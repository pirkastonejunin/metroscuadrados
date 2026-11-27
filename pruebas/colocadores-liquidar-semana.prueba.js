// Colocadores: "Liquidar semana" liquida las tareas hasta la fecha elegida y avisa desde cuándo hay más (20/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4163, { replSet: true }); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const col = new ObjectId(); await db.collection('obras_colocadores').insertOne({ _id: col, nombre: 'Pepe', orgId: ORG });
  const mk = (n, dia) => ({ _id: new ObjectId(), orgId: ORG, numero: n, cliente: { nombre: 'C' + n }, estado: 'terminada', tareas: [{ _id: new ObjectId(), estado: 'terminada', colocadorId: col, tipoTrabajo: 'Placa', m2Presupuestados: 10, costoPorM2Aplicado: 1000, fechaFinReal: new Date(`2026-11-${dia}T15:00:00-03:00`) }] });
  await db.collection('obras').insertMany([mk(12, 18), mk(30, 19), mk(29, 20)]);
  let r = await api('POST', '/api/sueldos/colocadores/liquidar', { periodo: '2026-11', tipo: 'parcial', hasta: '2026-11-13' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.tareas, 0); assert.equal(r.data.proximaFecha, '2026-11-18');
  r = await api('POST', '/api/sueldos/colocadores/liquidar', { periodo: '2026-11', tipo: 'parcial', hasta: '2026-11-20', colocadorId: String(col) });
  assert.equal(r.data.tareas, 3, JSON.stringify(r.data)); assert.equal(r.data.total, 30000);
  assert.equal(r.data.liquidaciones.length, 1); assert.equal(r.data.liquidaciones[0].total, 30000); assert.equal(r.data.liquidaciones[0].colocadorId, String(col));
  { const pr = await api('POST', '/api/sueldos/colocadores/liquidaciones/' + r.data.liquidaciones[0].id + '/pagos', { monto: 30000, fecha: '2026-11-27', cuentaTipo: 'caja', cuentaId: String(h.ids.caja) });
    assert.equal(pr.status, 200, JSON.stringify(pr.data)); assert.equal(pr.data.estado, 'pagada', 'liquidar y pagar de una vez: ' + JSON.stringify(pr.data)); }
  r = await api('POST', '/api/sueldos/colocadores/liquidar', { periodo: '2026-11', tipo: 'parcial', hasta: '2026-11-20' }); assert.equal(r.data.tareas, 0, 'no liquida dos veces');
  console.log('OK'); await h.stop();
})().catch(e => { console.error(e); process.exit(1); }).then(() => segundo());
function segundo(){
// Vista "Todas las sucursales" operando con otra sucursal: tiene que liquidar igual a los colocadores asignados a su propia sucursal.
(async () => {
  const h = await start(4164, { replSet: true }); const { db, ORG } = h; const { ObjectId } = require('mongodb');
  const OTRA = new ObjectId(), col = new ObjectId();
  await db.collection('obras_colocadores').insertOne({ _id: col, nombre: 'Carlos', orgId: OTRA, sucursalSueldoId: OTRA });
  await db.collection('obras').insertOne({ _id: new ObjectId(), orgId: OTRA, numero: 1, cliente: { nombre: 'X' }, estado: 'terminada', tareas: [{ _id: new ObjectId(), estado: 'terminada', colocadorId: col, tipoTrabajo: 'Placa', m2Presupuestados: 10, costoPorM2Aplicado: 1000, fechaFinReal: new Date('2026-11-18T15:00:00-03:00') }] });
  const r = await fetch('http://localhost:4164/api/sueldos/colocadores/liquidar', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-org-id': 'todas', 'x-org-operar': String(ORG) }, body: JSON.stringify({ periodo: '2026-11', tipo: 'parcial', hasta: '2026-11-20' }) });
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d)); assert.equal(d.tareas, 1, 'liquida aunque se opere con otra sucursal: ' + JSON.stringify(d));
  const liq = await db.collection('sueldos_colocadores').findOne({}); assert.equal(String(liq.orgId), String(OTRA), 'queda en la sucursal del colocador');
  console.log('OK2'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
}
