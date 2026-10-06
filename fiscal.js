// ---------------------------------------------------------------------------
// Fiscal (5/10/2026, "parte fiscal") — rutas HTTP del módulo.
//
//   Configuración de ARCA por organización:
//     GET  /config            estado de la conexión (sin datos secretos)
//     PUT  /config            entorno, punto de venta y criterios por defecto
//     POST /csr               genera la clave privada (queda cifrada en la
//                             base) y devuelve la solicitud de certificado
//     GET  /csr               vuelve a bajar la solicitud pendiente
//     POST /certificado       carga el certificado que devolvió ARCA
//     POST /probar            prueba la conexión (ticket + servicio + puntos de venta)
//   Facturación:
//     POST /ventas/:id/autorizar   pide el CAE de una venta fiscal
//   Padrón:
//     GET  /consulta-cuit/:cuit    datos del CUIT en ARCA (para Clientes/Proveedores)
//   Libros y reportes (JSON o Excel con ?formato=xlsx):
//     GET  /libro-iva-ventas | /libro-iva-compras | /retenciones
//
// Módulo con clave propia ('fiscal'), datos por organización (orgId).
// ---------------------------------------------------------------------------

const express = require('express');
const XLSX = require('xlsx');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, tieneModulo } = require('./usuarios');
const arca = require('./arca');
const emision = require('./fiscalEmision');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
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
async function conReintento(fn) {
  try { return await fn(); } catch (e) { if (e.status) throw e; mongoClient = null; return await fn(); }
}
function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function responder(res, e) { res.status(e.status || 500).json({ error: e.message }); }

const authFiscal = [authUsuario, resolverOrg, requiereModulo('fiscal')];
// La consulta de CUIT la usan también Clientes, Proveedores y Ventas (cliente nuevo desde una venta).
const authConsultaCuit = [authUsuario, resolverOrg, (req, res, next) => {
  if (['fiscal', 'clientes', 'proveedores', 'ventas'].some(m => tieneModulo(req.usuario, m))) return next();
  res.status(403).json({ error: 'Tu usuario no tiene acceso a este módulo. Pedile a un administrador que te lo habilite.' });
}];

function exigirOrg(req) {
  if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
  return req.orgId;
}

function estadoPublico(cfg) {
  const org = cfg.org || {};
  return {
    entorno: cfg.entorno, puntoVenta: cfg.puntoVenta || null,
    emisionAutomatica: cfg.emisionAutomatica !== false,
    preciosIncluyenIvaDefecto: cfg.preciosIncluyenIvaDefecto !== false,
    ivaDefecto: cfg.ivaDefecto === undefined ? emision.IVA_DEFECTO : cfg.ivaDefecto,
    tieneClave: !!cfg.keyEnc, tieneCertificado: !!cfg.certPem,
    certVence: cfg.certVence || null, certSujeto: cfg.certSujeto || '',
    solicitudPendiente: !!(cfg.keyEnc && !cfg.certPem),
    cuit: arca.soloDigitos(org.cuit), cuitValido: arca.cuitValido(org.cuit),
    razonSocial: org.razonSocial || org.nombre || '', condicionIva: org.condicionIva || null,
    secretoPropio: arca.usaSecretoPropio(),
    listo: !emision.listoParaEmitir(cfg),
    faltante: emision.listoParaEmitir(cfg)
  };
}

router.get('/config', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const cfg = await conReintento(async () => emision.getConfig(await getDb(), orgId));
    res.json(estadoPublico(cfg));
  } catch (e) { responder(res, e); }
});

