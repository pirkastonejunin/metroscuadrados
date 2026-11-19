// Stock de insumos: ingreso de materia prima, descuento por receta al producir, idempotencia e informe (19/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4161); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const cem = new ObjectId(), jor = new ObjectId(), cp = new ObjectId(), dep = new ObjectId();
  await db.collection('depositos').insertOne({ _id: dep, orgId: ORG, nombre: 'Junín', activo: true });
  await db.collection('costos_insumos').insertMany([
    { _id: cem, orgId: ORG, nombre: 'Cemento', unidad: 'kg', costoActual: 100, historial: [], activo: true },
    { _id: jor, orgId: ORG, nombre: 'Operario', unidad: 'jornal', costoActual: 5000, historial: [], activo: true }]);
  await db.collection('costos_productos').insertOne({ _id: cp, orgId: ORG, nombre: 'Placa', sku: 'PLACA', tipoCosteo: 'm2', rendimientoPorPaquete: 5, activo: true,
    receta: [{ insumoId: cem, cantidad: 2 }, { insumoId: jor, cantidad: 0.1, rendimiento: 10 }] });
  let r = await api('POST', `/api/costos/insumos/${cem}/ingreso`, { tipo: 'compra', cantidad: 100, costoUnitario: 120, actualizarCosto: true, proveedor: 'Corralón' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.stockActual, 100); assert.equal(r.data.costoActual, 120);
  r = await api('POST', `/api/costos/insumos/${jor}/ingreso`, { cantidad: 1 }); assert.equal(r.status, 400);
  r = await api('POST', '/api/costos/produccion/ingresar', { fecha: '2026-11-10', items: [{ productoId: cp, paquetes: 2 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let ins = await db.collection('costos_insumos').findOne({ _id: cem });
  assert.equal(ins.stockActual, 80, 'descontó 10 m² × 2 kg = 20');
  assert.equal(await db.collection('costos_insumos_movimientos').countDocuments({ tipo: 'consumo' }), 1, 'la mano de obra no descuenta');
  r = await api('POST', `/api/costos/insumos/${cem}/ingreso`, { tipo: 'ajuste', cantidad: -5, nota: 'merma' });
  assert.equal(r.data.stockActual, 75);
  r = await api('GET', '/api/costos/insumos-informe?desde=2026-10&hasta=2026-11'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const i = r.data.porInsumo.find(x => x.nombre === 'Cemento'); assert.equal(i.cantidad, 20); assert.equal(i.meses['2026-11'].cantidad, 20); assert.equal(i.costo, 2400);
  assert.equal(r.data.porProducto[0].meses['2026-11'].producido, 10);
  r = await api('GET', `/api/costos/insumos/${cem}/movimientos`); assert.equal(r.data.length, 3);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
