// Ventas pendientes importadas con productos sin vincular al catálogo: el recálculo las informa (6/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4147); const { db, api, ORG, ids } = h; const V = db.collection('ventas');
  await V.insertOne({ orgId: ORG, numero: 900, numeroOriginal: 'X-00900', tipoComprobante: 'comprobante_x', clienteNombre: 'Cliente Dux', estado: 'pendiente', fecha: new Date(), total: 100, items: [{ sku: 'PANEL1', nombre: 'Panel blanco', cantidad: 10, cantidadEntregada: 0 }] });
  await V.insertOne({ orgId: ORG, numero: 901, numeroOriginal: 'X-00901', tipoComprobante: 'comprobante_x', clienteNombre: 'Cliente Vinculado', estado: 'pendiente', fecha: new Date(), total: 100, items: [{ productoId: ids.cem50, nombre: 'Cemento', cantidad: 4, cantidadEntregada: 0 }] });
  let r = await api('POST', '/api/stock/recalcular-comprometido', {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.sinVincular.length, 1); assert.equal(r.data.sinVincular[0].comprobante, 'X-00900'); assert(r.data.sinVincular[0].items[0].includes('PANEL1'));
  r = await api('POST', '/api/stock/recalcular-comprometido', { aplicar: true }); assert.equal(r.status, 200);
  const st = await db.collection('stock_actual').findOne({ productoId: ids.cem50 }); assert.equal(st && st.cantidadComprometida, 4, 'la venta vinculada sí compromete');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
