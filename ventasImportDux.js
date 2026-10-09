// ---------------------------------------------------------------------------
// Importación del HISTORIAL de ventas de Dux (9/10/2026, pedido de Mato).
//
// Entrada: el Excel "consulta_ventas" de Dux (.xls o .xlsx) con columnas Fecha, Cliente, Total, Cobrado,
// Estado Remito, Comprobante (CX-00006-00000123 / FA-... / FB-...), Vendedor, Observaciones, ...
// Ese listado NO trae el detalle de artículos, así que cada venta importada lleva un único renglón
// "Venta histórica Dux (sin detalle)" por el total.
//
// Decisiones (confirmadas con Mato):
//   - SOLO HISTORIAL: no toca stock, no genera movimientos de cuenta corriente, no deja saldo pendiente
//     (los saldos de clientes se cargan aparte), no emite nada fiscal ni entra a los libros fiscales (esFiscal=false).
//   - Se conserva el número ORIGINAL de Dux (numeroOriginal) y se marca importado:true / origen:'dux'.
//   - Clientes: se reutiliza el que coincide por nombre (único); si no existe se crea con origenCliente 'Importado Dux'.
//   - Re-subir el mismo archivo no duplica: cada venta lleva una claveImport (número original, o
//     fecha+cliente+total en los pocos comprobantes que Dux exporta sin número completo).
// Rutas: POST /preview  y  POST /aplicar   body: { archivoBase64 }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereModulo('ventas')];

let mongoClient, mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(() => { mongoClient = nuevo; mongoConectando = null; }, (e) => { mongoConectando = null; throw e; });
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) { try { return await fn(); } catch (e) { if (e.status) throw e; mongoClient = null; return await fn(); } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Claves de comparación de un nombre: "LOPEZ, DAIANA" ~ "daiana lopez" ~ "lopez daiana".
function clavesNombre(nombre) {
  const n = norm(nombre);
  if (!n) return [];
  const claves = new Set([n, n.replace(/,/g, '').replace(/\s+/g, ' ').trim()]);
  if (n.includes(',')) {
    const [ap, ...resto] = n.split(',');
    claves.add((resto.join(' ') + ' ' + ap).replace(/\s+/g, ' ').trim());
  }
  return [...claves];
}

function parsearFecha(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 15));
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d, 15)) : null; }
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 15)) : null;
}
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return 0;
  // 1.234,56 (es-AR) o 1234.56
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Lee el Excel y devuelve las filas ya normalizadas + errores de lectura.
function leerArchivo(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'fecha') && f.some(c => norm(c) === 'comprobante'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Fecha y Comprobante. Tiene que ser el listado "consulta_ventas" de Dux.');
  const enc = filas[hIdx].map(norm);
  const col = (n) => enc.indexOf(n);
  const c = { fecha: col('fecha'), cliente: col('cliente'), total: col('total'), cobrado: col('cobrado'), remito: col('estado remito'), comp: col('comprobante'), vendedor: col('vendedor'), obs: col('observaciones') };
  if (c.cliente < 0 || c.total < 0) throw err(400, 'Faltan las columnas Cliente y/o Total.');
  const ventas = [], errores = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const nFila = i + 1;
    const comp = String(f[c.comp] == null ? '' : f[c.comp]).trim();
    const fecha = parsearFecha(f[c.fecha]);
    const cliente = String(f[c.cliente] == null ? '' : f[c.cliente]).trim();
    if (!comp && !cliente) continue;
    if (!fecha) { errores.push({ fila: nFila, motivo: 'Fecha inválida: ' + f[c.fecha] }); continue; }
    if (!cliente) { errores.push({ fila: nFila, motivo: 'Sin cliente' }); continue; }
    const total = round2(numero(f[c.total]));
    const m = comp.match(/^([A-Z]{2})-(\d{1,5})-(\d{1,8})$/);
    const prefijo = m ? m[1] : (comp.match(/^([A-Z]{2})/) || [])[1] || 'CX';
    ventas.push({
      fila: nFila, fecha, cliente, total, cobrado: round2(numero(f[c.cobrado])),
      estadoRemitoDux: String(f[c.remito] || '').trim(),
      comprobante: comp, completo: !!m, prefijo, puntoVenta: m ? m[2] : '', nro: m ? Number(m[3]) : 0,
      vendedor: String(f[c.vendedor] || '').trim(), observaciones: String(f[c.obs] || '').trim()
    });
  }
  return { ventas, errores };
}

