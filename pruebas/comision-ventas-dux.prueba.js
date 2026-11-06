// Comisión por % con ventas migradas de Dux (6/11/2026): se atribuyen por el nombre del vendedor (texto) y se avisa de los nombres parecidos.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4148); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const vendId = (await db.collection('visitas_vendedores').insertOne({ orgId: ORG, nombre: 'Carlos Pérez', comisionPct: 2, activo: true })).insertedId;
  const usrId = (await db.collection('usuarios').insertOne({ orgId: ORG, nombre: 'Carlos Pérez', usuario: 'carlos', vendedorId: vendId })).insertedId;
  const empId = (await db.collection('empleados').insertOne({ orgId: ORG, nombre: 'Carlos Pérez', vendedorId: vendId, activo: true, sueldoBasico: 100000, frecuencia: 'mensual', comisionTipo: 'porcentaje' })).insertedId;
  const f = new Date('2026-10-15T15:00:00Z'); const base = { orgId: ORG, tipoComprobante: 'comprobante_x', moneda: 'ARS', estado: 'pendiente', fecha: f, items: [] };
  await db.collection('ventas').insertMany([
    { ...base, numero: 1, total: 1000, usuarioId: usrId, vendedor: 'Carlos Pérez' },        // cargada en el sistema
    { ...base, numero: 2, total: 2000, vendedor: 'CARLOS PÉREZ' },                          // migrada de Dux: solo el nombre, en mayúsculas
    { ...base, numero: 3, total: 4000, vendedor: 'carlos pérez ' },                         // con espacio de más
    { ...base, numero: 4, total: 8000, vendedor: 'Otro Vendedor' },                         // de otro: no cuenta
    { ...base, numero: 5, total: 16000, vendedor: 'Pérez, Carlos' },                        // nombre parecido: no cuenta pero avisa
    { ...base, numero: 6, total: 500, vendedor: 'Carlos Pérez', estado: 'anulada' }         // anulada: no cuenta
  ]);
  const r = await api('GET', `/api/sueldos/comision?empleadoId=${empId}&periodo=2026-11`); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ventas, 3, 'cuenta las 3 de Carlos (sistema + Dux)'); assert.equal(r.data.base, 7000); assert.equal(r.data.monto, 140);
  assert(r.data.avisos.some(a => /Pérez, Carlos/.test(a) && /1 venta/.test(a)), 'avisa de la de nombre parecido: ' + JSON.stringify(r.data.avisos));
  assert(!r.data.avisos.some(a => /Otro Vendedor/.test(a)), 'no avisa de vendedores que no se parecen');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