router.put('/config', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const b = req.body || {};
    const set = { updatedAt: new Date() };
    if (b.entorno !== undefined) {
      if (!['homologacion', 'produccion'].includes(b.entorno)) throw err(400, 'Entorno inválido (homologacion o produccion)');
      set.entorno = b.entorno;
    }
    if (b.puntoVenta !== undefined) {
      const n = Number(b.puntoVenta);
      if (b.puntoVenta !== '' && b.puntoVenta !== null && (!Number.isInteger(n) || n < 1 || n > 99998)) throw err(400, 'El punto de venta tiene que ser un número entero entre 1 y 99998');
      set.puntoVenta = (b.puntoVenta === '' || b.puntoVenta === null) ? null : n;
    }
    if (b.emisionAutomatica !== undefined) set.emisionAutomatica = !!b.emisionAutomatica;
    if (b.preciosIncluyenIvaDefecto !== undefined) set.preciosIncluyenIvaDefecto = !!b.preciosIncluyenIvaDefecto;
    if (b.ivaDefecto !== undefined) {
      const n = Number(b.ivaDefecto);
      if (![0, 2.5, 5, 10.5, 21, 27].includes(n)) throw err(400, 'El IVA por defecto tiene que ser 0, 2.5, 5, 10.5, 21 o 27');
      set.ivaDefecto = n;
    }
    const cfg = await conReintento(async () => {
      const db = await getDb();
      const previo = await db.collection('arca_config').findOne({ orgId });
      // Cambiar de entorno invalida el ticket y obliga a revisar el certificado:
      // el de homologación no sirve en producción.
      if (set.entorno && previo && previo.entorno !== set.entorno) {
        await db.collection('arca_tickets').deleteMany({ orgId });
      }
      await db.collection('arca_config').updateOne({ orgId }, { $set: set, $setOnInsert: { orgId, createdAt: new Date() } }, { upsert: true });
      return emision.getConfig(db, orgId);
    });
    res.json(estadoPublico(cfg));
  } catch (e) { responder(res, e); }
});

router.post('/csr', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const cfg = await conReintento(async () => emision.getConfig(await getDb(), orgId));
    if (cfg.certPem && !(req.body && req.body.confirmar)) {
      throw err(409, 'Ya hay un certificado cargado. Si generás una solicitud nueva, el certificado actual deja de funcionar. Confirmalo para seguir.');
    }
    const org = cfg.org || {};
    const { csrPem, keyPem } = arca.generarCsr({ cuit: org.cuit, razonSocial: org.razonSocial || org.nombre, alias: 'sistema' });
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('arca_config').updateOne({ orgId }, {
        $set: { keyEnc: arca.cifrar(keyPem), csrPem, updatedAt: new Date() },
        $unset: { certPem: '', certVence: '', certSujeto: '', certHuella: '' },
        $setOnInsert: { orgId, createdAt: new Date(), entorno: 'homologacion' }
      }, { upsert: true });
      await db.collection('arca_tickets').deleteMany({ orgId });
    });
    res.json({ csr: csrPem });
  } catch (e) { responder(res, e); }
});

router.get('/csr', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const cfg = await conReintento(async () => emision.getConfig(await getDb(), orgId));
    if (!cfg.csrPem) throw err(404, 'Todavía no se generó ninguna solicitud de certificado.');
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', 'attachment; filename="solicitud-certificado-arca.csr"');
    res.send(cfg.csrPem);
  } catch (e) { responder(res, e); }
});

router.post('/certificado', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const texto = req.body && req.body.certificado;
    if (!texto) throw err(400, 'Pegá el contenido del certificado.');
    const cfg = await conReintento(async () => emision.getConfig(await getDb(), orgId));
    if (!cfg.keyEnc) throw err(400, 'Primero generá la solicitud de certificado.');
    const v = arca.validarCertificado({ certTexto: texto, keyPem: arca.descifrar(cfg.keyEnc), cuit: cfg.cuit });
    const huella = require('crypto').createHash('sha256').update(v.certPem).digest('hex').slice(0, 16);
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('arca_config').updateOne({ orgId }, { $set: { certPem: v.certPem, certVence: v.vence, certSujeto: v.sujeto, certHuella: huella, updatedAt: new Date() } });
      await db.collection('arca_tickets').deleteMany({ orgId });
    });
    const nuevo = await conReintento(async () => emision.getConfig(await getDb(), orgId));
    res.json(estadoPublico(nuevo));
  } catch (e) { responder(res, e); }
});

