// Comisión como % de lo vendido por toda la sucursal, a mes vencido (7/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4151); const { db, api, ORG } = h;
  const alta = await api('POST', '/api/sueldos/empleados', { nombre: 'Lucas', sector: 'ventas', sueldoBasico: 100000, comisionTipo: 'porcentaje_sucursal', pctSucursal: 1.5 });
  assert.equal(alta.status, 200, JSON.stringify(alta.data)); const empId = alta.data._id || alta.data.id;
  const base = { orgId: ORG, tipoComprobante: 'comprobante_x', moneda: 'ARS', estado: 'pendiente', items: [] };
  await db.collection('ventas').insertMany([
    { ...base, numero: 1, total: 100000, vendedor: 'Otro', fecha: new Date('2026-10-10T15:00:00Z') },
    { ...base, numero: 2, total: 50000, vendedor: 'Lucas', fecha: new Date('2026-10-20T15:00:00Z') },
    { ...base, numero: 3, total: 10000, tipoComprobante: 'nota_credito', fecha: new Date('2026-10-21T15:00:00Z') },
    { ...base, numero: 4, total: 9999, estado: 'anulada', fecha: new Date('2026-10-22T15:00:00Z') },
    { ...base, numero: 5, total: 70000, fecha: new Date('2026-11-02T15:00:00Z') }
  ]);
  const r = await api('GET', `/api/sueldos/comision?empleadoId=${empId}&periodo=2026-11`); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.base, 140000); assert.equal(r.data.monto, 2100); assert.equal(r.data.ventas, 2); assert.equal(r.data.notasCredito, 1);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
