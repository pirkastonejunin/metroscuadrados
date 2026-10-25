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
// Cobros desde "Todas las sucursales": si no hay una sucursal elegida, se usa la de la venta (o del cliente) que se está cobrando.
async function orgDesdeDoc(req, res, next) {
  try {
    if (!req.orgId) {
      const vId = req.params.ventaId || req.query.ventaId, cId = req.params.clienteId || req.query.clienteId;
      const ventaId = vId ? toObjectId(vId) : null, clienteId = cId ? toObjectId(cId) : null;
      const db = await getDb();
      const doc = ventaId ? await db.collection('ventas').findOne({ _id: ventaId }, { projection: { orgId: 1 } })
        : clienteId ? await db.collection('clientes').findOne({ _id: clienteId }, { projection: { orgId: 1 } }) : null;
      if (doc && doc.orgId) req.orgId = doc.orgId;
    }
    next();
  } catch (e) { next(e); }
}
const authCobro = [...auth, orgDesdeDoc];

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

// Limpieza (17/10/2026): borra los planes que había traído por tarjeta el botón "Traer planes de Mercado Pago" (ya quitado);
// reemplazados por los dos medios Point / Link de pago (ver /canales). Los cobros viejos conservan el nombre del plan usado.
router.delete('/planes/importados', auth, async (req, res) => {
  try {
    const db = await getDb();
    const orgs = await require('./tesoreria').orgsParaPlanes(db, req);
    const r = await db.collection('tarjetas_planes').deleteMany({ orgId: { $in: orgs }, origen: 'mercadopago' });
    res.json({ borrados: r.deletedCount });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Costos de cobrar con crédito en Mercado Pago (17/10/2026, pedido de Mato). Mercado Pago no los expone por API:
// se cargan a mano desde "Costos y cuotas" del panel de MP, UNO POR CANAL (link de pago / Point), porque difieren.
//   costo de un plan = (comisión base del canal + costo de financiación de esas cuotas) + IVA (los % de MP son siempre más IVA, 21%).
// Valores iniciales: los que informó Mato desde su panel. Link: comisión 5,99% + cuotas 2c 4,40 … 18c 26,10. Point: comisión 1,80% + cuotas 2c 4,00 … 18c 24,35.
// ---------------------------------------------------------------------------
const CANALES_COSTO = { link: 'Link de pago', point: 'Point' };
const COSTOS_INICIALES = {
  link: { base: 5.99, financiacion: [{ cuotas: 2, pct: 4.40 }, { cuotas: 3, pct: 6.20 }, { cuotas: 6, pct: 10.30 }, { cuotas: 9, pct: 15.30 }, { cuotas: 12, pct: 19.50 }, { cuotas: 18, pct: 26.10 }] },
  point: { base: 1.80, financiacion: [{ cuotas: 2, pct: 4.00 }, { cuotas: 3, pct: 5.30 }, { cuotas: 6, pct: 9.20 }, { cuotas: 9, pct: 13.50 }, { cuotas: 12, pct: 17.00 }, { cuotas: 18, pct: 24.35 }] }
};
function leerCostosCanal(c, def) {
  const base = Number(c && c.base); const fin = (c && Array.isArray(c.financiacion)) ? c.financiacion : def.financiacion;
  const iva = Number(c && c.iva);
  return { base: Number.isFinite(base) && c && c.base !== undefined ? base : def.base,
    iva: (c && c.iva !== undefined && Number.isFinite(iva) && iva >= 0 && iva <= 100) ? iva : 21,
    financiacion: fin.map(f => ({ cuotas: Math.floor(Number(f.cuotas)), pct: Number(f.pct) })).filter(f => f.cuotas >= 2 && Number.isFinite(f.pct) && f.pct >= 0 && f.pct <= 100).sort((a, b) => a.cuotas - b.cuotas) };
}
router.get('/costos', auth, async (req, res) => {
  try {
    const cfg = (await (await getDb()).collection('mp_costos').findOne({ _id: 'global' })) || {};
    const out = {};
    for (const k of Object.keys(CANALES_COSTO)) out[k] = Object.assign({ nombre: CANALES_COSTO[k] }, leerCostosCanal(cfg.costos && cfg.costos[k], COSTOS_INICIALES[k]));
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put('/costos/:canal', auth, async (req, res) => {
  try {
    if (!CANALES_COSTO[req.params.canal]) throw err(400, 'Canal inválido.');
    const b = req.body || {};
    const base = Number(b.base);
    if (!Number.isFinite(base) || base < 0 || base > 100) throw err(400, 'La comisión base tiene que estar entre 0 y 100.');
    const val = leerCostosCanal({ base, iva: b.iva, financiacion: b.financiacion || [] }, COSTOS_INICIALES[req.params.canal]);
    await (await getDb()).collection('mp_costos').updateOne({ _id: 'global' }, { $set: { ['costos.' + req.params.canal]: val, updatedAt: new Date() } }, { upsert: true });
    res.json(val);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Aplica a los planes de crédito: costo % = base + financiación. Opcional: recargo % para que el cliente cubra ese costo.
router.post('/costos/:canal/aplicar', auth, async (req, res) => {
  try {
    if (!CANALES_COSTO[req.params.canal]) throw err(400, 'Canal inválido.');
    const db = await getDb();
    const cfg = (await db.collection('mp_costos').findOne({ _id: 'global' })) || {};
    const c = leerCostosCanal(cfg.costos && cfg.costos[req.params.canal], COSTOS_INICIALES[req.params.canal]);
    const cubrir = !!(req.body && req.body.cubrirConRecargo);
    const orgs = await require('./tesoreria').orgsParaPlanes(db, req);
    const planes = await db.collection('tarjetas_planes').find({ orgId: { $in: orgs } }).toArray();
    const r = { actualizados: 0, omitidos: [] };
    const omit = new Set();
    for (const pl of planes) {
      if (!/cr[eé]dito/i.test(pl.tarjeta || '') || /american|amex/i.test(pl.tarjeta || '')) continue;
      const cuotas = Math.max(1, Number(pl.cuotas) || 1);
      const f = cuotas === 1 ? { pct: 0 } : c.financiacion.find(x => x.cuotas === cuotas);
      if (!f) { omit.add(`${pl.tarjeta} ${cuotas} cuotas (sin costo cargado para esa cantidad)`); continue; }
      const costo = redondear((c.base + f.pct) * (1 + c.iva / 100)); // los % de Mercado Pago son más IVA
      const set = { costoPorcentaje: costo, updatedAt: new Date() };
      if (cubrir && cuotas > 1) set.recargoPorcentaje = redondear((1 / (1 - costo / 100) - 1) * 100);
      await db.collection('tarjetas_planes').updateOne({ _id: pl._id }, { $set: set });
      r.actualizados++;
    }
    r.omitidos = [...omit];
    r.sucursales = orgs.length;
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Dos "medios" en vez de un plan por cada tarjeta (pedido de Mato, 17/10/2026): Mercado Pago Point y Mercado Pago Link de
// pago. El costo depende del canal y de la cantidad de cuotas (no de la tarjeta), así que cada canal es UNA tabla:
// cuotas → costo de las cuotas, recargo al cliente y si se ofrece. Al guardar se generan/actualizan los planes
// ("Mercado Pago Point — 3 cuotas", etc.) en TODAS las sucursales, que son los que se eligen al cobrar y en presupuestos.
// ---------------------------------------------------------------------------
const CANAL_TARJETA = { link: 'Mercado Pago Link de pago', point: 'Mercado Pago Point' };
const FILAS_CUOTAS = [1, 2, 3, 6, 9, 12, 18, 24];
router.get('/canales', auth, async (req, res) => {
  try {
    const db = await getDb();
    const orgs = await require('./tesoreria').orgsParaPlanes(db, req);
    const cfg = (await db.collection('mp_costos').findOne({ _id: 'global' })) || {};
    const out = {};
    for (const k of Object.keys(CANAL_TARJETA)) {
      const c = leerCostosCanal(cfg.costos && cfg.costos[k], COSTOS_INICIALES[k]);
      const planes = await db.collection('tarjetas_planes').find({ orgId: req.orgId ? req.orgId : { $in: orgs }, tarjeta: CANAL_TARJETA[k] }).toArray();
      const fin = {}; c.financiacion.forEach(f => fin[f.cuotas] = f.pct);
      out[k] = { nombre: CANAL_TARJETA[k], base: c.base, iva: c.iva, filas: FILAS_CUOTAS.map(n => {
        const pl = planes.find(x => Number(x.cuotas) === n);
        return { cuotas: n, financiacion: n === 1 ? 0 : (fin[n] !== undefined ? fin[n] : null), recargo: pl ? Number(pl.recargoPorcentaje) || 0 : 0, ofrecer: !!(pl && pl.activo !== false) };
      }) };
    }
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put('/canales/:canal', auth, async (req, res) => {
  try {
    const canal = req.params.canal, tarjeta = CANAL_TARJETA[canal];
    if (!tarjeta) throw err(400, 'Canal inválido.');
    const b = req.body || {};
    const num = (v, et, max) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > (max || 100)) throw err(400, `${et} tiene que estar entre 0 y ${max || 100}.`); return n; };
    const base = num(b.base, 'La comisión base'), iva = num(b.iva === undefined ? 21 : b.iva, 'El IVA');
    const filas = (Array.isArray(b.filas) ? b.filas : []).filter(f => FILAS_CUOTAS.includes(Number(f.cuotas)));
    const financiacion = [];
    const planes = [];
    for (const f of filas) {
      const cuotas = Number(f.cuotas);
      const tieneFin = f.financiacion !== null && f.financiacion !== '' && f.financiacion !== undefined;
      if (cuotas > 1 && tieneFin) financiacion.push({ cuotas, pct: num(f.financiacion, `El costo de ${cuotas} cuotas`) });
      if (!f.ofrecer) { planes.push({ cuotas, ofrecer: false }); continue; }
      if (cuotas > 1 && !tieneFin) throw err(400, `Para ofrecer ${cuotas} cuotas cargá su costo (el que figura en Costos y cuotas de Mercado Pago).`);
      const fin = cuotas === 1 ? 0 : num(f.financiacion, `El costo de ${cuotas} cuotas`);
      planes.push({ cuotas, ofrecer: true, costo: redondear((base + fin) * (1 + iva / 100)), recargo: num(f.recargo || 0, `El recargo de ${cuotas} cuotas`) });
    }
    const db = await getDb();
    await db.collection('mp_costos').updateOne({ _id: 'global' }, { $set: { ['costos.' + canal]: { base, iva, financiacion: financiacion.sort((a, c) => a.cuotas - c.cuotas) }, updatedAt: new Date() } }, { upsert: true });
    const orgs = await require('./tesoreria').orgsParaPlanes(db, req);
    const col = db.collection('tarjetas_planes');
    // Planes sueltos importados antes por tarjeta (sin revisar, inactivos): ya no hacen falta.
    await col.deleteMany({ orgId: { $in: orgs }, origen: 'mercadopago', activo: false });
    for (const orgId of orgs) {
      for (const pl of planes) {
        const nombre = pl.cuotas === 1 ? 'Contado' : `${pl.cuotas} cuotas`;
        if (!pl.ofrecer) { await col.updateMany({ orgId, tarjeta, cuotas: pl.cuotas }, { $set: { activo: false, updatedAt: new Date() } }); continue; }
        await col.updateOne({ orgId, tarjeta, cuotas: pl.cuotas }, { $set: { nombre, costoPorcentaje: pl.costo, recargoPorcentaje: pl.recargo, activo: true, updatedAt: new Date() },
          $setOnInsert: { orgId, tarjeta, cuotas: pl.cuotas, leyenda: '', vigenteHasta: null, listasPrecioIds: [], origen: 'mercadopago-canal', createdAt: new Date() } }, { upsert: true });
      }
    }
    res.json({ ok: true, sucursales: orgs.length });
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

// Crea una sucursal + caja en Mercado Pago (para que cada Point quede en su propia caja: solo se permite un Point en modo PDV por caja).
router.get('/sucursales', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    const u = await mp(cfg, 'GET', '/users/me');
    const st = await mp(cfg, 'GET', `/users/${u.id}/stores/search?limit=50`);
    const pos = await mp(cfg, 'GET', '/pos?limit=100');
    const tiendas = ((st && st.results) || []).map(x => ({ id: x.id, nombre: x.name, cajas: ((pos && pos.results) || []).filter(c => String(c.store_id) === String(x.id)).map(c => ({ id: c.id, nombre: c.name })) }));
    res.json(tiendas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/sucursales', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = txt(b.nombre), calle = txt(b.calle), numero = txt(b.numero), ciudad = txt(b.ciudad), provincia = txt(b.provincia);
    const lat = Number(b.latitud), lng = Number(b.longitud);
    if (!nombre || !calle || !numero || !ciudad || !provincia) throw err(400, 'Completá nombre, calle, número, ciudad y provincia.');
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw err(400, 'Falta la latitud y longitud (en Google Maps: clic derecho sobre el local → copiar coordenadas).');
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    const u = await mp(cfg, 'GET', '/users/me');
    const tienda = await mp(cfg, 'POST', `/users/${u.id}/stores`, { name: nombre, location: { street_number: numero, street_name: calle, city_name: ciudad, state_name: provincia, latitude: lat, longitude: lng, reference: txt(b.referencia) } });
    const caja = await mp(cfg, 'POST', '/pos', { name: 'Caja ' + nombre, fixed_amount: false, store_id: tienda.id, external_id: ('caja' + nombre).replace(/[^A-Za-z0-9]/g, '').slice(0, 40) + Date.now().toString().slice(-5) });
    res.json({ ok: true, sucursal: { id: tienda.id, nombre: tienda.name }, caja: { id: caja.id, nombre: caja.name } });
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
// Cobro a cuenta de un cliente (sin venta puntual) — desde Cobranza / Cuenta corriente (15/10/2026).
async function clienteParaCobrar(db, req, monto) {
  const clienteId = toObjectId(req.params.clienteId);
  if (!clienteId) throw err(400, 'id inválido');
  const cliente = await db.collection('clientes').findOne(Object.assign({ _id: clienteId }, filtroOrg(req)));
  if (!cliente) throw err(404, 'Cliente no encontrado');
  const m = redondear(monto);
  if (!(m > 0)) throw err(400, 'Indicá el monto a cobrar.');
  const nombre = [cliente.apellidoRazonSocial, cliente.nombre].filter(Boolean).join(' ') || 'Cliente';
  return { cliente, clienteNombre: nombre, monto: m };
}
function numeroVenta(v) { return `${v.letra || (v.tipoComprobante === 'fiscal' ? 'F' : 'X')}-${String(v.numero).padStart(5, '0')}`; }

// Plan de tarjeta elegido al cobrar con Point/link (17/10/2026, pedido de Mato): a la terminal / al link va el monto MÁS el recargo
// del plan (el cliente absorbe el costo si así está configurado). Lo que cancela deuda sigue siendo el monto sin recargo, el recargo
// se registra como ingreso financiero y el costo es el REAL que informa Mercado Pago (no el cargado en el plan).
async function planParaCobro(db, req, planId, monto) {
  if (!planId) return null;
  const pl = await require('./tesoreria').calcularPlanTarjeta(db, req, { planId, monto });
  if (!pl) throw err(400, 'El plan elegido no existe.');
  return pl;
}
function camposPlanCobro(pl) {
  return pl ? { planId: pl.tarjetaPlanId, planNombre: pl.tarjetaPlanNombre, planCuotas: pl.tarjetaCuotas, recargoPorcentaje: pl.tarjetaRecargoPorcentaje, recargo: pl.tarjetaRecargo, montoCobrar: pl.tarjetaTotalCobrado } : {};
}

// Planes ofrecibles al cobrar (activos y vigentes) para el canal Point / link, con el recargo ya calculado sobre el monto.
// Valor de las cuotas según Mercado Pago (25/10/2026, pedido de Mato): el link cobra el monto de la venta y es Mercado Pago el que ofrece
// las cuotas; esto consulta su calculadora para informarle al vendedor cuánto paga el cliente por cuota (referencia: depende de la tarjeta
// y el banco, y de las promociones vigentes). Usa Visa y Mastercard de crédito como referencia.
router.get('/cuotas-referencia', authCobro, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const monto = Number(req.query.monto) || 0;
    if (!(monto > 0)) return res.json({ monto, medios: [] });
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    const planes = await db.collection('tarjetas_planes').find({ orgId: req.orgId, tarjeta: CANAL_TARJETA.link, activo: { $ne: false } }).project({ cuotas: 1 }).toArray();
    const maxCuotas = planes.reduce((m, p) => Math.max(m, Number(p.cuotas) || 1), 0) || 12;
    const medios = [];
    for (const [id, nombre] of [['visa', 'Visa crédito'], ['master', 'Mastercard crédito']]) {
      try {
        const d = await mp(cfg, 'GET', `/v1/payment_methods/installments?amount=${monto}&payment_method_id=${id}`);
        const costos = ((Array.isArray(d) ? d[0] : d) || {}).payer_costs || [];
        const cuotas = costos.filter(c => Number(c.installments) <= maxCuotas).map(c => ({ cuotas: Number(c.installments), cuota: redondear(c.installment_amount), total: redondear(c.total_amount), tasa: Number(c.installment_rate) || 0 }));
        if (cuotas.length) medios.push({ id, nombre, cuotas });
      } catch (e) { /* ese medio no se pudo consultar: se muestra el resto */ }
    }
    res.json({ monto, medios });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/planes-cobro', authCobro, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const canal = req.query.canal === 'link' ? 'link' : 'point';
    const monto = Number(req.query.monto) || 0;
    const db = await getDb();
    const lista = await db.collection('tarjetas_planes').find({ orgId: req.orgId, tarjeta: CANAL_TARJETA[canal], activo: { $ne: false } }).sort({ cuotas: 1 }).toArray();
    const hoyAR = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    res.json(lista.filter(p => !p.vigenteHasta || hoyAR <= p.vigenteHasta).map(p => {
      const pct = Number(p.recargoPorcentaje) || 0;
      const recargo = Math.round(monto * pct) / 100;
      return { _id: p._id, nombre: p.nombre, cuotas: p.cuotas || 1, recargoPorcentaje: pct, recargo, total: Math.round((monto + recargo) * 100) / 100 };
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function crearLink(req, res) {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    if (!cfg || !cfg.accessToken) throw err(400, 'Falta configurar Mercado Pago (access token).');
    if (!cfg.bancoId) throw err(400, 'Falta elegir en qué banco de Tesorería entra la plata de Mercado Pago.');
    const esCuenta = !!req.params.clienteId;
    const { venta, cliente, clienteNombre, monto } = esCuenta ? await clienteParaCobrar(db, req, req.body && req.body.monto) : await ventaParaCobrar(db, req, req.body && req.body.monto);
    // Link de pago (25/10/2026, pedido de Mato): va por el monto de la venta, SIN recargo nuestro. Mercado Pago ofrece las cuotas y
    // el interés de financiar lo paga el cliente (si no, se cobraba dos veces: nuestro recargo + el de Mercado Pago).
    const plan = null;
    const aCobrar = monto;
    const planesLink = await db.collection('tarjetas_planes').find({ orgId: req.orgId, tarjeta: CANAL_TARJETA.link, activo: { $ne: false } }).project({ cuotas: 1 }).toArray();
    const maxCuotas = planesLink.reduce((m, p) => Math.max(m, Number(p.cuotas) || 1), 0);
    const cobroId = new ObjectId();
    const ref = 'pn-' + String(cobroId);
    const hoy = new Date();
    const vence = new Date(hoy.getTime() + 7 * 24 * 3600 * 1000); // el link vive 7 días
    const pref = await mp(cfg, 'POST', '/checkout/preferences', {
      items: [{ id: String(esCuenta ? cliente._id : venta._id), title: (esCuenta ? `Pago a cuenta — ${clienteNombre}` : `Venta ${numeroVenta(venta)}`).slice(0, 120), quantity: 1, unit_price: aCobrar, currency_id: 'ARS' }],
      external_reference: ref,
      notification_url: urlWebhook(req, cfg),
      expires: true, expiration_date_to: vence.toISOString(),
      ...(maxCuotas > 1 ? { payment_methods: { installments: maxCuotas } } : {})
    });
    const link = pref.init_point;
    if (!link) throw err(502, 'Mercado Pago no devolvió el link de pago.');
    const doc = { _id: cobroId, orgId: req.orgId, ventaId: esCuenta ? null : venta._id, clienteId: esCuenta ? cliente._id : (venta.clienteId || null), clienteNombre: esCuenta ? clienteNombre : (venta.clienteNombre || ''), aCuenta: esCuenta, tipo: 'link', externalReference: ref, monto, estado: 'pendiente', ...camposPlanCobro(plan),
      preferenciaId: pref.id, linkUrl: link, venceEn: vence, usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: hoy, updatedAt: hoy };
    await db.collection('mp_cobros').insertOne(doc);
    res.json(publico(doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}
router.post('/ventas/:ventaId/link', authCobro, crearLink);
router.post('/clientes/:clienteId/link', authCobro, crearLink);

async function crearPoint(req, res) {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const cfg = await cargarConfig(db, req.orgId);
    if (!cfg || !cfg.accessToken) throw err(400, 'Falta configurar Mercado Pago (access token).');
    if (!cfg.bancoId) throw err(400, 'Falta elegir en qué banco de Tesorería entra la plata de Mercado Pago.');
    const terminalId = txt(req.body && req.body.terminalId) || cfg.terminalId;
    if (!terminalId) throw err(400, 'Elegí la terminal Point (o dejá una por defecto en la configuración).');
    const esCuenta = !!req.params.clienteId;
    const { venta, cliente, clienteNombre, monto } = esCuenta ? await clienteParaCobrar(db, req, req.body && req.body.monto) : await ventaParaCobrar(db, req, req.body && req.body.monto);
    const plan = await planParaCobro(db, req, req.body && req.body.planId, monto);
    const aCobrar = plan ? plan.tarjetaTotalCobrado : monto;
    const cobroId = new ObjectId();
    const ref = 'pn-' + String(cobroId);
    const orden = await mp(cfg, 'POST', '/v1/orders', {
      type: 'point', external_reference: ref, expiration_time: 'PT15M',
      transactions: { payments: [{ amount: aCobrar.toFixed(2) }] },
      config: { point: { terminal_id: terminalId, print_on_terminal: 'no_ticket' } },
      description: (esCuenta ? `Pago a cuenta ${clienteNombre}` : `Venta ${numeroVenta(venta)}`).slice(0, 150)
    }, { 'X-Idempotency-Key': crypto.randomUUID() });
    const hoy = new Date();
    const doc = { _id: cobroId, orgId: req.orgId, ventaId: esCuenta ? null : venta._id, clienteId: esCuenta ? cliente._id : (venta.clienteId || null), clienteNombre: esCuenta ? clienteNombre : (venta.clienteNombre || ''), aCuenta: esCuenta, tipo: 'point', externalReference: ref, monto, estado: 'pendiente', ...camposPlanCobro(plan),
      ordenId: orden.id, terminalId, usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: hoy, updatedAt: hoy };
    await db.collection('mp_cobros').insertOne(doc);
    res.json(publico(doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}
router.post('/ventas/:ventaId/point', authCobro, crearPoint);
router.post('/clientes/:clienteId/point', authCobro, crearPoint);

function publico(c) {
  return { _id: c._id, ventaId: c.ventaId, clienteId: c.clienteId || null, aCuenta: !!c.aCuenta, tipo: c.tipo, monto: c.monto, montoCobrar: c.montoCobrar || c.monto, recargo: c.recargo || 0, planNombre: c.planNombre || '', estado: c.estado, linkUrl: c.linkUrl || null,
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

router.get('/clientes/:clienteId/cobros', auth, async (req, res) => {
  try {
    const clienteId = toObjectId(req.params.clienteId);
    if (!clienteId) throw err(400, 'id inválido');
    const db = await getDb();
    const lista = await db.collection('mp_cobros').find(Object.assign({ clienteId, aCuenta: true }, filtroOrg(req))).sort({ createdAt: -1 }).limit(30).toArray();
    res.json(lista.map(publico));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/cobros', auth, async (req, res) => {
  try {
    const db = await getDb();
    const lista = await db.collection('mp_cobros').find(filtroOrg(req)).sort({ createdAt: -1 }).limit(100).toArray();
    const ventas = await db.collection('ventas').find({ _id: { $in: lista.map(c => c.ventaId) } }).project({ numero: 1, letra: 1, tipoComprobante: 1, clienteNombre: 1 }).toArray();
    const pv = {}; ventas.forEach(v => { pv[String(v._id)] = v; });
    res.json(lista.map(c => { const v = pv[String(c.ventaId)]; return Object.assign(publico(c), { venta: v ? numeroVenta(v) : (c.aCuenta ? 'A cuenta' : ''), cliente: v ? v.clienteNombre : (c.clienteNombre || '') }); }));
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
  info.comision = info.comision || 0; info.impuestos = info.impuestos || 0; info.financiacion = info.financiacion || 0;
  if (!/^\d+$/.test(String(info.paymentId || ''))) return info;
  let p;
  try { p = await mp(cfg, 'GET', '/v1/payments/' + info.paymentId); } catch (e) { return info; }
  const num = x => Number(x) || 0;
  const fees = (p.fee_details || []).reduce((a, f) => a + num(f.amount), 0);
  // Costo de las cuotas (cuotas sin interés a cargo del vendedor): Mercado Pago lo informa aparte como "financing_fee"
  const financiacionMp = (p.fee_details || []).filter(f => String(f.type || '').toLowerCase() === 'financing_fee').reduce((a, f) => a + num(f.amount), 0);
  let imp = 0;
  (p.charges_details || []).forEach(c => { if (String(c.type || '').toLowerCase() === 'tax') imp += num(c.amounts && c.amounts.original); });
  if (!imp) imp = num(p.taxes_amount);
  let comision = redondear(fees - financiacionMp), impuestos = redondear(imp);
  info.financiacion = redondear(financiacionMp);
  const bruto = num(p.transaction_amount) || info.monto;
  const neto = p.transaction_details && p.transaction_details.net_received_amount != null ? num(p.transaction_details.net_received_amount) : null;
  if (neto !== null && neto > 0 && neto <= bruto) {
    // Lo que realmente deposita Mercado Pago manda: si no coincide con comisión + impuestos, la diferencia se suma a la comisión.
    const total = redondear(bruto - neto);
    if (total > comision + info.financiacion + impuestos + 0.009) comision = redondear(total - impuestos - info.financiacion);
    info.neto = neto;
  }
  info.comision = comision; info.impuestos = impuestos;
  return info;
}

async function registrarCobroACuenta(db, cfg, cobro, info) {
  const cliente = await db.collection('clientes').findOne({ _id: cobro.clienteId, orgId: cobro.orgId });
  if (!cliente) throw err(404, 'El cliente del cobro ya no existe.');
  if (!cfg.bancoId) throw err(400, 'Falta elegir el banco de Tesorería para Mercado Pago.');
  const reqFalso = { orgId: cobro.orgId, usuario: { nombre: 'Mercado Pago' } };
  const clienteNombre = cobro.clienteNombre || [cliente.apellidoRazonSocial, cliente.nombre].filter(Boolean).join(' ');
  const monto = redondear(info.monto || cobro.monto);            // lo que entró al banco (con el recargo del plan, si hubo)
  const aplicado = cobro.recargo > 0 ? Math.min(redondear(cobro.monto), monto) : monto;   // lo que queda a favor del cliente (la seña)
  const recargoCobrado = cobro.recargo > 0 ? redondear(monto - aplicado) : 0;
  const fecha = new Date();
  const esTarjeta = /card/.test(info.metodo || '');
  const nota = `Mercado Pago ${cobro.tipo === 'point' ? 'Point' : 'link de pago'} · pago ${info.paymentId}`;
  const mov = await aplicarMovimientoCuenta(db, reqFalso, {
    cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'ingreso', monto, moneda: 'ARS',
    motivo: `Cobro a cuenta — ${clienteNombre}`, observaciones: nota, origen: 'cobro_cuenta', fecha, omitirPermiso: true
  });
  if (info.comision > 0) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.comision, moneda: 'ARS',
      motivo: 'Comisión Mercado Pago', observaciones: `Cobro a cuenta ${clienteNombre} · pago ${info.paymentId}`, origen: 'manual', fecha, omitirPermiso: true
    });
  }
  if (info.financiacion > 0) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.financiacion, moneda: 'ARS',
      motivo: 'Costo de cuotas Mercado Pago', observaciones: `Cobro a cuenta ${clienteNombre} · pago ${info.paymentId}`, origen: 'manual', fecha, omitirPermiso: true
    });
  }
  if (info.impuestos > 0) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.impuestos, moneda: 'ARS',
      motivo: 'Impuestos y retenciones Mercado Pago', observaciones: `Cobro a cuenta ${clienteNombre} · pago ${info.paymentId}`, origen: 'manual', fecha, omitirPermiso: true
    });
  }
  await registrarMovimientoCuentaCorriente(db, reqFalso, {
    clienteId: cliente._id, clienteNombre, tipo: 'credito', monto: aplicado, moneda: 'ARS',
    concepto: 'Cobro a cuenta', origen: 'cobro_cuenta', chequeId: null, observaciones: nota, fecha,
    extra: Object.assign({ tipoValor: esTarjeta ? 'tarjeta' : 'cuenta', reciboTipo: 'movimiento', reciboId: mov._id },
      recargoCobrado > 0 ? { tarjetaPlanId: cobro.planId, tarjetaPlanNombre: cobro.planNombre, tarjetaCuotas: cobro.planCuotas, tarjetaRecargoPorcentaje: cobro.recargoPorcentaje, tarjetaRecargo: recargoCobrado, tarjetaTotalCobrado: monto } : {})
  });
}

// Idempotencia: si un registro quedó a medias (el servidor se reinició o se cortó), al reintentar se saltean los pasos ya hechos.
async function movimientoYaRegistrado(db, motivo, info) {
  const id = String(info.paymentId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return false;
  return !!(await db.collection('tesoreria_movimientos').findOne({ motivo, observaciones: { $regex: 'pago ' + id + '$|pago ' + id + '[^0-9]' } }));
}

async function registrarCobroEnVenta(db, cfg, cobro, info) {
  if (!cobro.ventaId && cobro.aCuenta) return registrarCobroACuenta(db, cfg, cobro, info);
  const venta = await db.collection('ventas').findOne({ _id: cobro.ventaId, orgId: cobro.orgId });
  if (!venta) throw err(404, 'La venta del cobro ya no existe.');
  if (venta.estado === 'anulada') throw err(400, 'La venta está anulada: el cobro de Mercado Pago quedó sin imputar, revisalo.');
  if (!cfg.bancoId) throw err(400, 'Falta elegir el banco de Tesorería para Mercado Pago.');
  const reqFalso = { orgId: cobro.orgId, usuario: { nombre: 'Mercado Pago' } };
  const monto = redondear(info.monto || cobro.monto);            // lo que realmente entró al banco (incluye el recargo del plan, si hubo)
  const aplicado = cobro.recargo > 0 ? Math.min(redondear(cobro.monto), monto) : monto;   // lo que cancela deuda de la venta
  const recargoCobrado = cobro.recargo > 0 ? redondear(monto - aplicado) : 0;
  const fecha = new Date();
  const esTarjeta = /card/.test(info.metodo || '');
  const tipoValor = esTarjeta ? 'tarjeta' : 'cuenta';
  const nota = `Mercado Pago ${cobro.tipo === 'point' ? 'Point' : 'link de pago'} · pago ${info.paymentId}`;
  if (!(await movimientoYaRegistrado(db, `Cobro venta Nº ${venta.numero}`, info))) await aplicarMovimientoCuenta(db, reqFalso, {
    cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'ingreso', monto, moneda: 'ARS',
    motivo: `Cobro venta Nº ${venta.numero}`, observaciones: nota, origen: 'venta', ventaId: venta._id, fecha, omitirPermiso: true
  });
  if (info.comision > 0 && !(await movimientoYaRegistrado(db, 'Comisión Mercado Pago', info))) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.comision, moneda: 'ARS',
      motivo: 'Comisión Mercado Pago', observaciones: `Venta Nº ${venta.numero} · pago ${info.paymentId}`, origen: 'manual', ventaId: venta._id, fecha, omitirPermiso: true
    });
  }
  if (info.financiacion > 0 && !(await movimientoYaRegistrado(db, 'Costo de cuotas Mercado Pago', info))) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.financiacion, moneda: 'ARS',
      motivo: 'Costo de cuotas Mercado Pago', observaciones: `Venta Nº ${venta.numero} · pago ${info.paymentId}`, origen: 'manual', ventaId: venta._id, fecha, omitirPermiso: true
    });
  }
  if (info.impuestos > 0 && !(await movimientoYaRegistrado(db, 'Impuestos y retenciones Mercado Pago', info))) {
    await aplicarMovimientoCuenta(db, reqFalso, {
      cuentaTipo: 'banco', cuentaId: cfg.bancoId, tipo: 'egreso', monto: info.impuestos, moneda: 'ARS',
      motivo: 'Impuestos y retenciones Mercado Pago', observaciones: `Venta Nº ${venta.numero} · pago ${info.paymentId}`, origen: 'manual', ventaId: venta._id, fecha, omitirPermiso: true
    });
  }
  const yaEnVenta = (venta.pagos || []).some(x => x.mercadoPagoId && String(x.mercadoPagoId) === String(info.paymentId));
  const totalCobrado = (venta.totalCobrado || 0) + aplicado;
  const saldoPendiente = Math.max(0, redondear(venta.total - totalCobrado - (venta.totalAcreditado || 0)));
  if (!yaEnVenta) await db.collection('ventas').updateOne({ _id: venta._id }, {
    $push: { pagos: { tipoValor, monto: aplicado, fecha, nota, usuarioNombre: 'Mercado Pago', cuentaTipo: 'banco', cuentaId: cfg.bancoId, mercadoPagoId: info.paymentId,
      ...(recargoCobrado > 0 ? { tarjetaPlanId: cobro.planId, tarjetaPlanNombre: cobro.planNombre, tarjetaCuotas: cobro.planCuotas, tarjetaRecargoPorcentaje: cobro.recargoPorcentaje, tarjetaRecargo: recargoCobrado, tarjetaTotalCobrado: monto } : {}) } },
    $set: { totalCobrado, saldoPendiente, updatedAt: new Date() }
  });
  const yaEnCC = await db.collection('cuenta_corriente_movimientos').findOne({ ventaId: venta._id, origen: 'cobro_venta', observaciones: nota });
  if (!yaEnCC) await registrarMovimientoCuentaCorriente(db, reqFalso, {
    clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto: aplicado, moneda: 'ARS',
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
      { _id: cobro._id, $or: [{ estado: { $in: ['pendiente', 'error'] } }, { estado: 'registrando', updatedAt: { $lt: new Date(Date.now() - 60000) } }] }, { $set: Object.assign({ estado: 'registrando', error: '' }, base) }, { returnDocument: 'after' });
    const doc = reclamado && (reclamado.value !== undefined ? reclamado.value : reclamado);
    if (!doc) return db.collection('mp_cobros').findOne({ _id: cobro._id });
    try {
      await completarDescuentos(cfg, info);
      await registrarCobroEnVenta(db, cfg, doc, info);
      await db.collection('mp_cobros').updateOne({ _id: cobro._id }, { $set: { estado: 'acreditado', paymentId: info.paymentId, montoAcreditado: info.monto, comision: info.comision || 0, financiacion: info.financiacion || 0, impuestos: info.impuestos || 0, neto: info.neto != null ? info.neto : null, acreditadoEn: new Date() } });
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
async function buscarCobroEntreOrgs(db, cfg, tipo, recurso) {
  let ref = null;
  if (tipo.includes('order') || recurso.startsWith('ORD')) {
    const o = await mp(cfg, 'GET', '/v1/orders/' + encodeURIComponent(recurso)).catch(() => null);
    ref = o && o.external_reference;
    if (!ref) { const c = await db.collection('mp_cobros').findOne({ ordenId: recurso }); return c || null; }
  } else {
    const p = await mp(cfg, 'GET', '/v1/payments/' + encodeURIComponent(recurso)).catch(() => null);
    ref = p && p.external_reference;
  }
  if (!ref || !/^pn-[0-9a-f]{24}$/.test(ref)) return null;
  return db.collection('mp_cobros').findOne({ externalReference: ref });
}

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
    // Si la misma cuenta de Mercado Pago la usan varias organizaciones, el aviso llega a una sola dirección:
    // el cobro se busca por su referencia propia (única) y se concilia con la configuración de SU organización.
    if (cobro && String(cobro.orgId) !== String(cfg.orgId)) cobro = null;
    if (!cobro) cobro = await buscarCobroEntreOrgs(db, cfg, tipo, recurso);
    if (cobro) {
      const cfgCobro = String(cobro.orgId) === String(cfg.orgId) ? cfg : await cargarConfig(db, cobro.orgId);
      if (cfgCobro) await conciliarCobro(db, cfgCobro, cobro);
    }
  } catch (e) {
    console.error('Webhook Mercado Pago:', e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

router.conciliarCobro = conciliarCobro; // para pruebas
module.exports = router;
