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
const { authUsuario, requiereAlgunModulo, resolverOrg, filtroOrg } = require('./usuarios');
const leads = require('./leads');
const ia = require('./ia');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
async function getDb() { if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; } return mongoClient.db(DB_NAME); }
const auth = [authUsuario, resolverOrg, requiereAlgunModulo('crm', 'visitas')];
const COL_C = 'wa_conversaciones', COL_M = 'wa_mensajes';
const soloAdmin = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador puede cambiar las instrucciones del bot.' });
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
// ---- base de conocimiento: textos, páginas web, archivos (PDF, Excel, CSV, texto, imágenes) y, si se activa, los productos del sistema (sin precios ni stock) ----
const cacheCon = new Map();
async function catalogoTexto(db, orgId) {
  const ps = await db.collection('productos_catalogo').find({ orgId, activo: { $ne: false } }).project({ nombre: 1, rubro: 1, subrubro: 1, marca: 1, unidad: 1, descripcion: 1 }).limit(3000).toArray();
  const porRubro = new Map(); for (const p of ps) { const k = [p.rubro, p.subrubro].filter(Boolean).join(' / ') || 'Otros'; if (!porRubro.has(k)) porRubro.set(k, []); porRubro.get(k).push(p); }
  let out = ''; for (const [k, l] of [...porRubro].sort((a, b) => a[0].localeCompare(b[0]))) out += '\n## ' + k + '\n' + l.map(p => '- ' + p.nombre + (p.marca ? ' (' + p.marca + ')' : '') + (p.unidad ? ' — se vende por ' + p.unidad : '') + (p.descripcion ? ': ' + String(p.descripcion).slice(0, 200) : '')).join('\n');
  return out.slice(0, 60000);
}
async function conocimientoTexto(orgId) {
  if (!orgId) return '';
  const k = String(orgId), c = cacheCon.get(k); if (c && Date.now() - c.t < 60000) return c.v;
  let v = '';
  try {
    const db = await getDb(); const cfg = await db.collection('bot_config').findOne({ _id: 'conocimiento:' + k });
    const fuentes = await db.collection('bot_conocimiento').find({ orgId, activo: { $ne: false } }).sort({ createdAt: 1 }).toArray();
    let total = 0;
    for (const f of fuentes) { const t = String(f.contenido || '').slice(0, 60000); if (!t || total + t.length > 200000) continue; total += t.length; v += '\n### ' + (f.titulo || f.tipo) + '\n' + t + '\n'; }
    if (cfg && cfg.incluirCatalogo) { const t = await catalogoTexto(db, orgId); if (t) v += '\n### Productos que vende Piedra Negra (catálogo del sistema; sin precios ni stock)\n' + t + '\n'; }
  } catch (e) { /* sin conocimiento extra */ }
  cacheCon.set(k, { t: Date.now(), v }); return v;
}
async function promptSistema(base, orgId) {
  if (base == null) base = await promptBase();
  const con = await conocimientoTexto(orgId); if (con) base += '\n\nBase de conocimiento (usala para responder con precisión; si algo no está acá ni en las instrucciones, no lo inventes ni lo afirmes; los precios y el stock los da un asesor):\n' + con;
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
// Vendedor con datos reales (Fase 1): por sucursal, apagado por defecto. Guardado en bot_config 'vendedor:<orgId>'.
const cacheVend = new Map();
async function vendedorCfg(orgId) { // { activo, modoPrecio: 'precio' | 'link' | 'link_o_precio', oportunidades }
  if (!orgId) return { activo: false, modoPrecio: 'precio', oportunidades: false };
  const k = String(orgId), c = cacheVend.get(k); if (c && Date.now() - c.t < 30000) return c.v;
  let v = { activo: false, modoPrecio: 'precio', oportunidades: false };
  try { const d = await (await getDb()).collection('bot_config').findOne({ _id: 'vendedor:' + k }); if (d) v = { activo: !!d.activo, modoPrecio: ['precio', 'link', 'link_o_precio'].includes(d.modoPrecio) ? d.modoPrecio : 'precio', oportunidades: !!d.oportunidades }; } catch (e) { /* apagado */ }
  cacheVend.set(k, { t: Date.now(), v }); return v;
}
const vendedorActivo = async (orgId) => (await vendedorCfg(orgId)).activo;
// opciones.conDatos: true/false fuerza (simulador); undefined = lo que diga la sucursal. Devuelve el JSON del bot (+ _pasos con las consultas hechas al sistema).
async function llamarIA(historial, promptBaseTexto, orgId, opciones) {
  const o = opciones || {};
  let sistema = await promptSistema(promptBaseTexto, orgId);
  const conDatos = orgId && (o.conDatos === undefined ? await vendedorActivo(orgId) : !!o.conDatos);
  let herramientas;
  if (conDatos) {
    const vt = require('./vendedorTools'), cfgV = await vendedorCfg(orgId), modo = cfgV.modoPrecio;
    const conBorrador = o.borrador === undefined ? !!cfgV.oportunidades : !!o.borrador; // simulador/lote: borrador de prueba, no se guarda
    herramientas = vt.herramientas(await getDb(), orgId, modo, conBorrador ? { borrador: true, convId: o.convId || null } : null); sistema += vt.reglasPrompt(modo, conBorrador);
  }
  const r = await ia.generar({
    uso: conDatos ? 'bot-datos' : 'bot', orgId: orgId || null, sistema, mensajes: historial, esquema: ESQUEMA, temperatura: 0.4, maxTokens: 800, timeoutMs: conDatos ? 60000 : 45000,
    proveedor: o.proveedor || process.env.BOT_PROVEEDOR, modelo: o.modelo || process.env.BOT_MODELO || undefined, modelos: { anthropic: 'claude-haiku-4-5-20251001' },
    notaJson: 'El JSON debe tener: respuesta, derivar, aceptoAsesor, producto, medidas, estilo, resumen, etiquetas.', herramientas, maxPasos: 5
  });
  if (r.json) { Object.defineProperty(r.json, '_pasos', { value: r.pasos || [], enumerable: false }); Object.defineProperty(r.json, '_meta', { value: { proveedor: r.proveedor, modelo: r.modelo, costoUsd: r.costoUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut }, enumerable: false }); }
  return r.json;
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
// Manda un archivo (PDF) por WhatsApp: primero lo sube como media y después lo envía como documento.
async function enviarDocumento(tel, buffer, nombreArchivo, texto) {
  if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return { id: 'prueba-' + crypto.randomBytes(6).toString('hex'), prueba: true };
  const h = { Authorization: 'Bearer ' + process.env.WA_TOKEN };
  const fd = new FormData(); fd.append('messaging_product', 'whatsapp'); fd.append('type', 'application/pdf'); fd.append('file', new Blob([buffer], { type: 'application/pdf' }), nombreArchivo);
  const up = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '/media', { method: 'POST', headers: h, body: fd }, 60000);
  const ud = await up.json().catch(() => ({})); if (!up.ok || !ud.id) throw new Error('WhatsApp no aceptó el archivo: ' + ((ud.error && ud.error.message) || up.status));
  const r = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '/messages', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h),
    body: JSON.stringify({ messaging_product: 'whatsapp', to: tel, type: 'document', document: { id: ud.id, filename: nombreArchivo, caption: String(texto || '').slice(0, 1000) } }) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error('WhatsApp ' + r.status + ': ' + ((d.error && d.error.message) || ''));
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

// Manda una foto, video, audio o documento por WhatsApp: se sube como media y se envía con el tipo que corresponde (foto/video/documento con texto de acompañamiento).
const TIPOS_ENVIO = { 'image/jpeg': 'image', 'image/png': 'image', 'video/mp4': 'video', 'video/3gpp': 'video', 'audio/aac': 'audio', 'audio/mp4': 'audio', 'audio/mpeg': 'audio', 'audio/amr': 'audio', 'audio/ogg': 'audio',
  'application/pdf': 'document', 'application/msword': 'document', 'application/vnd.ms-excel': 'document', 'application/vnd.ms-powerpoint': 'document', 'text/plain': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document' };
const LIMITE_ENVIO = { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024, audio: 16 * 1024 * 1024, document: 18 * 1024 * 1024 };
async function enviarMedia(tel, buffer, nombre, mime, tipo, texto) {
  if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return { id: 'prueba-' + crypto.randomBytes(6).toString('hex'), prueba: true };
  const h = { Authorization: 'Bearer ' + process.env.WA_TOKEN };
  const fd = new FormData(); fd.append('messaging_product', 'whatsapp'); fd.append('type', mime); fd.append('file', new Blob([buffer], { type: mime }), nombre);
  const up = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '/media', { method: 'POST', headers: h, body: fd }, 90000);
  const ud = await up.json().catch(() => ({})); if (!up.ok || !ud.id) throw new Error('WhatsApp no aceptó el archivo: ' + ((ud.error && ud.error.message) || up.status));
  const o = { id: ud.id }; if (tipo === 'document') o.filename = nombre; if (texto && tipo !== 'audio') o.caption = String(texto).slice(0, 1000);
  const r = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '/messages', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h), body: JSON.stringify({ messaging_product: 'whatsapp', to: tel, type: tipo, [tipo]: o }) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error('WhatsApp ' + r.status + ': ' + ((d.error && d.error.message) || ''));
  return { id: d.messages && d.messages[0] && d.messages[0].id, mediaId: ud.id };
}

