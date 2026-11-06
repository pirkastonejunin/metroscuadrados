// Números internos (6/11/2026): lo que escriben compañeros/proveedores no entra al CRM, el bot no contesta y no se gasta IA.
const assert = require('assert'); const http = require('http'); const crypto = require('crypto');
process.env.META_APP_SECRET = 'secreto-prueba'; process.env.BOT_ACTIVO = '0';
const { start } = require('./harness');
(async () => {
  const h = await start(4142); const { db, api, ORG } = h; process.env.BOT_ORG_ID = String(ORG);
  const hook = (body) => new Promise((ok, ko) => { const raw = JSON.stringify(body); const sig = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(raw).digest('hex');
    const rq = http.request({ host: 'localhost', port: 4142, path: '/api/bot/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig, 'Content-Length': Buffer.byteLength(raw) } }, r => { r.resume(); r.on('end', () => setTimeout(ok, 300)); }); rq.on('error', ko); rq.end(raw); });
  const msg = (from, id, extra) => ({ entry: [{ changes: [{ value: Object.assign({ contacts: [{ wa_id: from, profile: { name: 'X' } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } }] }, extra) }] }] });
  const total = () => db.collection('wa_conversaciones').countDocuments({ orgId: ORG });

  await hook(msg('5492364111111', 'wamid.1')); assert.equal(await total(), 1, 'un cliente común entra');
  let r = await api('PUT', '/api/bot/internos', { items: [{ tel: '+54 9 236 4222222', nombre: 'Proveedor Juan' }, { tel: '123' }, { tel: '5492364222222' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.items.length, 1, 'se descartan inválidos y repetidos');
  await hook(msg('5492364222222', 'wamid.2')); assert.equal(await total(), 1, 'el interno no crea conversación');
  assert.equal(await db.collection('wa_mensajes').countDocuments({ waId: 'wamid.2' }), 0);
  await hook({ entry: [{ changes: [{ value: { message_echoes: [{ to: '5492364222222', id: 'wamid.3', type: 'text', text: { body: 'ok' }, timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] }); assert.equal(await total(), 1, 'lo que escribís desde el celular al interno tampoco');
  await hook(msg('5492364333333', 'wamid.4')); assert.equal(await total(), 2);

  // marcar desde un chat: se oculta y queda en la lista
  const c = await db.collection('wa_conversaciones').findOne({ orgId: ORG, tel10: '2364333333' });
  r = await api('POST', `/api/bot/conversaciones/${c._id}/interno`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('GET', '/api/bot/conversaciones'); assert.equal(r.data.items.length, 1, 'la marcada como interna no aparece');
  r = await api('GET', '/api/bot/internos'); assert.equal(r.data.items.length, 2);
  await hook(msg('5492364333333', 'wamid.5')); assert.equal(await db.collection('wa_mensajes').countDocuments({ waId: 'wamid.5' }), 0);
  // quitar de la lista: vuelve a aparecer
  r = await api('PUT', '/api/bot/internos', { items: [{ tel: '5492364222222' }] }); r = await api('GET', '/api/bot/conversaciones'); assert.equal(r.data.items.length, 2, 'al quitarla vuelve');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