router.post('/probar', authFiscal, async (req, res) => {
  const orgId = req.orgId;
  const pasos = [];
  const paso = (nombre, ok, detalle) => pasos.push({ nombre, ok, detalle: detalle || '' });
  try {
    exigirOrg(req);
    const db = await getDb();
    const cfg = await emision.getConfig(db, orgId);
    if (!cfg.certPem || !cfg.keyEnc) throw err(400, 'Todavía no hay un certificado cargado.');
    try { const d = await arca.dummyFe(cfg); paso('Servicio de facturación de ARCA', true, d ? `App ${d.AppServer} · Base ${d.DbServer} · Auth ${d.AuthServer}` : ''); }
    catch (e) { paso('Servicio de facturación de ARCA', false, e.message); }
    try { await arca.obtenerTicket(db, cfg, 'wsfe'); paso('Autenticación con el certificado (wsfe)', true); }
    catch (e) { paso('Autenticación con el certificado (wsfe)', false, e.message); return res.json({ ok: false, pasos }); }
    try {
      const pv = await arca.puntosDeVenta(db, cfg);
      if (pv.errores.length) paso('Puntos de venta', false, pv.errores.map(x => `(${x.codigo}) ${x.mensaje}`).join(' | '));
      else if (!pv.lista.length) paso('Puntos de venta', false, 'ARCA no devolvió ningún punto de venta habilitado para web services. Hay que crear uno en ARCA (Administración de puntos de venta y domicilios → tipo "RECE para aplicativo y web services").');
      else {
        paso('Puntos de venta', true, 'Habilitados: ' + pv.lista.map(p => String(p.numero).padStart(4, '0') + (p.bloqueado ? ' (bloqueado)' : '')).join(', '));
        if (cfg.puntoVenta && !pv.lista.some(p => p.numero === cfg.puntoVenta)) paso('Punto de venta configurado', false, `El punto de venta ${cfg.puntoVenta} no figura entre los habilitados en ARCA.`);
        else if (cfg.puntoVenta) paso('Punto de venta configurado', true, String(cfg.puntoVenta).padStart(4, '0'));
      }
    } catch (e) { paso('Puntos de venta', false, e.message); }
    try { await arca.obtenerTicket(db, cfg, 'ws_sr_constancia_inscripcion'); paso('Consulta de CUIT (padrón)', true); }
    catch (e) { paso('Consulta de CUIT (padrón)', false, e.message + ' — Es opcional: sin esto no se autocompletan los datos al cargar un CUIT, pero se puede facturar igual.'); }
    res.json({ ok: pasos.filter(p => !/padrón/.test(p.nombre)).every(p => p.ok), entorno: cfg.entorno, pasos });
  } catch (e) {
    if (pasos.length) return res.json({ ok: false, pasos: pasos.concat([{ nombre: 'Error', ok: false, detalle: e.message }]) });
    responder(res, e);
  }
});

router.post('/ventas/:id/autorizar', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const venta = await conReintento(async () => emision.autorizarVenta(await getDb(), { orgId, ventaId: id, usuarioNombre: (req.usuario && req.usuario.nombre) || '' }));
    res.json(venta);
  } catch (e) { responder(res, e); }
});

