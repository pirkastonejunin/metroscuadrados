// ---------------------------------------------------------------------------
// Bot de WhatsApp propio (reemplaza al agente de Azuite/Vulcano). Recibe los mensajes por el webhook de la API de WhatsApp (Meta),
// los guarda, y si la conversación está en manos del bot contesta con IA (prompt en bot-prompt.md): califica al cliente (máx. 3 preguntas)
// y lo deriva a un asesor. Cuando un asesor escribe desde el celular (coexistencia: Meta avisa esos mensajes como "echoes") o desde
// el sistema, el bot deja de contestar en esa conversación.
// Estados de la conversación: 'bot' (contesta el bot) | 'derivado' (ofreció asesor, falta que acepte) | 'aceptado' (el cliente aceptó:
// el bot ya no escribe, salvo un aviso de horario cada 6 h) | 'humano' (un asesor tomó la conversación) | 'pausado'.
// Variables de entorno: WA_VERIFY_TOKEN (para el alta del webhook en Meta), META_APP_SECRET (firma de los avisos), WA_TOKEN (token
// permanente del usuario del sistema), WA_PHONE_ID (id del número), BOT_ORG_ID (sucursal; si no, AZUITE_ORG_ID), BOT_ACTIVO ('0' lo apaga),
// GEMINI_API_KEY / BOT_MODELO / BOT_PROVEEDOR, WA_GRAPH_VERSION. Sin WA_TOKEN funciona en "modo prueba": guarda lo que enviaría y no manda nada.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const leads = require('./leads');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db(DB_NAME); }
const auth = [authUsuario, resolverOrg, requiereModulo('visitas')];
const COL_C = 'wa_conversaciones', COL_M = 'wa_mensajes';
const digitos = (s) => String(s || '').replace(/\D/g, '');
const orgBot = () => { const v = process.env.BOT_ORG_ID || process.env.AZUITE_ORG_ID || ''; return /^[0-9a-f]{24}$/i.test(v) ? new ObjectId(v) : null; };
const graph = () => process.env.WA_GRAPH_BASE || ('https://graph.facebook.com/' + (process.env.WA_GRAPH_VERSION || 'v23.0'));

