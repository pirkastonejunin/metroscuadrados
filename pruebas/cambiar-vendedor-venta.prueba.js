// Cambiar el vendedor de cualquier venta ya hecha, también facturas con CAE y migradas de Dux (11/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4156); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const base = { orgId: ORG, estado: 'entregada', clienteNombre: 'C', total: 100, saldoPendiente: 0, moneda: 'ARS', fecha: new Date(), items: [], vendedor: 'Carlos' };
  const fiscal = (await db.collection('ventas').insertOne(Object.assign({}, base, { numero: 50, tipoComprobante: 'factura', esFiscal: true, cae: '12345678901234' }))).insertedId;
  const dux = (await db.collection('ventas').insertOne(Object.assign({}, base, { numero: 51, tipoComprobante: 'comprobante_x', importado: true }))).insertedId;
  const anulada = (await db.collection('ventas').insertOne(Object.assign({}, base, { numero: 52, tipoComprobante: 'comprobante_x', estado: 'anulada' }))).insertedId;
  for (const id of [fiscal, dux, anulada]) {
    const r = await api('PUT', `/api/ventas/${id}/vendedor`, { vendedor: 'Lucas' }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.vendedor, 'Lucas');
    const v = await db.collection('ventas').findOne({ _id: id }); assert.equal(v.vendedor, 'Lucas'); assert(/Carlos → Lucas/.test(v.ediciones[0].cambios[0]), JSON.stringify(v.ediciones)); assert.equal(v.total, 100);
  }
  let r = await api('PUT', `/api/ventas/${fiscal}/vendedor`, { vendedor: '' }); assert.equal(r.status, 200); assert.equal(r.data.vendedor, '');
  r = await api('PUT', `/api/ventas/${new ObjectId()}/vendedor`, { vendedor: 'X' }); assert.equal(r.status, 404);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
