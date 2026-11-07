// Contactos importados del histórico (Pirka) sin fecha: se marcan "historica" para no ensuciar el tablero (7/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4153); const { db, api, ORG } = h;
  const op = async (tel, extra) => (await db.collection('oportunidades').insertOne(Object.assign({ orgId: ORG, estado: 'activa', origen: 'Histórico Pirka', importado: true, cliente: { nombre: 'C' + tel, telefono: tel }, createdAt: new Date() }, extra))).insertedId;
  const sinFecha = await op('5492361111111'), conFecha = await op('5492361111112', { proximaAccion: { fecha: new Date(Date.now() + 5 * 86400000), tipo: 'otro', nota: '' } }), manual = await op('5492361111113', { importado: false });
  const r = await api('GET', '/api/mesa'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const por = id => r.data.items.find(i => i.opId === String(id));
  assert.equal(por(sinFecha).historica, true); assert.equal(por(conFecha).historica, false); assert.equal(por(manual).historica, false);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
