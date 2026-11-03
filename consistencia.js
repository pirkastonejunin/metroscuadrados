// Revisión de consistencia (auditoría 3/11/2026): busca registros que quedaron duplicados o a medias, para revisarlos a mano.
// No corrige nada. Solo administrador. Mira TODAS las sucursales.
//   GET /api/consistencia?dias=180
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');
const router = express.Router();
let mongoClient;
async function getDb() {
  if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; }
  return mongoClient.db('calculadora_m2');
}
const soloAdmin = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador.' });
const MAX = 50;
const fechaAR = d => d ? new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().slice(0, 10) : '';

async function revisar(db, dias) {
  const desde = new Date(Date.now() - dias * 864e5);
  const orgs = await db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const nom = id => (orgs.find(o => String(o._id) === String(id)) || {}).nombre || '';
  const vivas = { estado: { $ne: 'anulada' }, importado: { $ne: true } };
  const out = [];
  const agregar = (clave, titulo, explicacion, filas) => out.push({ clave, titulo, explicacion, cantidad: filas.length, filas: filas.slice(0, MAX) });

  // 1. Ventas con el mismo número (mismo tipo y letra) en la misma sucursal.
  const numDup = await db.collection('ventas').aggregate([
    { $match: Object.assign({ fecha: { $gte: desde }, numero: { $ne: null } }, vivas) },
    { $group: { _id: { o: '$orgId', t: '$tipoComprobante', l: '$letra', n: '$numero' }, c: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { c: { $gt: 1 } } }, { $limit: 500 }]).toArray();
  agregar('ventas_numero_repetido', 'Ventas con el número repetido', 'Dos comprobantes vivos con el mismo tipo, letra y número en la misma sucursal.',
    numDup.map(g => ({ sucursal: nom(g._id.o), detalle: String(g._id.t || '').replace(/_/g, ' ') + ' ' + (g._id.l || '') + ' Nº ' + g._id.n, cantidad: g.c, ids: g.ids.map(String) })));

  // 2. Posibles ventas cargadas dos veces: mismo cliente y total, con menos de 2 minutos de diferencia.
  const vs = await db.collection('ventas').find(Object.assign({ createdAt: { $gte: desde }, total: { $gt: 0 } }, vivas)).project({ orgId: 1, clienteId: 1, clienteNombre: 1, total: 1, numero: 1, tipoComprobante: 1, createdAt: 1, fecha: 1 }).sort({ orgId: 1, clienteId: 1, total: 1, createdAt: 1 }).limit(100000).toArray();
  const posibles = [];
  for (let i = 1; i < vs.length; i++) {
    const a = vs[i - 1], b = vs[i];
    if (String(a.orgId) === String(b.orgId) && String(a.clienteId) === String(b.clienteId) && a.total === b.total && a.tipoComprobante === b.tipoComprobante && Math.abs(new Date(b.createdAt) - new Date(a.createdAt)) < 120000)
      posibles.push({ sucursal: nom(b.orgId), fecha: fechaAR(b.fecha), detalle: (b.clienteNombre || 'Cliente') + ' · $ ' + Math.round(b.total).toLocaleString('es-AR') + ' · Nº ' + a.numero + ' y Nº ' + b.numero, ids: [String(a._id), String(b._id)] });
  }
  agregar('ventas_posible_duplicado', 'Posibles ventas cargadas dos veces', 'Mismo cliente, mismo tipo y mismo total, cargadas con menos de 2 minutos de diferencia. Puede ser correcto (dos compras iguales): revisalas.', posibles);

  // 3. Ventas sin su movimiento en la cuenta corriente.
  const sinCC = await db.collection('ventas').aggregate([
    { $match: Object.assign({ createdAt: { $gte: desde }, total: { $gt: 0 }, clienteId: { $ne: null } }, vivas) },
    { $lookup: { from: 'cuenta_corriente_movimientos', let: { v: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$ventaId', '$$v'] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'cc' } },
    { $match: { cc: { $size: 0 } } }, { $project: { orgId: 1, numero: 1, tipoComprobante: 1, clienteNombre: 1, total: 1, fecha: 1 } }, { $limit: 500 }]).toArray();
  agregar('ventas_sin_cuenta_corriente', 'Ventas sin movimiento en la cuenta corriente', 'La venta está guardada pero no generó la deuda del cliente: el saldo de ese cliente puede estar mal.',
    sinCC.map(v => ({ sucursal: nom(v.orgId), fecha: fechaAR(v.fecha), detalle: String(v.tipoComprobante || '').replace(/_/g, ' ') + ' Nº ' + v.numero + ' · ' + (v.clienteNombre || '') + ' · $ ' + Math.round(v.total).toLocaleString('es-AR'), ids: [String(v._id)] })));

  // 4. Movimientos de cuenta corriente de una venta que ya no existe.
  const huerf = await db.collection('cuenta_corriente_movimientos').aggregate([
    { $match: { origen: 'venta', ventaId: { $ne: null }, fecha: { $gte: desde }, anulado: { $ne: true } } },
    { $lookup: { from: 'ventas', localField: 'ventaId', foreignField: '_id', as: 'v' } },
    { $match: { v: { $size: 0 } } }, { $project: { orgId: 1, concepto: 1, clienteNombre: 1, monto: 1, fecha: 1 } }, { $limit: 500 }]).toArray();
  agregar('cuenta_corriente_huerfana', 'Cuenta corriente de ventas que no existen', 'Movimientos de deuda que apuntan a una venta borrada: inflan o bajan el saldo del cliente.',
    huerf.map(m => ({ sucursal: nom(m.orgId), fecha: fechaAR(m.fecha), detalle: (m.concepto || '') + ' · ' + (m.clienteNombre || '') + ' · $ ' + Math.round(m.monto || 0).toLocaleString('es-AR'), ids: [String(m._id)] })));

  // 5. Compras con el mismo comprobante del mismo proveedor.
  const compDup = await db.collection('compras').aggregate([
    { $match: { estado: { $ne: 'anulada' }, fecha: { $gte: desde }, comprobanteNumero: { $nin: [null, ''] } } },
    { $group: { _id: { o: '$orgId', p: '$proveedorId', t: '$tipoComprobante', pv: '$puntoVenta', n: '$comprobanteNumero' }, c: { $sum: 1 }, ids: { $push: '$_id' }, prov: { $first: '$proveedorNombre' } } },
    { $match: { c: { $gt: 1 } } }, { $limit: 500 }]).toArray();
  agregar('compras_repetidas', 'Compras con el mismo comprobante', 'El mismo comprobante del mismo proveedor cargado más de una vez.',
    compDup.map(g => ({ sucursal: nom(g._id.o), detalle: (g.prov || 'Proveedor') + ' · ' + String(g._id.t || '').replace(/_/g, ' ') + ' ' + (g._id.pv || '') + '-' + g._id.n, cantidad: g.c, ids: g.ids.map(String) })));

  // 6. Gastos con el mismo comprobante del mismo proveedor.
  const gasDup = await db.collection('gastos').aggregate([
    { $match: { estado: { $ne: 'anulada' }, fecha: { $gte: desde }, comprobanteNumero: { $nin: [null, ''] } } },
    { $group: { _id: { o: '$orgId', p: '$proveedorId', n: '$comprobanteNumero' }, c: { $sum: 1 }, ids: { $push: '$_id' }, prov: { $first: '$proveedorNombre' } } },
    { $match: { c: { $gt: 1 } } }, { $limit: 500 }]).toArray();
  agregar('gastos_repetidos', 'Gastos con el mismo comprobante', 'El mismo comprobante del mismo proveedor cargado más de una vez.',
    gasDup.map(g => ({ sucursal: nom(g._id.o), detalle: (g.prov || 'Proveedor') + ' · comprobante ' + g._id.n, cantidad: g.c, ids: g.ids.map(String) })));

  return { desde: fechaAR(desde), dias, revisiones: out, problemas: out.reduce((a, r) => a + r.cantidad, 0) };
}

router.get('/', authUsuario, soloAdmin, async (req, res) => {
  try {
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 180, 7), 1095);
    let r;
    try { r = await revisar(await getDb(), dias); } catch (e) { if (!require('./reintento').reintentable(e)) throw e; mongoClient = null; r = await revisar(await getDb(), dias); }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
module.exports = router;
module.exports.revisar = revisar;
