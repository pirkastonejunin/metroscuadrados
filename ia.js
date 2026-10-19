// ---------------------------------------------------------------------------
// Módulo único de IA (Fase 0 del vendedor digital, 19/10/2026). Todas las llamadas de texto a un modelo de lenguaje pasan por acá:
// el bot de WhatsApp y el asistente del sistema. (La lectura de facturas y el cotizador con imágenes siguen con su propio código por ahora.)
//
// Qué resuelve:
//  - Proveedor intercambiable: Gemini, Claude (Anthropic) u OpenAI, por variable de entorno y sin tocar el código.
//  - Respaldo automático: si el proveedor principal falla (error del servidor, límite de uso o sin conexión) prueba con otro que tenga clave.
//  - Registro de uso y costo estimado de cada llamada (colección ia_uso) y tope mensual en dólares.
//
// Variables de entorno (todas opcionales salvo las claves):
//   GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY   claves de cada proveedor
//   IA_PROVEEDOR      gemini | anthropic | openai (si no, el primero que tenga clave: gemini, anthropic, openai)
//   IA_MODELO_ANTHROPIC / IA_MODELO_OPENAI  modelo a usar cuando ese proveedor hace de respaldo (OpenAI exige indicarlo)
//   IA_FALLBACK       '0' desactiva el respaldo automático
//   IA_TOPE_USD_MES   tope mensual estimado en dólares (default 50; 0 = sin tope). Al llegar, el bot deriva a un asesor.
//   IA_AVISO_PCT      porcentaje del tope en el que se marca "aviso" (default 80)
//   IA_PRECIOS        JSON {"modelo":[usdEntradaPorMillon, usdSalidaPorMillon]} para corregir/sumar precios
//
// Ruta (/api/ia): GET /uso (solo administrador): gasto del mes, por uso y por proveedor, tope y últimos errores.
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const COL = 'ia_uso';
let mongoClient, mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(() => { mongoClient = nuevo; mongoConectando = null; }, (e) => { mongoConectando = null; throw e; });
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
const err = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

// ---- precios (USD por millón de tokens: [entrada, salida]) — son estimaciones para el control de gasto, no la factura del proveedor ----
const PRECIOS = {
  'gemini-3-flash': [0.5, 3], 'gemini-3.5-flash': [1.5, 9], 'gemini-3.6-flash': [0.75, 3.75], 'gemini-3.7-flash': [0.75, 3.75],
  'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.1-flash-lite': [0.25, 1.5], 'gemini-2.5-flash': [0.3, 2.5], 'gemini-2.5-flash-lite': [0.1, 0.4],
  'claude-haiku-4-5-20251001': [1, 5], 'claude-sonnet-5-5': [3, 15]
};
const PRECIO_DEFECTO = [1.5, 9]; // modelo desconocido: se estima por lo alto para no subestimar el gasto
function precioDe(modelo) {
  let extra = {}; try { extra = JSON.parse(process.env.IA_PRECIOS || '{}'); } catch (e) { /* ignora */ }
  const p = extra[modelo] || PRECIOS[modelo];
  return p ? { entrada: Number(p[0]), salida: Number(p[1]), estimado: false } : { entrada: PRECIO_DEFECTO[0], salida: PRECIO_DEFECTO[1], estimado: true };
}
function costoUsd(modelo, tin, tout) { const p = precioDe(modelo); return ((tin || 0) * p.entrada + (tout || 0) * p.salida) / 1e6; }

// ---- proveedores ----
const CLAVES = { gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
const tieneClave = (p) => !!process.env[CLAVES[p]];
function proveedorPrincipal(pedido) {
  const f = String(pedido || process.env.IA_PROVEEDOR || '').toLowerCase();
  if (CLAVES[f]) return f;
  return ['gemini', 'anthropic', 'openai'].find(tieneClave) || 'gemini';
}
function modeloDe(prov, op, esPrincipal) {
  if (esPrincipal && op.modelo) return op.modelo;
  const d = op.modelos || {};
  if (prov === 'gemini') return d.gemini || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  if (prov === 'anthropic') return d.anthropic || process.env.IA_MODELO_ANTHROPIC || 'claude-haiku-4-5-20251001';
  return d.openai || process.env.IA_MODELO_OPENAI || '';
}
async function pedir(url, opciones, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 45000);
  try { return await fetch(url, Object.assign({}, opciones, { signal: c.signal })); }
  catch (e) { throw err(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'La IA tardó demasiado en responder.' : 'No se pudo conectar con el servicio de IA.', { red: true }); }
  finally { clearTimeout(t); }
}
function falloHttp(r, d) {
  const detalle = (d && d.error && (d.error.message || (typeof d.error === 'string' ? d.error : ''))) || ('estado ' + r.status);
  return err(r.status, 'IA ' + r.status + ': ' + detalle, { detalle, http: r.status });
}

