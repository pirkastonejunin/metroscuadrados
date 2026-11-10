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
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