function claveImport(v) {
  if (v.completo) return 'dux:' + v.comprobante;
  return 'dux:s/n:' + v.prefijo + ':' + v.fecha.toISOString().slice(0, 10) + ':' + norm(v.cliente) + ':' + v.total.toFixed(2) + ':' + v.fila;
}

async function procesar(req, aplicar) {
  if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
  const { ventas, errores } = leerArchivo(req.body && req.body.archivoBase64);
  if (!ventas.length) throw err(400, 'El archivo no tiene ventas para importar.');
  return conReintento(async () => {
    const db = await getDb();
    const orgId = req.orgId;

    // Ya importadas
    const claves = ventas.map(claveImport);
    const existentes = new Set((await db.collection('ventas').find({ orgId, claveImport: { $in: claves } }).project({ claveImport: 1 }).toArray()).map(x => x.claveImport));

    // Clientes
    const clientes = await db.collection('clientes').find({ orgId, activo: { $ne: false } })
      .project({ apellidoRazonSocial: 1, nombre: 1, nombreFantasia: 1 }).toArray();
    const mapa = new Map(); // clave -> Set(_id)
    const agregar = (k, id) => { if (!k) return; if (!mapa.has(k)) mapa.set(k, new Set()); mapa.get(k).add(String(id)); };
    clientes.forEach(cl => {
      [cl.apellidoRazonSocial, cl.nombreFantasia, [cl.nombre, cl.apellidoRazonSocial].filter(Boolean).join(' '), [cl.apellidoRazonSocial, cl.nombre].filter(Boolean).join(' ')]
        .forEach(n => clavesNombre(n).forEach(k => agregar(k, cl._id)));
    });
    const idPorNombre = new Map(); // nombre Dux -> _id | null (ambiguo) | 'NUEVO'
    const nombresNuevos = new Set(); let ambiguos = 0, coinciden = 0;
    [...new Set(ventas.map(v => v.cliente))].forEach(nombre => {
      const cand = new Set();
      clavesNombre(nombre).forEach(k => (mapa.get(k) || new Set()).forEach(id => cand.add(id)));
      if (cand.size === 1) { idPorNombre.set(nombre, [...cand][0]); coinciden++; }
      else if (cand.size > 1) { idPorNombre.set(nombre, null); ambiguos++; }
      else { idPorNombre.set(nombre, 'NUEVO'); nombresNuevos.add(nombre); }
    });

    const nuevas = ventas.filter(v => !existentes.has(claveImport(v)));
    const resumen = {
      filasLeidas: ventas.length, aImportar: nuevas.length, yaImportadas: ventas.length - nuevas.length,
      desde: ventas.reduce((a, v) => (!a || v.fecha < a ? v.fecha : a), null), hasta: ventas.reduce((a, v) => (!a || v.fecha > a ? v.fecha : a), null),
      totalImporte: round2(nuevas.reduce((s, v) => s + v.total, 0)),
      sinNumeroCompleto: nuevas.filter(v => !v.completo).length,
      clientesExistentes: coinciden, clientesNuevos: nombresNuevos.size, clientesAmbiguos: ambiguos,
      errores
    };
    if (!aplicar) return resumen;

    const ahora = new Date();
    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    // Crear clientes nuevos
    let clientesCreados = 0;
    if (nombresNuevos.size) {
      const docs = [...nombresNuevos].map(n => ({ apellidoRazonSocial: n, categoriaFiscal: 'consumidor_final', origenCliente: 'Importado Dux', activo: true, orgId, createdAt: ahora, updatedAt: ahora }));
      const r = await db.collection('clientes').insertMany(docs, { ordered: false });
      [...nombresNuevos].forEach((n, i) => idPorNombre.set(n, String(r.insertedIds[i])));
      clientesCreados = docs.length;
    }
    const { ObjectId } = require('mongodb');
    const docs = nuevas.map(v => {
      const cid = idPorNombre.get(v.cliente);
      const esCX = v.prefijo === 'CX';
      return {
        numero: v.nro || 0,
        numeroOriginal: v.completo ? v.comprobante : (v.comprobante || v.prefijo) + ' (s/n)',
        importado: true, origen: 'dux', claveImport: claveImport(v),
        tipoComprobante: esCX ? 'comprobante_x' : 'fiscal',
        letra: esCX ? null : v.prefijo.slice(1),
        esFiscal: false, // ya se autorizó en Dux: no entra a ARCA ni a los libros fiscales de acá
        clienteId: cid ? new ObjectId(cid) : null,
        clienteNombre: v.cliente,
        vendedor: v.vendedor,
        fecha: v.fecha, moneda: 'ARS', listaPrecioId: null, cotizacionDolar: null,
        tipoEntrega: null, depositoId: null, stockComprometido: false,
        estado: 'entregada', estadoRemitoDux: v.estadoRemitoDux,
        items: [{ productoId: null, sku: null, nombre: 'Venta histórica Dux (sin detalle)', cantidad: 1, precioUnitario: v.total, subtotal: v.total, cantidadEntregada: 1 }],
        descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: v.total, total: v.total,
        fiscal: null, fiscalEstado: null, fiscalMensaje: null,
        pagos: [], totalCobrado: Math.min(v.cobrado, v.total), saldoPendiente: 0, duxCobrado: v.cobrado, duxSaldo: round2(Math.max(v.total - v.cobrado, 0)),
        observaciones: v.observaciones, stockDescontado: false, stockDescontadoEn: null,
        remitoId: null, remitoNumero: null, remitosIds: [], entregadaEn: v.fecha,
        anuladaEn: null, anuladaPor: null, anuladaMotivo: null,
        usuarioNombre, orgId, createdAt: ahora, updatedAt: ahora
      };
    });
    let insertadas = 0;
    for (let i = 0; i < docs.length; i += 500) {
      const lote = docs.slice(i, i + 500);
      await db.collection('ventas').insertMany(lote, { ordered: false });
      insertadas += lote.length;
    }
    return Object.assign(resumen, { insertadas, clientesCreados });
  });
}

