// Mesa de ventas: la pantalla de trabajo del vendedor. Junta en una sola lista (por teléfono) la conversación de WhatsApp, la oportunidad del CRM
// y el borrador de presupuesto, y calcula lo que el vendedor necesita ver: quién espera respuesta, qué seguimiento vence, temperatura, valor.
// Lo que el vendedor cambia a mano (temperatura, asesor, cierre, notas) se guarda en la conversación (campo `mesa`).
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereAlgunModulo, resolverOrg, filtroOrg } = require('./usuarios');

let mongoClient = null;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db('calculadora_m2'); }

const router = express.Router();
const auth = [authUsuario, resolverOrg, requiereAlgunModulo('crm', 'visitas')];
const COL_C = 'wa_conversaciones', COL_M = 'wa_mensajes';
const TEMPS = ['caliente', 'tibio', 'frio'];
const MOTIVOS_PERDIDA = ['precio', 'sin stock', 'eligió otro proveedor', 'sin respuesta', 'postergó la obra', 'otro'];

const digitos = s => String(s || '').replace(/\D/g, '');
const tel10 = s => digitos(s).slice(-10);
function hoyAR(ahora) { // medianoche de hoy en Argentina (UTC-3), como Date en UTC
  const a = new Date((ahora || new Date()).getTime() - 3 * 3600 * 1000);
  return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()) + 3 * 3600 * 1000);
}
const diasHasta = (fecha, ahora) => Math.round((hoyAR(new Date(fecha)).getTime() - hoyAR(ahora).getTime()) / 86400000);

function etapaDe(c, op, pres) {
  if (pres && pres.estado === 'presupuestado' && !pres.convertidoEnVentaId && ((pres.seguimiento || []).length > 1 || !pres.origenBot)) return 'presupuesto';
  if (pres && pres.estado === 'presupuestado') return 'borrador';
  return op || c.estado === 'aceptado' || c.estado === 'humano' ? 'seguimiento' : 'nuevo';
}

