// Cierre en bloque de conversaciones viejas sin atender (6/11/2026).
const assert = require('assert'); const { start } = require('./harness'); const { ObjectId } = require('mongodb');
(async () => {
  const h = await start(4143); const { db, api, ORG } = h; const C = db.collection('wa_conversaciones'), M = db.collection('wa_mensajes');
  const dia = n => new Date(Date.now() - n * 86400000);
  const mk = async (tel, dias, asesor) => { const _id = (await C.insertOne({ orgId: ORG, tel, tel10: tel.slice(-10), estado: 'derivado', datos: {}, createdAt: dia(dias + 1), updatedAt: dia(dias) })).insertedId;
    await M.insertOne({ orgId: ORG, convId: _id, waId: 'w' + tel, dir: 'in', origen: 'cliente', texto: 'hola', at: dia(dias) });
    if (asesor) await M.insertOne({ orgId: ORG, convId: _id, waId: 'a' + tel, dir: 'out', origen: 'asesor', texto: 'te escribo', at: dia(dias) }); return _id; };
  const vieja = await mk('5492361000001', 20), vieja2 = await mk('5492361000002', 30), atendida = await mk('5492361000003', 25, true), nueva = await mk('5492361000004', 2);
  const op = async (tel, dias, extra) => (await db.collection('oportunidades').insertOne(Object.assign({ orgId: ORG, estado: 'activa', origen: 'azuite', cliente: { nombre: 'C' + tel, telefono: tel }, createdAt: dia(dias), updatedAt: dia(dias) }, extra))).insertedId;
  const opVieja = await op('5492362000001', 20), opNueva = await op('5492362000002', 3), opConVend = await op('5492362000003', 20, { vendedorId: new ObjectId() }), opConConv = await op('5492361000001', 20);
  let r = await api('POST', '/api/mesa/cierre-masivo', { dias: 15 }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.vistaPrevia, true); assert.equal(r.data.total, 4); assert.equal(r.data.aCerrar, 2); assert.equal(r.data.atendidas, 1); assert.equal(r.data.contactos, 1, 'solo el contacto viejo, sin vendedor y sin conversación');
  assert.equal(await C.countDocuments({ 'mesa.cierre': { $exists: true, $ne: null } }), 0, 'la vista previa no cambia nada');
  r = await api('POST', '/api/mesa/cierre-masivo', { dias: 15, confirmar: true }); assert.equal(r.data.cerradas, 2); assert.equal(r.data.contactos, 1);
  const OP = db.collection('oportunidades'); assert.equal((await OP.findOne({ _id: opVieja })).estado, 'descartada'); for (const i of [opNueva, opConVend, opConConv]) assert.equal((await OP.findOne({ _id: i })).estado, 'activa');
  for (const [id, ok] of [[vieja, true], [vieja2, true], [atendida, false], [nueva, false]]) assert.equal(!!(await C.findOne({ _id: id })).mesa && !!(await C.findOne({ _id: id })).mesa.cierre, ok);
  r = await api('POST', `/api/mesa/${vieja}/reabrir`, {}); assert.equal(r.status, 200, 'se puede reabrir una por una');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
