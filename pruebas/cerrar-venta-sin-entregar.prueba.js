// Cerrar una venta sin entregar lo que falta (10/11/2026): sale del comprometido, no mueve el stock físico, se puede reabrir.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4153); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const p1 = new ObjectId(), p2 = new ObjectId(), dep = new ObjectId(), cli = new ObjectId();
  await db.collection('stock_actual').insertMany([{ orgId: ORG, productoId: p1, depositoId: dep, cantidad: 100, cantidadComprometida: 10 }, { orgId: ORG, productoId: p2, depositoId: dep, cantidad: 50, cantidadComprometida: 4 }]);
  const venta = (await db.collection('ventas').insertOne({ orgId: ORG, numero: 20, tipoComprobante: 'comprobante_x', estado: 'parcialmente_entregada', stockComprometido: true, depositoId: dep, clienteId: cli, clienteNombre: 'C', total: 1000, totalCobrado: 0, saldoPendiente: 1000, moneda: 'ARS', fecha: new Date(),
    items: [{ productoId: p1, nombre: 'A', cantidad: 10, cantidadEntregada: 6 }, { productoId: p2, nombre: 'B', cantidad: 4, cantidadEntregada: 0 }] })).insertedId;
  const st = async p => db.collection('stock_actual').findOne({ productoId: p, depositoId: dep });
  let r = await api('POST', `/api/ventas/${venta}/cerrar`, { motivo: 'el cliente ya no los quiere' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'entregada'); assert.equal(r.data.items[0].cantidadCerrada, 4); assert.equal(r.data.items[1].cantidadCerrada, 4);
  assert.equal(r.data.saldoPendiente, 1000, 'no cambia la plata');
  let s1 = await st(p1), s2 = await st(p2);
  assert.equal(s1.cantidad, 100); assert.equal(s2.cantidad, 50, 'el stock físico no se mueve');
  assert.equal(s1.cantidadComprometida, 6); assert.equal(s2.cantidadComprometida, 0);
  r = await api('POST', `/api/ventas/${venta}/cerrar`, {}); assert.equal(r.status, 400, 'ya cerrada');
  r = await api('POST', `/api/ventas/${venta}/reabrir-cierre`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'parcialmente_entregada'); assert(!r.data.items[0].cantidadCerrada);
  s1 = await st(p1); s2 = await st(p2); assert.equal(s1.cantidadComprometida, 10); assert.equal(s2.cantidadComprometida, 4); assert.equal(s1.cantidad, 100);
  // cierre parcial: solo el ítem B
  r = await api('POST', `/api/ventas/${venta}/cerrar`, { items: [{ index: 1 }] }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'parcialmente_entregada'); s1 = await st(p1); s2 = await st(p2); assert.equal(s1.cantidadComprometida, 10); assert.equal(s2.cantidadComprometida, 0);
  // anular una venta cerrada no libera dos veces
  r = await api('POST', `/api/ventas/${venta}/anular`, { motivo: 't' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  s2 = await st(p2); assert(s2.cantidadComprometida >= 0 && s2.cantidadComprometida === 0, 'B no queda negativo: ' + s2.cantidadComprometida);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
