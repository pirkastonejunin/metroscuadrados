// ---------------------------------------------------------------------------
// Asesores con IA — Etapa 1 (2/11/2026, pedido de Mato): motor de asesores + conocimiento desde Google Drive.
//
// Idea: cada asesor (ventas, VL, administrador) es una CONFIGURACIÓN (rol, carpeta de Drive, tope de gasto). El conocimiento
// (cursos, fichas técnicas, planillas, PDFs) se sube a una carpeta de Drive y el sistema lo lee de ahí:
//   Drive: "Asesores IA" / Ventas | VL | Administrador | Compartido   (Compartido lo leen todos los asesores)
// Los archivos ORIGINALES se quedan en Drive. En la base solo se guarda el texto extraído, partido en fragmentos
// (colección asesores_fragmentos, con índice de texto de Mongo, sin vectores) para que ocupe poco en Atlas (512 MB).
//
// Reglas:
//  - Solo LECTURA de Drive (scope drive.readonly) con la misma cuenta de servicio del Calendar (GOOGLE_SERVICE_ACCOUNT_KEY).
//  - El conocimiento es general: se comparte entre organizaciones (Piedra Negra y Pirka).
//  - Subir un archivo a la carpeta de un asesor equivale a asignárselo. Si se borra de Drive, se olvida en la próxima sincronización.
//  - Tope de espacio: ASESORES_MAX_MB (default 40) de texto en total; lo que no entra se informa, no se corta en silencio.
//  - Cada asesor tiene su propio tope mensual en dólares (dentro del tope general de ia.js). Se mide por el campo "uso" de ia_uso.
//  - Los asesores solo SUGIEREN en esta etapa: no crean tareas ni tocan datos (eso es la etapa 2).
//
// Variables de entorno (todas opcionales):
//   GOOGLE_SERVICE_ACCOUNT_KEY     JSON de la cuenta de servicio (ya existe por el Calendar)
//   ASESORES_DRIVE_FOLDER_ID       id de la carpeta raíz; si falta se busca por nombre ("Asesores IA") entre lo compartido con la cuenta
//   ASESORES_MAX_MB                tope de texto guardado (default 40)
//   ASESORES_SYNC_HORA             hora argentina de la sincronización nocturna (default 3)
//
// Rutas (/api/asesores, solo Administrador): GET /estado, POST /sincronizar, PUT /config/:key, POST /preguntar.
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');
const ia = require('./ia');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const COL_ARCHIVOS = 'asesores_archivos';
const COL_FRAGMENTOS = 'asesores_fragmentos';
const COL_CONFIG = 'asesores_config';
const SYNC_ID = 'asesoresDriveSync';
const AMBITO_TIENDA = 'tienda'; // productos de la tienda online (Tiendanube): los leen todos los asesores
const NOMBRE_RAIZ = 'Asesores IA';
const MAX_ARCHIVO_BYTES = 15 * 1024 * 1024;
const MAX_ARCHIVOS_POR_CARPETA = 300;
const TAM_FRAGMENTO = 1200, SOLAPE = 150;

// Definición base de los asesores. El tope y el "activo" se pueden cambiar desde la pantalla (se guardan en asesores_config).
const ASESORES = {
  ventas: {
    key: 'ventas', nombre: 'Asesor de ventas', carpeta: 'Ventas', topeUsdMes: 15, mensajeCliente: true,
    rol: 'Sos el asesor de ventas de un grupo de venta de cerámicos y materiales de construcción de Argentina. Ayudás al vendedor a ofrecer mejor, resolver dudas de obra y priorizar a quién llamar. Respondés en español rioplatense, claro y breve. Usás SOLO la información de contexto que se te da; si no alcanza para responder con seguridad, decilo y sugerí consultar. No inventás precios, stock ni datos técnicos.'
  },
  vl: {
    key: 'vl', nombre: 'Asesor de VL', carpeta: 'VL', topeUsdMes: 10, mensajeCliente: true,
    rol: 'Sos el asesor de la VL (rol comercial que saca visitas a obras y las convierte en ventas). Ayudás a ordenar a quién contactar, qué visitas quedaron sin presupuesto o sin cierre y cómo mejorar la conversión. Respondés en español rioplatense, claro y breve. Usás SOLO la información de contexto que se te da; si no alcanza, decilo.'
  },
  administrador: {
    key: 'administrador', nombre: 'Asesor del administrador', carpeta: 'Administrador', topeUsdMes: 15,
    rol: 'Sos el asesor estratégico del administrador de un grupo de venta de materiales de construcción. Ayudás a decidir con criterio de negocio: márgenes, rotación, tendencias, stock, flujo de fondos, qué empujar y qué cortar. Respondés en español rioplatense, directo, con números cuando los haya y marcando supuestos. Usás SOLO la información de contexto que se te da; si falta, decilo.'
  }
};
const CLAVES = Object.keys(ASESORES);

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
const esAdmin = (req) => !!(req.usuario && req.usuario.rol && req.usuario.rol.protegido);

