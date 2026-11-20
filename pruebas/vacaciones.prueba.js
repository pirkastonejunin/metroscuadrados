// Sueldos: panel de vacaciones (20/11/2026) — días según antigüedad (LCT art. 150), registros, ajustes y saldo.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4162); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const e1 = new ObjectId(), e2 = new ObjectId(), e3 = new ObjectId();
  await db.collection('empleados').insertMany([
    { _id: e1, orgId: ORG, nombre: 'Antiguo', sector: 'produccion', fechaIngreso: new Date('2012-03-01T12:00:00Z'), activo: true },
    { _id: e2, orgId: ORG, nombre: 'Nuevo', sector: 'ventas', fechaIngreso: new Date('2024-02-01T12:00:00Z'), activo: true },
    { _id: e3, orgId: ORG, nombre: 'Reciente', sector: 'ventas', fechaIngreso: new Date('2026-10-01T12:00:00Z'), activo: true }]);
  let r = await api('GET', '/api/sueldos/vacaciones?anio=2026'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = n => r.data.empleados.find(x => x.nombre === n);
  assert.equal(f('Antiguo').corresponden, 28); assert.equal(f('Nuevo').corresponden, 14); assert(f('Reciente').corresponden < 14 && f('Reciente').corresponden >= 3, JSON.stringify(f('Reciente')));
  r = await api('POST', '/api/sueldos/vacaciones', { empleadoId: e1, desde: '2026-01-05', hasta: '2026-01-18' }); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.dias, 14);
  r = await api('POST', '/api/sueldos/vacaciones', { empleadoId: e1, desde: '2025-12-01', hasta: '2025-12-10' }); assert.equal(r.data.anio, 2025);
  r = await api('GET', '/api/sueldos/vacaciones?anio=2026');
  assert.equal(f('Antiguo') && r.data.empleados.find(x => x.nombre === 'Antiguo').tomados, 14);
  assert.equal(r.data.empleados.find(x => x.nombre === 'Antiguo').saldoAnterior, 28 - 10, 'arrastra el saldo 2025');
  assert.equal(r.data.empleados.find(x => x.nombre === 'Antiguo').saldo, 28 - 14 + 18);
  r = await api('POST', '/api/sueldos/vacaciones', { empleadoId: e2, tipo: 'ajuste', anio: 2026, dias: -3, nota: 'a cuenta' }); assert.equal(r.status, 200);
  r = await api('GET', '/api/sueldos/vacaciones?anio=2026'); assert.equal(r.data.empleados.find(x => x.nombre === 'Nuevo').saldo, 11);
  const id = r.data.registros[0]._id; r = await api('DELETE', '/api/sueldos/vacaciones/' + id); assert.equal(r.status, 200);
  r = await api('POST', '/api/sueldos/vacaciones', { empleadoId: e1, desde: '2026-02-10', hasta: '2026-02-01' }); assert.equal(r.status, 400);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
