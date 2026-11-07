// Contacto de Azuite sin conversación: se le crea una vacía para poder moverlo de etapa (7/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4154); const { db, api, ORG } = h;
  const opId = (await db.collection('oportunidades').insertOne({ orgId: ORG, estado: 'activa', origen: 'azuite', numero: 9, cliente: { nombre: 'Nacho', telefono: '+5491155783198' }, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') })).insertedId;
  let r = await api('GET', '/api/mesa'); const it = r.data.items.find(i => i.opId === String(opId)); assert(it && !it.convId);
  r = await api('POST', '/api/mesa/materializar', { opId: String(opId) }); assert.equal(r.status, 200, JSON.stringify(r.data)); const convId = r.data.convId;
  const r2 = await api('POST', '/api/mesa/materializar', { opId: String(opId) }); assert.equal(r2.data.convId, convId, 'no duplica');
  r = await api('POST', `/api/mesa/${convId}/mover`, { columna: 'cerrando' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('GET', '/api/mesa'); const it2 = r.data.items.filter(i => i.opId === String(opId)); assert.equal(it2.length, 1, 'un solo item'); assert.equal(it2[0].convId, convId); assert.equal(it2[0].nombre, 'Nacho');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