// ---------------------------------------------------------------------------
// Texto: partir en fragmentos (puro, se prueba sin base ni Drive)
// ---------------------------------------------------------------------------
function normalizarTexto(t) {
  return String(t || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Junta párrafos hasta ~TAM_FRAGMENTO caracteres y arrastra el final del anterior para no cortar ideas por la mitad.
function partirEnFragmentos(texto, tam, solape) {
  tam = tam || TAM_FRAGMENTO; solape = solape == null ? SOLAPE : solape;
  const limpio = normalizarTexto(texto); if (!limpio) return [];
  const piezas = [];
  for (const p of limpio.split(/\n\s*\n/)) {
    let resto = p.trim();
    while (resto.length > tam) { // un párrafo gigante se corta en una frontera de oración o espacio
      let corte = Math.max(resto.lastIndexOf('. ', tam - 2), resto.lastIndexOf('\n', tam - 2), resto.lastIndexOf(' ', tam - 2));
      if (corte < tam * 0.5) corte = tam - 1;
      piezas.push(resto.slice(0, corte + 1).trim()); resto = resto.slice(corte + 1).trim();
    }
    if (resto) piezas.push(resto);
  }
  const out = []; let actual = '';
  for (const p of piezas) {
    if (actual && (actual.length + p.length + 2) > tam) {
      out.push(actual);
      actual = (solape > 0 ? actual.slice(-solape).replace(/^\S*\s/, '') + '\n' : '') + p;
    } else actual = actual ? actual + '\n\n' + p : p;
  }
  if (actual) out.push(actual);
  return out;
}

// ---------------------------------------------------------------------------
// Drive (solo lectura)
// ---------------------------------------------------------------------------
let driveOverride = null, driveCache = null, driveFallo = false;
function driveHabilitado() { return !!(driveOverride || process.env.GOOGLE_SERVICE_ACCOUNT_KEY); }
function getDrive() {
  if (driveOverride) return driveOverride;
  if (driveCache) return driveCache;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw err(400, 'Falta GOOGLE_SERVICE_ACCOUNT_KEY en el servidor (la misma cuenta de servicio del Calendar).');
  if (driveFallo) throw err(400, 'No se pudo inicializar Google Drive: revisá GOOGLE_SERVICE_ACCOUNT_KEY.');
  try {
    const { google } = require('googleapis');
    const cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.JWT({ email: cred.client_email, key: cred.private_key, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    driveCache = google.drive({ version: 'v3', auth });
    return driveCache;
  } catch (e) { driveFallo = true; throw err(400, 'No se pudo inicializar Google Drive: ' + e.message); }
}
function _setDriveParaTests(c) { driveOverride = c; }

const MIME_CARPETA = 'application/vnd.google-apps.folder';
const MIME_DOC = 'application/vnd.google-apps.document';
const MIME_HOJA = 'application/vnd.google-apps.spreadsheet';
const MIME_SLIDES = 'application/vnd.google-apps.presentation';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function mensajeDrive(e) {
  const code = e && (e.code || (e.response && e.response.status));
  const detalle = (e && e.errors && e.errors[0] && e.errors[0].message) || (e && e.message) || '';
  if (code === 403 && /not been used|disabled|accessNotConfigured/i.test(detalle)) return 'La Google Drive API no está habilitada en el proyecto de Google Cloud (APIs y servicios → Biblioteca → Google Drive API → Habilitar).';
  if (code === 401 || /invalid_grant|invalid_client|unauthorized/i.test(detalle)) return 'Google rechazó la cuenta de servicio: revisá GOOGLE_SERVICE_ACCOUNT_KEY.';
  return detalle || 'Error de Google Drive';
}

async function listar(drive, q) {
  const out = []; let pageToken;
  do {
    const r = await drive.files.list({ q, pageSize: 200, pageToken, fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    out.push(...((r.data && r.data.files) || [])); pageToken = r.data && r.data.nextPageToken;
  } while (pageToken && out.length < 2000);
  return out;
}
async function encontrarRaiz(drive) {
  if (process.env.ASESORES_DRIVE_FOLDER_ID) return process.env.ASESORES_DRIVE_FOLDER_ID;
  const c = await listar(drive, `mimeType='${MIME_CARPETA}' and name='${NOMBRE_RAIZ}' and trashed=false`);
  if (!c.length) throw err(404, `La cuenta de servicio no ve ninguna carpeta llamada "${NOMBRE_RAIZ}". Compartila con el email de la cuenta de servicio (rol Lector).`);
  return c[0].id;
}
// Todos los archivos de una carpeta, bajando por subcarpetas (hasta 3 niveles).
async function archivosDeCarpeta(drive, carpetaId, nivel) {
  const hijos = await listar(drive, `'${carpetaId}' in parents and trashed=false`);
  let out = hijos.filter(f => f.mimeType !== MIME_CARPETA);
  if ((nivel || 0) < 3) for (const sub of hijos.filter(f => f.mimeType === MIME_CARPETA)) out = out.concat(await archivosDeCarpeta(drive, sub.id, (nivel || 0) + 1));
  return out;
}
async function bajarBuffer(drive, fileId) {
  const r = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}
async function exportarBuffer(drive, fileId, mimeType) {
  const r = await drive.files.export({ fileId, mimeType }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data);
}

// Planilla → texto: una sección por hoja, filas separadas por " | ". Tope de filas para que una base enorme no llene el espacio.
function planillaATexto(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const partes = [];
  for (const nombre of wb.SheetNames) {
    const filas = XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, blankrows: false, defval: '' });
    if (!filas.length) continue;
    partes.push('## Hoja: ' + nombre + '\n' + filas.slice(0, 3000).map(f => f.map(c => String(c).trim()).join(' | ')).join('\n'));
  }
  return partes.join('\n\n');
}

// Devuelve { texto } o { estado: 'sin_texto' | 'no_soportado', error }.
async function extraerTexto(drive, f) {
  const nombre = String(f.name || ''), mime = f.mimeType || '';
  const ext = (nombre.split('.').pop() || '').toLowerCase();
  if (mime === MIME_DOC) return { texto: (await exportarBuffer(drive, f.id, 'text/plain')).toString('utf8') };
  if (mime === MIME_SLIDES) return { texto: (await exportarBuffer(drive, f.id, 'text/plain')).toString('utf8') };
  if (mime === MIME_HOJA) return { texto: planillaATexto(await exportarBuffer(drive, f.id, MIME_XLSX)) };
  if (mime.startsWith('application/vnd.google-apps.')) return { estado: 'no_soportado', error: 'Tipo de Google no soportado (' + mime.replace('application/vnd.google-apps.', '') + ').' };
  if (Number(f.size) > MAX_ARCHIVO_BYTES) return { estado: 'no_soportado', error: 'El archivo pesa más de 15 MB.' };
  if (mime === 'application/pdf' || ext === 'pdf') {
    const buf = await bajarBuffer(drive, f.id);
    const r = await require('pdf-parse')(buf);
    const t = normalizarTexto(r.text);
    if (t.length < 50) return { estado: 'sin_texto', error: 'El PDF no tiene texto (parece escaneado). Hace falta una versión con texto o su transcripción.' };
    return { texto: t };
  }
  if (mime === MIME_DOCX || ext === 'docx') return { texto: (await require('mammoth').extractRawText({ buffer: await bajarBuffer(drive, f.id) })).value };
  if (mime === MIME_XLSX || ['xlsx', 'xls', 'csv'].includes(ext)) return { texto: planillaATexto(await bajarBuffer(drive, f.id)) };
  if (mime.startsWith('text/') || ['txt', 'md', 'json'].includes(ext)) return { texto: (await bajarBuffer(drive, f.id)).toString('utf8') };
  return { estado: 'no_soportado', error: 'Formato no soportado (' + (ext || mime) + '). Videos e imágenes no se leen: subí la transcripción en texto.' };
}

// ---------------------------------------------------------------------------
// Sincronización
// ---------------------------------------------------------------------------
async function asegurarIndices(db) {
  await db.collection(COL_FRAGMENTOS).createIndex({ texto: 'text', archivo: 'text' }, { name: 'texto_es', default_language: 'spanish', language_override: 'idioma_texto' }).catch(() => {});
  await db.collection(COL_FRAGMENTOS).createIndex({ fileId: 1 }).catch(() => {});
  await db.collection(COL_FRAGMENTOS).createIndex({ ambito: 1 }).catch(() => {});
  await db.collection(COL_ARCHIVOS).createIndex({ fileId: 1 }, { unique: true }).catch(() => {});
}
const maxBytesTexto = () => Math.round((Number(process.env.ASESORES_MAX_MB) || 40) * 1048576);

// opciones.forzar: relee todo aunque no haya cambiado. Devuelve el resumen que también se guarda en configuracion/SYNC_ID.
async function sincronizar(db, opciones) {
  opciones = opciones || {};
  const t0 = Date.now();
  const drive = getDrive();
  await asegurarIndices(db);
  const resumen = { leidos: 0, sinCambios: 0, errores: 0, omitidosPorEspacio: 0, borrados: 0, archivos: 0, porAmbito: {} };
  let raiz;
  try {
    raiz = await encontrarRaiz(drive);
  } catch (e) { throw e.status ? e : err(502, mensajeDrive(e)); }

  let subcarpetas;
  try { subcarpetas = (await listar(drive, `'${raiz}' in parents and mimeType='${MIME_CARPETA}' and trashed=false`)); } catch (e) { throw err(502, mensajeDrive(e)); }
  const porNombre = new Map(subcarpetas.map(c => [String(c.name).trim().toLowerCase(), c.id]));
  const ambitos = CLAVES.map(k => ({ ambito: k, nombre: ASESORES[k].carpeta })).concat([{ ambito: 'compartido', nombre: 'Compartido' }]);

  // El espacio del conocimiento de Drive se mide aparte del de la tienda online (que tiene su propio tope).
  const usadoRes = await db.collection(COL_FRAGMENTOS).aggregate([{ $match: { ambito: { $ne: AMBITO_TIENDA } } }, { $group: { _id: null, b: { $sum: '$bytes' } } }]).toArray();
  let usadoBytes = usadoRes[0] ? usadoRes[0].b : 0;
  const tope = maxBytesTexto();

  for (const a of ambitos) {
    const carpetaId = porNombre.get(a.nombre.toLowerCase());
    resumen.porAmbito[a.ambito] = { carpeta: !!carpetaId, archivos: 0 };
    if (!carpetaId) continue; // si no existe la carpeta no se borra nada: puede ser un error pasajero o un cambio de nombre
    let archivos;
    try { archivos = (await archivosDeCarpeta(drive, carpetaId)).slice(0, MAX_ARCHIVOS_POR_CARPETA); } catch (e) { throw err(502, mensajeDrive(e)); }
    const vistos = new Set();
    for (const f of archivos) {
      vistos.add(f.id); resumen.archivos++; resumen.porAmbito[a.ambito].archivos++;
      const previo = await db.collection(COL_ARCHIVOS).findOne({ fileId: f.id });
      if (previo && !opciones.forzar && previo.modifiedTime === f.modifiedTime && previo.ambito === a.ambito && previo.estado !== 'error') { resumen.sinCambios++; continue; }
      const base = { fileId: f.id, nombre: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, ambito: a.ambito, syncAt: new Date() };
      try {
        const ex = await extraerTexto(drive, f);
        if (!ex.texto) {
          await db.collection(COL_FRAGMENTOS).deleteMany({ fileId: f.id });
          await db.collection(COL_ARCHIVOS).updateOne({ fileId: f.id }, { $set: Object.assign(base, { estado: ex.estado || 'sin_texto', error: ex.error || 'Sin texto', fragmentos: 0, chars: 0 }) }, { upsert: true });
          resumen.errores++; continue;
        }
        const trozos = partirEnFragmentos(ex.texto);
        const bytesNuevos = trozos.reduce((s, t) => s + Buffer.byteLength(t, 'utf8'), 0);
        const bytesViejos = previo ? ((await db.collection(COL_FRAGMENTOS).aggregate([{ $match: { fileId: f.id } }, { $group: { _id: null, b: { $sum: '$bytes' } } }]).toArray())[0] || { b: 0 }).b : 0;
        if (usadoBytes - bytesViejos + bytesNuevos > tope) {
          await db.collection(COL_ARCHIVOS).updateOne({ fileId: f.id }, { $set: Object.assign(base, { estado: 'sin_espacio', error: 'No entra en el tope de espacio para conocimiento (' + Math.round(tope / 1048576) + ' MB). Subí el tope o borrá archivos viejos.', fragmentos: 0, chars: 0 }) }, { upsert: true });
          resumen.omitidosPorEspacio++; continue;
        }
        await db.collection(COL_FRAGMENTOS).deleteMany({ fileId: f.id });
        if (trozos.length) await db.collection(COL_FRAGMENTOS).insertMany(trozos.map((t, i) => ({ fileId: f.id, archivo: f.name, ambito: a.ambito, n: i, texto: t, bytes: Buffer.byteLength(t, 'utf8') })));
        usadoBytes = usadoBytes - bytesViejos + bytesNuevos;
        await db.collection(COL_ARCHIVOS).updateOne({ fileId: f.id }, { $set: Object.assign(base, { estado: 'ok', error: null, fragmentos: trozos.length, chars: ex.texto.length }) }, { upsert: true });
        resumen.leidos++;
      } catch (e) {
        await db.collection(COL_ARCHIVOS).updateOne({ fileId: f.id }, { $set: Object.assign(base, { estado: 'error', error: mensajeDrive(e).slice(0, 300) }) }, { upsert: true });
        resumen.errores++;
      }
    }
    // Lo que estaba en esta carpeta y ya no está en Drive se olvida.
    const huerfanos = await db.collection(COL_ARCHIVOS).find({ ambito: a.ambito, fileId: { $nin: Array.from(vistos) } }).project({ fileId: 1 }).toArray();
    if (huerfanos.length) {
      const ids = huerfanos.map(h => h.fileId);
      await db.collection(COL_FRAGMENTOS).deleteMany({ fileId: { $in: ids } });
      await db.collection(COL_ARCHIVOS).deleteMany({ fileId: { $in: ids } });
      resumen.borrados += ids.length;
    }
  }
  resumen.ms = Date.now() - t0;
  return resumen;
}

// ---------------------------------------------------------------------------
// Tienda online (pedido de Mato, 2/11/2026): los asesores también conocen los productos publicados en piedranegra.com.ar
// (Tiendanube). Se leen por la API de la tienda que el sistema ya tiene conectada (TIENDA_REAL_STORE_ID) y se guardan como
// fragmentos de ámbito "tienda": nombre, marca, categorías, descripción y LINK. NO se guardan precios ni stock: esos
// salen del sistema (precios finales, stock "disponible / consultar") y no de la tienda.
//   ASESORES_TIENDA_MAX_MB   tope de texto de la tienda (default 10)
//   ASESORES_TIENDA_DOMINIO  dominio para armar links si la API no trae la URL (default piedranegra.com.ar)
// ---------------------------------------------------------------------------
let tiendaOverride = null;
const tiendaConfigurada = () => !!(tiendaOverride || process.env.TIENDA_REAL_STORE_ID);
function _setTiendaParaTests(o) { tiendaOverride = o; }
const tiendaMaxBytes = () => Math.round((Number(process.env.ASESORES_TIENDA_MAX_MB) || 10) * 1048576);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ENTIDADES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', deg: '°', sup2: '²', sup3: '³', times: '×', ndash: '–', mdash: '—', hellip: '…', bull: '•', laquo: '«', raquo: '»' };
// Descripción de Tiendanube (HTML) → texto plano con saltos de línea y viñetas.
function htmlATexto(html) {
  return normalizarTexto(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|tr|ul|ol)>/gi, '\n\n').replace(/<li[^>]*>/gi, '\n- ').replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d{1,5});/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch (e) { return ' '; } })
    .replace(/&#x([0-9a-f]{1,5});/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ' '; } })
    .replace(/&([a-zA-Z0-9]+);/g, (m, n) => (n in ENTIDADES ? ENTIDADES[n] : ' '))
    .replace(/[ \t]{2,}/g, ' '));
}
const locTexto = (c) => (!c ? '' : (typeof c === 'string' ? c : (c.es || Object.values(c)[0] || '')));
// Un producto de Tiendanube → { nombre, url, cuerpo } (sin precios ni stock).
function textoProductoTienda(p, dominio) {
  const nombre = String(locTexto(p.name)).trim(); if (!nombre) return null;
  const handle = locTexto(p.handle);
  const url = p.canonical_url || ((dominio && handle) ? 'https://' + dominio + '/productos/' + handle : '');
  const cats = (p.categories || []).map(c => String(locTexto(c.name)).trim()).filter(Boolean);
  const marca = String(locTexto(p.brand)).trim();
  const desc = htmlATexto(locTexto(p.description)).slice(0, 4000);
  const cuerpo = [marca ? 'Marca: ' + marca : '', cats.length ? 'Categorías: ' + cats.join(', ') : '', desc].filter(Boolean).join('\n\n');
  return { nombre, url, cuerpo };
}
// Todos los productos de la tienda (páginas de 200), con reintento si Tiendanube pide ir más despacio (429).
async function traerProductosTienda() {
  if (tiendaOverride) return { dominio: tiendaOverride.dominio, productos: await tiendaOverride.traer() };
  const cotizador = require('./cotizador');
  const store = await cotizador.getStoreById(process.env.TIENDA_REAL_STORE_ID);
  if (!store || !store.access_token) throw err(400, 'La tienda de Tiendanube no tiene un token de acceso válido.');
  const campos = 'id,name,handle,description,categories,brand,published,canonical_url,updated_at';
  const productos = [];
  for (let page = 1; page <= 100; page++) {
    let r, intentos = 0;
    for (;;) {
      r = await fetch(cotizador.API_BASE + '/' + store.store_id + '/products?per_page=200&page=' + page + '&fields=' + campos, { headers: cotizador.apiHeaders(store.access_token) });
      if (r.status === 429 && intentos < 4) { intentos++; await sleep(1500 * intentos); continue; }
      break;
    }
    if (r.status === 404 && page > 1) break; // Tiendanube responde 404 cuando la página pasa del final
    if (!r.ok) throw err(502, 'Tiendanube respondió ' + r.status + (r.status === 401 ? ' (el token de la tienda no es válido)' : ''));
    const pagina = await r.json().catch(() => null);
    if (!Array.isArray(pagina) || !pagina.length) break;
    productos.push(...pagina);
    if (pagina.length < 200) break;
  }
  return { dominio: process.env.ASESORES_TIENDA_DOMINIO || store.domain || 'piedranegra.com.ar', productos };
}
// Sincroniza los productos publicados. Solo relee los que cambiaron (updated_at) y olvida los que ya no están publicados.
async function sincronizarTienda(db, opciones) {
  opciones = opciones || {}; const t0 = Date.now();
  await asegurarIndices(db);
  const { dominio, productos } = await traerProductosTienda();
  const resumen = { productos: 0, nuevos: 0, sinCambios: 0, borrados: 0, omitidosPorEspacio: 0, sinNombre: 0 };
  const usadoRes = await db.collection(COL_FRAGMENTOS).aggregate([{ $match: { ambito: AMBITO_TIENDA } }, { $group: { _id: null, b: { $sum: '$bytes' } } }]).toArray();
  let usadoBytes = usadoRes[0] ? usadoRes[0].b : 0;
  const tope = tiendaMaxBytes();
  const previos = new Map((await db.collection(COL_ARCHIVOS).find({ ambito: AMBITO_TIENDA }).project({ fileId: 1, modifiedTime: 1, estado: 1, bytes: 1 }).toArray()).map(a => [a.fileId, a]));
  const vistos = new Set();
  let delIds = [], insFr = [], upsArch = [];
  const volcar = async () => { // se graba de a lotes para no hacer miles de idas y vueltas a la base
    if (delIds.length) await db.collection(COL_FRAGMENTOS).deleteMany({ fileId: { $in: delIds } });
    if (insFr.length) await db.collection(COL_FRAGMENTOS).insertMany(insFr);
    if (upsArch.length) await db.collection(COL_ARCHIVOS).bulkWrite(upsArch.map(a => ({ updateOne: { filter: { fileId: a.fileId }, update: { $set: a }, upsert: true } })));
    delIds = []; insFr = []; upsArch = [];
    if (typeof opciones.latido === 'function') await opciones.latido();
  };
  for (const p of productos) {
    if (p.published === false) continue;
    const t = textoProductoTienda(p, dominio); if (!t) { resumen.sinNombre++; continue; }
    const fileId = 'tn:' + p.id; vistos.add(fileId); resumen.productos++;
    const previo = previos.get(fileId), mod = String(p.updated_at || '');
    if (previo && !opciones.forzar && previo.modifiedTime === mod && previo.estado === 'ok') { resumen.sinCambios++; continue; }
    const cabecera = 'Producto: ' + t.nombre + (t.url ? ' — ' + t.url : '');
    const trozos = (t.cuerpo ? partirEnFragmentos(t.cuerpo) : ['(La tienda no tiene descripción cargada para este producto.)']).map(x => cabecera + '\n' + x);
    const bytesNuevos = trozos.reduce((s, x) => s + Buffer.byteLength(x, 'utf8'), 0), bytesViejos = previo ? (previo.bytes || 0) : 0;
    if (usadoBytes - bytesViejos + bytesNuevos > tope) { resumen.omitidosPorEspacio++; continue; } // el producto viejo, si estaba, se conserva
    if (previo) delIds.push(fileId);
    trozos.forEach((x, i) => insFr.push({ fileId, archivo: t.nombre, ambito: AMBITO_TIENDA, n: i, texto: x, bytes: Buffer.byteLength(x, 'utf8') }));
    upsArch.push({ fileId, nombre: t.nombre, mimeType: 'tiendanube/producto', modifiedTime: mod, ambito: AMBITO_TIENDA, url: t.url, estado: 'ok', error: null, fragmentos: trozos.length, chars: t.cuerpo.length, bytes: bytesNuevos, syncAt: new Date() });
    usadoBytes = usadoBytes - bytesViejos + bytesNuevos; resumen.nuevos++;
    if (insFr.length >= 400) await volcar();
  }
  await volcar();
  if (productos.length) { // si la tienda devolvió vacío (error de la API) no se borra nada
    const ids = Array.from(previos.keys()).filter(id => !vistos.has(id));
    if (ids.length) { await db.collection(COL_FRAGMENTOS).deleteMany({ fileId: { $in: ids } }); await db.collection(COL_ARCHIVOS).deleteMany({ fileId: { $in: ids } }); resumen.borrados = ids.length; }
  }
  resumen.ms = Date.now() - t0;
  return resumen;
}

