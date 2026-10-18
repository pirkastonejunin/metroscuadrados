// ---------------------------------------------------------------------------
// Leads de WhatsApp (migración desde Azuite, 18/10/2026). Guarda los contactos que llegaron por WhatsApp (Meta Ads o directos),
// con su campaña, estado y resumen, y los cruza por teléfono con los clientes. Se carga con el CSV de la bandeja de Azuite
// (POST /importar { csv }); se puede repetir: se actualiza por teléfono y NO pisa el estado/notas/etiquetas que ya se hayan tocado acá.
// GET /  (filtros: q, estado, fuente, campana, desde, hasta, cliente=si|no)   GET /resumen   PATCH /:id { estado, notas }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db(DB_NAME); }
const auth = [authUsuario, resolverOrg, requiereModulo('visitas')];
const COL = 'leads_whatsapp';
const ESTADOS = ['Nuevo', 'Contactado', 'Calificado', 'Cerrado', 'Perdido'];

function digitos(s) { return String(s || '').replace(/\D/g, ''); }
// Clave de cruce: últimos 10 dígitos (ignora 54, 9 y 0/15 delante).
function claveTel(s) { const d = digitos(s); return d.length >= 8 ? d.slice(-10) : ''; }

// Parser CSV mínimo (comillas dobles, "" escapadas, saltos de línea dentro de comillas).
function parsearCSV(txt) {
  txt = String(txt || '').replace(/^﻿/, '');
  const filas = []; let fila = [], campo = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { fila.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && txt[i + 1] === '\n') i++; fila.push(campo); campo = ''; if (fila.some(x => x !== '')) filas.push(fila); fila = []; }
    else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(campo); if (fila.some(x => x !== '')) filas.push(fila); }
  return filas;
}
// "17/10/2026, 06:05:00" (hora Argentina, UTC-3) -> Date
function fechaAR(s) {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(`${m[3]}-${p(m[2])}-${p(m[1])}T${p(m[4])}:${m[5]}:${p(m[6] || 0)}-03:00`);
  return isNaN(d.getTime()) ? null : d;
}
function filaALead(h, f) {
  const g = (n) => { const i = h.indexOf(n); return i >= 0 ? String(f[i] || '').trim() : ''; };
  const telefono = digitos(g('Teléfono'));
  return {
    telefono, tel10: claveTel(telefono), nombre: g('Nombre'), email: g('Email'), canal: g('Canal') || 'WhatsApp',
    estadoOrigen: g('Estado'), etiquetasOrigen: g('Etiquetas').split(';').map(x => x.trim()).filter(Boolean),
    fuente: g('Fuente'), utmSource: g('UTM source'), utmMedium: g('UTM medium'), campana: g('UTM campaign'),
    resumen: g('Resumen'), notasOrigen: g('Notas'), creadoOrigen: fechaAR(g('Creado'))
  };
}

const nombreCli = (c) => c ? (c.apellidoRazonSocial || c.nombre || '') : '';

// Guarda una lista de leads ya normalizados (ver filaALead) en la sucursal. Devuelve { nuevos, actualizados, sinTelefono }.
async function guardarLeads(db, orgId, leads, origen) {
  const col = db.collection(COL);
  await col.createIndex({ orgId: 1, tel10: 1 }, { unique: true }).catch(() => {});
  const cs = await db.collection('clientes').find({ orgId }).project({ telefono: 1, celular: 1, apellidoRazonSocial: 1, nombre: 1 }).toArray();
  const cli = new Map();
  for (const c of cs) for (const t of [c.telefono, c.celular]) { const k = claveTel(t); if (k && !cli.has(k)) cli.set(k, c); }
  const ahora = new Date(); const ops = []; let sinTelefono = 0, nuevos = 0, actualizados = 0;
  for (const l of leads) {
    if (!l.tel10) { sinTelefono++; continue; }
    const c = cli.get(l.tel10);
    ops.push({ updateOne: {
      filter: { orgId, tel10: l.tel10 },
      update: {
        $set: Object.assign({}, l, { clienteId: c ? c._id : null, clienteNombre: nombreCli(c), updatedAt: ahora }),
        $setOnInsert: { orgId, estado: l.estadoOrigen && ESTADOS.includes(l.estadoOrigen) ? l.estadoOrigen : 'Nuevo', notas: '', createdAt: ahora, origen }
      }, upsert: true } });
  }
  for (let i = 0; i < ops.length; i += 500) {
    const r = await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    nuevos += r.upsertedCount; actualizados += r.matchedCount;
  }
  return { nuevos, actualizados, sinTelefono };
}

