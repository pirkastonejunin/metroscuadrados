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
const NOMBRE_RAIZ = 'Asesores IA';
const MAX_ARCHIVO_BYTES = 15 * 1024 * 1024;
const MAX_ARCHIVOS_POR_CARPETA = 300;
const TAM_FRAGMENTO = 1200, SOLAPE = 150;

// Definición base de los asesores. El tope y el "activo" se pueden cambiar desde la pantalla (se guardan en asesores_config).
const ASESORES = {
  ventas: {
    key: 'ventas', nombre: 'Asesor de ventas', carpeta: 'Ventas', topeUsdMes: 15,
    rol: 'Sos el asesor de ventas de un grupo de venta de cerámicos y materiales de construcción de Argentina. Ayudás al vendedor a ofrecer mejor, resolver dudas de obra y priorizar a quién llamar. Respondés en español rioplatense, claro y breve. Usás SOLO la información de contexto que se te da; si no alcanza para responder con seguridad, decilo y sugerí consultar. No inventás precios, stock ni datos técnicos.'
  },
  vl: {
    key: 'vl', nombre: 'Asesor de VL', carpeta: 'VL', topeUsdMes: 10,
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

  const usadoRes = await db.collection(COL_FRAGMENTOS).aggregate([{ $group: { _id: null, b: { $sum: '$bytes' } } }]).toArray();
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

async function guardarEstadoSync(db, set) { await db.collection('configuracion').updateOne({ _id: SYNC_ID }, { $set: set }, { upsert: true }); }
// Corre una sincronización dejando el resultado guardado. Un solo proceso a la vez (candado de 15 min).
async function sincronizarYRegistrar(db, opciones) {
  const hace15 = new Date(Date.now() - 15 * 60000);
  const r = await db.collection('configuracion').updateOne({ _id: SYNC_ID, $or: [{ corriendoDesde: { $exists: false } }, { corriendoDesde: null }, { corriendoDesde: { $lt: hace15 } }] }, { $set: { corriendoDesde: new Date() } }, { upsert: true }).catch(e => { if (e && e.code === 11000) return { modifiedCount: 0, upsertedCount: 0 }; throw e; });
  if (!r.modifiedCount && !r.upsertedCount) throw err(409, 'Ya hay una sincronización en curso. Esperá unos minutos.');
  try {
    const resumen = await sincronizar(db, opciones);
    await guardarEstadoSync(db, { okAt: new Date(), error: null, errorAt: null, resumen, corriendoDesde: null });
    return resumen;
  } catch (e) {
    await guardarEstadoSync(db, { error: e.message, errorAt: new Date(), corriendoDesde: null }).catch(() => {});
    throw e;
  }
}
const horaAR = () => new Date(Date.now() - 3 * 3600000).getUTCHours();
// Una vez por día, a la hora configurada (default 3 de la mañana). Se revisa cada 30 min y también al abrir la pantalla.
async function sincronizacionNocturna(db) {
  if (!driveHabilitado()) return;
  const ult = await db.collection('configuracion').findOne({ _id: SYNC_ID });
  const pasaron = ult && ult.okAt ? (Date.now() - new Date(ult.okAt).getTime()) : Infinity;
  if (pasaron < 20 * 3600000) return;
  if (ult && ult.okAt && horaAR() < (Number(process.env.ASESORES_SYNC_HORA) || 3)) return;
  try { await sincronizarYRegistrar(db); } catch (e) { if (e.status !== 409) console.error('[asesores] sincronización nocturna:', e.message); }
}
if (process.env.MONGODB_URI && process.env.NODE_ENV !== 'test') setInterval(async () => { try { await sincronizacionNocturna(await getDb()); } catch (e) { /* sin base o sin Drive: se reintenta */ } }, 30 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Búsqueda y consulta (la usan la pantalla de prueba y, desde la etapa 2, cada asesor)
// ---------------------------------------------------------------------------
// Fragmentos más relevantes para la consulta, de la carpeta del asesor y de Compartido.
async function buscar(db, asesorKey, consulta, k) {
  const q = String(consulta || '').trim(); if (!q) return [];
  const filtro = { $text: { $search: q }, ambito: { $in: [asesorKey, 'compartido'] } };
  return db.collection(COL_FRAGMENTOS).find(filtro, { projection: { score: { $meta: 'textScore' }, texto: 1, archivo: 1, ambito: 1, n: 1 } }).sort({ score: { $meta: 'textScore' } }).limit(k || 6).toArray();
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
// Pregunta a un asesor con su conocimiento. Respeta el tope propio del asesor.
async function preguntar(db, key, pregunta, orgId) {
  const cfg = await configDe(db, key); if (!cfg) throw err(404, 'Asesor desconocido.');
  if (!cfg.activo) throw err(409, 'Este asesor está desactivado.');
  const p = String(pregunta || '').trim(); if (!p) throw err(400, 'Escribí una pregunta.');
  if (cfg.topeUsdMes > 0) { const g = await gastoDelMes(db, key); if (g.usd >= cfg.topeUsdMes) throw err(429, 'El asesor llegó a su tope mensual (US$ ' + cfg.topeUsdMes + ').', { tope: true }); }
  const frs = await buscar(db, key, p, 6);
  const contexto = frs.length ? frs.map((f, i) => `[${i + 1}] (${f.archivo})\n${f.texto}`).join('\n\n---\n\n') : '(No se encontró información cargada sobre esto.)';
  const r = await ia.generar({
    uso: 'asesor:' + key, orgId: orgId || null, temperatura: 0.2, maxTokens: 900,
    sistema: cfg.rol + '\n\nInformación de contexto cargada por la empresa (cursos, fichas, normas). Citá el número [n] del fragmento cuando te apoyes en uno:\n\n' + contexto,
    mensajes: [{ role: 'user', text: p }]
  });
  return { respuesta: r.texto, fuentes: Array.from(new Set(frs.map(f => f.archivo))), fragmentosUsados: frs.length, costoUsd: r.costoUsd, modelo: r.modelo };
}

// ---------------------------------------------------------------------------
// Rutas (solo Administrador)
// ---------------------------------------------------------------------------
function soloAdmin(req, res, next) { if (!esAdmin(req)) return res.status(403).json({ error: 'Solo un administrador puede gestionar los asesores.' }); next(); }

router.get('/estado', authUsuario, soloAdmin, async (req, res) => {
  try {
    const db = await getDb();
    sincronizacionNocturna(db).catch(() => {}); // si pasó más de un día, se actualiza en segundo plano
    const [ult, archivos, uso] = await Promise.all([
      db.collection('configuracion').findOne({ _id: SYNC_ID }),
      db.collection(COL_ARCHIVOS).find({}).project({ _id: 0 }).sort({ ambito: 1, nombre: 1 }).toArray(),
      db.collection(COL_FRAGMENTOS).aggregate([{ $group: { _id: null, bytes: { $sum: '$bytes' }, n: { $sum: 1 } } }]).toArray()
    ]);
    const asesores = [];
    for (const k of CLAVES) {
      const cfg = await configDe(db, k); const g = await gastoDelMes(db, k);
      asesores.push({ key: k, nombre: cfg.nombre, carpeta: cfg.carpeta, topeUsdMes: cfg.topeUsdMes, activo: cfg.activo, gastoUsd: Math.round(g.usd * 10000) / 10000, llamadas: g.llamadas, archivos: archivos.filter(a => a.ambito === k).length });
    }
    res.json({
      driveConfigurado: driveHabilitado(),
      sync: ult ? { okAt: ult.okAt || null, error: ult.error || null, errorAt: ult.errorAt || null, corriendo: !!(ult.corriendoDesde && Date.now() - new Date(ult.corriendoDesde).getTime() < 15 * 60000), resumen: ult.resumen || null } : null,
      espacio: { usadoMB: Math.round(((uso[0] ? uso[0].bytes : 0) / 1048576) * 10) / 10, topeMB: Math.round(maxBytesTexto() / 1048576), fragmentos: uso[0] ? uso[0].n : 0 },
      asesores, compartido: { archivos: archivos.filter(a => a.ambito === 'compartido').length }, archivos
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/sincronizar', authUsuario, soloAdmin, async (req, res) => {
  try {
    if (!driveHabilitado()) return res.status(400).json({ error: 'Falta GOOGLE_SERVICE_ACCOUNT_KEY en el servidor (la misma cuenta de servicio del Calendar).' });
    res.json({ ok: true, resumen: await sincronizarYRegistrar(await getDb(), { forzar: !!(req.body && req.body.forzar) }) });
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
module.exports._interno = { partirEnFragmentos, normalizarTexto, planillaATexto, extraerTexto, sincronizar, _setDriveParaTests, mensajeDrive };