// mensajes: [{role:'user'|'model', text, media?:{mime,data(base64)}}]
async function viaGemini(op, modelo, key) {
  const base = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
  const gen = { temperature: op.temperatura == null ? 0.4 : op.temperatura };
  if (op.esquema) { gen.responseMimeType = 'application/json'; gen.responseJsonSchema = op.esquema; }
  const r = await pedir(base + '/models/' + encodeURIComponent(modelo) + ':generateContent', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: op.sistema }] },
      contents: op.mensajes.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text || '(sin texto)' }].concat(m.media ? [{ inlineData: { mimeType: m.media.mime, data: m.media.data } }] : []) })),
      generationConfig: gen
    })
  }, op.timeoutMs);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw falloHttp(r, d);
  const c = (d.candidates || [])[0], u = d.usageMetadata || {};
  return { texto: c && c.content && c.content.parts ? c.content.parts.map(x => x.text || '').join('') : '', tin: u.promptTokenCount || 0, tout: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
}
async function viaAnthropic(op, modelo, key) {
  const r = await pedir('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelo, max_tokens: op.maxTokens || 800, temperature: op.temperatura == null ? 0.4 : op.temperatura,
      system: op.sistema + (op.notaJson ? '\n' + op.notaJson : ''),
      messages: op.mensajes.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.media && /^image\//.test(m.media.mime) ? [{ type: 'image', source: { type: 'base64', media_type: m.media.mime, data: m.media.data } }, { type: 'text', text: m.text || '(foto)' }] : (m.text || '(sin texto)') }))
    })
  }, op.timeoutMs);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw falloHttp(r, d);
  const u = d.usage || {};
  return { texto: (d.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), tin: u.input_tokens || 0, tout: u.output_tokens || 0 };
}
async function viaOpenai(op, modelo, key) {
  if (!modelo) throw err(503, 'Para usar OpenAI hay que indicar el modelo en IA_MODELO (o IA_MODELO_OPENAI).', { sinClave: true });
  const r = await pedir((process.env.OPENAI_BASE || 'https://api.openai.com/v1') + '/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelo, temperature: op.temperatura == null ? 0.4 : op.temperatura, max_completion_tokens: op.maxTokens || 800,
      response_format: op.esquema ? { type: 'json_object' } : undefined,
      messages: [{ role: 'system', content: op.sistema + (op.esquema ? '\nRespondé solo con un objeto JSON. ' + (op.notaJson || '') : '') }].concat(op.mensajes.map(m => ({
        role: m.role === 'model' ? 'assistant' : 'user',
        content: m.media && /^image\//.test(m.media.mime) ? [{ type: 'image_url', image_url: { url: 'data:' + m.media.mime + ';base64,' + m.media.data } }, { type: 'text', text: m.text || '(foto)' }] : (m.text || '(sin texto)')
      })))
    })
  }, op.timeoutMs);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw falloHttp(r, d);
  const u = d.usage || {};
  return { texto: ((d.choices || [])[0] || {}).message ? String(d.choices[0].message.content || '') : '', tin: u.prompt_tokens || 0, tout: u.completion_tokens || 0 };
}
const VIAS = { gemini: viaGemini, anthropic: viaAnthropic, openai: viaOpenai };

