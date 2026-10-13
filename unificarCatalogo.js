// ---------------------------------------------------------------------------
// Catálogo compartido entre sucursales (13/10/2026, pedido de Mato: Pirka, Piedra Negra y Factory trabajan con la misma
// base de productos, los mismos dos depósitos —Junín y Colomé— y las mismas listas de precios; todos ven todo).
// PASO 1 (este archivo, solo lectura): diagnóstico de lo que hoy hay en cada sucursal, para planear la unificación sin tocar nada.
// Ruta: GET /api/unificar-catalogo/diagnostico   (solo Administrador)
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');
const compartido = require('./compartido');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db(DB_NAME); }
const solo = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador.' });
const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

router.get('/diagnostico', authUsuario, solo, async (req, res) => {
  try {
    const db = await getDb();
    const orgs = await db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
    const nom = new Map(orgs.map(o => [String(o._id), o.nombre]));
    const porOrg = async (col, match) => {
      const rows = await db.collection(col).aggregate([{ $match: match || {} }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]).toArray();
      return Object.fromEntries(rows.map(r => [String(r._id), r.n]));
    };
    const cuentas = {};
    for (const [clave, col, match] of [
      ['productosActivos', 'productos_catalogo', { activo: { $ne: false } }], ['productosInactivos', 'productos_catalogo', { activo: false }],
      ['listasPrecio', 'productos_listas_precio', {}], ['depositos', 'depositos', {}], ['stockFilas', 'stock_actual', {}], ['stockMovimientos', 'stock_movimientos', {}],
      ['rubros', 'productos_rubros_base', {}], ['subrubros', 'productos_subrubros_base', {}],
      ['ventas', 'ventas', {}], ['compras', 'compras', {}], ['presupuestos', 'presupuestos', {}], ['obras', 'obras', {}]
    ]) { try { cuentas[clave] = await porOrg(col, match); } catch (e) { cuentas[clave] = {}; } }
    const depositos = (await db.collection('depositos').find({}).toArray()).map(d => ({ _id: String(d._id), org: nom.get(String(d.orgId)) || String(d.orgId), nombre: d.nombre, activo: d.activo !== false }));
    for (const d of depositos) {
      const r = await db.collection('stock_actual').aggregate([{ $match: { depositoId: require('mongodb').ObjectId.createFromHexString(d._id) } }, { $group: { _id: null, filas: { $sum: 1 }, conStock: { $sum: { $cond: [{ $gt: ['$cantidad', 0] }, 1, 0] } } } }]).toArray();
      d.filasStock = r[0] ? r[0].filas : 0; d.conStock = r[0] ? r[0].conStock : 0;
    }
    const listas = (await db.collection('productos_listas_precio').find({}).project({ nombre: 1, orgId: 1, predeterminada: 1, activa: 1 }).toArray()).map(l => ({ org: nom.get(String(l.orgId)) || String(l.orgId), nombre: l.nombre, predeterminada: !!l.predeterminada, activa: l.activa !== false }));
    const cot = (await db.collection('config_general').find({ clave: 'cotizacionDolar' }).toArray()).map(c => ({ org: nom.get(String(c.orgId)) || String(c.orgId), valor: c.valor }));
    // SKU repetidos entre sucursales
    const prods = await db.collection('productos_catalogo').find({ activo: { $ne: false }, sku: { $nin: [null, ''] } }).project({ sku: 1, orgId: 1, nombre: 1 }).toArray();
    const porSku = new Map();
    for (const p of prods) { const k = String(p.sku).trim().toUpperCase(); if (!porSku.has(k)) porSku.set(k, []); porSku.get(k).push(p); }
    let enVariasOrgs = 0, repetidosEnMismaOrg = 0; const ejemplos = [];
    for (const [k, arr] of porSku) {
      const o = new Set(arr.map(p => String(p.orgId)));
      if (o.size > 1) { enVariasOrgs++; if (ejemplos.length < 12) ejemplos.push({ sku: k, orgs: [...o].map(x => nom.get(x) || x), nombres: arr.slice(0, 3).map(p => p.nombre) }); }
      else if (arr.length > 1) repetidosEnMismaOrg++;
    }
    res.json({ organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })), cuentas, depositos, listas, cotizacionDolar: cot, skus: { total: porSku.size, enVariasSucursales: enVariasOrgs, repetidosEnMismaSucursal: repetidosEnMismaOrg, ejemplos } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/estado', authUsuario, solo, async (req, res) => {
  res.json({ activo: compartido.estado.activo, matrizOrgId: compartido.estado.matriz ? String(compartido.estado.matriz) : null });
});

// Activa el catálogo compartido: deja TODO lo compartido bajo la sucursal matriz y prende el reemplazo de sucursal en cada consulta.
// Listas de precio repetidas (mismo nombre) se unifican con la de la matriz; ventas y presupuestos que la usaban pasan a la de la matriz.
router.post('/activar', authUsuario, solo, async (req, res) => {
  try {
    const { ObjectId } = require('mongodb');
    const db = await getDb();
    let matriz; try { matriz = new ObjectId(String((req.body || {}).matrizOrgId)); } catch (e) { return res.status(400).json({ error: 'Elegí la sucursal matriz.' }); }
    if (String((req.body || {}).confirmar || '').toLowerCase() !== 'activar') return res.status(400).json({ error: 'Falta la confirmación.' });
    if (!(await db.collection('organizaciones').findOne({ _id: matriz }))) return res.status(400).json({ error: 'La sucursal matriz no existe.' });
    const resumen = { listasUnificadas: 0, listasMovidas: 0 };
    const bloqueos = [];
    for (const col of ['productos_catalogo', 'depositos', 'stock_actual', 'stock_movimientos', 'productos_rubros_base', 'productos_subrubros_base']) {
      const n = await db.collection(col).countDocuments({ orgId: { $nin: [matriz, null] } });
      if (n) bloqueos.push(col + ': ' + n);
    }
    if (bloqueos.length) return res.status(409).json({ error: 'Hay datos en otras sucursales que primero hay que unificar (' + bloqueos.join(', ') + '). Pasame el diagnóstico y lo resuelvo antes de activar.' });
    const propias = await db.collection('productos_listas_precio').find({ orgId: { $nin: [matriz, null] } }).toArray();
    const deMatriz = await db.collection('productos_listas_precio').find({ orgId: matriz }).toArray();
    for (const l of propias) {
      const igual = deMatriz.find(m => norm(m.nombre) === norm(l.nombre));
      if (igual) {
        for (const col of ['ventas', 'presupuestos']) await db.collection(col).updateMany({ listaPrecioId: l._id }, { $set: { listaPrecioId: igual._id } });
        await db.collection('productos_listas_precio').deleteOne({ _id: l._id }); resumen.listasUnificadas++;
      } else { await db.collection('productos_listas_precio').updateOne({ _id: l._id }, { $set: { orgId: matriz } }); resumen.listasMovidas++; }
    }
    await db.collection('config_general').updateOne({ clave: 'catalogoCompartido' }, { $set: { clave: 'catalogoCompartido', activo: true, matrizOrgId: matriz, activadoEn: new Date() } }, { upsert: true });
    await compartido.recargar();
    res.json({ ok: true, resumen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/desactivar', authUsuario, solo, async (req, res) => {
  try {
    const db = await getDb();
    await db.collection('config_general').updateOne({ clave: 'catalogoCompartido' }, { $set: { activo: false } });
    await compartido.recargar();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
module.exports = router;
