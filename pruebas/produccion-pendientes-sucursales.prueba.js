// Producción: los pendientes juntan el comprometido de TODAS las sucursales por SKU (10/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4155); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const OTRA = new ObjectId(), cp = new ObjectId(), cat1 = new ObjectId(), cat2 = new ObjectId(), dep = new ObjectId(), depO = new ObjectId();
  await db.collection('costos_productos').insertOne({ _id: cp, orgId: ORG, nombre: 'Irregular gris', sku: 'IRREGULAR GRIS', tipoCosteo: 'm2', activo: true });
  await db.collection('productos_catalogo').insertMany([{ _id: cat1, orgId: ORG, sku: 'IRREGULAR GRIS', nombre: 'IG', unidad: 'm2', activo: true }, { _id: cat2, orgId: OTRA, sku: 'IRREGULAR GRIS', nombre: 'IG otra', unidad: 'm2', activo: true }]);
  await db.collection('stock_actual').insertMany([{ orgId: ORG, productoId: cat1, depositoId: dep, cantidad: 10, cantidadComprometida: 5 }, { orgId: OTRA, productoId: cat2, depositoId: depO, cantidad: 0, cantidadComprometida: 48 }]);
  await db.collection('ventas').insertOne({ orgId: OTRA, numero: 9, numeroOriginal: 'CX-00008-613', tipoComprobante: 'comprobante_x', estado: 'pendiente', clienteNombre: 'Bolado', fecha: new Date(), items: [{ productoId: cat2, nombre: 'IG', cantidad: 48, cantidadEntregada: 0 }] });
  let r = await api('GET', '/api/costos/produccion/panel?dias=7'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.productos.find(x => x.sku === 'IRREGULAR GRIS'); assert(f, JSON.stringify(r.data.productos));
  assert.equal(f.comprometido, 53, JSON.stringify(f)); assert.equal(f.faltante, 43, JSON.stringify(f));
  r = await api('GET', `/api/costos/produccion/comprometido?productoId=${cp}`); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ventas.length, 1, JSON.stringify(r.data)); assert.equal(r.data.ventas[0].cantidad, 48);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