async function guardarEstadoSync(db, set) { await db.collection('configuracion').updateOne({ _id: SYNC_ID }, { $set: set }, { upsert: true }); }
// Un solo proceso a la vez (candado de 15 min, que se renueva mientras la sincronización avanza).
async function tomarCandado(db) {
  const hace15 = new Date(Date.now() - 15 * 60000);
  const r = await db.collection('configuracion').updateOne({ _id: SYNC_ID, $or: [{ corriendoDesde: { $exists: false } }, { corriendoDesde: null }, { corriendoDesde: { $lt: hace15 } }] }, { $set: { corriendoDesde: new Date() } }, { upsert: true }).catch(e => { if (e && e.code === 11000) return { modifiedCount: 0, upsertedCount: 0 }; throw e; });
  if (!r.modifiedCount && !r.upsertedCount) throw err(409, 'Ya hay una sincronización en curso. Esperá unos minutos.');
}
// Corre Drive y la tienda (cada una por su lado: si una falla, la otra igual se actualiza) y deja el resultado guardado.
// Hay que haber tomado el candado antes (tomarCandado).
async function ejecutarSincronizacion(db, opciones) {
  opciones = Object.assign({}, opciones, { latido: () => guardarEstadoSync(db, { corriendoDesde: new Date() }) });
  const out = { drive: null, driveError: null, tienda: null, tiendaError: null };
  try {
    if (driveHabilitado()) {
      try { out.drive = await sincronizar(db, opciones); await guardarEstadoSync(db, { okAt: new Date(), error: null, errorAt: null, resumen: out.drive }); }
      catch (e) { out.driveError = e.message; await guardarEstadoSync(db, { error: e.message, errorAt: new Date() }).catch(() => {}); }
    }
    if (tiendaConfigurada()) {
      try { out.tienda = await sincronizarTienda(db, opciones); await guardarEstadoSync(db, { tiendaOkAt: new Date(), tiendaError: null, tiendaErrorAt: null, tiendaResumen: out.tienda }); }
      catch (e) { out.tiendaError = e.message; await guardarEstadoSync(db, { tiendaError: e.message, tiendaErrorAt: new Date() }).catch(() => {}); }
    }
  } finally { await guardarEstadoSync(db, { corriendoDesde: null }).catch(() => {}); }
  return out;
}
async function sincronizarYRegistrar(db, opciones) { await tomarCandado(db); return ejecutarSincronizacion(db, opciones); }
const horaAR = () => new Date(Date.now() - 3 * 3600000).getUTCHours();
// Una vez por día, a la hora configurada (default 3 de la mañana). Se revisa cada 30 min y también al abrir la pantalla.
async function sincronizacionNocturna(db) {
  if (!driveHabilitado() && !tiendaConfigurada()) return;
  const ult = await db.collection('configuracion').findOne({ _id: SYNC_ID });
  const ultima = ult ? Math.max(ult.okAt ? new Date(ult.okAt).getTime() : 0, ult.tiendaOkAt ? new Date(ult.tiendaOkAt).getTime() : 0) : 0;
  if (Date.now() - ultima < 20 * 3600000) return;
  if (ultima && horaAR() < (Number(process.env.ASESORES_SYNC_HORA) || 3)) return;
  try { await sincronizarYRegistrar(db); } catch (e) { if (e.status !== 409) console.error('[asesores] sincronización nocturna:', e.message); }
}
if (process.env.MONGODB_URI && process.env.NODE_ENV !== 'test') setInterval(async () => { try { await sincronizacionNocturna(await getDb()); } catch (e) { /* sin base o sin Drive: se reintenta */ } }, 30 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Búsqueda y consulta (la usan la pantalla de prueba y, desde la etapa 2, cada asesor)
// ---------------------------------------------------------------------------
// Fragmentos más relevantes para la consulta: los de la carpeta del asesor y de Compartido (k) más los productos de la tienda
// online (hasta 3, en una búsqueda aparte para que los productos no desplacen a los cursos y viceversa).
async function buscar(db, asesorKey, consulta, k, kTienda) {
  const q = String(consulta || '').trim(); if (!q) return [];
  const proy = { projection: { score: { $meta: 'textScore' }, texto: 1, archivo: 1, ambito: 1, n: 1 } };
  const por = (ambito, n) => db.collection(COL_FRAGMENTOS).find({ $text: { $search: q }, ambito }, proy).sort({ score: { $meta: 'textScore' } }).limit(n).toArray();
  const [conocimiento, tienda] = await Promise.all([por({ $in: [asesorKey, 'compartido'] }, k || 5), por(AMBITO_TIENDA, kTienda == null ? 3 : kTienda)]);
  return conocimiento.concat(tienda);
}
async function configDe(db, key) {
  const base = ASESORES[key]; if (!base) return null;
  const guardada = (await db.collection(COL_CONFIG).findOne({ _id: key })) || {};
  return Object.assign({}, base, { topeUsdMes: guardada.topeUsdMes != null ? Number(guardada.topeUsdMes) : base.topeUsdMes, activo: guardada.activo !== false });
}
async function gastoDelMes(db, key) {
  const r = await db.collection('ia_uso').aggregate([{ $match: { uso: 'asesor:' + key, at: { $gte: ia._interno.inicioMes() } } }, { $group: { _id: null, total: { $sum: '$costoUsd' }, llamadas: { $sum: 1 } } }]).toArray();
  return { usd: r[0] ? r[0].total : 0, llamadas: r[0] ? r[0].llamadas : 0 };
}
// Mensaje modelo para el cliente (pedido de Mato, 2/11/2026): los asesores comerciales, además de explicarle al vendedor,
// proponen un texto listo para mandar por WhatsApp. Va separado de la explicación con una marca fija para poder mostrarlo aparte.
const MARCA_MENSAJE = '=== MENSAJE PARA EL CLIENTE ===';
const INSTRUCCION_MENSAJE = '\n\nMensaje para el cliente: si la consulta es para responderle o contactar a un cliente, después de tu respuesta escribí en una línea sola exactamente ' + MARCA_MENSAJE + ' y debajo un mensaje listo para enviar por WhatsApp. Reglas del mensaje: en español rioplatense, cordial y breve (2 a 5 líneas), escrito como lo mandaría el vendedor (primera persona, sin saludos largos); *negrita* de WhatsApp con un solo asterisco solo si hace falta; sin citas [n], sin listas largas ni datos internos; usá solo información del contexto, sin inventar precios, stock ni plazos (si hace falta un dato que no tenés, dejalo entre corchetes para completar, por ejemplo [precio]); si en el contexto está el link de la tienda online del producto que recomendás, podés incluirlo. Si la consulta es solo una duda interna del vendedor y no hay nada para mandarle al cliente, no escribas la marca ni el mensaje.';
const INSTRUCCION_TIENDA = '\n\nLos fragmentos marcados "Tienda online" son descripciones públicas de productos de piedranegra.com.ar, con su link. Sirven para saber qué productos existen, sus características y compartir el link (copiado tal cual del contexto, nunca inventes uno). NO tienen precios ni stock confiables: si piden precio o disponibilidad, decí que hay que consultarlo en el sistema.';
// Separa { respuesta, mensajeCliente } y deja el mensaje en formato WhatsApp (sin citas, negrita simple).
function separarMensajeCliente(texto) {
  const t = String(texto || '');
  const i = t.search(/={3,}\s*MENSAJE PARA EL CLIENTE\s*={3,}/i);
  if (i < 0) return { respuesta: t.trim(), mensajeCliente: '' };
  const respuesta = t.slice(0, i).trim();
  const msg = t.slice(i).replace(/^={3,}\s*MENSAJE PARA EL CLIENTE\s*={3,}/i, '')
    .replace(/\s*\[\d{1,2}\]/g, '').replace(/\*\*(.+?)\*\*/g, '*$1*').trim().replace(/^["“”]+|["“”]+$/g, '').trim();
  return { respuesta, mensajeCliente: msg };
}
// Pregunta a un asesor con su conocimiento. Respeta el tope propio del asesor.
async function preguntar(db, key, pregunta, orgId) {
  const cfg = await configDe(db, key); if (!cfg) throw err(404, 'Asesor desconocido.');
  if (!cfg.activo) throw err(409, 'Este asesor está desactivado.');
  const p = String(pregunta || '').trim(); if (!p) throw err(400, 'Escribí una pregunta.');
  if (cfg.topeUsdMes > 0) { const g = await gastoDelMes(db, key); if (g.usd >= cfg.topeUsdMes) throw err(429, 'El asesor llegó a su tope mensual (US$ ' + cfg.topeUsdMes + ').', { tope: true }); }
  const frs = await buscar(db, key, p, 5, 3);
  const hayTienda = frs.some(f => f.ambito === AMBITO_TIENDA);
  const contexto = frs.length ? frs.map((f, i) => `[${i + 1}] (${f.ambito === AMBITO_TIENDA ? 'Tienda online' : f.archivo})\n${f.texto}`).join('\n\n---\n\n') : '(No se encontró información cargada sobre esto.)';
  const r = await ia.generar({
    uso: 'asesor:' + key, orgId: orgId || null, temperatura: 0.2, maxTokens: cfg.mensajeCliente ? 1200 : 900,
    sistema: cfg.rol + '\n\nFormato de la respuesta: ordenada y fácil de leer en pantalla. Párrafos cortos separados por una línea en blanco; si hay pasos o varias opciones, una lista (con "- " o "1. "); **negrita** solo para lo clave (productos, cantidades, advertencias). Sin títulos largos ni relleno. Empezá por la respuesta directa.' + (cfg.mensajeCliente ? INSTRUCCION_MENSAJE : '') + (hayTienda ? INSTRUCCION_TIENDA : '') + '\n\nInformación de contexto cargada por la empresa (cursos, fichas, normas). Citá el número [n] del fragmento cuando te apoyes en uno:\n\n' + contexto,
    mensajes: [{ role: 'user', text: p }]
  });
  const partes = cfg.mensajeCliente ? separarMensajeCliente(r.texto) : { respuesta: String(r.texto || '').trim(), mensajeCliente: '' };
  return { respuesta: partes.respuesta, mensajeCliente: partes.mensajeCliente, fuentes: Array.from(new Set(frs.map(f => (f.ambito === AMBITO_TIENDA ? 'Tienda: ' : '') + f.archivo))), fragmentosUsados: frs.length, costoUsd: r.costoUsd, modelo: r.modelo };
}

// ---------------------------------------------------------------------------
// Rutas (solo Administrador)
// ---------------------------------------------------------------------------
function soloAdmin(req, res, next) { if (!esAdmin(req)) return res.status(403).json({ error: 'Solo un administrador puede gestionar los asesores.' }); next(); }

router.get('/estado', authUsuario, soloAdmin, async (req, res) => {
  try {
    const db = await getDb();
    sincronizacionNocturna(db).catch(() => {}); // si pasó más de un día, se actualiza en segundo plano
    const [ult, archivos, usoPorAmbito, productosTienda] = await Promise.all([
      db.collection('configuracion').findOne({ _id: SYNC_ID }),
      db.collection(COL_ARCHIVOS).find({ ambito: { $ne: AMBITO_TIENDA } }).project({ _id: 0 }).sort({ ambito: 1, nombre: 1 }).toArray(), // los productos de la tienda no se listan uno por uno
      db.collection(COL_FRAGMENTOS).aggregate([{ $group: { _id: '$ambito', bytes: { $sum: '$bytes' }, n: { $sum: 1 } } }]).toArray(),
      db.collection(COL_ARCHIVOS).countDocuments({ ambito: AMBITO_TIENDA })
    ]);
    const sumar = (filas) => filas.reduce((s, f) => ({ bytes: s.bytes + (f.bytes || 0), n: s.n + (f.n || 0) }), { bytes: 0, n: 0 });
    const uso = [sumar(usoPorAmbito.filter(f => f._id !== AMBITO_TIENDA))], usoTienda = sumar(usoPorAmbito.filter(f => f._id === AMBITO_TIENDA));
    const mb = (b) => Math.round((b / 1048576) * 10) / 10;
    const asesores = [];
    for (const k of CLAVES) {
      const cfg = await configDe(db, k); const g = await gastoDelMes(db, k);
      asesores.push({ key: k, nombre: cfg.nombre, carpeta: cfg.carpeta, topeUsdMes: cfg.topeUsdMes, activo: cfg.activo, gastoUsd: Math.round(g.usd * 10000) / 10000, llamadas: g.llamadas, archivos: archivos.filter(a => a.ambito === k).length });
    }
    res.json({
      driveConfigurado: driveHabilitado(),
      sync: ult ? { okAt: ult.okAt || null, error: ult.error || null, errorAt: ult.errorAt || null, corriendo: !!(ult.corriendoDesde && Date.now() - new Date(ult.corriendoDesde).getTime() < 15 * 60000), resumen: ult.resumen || null } : null,
      espacio: { usadoMB: mb(uso[0].bytes), topeMB: Math.round(maxBytesTexto() / 1048576), fragmentos: uso[0].n },
      tienda: {
        configurada: tiendaConfigurada(), productos: productosTienda, fragmentos: usoTienda.n, usadoMB: mb(usoTienda.bytes), topeMB: Math.round(tiendaMaxBytes() / 1048576),
        okAt: (ult && ult.tiendaOkAt) || null, error: (ult && ult.tiendaError) || null, resumen: (ult && ult.tiendaResumen) || null
      },
      asesores, compartido: { archivos: archivos.filter(a => a.ambito === 'compartido').length }, archivos
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/sincronizar', authUsuario, soloAdmin, async (req, res) => {
  try {
    if (!driveHabilitado() && !tiendaConfigurada()) return res.status(400).json({ error: 'Falta GOOGLE_SERVICE_ACCOUNT_KEY (la misma cuenta de servicio del Calendar) y TIENDA_REAL_STORE_ID en el servidor.' });
    const db = await getDb(); await tomarCandado(db); // 409 si ya hay una en curso
    // Se responde enseguida y se sigue en segundo plano: la primera lectura de la tienda puede tardar varios minutos. La pantalla consulta /estado.
    res.json({ ok: true, iniciado: true });
    ejecutarSincronizacion(db, { forzar: !!(req.body && req.body.forzar) }).catch(e => console.error('[asesores] sincronización:', e.message));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config/:key', authUsuario, soloAdmin, async (req, res) => {
  try {
    const key = req.params.key; if (!ASESORES[key]) return res.status(404).json({ error: 'Asesor desconocido.' });
    const set = { updatedAt: new Date() }; const b = req.body || {};
    if (b.topeUsdMes !== undefined) { const v = Number(b.topeUsdMes); if (!isFinite(v) || v < 0 || v > 1000) return res.status(400).json({ error: 'Tope inválido.' }); set.topeUsdMes = v; }
    if (b.activo !== undefined) set.activo = !!b.activo;
    await (await getDb()).collection(COL_CONFIG).updateOne({ _id: key }, { $set: set }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/preguntar', authUsuario, soloAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await preguntar(await getDb(), String(b.asesor || ''), b.pregunta, req.orgId || null));
  } catch (e) { res.status(e.status || (e.sinClave ? 503 : 500)).json({ error: e.message, tope: !!e.tope }); }
});

module.exports = router;
module.exports.ASESORES = ASESORES;
module.exports.buscar = buscar;
module.exports.preguntar = preguntar;
module.exports.configDe = configDe;
module.exports._interno = { sincronizarTienda, htmlATexto, textoProductoTienda, _setTiendaParaTests, separarMensajeCliente, partirEnFragmentos, normalizarTexto, planillaATexto, extraerTexto, sincronizar, _setDriveParaTests, mensajeDrive };
