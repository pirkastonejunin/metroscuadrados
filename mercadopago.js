// ---------------------------------------------------------------------------
// Mercado Pago (8/10/2026, pedido de Mato: "quiero cobrar con Point y con link
// de pago"). Es independiente de Tiendanube: todo cuelga de las ventas del
// sistema, así sigue sirviendo el día que haya tienda propia.
//
// Qué hace:
//   - Configuración por organización: access token de Mercado Pago, banco de
//     Tesorería donde entra la plata, terminal Point por defecto.
//   - Link de pago (Checkout Pro): crea una "preferencia" por el saldo (o un
//     monto) de una venta y devuelve el link para mandárselo al cliente.
//   - Point: manda el cobro a una terminal (Orders API) y espera el resultado.
//   - Cuando el pago está aprobado registra solo el cobro en la venta
//     (Tesorería + cuenta corriente), una única vez por pago.
//
// Cómo se entera de que pagaron (dos caminos, ambos idempotentes):
//   1) Webhook: Mercado Pago llama a /api/mercadopago/webhook/:token. El token
//      va en la URL (secreto por organización). Nunca se confía en el
//      contenido de la notificación: se vuelve a consultar el pago/orden a
//      Mercado Pago con nuestro propio access token.
//   2) Verificación activa: la pantalla de ventas consulta el estado cada
//      pocos segundos (POST /cobros/:id/verificar), así que funciona aunque el
//      webhook no llegue.
//
// Colecciones nuevas: mp_config, mp_cobros (cada link/orden), mp_eventos (log
// crudo de notificaciones, para diagnosticar).
// ---------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { aplicarMovimientoCuenta } = require('./tesoreria');
const { registrarMovimientoCuentaCorriente } = require('./clientes');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('tesoreria')];

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(
        () => { mongoClient = nuevo; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
const txt = v => (v === undefined || v === null) ? '' : String(v).trim();
const redondear = n => Math.round(Number(n) * 100) / 100;

const API = () => (process.env.MP_API_URL || 'https://api.mercadopago.com').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Cliente HTTP de Mercado Pago
// ---------------------------------------------------------------------------
async function mp(cfg, metodo, ruta, body, extraHeaders) {
  if (!cfg || !cfg.accessToken) throw err(400, 'Falta configurar el access token de Mercado Pago.');
  const headers = Object.assign({ Authorization: 'Bearer ' + cfg.accessToken, 'Content-Type': 'application/json' }, extraHeaders || {});
  let r;
  try {
    r = await fetch(API() + ruta, { method: metodo, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw err(502, 'No se pudo conectar con Mercado Pago: ' + e.message);
  }
  const texto = await r.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch (e) { data = { raw: texto }; }
  if (!r.ok) {
    const detalle = data.message || data.error || (data.errors && data.errors.map(x => x.message || x.code).join(', ')) || ('HTTP ' + r.status);
    throw err(r.status === 401 || r.status === 403 ? 400 : 502, 'Mercado Pago: ' + detalle);
  }
  return data;
}

async function cargarConfig(db, orgId) {
  return db.collection('mp_config').findOne({ orgId });
}
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.get('host')}`;
}
function urlWebhook(req, cfg) { return `${baseUrl(req)}/api/mercadopago/webhook/${cfg.webhookToken}`; }

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
router.get('/config', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    let cfg = await cargarConfig(db, req.orgId);
    if (!cfg) {
      cfg = { orgId: req.orgId, accessToken: '', bancoId: null, terminalId: '', webhookToken: crypto.randomBytes(24).toString('hex'), createdAt: new Date() };
      await db.collection('mp_config').insertOne(cfg);
    }
    const t = cfg.accessToken || '';
    res.json({
      tokenCargado: !!t, tokenParcial: t ? '••••' + t.slice(-4) : '',
      bancoId: cfg.bancoId || null, terminalId: cfg.terminalId || '',
      webhookUrl: urlWebhook(req, cfg), modoPrueba: /^TEST-/.test(t)
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const b = req.body || {};
    const db = await getDb();
    const set = { updatedAt: new Date() };
    if (b.accessToken !== undefined && txt(b.accessToken)) set.accessToken = txt(b.accessToken);
    if (b.bancoId !== undefined) {
      const id = b.bancoId ? toObjectId(b.bancoId) : null;
      if (id && !(await db.collection('tesoreria_bancos').findOne({ _id: id }))) throw err(400, 'Ese banco no existe.');
      set.bancoId = id;
    }
    if (b.terminalId !== undefined) set.terminalId = txt(b.terminalId);
    await db.collection('mp_config').updateOne(
      { orgId: req.orgId },
      { $set: set, $setOnInsert: { orgId: req.orgId, webhookToken: crypto.randomBytes(24).toString('hex'), createdAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Prueba la conexión: pide a Mercado Pago los datos del usuario dueño del token.
router.post('/config/probar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    const u = await mp(cfg, 'GET', '/users/me');
    res.json({ ok: true, usuario: u.nickname || u.email || u.id, pais: u.site_id || '' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/terminales', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    const d = await mp(cfg, 'GET', '/terminals/v1/list?limit=50');
    const lista = (d && d.data && d.data.terminals) || d.terminals || (Array.isArray(d.data) ? d.data : null) || (Array.isArray(d) ? d : []);
    res.json(lista.map(t => ({ id: t.id, modo: t.operating_mode || '', nombre: t.name || '', pdv: (t.operating_mode || '') === 'PDV' })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Pone una terminal en modo PDV (hace falta para que reciba cobros desde el sistema).
router.post('/terminales/:id/pdv', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    const id = txt(req.params.id);
    if (!id) throw err(400, 'Falta la terminal.');
    await mp(cfg, 'PATCH', '/terminals/v1/setup', { terminals: [{ id, operating_mode: 'PDV' }] });
    res.json({ ok: true, aviso: 'Listo. Si la terminal no cambia sola, reiniciala (apagar y prender).' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Crear cobros
// ---------------------------------------------------------------------------
async function ventaParaCobrar(db, req, monto) {
  const ventaId = toObjectId(req.params.ventaId);
  if (!ventaId) throw err(400, 'id inválido');
  const venta = await db.collection('ventas').findOne(Object.assign({ _id: ventaId }, filtroOrg(req)));
  if (!venta) throw err(404, 'Venta no encontrada');
  if (venta.estado === 'anulada') throw err(400, 'La venta está anulada.');
  if ((venta.moneda || 'ARS') !== 'ARS') throw err(400, 'Mercado Pago solo cobra en pesos; esta venta está en otra moneda.');
  const saldo = redondear(venta.saldoPendiente != null ? venta.saldoPendiente : venta.total);
  const m = monto === undefined || monto === null || monto === '' ? saldo : redondear(monto);
  if (!(m > 0)) throw err(400, 'No hay saldo para cobrar.');
  if (m > saldo + 0.009) throw err(400, `El monto no puede superar el saldo pendiente (${saldo}).`);
  return { venta, monto: m };
}
function numeroVenta(v) { return `${v.letra || (v.tipoComprobante === 'fiscal' ? 'F' : 'X')}-${String(v.numero).padStart(5, '0')}`; }

router.post('/ventas/:ventaId/link', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    if (!cfg || !cfg.accessToken) throw err(400, 'Falta configurar Mercado Pago (access token).');
    if (!cfg.bancoId) throw err(400, 'Falta elegir en qué banco de Tesorería entra la plata de Mercado Pago.');
    const { venta, monto } = await ventaParaCobrar(db, req, req.body && req.body.monto);
    const cobroId = new ObjectId();
    const ref = 'pn-' + String(cobroId);
    const hoy = new Date();
    const vence = new Date(hoy.getTime() + 7 * 24 * 3600 * 1000); // el link vive 7 días
    const pref = await mp(cfg, 'POST', '/checkout/preferences', {
      items: [{ id: String(venta._id), title: `Venta ${numeroVenta(venta)}`.slice(0, 120), quantity: 1, unit_price: monto, currency_id: 'ARS' }],
      external_reference: ref,
      notification_url: urlWebhook(req, cfg),
      expires: true, expiration_date_to: vence.toISOString()
    });
    const link = pref.init_point;
    if (!link) throw err(502, 'Mercado Pago no devolvió el link de pago.');
    const doc = { _id: cobroId, orgId: req.orgId, ventaId: venta._id, tipo: 'link', externalReference: ref, monto, estado: 'pendiente',
      preferenciaId: pref.id, linkUrl: link, venceEn: vence, usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: hoy, updatedAt: hoy };
    await db.collection('mp_cobros').insertOne(doc);
    res.json(publico(doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/ventas/:ventaId/point', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    if (!cfg || !cfg.accessToken) throw err(400, 'Falta configurar Mercado Pago (access token).');
    if (!cfg.bancoId) throw err(400, 'Falta elegir en qué banco de Tesorería entra la plata de Mercado Pago.');
    const terminalId = txt(req.body && req.body.terminalId) || cfg.terminalId;
    if (!terminalId) throw err(400, 'Elegí la terminal Point (o dejá una por defecto en la configuración).');
    const { venta, monto } = await ventaParaCobrar(db, req, req.body && req.body.monto);
    const cobroId = new ObjectId();
    const ref = 'pn-' + String(cobroId);
    const orden = await mp(cfg, 'POST', '/v1/orders', {
      type: 'point', external_reference: ref, expiration_time: 'PT15M',
      transactions: { payments: [{ amount: monto.toFixed(2) }] },
      config: { point: { terminal_id: terminalId, print_on_terminal: 'no_ticket' } },
      description: `Venta ${numeroVenta(venta)}`.slice(0, 150)
    }, { 'X-Idempotency-Key': crypto.randomUUID() });
    const hoy = new Date();
    const doc = { _id: cobroId, orgId: req.orgId, ventaId: venta._id, tipo: 'point', externalReference: ref, monto, estado: 'pendiente',
      ordenId: orden.id, terminalId, usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: hoy, updatedAt: hoy };
    await db.collection('mp_cobros').insertOne(doc);
    res.json(publico(doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

function publico(c) {
  return { _id: c._id, ventaId: c.ventaId, tipo: c.tipo, monto: c.monto, estado: c.estado, linkUrl: c.linkUrl || null,
    estadoMp: c.estadoMp || '', error: c.error || '', createdAt: c.createdAt, acreditadoEn: c.acreditadoEn || null, venceEn: c.venceEn || null };
}

router.get('/ventas/:ventaId/cobros', auth, async (req, res) => {
  try {
    const ventaId = toObjectId(req.params.ventaId);
    if (!ventaId) throw err(400, 'id inválido');
    const db = await getDb();
    const lista = await db.collection('mp_cobros').find(Object.assign({ ventaId }, filtroOrg(req))).sort({ createdAt: -1 }).limit(30).toArray();
    res.json(lista.map(publico));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/cobros', auth, async (req, res) => {
  try {
    const db = await getDb();
    const lista = await db.collection('mp_cobros').find(filtroOrg(req)).sort({ createdAt: -1 }).limit(100).toArray();
    const ventas = await db.collection('ventas').find({ _id: { $in: lista.map(c => c.ventaId) } }).project({ numero: 1, letra: 1, tipoComprobante: 1, clienteNombre: 1 }).toArray();
    const pv = {}; ventas.forEach(v => { pv[String(v._id)] = v; });
    res.json(lista.map(c => { const v = pv[String(c.ventaId)]; return Object.assign(publico(c), { venta: v ? numeroVenta(v) : '', cliente: v ? v.clienteNombre : '' }); }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Conciliación: consulta a Mercado Pago y, si está aprobado, registra el cobro
// ---------------------------------------------------------------------------
const PAGO_OK = ['approved', 'processed', 'paid', 'accredited'];
const PAGO_FALLIDO = ['rejected', 'cancelled', 'canceled', 'refunded', 'charged_back', 'expired', 'failed'];

// Normaliza lo que devuelve Mercado Pago (pago clásico u orden de Point) a
// { estado: 'aprobado'|'rechazado'|'pendiente', monto, paymentId, metodo, comision }.
function interpretar(data, esOrden) {
  if (esOrden) {
    const pagos = (data.transactions && data.transactions.payments) || [];
    const ok = pagos.find(p => PAGO_OK.includes(String(p.status || '').toLowerCase()) || PAGO_OK.includes(String(p.status_detail || '').toLowerCase()));
    const estadoOrden = String(data.status || '').toLowerCase();
    if (ok || PAGO_OK.includes(estadoOrden)) {
      const p = ok || pagos[0] || {};
      const monto = Number(p.paid_amount != null ? p.paid_amount : (p.amount != null ? p.amount : data.total_paid_amount)) || 0;
      const pm = p.payment_method || {};
      return { estado: 'aprobado', monto, paymentId: String(p.id || data.id), metodo: pm.type || pm.id || '', estadoMp: estadoOrden };
    }
    if (PAGO_FALLIDO.includes(estadoOrden) || pagos.some(p => PAGO_FALLIDO.includes(String(p.status || '').toLowerCase()))) return { estado: 'rechazado', estadoMp: estadoOrden };
    return { estado: 'pendiente', estadoMp: estadoOrden };
  }
  const st = String(data.status || '').toLowerCase();
  if (st === 'approved') {
    const fees = (data.fee_details || []).reduce((a, f) => a + (Number(f.amount) || 0), 0);
    return { estado: 'aprobado', monto: Number(data.transaction_amount) || 0, paymentId: String(data.id), metodo: data.payment_type_id || '', comision: redondear(fees), estadoMp: st };
  }
  if (PAGO_FALLIDO.includes(st)) return { estado: 'rechazado', estadoMp: st };
  return { estado: 'pendiente', estadoMp: st };
}

// Trae el pago real (cualquier medio) para saber cuánto descuenta Mercado Pago:
// comisión e impuestos/retenciones. Si falla, el cobro igual se registra completo.
async function completarDescuentos(cfg, info) {
  info.comision = info.comision || 0; info.impuestos = info.impuestos || 0;
  if (!/^\d+$/.test(String(info.paymentId || ''))) return info;
  let p;
  try { p = await mp(cfg, 'GET', '/v1/payments/' + info.paymentId); } catch (e) { return info; }
  const num = x => Number(x) || 0;
  const fees = (p.fee_details || []).reduce((a, f) => a + num(f.amount), 0);
  let imp = 0;
  (p.charges_details || []).forEach(c => { if (String(c.type || '').toLowerCase() === 'tax') imp += num(c.amounts && c.amounts.original); });
  if (!imp) imp = num(p.taxes_amount);
  let comision = redondear(fees), impuestos = redondear(imp);
  const bruto = num(p.transaction_amount) || info.monto;
  const neto = p.transaction_details && p.transaction_details.net_received_amount != null ? num(p.transaction_details.net_received_amount) : null;
  if (neto !== null && neto > 0 && neto <= bruto) {
    // Lo que realmente deposita Mercado Pago manda: si no coincide con comisión + impuestos, la diferencia se suma a la comisión.
    const total = redondear(bruto - neto);
    if (total > comision + impuestos + 0.009) comision = redondear(total - impuestos);
    info.neto = neto;
  }
  info.comision = comision; info.impuestos = impuestos;
  return info;
}

async function registrarCobroEnVenta(db, cfg, cobro, info) {
  const venta = await db.collection('ventas').findOne({ _id: cobro.ventaId, orgId: cobro.orgId });
  if (!venta) throw err(404, 'La venta del cobro ya no existe.');
  if (venta.estado === 'anulada') throw err(400, 'La venta está anulada: el cobro de Mercado Pago quedó sin imputar, revisalo.');
  if (!cfg.bancoId) throw err(400, 'Falta elegir el banco de Tesorería para Mercado Pago.');
  const reqFalso = { orgId: cobro.orgId, usuario: { nombre: 'Mercado Pago' } };
  const monto = redondear(info.monto || cobro.monto);
  const fecha = new Date();
  const esTarjeta = /card/.test(info.metodo || '');
  const tipoValor = esTarjeta ? 'tarjeta' : 'cuenta';
  const nota = `Mercado Pago ${cobro.tipo === 'point' ? 'Point' : 'link de pago'} · pago ${info.paymentId}`;
  await aplicarMovimientoCuenta(db, reqFalso, {
    cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'ingreso', monto, moneda: 'ARS',
    motivo: `Cobro venta Nº ${venta.numero}`, observaciones: nota, origen: 'venta', ventaId: venta._id, fecha, omitirPermiso: true
  });
  if (info.comision > 0) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.comision, moneda: 'ARS',
      motivo: 'Comisión Mercado Pago', observaciones: `Venta Nº ${venta.numero} · pago ${info.paymentId}`, origen: 'manual', ventaId: venta._id, fecha, omitirPermiso: true
    });
  }
  if (info.impuestos > 0) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.impuestos, moneda: 'ARS',
      motivo: 'Impuestos y retenciones Mercado Pago', observaciones: `Venta Nº ${venta.numero} · pago ${info.paymentId}`, origen: 'manual', ventaId: venta._id, fecha, omitirPermiso: true
    });
  }
  const totalCobrado = (venta.totalCobrado || 0) + monto;
  const saldoPendiente = Math.max(0, venta.total - totalCobrado);
  await db.collection('ventas').updateOne({ _id: venta._id }, {
    $push: { pagos: { tipoValor, monto, fecha, nota, usuarioNombre: 'Mercado Pago', cuentaTipo: 'banco', cuentaId: cfg.bancoId, mercadoPagoId: info.paymentId } },
    $set: { totalCobrado, saldoPendiente, updatedAt: new Date() }
  });
  await registrarMovimientoCuentaCorriente(db, reqFalso, {
    clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto, moneda: 'ARS',
    concepto: `Cobro venta Nº ${venta.numero}`, origen: 'cobro_venta', ventaId: venta._id, chequeId: null, fecha, observaciones: nota
  });
}

// Consulta el estado en Mercado Pago y, si corresponde, registra el cobro (una sola vez).
async function conciliarCobro(db, cfg, cobro) {
  if (cobro.estado === 'acreditado') return cobro;
  let info;
  if (cobro.tipo === 'point') {
    info = interpretar(await mp(cfg, 'GET', '/v1/orders/' + encodeURIComponent(cobro.ordenId)), true);
  } else {
    const r = await mp(cfg, 'GET', '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(cobro.externalReference));
    const pagos = (r.results || []).map(p => interpretar(p, false));
    info = pagos.find(p => p.estado === 'aprobado') || pagos[0] || { estado: 'pendiente', estadoMp: '' };
  }
  const base = { estadoMp: info.estadoMp || '', updatedAt: new Date() };
  if (info.estado === 'aprobado') {
    // Se "reclama" el cobro de forma atómica: si dos caminos (webhook + verificación) llegan a la vez, solo uno lo registra.
    const reclamado = await db.collection('mp_cobros').findOneAndUpdate(
      { _id: cobro._id, estado: { $in: ['pendiente', 'error'] } }, { $set: Object.assign({ estado: 'registrando', error: '' }, base) }, { returnDocument: 'after' });
    const doc = reclamado && (reclamado.value !== undefined ? reclamado.value : reclamado);
    if (!doc) return db.collection('mp_cobros').findOne({ _id: cobro._id });
    try {
      await completarDescuentos(cfg, info);
      await registrarCobroEnVenta(db, cfg, doc, info);
      await db.collection('mp_cobros').updateOne({ _id: cobro._id }, { $set: { estado: 'acreditado', paymentId: info.paymentId, montoAcreditado: info.monto, comision: info.comision || 0, impuestos: info.impuestos || 0, neto: info.neto != null ? info.neto : null, acreditadoEn: new Date() } });
    } catch (e) {
      await db.collection('mp_cobros').updateOne({ _id: cobro._id }, { $set: { estado: 'error', error: e.message } });
    }
  } else if (info.estado === 'rechazado') {
    await db.collection('mp_cobros').updateOne({ _id: cobro._id, estado: 'pendiente' }, { $set: Object.assign({ estado: 'rechazado' }, base) });
  } else {
    await db.collection('mp_cobros').updateOne({ _id: cobro._id, estado: 'pendiente' }, { $set: base });
  }
  return db.collection('mp_cobros').findOne({ _id: cobro._id });
}

router.post('/cobros/:id/verificar', auth, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const db = await getDb();
    const cobro = await db.collection('mp_cobros').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    if (!cobro) throw err(404, 'Cobro no encontrado');
    const cfg = await cargarConfig(db, cobro.orgId);
    res.json(publico(await conciliarCobro(db, cfg, cobro)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/cobros/:id/cancelar', auth, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const db = await getDb();
    const cobro = await db.collection('mp_cobros').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    if (!cobro) throw err(404, 'Cobro no encontrado');
    if (cobro.estado === 'acreditado') throw err(400, 'Ese cobro ya se acreditó.');
    const cfg = await cargarConfig(db, cobro.orgId);
    if (cobro.tipo === 'point') {
      try {
        await mp(cfg, 'POST', `/v1/orders/${encodeURIComponent(cobro.ordenId)}/cancel`, null,
          { 'X-Idempotency-Key': crypto.randomUUID(), 'x-allow-cancelable-status': 'at_terminal' });
      } catch (e) { /* si Mercado Pago no deja cancelarla, igual se la marca cancelada acá; si luego paga, la conciliación la registra */ }
    }
    await db.collection('mp_cobros').updateOne({ _id: id, estado: { $ne: 'acreditado' } }, { $set: { estado: 'cancelado', updatedAt: new Date() } });
    res.json(publico(await db.collection('mp_cobros').findOne({ _id: id })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Webhook (público: sin sesión; el token secreto va en la URL)
// ---------------------------------------------------------------------------
router.post('/webhook/:token', async (req, res) => {
  const token = txt(req.params.token);
  let db;
  try { db = await getDb(); } catch (e) { return res.sendStatus(500); }
  try {
    const cfg = token.length >= 24 ? await db.collection('mp_config').findOne({ webhookToken: token }) : null;
    if (!cfg) return res.sendStatus(404);
    const body = req.body || {};
    await db.collection('mp_eventos').insertOne({ orgId: cfg.orgId, query: req.query, body, recibidoEn: new Date() }).catch(() => {});
    // Se responde enseguida (Mercado Pago espera 200/201 en pocos segundos) y se concilia después.
    res.sendStatus(200);
    const tipo = String(body.type || body.topic || req.query.type || req.query.topic || '').toLowerCase();
    const recurso = String((body.data && body.data.id) || body.id || req.query['data.id'] || req.query.id || '');
    if (!recurso) return;
    let cobro = null;
    if (tipo.includes('order') || recurso.startsWith('ORD')) {
      cobro = await db.collection('mp_cobros').findOne({ orgId: cfg.orgId, ordenId: recurso });
      if (!cobro) { // por si la orden se creó por otro camino: se busca por su referencia
        const o = await mp(cfg, 'GET', '/v1/orders/' + encodeURIComponent(recurso)).catch(() => null);
        if (o && o.external_reference) cobro = await db.collection('mp_cobros').findOne({ orgId: cfg.orgId, externalReference: o.external_reference });
      }
    } else if (tipo === 'payment' || /^\d+$/.test(recurso)) {
      const p = await mp(cfg, 'GET', '/v1/payments/' + encodeURIComponent(recurso)).catch(() => null);
      if (p && p.external_reference) cobro = await db.collection('mp_cobros').findOne({ orgId: cfg.orgId, externalReference: p.external_reference });
    }
    if (cobro) await conciliarCobro(db, cfg, cobro);
  } catch (e) {
    console.error('Webhook Mercado Pago:', e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

router.conciliarCobro = conciliarCobro; // para pruebas
module.exports = router;
