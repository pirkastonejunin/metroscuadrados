// ---------------------------------------------------------------------------
// Asistente del sistema (17/10/2026, pedido de Mato): chat con IA para que los usuarios pregunten cómo se usa el sistema y
// dejen propuestas de mejora, que quedan registradas y mapeadas (pantalla, módulo, tipo, prioridad, estado) en un tablero
// que solo ve el administrador.
//
// - El asistente solo conoce la guía `asistente-guia.md` (no ve datos de clientes, ventas ni stock).
// - Cuando el usuario cuenta una mejora, un error o algo que falta, la IA arma un borrador de propuesta y la pantalla le
//   pide confirmar antes de guardarla (nada se registra sin que el usuario lo apruebe).
// - IA: usa la misma configuración que la lectura de facturas: GEMINI_API_KEY (o ANTHROPIC_API_KEY). Variables opcionales:
//   ASISTENTE_PROVEEDOR (gemini|anthropic), ASISTENTE_MODELO.
//
// Rutas (/api/asistente):
//   POST   /chat                { mensajes:[{role,content}], pantalla }  -> { respuesta, propuesta|null }   (cualquier usuario)
//   POST   /propuestas          { titulo, descripcion, tipo, prioridad, pantalla, contexto } (cualquier usuario)
//   GET    /propuestas/mias     las del usuario
//   GET    /propuestas          (admin) todas, con filtros ?estado=&modulo=
//   PATCH  /propuestas/:id      (admin) { estado, nota, prioridad }
//   GET    /consultas           (admin) últimas preguntas hechas al asistente
// ---------------------------------------------------------------------------
const express = require('express');
const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient;
let mongoConectando = null;
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
function err(status, message) { return Object.assign(new Error(message), { status }); }
function responder(res, e) { res.status(e.status || 500).json({ error: e.message || 'Error' }); }
function toObjectId(id) { try { return id ? new ObjectId(String(id)) : null; } catch (e) { return null; } }
const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 2000);

const authAdmin = [authUsuario, requiereModulo('usuarios')];

// Pantalla (ruta) -> nombre legible y módulo, para mapear cada propuesta con la parte del sistema a la que se refiere.
const PANTALLAS = {
  '/admin-ventas.html': ['Ventas', 'Comercial'], '/admin-presupuestos.html': ['Presupuestos', 'Comercial'], '/admin-clientes.html': ['Clientes', 'Comercial'],
  '/admin-cobranza.html': ['Cobranza', 'Comercial'], '/cotizador.html': ['Cotizador', 'Comercial'], '/admin-remitos.html': ['Remitos', 'Comercial'],
  '/admin-productos.html': ['Productos', 'Inventario'], '/admin-stock.html': ['Stock', 'Inventario'], '/admin-tiendanube.html': ['Tiendanube', 'Inventario'],
  '/admin-proveedores.html': ['Proveedores', 'Proveedores'], '/admin-compras.html': ['Compras', 'Proveedores'], '/admin-gastos.html': ['Gastos', 'Proveedores'],
  '/admin-tesoreria.html': ['Tesorería', 'Tesorería'], '/admin-mercadopago.html': ['Mercado Pago y tarjetas', 'Tesorería'], '/admin-financiera.html': ['Financiera', 'Tesorería'],
  '/admin-fiscal.html': ['Puntos de venta y ARCA', 'Fiscal'], '/admin-fiscal-libros.html': ['Libros de IVA', 'Fiscal'],
  '/admin-informe-ventas.html': ['Informe de ventas', 'Reportes'], '/admin-informe-resultados.html': ['Estado de resultados', 'Reportes'],
  '/admin-informe-deudores.html': ['Deudores', 'Reportes'], '/admin-informe-proveedores.html': ['Deuda con proveedores', 'Reportes'], '/admin-facturacion.html': ['Facturación por sucursal', 'Reportes'],
  '/admin-visitas.html': ['Panel de Visitas / CRM', 'CRM'], '/admin-obras.html': ['Panel de Obras', 'CRM'], '/calendario.html': ['Calendario', 'CRM'],
  '/admin-costos.html': ['Costos de Producción', 'Producción'], '/fabrica.html': ['Registrar producción', 'Producción'], '/admin-sueldos.html': ['Sueldos', 'Personal'],
  '/admin-usuarios.html': ['Configuración', 'Configuración'], '/admin-config-bases.html': ['Bases y catálogos', 'Configuración'],
  '/admin-integraciones.html': ['Integraciones', 'Configuración'], '/admin-correo.html': ['Correo a clientes', 'Configuración'], '/inicio.html': ['Inicio', 'General']
};
function mapearPantalla(p) {
  const ruta = txt(p, 200).split('?')[0];
  const m = PANTALLAS[ruta];
  return { pantallaRuta: ruta, pantalla: m ? m[0] : (ruta || ''), modulo: m ? m[1] : 'General' };
}

