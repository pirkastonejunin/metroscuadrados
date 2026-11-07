// Nota de crédito asociada a una venta migrada de Dux ya cobrada y sin entregar (7/11/2026): sale de los pendientes.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4152); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const prod = new ObjectId(), cli = new ObjectId();
  const venta = (await db.collection('ventas').insertOne({ orgId: ORG, numero: 10, numeroOriginal: 'FA-0001-123', tipoComprobante: 'comprobante_x', estado: 'pendiente', clienteNombre: 'Cliente Dux', total: 1000, totalCobrado: 1000, saldoPendiente: 0, moneda: 'ARS', fecha: new Date('2026-05-01'),
    items: [{ productoId: prod, nombre: 'P', cantidad: 5, cantidadEntregada: 0 }] })).insertedId;
  const nota = (await db.collection('ventas').insertOne({ orgId: ORG, numero: 11, tipoComprobante: 'nota_credito', estado: 'entregada', clienteId: cli, clienteNombre: 'Cliente Dux', total: 1000, moneda: 'ARS', fecha: new Date('2026-06-01'), items: [{ productoId: prod, nombre: 'P', cantidad: 5 }] })).insertedId;
  let r = await api('GET', '/api/ventas/con-saldo?todos=1&q=Dux'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.find(x => x._id === String(venta)); assert(f && f.pendienteEntrega && f.acreditable === 1000, JSON.stringify(r.data));
  r = await api('POST', `/api/ventas/${nota}/asociar`, { facturaId: String(venta), liberar: true, otroCliente: true }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.cancelada, true);
  const v = await db.collection('ventas').findOne({ _id: venta });
  assert.equal(v.canceladaPorNota, true); assert.equal(v.estado, 'entregada'); assert.equal(v.items[0].cantidadAcreditada, 5); assert.equal(v.saldoPendiente, 0);
  r = await api('POST', `/api/ventas/${nota}/desasociar`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  const v2 = await db.collection('ventas').findOne({ _id: venta });
  assert.equal(v2.canceladaPorNota, false); assert.equal(v2.estado, 'pendiente'); assert.equal(v2.items[0].cantidadAcreditada, 0);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
