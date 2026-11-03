// Copia diaria de la base de datos (auditoría 3/11/2026, etapa 3).
// Cada noche (y a pedido, desde Configuración → Copias de seguridad) se exporta TODA la base, se comprime, se CIFRA con
// la clave BACKUP_CLAVE (variable de entorno de Render) y se sube a Cloudinary en partes de hasta 8 MB, en la carpeta
// "backups-sistema". Se conservan las últimas 14 copias. Si falta la clave o Cloudinary, no se hace nada y la pantalla avisa.
// Importante: la clave NO se guarda en la base ni en Cloudinary. Sin ella las copias no se pueden abrir: guardala también
// en un lugar propio (gestor de contraseñas). Para restaurar: restaurarCopia.js (ver LEEME de pruebas / ese archivo).
//   GET  /api/backups           -> estado y lista de copias (solo Administrador)
//   POST /api/backups/ejecutar  -> hace una copia ahora (corre en segundo plano)
const express = require('express');
const crypto = require('crypto');
const zlib = require('zlib');
const { MongoClient, BSON } = require('mongodb');
const { authUsuario } = require('./usuarios');
const cloudinary = require('./cloudinary');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const CARPETA = 'backups-sistema';
const COL_COPIAS = 'backups_copias';
const CONSERVAR = 14;
const MAGIC = Buffer.from('PNB1');
const parteMax = () => Number(process.env.BACKUP_PARTE_BYTES) || 8 * 1024 * 1024; // sin comprimir; comprimida pesa igual o menos (Cloudinary gratis admite 10 MB por archivo)

let mongoClient;
async function getDb() {
  if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; }
  return mongoClient.db(DB_NAME);
}
const soloAdmin = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador.' });

function estadoConfig() {
  const clave = process.env.BACKUP_CLAVE || '';
  return { clave: clave.length >= 12, claveCorta: !!clave && clave.length < 12, cloudinary: !!cloudinary.config() };
}

// ---- cifrado: MAGIC(4) + sal(16) + iv(12) + etiqueta(16) + datos. La clave se deriva una vez por copia (scrypt) y cada parte lleva su iv.
function claveDerivada(clave, sal) { return crypto.scryptSync(clave, sal, 32); }
function cifrar(buf, key, sal) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const datos = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, sal, iv, c.getAuthTag(), datos]);
}
function descifrar(buf, clave) {
  if (buf.length < 48 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('El archivo no es una parte de copia válida.');
  const sal = buf.subarray(4, 20), iv = buf.subarray(20, 32), tag = buf.subarray(32, 48);
  const d = crypto.createDecipheriv('aes-256-gcm', claveDerivada(clave, sal), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(48)), d.final()]); } catch (e) { throw new Error('No se pudo descifrar: la clave es otra o el archivo está dañado.'); }
}
const gzip = buf => new Promise((ok, mal) => zlib.gzip(buf, { level: 6 }, (e, r) => e ? mal(e) : ok(r)));
const gunzip = buf => new Promise((ok, mal) => zlib.gunzip(buf, (e, r) => e ? mal(e) : ok(r)));

// ---- Cloudinary (subida firmada desde el servidor, archivo "raw")
async function subirParte(c, nombre, buf) {
  const timestamp = Math.floor(Date.now() / 1000);
  const firma = crypto.createHash('sha1').update(`folder=${CARPETA}&public_id=${nombre}&timestamp=${timestamp}${c.apiSecret}`).digest('hex');
  const fd = new FormData();
  fd.append('file', new Blob([buf]), nombre);
  fd.append('api_key', c.apiKey); fd.append('timestamp', String(timestamp)); fd.append('signature', firma);
  fd.append('folder', CARPETA); fd.append('public_id', nombre);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/raw/upload`, { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.public_id) throw new Error('Cloudinary rechazó la subida (' + r.status + '): ' + ((d.error && d.error.message) || 'sin detalle'));
  return { publicId: d.public_id, url: d.secure_url, bytes: d.bytes || buf.length };
}
async function borrarPartes(c, publicIds) {
  for (let i = 0; i < publicIds.length; i += 90) {
    const q = publicIds.slice(i, i + 90).map(p => 'public_ids[]=' + encodeURIComponent(p)).join('&');
    const r = await fetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/resources/raw/upload?${q}`, { method: 'DELETE', headers: { Authorization: 'Basic ' + Buffer.from(c.apiKey + ':' + c.apiSecret).toString('base64') } });
    if (!r.ok) throw new Error('Cloudinary no dejó borrar copias viejas (' + r.status + ')');
  }
}

