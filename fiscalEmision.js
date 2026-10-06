// ---------------------------------------------------------------------------
// Emisión de comprobantes electrónicos (5/10/2026, "parte fiscal").
//
// Une las ventas del sistema con ARCA (arca.js): arma el comprobante de una
// venta fiscal (Factura A/B, Nota de Crédito/Débito A/B), pide el CAE y
// guarda el resultado en la venta. No tiene rutas HTTP: la usan fiscal.js
// (botón "Autorizar en ARCA") y ventas.js (autorización automática al
// guardar).
//
// Campos que esta etapa agrega a la venta (todos opcionales, solo las ventas
// fiscales los usan):
//   fiscal        { preciosIncluyenIva, discriminaIva, grupos:[{porcentaje,
//                   idArca, baseImp, importe}], neto, iva, total, items:[...] }
//   fiscalEstado  'pendiente' | 'autorizando' | 'autorizada' | 'rechazada'
//   fiscalMensaje texto para mostrar (por qué quedó pendiente / rechazada)
//   cae, caeVto (Date), puntoVenta, numeroFiscal, cbteTipo, fiscalFecha
//   (AAAAMMDD), fiscalDocTipo, fiscalDocNro, fiscalEntorno, fiscalObservaciones
//   fiscalIntento { cbteNro, ptoVta, cbteTipo, importe } (para recuperarse
//   si ARCA cortó la respuesta)
// ---------------------------------------------------------------------------

const arca = require('./arca');
const { calcularFiscal } = require('./fiscalCalculo');

const IVA_DEFECTO = 21;

function err(status, message) { return Object.assign(new Error(message), { status }); }

async function getConfig(db, orgId) {
  const cfg = await db.collection('arca_config').findOne({ orgId });
  const org = await db.collection('organizaciones').findOne({ _id: orgId });
  if (!cfg) return { orgId, entorno: 'homologacion', puntoVenta: null, org, vacia: true, emisionAutomatica: true, preciosIncluyenIvaDefecto: true, ivaDefecto: IVA_DEFECTO };
  cfg.org = org;
  cfg.cuit = arca.soloDigitos(org && org.cuit);
  if (cfg.emisionAutomatica === undefined) cfg.emisionAutomatica = true;
  if (cfg.preciosIncluyenIvaDefecto === undefined) cfg.preciosIncluyenIvaDefecto = true;
  if (cfg.ivaDefecto === undefined) cfg.ivaDefecto = IVA_DEFECTO;
  return cfg;
}

function listoParaEmitir(cfg) {
  if (!cfg || cfg.vacia) return 'Todavía no está configurada la conexión con ARCA (Fiscal → Configuración).';
  if (!cfg.certPem || !cfg.keyEnc) return 'Falta cargar el certificado de ARCA (Fiscal → Configuración).';
  if (!cfg.puntoVenta) return 'Falta indicar el punto de venta electrónico (Fiscal → Configuración).';
  if (!arca.cuitValido(cfg.cuit)) return 'El CUIT de la organización no es válido (Configuración → Organizaciones).';
  return null;
}

// ¿Los precios de esta venta incluyen IVA? Lo decide la lista de precios
// usada; si no hay lista (o no lo indica), el valor por defecto de la
// configuración fiscal.
async function preciosIncluyenIvaDe(db, cfg, listaPrecioId) {
  if (listaPrecioId) {
    const l = await db.collection('productos_listas_precio').findOne({ _id: listaPrecioId });
    if (l && typeof l.incluyeIva === 'boolean') return l.incluyeIva;
  }
  return cfg.preciosIncluyenIvaDefecto !== false;
}

// Calcula el bloque fiscal de una venta a partir de sus ítems.
function calcularFiscalVenta({ items, descuentoPorcentaje, descuentoMonto, preciosIncluyenIva, letra, ivaDefecto }) {
  const conIva = (items || []).map(it => ({
    subtotal: it.subtotal,
    porcentajeIva: (it.porcentajeIva === undefined || it.porcentajeIva === null || it.porcentajeIva === '') ? (ivaDefecto === undefined ? IVA_DEFECTO : ivaDefecto) : Number(it.porcentajeIva)
  }));
  return calcularFiscal({ items: conIva, descuentoPorcentaje, descuentoMonto, preciosIncluyenIva, discriminaIva: letra !== 'C' });
}