// ---- bucle de herramientas (function calling) ----
// op.herramientas: [{ name, description, parameters (JSON schema), ejecutar: async (args) => objeto }]. Cada proveedor tiene su formato;
// el bucle es el mismo: el modelo pide herramientas, las ejecutamos, le devolvemos los resultados, hasta que responde con texto.
const ADAPTADORES = {
  gemini: {
    init(op) { return { contents: op.mensajes.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text || '(sin texto)' }].concat(m.media ? [{ inlineData: { mimeType: m.media.mime, data: m.media.data } }] : []) })) }; },
    async llamar(op, modelo, key, st, conTools) {
      const base = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
      const body = { systemInstruction: { parts: [{ text: op.sistema }] }, contents: st.contents, generationConfig: { temperature: op.temperatura == null ? 0.4 : op.temperatura } };
      if (conTools) body.tools = [{ functionDeclarations: op.herramientas.map(h => ({ name: h.name, description: h.description, parameters: h.parameters })) }];
      const r = await pedir(base + '/models/' + encodeURIComponent(modelo) + ':generateContent', { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }, op.timeoutMs);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw falloHttp(r, d);
      const c = (d.candidates || [])[0], u = d.usageMetadata || {}, partes = (c && c.content && c.content.parts) || [];
      if (c && c.content) st.contents.push(c.content); // se devuelve tal cual (incluye las firmas de razonamiento de Gemini)
      return { texto: partes.map(x => x.text || '').join(''), llamadas: partes.filter(x => x.functionCall).map((x, i) => ({ id: x.functionCall.id || ('c' + i), name: x.functionCall.name, args: x.functionCall.args || {} })), tin: u.promptTokenCount || 0, tout: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
    },
    resultados(st, llamadas, res) { st.contents.push({ role: 'user', parts: llamadas.map((l, i) => ({ functionResponse: { name: l.name, id: l.id, response: { resultado: res[i] } } })) }); }
  },
  anthropic: {
    init(op) { return { messages: op.mensajes.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.media && /^image\//.test(m.media.mime) ? [{ type: 'image', source: { type: 'base64', media_type: m.media.mime, data: m.media.data } }, { type: 'text', text: m.text || '(foto)' }] : (m.text || '(sin texto)') })) }; },
    async llamar(op, modelo, key, st, conTools) {
      const body = { model: modelo, max_tokens: op.maxTokens || 1000, temperature: op.temperatura == null ? 0.4 : op.temperatura, system: op.sistema, messages: st.messages };
      if (conTools) body.tools = op.herramientas.map(h => ({ name: h.name, description: h.description, input_schema: h.parameters }));
      const r = await pedir('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) }, op.timeoutMs);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw falloHttp(r, d);
      const u = d.usage || {}, bl = d.content || [];
      st.messages.push({ role: 'assistant', content: bl });
      return { texto: bl.filter(b => b.type === 'text').map(b => b.text).join(''), llamadas: bl.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })), tin: u.input_tokens || 0, tout: u.output_tokens || 0 };
    },
    resultados(st, llamadas, res) { st.messages.push({ role: 'user', content: llamadas.map((l, i) => ({ type: 'tool_result', tool_use_id: l.id, content: JSON.stringify(res[i]) })) }); }
  },
  openai: {
    init(op) { return { messages: [{ role: 'system', content: op.sistema }].concat(op.mensajes.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.media && /^image\//.test(m.media.mime) ? [{ type: 'image_url', image_url: { url: 'data:' + m.media.mime + ';base64,' + m.media.data } }, { type: 'text', text: m.text || '(foto)' }] : (m.text || '(sin texto)') }))) }; },
    async llamar(op, modelo, key, st, conTools) {
      if (!modelo) throw err(503, 'Para usar OpenAI hay que indicar el modelo en IA_MODELO (o IA_MODELO_OPENAI).', { sinClave: true });
      const body = { model: modelo, temperature: op.temperatura == null ? 0.4 : op.temperatura, max_completion_tokens: op.maxTokens || 1000, messages: st.messages };
      if (conTools) body.tools = op.herramientas.map(h => ({ type: 'function', function: { name: h.name, description: h.description, parameters: h.parameters } }));
      const r = await pedir((process.env.OPENAI_BASE || 'https://api.openai.com/v1') + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) }, op.timeoutMs);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw falloHttp(r, d);
      const u = d.usage || {}, m = ((d.choices || [])[0] || {}).message || {};
      st.messages.push(m);
      return { texto: String(m.content || ''), llamadas: (m.tool_calls || []).map(t => { let a = {}; try { a = JSON.parse(t.function.arguments || '{}'); } catch (e) { /* args inválidos */ } return { id: t.id, name: t.function.name, args: a }; }), tin: u.prompt_tokens || 0, tout: u.completion_tokens || 0 };
    },
    resultados(st, llamadas, res) { llamadas.forEach((l, i) => st.messages.push({ role: 'tool', tool_call_id: l.id, content: JSON.stringify(res[i]) })); }
  }
};
async function viaHerramientas(prov, op, modelo, key) {
  const ad = ADAPTADORES[prov], st = ad.init(op), maxPasos = Math.min(Math.max(op.maxPasos || 5, 1), 8);
  let tin = 0, tout = 0, texto = '';
  const pasos = [];
  for (let paso = 0; paso <= maxPasos; paso++) {
    const r = await ad.llamar(op, modelo, key, st, paso < maxPasos); // el último intento va sin herramientas: obliga a responder
    tin += r.tin; tout += r.tout; texto = r.texto;
    if (!r.llamadas.length || paso >= maxPasos) break;
    const res = [];
    for (const l of r.llamadas) {
      const h = op.herramientas.find(x => x.name === l.name); let out;
      try { out = h ? await h.ejecutar(l.args) : { error: 'Herramienta desconocida.' }; } catch (e) { out = { error: 'La herramienta falló: ' + String(e.message || e).slice(0, 200) }; }
      pasos.push({ herramienta: l.name, argumentos: l.args, resultado: out }); res.push(out);
    }
    ad.resultados(st, r.llamadas, res);
  }
  return { texto, tin, tout, pasos };
}
// Con herramientas el modelo no fuerza el JSON: se pide por instrucción y, si no vino bien formado, se repara con una llamada corta sin herramientas.
async function conHerramientas(prov, op, modelo, key) {
  const sistema = op.sistema + (op.esquema ? '\n\nCuando termines de consultar herramientas, tu respuesta FINAL debe ser únicamente un objeto JSON con este esquema (sin texto afuera, sin bloques de código): ' + JSON.stringify(op.esquema) : '');
  const r = await viaHerramientas(prov, Object.assign({}, op, { sistema }), modelo, key);
  if (op.esquema && !jsonDe(r.texto)) {
    const rep = await VIAS[prov](Object.assign({}, op, { mensajes: [{ role: 'user', text: 'Texto a convertir en el JSON pedido (conservá el contenido):\n' + r.texto }] }), modelo, key);
    r.tin += rep.tin; r.tout += rep.tout; r.texto = rep.texto;
  }
  return r;
}

