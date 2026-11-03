// Utilidades de Cloudinary compartidas (16/10/2026): firma para subida directa desde el navegador, validación de links y descarga
// para los PDF. Variables de entorno: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
const crypto = require('crypto');
function config() {
  const c = { cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, apiSecret: process.env.CLOUDINARY_API_SECRET };
  return (c.cloudName && c.apiKey && c.apiSecret) ? c : null;
}
function firma(carpeta) {
  const c = config();
  if (!c) return { habilitado: false };
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update('folder=' + carpeta + '&timestamp=' + timestamp + c.apiSecret).digest('hex');
  return { habilitado: true, cloudName: c.cloudName, apiKey: c.apiKey, timestamp, folder: carpeta, signature };
}
// ¿Es un link de nuestra cuenta de Cloudinary? (para aceptarlo en lugar de una imagen en base64)
function esLinkPropio(u) {
  const c = config();
  return !!(c && typeof u === 'string' && u.indexOf('https://res.cloudinary.com/' + c.cloudName + '/') === 0);
}
// Imagen para un PDF: si es un link se descarga (versión liviana) y se devuelve como data URL; si ya es data URL se devuelve igual.
async function dataUrlParaPdf(u) {
  if (typeof u !== 'string' || u.indexOf('https://res.cloudinary.com/') !== 0) return u;
  try {
    const r = await fetch(u.replace('/upload/', '/upload/w_900,q_auto,f_jpg/'));
    if (!r.ok) return null;
    return 'data:image/jpeg;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch (e) { return null; }
}
// Sube cualquier archivo (foto, audio, video, PDF, Word…) con un nombre al azar imposible de adivinar. Devuelve { url, tipo }.
// Fotos → image, audio/video → video, el resto → raw (los PDF como "image" suelen venir bloqueados en la cuenta).
async function subirArchivo(buf, mime, carpeta) {
  const c = config(); if (!c) throw new Error('Cloudinary no está configurado.');
  const m = String(mime || '').toLowerCase();
  const tipo = /^image\/(jpeg|png|webp|gif)$/.test(m) ? 'image' : /^(audio|video)\//.test(m) ? 'video' : 'raw';
  const publicId = (carpeta || 'piedranegra/whatsapp') + '/' + crypto.randomBytes(18).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update('public_id=' + publicId + '&timestamp=' + timestamp + c.apiSecret).digest('hex');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: m || 'application/octet-stream' }), 'archivo');
  fd.append('api_key', c.apiKey); fd.append('timestamp', String(timestamp)); fd.append('public_id', publicId); fd.append('signature', signature);
  const r = await fetch('https://api.cloudinary.com/v1_1/' + c.cloudName + '/' + tipo + '/upload', { method: 'POST', body: fd });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.secure_url) throw new Error((d.error && d.error.message) || ('Cloudinary respondió ' + r.status));
  return { url: d.secure_url, tipo };
}
module.exports = { config, firma, esLinkPropio, dataUrlParaPdf, subirArchivo };