let GUIA = null;
function guia() {
  if (GUIA === null) { try { GUIA = fs.readFileSync(path.join(__dirname, 'asistente-guia.md'), 'utf8'); } catch (e) { GUIA = ''; } }
  return GUIA;
}

const TIPOS = ['mejora', 'error', 'consulta'];
const PRIORIDADES = ['baja', 'media', 'alta'];
const ESTADOS = ['nueva', 'evaluando', 'aprobada', 'hecha', 'descartada'];

function instrucciones(pantalla) {
  return `Sos el asistente del sistema de gestión de Grupo Piedra Negra (un negocio argentino de materiales de construcción). Hablás en español rioplatense (voseo), claro, breve y amable. Ayudás a los usuarios a usar el sistema y recibís sus propuestas de mejora.

REGLAS
- Respondé SOLO con lo que dice la GUÍA de abajo. Si la guía no lo cubre, decí con honestidad que no lo sabés; nunca inventes pantallas, botones ni funciones.
- No tenés acceso a datos del negocio (clientes, ventas, stock, precios, saldos). Si te los piden, explicá en qué pantalla se ven.
- Respuestas cortas: pasos numerados cuando se explica cómo hacer algo, sin rodeos. No uses tablas ni títulos.
- Si el usuario cuenta una idea de mejora, algo que falta, algo que le resulta confuso o un error, respondé con empatía en una o dos frases y completá "propuesta" con un borrador: titulo (corto, máx. 80 caracteres), descripcion (qué quiere lograr y por qué, con los detalles que dio, en tercera persona neutra), tipo ("mejora", "error" o "consulta" si es una pregunta que la guía no pudo resolver) y prioridad ("baja", "media" o "alta", según el impacto que describe). La pantalla le va a pedir que confirme antes de guardarla.
- Si solo es una pregunta que sí podés responder con la guía, "propuesta" va en null.
- Si falta un dato clave para entender la propuesta, preguntalo en "respuesta" y dejá "propuesta" en null hasta tenerlo.
- La pantalla donde está el usuario ahora es: ${pantalla || 'desconocida'}.

Devolvé SIEMPRE un único objeto JSON con esta forma, sin texto afuera: {"respuesta": string, "propuesta": null | {"titulo": string, "descripcion": string, "tipo": "mejora"|"error"|"consulta", "prioridad": "baja"|"media"|"alta"}}

GUÍA DEL SISTEMA
${guia()}`;
}

const ESQUEMA = {
  type: 'object',
  properties: {
    respuesta: { type: 'string' },
    propuesta: { type: 'object', nullable: true, properties: { titulo: { type: 'string' }, descripcion: { type: 'string' }, tipo: { type: 'string', enum: TIPOS }, prioridad: { type: 'string', enum: PRIORIDADES } }, required: ['titulo', 'descripcion', 'tipo', 'prioridad'] }
  },
  required: ['respuesta']
};

