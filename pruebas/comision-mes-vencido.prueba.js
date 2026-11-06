// Comisiones a mes vencido (6/11/2026): la liquidación de noviembre lleva las ventas de octubre, repartidas en cuotas si cobra por semana.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4149); const { db, api, ORG } = h;
  const vendId = (await db.collection('visitas_vendedores').insertOne({ orgId: ORG, nombre: 'Carlos V', comisionPct: 2, activo: true })).insertedId;
  const usrId = (await db.collection('usuarios').insertOne({ orgId: ORG, nombre: 'Carlos V', usuario: 'cv', vendedorId: vendId })).insertedId;
  const empId = (await db.collection('empleados').insertOne({ orgId: ORG, nombre: 'Carlos V', vendedorId: vendId, activo: true, sueldoBasico: 100000, frecuencia: 'semanal', comisionTipo: 'porcentaje', comisionPago: 'con_sueldo' })).insertedId;
  const base = { orgId: ORG, tipoComprobante: 'comprobante_x', moneda: 'ARS', estado: 'pendiente', items: [], vendedor: 'Carlos V', usuarioId: usrId };
  await db.collection('ventas').insertMany([
    { ...base, numero: 1, total: 10000, fecha: new Date('2026-10-20T15:00:00Z') },   // octubre: cuenta en noviembre
    { ...base, numero: 2, total: 40000, fecha: new Date('2026-11-03T15:00:00Z') },   // noviembre: cuenta en diciembre
    { ...base, numero: 3, total: 5000, fecha: new Date('2026-09-30T15:00:00Z') }     // septiembre: no cuenta
  ]);
  let r = await api('GET', `/api/sueldos/comision?empleadoId=${empId}&periodo=2026-11`);
  assert.equal(r.data.base, 10000); assert.equal(r.data.monto, 200);
  r = await api('GET', `/api/sueldos/comision?empleadoId=${empId}&periodo=2026-12`);
  assert.equal(r.data.base, 40000); assert.equal(r.data.monto, 800);
  r = await api('GET', `/api/sueldos/comision?empleadoId=${empId}&periodo=2027-01`);
  assert.equal(r.data.base, 0, 'enero mira diciembre');
  // La liquidación nueva lleva la comisión completa y los pagos la reparten en cuotas.
  const c = await api('POST', '/api/sueldos/liquidaciones/copiar', { periodo: '2026-11' }); assert.equal(c.status, 200, JSON.stringify(c.data));
  const l = await db.collection('sueldos_liquidaciones').findOne({ empleadoId: empId, periodo: '2026-11' });
  assert.equal(l.comisiones, 200);
  const p = await api('GET', '/api/sueldos/pagos-periodo?periodo=2026-11&fecha=2026-11-06'); assert.equal(p.status, 200, JSON.stringify(p.data));
  const fila = (p.data.filas || p.data).find(x => x.empleadoId === String(empId));
  assert.equal(fila.sugeridaComision, 50, 'cuota 1 de 4'); assert.equal(fila.comisionNueva, 0);
  const u = await api('GET', '/api/sueldos/pagos-periodo?periodo=2026-11&fecha=2026-11-27');
  const fu = (u.data.filas || u.data).find(x => x.empleadoId === String(empId));
  assert.equal(fu.sugeridaComision, 200, 'último pago del mes: lo que falte');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
