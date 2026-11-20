// Colocadores: "Liquidar semana" liquida las tareas hasta la fecha elegida y avisa desde cuándo hay más (20/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4163); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const col = new ObjectId(); await db.collection('obras_colocadores').insertOne({ _id: col, nombre: 'Pepe', orgId: ORG });
  const mk = (n, dia) => ({ _id: new ObjectId(), orgId: ORG, numero: n, cliente: { nombre: 'C' + n }, estado: 'terminada', tareas: [{ _id: new ObjectId(), estado: 'terminada', colocadorId: col, tipoTrabajo: 'Placa', m2Presupuestados: 10, costoPorM2Aplicado: 1000, fechaFinReal: new Date(`2026-11-${dia}T15:00:00-03:00`) }] });
  await db.collection('obras').insertMany([mk(12, 18), mk(30, 19), mk(29, 20)]);
  let r = await api('POST', '/api/sueldos/colocadores/liquidar', { periodo: '2026-11', tipo: 'parcial', hasta: '2026-11-13' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.tareas, 0); assert.equal(r.data.proximaFecha, '2026-11-18');
  r = await api('POST', '/api/sueldos/colocadores/liquidar', { periodo: '2026-11', tipo: 'parcial', hasta: '2026-11-20', colocadorId: String(col) });
  assert.equal(r.data.tareas, 3, JSON.stringify(r.data)); assert.equal(r.data.total, 30000);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