const TIMEOUT_MS = 60000;
async function pedir(url, opciones) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, opciones, { signal: c.signal })); }
  catch (e) { throw err(e.name === 'AbortError' ? 504 : 502, e.name === 'AbortError' ? 'El asistente tardó demasiado en responder. Probá de nuevo.' : 'No se pudo conectar con el servicio de IA.'); }
  finally { clearTimeout(t); }
}
function proveedor() {
  const f = String(process.env.ASISTENTE_PROVEEDOR || process.env.FACTURA_IA_PROVEEDOR || '').toLowerCase();
  if (f === 'gemini' || f === 'anthropic') return f;
  return process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic';
}
function jsonDe(texto) {
  const limpio = String(texto || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(limpio); } catch (e) {
    const i = limpio.indexOf('{'), j = limpio.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(limpio.slice(i, j + 1)); } catch (e2) { /* sigue */ } }
    return { respuesta: limpio || 'No pude armar una respuesta. Probá reformular la pregunta.', propuesta: null };
  }
}
function sinNullable(n) { // Gemini no acepta "nullable" en este esquema: se saca y la propuesta es opcional
  if (Array.isArray(n)) return n.map(sinNullable);
  if (!n || typeof n !== 'object') return n;
  const o = {}; for (const k of Object.keys(n)) if (k !== 'nullable') o[k] = sinNullable(n[k]); return o;
}

async function llamarIA(mensajes, pantalla) {
  const sistema = instrucciones(pantalla);
  if (proveedor() === 'gemini') {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw err(503, 'El asistente todavía no está configurado: falta la variable GEMINI_API_KEY (o ANTHROPIC_API_KEY) en el servidor.');
    const modelo = process.env.ASISTENTE_MODELO || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const resp = await pedir('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelo) + ':generateContent', {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents: mensajes.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: sinNullable(ESQUEMA), temperature: 0.3 }
      })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const d = (data && data.error && data.error.message) || ('estado ' + resp.status);
      if (resp.status === 429) throw err(429, 'El asistente alcanzó su límite de uso por ahora. Probá en unos minutos.');
      throw err(502, 'El servicio de IA devolvió un error: ' + d);
    }
    const cand = (data.candidates || [])[0];
    return jsonDe(cand && cand.content && cand.content.parts ? cand.content.parts.map(x => x.text || '').join('') : '');
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw err(503, 'El asistente todavía no está configurado: falta la variable GEMINI_API_KEY (o ANTHROPIC_API_KEY) en el servidor.');
  const resp = await pedir('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.ASISTENTE_MODELO || process.env.FACTURA_IA_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, system: sistema, messages: mensajes.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })) })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const d = (data && data.error && data.error.message) || ('estado ' + resp.status);
    if (resp.status === 429) throw err(429, 'El asistente alcanzó su límite de uso por ahora. Probá en unos minutos.');
    throw err(502, 'El servicio de IA devolvió un error: ' + d);
  }
  return jsonDe((data.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
}

// Tope de uso por usuario (en memoria): evita que un usuario o un bucle gaste la cuota de la IA.
const usoPorUsuario = new Map();
function dentroDelTope(clave) {
  const ahora = Date.now(), tope = Number(process.env.ASISTENTE_MAX_POR_HORA) || 40;
  const lista = (usoPorUsuario.get(clave) || []).filter(t => ahora - t < 3600 * 1000);
  if (lista.length >= tope) { usoPorUsuario.set(clave, lista); return false; }
  lista.push(ahora); usoPorUsuario.set(clave, lista); return true;
}

function normalizarPropuesta(p) {
  if (!p || typeof p !== 'object') return null;
  const titulo = txt(p.titulo, 120), descripcion = txt(p.descripcion, 3000);
  if (!titulo || !descripcion) return null;
  return { titulo, descripcion, tipo: TIPOS.includes(p.tipo) ? p.tipo : 'mejora', prioridad: PRIORIDADES.includes(p.prioridad) ? p.prioridad : 'media' };
}

router.post('/chat', authUsuario, async (req, res) => {
  try {
    const clave = String(req.usuario._id || req.usuario.usuario);
    if (!dentroDelTope(clave)) throw err(429, 'Hiciste muchas consultas seguidas al asistente. Probá de nuevo en un rato.');
    let mensajes = Array.isArray(req.body && req.body.mensajes) ? req.body.mensajes : [];
    mensajes = mensajes.filter(m => m && ['user', 'assistant'].includes(m.role) && txt(m.content)).slice(-12).map(m => ({ role: m.role, content: txt(m.content, 2000) }));
    if (!mensajes.length || mensajes[mensajes.length - 1].role !== 'user') throw err(400, 'Escribí tu consulta.');
    const ubic = mapearPantalla(req.body && req.body.pantalla);
    const out = await llamarIA(mensajes, ubic.pantalla + (ubic.pantallaRuta ? ' (' + ubic.pantallaRuta + ')' : ''));
    const respuesta = txt(out.respuesta, 4000) || 'No pude armar una respuesta. Probá reformular la pregunta.';
    const propuesta = normalizarPropuesta(out.propuesta);
    // Registro de lo que se pregunta (para que el administrador vea qué le cuesta al equipo y mejore la guía).
    try {
      const db = await getDb();
      await db.collection('asistente_consultas').insertOne({ usuarioNombre: req.usuario.nombre || '', usuarioId: req.usuario._id || null, pantalla: ubic.pantalla, pregunta: mensajes[mensajes.length - 1].content, respuesta, conPropuesta: !!propuesta, createdAt: new Date() });
    } catch (e) { /* el registro es secundario */ }
    res.json({ respuesta, propuesta });
  } catch (e) { responder(res, e); }
});

router.post('/propuestas', authUsuario, async (req, res) => {
  try {
    const p = normalizarPropuesta(req.body);
    if (!p) throw err(400, 'Falta el título o la descripción de la propuesta.');
    const ubic = mapearPantalla(req.body.pantalla);
    const ahora = new Date();
    const doc = Object.assign({}, p, ubic, {
      estado: 'nueva', nota: '', usuarioId: req.usuario._id || null, usuarioNombre: req.usuario.nombre || '',
      contexto: Array.isArray(req.body.contexto) ? req.body.contexto.slice(-8).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: txt(m.content, 1500) })) : [],
      historial: [{ fecha: ahora, estado: 'nueva', nota: '', usuarioNombre: req.usuario.nombre || '' }], createdAt: ahora, updatedAt: ahora
    });
    const db = await getDb();
    const r = await db.collection('asistente_propuestas').insertOne(doc);
    res.json(Object.assign({ _id: r.insertedId }, doc));
  } catch (e) { responder(res, e); }
});