// ---- la copia
async function ejecutarCopia({ origen = 'auto', usuario = '' } = {}) {
  const cfg = estadoConfig();
  if (!cfg.clave) throw new Error('Falta la variable BACKUP_CLAVE en Render (mínimo 12 caracteres).');
  if (!cfg.cloudinary) throw new Error('Falta la configuración de Cloudinary (CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).');
  const c = cloudinary.config();
  const db = await getDb();
  const copias = db.collection(COL_COPIAS);
  const enCurso = await copias.findOne({ estado: 'en_curso', inicio: { $gt: new Date(Date.now() - 3 * 3600e3) } });
  if (enCurso) throw new Error('Ya hay una copia en curso (empezó ' + enCurso.inicio.toISOString() + ').');
  const inicio = new Date();
  const tag = inicio.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const unico = crypto.randomBytes(8).toString('hex'); // el nombre no se puede adivinar
  const { insertedId } = await copias.insertOne({ inicio, estado: 'en_curso', origen, usuario, partes: [] });
  const partes = []; const colecciones = {}; let docs = 0, crudos = 0, subidos = 0;
  try {
    const sal = crypto.randomBytes(16), key = claveDerivada(process.env.BACKUP_CLAVE, sal);
    let acum = [], acumBytes = 0;
    const vaciar = async () => {
      if (!acumBytes) return;
      const comprimido = await gzip(Buffer.from(acum.join(''), 'utf8'));
      const cifrado = cifrar(comprimido, key, sal);
      const nombre = `copia-${tag}-${unico}-${String(partes.length + 1).padStart(3, '0')}.bin`;
      const sub = await subirParte(c, nombre, cifrado);
      partes.push({ n: partes.length + 1, publicId: sub.publicId, url: sub.url, bytes: cifrado.length, sha256: crypto.createHash('sha256').update(cifrado).digest('hex') });
      crudos += acumBytes; subidos += cifrado.length; acum = []; acumBytes = 0;
    };
    const agregar = async linea => { const b = Buffer.byteLength(linea); if (acumBytes && acumBytes + b > parteMax()) await vaciar(); acum.push(linea); acumBytes += b; };
    const nombres = (await db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).filter(n => !n.startsWith('system.') && n !== COL_COPIAS).sort();
    for (const nombre of nombres) {
      const col = db.collection(nombre);
      let indices = []; try { indices = (await col.indexes()).filter(i => i.name !== '_id_'); } catch (e) { /* vista o colección sin índices */ }
      await agregar(BSON.EJSON.stringify({ c: nombre, indices }, { relaxed: false }) + '\n');
      let n = 0;
      for await (const doc of col.find({}).batchSize(200)) { await agregar(BSON.EJSON.stringify({ c: nombre, d: doc }, { relaxed: false }) + '\n'); n++; }
      colecciones[nombre] = n; docs += n;
    }
    await vaciar();
    await copias.updateOne({ _id: insertedId }, { $set: { estado: 'ok', fin: new Date(), partes, colecciones, docs, bytesCrudos: crudos, bytesSubidos: subidos } });
  } catch (e) {
    // Lo subido a medias se borra: una copia incompleta no sirve y confunde.
    try { if (partes.length) await borrarPartes(c, partes.map(p => p.publicId)); } catch (e2) { /* nada más que hacer */ }
    await copias.updateOne({ _id: insertedId }, { $set: { estado: 'error', fin: new Date(), error: String(e.message || e).slice(0, 500), partes: [] } });
    throw e;
  }
  // Retención: se quedan las últimas CONSERVAR copias buenas.
  try {
    const buenas = await copias.find({ estado: 'ok' }).sort({ inicio: -1 }).toArray();
    for (const vieja of buenas.slice(CONSERVAR)) {
      await borrarPartes(c, (vieja.partes || []).map(p => p.publicId));
      await copias.deleteOne({ _id: vieja._id });
    }
    await copias.deleteMany({ estado: 'error', inicio: { $lt: new Date(Date.now() - 30 * 864e5) } });
  } catch (e) { console.error('[backup] no se pudieron borrar copias viejas:', e.message); }
  return { id: insertedId, partes: partes.length, docs, colecciones: Object.keys(colecciones).length, bytesSubidos: subidos };
}

