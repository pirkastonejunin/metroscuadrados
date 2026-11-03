// Historial de cambios (auditoría 3/11/2026, etapa 4): cada alta, cambio, pago o anulación que sale bien queda registrada con
// quién la hizo, en qué sucursal, en qué módulo, qué acción y con qué datos. Sirve para saber "quién tocó esto y cuándo".
// - Se registra al terminar la respuesta (no frena ni rompe nada si falla el registro).
// - NO se guardan contraseñas, claves, tokens, PIN ni archivos/fotos (se tapan). Los textos largos se recortan.
// - Se borra solo lo de más de 540 días (índice TTL) para no llenar la base.
//   GET /api/auditoria?usuario=&modulo=&desde=&hasta=&q=&pagina=   (solo Administrador)
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const OMITIR = /webhook|\/login|\/logout|\/usuarios\/me|\/notificaciones|\/auditoria|\/backups\/ejecutar|\/asistente|\/mesa/i; // ruido o rutas sin usuario
const SECRETO = /pass|contrase|token|secret|clave|key|pin$|cert|private|authorization|cuitlogin/i;
const OID = /^[0-9a-f]{24}$/i;

let mongoClient, indicesListos = false;
async function getDb() {
  if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; }
  const db = mongoClient.db(DB_NAME);
  if (!indicesListos) {
    indicesListos = true;
    const col = db.collection('auditoria');
    col.createIndex({ fecha: 1 }, { expireAfterSeconds: 540 * 86400, name: 'ttl_fecha' }).catch(() => {});
    col.createIndex({ modulo: 1, fecha: -1 }).catch(() => {});
    col.createIndex({ usuarioNombre: 1, fecha: -1 }).catch(() => {});
    col.createIndex({ entidadId: 1 }).catch(() => {});
  }
  return db;
}

// Resumen de lo enviado, sin secretos ni archivos, de tamaño acotado.
function limpiar(v, prof = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return (v.startsWith('data:') || v.length > 3000) ? '[archivo]' : (v.length > 160 ? v.slice(0, 160) + '…' : v);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return prof > 1 ? `[${v.length} ítems]` : v.slice(0, 15).map(x => limpiar(x, prof + 1)).concat(v.length > 15 ? [`… y ${v.length - 15} más`] : []);
  if (typeof v === 'object') {
    if (prof > 2) return '{…}';
    const o = {}; let n = 0;
    for (const [k, x] of Object.entries(v)) { if (++n > 30) { o['…'] = 'más campos'; break; } o[k] = SECRETO.test(k) ? '***' : (/base64|archivo|foto|imagen|firma|adjunto/i.test(k) && typeof x === 'string' && x.length > 200 ? '[archivo]' : limpiar(x, prof + 1)); }
    return o;
  }
  return String(v);
}
function resumenBody(body) {
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return null;
  const l = limpiar(body); let s = JSON.stringify(l);
  if (s.length > 2500) return { recortado: s.slice(0, 2500) + '…' };
  return l;
}

function middleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const url = (req.originalUrl || req.url || '').split('?')[0];
  if (OMITIR.test(url)) return next();
  let cuerpoRespuesta = null;
  const jsonOriginal = res.json.bind(res);
  res.json = (b) => { cuerpoRespuesta = b; return jsonOriginal(b); };
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400 || !req.usuario) return;
      const partes = url.split('/').filter(Boolean); // ['api','ventas','<id>','anular']
      const ruta = '/' + partes.map(p => OID.test(p) || /^\d+$/.test(p) ? ':id' : p).join('/');
      const entidadId = (partes.find(p => OID.test(p)) || (cuerpoRespuesta && OID.test(String(cuerpoRespuesta._id || '')) ? String(cuerpoRespuesta._id) : '')) || null;
      const r = cuerpoRespuesta && typeof cuerpoRespuesta === 'object' ? cuerpoRespuesta : {};
      const doc = {
        fecha: new Date(), usuarioId: req.usuario._id || null, usuarioNombre: req.usuario.nombre || '', rol: (req.usuario.rol && req.usuario.rol.nombre) || '',
        orgId: req.orgId || req.orgOperar || null, modulo: partes[1] || '', metodo: req.method, ruta, status: res.statusCode, entidadId,
        numero: r.numero != null ? r.numero : (r.venta && r.venta.numero) || null, nombre: typeof r.nombre === 'string' ? r.nombre.slice(0, 80) : (typeof r.razonSocial === 'string' ? r.razonSocial.slice(0, 80) : null),
        datos: resumenBody(req.body), ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 60)
      };
      getDb().then(db => db.collection('auditoria').insertOne(doc)).catch(e => console.error('[auditoría] no se pudo registrar:', e.message));
    } catch (e) { /* el registro nunca rompe la operación */ }
  });
  next();
}

const soloAdmin = (req, res, next) => (req.usuario && req.usuario.rol && req.usuario.rol.protegido) ? next() : res.status(403).json({ error: 'Solo el rol Administrador.' });
const POR_PAGINA = 100;
router.get('/', authUsuario, soloAdmin, async (req, res) => {
  try {
    const db = await getDb(), q = {};
    if (req.query.usuario) q.usuarioNombre = String(req.query.usuario);
    if (req.query.modulo) q.modulo = String(req.query.modulo);
    if (req.query.desde || req.query.hasta) {
      q.fecha = {};
      if (req.query.desde) q.fecha.$gte = new Date(req.query.desde + 'T00:00:00-03:00');
      if (req.query.hasta) q.fecha.$lte = new Date(req.query.hasta + 'T23:59:59.999-03:00');
    }
    const t = String(req.query.q || '').trim();
    if (t) {
      if (OID.test(t)) q.entidadId = t;
      else if (/^\d+$/.test(t)) q.numero = Number(t);
      else q.$or = [{ nombre: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { ruta: { $regex: t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }];
    }
    const pagina = Math.max(0, Number(req.query.pagina) || 0);
    const [filas, total, usuarios, modulos, orgs] = await Promise.all([
      db.collection('auditoria').find(q).sort({ fecha: -1 }).skip(pagina * POR_PAGINA).limit(POR_PAGINA).toArray(),
      db.collection('auditoria').countDocuments(q),
      db.collection('auditoria').distinct('usuarioNombre'), db.collection('auditoria').distinct('modulo'),
      db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray()
    ]);
    const nomOrg = Object.fromEntries(orgs.map(o => [String(o._id), o.nombre]));
    res.json({ total, pagina, porPagina: POR_PAGINA, usuarios: usuarios.filter(Boolean).sort(), modulos: modulos.filter(Boolean).sort(),
      filas: filas.map(f => Object.assign({}, f, { sucursal: f.orgId ? (nomOrg[String(f.orgId)] || '') : '' })) });
  } catch (e) { mongoClient = null; indicesListos = false; res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.middleware = middleware;
module.exports.limpiar = limpiar;