router.get('/propuestas/mias', authUsuario, async (req, res) => {
  try {
    const db = await getDb();
    const lista = await db.collection('asistente_propuestas').find({ usuarioId: req.usuario._id }).project({ contexto: 0 }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(lista);
  } catch (e) { responder(res, e); }
});

router.get('/propuestas', authAdmin, async (req, res) => {
  try {
    const f = {};
    if (ESTADOS.includes(req.query.estado)) f.estado = req.query.estado;
    if (req.query.modulo) f.modulo = txt(req.query.modulo, 60);
    const db = await getDb();
    const lista = await db.collection('asistente_propuestas').find(f).sort({ createdAt: -1 }).limit(500).toArray();
    res.json(lista);
  } catch (e) { responder(res, e); }
});

router.patch('/propuestas/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const set = { updatedAt: new Date() };
    if (b.estado !== undefined) { if (!ESTADOS.includes(b.estado)) throw err(400, 'Estado inválido'); set.estado = b.estado; }
    if (b.prioridad !== undefined) { if (!PRIORIDADES.includes(b.prioridad)) throw err(400, 'Prioridad inválida'); set.prioridad = b.prioridad; }
    if (b.nota !== undefined) set.nota = txt(b.nota, 1000);
    const db = await getDb();
    const actual = await db.collection('asistente_propuestas').findOne({ _id: id });
    if (!actual) throw err(404, 'Propuesta no encontrada');
    const update = { $set: set };
    if (set.estado && set.estado !== actual.estado || (b.nota !== undefined && set.nota)) {
      update.$push = { historial: { fecha: new Date(), estado: set.estado || actual.estado, nota: set.nota || '', usuarioNombre: req.usuario.nombre || '' } };
    }
    await db.collection('asistente_propuestas').updateOne({ _id: id }, update);
    res.json(await db.collection('asistente_propuestas').findOne({ _id: id }));
  } catch (e) { responder(res, e); }
});

router.get('/consultas', authAdmin, async (req, res) => {
  try {
    const db = await getDb();
    res.json(await db.collection('asistente_consultas').find({}).sort({ createdAt: -1 }).limit(200).toArray());
  } catch (e) { responder(res, e); }
});

router.ESTADOS = ESTADOS;
module.exports = router;