async function armar(db, req, { cerradas }) {
  const ahora = new Date(); const org = filtroOrg(req);
  const convs = await db.collection(COL_C).find(Object.assign({}, org, { estado: { $ne: 'bot' } })).sort({ updatedAt: -1 }).limit(400).toArray();
  const ids = convs.map(c => c._id);
  const ult = ids.length ? await db.collection(COL_M).aggregate([
    { $match: { convId: { $in: ids } } }, { $sort: { at: 1 } },
    { $group: { _id: '$convId', ult: { $last: '$$ROOT' }, lastOut: { $max: { $cond: [{ $eq: ['$dir', 'out'] }, '$at', null] } }, ins: { $push: { $cond: [{ $eq: ['$dir', 'in'] }, '$at', '$$REMOVE'] } } } }
  ]).toArray() : [];
  const porConv = new Map(ult.map(u => [String(u._id), u]));
  const ops = await db.collection('oportunidades').find(Object.assign({}, org, { estado: 'activa' })).toArray();
  const opPorTel = new Map(); for (const o of ops) { const t = tel10(o.cliente && o.cliente.telefono); if (t && !opPorTel.has(t)) opPorTel.set(t, o); }
  const press = ids.length ? await db.collection('presupuestos').find({ 'origenBot.convId': { $in: ids } }).sort({ createdAt: -1 }).toArray() : [];
  const presPorConv = new Map(); for (const p of press) { const k = String(p.origenBot.convId); if (!presPorConv.has(k)) presPorConv.set(k, p); }
  const items = []; const vistos = new Set();
  for (const c of convs) {
    const m = c.mesa || {}; const cerrada = !!m.cierre;
    if (cerrada && !cerradas) { vistos.add(c.tel10); continue; }
    const u = porConv.get(String(c._id)); const op = opPorTel.get(c.tel10) || null; const pres = presPorConv.get(String(c._id)) || null; const a = c.asistente || null;
    vistos.add(c.tel10);
    const ultimo = u ? { texto: u.ult.texto || ('[' + (u.ult.tipo || 'archivo') + ']'), dir: u.ult.dir, origen: u.ult.origen, at: u.ult.at } : null;
    const esperaCliente = !!(ultimo && ultimo.dir === 'in' && !cerrada);
    const sinLeer = u ? (u.ins || []).filter(t => !u.lastOut || t > u.lastOut).length : 0;
    const prox = op && op.proximaAccion && op.proximaAccion.fecha ? { fecha: op.proximaAccion.fecha, nota: op.proximaAccion.nota || '', dias: diasHasta(op.proximaAccion.fecha, ahora) } : null;
    const productos = a && a.productos && a.productos.length ? a.productos : (c.datos && c.datos.producto ? [c.datos.producto] : []);
    items.push({
      id: String(c._id), convId: String(c._id), opId: op ? String(op._id) : null, opNumero: op ? op.numero : null, nombre: c.nombre || (op && op.cliente && op.cliente.nombre) || ('+' + c.tel), tel: c.tel,
      estadoConv: c.estado, demo: !!c.demo, asesorId: m.asesorId || null, asesorNombre: m.asesorNombre || (op && op.vendedorNombre) || '', sinAsignar: !m.asesorId && !(op && op.vendedorId),
      temperatura: m.temperatura && TEMPS.includes(m.temperatura) ? m.temperatura : (a && TEMPS.includes(a.temperatura) ? a.temperatura : 'tibio'),
      temperaturaOrigen: m.temperatura ? 'manual' : (a ? 'ia' : 'sin analizar'),
      productos, producto: productos[0] || '', valor: pres ? Number(pres.total) || 0 : 0,
      ultimo, esperaCliente, esperaMin: esperaCliente ? Math.max(0, Math.round((ahora - new Date(ultimo.at)) / 60000)) : 0, sinLeer: esperaCliente ? sinLeer : 0,
      prox, paso: a ? a.proximoPaso : '', resumen: (a && a.resumen) || c.resumen || '', falta: (a && a.datosFaltantes) || [], sugerida: a ? a.respuestaSugerida : '', analizadoAt: a ? a.at : null,
      presupuesto: pres ? { id: String(pres._id), numero: pres.numero, total: Number(pres.total) || 0, items: (pres.items || []).length, estado: pres.estado, borrador: !!(pres.origenBot && (pres.seguimiento || []).length <= 1) } : null,
      etapa: etapaDe(c, op, pres), fuente: c.referral && (c.referral.headline || c.referral.source_id) ? 'Meta Ads · ' + (c.referral.headline || '') : 'Directo',
      notas: m.notas || '', historial: (m.historial || []).slice(-30), cierre: m.cierre || null, actualizado: (ultimo && ultimo.at) || c.updatedAt
    });
  }
  // oportunidades activas sin conversación guardada (vienen de Azuite o se cargaron a mano): se ven igual, sin chat
  for (const [t, o] of opPorTel) {
    if (vistos.has(t)) continue;
    const prox = o.proximaAccion && o.proximaAccion.fecha ? { fecha: o.proximaAccion.fecha, nota: o.proximaAccion.nota || '', dias: diasHasta(o.proximaAccion.fecha, ahora) } : null;
    items.push({
      id: 'op:' + o._id, convId: null, opId: String(o._id), opNumero: o.numero, nombre: o.cliente.nombre || ('+' + digitos(o.cliente.telefono)), tel: digitos(o.cliente.telefono), estadoConv: null, demo: false,
      asesorId: null, asesorNombre: o.vendedorNombre || '', sinAsignar: !o.vendedorId, temperatura: 'tibio', temperaturaOrigen: 'sin analizar', productos: [], producto: '', valor: 0,
      ultimo: null, esperaCliente: false, esperaMin: 0, sinLeer: 0, prox, paso: '', resumen: o.notas || '', falta: [], sugerida: '', analizadoAt: null, presupuesto: null,
      etapa: 'seguimiento', fuente: o.origen || '', notas: '', historial: [], cierre: null, actualizado: o.updatedAt || o.createdAt
    });
  }
  return items;
}

