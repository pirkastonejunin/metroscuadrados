// ---------------------------------------------------------------------------
// Pasar las VISITAS de una sucursal a otra (11/10/2026, pedido de Mato: todas las visitas se cargaron en Piedra Negra por error
// y corresponden a Pirka). Solo el rol Administrador. Mueve, juntas, para que sigan vinculadas:
//   - las visitas de la sucursal de origen (con su numeración, fotos y estado);
//   - las obras que nacieron de esas visitas;
//   - los presupuestos comerciales vinculados a esas visitas (salvo los que ya se convirtieron en venta: esos quedan donde están);
//   - las oportunidades del CRM convertidas en esas visitas;
//   - (opcional) los vendedores que tienen esas visitas, para que aparezcan en la sucursal de destino.
// Los clientes y las ventas NO se mueven. A las obras y presupuestos que traían un cliente de la sucursal de origen se les busca
// el mismo cliente (único) en la de destino; si no hay uno, quedan sin vincular a un cliente.
// GET /preview?origen=&destino=   GET /respaldo?origen=   POST /ejecutar { origen, destino, moverVendedores, confirmar: 'MOVER' }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario } = require('./usuarios');
const { buscarClienteUnico } = require('./clienteVinculo');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db(DB_NAME); }
function err(status, message) { return Object.assign(new Error(message), { status }); }
const oid = (v) => { try { return v && ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null; } catch (e) { return null; } };
const auth = [authUsuario, (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador puede mover visitas.' })];

async function alcance(db, origen, destino) {
  if (!origen || !destino) throw err(400, 'Elegí la sucursal de origen y la de destino.');
  if (String(origen) === String(destino)) throw err(400, 'El origen y el destino son la misma sucursal.');
  const visitas = await db.collection('visitas').find({ orgId: origen }).project({ numero: 1, estado: 1, vendedorId: 1, obraId: 1, cliente: 1 }).toArray();
  const ids = visitas.map(v => v._id);
  const obraIds = visitas.map(v => v.obraId).filter(Boolean);
  const obras = obraIds.length ? await db.collection('obras').find({ _id: { $in: obraIds }, orgId: origen }).project({ numero: 1, clienteId: 1, cliente: 1 }).toArray() : [];
  const presAll = ids.length ? await db.collection('presupuestos').find({ 'origenVisita.visitaId': { $in: ids }, orgId: origen }).project({ numero: 1, convertidoEnVentaId: 1, clienteId: 1, clienteNombre: 1 }).toArray() : [];
  const presMover = presAll.filter(p => !p.convertidoEnVentaId), presQuedan = presAll.filter(p => p.convertidoEnVentaId);
  const crm = ids.length ? await db.collection('oportunidades').find({ visitaId: { $in: ids }, orgId: origen }).project({ _id: 1 }).toArray().catch(() => []) : [];
  const vendIds = [...new Set(visitas.map(v => v.vendedorId).filter(Boolean).map(String))].map(x => new ObjectId(x));
  const vendedores = vendIds.length ? await db.collection('visitas_vendedores').find({ _id: { $in: vendIds }, orgId: origen }).project({ nombre: 1 }).toArray() : [];
  return { visitas, ids, obras, presMover, presQuedan, crm, vendedores };
}
async function nombresOrg(db, ids) { const d = await db.collection('organizaciones').find({ _id: { $in: ids.filter(Boolean) } }).project({ nombre: 1 }).toArray(); return new Map(d.map(o => [String(o._id), o.nombre])); }

router.get('/preview', auth, async (req, res) => {
  try {
    const db = await getDb(); const orgs = await db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
    const origen = oid(req.query.origen), destino = oid(req.query.destino);
    const base = { organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })) };
    if (!origen || !destino) return res.json(base);
    const a = await alcance(db, origen, destino);
    const porEstado = {}; a.visitas.forEach(v => { porEstado[v.estado || 'sin estado'] = (porEstado[v.estado || 'sin estado'] || 0) + 1; });
    const enDestino = await db.collection('visitas').countDocuments({ orgId: destino });
    res.json(Object.assign(base, { visitas: a.visitas.length, porEstado, obras: a.obras.length, presupuestos: a.presMover.length, presupuestosQueQuedan: a.presQuedan.length, oportunidadesCrm: a.crm.length,
      vendedores: a.vendedores.map(v => v.nombre), visitasYaEnDestino: enDestino }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/respaldo', auth, async (req, res) => {
  try {
    const db = await getDb(); const origen = oid(req.query.origen); const destino = oid(req.query.destino) || new ObjectId();
    const a = await alcance(db, origen, destino);
    const out = {
      visitas: await db.collection('visitas').find({ orgId: origen }).toArray(),
      obras: a.obras.length ? await db.collection('obras').find({ _id: { $in: a.obras.map(o => o._id) } }).toArray() : [],
      presupuestos: a.presMover.length ? await db.collection('presupuestos').find({ _id: { $in: a.presMover.map(p => p._id) } }).toArray() : [],
      oportunidades: a.crm.length ? await db.collection('oportunidades').find({ _id: { $in: a.crm.map(c => c._id) } }).toArray() : [],
      visitas_vendedores: a.vendedores.length ? await db.collection('visitas_vendedores').find({ _id: { $in: a.vendedores.map(v => v._id) } }).toArray() : []
    };
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Content-Disposition', 'attachment; filename="respaldo-visitas-antes-de-mover.json"');
    res.send(JSON.stringify(out));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/ejecutar', auth, async (req, res) => {
  try {
    const b = req.body || {}; if (b.confirmar !== 'MOVER') throw err(400, 'Escribí MOVER para confirmar.');
    const db = await getDb(); const origen = oid(b.origen), destino = oid(b.destino);
    const a = await alcance(db, origen, destino); const ahora = new Date(); const r = {};
    if (!a.visitas.length) throw err(400, 'No hay visitas en la sucursal de origen.');
    // vendedores primero (para que las visitas no queden apuntando a un vendedor de otra sucursal)
    if (b.moverVendedores !== false && a.vendedores.length) r.vendedores = (await db.collection('visitas_vendedores').updateMany({ _id: { $in: a.vendedores.map(v => v._id) } }, { $set: { orgId: destino, updatedAt: ahora } })).modifiedCount;
    r.visitas = (await db.collection('visitas').updateMany({ orgId: origen }, { $set: { orgId: destino, updatedAt: ahora } })).modifiedCount;
    // obras y presupuestos: se pasan de sucursal y se re-vinculan al cliente de la sucursal de destino (si hay uno único)
    r.obras = 0; for (const o of a.obras) {
      const cid = o.clienteId ? await buscarClienteUnico(db, destino, o.cliente || {}) : null;
      const set = { orgId: destino, updatedAt: ahora }; if (o.clienteId) set.clienteId = cid || null;
      r.obras += (await db.collection('obras').updateOne({ _id: o._id }, { $set: set })).modifiedCount; }
    r.presupuestos = 0; for (const p of a.presMover) {
      const cid = p.clienteId ? await buscarClienteUnico(db, destino, { nombre: p.clienteNombre }) : null;
      const set = { orgId: destino, updatedAt: ahora }; if (p.clienteId) set.clienteId = cid || null;
      r.presupuestos += (await db.collection('presupuestos').updateOne({ _id: p._id }, { $set: set })).modifiedCount; }
    if (a.crm.length) r.oportunidadesCrm = (await db.collection('oportunidades').updateMany({ _id: { $in: a.crm.map(c => c._id) } }, { $set: { orgId: destino, updatedAt: ahora } })).modifiedCount;
    res.json({ ok: true, movido: r, presupuestosQueQuedan: a.presQuedan.length });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
module.exports = router;