router.post('/preview', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});


// ---------------------------------------------------------------------------
// DETALLE por artículo ("consulta_de_ventas_detallada"): una fila por renglón de cada comprobante.
// - Si el comprobante ya está importado desde el listado → se reemplaza su renglón "sin detalle" por los artículos reales.
// - Si no existe (ej. Notas de Crédito/Débito, que el listado no trae) → se crea la venta completa.
// - Los artículos se vinculan al catálogo por Código Producto = SKU / código externo; si no hay match, queda el
//   nombre/rubro/marca que vino de Dux (los informes por rubro usan ese dato).
// - Idempotente: volver a subir el mismo archivo deja lo mismo. Se pueden subir varios archivos (de a 60 días).
// ---------------------------------------------------------------------------
function leerDetalle(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo.'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'comprobante') && f.some(c => norm(c) === 'codigo producto'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Comprobante y Código Producto. Tiene que ser "consulta_de_ventas_detallada" de Dux.');
  const enc = filas[hIdx].map(norm);
  const c = (n) => enc.indexOf(n);
  const idx = {
    sucursal: c('sucursal'), cliente: c('cliente'), comp: c('comprobante'), fecha: c('fecha comp'), codigo: c('codigo producto'), producto: c('producto'),
    rubro: c('rubro'), marca: c('marca'), proveedor: c('proveedor'), obs: c('observaciones'), forma: c('forma pago'), vendedor: c('vendedor'),
    cantidad: c('cantidad'), precio: c('precio uni'), desc: c('% desc.'), sinIva: c('total sin iva'), pIva: c('porc. iva'), iva: c('iva'),
    conIva: c('total con iva'), total: c('total'), efvo: c('cobro efectivo'), tarj: c('cobro tarjeta'), chq: c('cobro cheque'), cta: c('cobro cuenta'),
    costoU: c('costo unitario producto'), costoT: c('costo total producto')
  };
  if (idx.cliente < 0 || idx.total < 0 || idx.cantidad < 0) throw err(400, 'Faltan columnas (Cliente, Cantidad o Total).');
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const num = (f, k) => idx[k] >= 0 ? numero(f[idx[k]]) : 0;
  const grupos = new Map(), errores = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    let comp = txt(f, 'comp');
    const cliente = txt(f, 'cliente');
    let fecha = parsearFecha(f[idx.fecha]);
    if (!fecha) { const m = String(f[idx.fecha] || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) fecha = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 15)); }
    // Dux exporta algunos comprobantes sin número: se agrupan por cliente + fecha y se enlazan con la venta "s/n" del listado.
    if (!comp && cliente && fecha) comp = 'SN|' + cliente + '|' + fecha.toISOString().slice(0, 10);
    if (!comp || !cliente || !fecha) { errores.push({ fila: i + 1, motivo: 'Falta comprobante, cliente o fecha' }); continue; }
    if (!grupos.has(comp)) grupos.set(comp, { comprobante: comp, fecha, cliente, sucursal: txt(f, 'sucursal'), vendedor: txt(f, 'vendedor'), formaPago: txt(f, 'forma'), observaciones: txt(f, 'obs'), items: [], cobros: { efectivo: 0, tarjeta: 0, cheque: 0, cuenta: 0 }, total: 0 });
    const g = grupos.get(comp);
    const nota = /^N[CD]/.test(comp); // en las notas de crédito Dux manda cantidades e importes en negativo
    const k = (v) => round2(nota ? Math.abs(v) : v);
    const cantidad = Math.abs(num(f, 'cantidad')) || 0;
    g.items.push({
      codigo: txt(f, 'codigo'), nombre: txt(f, 'producto'), rubro: txt(f, 'rubro'), marca: txt(f, 'marca'), proveedor: txt(f, 'proveedor'),
      cantidad, precioUnitario: round2(Math.abs(num(f, 'precio'))), descuentoPorcentaje: num(f, 'desc'),
      subtotal: k(num(f, 'sinIva')), porcentajeIva: num(f, 'pIva'), iva: k(num(f, 'iva')), totalConIva: k(num(f, 'conIva')),
      costoUnitario: round2(Math.abs(num(f, 'costoU'))), costoTotal: k(num(f, 'costoT'))
    });
    g.total = round2(g.total + k(num(f, 'total')));
    g.cobros.efectivo += num(f, 'efvo'); g.cobros.tarjeta += num(f, 'tarj'); g.cobros.cheque += num(f, 'chq'); g.cobros.cuenta += num(f, 'cta');
  }
  return { grupos: [...grupos.values()], errores };
}

