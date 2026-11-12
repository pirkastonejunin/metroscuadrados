// Modificar un remito ya hecho (12/11/2026): ajusta stock, entregado/pendiente y comprometido de la venta; queda registro.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4154); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const p1 = new ObjectId(), dep = new ObjectId(), cli = new ObjectId();
  await db.collection('depositos').insertOne({ _id: dep, orgId: ORG, nombre: 'Junín', activo: true });
  await db.collection('stock_actual').insertOne({ orgId: ORG, productoId: p1, depositoId: dep, cantidad: 90, cantidadComprometida: 0 });
  const venta = (await db.collection('ventas').insertOne({ orgId: ORG, numero: 30, tipoComprobante: 'comprobante_x', estado: 'entregada', stockComprometido: true, stockDescontado: true, depositoId: dep, clienteId: cli, clienteNombre: 'C', total: 1000, saldoPendiente: 1000,
    items: [{ productoId: p1, sku: 'A', nombre: 'A', cantidad: 10, cantidadEntregada: 10 }] })).insertedId;
  const rem = (await db.collection('remitos').insertOne({ orgId: ORG, numero: 1, ventaId: venta, depositoId: dep, depositoNombre: 'Junín', clienteId: cli, items: [{ productoId: p1, sku: 'A', nombre: 'A', cantidad: 10 }], fecha: new Date(), observaciones: '' })).insertedId;
  await db.collection('productos_catalogo').insertOne({ _id: p1, orgId: ORG, nombre: 'A', sku: 'A', aceptaStockNegativo: false });
  const st = async () => db.collection('stock_actual').findOne({ productoId: p1, depositoId: dep });
  const vt = async () => db.collection('ventas').findOne({ _id: venta });
  // entregó 6 en vez de 10: vuelven 4 al stock y quedan pendientes
  let r = await api('PUT', `/api/ventas/remitos/${rem}`, { items: [{ index: 0, cantidad: 6 }], observaciones: 'corregido' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let s = await st(); assert.equal(s.cantidad, 94); assert.equal(s.cantidadComprometida, 4);
  let v = await vt(); assert.equal(v.items[0].cantidadEntregada, 6); assert.equal(v.estado, 'parcialmente_entregada');
  assert.equal(r.data.items[0].cantidad, 6); assert.equal(r.data.observaciones, 'corregido'); assert.equal(r.data.ediciones.length, 1);
  // no se puede pasar de lo pendiente
  r = await api('PUT', `/api/ventas/remitos/${rem}`, { items: [{ index: 0, cantidad: 11 }] }); assert.equal(r.status, 400, JSON.stringify(r.data));
  // subir a 9: sale stock y baja el pendiente
  r = await api('PUT', `/api/ventas/remitos/${rem}`, { items: [{ index: 0, cantidad: 9 }] }); assert.equal(r.status, 200, JSON.stringify(r.data));
  s = await st(); assert.equal(s.cantidad, 91); assert.equal(s.cantidadComprometida, 1);
  v = await vt(); assert.equal(v.items[0].cantidadEntregada, 9);
  // sin stock suficiente no deja subir
  await db.collection('stock_actual').updateOne({ productoId: p1 }, { $set: { cantidad: 0 } });
  r = await api('PUT', `/api/ventas/remitos/${rem}`, { items: [{ index: 0, cantidad: 10 }] }); assert.equal(r.status, 400, JSON.stringify(r.data));
  // no puede quedar en cero
  r = await api('PUT', `/api/ventas/remitos/${rem}`, { items: [{ index: 0, cantidad: 0 }] }); assert.equal(r.status, 400);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
