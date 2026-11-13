// Cierre "Solo consulta" (13/11/2026) y columna Esperando cuando un asesor ya contestó.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4157); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const hace = d => new Date(Date.now() - d * 864e5);
  const mk = async (tel, nombre) => (await db.collection('wa_conversaciones').insertOne({ orgId: ORG, tel, tel10: tel.slice(-10), nombre, estado: 'humano', datos: {}, createdAt: hace(30), updatedAt: hace(30), mesa: {} })).insertedId;
  const c1 = await mk('5492364000001', 'Pregunta dirección'), c2 = await mk('5492364000002', 'Asesor ya contestó');
  await db.collection('wa_mensajes').insertMany([
    { convId: c1, orgId: ORG, dir: 'in', origen: 'cliente', texto: 'dónde están?', at: hace(2) },
    { convId: c2, orgId: ORG, dir: 'in', origen: 'cliente', texto: 'precio?', at: hace(10) }, { convId: c2, orgId: ORG, dir: 'out', origen: 'asesor', texto: 'te paso', at: hace(9) }
  ]);
  let r = await api('GET', '/api/mesa'); const it = id => r.data.items.find(i => i.convId === String(id));
  assert.equal(it(c2).columna, 'esperando', 'si el asesor contestó último, no queda en Hoy'); assert.equal(it(c1).columna, 'hoy');
  assert(r.data.motivosConsulta.includes('dirección'));
  r = await api('POST', `/api/mesa/${c1}/decidir`, { tipo: 'consulta' }); assert.equal(r.status, 400, 'pide el motivo');
  r = await api('POST', `/api/mesa/${c1}/decidir`, { tipo: 'consulta', motivo: 'dirección' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = await db.collection('wa_conversaciones').findOne({ _id: c1 }); assert.equal(c.mesa.cierre.estado, 'consulta'); assert.equal(c.mesa.cierre.motivo, 'dirección');
  r = await api('GET', '/api/mesa'); assert(!it(c1), 'sale del tablero');
  r = await api('GET', '/api/mesa?cerradas=1'); assert.equal(it(c1).cierre.estado, 'consulta');
  // si el cliente vuelve a escribir, reabre sola
  await db.collection('wa_mensajes').insertOne({ convId: c1, orgId: ORG, dir: 'in', origen: 'cliente', texto: 'gracias, y hasta qué hora?', at: new Date(Date.now() + 1000) });
  r = await api('GET', '/api/mesa'); assert(it(c1) && !it(c1).cierre, 'reabrió sola');
  // pulso: cambia cuando llega un mensaje
  const p1 = (await api('GET', '/api/mesa/pulso')).data.t; assert(p1);
  await db.collection('wa_mensajes').insertOne({ convId: c2, orgId: ORG, dir: 'in', origen: 'cliente', texto: 'hola?', at: new Date() });
  assert.notEqual((await api('GET', '/api/mesa/pulso')).data.t, p1, 'el pulso detecta el mensaje nuevo');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