// ---- horario comercial (hora de Argentina, UTC-3 todo el año) ----
function ahoraAR(d) { return new Date((d || new Date()).getTime() - 3 * 3600 * 1000); }
function abierto(d) {
  const a = ahoraAR(d), dia = a.getUTCDay(), min = a.getUTCHours() * 60 + a.getUTCMinutes();
  if (dia >= 1 && dia <= 5) return min >= 8 * 60 && min < 16 * 60;
  if (dia === 6) return min >= 8 * 60 + 30 && min < 12 * 60 + 30;
  return false;
}
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// ---- IA ----
const ESQUEMA = {
  type: 'object',
  properties: {
    respuesta: { type: 'string', description: 'Mensaje para el cliente. Vacío si no corresponde escribir.' },
    derivar: { type: 'boolean', description: 'true en el turno en que se ofrece/pide derivar a un asesor.' },
    aceptoAsesor: { type: 'boolean', description: 'true cuando el cliente aceptó que lo atienda un asesor.' },
    producto: { type: 'string' }, medidas: { type: 'string' }, estilo: { type: 'string' },
    resumen: { type: 'string', description: 'Resumen de una línea de lo que necesita el cliente, para el asesor.' },
    etiquetas: { type: 'array', items: { type: 'string' } },
    transcripcion: { type: 'string', description: 'Si el último mensaje del cliente fue un audio: lo que dice, textual.' }
  },
  required: ['respuesta', 'derivar', 'aceptoAsesor']
};
function promptArchivo() { try { return fs.readFileSync(path.join(__dirname, 'bot-prompt.md'), 'utf8'); } catch (e) { return 'Sos el asistente virtual de Piedra Negra.'; } }
let cachePrompt = { t: 0, v: null };
async function promptBase() { // el texto editado desde la pantalla (base de datos) manda sobre el del archivo
  if (Date.now() - cachePrompt.t < 30000) return cachePrompt.v || promptArchivo();
  try { const d = await (await getDb()).collection('bot_config').findOne({ _id: 'prompt' }); cachePrompt = { t: Date.now(), v: d && d.texto ? d.texto : null }; } catch (e) { cachePrompt = { t: Date.now(), v: null }; }
  return cachePrompt.v || promptArchivo();
}
async function promptSistema(base) {
  if (base == null) base = await promptBase();
  const a = ahoraAR();
  return base + '\n\nContexto actual: hoy es ' + DIAS[a.getUTCDay()] + ' ' + a.toISOString().slice(11, 16) + ' hs (Argentina). La atención humana está ' + (abierto() ? 'ABIERTA ahora.' : 'CERRADA ahora (un asesor responderá en el próximo horario de atención).') +
    '\nRespondé SIEMPRE con el JSON pedido. En "respuesta" va únicamente el mensaje para el cliente.';
}
async function pedir(url, op, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 45000);
  try { return await fetch(url, Object.assign({}, op, { signal: c.signal })); } finally { clearTimeout(t); }
}
function jsonDe(t) {
  const l = String(t || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(l); } catch (e) { const i = l.indexOf('{'), j = l.lastIndexOf('}'); if (i >= 0 && j > i) { try { return JSON.parse(l.slice(i, j + 1)); } catch (e2) { /* nada */ } } return null; }
}
// historial: [{role:'user'|'model', text, media?:{mime,data(base64)}}]
async function llamarIA(historial, promptBaseTexto) {
  const prov = String(process.env.BOT_PROVEEDOR || '').toLowerCase() || (process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic');
  const sistema = await promptSistema(promptBaseTexto);
  if (prov === 'gemini') {
    const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('Falta GEMINI_API_KEY');
    const modelo = process.env.BOT_MODELO || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const r = await pedir((process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta') + '/models/' + encodeURIComponent(modelo) + ':generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents: historial.map(m => ({ role: m.role, parts: [{ text: m.text || '(sin texto)' }].concat(m.media ? [{ inlineData: { mimeType: m.media.mime, data: m.media.data } }] : []) })),
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: ESQUEMA, temperature: 0.4 }
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('IA ' + r.status + ': ' + ((d.error && d.error.message) || ''));
    const c = (d.candidates || [])[0];
    return jsonDe(c && c.content && c.content.parts ? c.content.parts.map(x => x.text || '').join('') : '');
  }
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('Falta ANTHROPIC_API_KEY');
  const r = await pedir('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.BOT_MODELO || 'claude-haiku-4-5-20251001', max_tokens: 800, system: sistema + '\nEl JSON debe tener: respuesta, derivar, aceptoAsesor, producto, medidas, estilo, resumen, etiquetas.',
      messages: historial.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.media && /^image\//.test(m.media.mime) ? [{ type: 'image', source: { type: 'base64', media_type: m.media.mime, data: m.media.data } }, { type: 'text', text: m.text || '(foto)' }] : (m.text || '(sin texto)') })) })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('IA ' + r.status + ': ' + ((d.error && d.error.message) || ''));
  return jsonDe((d.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
}

// ---- WhatsApp (Meta) ----
async function enviarTexto(tel, texto) {
  if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return { id: 'prueba-' + crypto.randomBytes(6).toString('hex'), prueba: true };
  const r = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: tel, type: 'text', text: { body: texto, preview_url: true } }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('WhatsApp ' + r.status + ': ' + ((d.error && d.error.message) || ''));
  return { id: d.messages && d.messages[0] && d.messages[0].id };
}
async function bajarMedia(mediaId) {
  if (!process.env.WA_TOKEN || !mediaId) return null;
  try {
    const h = { Authorization: 'Bearer ' + process.env.WA_TOKEN };
    const m = await (await pedir(graph() + '/' + mediaId, { headers: h }, 20000)).json();
    if (!m.url) return null;
    const r = await pedir(m.url, { headers: h }, 30000); const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 12 * 1024 * 1024) return null;
    return { mime: String(m.mime_type || r.headers.get('content-type') || '').split(';')[0], data: buf.toString('base64') };
  } catch (e) { return null; }
}

// ---- conversaciones ----
async function guardarMensaje(db, conv, m) {
  try { await db.collection(COL_M).insertOne(Object.assign({ orgId: conv.orgId, convId: conv._id }, m)); return true; }
  catch (e) { if (e.code === 11000) return false; throw e; }
}
async function convDe(db, orgId, tel, nombre, referral) {
  const t10 = digitos(tel).slice(-10); const ahora = new Date();
  const set = { updatedAt: ahora }; if (nombre) set.nombre = nombre;
  const ins = { orgId, tel: digitos(tel), tel10: t10, estado: 'bot', datos: {}, createdAt: ahora };
  if (referral) ins.referral = referral;
  const r = await db.collection(COL_C).findOneAndUpdate({ orgId, tel10: t10 }, { $set: set, $setOnInsert: ins }, { upsert: true, returnDocument: 'after' });
  return r && r.value !== undefined ? r.value : r;
}
const textoDe = (m) => m.type === 'text' ? (m.text && m.text.body) || '' : m.type === 'button' ? (m.button && m.button.text) || '' : m.type === 'interactive' ? ((m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) || (m.interactive.list_reply && m.interactive.list_reply.title))) || '') : (m[m.type] && m[m.type].caption) || '';
const mediaIdDe = (m) => (m.type === 'audio' || m.type === 'image') && m[m.type] ? m[m.type].id : null;

const timers = new Map(), ocupadas = new Set();
function programar(convId, orgId) {
  const k = String(convId); clearTimeout(timers.get(k));
  timers.set(k, setTimeout(() => { timers.delete(k); responder(orgId, convId).catch(e => console.error('[bot]', e.message)); }, Number(process.env.BOT_ESPERA_MS != null ? process.env.BOT_ESPERA_MS : 4000)));
}

async function responder(orgId, convId) {
  const k = String(convId); if (ocupadas.has(k)) { programar(convId, orgId); return; } ocupadas.add(k);
  try {
    const db = await getDb(); const conv = await db.collection(COL_C).findOne({ _id: convId });
    if (!conv || process.env.BOT_ACTIVO === '0' || ['humano', 'pausado'].includes(conv.estado)) return;
    const msgs = await db.collection(COL_M).find({ convId }).sort({ at: 1 }).toArray();
    const ultimoIn = [...msgs].reverse().find(m => m.dir === 'in'); if (!ultimoIn) return;
    if (ultimoIn.respondido) return;
    // cliente que ya aceptó al asesor: el bot no escribe, salvo un aviso de horario (máx. 1 cada 6 h)
    if (conv.estado === 'aceptado') {
      await db.collection(COL_M).updateOne({ _id: ultimoIn._id }, { $set: { respondido: true } });
      if (!conv.avisoAt || Date.now() - new Date(conv.avisoAt).getTime() > 6 * 3600 * 1000) {
        const txt = abierto() ? 'Ya avisamos a un asesor, te va a atender a la brevedad. ¡Gracias por la paciencia!' : 'Un asesor te va a atender a la brevedad dentro del horario comercial (lunes a viernes de 8 a 16 y sábados de 8:30 a 12:30 hs). ¡Gracias!';
        const env = await enviarTexto(conv.tel, txt); await guardarMensaje(db, conv, { waId: env.id, dir: 'out', origen: 'bot', tipo: 'text', texto: txt, at: new Date() });
        await db.collection(COL_C).updateOne({ _id: convId }, { $set: { avisoAt: new Date() } });
      }
      return;
    }
    const hist = []; const recientes = msgs.slice(-24);
    for (const m of recientes) {
      const role = m.dir === 'in' ? 'user' : 'model';
      const item = { role, text: m.texto || (m.tipo === 'audio' ? '(audio del cliente)' : m.tipo === 'image' ? '(foto del cliente)' : '') };
      if (m._id.equals(ultimoIn._id) && m.mediaId) item.media = await bajarMedia(m.mediaId);
      if (hist.length && hist[hist.length - 1].role === role) { hist[hist.length - 1].text += '\n' + item.text; if (item.media) hist[hist.length - 1].media = item.media; } else hist.push(item);
    }
    if (hist[0] && hist[0].role === 'model') hist.unshift({ role: 'user', text: '(inicio de la conversación)' });
    const r = await llamarIA(hist);
    if (!r) throw new Error('La IA no devolvió un JSON válido');
    await db.collection(COL_M).updateOne({ _id: ultimoIn._id }, { $set: Object.assign({ respondido: true }, r.transcripcion ? { texto: '🎤 ' + r.transcripcion } : {}) });
    // el estado pudo cambiar mientras pensaba la IA (un asesor tomó la conversación): no pisarlo ni escribir
    const fresco = await db.collection(COL_C).findOne({ _id: convId });
    if (!fresco || ['humano', 'pausado'].includes(fresco.estado)) return;
    const txt = String(r.respuesta || '').trim();
    if (txt) { const env = await enviarTexto(conv.tel, txt); await guardarMensaje(db, conv, { waId: env.id, dir: 'out', origen: 'bot', tipo: 'text', texto: txt, at: new Date(), prueba: !!env.prueba }); }
    const set = { updatedAt: new Date(), datos: { producto: r.producto || (conv.datos || {}).producto || '', medidas: r.medidas || (conv.datos || {}).medidas || '', estilo: r.estilo || (conv.datos || {}).estilo || '' } };
    if (r.resumen) set.resumen = r.resumen;
    if (r.aceptoAsesor) set.estado = 'aceptado'; else if (r.derivar && conv.estado === 'bot') set.estado = 'derivado';
    if (set.estado === 'aceptado') set.avisoAt = new Date();
    await db.collection(COL_C).updateOne({ _id: convId }, { $set: set });
    await actualizarLead(db, Object.assign({}, conv, set), (r.etiquetas || []));
  } finally { ocupadas.delete(k); }
}

async function actualizarLead(db, conv, etiquetas) {
  const ref = conv.referral || {};
  const l = { telefono: conv.tel, tel10: conv.tel10, nombre: conv.nombre || '', email: '', canal: 'WhatsApp', estadoOrigen: '', etiquetasOrigen: etiquetas.map(String).slice(0, 8),
    fuente: ref.source_id || ref.headline ? 'Meta Ads' : 'Directo', utmSource: ref.source_type === 'ad' ? 'facebook' : '', utmMedium: ref.source_type === 'ad' ? 'ad' : '',
    campana: ref.headline || '', anuncio: ref.source_id || '', resumen: conv.resumen || '', notasOrigen: '' };
  await leads.guardarLeads(db, conv.orgId, [l], 'bot');
}

// ---- webhook de Meta ----
router.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && process.env.WA_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  res.sendStatus(403);
});
function firmaOk(raw, header) {
  const sec = process.env.META_APP_SECRET; if (!sec || !raw) return false;
  const esp = 'sha256=' + crypto.createHmac('sha256', sec).update(raw).digest('hex'); const h = String(header || '');
  return esp.length === h.length && crypto.timingSafeEqual(Buffer.from(esp), Buffer.from(h));
}
router.post('/webhook', async (req, res) => {
  if (!firmaOk(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(process.env.META_APP_SECRET ? 401 : 503);
  res.sendStatus(200); // Meta reintenta si tardamos: se responde ya y se procesa después
  try { await procesarEvento(req.body); } catch (e) { console.error('[bot] webhook:', e.message); }
});
async function procesarEvento(body) {
  const orgId = orgBot(); if (!orgId) { console.error('[bot] falta BOT_ORG_ID'); return; }
  const db = await getDb();
  for (const ent of (body && body.entry) || []) for (const ch of ent.changes || []) {
    const v = ch.value || {}; if (!v.messages && !v.message_echoes) continue;
    const nombres = new Map((v.contacts || []).map(c => [digitos(c.wa_id), c.profile && c.profile.name]));
    for (const m of v.messages || []) {
      const conv = await convDe(db, orgId, m.from, nombres.get(digitos(m.from)), m.referral);
      const ok = await guardarMensaje(db, conv, { waId: m.id, dir: 'in', origen: 'cliente', tipo: m.type, texto: textoDe(m), mediaId: mediaIdDe(m), at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() });
      if (ok) programar(conv._id, orgId);
    }
    // mensajes que un asesor mandó desde la app del celular (coexistencia): el bot deja de contestar en esa conversación
    for (const m of v.message_echoes || []) {
      const conv = await convDe(db, orgId, m.to, null, null);
      const ok = await guardarMensaje(db, conv, { waId: m.id, dir: 'out', origen: 'asesor', tipo: m.type, texto: textoDe(m), at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() });
      if (ok) await db.collection(COL_C).updateOne({ _id: conv._id }, { $set: { estado: 'humano', humanoAt: new Date() } });
    }
  }
}

// ---- API para la pantalla ----
router.get('/conversaciones', auth, async (req, res) => {
  try {
    const db = await getDb(); const m = Object.assign({}, filtroOrg(req)); if (req.query.estado) m.estado = req.query.estado;
    const items = await db.collection(COL_C).find(m).sort({ updatedAt: -1 }).limit(200).toArray();
    res.json({ items, botActivo: process.env.BOT_ACTIVO !== '0', modoPrueba: !(process.env.WA_TOKEN && process.env.WA_PHONE_ID) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
async function convDeReq(db, req) {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return null;
  return db.collection(COL_C).findOne(Object.assign({ _id: new ObjectId(req.params.id) }, filtroOrg(req)));
}
router.get('/conversaciones/:id', auth, async (req, res) => {
  try { const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    res.json({ conversacion: c, mensajes: await db.collection(COL_M).find({ convId: c._id }).sort({ at: 1 }).limit(500).toArray() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/conversaciones/:id/estado', auth, async (req, res) => {
  try { const est = req.body && req.body.estado; if (!['bot', 'derivado', 'aceptado', 'humano', 'pausado'].includes(est)) return res.status(400).json({ error: 'Estado inválido.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: est, updatedAt: new Date() } }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/conversaciones/:id/enviar', auth, async (req, res) => { // un asesor escribe desde el sistema: el bot queda afuera
  try { const texto = String((req.body && req.body.texto) || '').trim().slice(0, 4000); if (!texto) return res.status(400).json({ error: 'Escribí un mensaje.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const env = await enviarTexto(c.tel, texto);
    await guardarMensaje(db, c, { waId: env.id, dir: 'out', origen: 'asesor', tipo: 'text', texto, at: new Date(), prueba: !!env.prueba });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: 'humano', humanoAt: new Date(), updatedAt: new Date() } }); res.json({ ok: true, prueba: !!env.prueba });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- prueba del bot sin WhatsApp: corre el mismo motor de IA sobre una conversación simulada (no guarda nada ni envía mensajes) ----
const soloAdmin = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador puede cambiar las instrucciones del bot.' });
router.post('/simular', auth, async (req, res) => {
  try {
    const b = req.body || {}; const ms = Array.isArray(b.mensajes) ? b.mensajes.slice(-30) : [];
    if (!ms.length || ms[ms.length - 1].role !== 'user') return res.status(400).json({ error: 'Falta el mensaje del cliente.' });
    const hist = ms.map(m => ({ role: m.role === 'model' ? 'model' : 'user', text: String(m.text || '').slice(0, 4000), media: m.media && m.media.data && /^(image|audio)\//.test(m.media.mime || '') && String(m.media.data).length < 12e6 ? { mime: m.media.mime, data: m.media.data } : undefined }));
    if (hist[0].role === 'model') hist.unshift({ role: 'user', text: '(inicio de la conversación)' });
    const r = await llamarIA(hist, typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt : undefined);
    if (!r) return res.status(502).json({ error: 'La IA no devolvió una respuesta válida. Probá de nuevo.' });
    res.json({ respuesta: r.respuesta || '', derivar: !!r.derivar, aceptoAsesor: !!r.aceptoAsesor, producto: r.producto || '', medidas: r.medidas || '', estilo: r.estilo || '', resumen: r.resumen || '', etiquetas: r.etiquetas || [], transcripcion: r.transcripcion || '' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
router.get('/prompt', auth, async (req, res) => {
  try { const d = await (await getDb()).collection('bot_config').findOne({ _id: 'prompt' }); res.json({ texto: d && d.texto ? d.texto : promptArchivo(), personalizado: !!(d && d.texto), original: promptArchivo() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/prompt', auth, soloAdmin, async (req, res) => { // guarda las instrucciones editadas ('' = volver al texto original del sistema)
  try { const t = String((req.body && req.body.texto) || '').trim().slice(0, 20000); const col = (await getDb()).collection('bot_config');
    if (!t) await col.deleteOne({ _id: 'prompt' }); else await col.updateOne({ _id: 'prompt' }, { $set: { texto: t, actualizado: new Date(), por: req.usuario.usuario || req.usuario.nombre || '' } }, { upsert: true });
    cachePrompt = { t: 0, v: null }; res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

(async () => { try { const db = await getDb(); await db.collection(COL_M).createIndex({ waId: 1 }, { unique: true, sparse: true }); await db.collection(COL_C).createIndex({ orgId: 1, tel10: 1 }, { unique: true }); await db.collection(COL_M).createIndex({ convId: 1, at: 1 }); } catch (e) { /* sin base al arrancar */ } })();

module.exports = router;
module.exports.abierto = abierto;
module.exports.procesarEvento = procesarEvento;