router.post('/importar', auth, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Elegí una sucursal para importar los leads.' });
    const filas = parsearCSV(req.body && req.body.csv);
    if (filas.length < 2) return res.status(400).json({ error: 'El archivo no tiene filas.' });
    const h = filas[0].map(x => x.trim());
    if (!h.includes('Teléfono')) return res.status(400).json({ error: 'No parece el CSV de la bandeja de Azuite (falta la columna Teléfono).' });
    const db = await getDb();
    const r = await guardarLeads(db, req.orgId, filas.slice(1).map(f => filaALead(h, f)), 'azuite');
    res.json(Object.assign({ ok: true, filas: filas.length - 1 }, r));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// --- API de leads de Azuite (solo lectura). La key va en la variable de entorno AZUITE_API_KEY (nunca en el código ni en el chat). ---
const AZ_BASE = process.env.AZUITE_API_URL || 'https://brkvidblothecotntcim.supabase.co/functions/v1/public-api/v1';
async function azGet(ruta, params) {
  const key = process.env.AZUITE_API_KEY;
  if (!key) throw Object.assign(new Error('Falta cargar AZUITE_API_KEY en Render (Environment).'), { status: 400 });
  const u = new URL(AZ_BASE + ruta); Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v); });
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  if (r.status === 429) { await new Promise(ok => setTimeout(ok, 5000)); return azGet(ruta, params); }
  const txt = await r.text(); let d; try { d = JSON.parse(txt); } catch (e) { d = { raw: txt.slice(0, 300) }; }
  if (!r.ok) throw Object.assign(new Error('Azuite respondió ' + r.status + ': ' + (d.error && (d.error.message || d.error) || d.message || d.raw || '')), { status: 502 });
  return d;
}
const aLista = (d) => Array.isArray(d) ? d : (d && (d.data || d.leads || d.items || d.results)) || [];
const siguiente = (d) => d && (d.next_cursor || d.nextCursor || (d.pagination && (d.pagination.next_cursor || d.pagination.nextCursor)) || (d.meta && d.meta.next_cursor)) || null;
const txt = (v) => (v == null ? '' : typeof v === 'object' ? String(v.name || v.nombre || v.title || v.campaign || '') : String(v));
// Un lead de la API de Azuite -> el formato interno. Los nombres de campos se leen de forma tolerante.
function leadDeApi(x) {
  const utm = x.utm || {}, ad = x.ad || {};
  const tel = digitos(x.phone || x.telefono);
  return {
    telefono: tel, tel10: claveTel(tel), nombre: txt(x.name || x.nombre), email: txt(x.email), canal: txt(x.channel) || 'WhatsApp',
    estadoOrigen: txt(x.status), etiquetasOrigen: Array.isArray(x.tags) ? x.tags.map(txt).filter(Boolean) : [],
    fuente: txt(x.source || x.fuente) || (utm.source || ad.id || ad.name ? 'Meta Ads' : 'Directo'),
    utmSource: txt(utm.source || utm.utm_source), utmMedium: txt(utm.medium || utm.utm_medium),
    campana: txt(utm.campaign || utm.utm_campaign || ad.campaign || ad.name || ad.headline),
    anuncio: txt(ad.name || ad.headline || ad.id), azuiteId: txt(x.id),
    resumen: txt(x.summary || x.resumen), notasOrigen: txt(x.notes), creadoOrigen: x.created_at ? new Date(x.created_at) : null
  };
}
async function sincronizarAzuite(db, orgId, { desde, maxPaginas, completo } = {}) {
  let cursor = null, pag = 0, vistos = 0, acum = { nuevos: 0, actualizados: 0, sinTelefono: 0 };
  if (!desde && !completo) { const ult = await db.collection(COL).find({ orgId, origen: 'azuite' }).sort({ creadoOrigen: -1 }).limit(1).project({ creadoOrigen: 1 }).toArray(); if (ult[0] && ult[0].creadoOrigen) desde = new Date(ult[0].creadoOrigen.getTime() - 86400000).toISOString(); }
  do {
    const d = await azGet('/leads', { limit: 200, order: 'asc', cursor, created_from: desde });
    const lista = aLista(d); vistos += lista.length;
    const r = await guardarLeads(db, orgId, lista.map(leadDeApi), 'azuite');
    acum.nuevos += r.nuevos; acum.actualizados += r.actualizados; acum.sinTelefono += r.sinTelefono;
    cursor = lista.length ? siguiente(d) : null; pag++;
    if (cursor) await new Promise(ok => setTimeout(ok, 600)); // 120 pedidos/min
  } while (cursor && pag < (maxPaginas || 100));
  return Object.assign({ vistos, paginas: pag, desde: desde || null }, acum);
}

