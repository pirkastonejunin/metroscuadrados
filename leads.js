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

async function clientesPorTel(db, req) {
  const cs = await db.collection('clientes').find(Object.assign({}, filtroOrg(req))).project({ telefono: 1, celular: 1, apellidoRazonSocial: 1, nombre: 1 }).toArray();
  const mapa = new Map();
  for (const c of cs) for (const t of [c.telefono, c.celular]) { const k = claveTel(t); if (k && !mapa.has(k)) mapa.set(k, c); }
  return mapa;
}
const nombreCli = (c) => c ? (c.apellidoRazonSocial || c.nombre || '') : '';

router.post('/importar', auth, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Elegí una sucursal para importar los leads.' });
    const filas = parsearCSV(req.body && req.body.csv);
    if (filas.length < 2) return res.status(400).json({ error: 'El archivo no tiene filas.' });
    const h = filas[0].map(x => x.trim());
    if (!h.includes('Teléfono')) return res.status(400).json({ error: 'No parece el CSV de la bandeja de Azuite (falta la columna Teléfono).' });
    const db = await getDb(); const col = db.collection(COL);
    await col.createIndex({ orgId: 1, tel10: 1 }, { unique: true }).catch(() => {});
    const cli = await clientesPorTel(db, req); const ahora = new Date();
    let nuevos = 0, actualizados = 0, sinTel = 0;
    const ops = [];
    for (const f of filas.slice(1)) {
      const l = filaALead(h, f);
      if (!l.tel10) { sinTel++; continue; }
      const c = cli.get(l.tel10);
      ops.push({ updateOne: {
        filter: { orgId: req.orgId, tel10: l.tel10 },
        update: {
          $set: Object.assign({}, l, { clienteId: c ? c._id : null, clienteNombre: nombreCli(c), updatedAt: ahora }),
          $setOnInsert: { orgId: req.orgId, estado: l.estadoOrigen && ESTADOS.includes(l.estadoOrigen) ? l.estadoOrigen : 'Nuevo', notas: '', createdAt: ahora, origen: 'azuite' }
        }, upsert: true } });
    }
    for (let i = 0; i < ops.length; i += 500) {
      const r = await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      nuevos += r.upsertedCount; actualizados += r.matchedCount;
    }
    res.json({ ok: true, filas: filas.length - 1, nuevos, actualizados, sinTelefono: sinTel });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