function datosReceptor(cliente, letra) {
  const cuit = arca.soloDigitos(cliente && cliente.cuit);
  const tipoDoc = String((cliente && cliente.tipoDocumento) || '').toLowerCase();
  const numDoc = arca.soloDigitos(cliente && cliente.numeroDocumento);
  const cuitCrudo = String((cliente && cliente.cuit) || '').trim();
  if (cuitCrudo && !arca.cuitValido(cuit)) throw err(400, `El CUIT cargado del cliente (${cuitCrudo}) no es válido. Corregilo en Clientes antes de facturar.`);
  if (tipoDoc === 'pasaporte' && numDoc) throw err(400, 'El cliente figura con pasaporte: cargale CUIT/CUIL o DNI para facturar.');
  if (numDoc && (tipoDoc === 'cuit' || tipoDoc === 'cuil') && !arca.cuitValido(numDoc)) throw err(400, `El ${tipoDoc.toUpperCase()} cargado del cliente no es válido. Corregilo en Clientes antes de facturar.`);
  let docTipo = arca.DOC_TIPO.consumidor_final, docNro = '0';
  if (arca.cuitValido(cuit)) { docTipo = arca.DOC_TIPO.cuit; docNro = cuit; }
  else if (numDoc && (tipoDoc === 'cuit' || tipoDoc === 'cuil') && arca.cuitValido(numDoc)) { docTipo = tipoDoc === 'cuil' ? arca.DOC_TIPO.cuil : arca.DOC_TIPO.cuit; docNro = numDoc; }
  else if (numDoc && tipoDoc === 'dni') { docTipo = arca.DOC_TIPO.dni; docNro = numDoc; }
  if (letra === 'A' && docTipo !== arca.DOC_TIPO.cuit && docTipo !== arca.DOC_TIPO.cuil) {
    throw err(400, 'La Factura A necesita que el cliente tenga un CUIT válido cargado (Clientes).');
  }
  let cond = arca.COND_IVA_RECEPTOR[(cliente && cliente.categoriaFiscal) || ''];
  if (!cond) cond = letra === 'A' ? arca.COND_IVA_RECEPTOR.responsable_inscripto : arca.COND_IVA_RECEPTOR.consumidor_final;
  return { docTipo, docNro, condIvaReceptor: cond };
}

// Nunca pisa una venta que ya tiene CAE (otro proceso pudo haberla cerrado).
async function guardarEstado(db, id, set) {
  await db.collection('ventas').updateOne({ _id: id, cae: { $exists: false } }, { $set: Object.assign({ updatedAt: new Date() }, set) });
}

// Exclusión por organización: el número de comprobante sale de "último + 1",
// así que dos pedidos a la vez de la misma organización se pisarían.
const LOCK_ORG_MS = 4 * 60 * 1000;
async function tomarLockOrg(db, orgId) {
  const limite = Date.now() + 20 * 1000;
  for (;;) {
    const ahora = new Date();
    const r = await db.collection('arca_config').findOneAndUpdate(
      { orgId, $or: [{ emitiendoDesde: { $exists: false } }, { emitiendoDesde: null }, { emitiendoDesde: { $lt: new Date(Date.now() - LOCK_ORG_MS) } }] },
      { $set: { emitiendoDesde: ahora } }, { returnDocument: 'after' }
    );
    const doc = r && r.value !== undefined ? r.value : r;
    if (doc) return ahora;
    if (Date.now() > limite) throw err(409, 'Hay otro comprobante autorizándose en este momento. Reintentá en unos segundos.');
    await new Promise(res => setTimeout(res, 400));
  }
}
async function soltarLockOrg(db, orgId, marca) {
  await db.collection('arca_config').updateOne({ orgId, emitiendoDesde: marca }, { $set: { emitiendoDesde: null } });
}

/**
 * Pide el CAE de una venta fiscal. Devuelve la venta actualizada.
 * Lanza error con `status` y mensaje claro si no se puede (y deja la venta
 * en estado 'pendiente' o 'rechazada' con `fiscalMensaje`).
 */