function tipoDeComprobante(comp) {
  if (String(comp).startsWith('SN|')) return { pref: 'SN', base: 'fiscal', letra: null, nro: 0, completo: false };
  const m = String(comp).match(/^([A-Z]{2,3})-(\d+)-(\d+)$/);
  const pref = m ? m[1] : (String(comp).match(/^[A-Z]+/) || ['CX'])[0];
  const letra = pref.length === 3 ? pref[2] : pref[1];
  const base = pref.startsWith('NC') ? 'nota_credito' : pref.startsWith('ND') ? 'nota_debito' : pref === 'CX' ? 'comprobante_x' : 'fiscal';
  return { pref, base, letra: letra === 'X' ? null : letra, nro: m ? Number(m[3]) : 0, completo: !!m };
}

async function procesarDetalle(req, aplicar) {
  if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
  const { grupos, errores } = leerDetalle(req.body && req.body.archivoBase64);
  if (!grupos.length) throw err(400, 'El archivo no tiene ventas.');
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId; const { ObjectId } = require('mongodb');

    // Catálogo para vincular artículos (por SKU / código externo)
    const codigos = [...new Set(grupos.flatMap(g => g.items.map(i => i.codigo)).filter(Boolean))];
    const prods = codigos.length ? await db.collection('productos_catalogo').find({ orgId, $or: [{ sku: { $in: codigos } }, { codigoExterno: { $in: codigos } }] }).project({ sku: 1, codigoExterno: 1, nombre: 1 }).toArray() : [];
    const porCodigo = new Map();
    prods.forEach(p => { [p.sku, p.codigoExterno].filter(Boolean).forEach(cd => { if (!porCodigo.has(cd)) porCodigo.set(cd, p); }); });

    // Ventas ya importadas
    const claves = grupos.map(g => 'dux:' + g.comprobante);
    const existentes = new Map((await db.collection('ventas').find({ orgId, claveImport: { $in: claves } }).project({ claveImport: 1, total: 1 }).toArray()).map(v => [v.claveImport, v]));

    // Clientes para las que hay que crear
    const clientes = await db.collection('clientes').find({ orgId, activo: { $ne: false } }).project({ apellidoRazonSocial: 1, nombre: 1, nombreFantasia: 1 }).toArray();
    const mapa = new Map();
    const agregar = (k, id) => { if (!k) return; if (!mapa.has(k)) mapa.set(k, new Set()); mapa.get(k).add(String(id)); };
    clientes.forEach(cl => [cl.apellidoRazonSocial, cl.nombreFantasia, [cl.nombre, cl.apellidoRazonSocial].filter(Boolean).join(' '), [cl.apellidoRazonSocial, cl.nombre].filter(Boolean).join(' ')].forEach(n => clavesNombre(n).forEach(k => agregar(k, cl._id))));
    const nuevasVentas = grupos.filter(g => !existentes.has('dux:' + g.comprobante));
    const idPorNombre = new Map(); const nombresNuevos = new Set();
    [...new Set(nuevasVentas.map(g => g.cliente))].forEach(n => {
      const cand = new Set(); clavesNombre(n).forEach(k => (mapa.get(k) || new Set()).forEach(id => cand.add(id)));
      if (cand.size === 1) idPorNombre.set(n, [...cand][0]); else if (cand.size > 1) idPorNombre.set(n, null); else { idPorNombre.set(n, 'NUEVO'); nombresNuevos.add(n); }
    });

    const sinMatch = new Set();
    let itemsVinculados = 0, itemsTotal = 0;
    grupos.forEach(g => g.items.forEach(i => { itemsTotal++; if (porCodigo.has(i.codigo)) itemsVinculados++; else sinMatch.add(i.codigo); }));
    const diferencias = grupos.filter(g => existentes.has('dux:' + g.comprobante) && Math.abs(existentes.get('dux:' + g.comprobante).total - Math.abs(g.total)) > 1)
      .map(g => ({ comprobante: g.comprobante, listado: existentes.get('dux:' + g.comprobante).total, detalle: Math.abs(g.total) }));
    const resumen = {
      comprobantes: grupos.length, renglones: itemsTotal, conVentaExistente: grupos.length - nuevasVentas.length, aCrear: nuevasVentas.length,
      notas: grupos.filter(g => /^N[CD]/.test(g.comprobante)).length,
      desde: grupos.reduce((a, g) => (!a || g.fecha < a ? g.fecha : a), null), hasta: grupos.reduce((a, g) => (!a || g.fecha > a ? g.fecha : a), null),
      articulosVinculados: itemsVinculados, articulosSinCatalogo: sinMatch.size, ejemplosSinCatalogo: [...sinMatch].slice(0, 8),
      clientesNuevos: nombresNuevos.size, diferencias: diferencias.length, ejemplosDiferencias: diferencias.slice(0, 5), errores
    };
    if (!aplicar) return resumen;

    const ahora = new Date(); const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    if (nombresNuevos.size) {
      const docs = [...nombresNuevos].map(n => ({ apellidoRazonSocial: n, categoriaFiscal: 'consumidor_final', origenCliente: 'Importado Dux', activo: true, orgId, createdAt: ahora, updatedAt: ahora }));
      const r = await db.collection('clientes').insertMany(docs, { ordered: false });
      [...nombresNuevos].forEach((n, i) => idPorNombre.set(n, String(r.insertedIds[i])));
    }
    const armarItems = (g) => g.items.map(i => {
      const p = porCodigo.get(i.codigo);
      return { productoId: p ? p._id : null, sku: i.codigo || null, nombre: p ? p.nombre : i.nombre, nombreDux: i.nombre, rubro: i.rubro || null, marca: i.marca || null, proveedor: i.proveedor || null,
        cantidad: i.cantidad, cantidadEntregada: i.cantidad, precioUnitario: i.precioUnitario, descuentoPorcentaje: i.descuentoPorcentaje, subtotal: i.subtotal,
        porcentajeIva: i.porcentajeIva, iva: i.iva, totalConIva: i.totalConIva, costoUnitario: i.costoUnitario, costoTotal: i.costoTotal };
    });
    let actualizadas = 0, creadas = 0, convertidasSN = 0;
    for (const g of grupos) {
      const clave = 'dux:' + g.comprobante; const items = armarItems(g);
      const base = { items, sucursalDux: g.sucursal, formaPagoDux: g.formaPago, duxCobros: { efectivo: round2(g.cobros.efectivo), tarjeta: round2(g.cobros.tarjeta), cheque: round2(g.cobros.cheque), cuenta: round2(g.cobros.cuenta) }, updatedAt: ahora };
      if (existentes.has(clave)) {
        await db.collection('ventas').updateOne({ orgId, claveImport: clave }, { $set: Object.assign(base, { detalleDux: true }) });
        actualizadas++; continue;
      }
      const t = tipoDeComprobante(g.comprobante); const total = Math.abs(g.total);
      // ¿Es una venta del listado que Dux exportó sin número completo? Se completa en vez de duplicar.
      const dia0 = new Date(g.fecha.getTime() - 12 * 3600e3), dia1 = new Date(g.fecha.getTime() + 12 * 3600e3);
      const sn = await db.collection('ventas').findOne({ orgId, importado: true, numeroOriginal: /\(s\/n\)$/, clienteNombre: g.cliente, fecha: { $gte: dia0, $lte: dia1 }, total: { $gte: total - 1, $lte: total + 1 } });
      if (sn) {
        await db.collection('ventas').updateOne({ _id: sn._id }, { $set: Object.assign(base, { detalleDux: true, numeroOriginal: g.comprobante, claveImport: clave, numero: t.nro }) });
        convertidasSN++; continue;
      }
      const cid = idPorNombre.get(g.cliente);
      await db.collection('ventas').insertOne(Object.assign({
        numero: t.nro, numeroOriginal: t.completo ? g.comprobante : 'S/N (s/n)', importado: true, origen: 'dux', claveImport: clave, detalleDux: true,
        tipoComprobante: t.base, letra: t.letra, esFiscal: false,
        clienteId: cid ? new ObjectId(cid) : null, clienteNombre: g.cliente, vendedor: g.vendedor, fecha: g.fecha, moneda: 'ARS',
        listaPrecioId: null, cotizacionDolar: null, tipoEntrega: null, depositoId: null, stockComprometido: false,
        estado: 'entregada', estadoRemitoDux: '', descuentoPorcentaje: 0, descuentoMonto: 0,
        subtotal: round2(items.reduce((a, i) => a + i.subtotal, 0)), total, fiscal: null, fiscalEstado: null, fiscalMensaje: null,
        pagos: [], totalCobrado: total, saldoPendiente: 0, duxCobrado: total, duxSaldo: 0, observaciones: g.observaciones,
        stockDescontado: false, stockDescontadoEn: null, remitoId: null, remitoNumero: null, remitosIds: [], entregadaEn: g.fecha,
        anuladaEn: null, anuladaPor: null, anuladaMotivo: null, usuarioNombre, orgId, createdAt: ahora
      }, base));
      creadas++;
    }
    return Object.assign(resumen, { actualizadas, creadas, convertidasSN, clientesCreados: nombresNuevos.size });
  });
}
router.post('/detalle/preview', authAdmin, async (req, res) => {
  try { res.json(await procesarDetalle(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/detalle/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesarDetalle(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
