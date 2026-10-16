// ---------------------------------------------------------------------------
// Migración de fotos a Cloudinary (16/10/2026, pedido de Mato: las fotos guardadas dentro de la base la llenan — Atlas gratis tiene 512 MB).
// Recorre `visitas` y `obras`, sube cada foto que todavía está como imagen en base64 a Cloudinary y deja en su lugar solo el link
// (mismo campo `data`, así el resto del sistema no cambia). Solo administradores. Se puede repetir sin riesgo:
//   - una foto solo se reemplaza DESPUÉS de que Cloudinary confirmó la subida;
//   - el nombre del archivo en Cloudinary sale del contenido de la foto, así la misma imagen (por ejemplo la foto de una visita
//     copiada a su obra) se sube una sola vez y comparte el link.
// GET /estado  → cuántas fotos quedan en la base y cuánto pesan.
// POST /lote   → migra un lote chico (para no pasarse de tiempo) y devuelve cuántas quedan; la pantalla lo repite hasta terminar.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario } = require('./usuarios');
const cloudinary = require('./cloudinary');

const router = express.Router();
const COLECCIONES = ['visitas', 'obras'];
const POR_LOTE = 6;
let mongoClient;
async function getDb() {
  if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; }
  return mongoClient.db('calculadora_m2');
}
function soloAdmin(req, res, next) {
  if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) return res.status(403).json({ error: 'Solo un administrador puede migrar las fotos.' });
  next();
}
const esBase64 = f => !!(f && typeof f.data === 'string' && f.data.indexOf('data:image/') === 0);

async function contar(db) {
  let fotos = 0, bytes = 0;
  for (const col of COLECCIONES) {
    const r = await db.collection(col).aggregate([
      { $match: { 'fotos.data': { $regex: '^data:image/' } } },
      { $unwind: '$fotos' },
      { $match: { 'fotos.data': { $regex: '^data:image/' } } },
      { $group: { _id: null, n: { $sum: 1 }, b: { $sum: { $strLenBytes: '$fotos.data' } } } }
    ]).toArray();
    if (r[0]) { fotos += r[0].n; bytes += r[0].b; }
  }
  return { fotos, mb: Math.round(bytes / 1048576 * 10) / 10 };
}

async function subir(dataUrl) {
  const c = cloudinary.config();
  const hash = crypto.createHash('sha1').update(dataUrl).digest('hex');
  const publicId = 'piedranegra/migradas/' + hash;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update('public_id=' + publicId + '&timestamp=' + timestamp + c.apiSecret).digest('hex');
  const fd = new FormData();
  fd.append('file', dataUrl); fd.append('api_key', c.apiKey); fd.append('timestamp', String(timestamp)); fd.append('public_id', publicId); fd.append('signature', signature);
  const r = await fetch('https://api.cloudinary.com/v1_1/' + c.cloudName + '/image/upload', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.secure_url) throw new Error((d.error && d.error.message) || ('Cloudinary respondió ' + r.status));
  return d.secure_url;
}

router.get('/estado', authUsuario, soloAdmin, async (req, res) => {
  try { res.json(Object.assign({ cloudinary: !!cloudinary.config() }, await contar(await getDb()))); }
  catch (e) { mongoClient = null; res.status(500).json({ error: e.message }); }
});

router.post('/lote', authUsuario, soloAdmin, async (req, res) => {
  try {
    if (!cloudinary.config()) return res.status(400).json({ error: 'Cloudinary todavía no está configurado en Render.' });
    const db = await getDb();
    let migradas = 0; const errores = []; const idsFallidos = [];
    const t0 = Date.now();
    for (const col of COLECCIONES) {
      while (migradas + errores.length < POR_LOTE && Date.now() - t0 < 40000) {
        const doc = await db.collection(col).findOne({ 'fotos.data': { $regex: '^data:image/' }, _id: { $nin: idsFallidos } }, { projection: { fotos: 1 } });
        if (!doc) break;
        let avanzo = false, huboError = false;
        for (let i = 0; i < doc.fotos.length && migradas + errores.length < POR_LOTE; i++) {
          const f = doc.fotos[i];
          if (!esBase64(f)) continue;
          try {
            const url = await subir(f.data);
            const r = await db.collection(col).updateOne({ _id: doc._id, ['fotos.' + i + '.data']: f.data }, { $set: { ['fotos.' + i + '.data']: url } });
            if (r.modifiedCount) { migradas++; avanzo = true; }
          } catch (e) { errores.push(e.message); huboError = true; }
        }
        if (huboError) idsFallidos.push(doc._id); // se saltea en este lote; las que fallan se reintentan en la próxima corrida
        else if (!avanzo) break;
      }
    }
    res.json(Object.assign({ migradas, errores }, await contar(db)));
  } catch (e) { mongoClient = null; res.status(500).json({ error: e.message }); }
});

module.exports = router;