// Prueba de conexión: trae 1 lead y muestra los nombres de campos que devuelve la API (no guarda nada).
router.get('/azuite/probar', auth, async (req, res) => {
  try {
    const d = await azGet('/leads', { limit: 1, order: 'desc' }); const l = aLista(d);
    res.json({ ok: true, claves: d && !Array.isArray(d) ? Object.keys(d) : ['(lista)'], campos: l[0] ? Object.keys(l[0]) : [], hayLeads: l.length > 0 });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/azuite/sincronizar', auth, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Elegí una sucursal para sincronizar los leads.' });
    const db = await getDb();
    res.json(Object.assign({ ok: true }, await sincronizarAzuite(db, req.orgId, { completo: !!(req.body && req.body.completo), maxPaginas: 100 })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Sincronización automática cada 30 min, solo si están AZUITE_API_KEY y AZUITE_ORG_ID (id de la sucursal que recibe los leads).
if (process.env.AZUITE_API_KEY && process.env.AZUITE_ORG_ID && /^[0-9a-f]{24}$/i.test(process.env.AZUITE_ORG_ID)) {
  setInterval(async () => { try { await sincronizarAzuite(await getDb(), new ObjectId(process.env.AZUITE_ORG_ID)); } catch (e) { console.error('[leads] sync Azuite:', e.message); } }, 30 * 60 * 1000).unref();
}

function armarFiltro(req) {
  const q = req.query, m = Object.assign({}, filtroOrg(req));
  if (q.estado) m.estado = q.estado;
  if (q.fuente) m.fuente = q.fuente;
  if (q.campana) m.campana = q.campana === '(sin campaña)' ? '' : q.campana;
  if (q.cliente === 'si') m.clienteId = { $ne: null }; else if (q.cliente === 'no') m.clienteId = null;
  if (q.desde || q.hasta) { m.creadoOrigen = {}; if (q.desde) m.creadoOrigen.$gte = new Date(q.desde + 'T00:00:00-03:00'); if (q.hasta) m.creadoOrigen.$lte = new Date(q.hasta + 'T23:59:59-03:00'); }
  if (q.q) { const rx = new RegExp(String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); m.$or = [{ nombre: rx }, { telefono: rx }, { resumen: rx }, { etiquetasOrigen: rx }]; }
  return m;
}

router.get('/', auth, async (req, res) => {
  try {
    const db = await getDb(); const lim = Math.min(parseInt(req.query.limit) || 200, 500), skip = parseInt(req.query.skip) || 0;
    const m = armarFiltro(req);
    const [items, total] = await Promise.all([db.collection(COL).find(m).sort({ creadoOrigen: -1 }).skip(skip).limit(lim).toArray(), db.collection(COL).countDocuments(m)]);
    res.json({ total, items });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/resumen', auth, async (req, res) => {
  try {
    const db = await getDb(); const col = db.collection(COL); const f = filtroOrg(req);
    const agr = (campo) => col.aggregate([{ $match: f }, { $group: { _id: campo, leads: { $sum: 1 }, clientes: { $sum: { $cond: [{ $ne: ['$clienteId', null] }, 1, 0] } } } }, { $sort: { leads: -1 } }]).toArray();
    const [total, porCampana, porEstado, porFuente, porMes] = await Promise.all([
      col.countDocuments(f), agr('$campana'), agr('$estado'), agr('$fuente'),
      col.aggregate([{ $match: f }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$creadoOrigen', timezone: 'America/Argentina/Buenos_Aires' } }, leads: { $sum: 1 }, clientes: { $sum: { $cond: [{ $ne: ['$clienteId', null] }, 1, 0] } } } }, { $sort: { _id: 1 } }]).toArray()
    ]);
    const n = (a) => a.map(x => ({ nombre: x._id || '(sin campaña)', leads: x.leads, clientes: x.clientes }));
    res.json({ total, conCliente: porEstado.reduce((s, x) => s + x.clientes, 0), porCampana: n(porCampana), porEstado: n(porEstado), porFuente: n(porFuente), porMes: n(porMes) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.patch('/:id', auth, async (req, res) => {
  try {
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
    const set = { updatedAt: new Date() };
    if (req.body.estado !== undefined) { if (!ESTADOS.includes(req.body.estado)) return res.status(400).json({ error: 'Estado inválido.' }); set.estado = req.body.estado; }
    if (req.body.notas !== undefined) set.notas = String(req.body.notas).slice(0, 2000);
    const db = await getDb();
    const r = await db.collection(COL).findOneAndUpdate(Object.assign({ _id: new ObjectId(req.params.id) }, filtroOrg(req)), { $set: set }, { returnDocument: 'after' });
    const doc = r && (r.value !== undefined ? r.value : r);
    if (!doc) return res.status(404).json({ error: 'No encontrado.' });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.parsearCSV = parsearCSV;
module.exports.fechaAR = fechaAR;