async function autorizarVenta(db, { orgId, ventaId, usuarioNombre }) {
  const venta = await db.collection('ventas').findOne({ _id: ventaId, orgId });
  if (!venta) throw err(404, 'Venta no encontrada');
  if (!venta.esFiscal) throw err(400, 'Esta venta es un comprobante X (no fiscal): no se autoriza en ARCA.');
  if (venta.cae) throw err(400, 'Este comprobante ya está autorizado por ARCA (CAE ' + venta.cae + ').');
  if (venta.estado === 'anulada') throw err(400, 'La venta está anulada.');
  const letra = venta.letra;
  if (letra !== 'A' && letra !== 'B') throw err(400, `La letra ${letra} no se puede autorizar desde acá (solo Factura/Notas A y B).`);

  const cfg = await getConfig(db, orgId);
  const falta = listoParaEmitir(cfg);
  if (falta) { await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: falta }); throw err(400, falta); }
  const condEmisor = cfg.org && cfg.org.condicionIva;
  if (condEmisor && condEmisor !== 'responsable_inscripto') {
    const m = 'La organización no figura como Responsable Inscripto: por ahora el sistema emite solo Facturas/Notas A y B (Configuración → Organizaciones → Condición de IVA).';
    await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: m });
    throw err(400, m);
  }

  // Tipo de comprobante de ARCA
  const familia = venta.tipoComprobante === 'nota_credito' ? 'nota_credito' : venta.tipoComprobante === 'nota_debito' ? 'nota_debito' : 'factura';
  const cbteTipo = arca.CBTE_TIPO[familia][letra];

  const cliente = venta.clienteId ? await db.collection('clientes').findOne({ _id: venta.clienteId }) : null;
  let receptor;
  try { receptor = datosReceptor(cliente, letra); }
  catch (e) { await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: e.message }); throw e; }

  // Importes: los guardados al crear la venta; si es una venta anterior a este
  // módulo se calculan ahora, solo si el total no cambia.
  let fiscal = venta.fiscal;
  if (!fiscal) {
    const inc = await preciosIncluyenIvaDe(db, cfg, venta.listaPrecioId);
    fiscal = calcularFiscalVenta({ items: venta.items, descuentoPorcentaje: venta.descuentoPorcentaje, descuentoMonto: venta.descuentoMonto, preciosIncluyenIva: inc, letra, ivaDefecto: cfg.ivaDefecto });
    if (Math.abs(fiscal.total - venta.total) > 0.01) {
      const m = `Esta venta se cargó antes del módulo fiscal con precios sin IVA y el total de ARCA (${fiscal.total.toFixed(2)}) no coincidiría con el de la venta (${Number(venta.total).toFixed(2)}). Anulala y cargala de nuevo.`;
      await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: m });
      throw err(400, m);
    }
  }
  if (Math.abs(fiscal.total - venta.total) > 0.01) {
    const m = 'El total fiscal no coincide con el total de la venta. Revisá los importes.';
    await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: m });
    throw err(400, m);
  }

  // Moneda
  let moneda = { id: 'PES', cotiz: 1 };
  if (venta.moneda === 'USD') {
    if (!venta.cotizacionDolar || venta.cotizacionDolar <= 0) throw err(400, 'La venta está en dólares pero no tiene cotización cargada.');
    moneda = { id: 'DOL', cotiz: venta.cotizacionDolar };
  }

  // Comprobante asociado (notas)
  let asociado = null;
  if (familia !== 'factura') {
    const origen = venta.comprobanteOrigenId ? await db.collection('ventas').findOne({ _id: venta.comprobanteOrigenId, orgId }) : null;
    if (!origen || !origen.cae) {
      const m = 'Una nota de crédito/débito fiscal tiene que referirse a una factura ya autorizada por ARCA. Generala desde esa factura.';
      await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: m });
      throw err(400, m);
    }
    if (origen.estado === 'anulada') { const m = 'El comprobante de origen está anulado.'; await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: m }); throw err(400, m); }
    if (String(origen.clienteId) !== String(venta.clienteId) || origen.letra !== letra) {
      const m = `La nota tiene que ser del mismo cliente y de la misma letra que la factura de origen (${origen.letra}).`;
      await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: m }); throw err(400, m);
    }
    asociado = { tipo: origen.cbteTipo, ptoVta: origen.puntoVenta, nro: origen.numeroFiscal, cuit: cfg.cuit, fecha: origen.fiscalFecha };
  }

  // Candado: evita dos pedidos simultáneos para la misma venta.
  const hace2min = new Date(Date.now() - LOCK_ORG_MS);
  const lock = await db.collection('ventas').findOneAndUpdate(
    { _id: venta._id, orgId, cae: { $exists: false }, $or: [{ fiscalEstado: { $ne: 'autorizando' } }, { fiscalAutorizandoDesde: { $lt: hace2min } }] },
    { $set: { fiscalEstado: 'autorizando', fiscalAutorizandoDesde: new Date(), fiscalMensaje: null } },
    { returnDocument: 'after' }
  );
  const bloqueada = lock && lock.value !== undefined ? lock.value : lock;
  if (!bloqueada) throw err(409, 'Ya hay un pedido de autorización en curso para esta venta. Esperá unos segundos.');

  // ARCA exige que la fecha no sea anterior a la del último comprobante: se usa siempre el día de hoy.
  const fecha = arca.yyyymmddAR(new Date());
  const ptoVta = cfg.puntoVenta;
  let marcaLock = null;
  try {
    marcaLock = await tomarLockOrg(db, orgId);
    // Con el lock tomado otro proceso pudo haber cerrado esta misma venta.
    const actual = await db.collection('ventas').findOne({ _id: venta._id, orgId });
    if (actual && actual.cae) return actual;
    // ¿Un intento anterior quedó a medias (corte de conexión)? Se verifica
    // si ARCA ya había autorizado ese número antes de pedir otro.
    let cbteNro = null;
    const intento = venta.fiscalIntento;
    if (intento && intento.cbteTipo === cbteTipo && intento.ptoVta === ptoVta && (!intento.entorno || intento.entorno === cfg.entorno)) {
      const ya = await arca.consultarComprobante(db, cfg, ptoVta, cbteTipo, intento.cbteNro);
      // No adoptar el comprobante si ya pertenece a otra venta de esta organización.
      const deOtra = ya.existe ? await db.collection('ventas').findOne({ orgId, _id: { $ne: venta._id }, puntoVenta: ptoVta, cbteTipo, numeroFiscal: intento.cbteNro, fiscalEntorno: cfg.entorno }) : null;
      if (ya.existe && !deOtra && ya.cae && Math.abs(ya.importe - fiscal.total) < 0.01 && String(ya.docNro) === String(receptor.docNro)) {
        return await cerrarAprobado(db, venta, cfg, { cae: ya.cae, caeVto: ya.caeVto, cbteNro: intento.cbteNro, observaciones: [] }, { cbteTipo, ptoVta, fecha: ya.fecha || fecha, receptor, fiscal, moneda, usuarioNombre });
      }
    }
    const ultimo = await arca.ultimoAutorizado(db, cfg, ptoVta, cbteTipo);
    cbteNro = ultimo + 1;
    await guardarEstado(db, venta._id, { fiscalIntento: { cbteNro, ptoVta, cbteTipo, importe: fiscal.total, entorno: cfg.entorno } });

    const r = await arca.solicitarCae(db, cfg, {
      ptoVta, cbteTipo, letra, cbteNro, concepto: 1, fecha,
      docTipo: receptor.docTipo, docNro: receptor.docNro, condIvaReceptor: receptor.condIvaReceptor,
      fiscal, moneda, asociado
    });
    if (r.aprobado) {
      return await cerrarAprobado(db, venta, cfg, r, { cbteTipo, ptoVta, fecha, receptor, fiscal, moneda, usuarioNombre });
    }
    const mensajes = r.errores.concat(r.observaciones).map(e => `(${e.codigo}) ${e.mensaje}`);
    const msg = 'ARCA rechazó el comprobante: ' + (mensajes.join(' | ') || 'sin detalle');
    await guardarEstado(db, venta._id, { fiscalEstado: 'rechazada', fiscalMensaje: msg, fiscalIntento: null, fiscalAutorizandoDesde: null });
    throw err(422, msg);
  } catch (e) {
    if (e.status === 422) throw e;
    // Error de conexión/servicio: la venta queda pendiente para reintentar.
    const msg = e.incierto
      ? e.message + ' Es posible que ARCA sí haya autorizado el comprobante: al reintentar el sistema lo verifica antes de pedir otro número.'
      : e.message;
    await guardarEstado(db, venta._id, { fiscalEstado: 'pendiente', fiscalMensaje: msg, fiscalAutorizandoDesde: null });
    throw Object.assign(err(e.status || 502, msg), { incierto: !!e.incierto });
  } finally {
    if (marcaLock) { try { await soltarLockOrg(db, orgId, marcaLock); } catch (_) {} }
  }
}

