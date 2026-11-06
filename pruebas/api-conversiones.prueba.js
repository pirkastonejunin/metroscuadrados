// API de conversiones de Meta (6/11/2026): solo chats de anuncio, un evento por chat y tipo, Purchase con monto, nada se manda si está desactivada.
const assert = require('assert'); const { start } = require('./harness');
process.env.WA_TOKEN = 'token-de-prueba'; process.env.WA_WABA_ID = '103317782744150'; process.env.WA_GRAPH_BASE = 'https://graph.test';
(async () => {
  const h = await start(4145); const { db, api, ORG } = h; const capi = require('../capi');
  const llamadas = []; const fetchOrig = global.fetch;
  global.fetch = async (url, op) => { if (!String(url).startsWith('https://graph.test')) return fetchOrig(url, op); llamadas.push({ url: String(url), op });
    if (String(url).endsWith('/dataset')) return { ok: true, status: 200, json: async () => ({ id: '999000111' }) };
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) }; };
  const C = db.collection('wa_conversaciones');
  const mk = async (tel, referral) => { const _id = (await C.insertOne({ orgId: ORG, tel, tel10: tel.slice(-10), estado: 'derivado', datos: {}, createdAt: new Date(), updatedAt: new Date(), ...(referral ? { referral } : {}) })).insertedId; return C.findOne({ _id }); };
  const anuncio = await mk('5492365000001', { ctwa_clid: 'CLID-ABC', headline: 'Pisos' }), organico = await mk('5492365000002', null);

  assert.equal((await capi.enviar(db, anuncio, 'LeadSubmitted')).motivo, 'desactivado'); assert.equal(llamadas.length, 0, 'desactivada: no se manda nada');
  let r = await api('PUT', '/api/bot/capi', { activo: true }); assert.equal(r.status, 409, 'no se activa sin conjunto de datos');
  r = await api('POST', '/api/bot/capi/preparar', {}); assert.equal(r.data.ok, true, JSON.stringify(r.data)); assert.equal(r.data.datasetId, '999000111'); assert(llamadas[0].url.endsWith('/103317782744150/dataset'));
  r = await api('PUT', '/api/bot/capi', { activo: true, codigoPrueba: 'TEST123' }); assert.equal(r.status, 200);

  llamadas.length = 0;
  assert.equal((await capi.enviar(db, organico, 'LeadSubmitted')).motivo, 'no vino de un anuncio'); assert.equal(llamadas.length, 0);
  assert.equal((await capi.enviar(db, anuncio, 'LeadSubmitted')).ok, true); assert.equal(llamadas.length, 1);
  const b = JSON.parse(llamadas[0].op.body); assert(llamadas[0].url.endsWith('/999000111/events')); assert.equal(b.test_event_code, 'TEST123');
  assert.deepEqual(b.data[0].user_data, { whatsapp_business_account_id: '103317782744150', ctwa_clid: 'CLID-ABC' }); assert.equal(b.data[0].action_source, 'business_messaging'); assert.equal(b.data[0].messaging_channel, 'whatsapp'); assert.equal(b.data[0].event_name, 'LeadSubmitted');
  assert.equal(llamadas[0].op.headers.Authorization, 'Bearer token-de-prueba');
  assert.equal((await capi.enviar(db, anuncio, 'LeadSubmitted')).motivo, 'ya enviado'); assert.equal(llamadas.length, 1, 'no se repite');
  assert.equal((await capi.enviar(db, anuncio, 'Purchase')).motivo, 'sin monto'); assert.equal(llamadas.length, 1);
  assert.equal((await capi.enviar(db, anuncio, 'Purchase', { valor: 125000, moneda: 'ARS' })).ok, true);
  const p = JSON.parse(llamadas[1].op.body).data[0]; assert.deepEqual(p.custom_data, { currency: 'ARS', value: 125000 });
  r = await api('GET', '/api/bot/capi'); assert.equal(r.data.activo, true); assert.equal(r.data.chatsDeAnuncio, 1); assert(r.data.eventos.length >= 3);
  // venta ganada desde el CRM → Purchase con el monto del presupuesto de la conversación
  const g = await mk('5492365000003', { ctwa_clid: 'CLID-XYZ' });
  await db.collection('presupuestos').insertOne({ orgId: ORG, origenBot: { convId: g._id }, total: 80000, moneda: 'ARS', createdAt: new Date() });
  llamadas.length = 0; r = await api('POST', `/api/mesa/${g._id}/decidir`, { tipo: 'ganada' }); assert.equal(r.status, 200, JSON.stringify(r.data)); await new Promise(ok => setTimeout(ok, 400));
  assert(llamadas.some(c => /\/events$/.test(c.url) && JSON.parse(c.op.body).data[0].custom_data.value === 80000), 'se informó la venta con su monto');
  // un fallo de Meta queda registrado y no rompe nada
  global.fetch = async (url, op) => String(url).startsWith('https://graph.test') ? { ok: false, status: 400, json: async () => ({ error: { message: 'ctwa_clid inválido' } }) } : fetchOrig(url, op);
  const x = await mk('5492365000004', { ctwa_clid: 'MAL' }); assert.equal((await capi.enviar(db, x, 'LeadSubmitted')).ok, false);
  const fila = await db.collection('capi_eventos').findOne({ convId: x._id }); assert(/ctwa_clid inválido/.test(fila.error));
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