function jsonDe(t) {
  const l = String(t || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(l); } catch (e) { const i = l.indexOf('{'), j = l.lastIndexOf('}'); if (i >= 0 && j > i) { try { return JSON.parse(l.slice(i, j + 1)); } catch (e2) { /* nada */ } } return null; }
}

// ---- gasto del mes y tope ----
function inicioMes(d) { const a = new Date((d || new Date()).getTime() - 3 * 3600 * 1000); return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1, 3)); }
const topeUsd = () => { const v = Number(process.env.IA_TOPE_USD_MES); return isFinite(v) && process.env.IA_TOPE_USD_MES !== undefined && process.env.IA_TOPE_USD_MES !== '' ? v : 50; };
let cacheGasto = { t: 0, v: 0 };
async function gastoMes(forzar) {
  if (!forzar && Date.now() - cacheGasto.t < 30000) return cacheGasto.v;
  const db = await getDb();
  const r = await db.collection(COL).aggregate([{ $match: { at: { $gte: inicioMes() } } }, { $group: { _id: null, total: { $sum: '$costoUsd' } } }]).toArray();
  cacheGasto = { t: Date.now(), v: r[0] ? r[0].total : 0 };
  return cacheGasto.v;
}
async function verificarTope() {
  const tope = topeUsd(); if (!(tope > 0)) return;
  let g = 0; try { g = await gastoMes(); } catch (e) { return; } // si no se puede medir, no se bloquea
  if (g >= tope) throw err(429, 'Se alcanzó el tope mensual de gasto en IA (US$ ' + tope + ').', { tope: true });
}
async function registrar(doc) {
  try {
    const db = await getDb(); await db.collection(COL).insertOne(Object.assign({ at: new Date() }, doc));
    if (doc.costoUsd) cacheGasto.v += doc.costoUsd;
  } catch (e) { /* el registro es secundario */ }
}