async function cerrarAprobado(db, venta, cfg, r, ctx) {
  const vto = String(r.caeVto || '');
  const caeVto = vto.length === 8 ? new Date(`${vto.slice(0, 4)}-${vto.slice(4, 6)}-${vto.slice(6, 8)}T12:00:00-03:00`) : null;
  const obs = (r.observaciones || []).map(o => `(${o.codigo}) ${o.mensaje}`);
  await guardarEstado(db, venta._id, {
    fiscal: ctx.fiscal,
    fiscalEstado: 'autorizada', fiscalMensaje: obs.length ? 'Autorizada con observaciones: ' + obs.join(' | ') : null,
    cae: String(r.cae), caeVto, puntoVenta: ctx.ptoVta, numeroFiscal: r.cbteNro, cbteTipo: ctx.cbteTipo,
    fiscalFecha: String(ctx.fecha), fiscalDocTipo: ctx.receptor.docTipo, fiscalDocNro: String(ctx.receptor.docNro),
    fiscalCondIvaReceptor: ctx.receptor.condIvaReceptor,
    fiscalMoneda: ctx.moneda.id, fiscalCotiz: ctx.moneda.cotiz,
    fiscalEntorno: cfg.entorno, fiscalObservaciones: obs, fiscalAutorizadaPor: ctx.usuarioNombre || '',
    fiscalAutorizadaEn: new Date(), fiscalIntento: null, fiscalAutorizandoDesde: null
  });
  return db.collection('ventas').findOne({ _id: venta._id });
}

module.exports = { getConfig, listoParaEmitir, preciosIncluyenIvaDe, calcularFiscalVenta, autorizarVenta, datosReceptor, IVA_DEFECTO };