// ---- restauración (la usa restaurarCopia.js): recibe las partes en orden y las vuelca en una base (por defecto NUEVA, nunca la actual)
async function restaurar(buffersPartes, dbDestino, clave) {
  const cont = {};
  const lote = {}; // colección -> docs pendientes
  const volcar = async nombre => { if (lote[nombre] && lote[nombre].length) { await dbDestino.collection(nombre).insertMany(lote[nombre], { ordered: false }); lote[nombre] = []; } };
  const indices = {};
  for (const buf of buffersPartes) {
    const texto = (await gunzip(descifrar(buf, clave))).toString('utf8');
    for (const linea of texto.split('\n')) {
      if (!linea) continue;
      const o = BSON.EJSON.parse(linea, { relaxed: false });
      if (o.indices) { indices[o.c] = o.indices; cont[o.c] = cont[o.c] || 0; continue; }
      (lote[o.c] = lote[o.c] || []).push(o.d); cont[o.c] = (cont[o.c] || 0) + 1;
      if (lote[o.c].length >= 500) await volcar(o.c);
    }
  }
  for (const n of Object.keys(lote)) await volcar(n);
  for (const [n, lista] of Object.entries(indices)) {
    for (const i of lista) { try { const { key, name, v, ns, ...opc } = i; await dbDestino.collection(n).createIndex(key, Object.assign({ name }, opc)); } catch (e) { /* un índice que no se pueda crear no frena la restauración */ } }
  }
  return cont;
}

// ---- programador: cada 15 min mira si toca (entre las 3 y las 7 de la mañana de Argentina y sin copia buena en 20 h)
let temporizador = null;
async function tocaCopiar() {
  const cfg = estadoConfig(); if (!cfg.clave || !cfg.cloudinary || process.env.BACKUP_AUTO === '0') return false;
  const horaAR = (new Date().getUTCHours() + 21) % 24;
  if (horaAR < 3 || horaAR > 7) return false;
  const ultima = await (await getDb()).collection(COL_COPIAS).findOne({ estado: 'ok' }, { sort: { inicio: -1 } });
  return !ultima || Date.now() - new Date(ultima.inicio).getTime() > 20 * 3600e3;
}
function iniciarProgramador() {
  if (temporizador) return;
  const paso = async () => { try { if (await tocaCopiar()) { const r = await ejecutarCopia({ origen: 'auto' }); console.log('[backup] copia diaria lista:', r.partes, 'partes,', r.docs, 'documentos'); } } catch (e) { console.error('[backup] falló la copia diaria:', e.message); } };
  temporizador = setInterval(paso, 15 * 60 * 1000); temporizador.unref();
  setTimeout(paso, 2 * 60 * 1000).unref();
}

// ---- API
router.get('/', authUsuario, soloAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const lista = await db.collection(COL_COPIAS).find({}).sort({ inicio: -1 }).limit(40).toArray();
    res.json({
      configurado: estadoConfig(), conservar: CONSERVAR,
      copias: lista.map(c => ({ _id: c._id, inicio: c.inicio, fin: c.fin || null, estado: c.estado, origen: c.origen, usuario: c.usuario || '', error: c.error || '', partes: (c.partes || []).length, docs: c.docs || 0, colecciones: c.colecciones ? Object.keys(c.colecciones).length : 0, bytesSubidos: c.bytesSubidos || 0 }))
    });
  } catch (e) { mongoClient = null; res.status(500).json({ error: e.message }); }
});
router.post('/ejecutar', authUsuario, soloAdmin, async (req, res) => {
  try {
    const cfg = estadoConfig();
    if (!cfg.clave) return res.status(400).json({ error: 'Falta cargar BACKUP_CLAVE en Render (Environment), de al menos 12 caracteres.' });
    if (!cfg.cloudinary) return res.status(400).json({ error: 'Falta la configuración de Cloudinary en Render.' });
    const enCurso = await (await getDb()).collection(COL_COPIAS).findOne({ estado: 'en_curso', inicio: { $gt: new Date(Date.now() - 3 * 3600e3) } });
    if (enCurso) return res.status(409).json({ error: 'Ya hay una copia en curso.' });
    ejecutarCopia({ origen: 'manual', usuario: (req.usuario && req.usuario.nombre) || '' }).then(r => console.log('[backup] copia manual lista:', r.partes, 'partes'), e => console.error('[backup] falló la copia manual:', e.message));
    res.status(202).json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.ejecutarCopia = ejecutarCopia;
module.exports.restaurar = restaurar;
module.exports.iniciarProgramador = iniciarProgramador;
module.exports.cifrar = cifrar; module.exports.descifrar = descifrar;