router.get('/consulta-cuit/:cuit', authConsultaCuit, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const db = await getDb();
    const cfg = await emision.getConfig(db, orgId);
    if (!cfg.certPem) throw err(400, 'La consulta automática de CUIT todavía no está habilitada: falta configurar la conexión con ARCA (módulo Fiscal).');
    const datos = await arca.consultarCuit(db, cfg, req.params.cuit);
    res.json(datos);
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Libros y reportes
// ---------------------------------------------------------------------------

function rangoFechas(q) {
  const m = {};
  if (q.desde) { const d = new Date(q.desde + 'T00:00:00-03:00'); if (isNaN(d)) throw err(400, 'Fecha "desde" inválida'); m.$gte = d; }
  if (q.hasta) { const d = new Date(q.hasta + 'T23:59:59.999-03:00'); if (isNaN(d)) throw err(400, 'Fecha "hasta" inválida'); m.$lte = d; }
  return Object.keys(m).length ? m : null;
}
function r2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function fechaDDMMAAAA(d) {
  if (!d) return '';
  const x = new Date(new Date(d).getTime() - 3 * 3600 * 1000);
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
}
function fiscalDDMMAAAA(s) { s = String(s || ''); return s.length === 8 ? `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}` : ''; }

const LETRA_TIPO = {
  factura: 'Factura', nota_credito: 'Nota de Crédito', nota_debito: 'Nota de Débito'
};
const ALICUOTAS_COLUMNAS = [21, 10.5, 27];

// Reparte un monto en columnas por alícuota (21 / 10,5 / 27 / otras).
function columnasIva(grupos, signo) {
  const out = { neto21: 0, iva21: 0, neto105: 0, iva105: 0, neto27: 0, iva27: 0, netoOtras: 0, ivaOtras: 0 };
  for (const g of grupos) {
    const base = signo * Number(g.baseImp || 0), iva = signo * Number(g.importe || 0);
    const p = Number(g.porcentaje);
    if (p === 21) { out.neto21 += base; out.iva21 += iva; }
    else if (p === 10.5) { out.neto105 += base; out.iva105 += iva; }
    else if (p === 27) { out.neto27 += base; out.iva27 += iva; }
    else { out.netoOtras += base; out.ivaOtras += iva; }
  }
  Object.keys(out).forEach(k => { out[k] = r2(out[k]); });
  return out;
}

const COLS_IVA = [
  { clave: 'neto21', titulo: 'Neto gravado 21%' }, { clave: 'iva21', titulo: 'IVA 21%' },
  { clave: 'neto105', titulo: 'Neto gravado 10,5%' }, { clave: 'iva105', titulo: 'IVA 10,5%' },
  { clave: 'neto27', titulo: 'Neto gravado 27%' }, { clave: 'iva27', titulo: 'IVA 27%' },
  { clave: 'netoOtras', titulo: 'Neto otras alícuotas / exento' }, { clave: 'ivaOtras', titulo: 'IVA otras alícuotas' }
];

function enviarLibro(res, q, nombre, columnas, filas, totalesClaves) {
  const total = { };
  totalesClaves.forEach(k => { total[k] = r2(filas.reduce((a, f) => a + Number(f[k] || 0), 0)); });
  if (String(q.formato || '').toLowerCase() === 'xlsx') {
    const aoa = [columnas.map(c => c.titulo)].concat(filas.map(f => columnas.map(c => f[c.clave] === undefined ? '' : f[c.clave])));
    aoa.push(columnas.map((c, i) => i === 0 ? 'TOTALES' : (totalesClaves.includes(c.clave) ? total[c.clave] : '')));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = columnas.map(c => ({ wch: Math.max(12, c.titulo.length + 2) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Libro');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }
  res.json({ columnas, filas, totales: total });
}

router.get('/libro-iva-ventas', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    rangoFechas(req.query); // valida el formato
    const match = { orgId, esFiscal: true, cae: { $exists: true }, estado: { $ne: 'anulada' } };
    const { ventas: ventasTodas, entorno } = await conReintento(async () => {
      const db = await getDb();
      const cfg = await emision.getConfig(db, orgId);
      return { entorno: cfg.entorno, ventas: await db.collection('ventas').find(match).sort({ fiscalFecha: 1, numeroFiscal: 1 }).toArray() };
    });
    // En producción el libro NO incluye lo emitido en homologación (no tiene validez fiscal).
    const ventas = ventasTodas.filter(v => entorno !== 'produccion' || v.fiscalEntorno === 'produccion');
    // Se filtra por la fecha del comprobante (la que ARCA registró), no por la de carga.
    const desde = req.query.desde ? req.query.desde.replace(/-/g, '') : null;
    const hasta = req.query.hasta ? req.query.hasta.replace(/-/g, '') : null;
    const filas = ventas.filter(v => (!desde || v.fiscalFecha >= desde) && (!hasta || v.fiscalFecha <= hasta)).map(v => {
      const familia = v.tipoComprobante === 'nota_credito' ? 'nota_credito' : v.tipoComprobante === 'nota_debito' ? 'nota_debito' : 'factura';
      // El libro va en pesos: las ventas en dólares se pasan con la cotización informada a ARCA.
      const signo = (familia === 'nota_credito' ? -1 : 1) * ((v.fiscalMoneda === 'DOL' && Number(v.fiscalCotiz) > 0) ? Number(v.fiscalCotiz) : 1);
      const g = columnasIva((v.fiscal && v.fiscal.grupos) || [], signo);
      const neto = r2(signo * ((v.fiscal && v.fiscal.neto) || 0)), iva = r2(signo * ((v.fiscal && v.fiscal.iva) || 0));
      return Object.assign({
        fecha: fiscalDDMMAAAA(v.fiscalFecha), tipo: `${LETRA_TIPO[familia]} ${v.letra}`,
        puntoVenta: String(v.puntoVenta).padStart(4, '0'), numero: String(v.numeroFiscal).padStart(8, '0'),
        cliente: v.clienteNombre || '', cuit: v.fiscalDocTipo === 80 || v.fiscalDocTipo === 86 ? v.fiscalDocNro : '',
        cae: v.cae, entorno: v.fiscalEntorno === 'produccion' ? '' : 'HOMOLOGACIÓN'
      }, g, { totalNeto: neto, totalIva: iva, total: r2(signo * v.total) });
    });
    const cols = [
      { clave: 'fecha', titulo: 'Fecha' }, { clave: 'tipo', titulo: 'Comprobante' }, { clave: 'puntoVenta', titulo: 'Pto. Vta.' }, { clave: 'numero', titulo: 'Número' },
      { clave: 'cliente', titulo: 'Cliente' }, { clave: 'cuit', titulo: 'CUIT/Doc.' }
    ].concat(COLS_IVA, [{ clave: 'totalNeto', titulo: 'Total neto' }, { clave: 'totalIva', titulo: 'Total IVA' }, { clave: 'total', titulo: 'Total' }, { clave: 'cae', titulo: 'CAE' }, { clave: 'entorno', titulo: 'Observación' }]);
    enviarLibro(res, req.query, 'libro-iva-ventas', cols, filas, COLS_IVA.map(c => c.clave).concat(['totalNeto', 'totalIva', 'total']));
  } catch (e) { responder(res, e); }
});

router.get('/libro-iva-compras', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const rango = rangoFechas(req.query);
    const match = { orgId, esFiscal: true, estado: { $ne: 'anulada' } };
    if (rango) match.fecha = rango;
    const db = await getDb();
    const [compras, gastos] = await Promise.all([
      db.collection('compras').find(match).sort({ fecha: 1 }).toArray(),
      db.collection('gastos').find(match).sort({ fecha: 1 }).toArray()
    ]);
    const provIds = [...new Set(compras.concat(gastos).map(d => d.proveedorId).filter(Boolean).map(String))].map(toObjectId).filter(Boolean);
    const provs = provIds.length ? await db.collection('proveedores').find({ _id: { $in: provIds } }).project({ cuit: 1 }).toArray() : [];
    const cuitPorProv = {}; provs.forEach(p => { cuitPorProv[String(p._id)] = p.cuit || ''; });
    const TIPOS = { factura_a: 'Factura A', factura_b: 'Factura B', factura_c: 'Factura C', factura_m: 'Factura M', nota_credito_a: 'Nota de Crédito A', nota_credito_b: 'Nota de Crédito B', nota_credito_c: 'Nota de Crédito C', nota_credito_m: 'Nota de Crédito M', nota_debito_a: 'Nota de Débito A', nota_debito_b: 'Nota de Débito B', nota_debito_c: 'Nota de Débito C', nota_debito_m: 'Nota de Débito M' };
    const fila = (d, origen) => {
      const signo = /^nota_credito/.test(d.tipoComprobante) ? -1 : 1;
      const sub = (d.items || []).reduce((a, it) => a + Number(it.subtotal || 0), 0);
      let conDesc = sub;
      if (d.descuentoPorcentaje) conDesc -= conDesc * (d.descuentoPorcentaje / 100);
      if (d.descuentoMonto) conDesc -= d.descuentoMonto;
      const factor = sub > 0 ? Math.max(0, conDesc) / sub : 1;
      const mapa = new Map();
      for (const it of (d.items || [])) {
        const p = Number(it.alicuotaIva || 0);
        const g = mapa.get(p) || { porcentaje: p, baseImp: 0, importe: 0 };
        g.baseImp += Number(it.subtotal || 0) * factor; g.importe += Number(it.importeIva || 0) * factor;
        mapa.set(p, g);
      }
      const cols = columnasIva([...mapa.values()], signo);
      const perc = d.percepciones || [];
      const suma = f => r2(signo * perc.filter(f).reduce((a, p) => a + Number(p.monto || 0), 0));
      const ivaTotal = r2(cols.iva21 + cols.iva105 + cols.iva27 + cols.ivaOtras);
      const netoTotal = r2(cols.neto21 + cols.neto105 + cols.neto27 + cols.netoOtras);
      return Object.assign({
        fecha: fechaDDMMAAAA(d.fecha), origen, tipo: TIPOS[d.tipoComprobante] || d.tipoComprobante,
        puntoVenta: String(d.puntoVenta || '').padStart(4, '0'), numero: String(d.comprobanteNumero || '').padStart(8, '0'),
        proveedor: d.proveedorNombre || '', cuit: cuitPorProv[String(d.proveedorId)] || ''
      }, cols, {
        totalNeto: netoTotal, totalIva: ivaTotal,
        percIva: suma(p => p.tipo === 'iva'), percIibb: suma(p => p.tipo === 'iibb'), percOtras: suma(p => p.tipo !== 'iva' && p.tipo !== 'iibb'),
        impCreditoDebito: r2(signo * (Number(d.impuestoCredito || 0) + Number(d.impuestoDebito || 0))),
        otrosImpuestos: r2(signo * Number(d.otrosImpuestos || 0)), total: r2(signo * Number(d.total || 0))
      });
    };
    const filas = compras.map(d => fila(d, 'Compra')).concat(gastos.map(d => fila(d, 'Gasto')));
    filas.sort((a, b) => a.fecha.split('/').reverse().join('').localeCompare(b.fecha.split('/').reverse().join('')));
    const cols = [
      { clave: 'fecha', titulo: 'Fecha' }, { clave: 'origen', titulo: 'Origen' }, { clave: 'tipo', titulo: 'Comprobante' }, { clave: 'puntoVenta', titulo: 'Pto. Vta.' }, { clave: 'numero', titulo: 'Número' },
      { clave: 'proveedor', titulo: 'Proveedor' }, { clave: 'cuit', titulo: 'CUIT' }
    ].concat(COLS_IVA, [
      { clave: 'totalNeto', titulo: 'Total neto' }, { clave: 'totalIva', titulo: 'Total IVA (crédito fiscal)' },
      { clave: 'percIva', titulo: 'Percepciones IVA' }, { clave: 'percIibb', titulo: 'Percepciones IIBB' }, { clave: 'percOtras', titulo: 'Otras percepciones' },
      { clave: 'impCreditoDebito', titulo: 'Imp. créd./déb. bancario' }, { clave: 'otrosImpuestos', titulo: 'Otros impuestos' }, { clave: 'total', titulo: 'Total' }
    ]);
    enviarLibro(res, req.query, 'libro-iva-compras', cols, filas, COLS_IVA.map(c => c.clave).concat(['totalNeto', 'totalIva', 'percIva', 'percIibb', 'percOtras', 'impCreditoDebito', 'otrosImpuestos', 'total']));
  } catch (e) { responder(res, e); }
});

router.get('/retenciones', authFiscal, async (req, res) => {
  try {
    const orgId = exigirOrg(req);
    const rango = rangoFechas(req.query);
    const match = { orgId };
    if (rango) match.fecha = rango;
    const lista = await conReintento(async () => (await getDb()).collection('retenciones_sufridas').find(match).sort({ fecha: 1 }).toArray());
    const ORIGEN = { cobro_venta: 'Cobro de venta', cobro_cuenta: 'Cobro a cuenta', compra: 'Compra', gasto: 'Gasto' };
    const filas = lista.map(r => ({
      fecha: fechaDDMMAAAA(r.fecha), impuesto: r.tipoNombre || r.tipo, monto: r2(r.monto), moneda: r.moneda || 'ARS',
      origen: ORIGEN[r.origen] || r.origen,
      referencia: [r.compraNumero && `Compra #${r.compraNumero}`, r.gastoNumero && `Gasto #${r.gastoNumero}`, r.ventaNumero && `Venta #${r.ventaNumero}`, r.reciboNumero && `Recibo #${r.reciboNumero}`].filter(Boolean).join(' '),
      de: r.proveedorNombre || r.clienteNombre || '', nota: r.nota || ''
    }));
    const cols = [{ clave: 'fecha', titulo: 'Fecha' }, { clave: 'impuesto', titulo: 'Impuesto' }, { clave: 'monto', titulo: 'Monto' }, { clave: 'moneda', titulo: 'Moneda' },
      { clave: 'origen', titulo: 'Origen' }, { clave: 'referencia', titulo: 'Referencia' }, { clave: 'de', titulo: 'Cliente / Proveedor' }, { clave: 'nota', titulo: 'Nota' }];
    enviarLibro(res, req.query, 'retenciones-sufridas', cols, filas, ['monto']);
  } catch (e) { responder(res, e); }
});

module.exports = router;