router.get('/', auth, async (req, res) => {
  try {
    const db = await getDb(); const items = await armar(db, req, { cerradas: req.query.cerradas === '1' });
    const yo = String(req.usuario && req.usuario._id || '');
    res.json({ items, yo: { id: yo, nombre: (req.usuario && req.usuario.nombre) || '' }, productos: [...new Set(items.map(i => i.producto).filter(Boolean))].sort(), motivosPerdida: MOTIVOS_PERDIDA });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function convDeReq(db, req) {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return null;
  return db.collection(COL_C).findOne(Object.assign({ _id: new ObjectId(req.params.id) }, filtroOrg(req)));
}
const quien = req => ({ id: String(req.usuario && req.usuario._id || ''), nombre: (req.usuario && req.usuario.nombre) || '' });
function reg(req, txt) { return { at: new Date(), txt, usuario: quien(req).nombre }; }

router.post('/:id/temperatura', auth, async (req, res) => {
  try {
    const t = req.body && req.body.temperatura; if (!TEMPS.includes(t)) return res.status(400).json({ error: 'Temperatura inválida.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { 'mesa.temperatura': t }, $push: { 'mesa.historial': reg(req, 'Temperatura: ' + t) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/tomar', auth, async (req, res) => {
  try {
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const q = quien(req);
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { 'mesa.asesorId': q.id, 'mesa.asesorNombre': q.nombre, estado: c.estado === 'bot' || c.estado === 'derivado' ? 'aceptado' : c.estado }, $push: { 'mesa.historial': reg(req, 'Tomada por ' + q.nombre) } });
    res.json({ ok: true, asesorNombre: q.nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/nota', auth, async (req, res) => {
  try {
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { 'mesa.notas': String((req.body && req.body.texto) || '').slice(0, 4000) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Cierre: ganada limpia la próxima acción (deja de avisar en la campanita); perdida descarta la oportunidad con el motivo.
router.post('/:id/cerrar', auth, async (req, res) => {
  try {
    const estado = req.body && req.body.estado; if (!['ganada', 'perdida'].includes(estado)) return res.status(400).json({ error: 'Indicá si fue ganada o perdida.' });
    const motivo = String((req.body && req.body.motivo) || '').slice(0, 120); if (estado === 'perdida' && !motivo) return res.status(400).json({ error: 'Indicá el motivo de la pérdida.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const ahora = new Date(); const q = quien(req);
    const op = await db.collection('oportunidades').findOne(Object.assign({ estado: 'activa' }, filtroOrg(req), { 'cliente.telefono': { $regex: c.tel10 + '$' } }));
    if (op) await db.collection('oportunidades').updateOne({ _id: op._id }, { $set: estado === 'ganada' ? { proximaAccion: null, updatedAt: ahora } : { estado: 'descartada', motivoDescarte: 'Perdida: ' + motivo, proximaAccion: null, updatedAt: ahora } });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { 'mesa.cierre': { estado, motivo, at: ahora, usuario: q.nombre, opId: op ? op._id : null } }, $push: { 'mesa.historial': reg(req, estado === 'ganada' ? 'Venta ganada' : 'Perdida: ' + motivo) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/reabrir', auth, async (req, res) => {
  try {
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const cierre = c.mesa && c.mesa.cierre;
    if (cierre && cierre.estado === 'perdida' && cierre.opId) await db.collection('oportunidades').updateOne({ _id: cierre.opId, estado: 'descartada' }, { $set: { estado: 'activa', motivoDescarte: '', updatedAt: new Date() } });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $unset: { 'mesa.cierre': '' }, $push: { 'mesa.historial': reg(req, 'Reabierta') } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.armar = armar;