// op: { uso:'bot'|'asistente'|..., orgId, sistema, mensajes, esquema?, temperatura?, maxTokens?, timeoutMs?, proveedor?, modelo?, modelos?:{gemini,anthropic,openai}, notaJson? }
// Devuelve { texto, json, proveedor, modelo, tokensIn, tokensOut, costoUsd }. Errores: .status, .tope (tope mensual), .sinClave.
async function generar(op) {
  await verificarTope();
  const principal = proveedorPrincipal(op.proveedor);
  const orden = [principal];
  if (String(process.env.IA_FALLBACK) !== '0') for (const p of ['gemini', 'anthropic', 'openai']) if (p !== principal && tieneClave(p) && (p !== 'openai' || modeloDe(p, op))) orden.push(p);
  let ultimo = null;
  for (let i = 0; i < orden.length; i++) {
    const prov = orden[i], modelo = modeloDe(prov, op, i === 0), t0 = Date.now();
    if (!tieneClave(prov)) { ultimo = err(503, 'Falta la variable ' + CLAVES[prov] + ' en el servidor.', { sinClave: true }); continue; }
    try {
      const r = (op.herramientas && op.herramientas.length) ? await conHerramientas(prov, op, modelo, process.env[CLAVES[prov]]) : await VIAS[prov](op, modelo, process.env[CLAVES[prov]]);
      const costo = costoUsd(modelo, r.tin, r.tout);
      registrar({ uso: op.uso || 'otro', orgId: op.orgId || null, proveedor: prov, modelo, tokensIn: r.tin, tokensOut: r.tout, costoUsd: costo, ms: Date.now() - t0, ok: true, respaldo: i > 0, herramientas: (r.pasos || []).length || undefined });
      return { texto: r.texto, json: op.esquema ? jsonDe(r.texto) : null, proveedor: prov, modelo, tokensIn: r.tin, tokensOut: r.tout, costoUsd: costo, pasos: r.pasos || [] };
    } catch (e) {
      ultimo = e;
      registrar({ uso: op.uso || 'otro', orgId: op.orgId || null, proveedor: prov, modelo, tokensIn: 0, tokensOut: 0, costoUsd: 0, ms: Date.now() - t0, ok: false, error: String(e.message || '').slice(0, 300), respaldo: i > 0 });
      const reintentable = e.red || e.http === 429 || e.http >= 500;
      if (!reintentable) break; // clave inválida, pedido mal armado, etc.: otro proveedor no lo arregla
    }
  }
  throw ultimo || err(503, 'La IA no está configurada.', { sinClave: true });
}

// ---- modelos que realmente tiene la cuenta (Gemini): evita adivinar nombres ----
router.get('/modelos', authUsuario, async (req, res) => {
  try {
    if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) return res.status(403).json({ error: 'Solo un administrador puede ver los modelos.' });
    const out = { gemini: [], actual: { gemini: process.env.BOT_MODELO || process.env.GEMINI_MODEL || 'gemini-3.8-flash' } };
    if (process.env.GEMINI_API_KEY) {
      const r = await pedir((process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta') + '/models?pageSize=200', { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } }, 15000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: 'Google respondió ' + r.status + ': ' + ((d.error && d.error.message) || '') });
      out.gemini = (d.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name)).map(m => String(m.name).replace(/^models\//, '')).sort();
    }
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- resumen para el administrador ----
router.get('/uso', authUsuario, async (req, res) => {
  try {
    if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) return res.status(403).json({ error: 'Solo un administrador puede ver el uso de IA.' });
    const db = await getDb(), desde = inicioMes();
    const agrupar = (campo) => db.collection(COL).aggregate([{ $match: { at: { $gte: desde } } }, { $group: { _id: '$' + campo, llamadas: { $sum: 1 }, errores: { $sum: { $cond: ['$ok', 0, 1] } }, tokensIn: { $sum: '$tokensIn' }, tokensOut: { $sum: '$tokensOut' }, costoUsd: { $sum: '$costoUsd' } } }, { $sort: { costoUsd: -1 } }]).toArray();
    const [porUso, porProveedor, errores, total] = await Promise.all([agrupar('uso'), agrupar('proveedor'), db.collection(COL).find({ ok: false, at: { $gte: desde } }).sort({ at: -1 }).limit(10).project({ at: 1, uso: 1, proveedor: 1, modelo: 1, error: 1 }).toArray(), gastoMes(true)]);
    const tope = topeUsd(), pct = Number(process.env.IA_AVISO_PCT) || 80;
    res.json({
      mesDesde: desde, gastoUsd: Math.round(total * 10000) / 10000, topeUsd: tope, usadoPct: tope > 0 ? Math.round(total / tope * 1000) / 10 : null,
      estado: tope > 0 && total >= tope ? 'tope' : (tope > 0 && total >= tope * pct / 100 ? 'aviso' : 'ok'),
      proveedor: proveedorPrincipal(), respaldo: String(process.env.IA_FALLBACK) !== '0',
      porUso: porUso.map(x => ({ uso: x._id, llamadas: x.llamadas, errores: x.errores, tokensIn: x.tokensIn, tokensOut: x.tokensOut, costoUsd: x.costoUsd })),
      porProveedor: porProveedor.map(x => ({ proveedor: x._id, llamadas: x.llamadas, errores: x.errores, costoUsd: x.costoUsd })), ultimosErrores: errores,
      nota: 'Costos estimados con los precios públicos de cada modelo; la factura real del proveedor puede diferir.'
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.generar = generar;
module.exports.jsonDe = jsonDe;
module.exports._interno = { costoUsd, precioDe, proveedorPrincipal, inicioMes, topeUsd, gastoMes };
