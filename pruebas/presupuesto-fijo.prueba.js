// "Presupuesto enviado" no vuelve a Hoy cuando el cliente escribe ni sin fecha; solo si hay una fecha puesta a propósito que ya llegó (6/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4144); const { db, api, ORG } = h; const C = db.collection('wa_conversaciones'), M = db.collection('wa_mensajes');
  const mk = async (tel, mesa) => { const _id = (await C.insertOne({ orgId: ORG, tel, tel10: tel.slice(-10), nombre: 'N' + tel, estado: 'derivado', datos: {}, createdAt: new Date(), updatedAt: new Date(), mesa })).insertedId;
    await M.insertOne({ orgId: ORG, convId: _id, waId: 'w' + tel, dir: 'in', origen: 'cliente', texto: 'hola, una consulta', at: new Date() }); return _id; };
  const presu = await mk('5492364000001', { etapa: 'presupuesto' });            // el cliente escribió y no hay fecha
  const presuFecha = await mk('5492364000002', { etapa: 'presupuesto', prox: { fecha: new Date(Date.now() - 86400000), nota: 'llamar', tipo: 'seguimiento' } }); // fecha puesta a propósito que ya llegó
  const presuFuturo = await mk('5492364000003', { etapa: 'presupuesto', prox: { fecha: new Date(Date.now() + 5 * 86400000), nota: 'llamar', tipo: 'seguimiento' } });
  const conv = await mk('5492364000004', { etapa: 'conversando' });             // las demás etapas siguen igual: el cliente escribió → Hoy
  let r = await api('GET', '/api/mesa'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const col = id => (r.data.items.find(i => i.convId === String(id)) || {}).columna;
  assert.equal(col(presu), 'presupuesto', 'el cliente escribió pero sigue en Presupuesto enviado'); assert.equal(col(presuFecha), 'hoy', 'llegó la fecha puesta a propósito');
  assert.equal(col(presuFuturo), 'presupuesto'); assert.equal(col(conv), 'hoy');
  // arrastrar a Presupuesto enviado no le pone fecha automática
  const otra = await mk('5492364000005', { etapa: 'conversando' });
  r = await api('POST', `/api/mesa/${otra}/mover`, { columna: 'presupuesto' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('GET', '/api/mesa'); const it = r.data.items.find(i => i.convId === String(otra)); assert.equal(it.columna, 'presupuesto'); assert.equal(it.prox, null);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
