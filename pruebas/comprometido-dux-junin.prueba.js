// El detalle de "comprometido" muestra también las ventas de Dux sin depósito (se cuentan contra Junín de su sucursal) (10/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4154); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const prod = new ObjectId(), junin = new ObjectId(), colome = new ObjectId();
  await db.collection('depositos').insertMany([{ _id: junin, orgId: ORG, nombre: 'Depósito Junín', activo: true }, { _id: colome, orgId: ORG, nombre: 'Colomé', activo: true }]);
  await db.collection('ventas').insertOne({ orgId: ORG, numero: 30, numeroOriginal: 'FA-0001-555', tipoComprobante: 'comprobante_x', estado: 'pendiente', importado: true, depositoId: null, clienteNombre: 'Cliente Dux', total: 100, fecha: new Date(), items: [{ productoId: prod, nombre: 'P', cantidad: 7, cantidadEntregada: 0 }] });
  let r = await api('GET', `/api/stock/comprometido?productoId=${prod}&depositoId=${junin}`); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.length, 1, JSON.stringify(r.data)); assert.equal(r.data[0].cantidad, 7);
  r = await api('GET', `/api/stock/comprometido?productoId=${prod}&depositoId=${colome}`); assert.equal(r.data.length, 0, 'en otro depósito no aparece');
  // ítem de Dux sin producto vinculado: el recálculo lo vincula por SKU y lo compromete contra Junín
  const prod2 = new ObjectId();
  await db.collection('productos_catalogo').insertOne({ _id: prod2, orgId: ORG, sku: 'IRREGULAR GRIS', nombre: 'REVESTIMIENTO IRREGULAR GRIS 0,25 M2', activo: true });
  await db.collection('stock_actual').insertOne({ orgId: ORG, productoId: prod2, depositoId: junin, cantidad: 42.5, cantidadComprometida: 0 });
  const v2 = (await db.collection('ventas').insertOne({ orgId: ORG, numero: 31, tipoComprobante: 'comprobante_x', estado: 'pendiente', importado: true, depositoId: null, clienteNombre: 'Otro', total: 50, fecha: new Date(), items: [{ sku: 'irregular gris', nombre: 'IRREGULAR GRIS', cantidad: 3, cantidadEntregada: 0 }] })).insertedId;
  r = await api('POST', '/api/stock/recalcular-comprometido', {}); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.itemsVinculados, 1, JSON.stringify(r.data));
  r = await api('POST', '/api/stock/recalcular-comprometido', { aplicar: true }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const st = await db.collection('stock_actual').findOne({ productoId: prod2, depositoId: junin }); assert.equal(st.cantidadComprometida, 3, JSON.stringify(st));
  const vv = await db.collection('ventas').findOne({ _id: v2 }); assert.equal(String(vv.items[0].productoId), String(prod2));
  r = await api('GET', `/api/ventas/${v2}/diagnostico-stock`); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.items.length, 1); assert.equal(r.data.items[0].stock[0].comprometida, 3, JSON.stringify(r.data));
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
