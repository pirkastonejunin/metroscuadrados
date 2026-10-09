// ---------------------------------------------------------------------------
// Reinicio de datos de PRUEBA (9/10/2026, pedido de Mato): antes de importar el historial de Dux se dejan en
// blanco ventas, remitos, cobranzas, stock, cuenta corriente, tesorería y compras, y se conserva todo lo
// demás (visitas, obras, presupuestos, clientes, productos, proveedores, listas, usuarios y configuración).
// Solo el rol Administrador (protegido), solo la organización con la que está trabajando, y exige escribir
// BORRAR. GET /preview cuenta lo que se borraría, GET /respaldo baja un JSON con todo eso antes de borrar.
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
async function getDb() {
  if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; }
  return mongoClient.db(DB_NAME);
}
function err(status, message) { return Object.assign(new Error(message), { status }); }
function soloAdmin(req, res, next) {
  if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) return res.status(403).json({ error: 'Solo el rol Administrador puede reiniciar los datos.' });
  if (!req.orgId) return res.status(400).json({ error: 'Elegí con qué organización estás trabajando (no "todas").' });
  next();
}
const auth = [authUsuario, resolverOrg, soloAdmin];

// Colecciones con orgId propio que se vacían por completo para la organización.
const POR_ORG = [
  ['ventas', 'Ventas'], ['remitos', 'Remitos'], ['ventas_contadores', 'Numeración de ventas'], ['remitos_contadores', 'Numeración de remitos'],
  ['stock_movimientos', 'Movimientos de stock'], ['stock_actual', 'Stock actual (y comprometido)'],
  ['cuenta_corriente_movimientos', 'Movimientos de cuenta corriente'],
  ['tesoreria_movimientos', 'Movimientos de tesorería (cobros, caja, bancos)'], ['cheques', 'Cheques'], ['retenciones_sufridas', 'Retenciones sufridas'],
  ['compras', 'Compras'], ['compras_pagos', 'Pagos a proveedores'], ['compras_contadores', 'Numeración de compras'],
  ['ordenes_compra', 'Órdenes de compra'], ['ordenes_compra_contadores', 'Numeración de órdenes de compra']
];

async function cuentasConMovimientos(db, orgId) {
  return db.collection('tesoreria_movimientos').distinct('cuentaId', { orgId });
}
async function clientesDeOrg(db, orgId) {
  return (await db.collection('clientes').find({ orgId }).project({ _id: 1 }).toArray()).map(c => c._id);
}

router.get('/preview', auth, async (req, res) => {
  try {
    const db = await getDb(); const orgId = req.orgId;
    const filas = [];
    for (const [col, etiqueta] of POR_ORG) filas.push({ coleccion: col, etiqueta, cantidad: await db.collection(col).countDocuments({ orgId }) });
    const cids = await clientesDeOrg(db, orgId);
    filas.push({ coleccion: 'cuenta_corriente_saldos', etiqueta: 'Saldos de cuenta corriente de clientes', cantidad: await db.collection('cuenta_corriente_saldos').countDocuments({ clienteId: { $in: cids } }) });
    filas.push({ coleccion: 'tesoreria_saldos', etiqueta: 'Saldos de cajas/bancos (se ponen en 0)', cantidad: (await cuentasConMovimientos(db, orgId)).length });
    const org = await db.collection('organizaciones').findOne({ _id: orgId });
    res.json({ organizacion: (org && org.nombre) || String(orgId), filas, conservado: ['Visitas', 'Obras', 'Presupuestos', 'Clientes', 'Productos', 'Proveedores', 'Listas de precios', 'Usuarios y configuración'] });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/respaldo', auth, async (req, res) => {
  try {
    const db = await getDb(); const orgId = req.orgId; const out = {};
    for (const [col] of POR_ORG) out[col] = await db.collection(col).find({ orgId }).toArray();
    const cids = await clientesDeOrg(db, orgId);
    out.cuenta_corriente_saldos = await db.collection('cuenta_corriente_saldos').find({ clienteId: { $in: cids } }).toArray();
    out.tesoreria_saldos = await db.collection('tesoreria_saldos').find({ cuentaId: { $in: await cuentasConMovimientos(db, orgId) } }).toArray();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="respaldo-antes-de-reiniciar.json"');
    res.send(JSON.stringify(out));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/ejecutar', auth, async (req, res) => {
  try {
    if (!req.body || req.body.confirmar !== 'BORRAR') throw err(400, 'Escribí BORRAR para confirmar.');
    const db = await getDb(); const orgId = req.orgId; const borrado = {};
    // Tesorería y cuenta corriente primero (se calculan a partir de lo que va a desaparecer).
    const cuentas = await cuentasConMovimientos(db, orgId);
    const cids = await clientesDeOrg(db, orgId);
    const r1 = await db.collection('cuenta_corriente_saldos').deleteMany({ clienteId: { $in: cids } });
    borrado.cuenta_corriente_saldos = r1.deletedCount;
    const r2 = await db.collection('tesoreria_saldos').updateMany({ cuentaId: { $in: cuentas } }, { $set: { saldo: 0, actualizadoEn: new Date() } });
    borrado.tesoreria_saldos_en_cero = r2.modifiedCount;
    for (const [col] of POR_ORG) borrado[col] = (await db.collection(col).deleteMany({ orgId })).deletedCount;
    // Los presupuestos se conservan: solo se corta el vínculo a ventas que ya no existen.
    const rp = await db.collection('presupuestos').updateMany({ orgId, convertidoEnVentaId: { $ne: null } }, { $set: { convertidoEnVentaId: null, convertidoEnVentaNumero: null } });
    borrado.presupuestos_desvinculados = rp.modifiedCount;
    res.json({ ok: true, borrado });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