// ---- ventana de 24 h y plantillas ----
// WhatsApp solo deja mandar texto libre hasta 24 h después del último mensaje del cliente; pasado ese tiempo hay que usar una plantilla aprobada por Meta.
const VENTANA_H = 24;
function ventanaDe(ultimoClienteAt) {
  if (!ultimoClienteAt) return { abierta: false, venceAt: null, ultimoCliente: null };
  const ult = new Date(ultimoClienteAt), vence = new Date(ult.getTime() + VENTANA_H * 3600 * 1000);
  return { abierta: vence > new Date(), venceAt: vence, ultimoCliente: ult };
}
async function ventanaConv(db, convId) {
  const m = await db.collection(COL_M).find({ convId, dir: 'in' }).sort({ at: -1 }).limit(1).toArray();
  return ventanaDe(m[0] && m[0].at);
}
const MSJ_VENTANA = 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo deja mandar una plantilla aprobada. Elegí una plantilla o esperá a que escriba.';
const VARIABLES_PLANTILLA = { nombre: 'Nombre del cliente', asesor: 'Nombre del asesor', producto: 'Producto que consultó' };
// Plantillas sugeridas (para crear y aprobar en Meta). 'categoria' y 'ejemplos' son para completar el formulario de Meta; el sistema usa nombre, idioma, texto y variables.
const PLANTILLAS_SUGERIDAS = [
  { titulo: 'Seguimiento de presupuesto', nombre: 'seguimiento_presupuesto', categoria: 'Utilidad', texto: 'Hola {{1}}, soy {{2}} de Piedra Negra. Quería saber si pudiste revisar el presupuesto que te enviamos. Si tenés alguna duda o querés ajustar algo, respondé este mensaje y lo vemos juntos.', variables: ['nombre', 'asesor'] },
  { titulo: 'Presupuesto por vencer', nombre: 'presupuesto_por_vencer', categoria: 'Utilidad', texto: 'Hola {{1}}, soy {{2}} de Piedra Negra. Te aviso que el presupuesto que te pasamos está por vencer y los precios pueden actualizarse. Si querés avanzar o necesitás ajustarlo, respondé este mensaje.', variables: ['nombre', 'asesor'] },
  { titulo: 'Consulta sin respuesta', nombre: 'consulta_sin_respuesta', categoria: 'Utilidad (Meta puede pasarla a Marketing)', texto: 'Hola {{1}}, soy {{2}} de Piedra Negra. Hace unos días nos consultaste por {{3}} y queremos saber si todavía te interesa. Respondé este mensaje y te ayudamos con lo que necesites.', variables: ['nombre', 'asesor', 'producto'] },
  { titulo: 'Retomar consulta', nombre: 'retomar_consulta', categoria: 'Utilidad (Meta puede pasarla a Marketing)', texto: 'Hola {{1}}, soy {{2}} de Piedra Negra. Retomamos tu consulta por {{3}}. ¿Querés que sigamos por acá y te paso el detalle?', variables: ['nombre', 'asesor', 'producto'] },
  { titulo: 'Coordinar entrega', nombre: 'coordinar_entrega', categoria: 'Utilidad', texto: 'Hola {{1}}, te escribimos de Piedra Negra para coordinar la entrega de tu pedido. ¿Qué día y horario te queda cómodo? Respondé este mensaje y lo coordinamos.', variables: ['nombre'] },
  { titulo: 'Poscompra', nombre: 'poscompra', categoria: 'Utilidad', texto: 'Hola {{1}}, gracias por tu compra en Piedra Negra. Si tenés alguna duda con los materiales o necesitás algo más para tu obra, escribinos por acá.', variables: ['nombre'] }
];
const EJEMPLOS_VARIABLE = { nombre: 'Marta', asesor: 'Carla', producto: 'porcelanato 60x60' };
function plantillasLimpias(arr) {
  const out = []; const usados = new Set();
  for (const p of Array.isArray(arr) ? arr : []) {
    const nombre = String((p && p.nombre) || '').trim().toLowerCase(); const texto = String((p && p.texto) || '').trim().slice(0, 1024);
    if (!/^[a-z0-9_]{1,200}$/.test(nombre) || !texto || usados.has(nombre)) continue; usados.add(nombre);
    const n = (texto.match(/\{\{\d+\}\}/g) || []).length;
    const variables = (Array.isArray(p.variables) ? p.variables : []).map(String).filter(v => VARIABLES_PLANTILLA[v]).slice(0, n);
    while (variables.length < n) variables.push('nombre');
    out.push({ nombre, idioma: /^[a-z]{2}(_[A-Z]{2})?$/.test(String(p.idioma || '')) ? p.idioma : 'es_AR', texto, variables, titulo: String(p.titulo || '').trim().slice(0, 60) || nombre });
  }
  return out.slice(0, 20);
}
async function plantillasDe(db, orgId) { const d = await db.collection('bot_config').findOne({ _id: 'plantillas:' + orgId }); return plantillasLimpias(d && d.items); }
function paramsPlantilla(pl, conv, usuario) {
  const primero = String((conv && conv.nombre) || '').trim().split(/\s+/)[0] || 'cliente';
  const v = { nombre: primero, asesor: String((usuario && (usuario.nombre || usuario.name)) || 'un asesor'), producto: String((conv && conv.datos && conv.datos.producto) || '').trim() || 'materiales' };
  return pl.variables.map(k => v[k] || '');
}
const rellenar = (texto, params) => String(texto || '').replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] != null ? params[Number(n) - 1] : '');
async function enviarPlantilla(tel, pl, params) {
  if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return { id: 'prueba-' + crypto.randomBytes(6).toString('hex'), prueba: true };
  const tpl = { name: pl.nombre, language: { code: pl.idioma } };
  if (params.length) tpl.components = [{ type: 'body', parameters: params.map(t => ({ type: 'text', text: String(t) })) }];
  const r = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: tel, type: 'template', template: tpl }) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error('WhatsApp ' + r.status + ': ' + ((d.error && d.error.message) || ''));
  return { id: d.messages && d.messages[0] && d.messages[0].id };
}


