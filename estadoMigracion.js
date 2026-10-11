// ---------------------------------------------------------------------------
// Estado de la migración de Dux (11/10/2026): qué hay cargado en la base, por módulo, sucursal y año, qué le falta
// y cuánto espacio queda en Atlas. Solo lectura. Solo el rol Administrador. GET /api/estado-migracion
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const LIMITE_MB = Number(process.env.DB_LIMITE_MB) || 512; // plan gratuito de Atlas
let mongoClient;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db(DB_NAME); }
const TZ = 'America/Argentina/Buenos_Aires';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const solo = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador puede ver el estado de la migración.' });

// $group por sucursal y año de la fecha indicada
const porAnio = (db, col, match, campoFecha, acc) => db.collection(col).aggregate([
  { $match: match },
  { $group: Object.assign({ _id: { o: '$orgId', y: { $year: { date: '$' + campoFecha, timezone: TZ } } }, n: { $sum: 1 } }, acc || {}) }
]).toArray();

router.get('/', authUsuario, solo, async (req, res) => {
  try {
    const db = await getDb();
    const orgs = await db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
    const esNota = { $in: ['$tipoComprobante', ['nota_credito', 'nota_debito']] };
    const esNotaC = { $regexMatch: { input: { $ifNull: ['$tipoComprobante', ''] }, regex: '^nota_' } };
    const det = { $cond: [{ $eq: ['$detalleDux', true] }, 1, 0] };
    const S = {};
    S.ventas = await porAnio(db, 'ventas', { importado: true }, 'createdAt', {
      notas: { $sum: { $cond: [esNota, 1, 0] } }, conDetalle: { $sum: det }, monto: { $sum: { $cond: [esNota, 0, '$total'] } }, sinDetalle: { $sum: { $cond: [{ $eq: ['$detalleDux', true] }, 0, 1] } },
      notasSinDetalle: { $sum: { $cond: [{ $and: [esNota, { $ne: ['$detalleDux', true] }, { $ne: ['$detalleEstimado', true] }] }, 1, 0] } } });
    S.remitos = await porAnio(db, 'remitos', { claveImport: { $exists: true } }, 'fecha', { vinculados: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$ventaId', null] }, null] }, 1, 0] } } }).catch(() => []);
    S.cobros = await porAnio(db, 'cuenta_corriente_movimientos', { importado: true, origen: { $in: ['cobro_venta', 'cobro_cuenta', 'devolucion'] } }, 'fecha', { monto: { $sum: '$monto' } });
    S.compras = await porAnio(db, 'compras', { importado: true }, 'fecha', { notas: { $sum: { $cond: [esNotaC, 1, 0] } }, conDetalle: { $sum: det }, monto: { $sum: { $cond: [esNotaC, 0, '$total'] } } });
    S.gastos = await porAnio(db, 'gastos', { importado: true }, 'fecha', { notas: { $sum: { $cond: [esNotaC, 1, 0] } }, conDetalle: { $sum: det }, monto: { $sum: { $cond: [esNotaC, 0, '$total'] } } });
    S.pagos = await porAnio(db, 'compras_pagos', { importado: true }, 'fecha', { monto: { $sum: '$monto' } });

    const saldosCli = await db.collection('cuenta_corriente_movimientos').aggregate([{ $match: { origen: 'saldo_inicial_dux' } },
      { $group: { _id: '$orgId', n: { $sum: 1 }, saldo: { $sum: { $cond: [{ $eq: ['$tipo', 'debito'] }, '$monto', { $multiply: ['$monto', -1] }] } } } }]).toArray();
    const cont = async (col, match) => db.collection(col).countDocuments(match || {}).catch(() => 0);
    const [clientes, proveedores, productos, stockFilas, tesoreria, cheques, presupuestos] = await Promise.all([
      db.collection('clientes').aggregate([{ $group: { _id: '$orgId', n: { $sum: 1 } } }]).toArray(),
      db.collection('proveedores').aggregate([{ $group: { _id: '$orgId', n: { $sum: 1 } } }]).toArray(),
      db.collection('productos_catalogo').aggregate([{ $group: { _id: '$orgId', n: { $sum: 1 } } }]).toArray(),
      cont('stock_actual', {}), cont('tesoreria_movimientos', {}), cont('cheques', {}), cont('presupuestos', {})
    ]);
    const saldosProv = await cont('proveedores_saldos_iniciales', {});

    // espacio en Atlas
    let espacio = null;
    try {
      const st = await db.command({ dbStats: 1, scale: 1024 * 1024 });
      const colls = await db.listCollections({}, { nameOnly: true }).toArray();
      const tams = [];
      for (const c of colls) { try { const s = await db.command({ collStats: c.name, scale: 1024 * 1024 }); tams.push({ coleccion: c.name, mb: round2((s.size || 0) + (s.totalIndexSize || 0)), docs: s.count }); } catch (e) {} }
      tams.sort((a, b) => b.mb - a.mb);
      espacio = { usadoMB: round2((st.dataSize || 0) + (st.indexSize || 0)), datosMB: round2(st.dataSize), limiteMB: LIMITE_MB, mayores: tams.slice(0, 8) };
    } catch (e) { espacio = { error: 'No se pudo leer el espacio: ' + e.message }; }

    res.json({ organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })), ventas: S.ventas, remitos: S.remitos, cobros: S.cobros, compras: S.compras, gastos: S.gastos, pagos: S.pagos,
      saldosClientes: saldosCli, clientes, proveedores, productos, otros: { stockFilas, tesoreria, cheques, presupuestos, saldosProveedores: saldosProv }, espacio, generado: new Date() });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