// ---- archivos del cliente (fotos, audios, videos, documentos) ----
// Meta guarda cada archivo ~30 días y su link dura minutos: se baja con el token y se guarda una copia (hasta 6 MB, 120 días) para verlo desde el CRM.
const MEDIA_MAX_COPIA = 6 * 1024 * 1024, MEDIA_MAX_VER = 25 * 1024 * 1024;
async function traerMediaDeMeta(id) {
  const h = { Authorization: 'Bearer ' + process.env.WA_TOKEN };
  const mr = await pedir(graph() + '/' + id, { headers: h }, 20000); const m = await mr.json().catch(() => ({}));
  if (!mr.ok || !m.url) { const e = new Error(mr.status === 404 || mr.status === 400 ? 'Meta ya no guarda este archivo (pasaron más de 30 días).' : 'No se pudo pedir el archivo a Meta (' + mr.status + ').'); e.vencido = mr.status === 404 || mr.status === 400; throw e; }
  if (m.file_size && Number(m.file_size) > MEDIA_MAX_VER) throw new Error('El archivo es muy grande para verlo acá.');
  const r = await pedir(m.url, { headers: h }, 60000); if (!r.ok) throw new Error('No se pudo bajar el archivo (' + r.status + ').');
  const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > MEDIA_MAX_VER) throw new Error('El archivo es muy grande para verlo acá.');
  return { buf, mime: String(m.mime_type || r.headers.get('content-type') || '').split(';')[0] };
}
async function guardarCopiaMedia(db, orgId, archivo) {
  if (!process.env.WA_TOKEN || !archivo) return null;
  const { buf, mime } = await traerMediaDeMeta(archivo.id);
  if (buf.length <= MEDIA_MAX_COPIA) await db.collection('wa_media').updateOne({ _id: archivo.id }, { $set: { orgId, mime, data: buf, bytes: buf.length, at: new Date() } }, { upsert: true }).catch(() => {});
  return { buf, mime };
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
const textoDe = (m) => {
  const t = m.type, x = m[t] || {}, cap = String(x.caption || '').trim();
  if (t === 'text') return (m.text && m.text.body) || '';
  if (t === 'button') return (m.button && m.button.text) || '';
  if (t === 'interactive') return ((m.interactive && ((m.interactive.button_reply && m.interactive.button_reply.title) || (m.interactive.list_reply && m.interactive.list_reply.title))) || '');
  if (t === 'document') return '📎 ' + (x.filename || 'Documento') + (cap ? '\n' + cap : '');
  if (t === 'video') return '🎬 Video' + (cap ? '\n' + cap : '');
  if (t === 'sticker') return '(sticker)';
  if (t === 'location') return '📍 Ubicación' + [x.name, x.address].filter(Boolean).map(v => ': ' + v).join('') + (x.latitude != null ? ' https://maps.google.com/?q=' + x.latitude + ',' + x.longitude : '');
  if (t === 'contacts') return '👤 Contacto compartido: ' + ((m.contacts || []).map(c => c.name && c.name.formatted_name).filter(Boolean).join(', ') || '—');
  if (t === 'reaction') return '(reaccionó con ' + (x.emoji || '👍') + ')';
  if (t === 'unsupported' || t === 'order' || t === 'system') return '(mensaje que WhatsApp no deja ver en el sistema)';
  return cap;
};
const archivoDe = (m) => { // foto, audio, video, documento o sticker que mandó el cliente: se guarda para poder verlo en el CRM
  const t = m.type; if (!['image', 'audio', 'video', 'document', 'sticker'].includes(t)) return null; const x = m[t] || {};
  return x.id ? { id: String(x.id), tipo: t, mime: String(x.mime_type || '').split(';')[0], nombre: x.filename || '', voz: !!x.voice } : null;
};
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
    let r;
    try { r = await llamarIA(hist, undefined, conv.orgId, { convId }); }
    catch (e) {
      if (!e.tope) throw e;
      // tope mensual de IA alcanzado: el bot no puede responder; se avisa al cliente y queda para un asesor
      await db.collection(COL_M).updateOne({ _id: ultimoIn._id }, { $set: { respondido: true } });
      const aviso = 'Gracias por escribirnos. Un asesor te va a responder a la brevedad' + (abierto() ? '.' : ' dentro del horario comercial.');
      const env = await enviarTexto(conv.tel, aviso); await guardarMensaje(db, conv, { waId: env.id, dir: 'out', origen: 'bot', tipo: 'text', texto: aviso, at: new Date(), prueba: !!env.prueba });
      await db.collection(COL_C).updateOne({ _id: convId }, { $set: { estado: 'aceptado', avisoAt: new Date(), updatedAt: new Date(), resumen: (conv.resumen || '') + ' [El bot no respondió: tope mensual de IA alcanzado]' } });
      return;
    }
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
    // Fase 2: si el bot derivó a un cliente con interés concreto, se crea la oportunidad (y el borrador de presupuesto si corresponde)
    if ((r.derivar || r.aceptoAsesor) && (await vendedorCfg(conv.orgId)).oportunidades) {
      try { const fresca = await db.collection(COL_C).findOne({ _id: convId }); const res2 = await require('./vendedorOportunidades').oportunidadDeConversacion(db, fresca, r);
        if (res2 && res2.creada) console.log('[bot] oportunidad #' + res2.numero + ' creada desde la conversación ' + k + (res2.presupuestoNumero ? ' con borrador de presupuesto #' + res2.presupuestoNumero : '')); }
      catch (e) { console.error('[bot] oportunidad:', e.message); }
    }
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

// último aviso real recibido de Meta (para que el panel de Conexión muestre si el webhook está llegando)
function registrarAviso(body) {
  try { const tipos = new Set(); for (const e of (body && body.entry) || []) for (const c of e.changes || []) { const v = c.value || {}; if (v.messages) tipos.add('mensajes'); if (v.statuses) tipos.add('estados'); if (v.message_echoes) tipos.add('mensajes del celular'); }
    getDb().then(db => db.collection('bot_config').updateOne({ _id: 'ultimo-aviso' }, { $set: { at: new Date(), tipos: [...tipos] } }, { upsert: true })).catch(() => {}); } catch (e) { /* no importa */ }
}
router.post('/webhook', async (req, res) => {
  if (!firmaOk(req.rawBody, req.headers['x-hub-signature-256'])) return res.sendStatus(process.env.META_APP_SECRET ? 401 : 503);
  res.sendStatus(200); // Meta reintenta si tardamos: se responde ya y se procesa después
  registrarAviso(req.body);
  try { await procesarEvento(req.body); } catch (e) { console.error('[bot] webhook:', e.message); }
});
async function procesarEvento(body) {
  const orgId = orgBot(); if (!orgId) { console.error('[bot] falta BOT_ORG_ID'); return; }
  const db = await getDb();
  for (const ent of (body && body.entry) || []) for (const ch of ent.changes || []) {
    const v = ch.value || {};
    for (const st of v.statuses || []) { // enviado / entregado / leído / falló
      if (!st.id) continue; const err = (st.errors && st.errors[0]) || null;
      await db.collection(COL_M).updateOne({ waId: st.id }, { $set: Object.assign({ estadoEnvio: st.status, estadoAt: st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date() }, err ? { errorEnvio: { codigo: err.code, texto: String(err.title || err.message || '').slice(0, 200) } } : {}) }).catch(() => {});
    }
    if (!v.messages && !v.message_echoes) continue;
    const nombres = new Map((v.contacts || []).map(c => [digitos(c.wa_id), c.profile && c.profile.name]));
    for (const m of v.messages || []) {
      if (m.type === 'reaction') continue; // una reacción no es una consulta nueva
      const conv = await convDe(db, orgId, m.from, nombres.get(digitos(m.from)), m.referral);
      const arch = archivoDe(m);
      const ok = await guardarMensaje(db, conv, Object.assign({ waId: m.id, dir: 'in', origen: 'cliente', tipo: m.type, texto: textoDe(m), mediaId: mediaIdDe(m), at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() }, arch ? { archivo: arch } : {}));
      if (ok && arch && arch.tipo !== 'video') guardarCopiaMedia(db, orgId, arch).catch(e => console.error('[bot] copia de archivo:', e.message));
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

// ---- panel de Conexión de WhatsApp: qué falta para pasar el número al bot propio (no conecta nada por sí solo) ----
router.get('/conexion', auth, soloAdmin, async (req, res) => {
  try { const db = await getDb(); const e = process.env;
    const org = orgBot(); const dominio = (e.PUBLIC_URL || ((req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'))).replace(/\/$/, '');
    const checks = [
      { k: 'WA_TOKEN', ok: !!e.WA_TOKEN, ayuda: 'Token permanente del usuario del sistema, con los permisos whatsapp_business_messaging y whatsapp_business_management.' },
      { k: 'WA_PHONE_ID', ok: !!e.WA_PHONE_ID, ayuda: 'Identificador del número (Meta → WhatsApp → Configuración de la API). No es el teléfono.' },
      { k: 'WA_VERIFY_TOKEN', ok: !!e.WA_VERIFY_TOKEN, ayuda: 'Una clave que inventamos y se carga igual en Render y en Meta (al configurar el webhook).' },
      { k: 'META_APP_SECRET', ok: !!e.META_APP_SECRET, ayuda: 'Clave secreta de la app (Meta → App → Configuración → Básica). Sirve para comprobar que los avisos vienen de Meta.' },
      { k: 'BOT_ORG_ID', ok: !!org, ayuda: 'Identificador de la sucursal a la que entran los mensajes (Piedra Negra).' },
      { k: 'GEMINI_API_KEY', ok: !!(e.GEMINI_API_KEY || e.ANTHROPIC_API_KEY || e.OPENAI_API_KEY), ayuda: 'Clave de la IA que redacta las respuestas.' }
    ];
    const aviso = await db.collection('bot_config').findOne({ _id: 'ultimo-aviso' });
    const [reales, plantillas] = await Promise.all([db.collection(COL_C).countDocuments(Object.assign({ demo: { $ne: true } }, org ? { orgId: org } : {})), org ? plantillasDe(db, org) : []]);
    res.json({ modo: (e.WA_TOKEN && e.WA_PHONE_ID) ? 'real' : 'prueba', botActivo: e.BOT_ACTIVO !== '0', checks, listo: checks.every(c => c.ok), webhookUrl: dominio + '/api/bot/webhook',
      tokenSugerido: e.WA_VERIFY_TOKEN ? '' : crypto.randomBytes(18).toString('hex'), ultimoAviso: aviso ? { at: aviso.at, tipos: aviso.tipos || [] } : null, conversacionesReales: reales, plantillas: plantillas.length });
  } catch (er) { res.status(500).json({ error: er.message }); }
});
router.post('/conexion/probar', auth, soloAdmin, async (req, res) => { // consulta a Meta los datos del número: solo lee, no manda nada
  try { if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return res.json({ ok: false, error: 'Faltan WA_TOKEN y WA_PHONE_ID en Render.' });
    const r = await pedir(graph() + '/' + process.env.WA_PHONE_ID + '?fields=display_phone_number,verified_name,quality_rating,name_status,code_verification_status,platform_type', { headers: { Authorization: 'Bearer ' + process.env.WA_TOKEN } }, 20000);
    const d = await r.json().catch(() => ({})); if (!r.ok) return res.json({ ok: false, error: 'Meta respondió ' + r.status + ': ' + ((d.error && d.error.message) || '') });
    res.json({ ok: true, numero: d.display_phone_number, nombre: d.verified_name, calidad: d.quality_rating, estadoNombre: d.name_status, verificacion: d.code_verification_status, plataforma: d.platform_type });
  } catch (er) { res.json({ ok: false, error: er.message }); }
});
router.post('/conexion/mensaje-prueba', auth, soloAdmin, async (req, res) => { // manda la plantilla "hello_world" que Meta trae por defecto, a un celular propio
  try { const tel = digitos(req.body && req.body.tel); if (tel.length < 10) return res.status(400).json({ error: 'Poné tu celular con código de área (ej: 549236…).' });
    if (!process.env.WA_TOKEN || !process.env.WA_PHONE_ID) return res.json({ ok: true, prueba: true, aviso: 'Modo prueba: no se mandó nada porque todavía no está conectado.' });
    await enviarPlantilla(tel, { nombre: 'hello_world', idioma: 'en_US' }, []); res.json({ ok: true });
  } catch (er) { res.status(502).json({ error: er.message }); }
});

router.get('/media/:id', auth, async (req, res) => { // el CRM pide el archivo con su sesión; se sirve desde la copia o, si no hay, desde Meta
  try { const id = String(req.params.id); if (!/^[\w.-]{4,200}$/.test(id)) return res.status(400).json({ error: 'Archivo inválido.' });
    const db = await getDb(); const m = await db.collection(COL_M).findOne(Object.assign({ 'archivo.id': id }, filtroOrg(req))); if (!m) return res.status(404).json({ error: 'Archivo no encontrado.' });
    let data = null, mime = m.archivo.mime || '';
    const c = await db.collection('wa_media').findOne({ _id: id }); if (c && c.data) { data = c.data.buffer ? Buffer.from(c.data.buffer) : Buffer.from(c.data); mime = c.mime || mime; }
    if (!data) { if (!process.env.WA_TOKEN) return res.status(503).json({ error: 'Todavía no hay conexión con WhatsApp: el archivo se va a poder ver cuando esté conectado.' });
      let r; try { r = await guardarCopiaMedia(db, m.orgId, m.archivo); } catch (e) { return res.status(e.vencido ? 410 : 502).json({ error: e.message }); } data = r.buf; mime = r.mime || mime; }
    if (!/^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr|wav|x-m4a)|video\/(mp4|3gpp|webm|quicktime)|application\/pdf)$/.test(mime)) mime = 'application/octet-stream'; // nunca se sirve HTML/SVG de un cliente
    res.set({ 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(data.length) }); res.send(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
// conversación de WhatsApp de un teléfono (para abrirla desde el CRM): últimos 10 dígitos
router.get('/conversacion-por-tel/:tel', auth, async (req, res) => {
  try { const t = String(req.params.tel || '').replace(/\D/g, '').slice(-10); if (t.length < 8) return res.json({ conversacion: null, mensajes: [] });
    const db = await getDb(); const c = await db.collection(COL_C).findOne(Object.assign({ tel10: t }, filtroOrg(req)));
    if (!c) return res.json({ conversacion: null, mensajes: [] });
    res.json({ conversacion: { _id: c._id, nombre: c.nombre, tel: c.tel, estado: c.estado, resumen: c.resumen }, mensajes: await db.collection(COL_M).find({ convId: c._id }).sort({ at: 1 }).limit(500).toArray() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/conversaciones/:id', auth, async (req, res) => {
  try { const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const mensajes = await db.collection(COL_M).find({ convId: c._id }).sort({ at: 1 }).limit(500).toArray(); const ult = [...mensajes].reverse().find(m => m.dir === 'in');
    res.json({ conversacion: c, mensajes, ventana: c.demo ? { abierta: true, demo: true } : ventanaDe(ult && ult.at), plantillas: c.demo ? [] : await plantillasDe(db, c.orgId) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/conversaciones/:id/estado', auth, async (req, res) => {
  try { const est = req.body && req.body.estado; if (!['bot', 'derivado', 'aceptado', 'humano', 'pausado'].includes(est)) return res.status(400).json({ error: 'Estado inválido.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: est, updatedAt: new Date() } }); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- Fase 3: asistente del vendedor (el asesor lo pide con un botón; nunca envía nada solo) ----
router.post('/conversaciones/:id/asistente', auth, async (req, res) => {
  try {
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const mensajes = await db.collection(COL_M).find({ convId: c._id }).sort({ at: -1 }).limit(40).toArray(); mensajes.reverse();
    if (!mensajes.length) return res.status(400).json({ error: 'La conversación todavía no tiene mensajes.' });
    const a = ahoraAR(); const cfgV = await vendedorCfg(c.orgId);
    const r = await require('./vendedorAsistente').analizar({ db, orgId: c.orgId, conv: c, mensajes, conocimiento: await conocimientoTexto(c.orgId), modo: cfgV.modoPrecio,
      ahora: 'hoy es ' + DIAS[a.getUTCDay()] + ' ' + a.toISOString().slice(0, 10) + ' ' + a.toISOString().slice(11, 16) + ' hs (Argentina); la atención humana está ' + (abierto() ? 'ABIERTA' : 'CERRADA') });
    const asistente = Object.assign({}, r, { at: new Date(), usuario: (req.usuario && req.usuario.nombre) || '', mensajesAnalizados: mensajes.length });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { asistente } });
    res.json(asistente);
  } catch (e) { res.status(e.tope ? 429 : (e.status && e.status < 600 ? e.status : 502)).json({ error: e.tope ? 'Se alcanzó el tope mensual de gasto en IA. Avisale al administrador.' : e.message }); }
});
router.post('/conversaciones/:id/seguimiento', auth, async (req, res) => {
  try {
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    await actualizarLead(db, c, []); // asegura que exista el lead de esta conversación
    const r = await require('./vendedorAsistente').programarSeguimiento(db, c, { dias: req.body && req.body.dias, nota: req.body && req.body.nota, resumen: c.asistente && c.asistente.resumen, usuarioNombre: (req.usuario && req.usuario.nombre) || '' });
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// ---- conversaciones de EJEMPLO para probar el asistente sin WhatsApp conectado (marcadas demo; se pueden quitar) ----
const EJEMPLOS = [
  { tel: '5491100000001', nombre: 'Luis (ejemplo)', estado: 'derivado', datos: { producto: 'Porcelanato gris 60x60', medidas: '30 m2', estilo: 'cemento' }, resumen: 'Quiere 30 m2 de porcelanato gris 60x60 para el living.', min: [
    ['in', 'Hola, buenas tardes. Cuánto sale el porcelanato gris 60x60?'], ['bot', 'Hola Luis! Tenemos varias opciones de porcelanato gris 60x60. ¿Para qué ambiente lo necesitás y cuántos m2 son?'],
    ['in', 'Para el living y el pasillo, unos 30 m2. Lo quiero tipo cemento, mate'], ['bot', 'Genial. Te paso con un asesor que te arma el presupuesto. ¿Querés que te contacte hoy?'], ['in', 'Sí por favor, y si me pueden decir si hacen envío a Chacabuco']] },
  { tel: '5491100000002', nombre: 'Marta (ejemplo)', estado: 'humano', datos: { producto: 'Cerámica baño', medidas: '', estilo: '' }, resumen: 'Preguntó precios de cerámica para el baño y no volvió a responder.', min: [
    ['in', 'Hola, precio de la ceramica para baño?'], ['bot', 'Hola! ¿Qué medidas tiene el baño y qué estilo buscás (blanco, símil mármol, color)?'], ['in', 'Son como 6 m2, algo claro'],
    ['asesor', 'Marta, te paso dos opciones claras que tenemos en stock. ¿Te las mando por acá?'], ['in', 'Dale, mandame y lo hablo con mi marido']] },
  { tel: '5491100000003', nombre: 'Carlos (ejemplo)', estado: 'humano', datos: { producto: 'Porcelanato', medidas: '', estilo: '' }, resumen: 'Reclama por una caja de porcelanato rota en su última compra.', min: [
    ['in', 'Buenas, compré porcelanato la semana pasada y me llegó una caja rota'], ['bot', 'Lamento lo ocurrido, Carlos. Te pasamos con un asesor para resolverlo.'], ['asesor', 'Hola Carlos, soy del equipo de Piedra Negra. ¿Me pasás una foto de la caja y el número de compra?'],
    ['in', 'Acá va la foto. La compra fue a nombre de Carlos Ruiz, el martes'], ['in', 'Necesito que me la cambien porque ya empiezan a colocar el viernes']] }
];
router.post('/conversaciones/ejemplos', auth, soloAdmin, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return sinOrg(res); const db = await getDb(); let n = 0;
    for (const e of EJEMPLOS) {
      const tel10 = e.tel.slice(-10); if (await db.collection(COL_C).findOne({ orgId, tel10 })) continue;
      const ahora = Date.now(); const r = await db.collection(COL_C).insertOne({ orgId, tel: e.tel, tel10, nombre: e.nombre, estado: e.estado, datos: e.datos, resumen: e.resumen, demo: true, createdAt: new Date(ahora), updatedAt: new Date(ahora) });
      const docs = e.min.map((m, i) => ({ convId: r.insertedId, orgId, waId: 'demo-' + e.tel + '-' + i, dir: m[0] === 'in' ? 'in' : 'out', origen: m[0] === 'in' ? 'cliente' : m[0], tipo: 'text', texto: m[1], at: new Date(ahora - (e.min.length - i) * 4 * 60000), respondido: true, prueba: true }));
      await db.collection(COL_M).insertMany(docs); n++;
    }
    res.json({ ok: true, creadas: n }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/conversaciones/ejemplos', auth, soloAdmin, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return sinOrg(res); const db = await getDb();
    const convs = await db.collection(COL_C).find({ orgId, demo: true }).project({ tel10: 1 }).toArray(); const ids = convs.map(c => c._id), tels = convs.map(c => c.tel10);
    const leadsDemo = tels.length ? await db.collection('leads_whatsapp').find({ orgId, tel10: { $in: tels } }).project({ _id: 1 }).toArray() : [];
    const lids = leadsDemo.map(l => l._id);
    if (lids.length) { await db.collection('oportunidades').deleteMany({ orgId, leadId: { $in: lids }, estado: 'activa' }); await db.collection('leads_whatsapp').deleteMany({ _id: { $in: lids } }); }
    await db.collection(COL_M).deleteMany({ convId: { $in: ids } }); await db.collection(COL_C).deleteMany({ _id: { $in: ids } });
    res.json({ ok: true, quitadas: ids.length }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/conversaciones/:id/enviar', auth, async (req, res) => { // un asesor escribe desde el sistema: el bot queda afuera
  try { const texto = String((req.body && req.body.texto) || '').trim().slice(0, 4000); if (!texto) return res.status(400).json({ error: 'Escribí un mensaje.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    if (!c.demo && !(await ventanaConv(db, c._id)).abierta) return res.status(409).json({ error: MSJ_VENTANA, ventanaCerrada: true });
    const env = c.demo ? { id: 'demo-' + crypto.randomBytes(6).toString('hex'), prueba: true } : await enviarTexto(c.tel, texto); // los ejemplos nunca se mandan por WhatsApp
    await guardarMensaje(db, c, { waId: env.id, dir: 'out', origen: 'asesor', tipo: 'text', texto, at: new Date(), prueba: !!env.prueba });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: 'humano', humanoAt: new Date(), updatedAt: new Date() } }); res.json({ ok: true, prueba: !!env.prueba });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/plantillas', auth, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return res.json({ items: [], variables: VARIABLES_PLANTILLA, sugeridas: [] });
    res.json({ items: await plantillasDe(await getDb(), orgId), variables: VARIABLES_PLANTILLA, sugeridas: PLANTILLAS_SUGERIDAS.map(p => Object.assign({ idioma: 'es_AR', ejemplos: p.variables.map(v => EJEMPLOS_VARIABLE[v]) }, p)) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/plantillas', auth, soloAdmin, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return sinOrg(res); const items = plantillasLimpias(req.body && req.body.items);
    await (await getDb()).collection('bot_config').updateOne({ _id: 'plantillas:' + orgId }, { $set: { items, updatedAt: new Date() } }, { upsert: true }); res.json({ ok: true, items }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/conversaciones/:id/enviar-plantilla', auth, async (req, res) => { // reabre la conversación fuera de las 24 h con una plantilla aprobada
  try { const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    const pl = (await plantillasDe(db, c.orgId)).find(x => x.nombre === String((req.body && req.body.nombre) || '')); if (!pl) return res.status(400).json({ error: 'Elegí una plantilla de la lista.' });
    const params = paramsPlantilla(pl, c, req.usuario); const texto = rellenar(pl.texto, params);
    const env = c.demo ? { id: 'demo-' + crypto.randomBytes(6).toString('hex'), prueba: true } : await enviarPlantilla(c.tel, pl, params);
    await guardarMensaje(db, c, { waId: env.id, dir: 'out', origen: 'asesor', tipo: 'template', plantilla: pl.nombre, texto, at: new Date(), prueba: !!env.prueba });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: 'humano', humanoAt: new Date(), updatedAt: new Date() } }); res.json({ ok: true, prueba: !!env.prueba, texto });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/conversaciones/:id/enviar-archivo', auth, async (req, res) => { // el asesor manda una foto, video, audio o documento (con texto opcional)
  try { const b = req.body || {}; const mime = String(b.mime || '').toLowerCase().split(';')[0]; const tipo = TIPOS_ENVIO[mime];
    if (!tipo) return res.status(400).json({ error: 'Ese tipo de archivo no se puede mandar por WhatsApp. Sirven fotos JPG/PNG, videos MP4, audios, PDF y documentos de Word, Excel o PowerPoint.' });
    const b64 = String(b.data || '').replace(/^data:[^,]*,/, ''); if (!/^[A-Za-z0-9+/=\s]+$/.test(b64) || b64.length < 4) return res.status(400).json({ error: 'Falta el archivo.' });
    const buf = Buffer.from(b64, 'base64'); if (!buf.length) return res.status(400).json({ error: 'El archivo está vacío.' });
    if (buf.length > LIMITE_ENVIO[tipo]) return res.status(413).json({ error: 'El archivo pesa ' + (buf.length / 1048576).toFixed(1) + ' MB y el máximo para ' + ({ image: 'una foto', video: 'un video', audio: 'un audio', document: 'un documento' })[tipo] + ' es ' + Math.round(LIMITE_ENVIO[tipo] / 1048576) + ' MB.' });
    const nombre = String(b.nombre || 'archivo').replace(/[^\w.\- ()áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 100) || 'archivo'; const texto = String(b.texto || '').trim().slice(0, 1000);
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    if (!c.demo && !(await ventanaConv(db, c._id)).abierta) return res.status(409).json({ error: MSJ_VENTANA, ventanaCerrada: true });
    const env = c.demo ? { id: 'demo-' + crypto.randomBytes(6).toString('hex'), prueba: true } : await enviarMedia(c.tel, buf, nombre, mime, tipo, texto);
    const aid = env.mediaId || env.id; // para verlo en el chat: copia propia (hasta 6 MB) y, si no hay, se pide a Meta
    if (buf.length <= MEDIA_MAX_COPIA) await db.collection('wa_media').updateOne({ _id: aid }, { $set: { orgId: c.orgId, mime, data: buf, bytes: buf.length, at: new Date() } }, { upsert: true }).catch(() => {});
    const etiqueta = tipo === 'document' ? '📎 ' + nombre : tipo === 'video' ? '🎬 Video' : '';
    await guardarMensaje(db, c, { waId: env.id, dir: 'out', origen: 'asesor', tipo, texto: (etiqueta + (texto ? (etiqueta ? '\n' : '') + texto : '')).trim(), archivo: { id: aid, tipo, mime, nombre }, at: new Date(), prueba: !!env.prueba });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: 'humano', humanoAt: new Date(), updatedAt: new Date() } }); res.json({ ok: true, prueba: !!env.prueba });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/conversaciones/:id/enviar-presupuesto', auth, async (req, res) => { // manda el PDF del presupuesto (con un texto de acompañamiento)
  try {
    const texto = String((req.body && req.body.texto) || '').trim().slice(0, 1000);
    const pid = (() => { try { return new ObjectId(String(req.body && req.body.presupuestoId)); } catch (e) { return null; } })(); if (!pid) return res.status(400).json({ error: 'Falta el presupuesto.' });
    const db = await getDb(); const c = await convDeReq(db, req); if (!c) return res.status(404).json({ error: 'No encontrada.' });
    if (!c.demo && !(await ventanaConv(db, c._id)).abierta) return res.status(409).json({ error: MSJ_VENTANA, ventanaCerrada: true });
    const p = await db.collection('presupuestos').findOne({ _id: pid, orgId: c.orgId }); if (!p) return res.status(404).json({ error: 'Presupuesto no encontrado.' });
    const [org, cliente] = await Promise.all([db.collection('organizaciones').findOne({ _id: p.orgId }), p.clienteId ? db.collection('clientes').findOne({ _id: p.clienteId }) : null]);
    const b64 = String((req.body && req.body.pdfBase64) || '').replace(/^data:[^,]*,/, ''); // el navegador manda el PDF con el mismo diseño de Imprimir; si no, uno simple del servidor
    const pdf = /^[A-Za-z0-9+/=\s]+$/.test(b64) && b64.length > 400 ? Buffer.from(b64, 'base64') : await require('./presupuestoPdf').generar(p, org, cliente); const nombre = 'Presupuesto-' + String(p.numero).padStart(5, '0') + '.pdf';
    const env = c.demo ? { id: 'demo-' + crypto.randomBytes(6).toString('hex'), prueba: true } : await enviarDocumento(c.tel, pdf, nombre, texto);
    await guardarMensaje(db, c, { waId: env.id, dir: 'out', origen: 'asesor', tipo: 'document', texto: '📎 ' + nombre + (texto ? '\n' + texto : ''), at: new Date(), prueba: !!env.prueba });
    await db.collection(COL_C).updateOne({ _id: c._id }, { $set: { estado: 'humano', humanoAt: new Date(), updatedAt: new Date() } }); res.json({ ok: true, prueba: !!env.prueba, bytes: pdf.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- prueba del bot sin WhatsApp: corre el mismo motor de IA sobre una conversación simulada (no guarda nada ni envía mensajes) ----
router.post('/simular', auth, async (req, res) => {
  try {
    const b = req.body || {}; const ms = Array.isArray(b.mensajes) ? b.mensajes.slice(-30) : [];
    if (!ms.length || ms[ms.length - 1].role !== 'user') return res.status(400).json({ error: 'Falta el mensaje del cliente.' });
    const hist = ms.map(m => ({ role: m.role === 'model' ? 'model' : 'user', text: String(m.text || '').slice(0, 4000), media: m.media && m.media.data && /^(image|audio)\//.test(m.media.mime || '') && String(m.media.data).length < 12e6 ? { mime: m.media.mime, data: m.media.data } : undefined }));
    if (hist[0].role === 'model') hist.unshift({ role: 'user', text: '(inicio de la conversación)' });
    const orgSim = req.orgId || req.orgOperar || orgBot();
    const r = await llamarIA(hist, typeof b.prompt === 'string' && b.prompt.trim() ? b.prompt : undefined, orgSim, { conDatos: typeof b.conDatos === 'boolean' ? b.conDatos : undefined, borrador: true });
    if (!r) return res.status(502).json({ error: 'La IA no devolvió una respuesta válida. Probá de nuevo.' });
    res.json({ respuesta: r.respuesta || '', derivar: !!r.derivar, aceptoAsesor: !!r.aceptoAsesor, producto: r.producto || '', medidas: r.medidas || '', estilo: r.estilo || '', resumen: r.resumen || '', etiquetas: r.etiquetas || [], transcripcion: r.transcripcion || '', pasos: (r._pasos || []).map(p => ({ herramienta: p.herramienta, argumentos: p.argumentos, resultado: p.resultado })) });
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

// ---- gestión de la base de conocimiento (solo Administrador puede modificarla) ----
const dns = require('dns').promises, net = require('net');
function ipPrivada(ip) { return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i.test(ip); }
async function urlSegura(u) {
  let x; try { x = new URL(u); } catch (e) { throw new Error('La dirección no es válida.'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('Solo se aceptan direcciones http o https.');
  if (process.env.BOT_PERMITIR_LOCAL === '1') return x;
  const host = x.hostname.replace(/^\[|\]$/g, ''); const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(r => r.address);
  if (!ips.length || ips.some(ipPrivada)) throw new Error('Esa dirección no se puede leer desde el servidor.');
  return x;
}
function htmlATexto(h) {
  const ent = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ' };
  return String(h).replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ent[m.toLowerCase()] || ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function leerURL(u) {
  const x = await urlSegura(u);
  const r = await pedir(x.href, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; PiedraNegraBot/1.0)', accept: 'text/html,text/plain' }, redirect: 'follow' }, 20000);
  if (!r.ok) throw new Error('La página respondió ' + r.status + '.');
  const ct = String(r.headers.get('content-type') || ''); const raw = await r.text();
  const t = /html/i.test(ct) || /<html|<body/i.test(raw.slice(0, 2000)) ? htmlATexto(raw) : raw;
  if (t.length < 50) throw new Error('No se pudo leer texto de esa página (puede cargarse con JavaScript).');
  const titulo = (raw.match(/<title[^>]*>([^<]{1,120})/i) || [])[1];
  return { texto: t.slice(0, 60000), titulo: titulo ? htmlATexto(titulo) : x.hostname };
}
async function extraerConIA(mime, data) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('Para leer PDF o imágenes hace falta GEMINI_API_KEY.');
  const modelo = process.env.BOT_MODELO || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  const r = await pedir((process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta') + '/models/' + encodeURIComponent(modelo) + ':generateContent', { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Transcribí en texto plano todo el contenido útil de este documento (productos, medidas, colores, usos, características, condiciones). Mantené las tablas como líneas "producto | dato | dato". No resumas ni inventes nada.' }, { inlineData: { mimeType: mime, data } }] }], generationConfig: { temperature: 0 } }) }, 120000);
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error('IA ' + r.status + ': ' + ((d.error && d.error.message) || ''));
  const c = (d.candidates || [])[0]; return c && c.content && c.content.parts ? c.content.parts.map(x => x.text || '').join('') : '';
}
async function textoDeArchivo(nombre, mime, b64) {
  const buf = Buffer.from(b64, 'base64'); if (buf.length > 15 * 1024 * 1024) throw new Error('El archivo supera los 15 MB.');
  const ext = (String(nombre).split('.').pop() || '').toLowerCase(); mime = mime || '';
  if (['txt', 'md', 'csv', 'json', 'html'].includes(ext) || /^text\//.test(mime)) { const t = buf.toString('utf8'); return ext === 'html' ? htmlATexto(t) : t; }
  if (['xlsx', 'xls', 'ods'].includes(ext)) { const XLSX = require('xlsx'); const wb = XLSX.read(buf, { type: 'buffer' }); return wb.SheetNames.map(n => '## Hoja: ' + n + '\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n'); }
  if (ext === 'pdf' || mime === 'application/pdf') return extraerConIA('application/pdf', b64);
  if (/^image\//.test(mime) || ['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return extraerConIA(mime || 'image/' + (ext === 'jpg' ? 'jpeg' : ext), b64);
  throw new Error('Formato no soportado. Subí PDF, Excel, CSV, texto o imagen.');
}
const orgCon = (req) => req.orgId || req.orgOperar || null;
const sinOrg = (res) => res.status(400).json({ error: 'Elegí una sucursal en la barra de arriba (no "todas").' });
async function nuevaFuente(req, res, datos) {
  const orgId = orgCon(req); if (!orgId) return sinOrg(res);
  const texto = String(datos.contenido || '').trim(); if (!texto) return res.status(400).json({ error: 'No se pudo obtener texto de esa fuente.' });
  const db = await getDb(); const ahora = new Date();
  const r = await db.collection('bot_conocimiento').insertOne({ orgId, tipo: datos.tipo, titulo: String(datos.titulo || 'Sin título').slice(0, 120), url: datos.url || '', archivo: datos.archivo || '', contenido: texto.slice(0, 60000), chars: Math.min(texto.length, 60000), recortado: texto.length > 60000, activo: true, createdAt: ahora, actualizado: ahora });
  cacheCon.delete(String(orgId)); res.json({ ok: true, id: r.insertedId, chars: Math.min(texto.length, 60000), recortado: texto.length > 60000 });
}
router.get('/conocimiento', auth, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return res.json({ fuentes: [], incluirCatalogo: false, sinSucursal: true });
    const db = await getDb(); const fuentes = await db.collection('bot_conocimiento').find({ orgId }).project({ contenido: 0 }).sort({ createdAt: 1 }).toArray();
    const cfg = await db.collection('bot_config').findOne({ _id: 'conocimiento:' + orgId }); const nProd = await db.collection('productos_catalogo').countDocuments({ orgId, activo: { $ne: false } });
    res.json({ fuentes, incluirCatalogo: !!(cfg && cfg.incluirCatalogo), productosEnSistema: nProd }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/conocimiento/texto', auth, soloAdmin, async (req, res) => { try { await nuevaFuente(req, res, { tipo: 'texto', titulo: req.body.titulo, contenido: req.body.contenido }); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/conocimiento/url', auth, soloAdmin, async (req, res) => { try { const u = await leerURL(String((req.body && req.body.url) || '').trim()); await nuevaFuente(req, res, { tipo: 'url', titulo: req.body.titulo || u.titulo, url: req.body.url.trim(), contenido: u.texto }); } catch (e) { res.status(400).json({ error: e.message }); } });
router.post('/conocimiento/archivo', auth, soloAdmin, async (req, res) => { try { const b = req.body || {}; if (!b.data) return res.status(400).json({ error: 'Falta el archivo.' }); const t = await textoDeArchivo(b.nombre || 'archivo', b.mime, b.data); await nuevaFuente(req, res, { tipo: 'archivo', titulo: b.titulo || b.nombre, archivo: b.nombre, contenido: t }); } catch (e) { res.status(400).json({ error: e.message }); } });
async function fuenteDeReq(db, req) { const orgId = orgCon(req); if (!orgId || !/^[0-9a-f]{24}$/i.test(req.params.id)) return null; return db.collection('bot_conocimiento').findOne({ _id: new ObjectId(req.params.id), orgId }); }
router.get('/conocimiento/:id', auth, async (req, res) => { try { const f = await fuenteDeReq(await getDb(), req); if (!f) return res.status(404).json({ error: 'No encontrada.' }); res.json(f); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/conocimiento/:id/actualizar', auth, soloAdmin, async (req, res) => { // vuelve a leer una página web
  try { const db = await getDb(); const f = await fuenteDeReq(db, req); if (!f || f.tipo !== 'url') return res.status(404).json({ error: 'No es una página web.' });
    const u = await leerURL(f.url); await db.collection('bot_conocimiento').updateOne({ _id: f._id }, { $set: { contenido: u.texto, chars: u.texto.length, actualizado: new Date() } }); cacheCon.delete(String(f.orgId)); res.json({ ok: true, chars: u.texto.length }); } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/conocimiento/:id', auth, soloAdmin, async (req, res) => {
  try { const db = await getDb(); const f = await fuenteDeReq(db, req); if (!f) return res.status(404).json({ error: 'No encontrada.' }); const set = { actualizado: new Date() }, b = req.body || {};
    if (b.activo !== undefined) set.activo = !!b.activo; if (typeof b.titulo === 'string') set.titulo = b.titulo.slice(0, 120); if (typeof b.contenido === 'string') { set.contenido = b.contenido.slice(0, 60000); set.chars = set.contenido.length; }
    await db.collection('bot_conocimiento').updateOne({ _id: f._id }, { $set: set }); cacheCon.delete(String(f.orgId)); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/conocimiento/:id', auth, soloAdmin, async (req, res) => { try { const db = await getDb(); const f = await fuenteDeReq(db, req); if (!f) return res.status(404).json({ error: 'No encontrada.' }); await db.collection('bot_conocimiento').deleteOne({ _id: f._id }); cacheCon.delete(String(f.orgId)); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

// ---- prueba por lote: corre las consultas de pruebas/consultas-bot.json por el mismo motor (con datos reales) y deja el resultado para revisar ----
const lotes = new Map();
router.post('/probar-lote', auth, soloAdmin, async (req, res) => {
  try {
    const orgId = orgCon(req); if (!orgId) return sinOrg(res);
    let casos; try { casos = JSON.parse(fs.readFileSync(path.join(__dirname, 'pruebas', 'consultas-bot.json'), 'utf8')).consultas; } catch (e) { return res.status(500).json({ error: 'No se pudo leer pruebas/consultas-bot.json' }); }
    const b = req.body || {}; const ids = Array.isArray(b.ids) && b.ids.length ? new Set(b.ids.map(Number)) : null;
    casos = casos.filter(c => !ids || ids.has(c.id));
    const id = crypto.randomBytes(6).toString('hex');
    const job = { id, estado: 'corriendo', total: casos.length, hechas: 0, resultados: [], costoUsd: 0, inicio: new Date(), proveedor: String(b.proveedor || '').toLowerCase() || undefined, modelo: String(b.modelo || '').trim() || undefined };
    lotes.set(id, job); if (lotes.size > 10) lotes.delete(lotes.keys().next().value);
    (async () => {
      const cola = casos.slice();
      const worker = async () => { for (let c = cola.shift(); c; c = cola.shift()) {
        const hist = [], turnos = [];
        try {
          for (const m of c.mensajes) {
            hist.push({ role: 'user', text: m });
            const r = await llamarIA(hist.slice(), undefined, orgId, { conDatos: true, borrador: true, proveedor: job.proveedor, modelo: job.modelo });
            if (!r) throw new Error('La IA no devolvió un JSON válido');
            const meta = r._meta || {}; job.costoUsd += meta.costoUsd || 0; job.usado = { proveedor: meta.proveedor, modelo: meta.modelo };
            turnos.push({ cliente: m, bot: r.respuesta || '', derivar: !!r.derivar, herramientas: (r._pasos || []).map(p => p.herramienta + ' ' + JSON.stringify(p.argumentos)) });
            hist.push({ role: 'model', text: r.respuesta || '' });
          }
          job.resultados.push({ id: c.id, categoria: c.categoria, esperado: c.esperado, turnos });
        } catch (e) { job.resultados.push({ id: c.id, categoria: c.categoria, esperado: c.esperado, turnos, error: e.message }); if (e.tope) { cola.length = 0; } }
        job.hechas++;
      } };
      await Promise.all([worker(), worker(), worker()]);
      job.resultados.sort((a, b2) => a.id - b2.id); job.estado = 'listo'; job.fin = new Date();
    })().catch(e => { job.estado = 'error'; job.error = e.message; });
    res.json({ id, total: casos.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/probar-lote/:id', auth, soloAdmin, (req, res) => { const j = lotes.get(req.params.id); if (!j) return res.status(404).json({ error: 'No existe esa corrida (se pierde si el servidor se reinicia).' }); res.json(j); });
router.get('/vendedor-config', auth, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return res.json({ activo: false, sinSucursal: true });
    const db = await getDb(); const d = await db.collection('bot_config').findOne({ _id: 'vendedor:' + orgId });
    const [conPrecio, total] = await Promise.all([db.collection('productos_catalogo').countDocuments({ orgId, activo: { $ne: false }, precio: { $gt: 0 } }), db.collection('productos_catalogo').countDocuments({ orgId, activo: { $ne: false } })]);
    const vinc = await db.collection('productos_catalogo').countDocuments({ orgId, activo: { $ne: false }, skuTiendanube: { $nin: [null, ''] } });
    res.json({ activo: !!(d && d.activo), modoPrecio: (await vendedorCfg(orgId)).modoPrecio, oportunidades: !!(d && d.oportunidades), productosConPrecio: conPrecio, productosTotal: total, productosConLink: vinc }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/vendedor-config', auth, soloAdmin, async (req, res) => {
  try { const orgId = orgCon(req); if (!orgId) return sinOrg(res);
    await (await getDb()).collection('bot_config').updateOne({ _id: 'vendedor:' + orgId }, { $set: Object.assign({ updatedAt: new Date() }, req.body && req.body.activo !== undefined ? { activo: !!req.body.activo } : {}, req.body && ['precio', 'link', 'link_o_precio'].includes(req.body.modoPrecio) ? { modoPrecio: req.body.modoPrecio } : {}, req.body && req.body.oportunidades !== undefined ? { oportunidades: !!req.body.oportunidades } : {}) }, { upsert: true }); cacheVend.delete(String(orgId)); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/conocimiento-config', auth, soloAdmin, async (req, res) => { try { const orgId = orgCon(req); if (!orgId) return sinOrg(res); await (await getDb()).collection('bot_config').updateOne({ _id: 'conocimiento:' + orgId }, { $set: { incluirCatalogo: !!(req.body && req.body.incluirCatalogo) } }, { upsert: true }); cacheCon.delete(String(orgId)); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

(async () => { try { const db = await getDb(); await db.collection(COL_M).createIndex({ waId: 1 }, { unique: true, sparse: true }); await db.collection(COL_C).createIndex({ orgId: 1, tel10: 1 }, { unique: true }); await db.collection(COL_M).createIndex({ convId: 1, at: 1 }); await db.collection('wa_media').createIndex({ at: 1 }, { expireAfterSeconds: 120 * 86400 }); await db.collection(COL_M).createIndex({ 'archivo.id': 1 }, { sparse: true }); } catch (e) { /* sin base al arrancar */ } })();

module.exports = router;
module.exports.abierto = abierto;
module.exports.procesarEvento = procesarEvento;
module.exports.actualizarLead = actualizarLead;
