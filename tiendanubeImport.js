// ---------------------------------------------------------------------------
// Importar desde Tiendanube las fotos y la descripción de cada producto
// (8/10/2026, pedido de Mato: "traer de tiendanube e importar todas las
// imagenes y dejarlas en la ficha de los productos junto con la descripcion
// que tienen en la tienda para poder armar una tienda nueva").
//
// Idea: las fotos de Tiendanube viven en SU servidor; cuando se deje de usar
// esa tienda, esos links dejan de andar. Por eso se DESCARGAN y se guardan
// acá (sin recomprimir, en su calidad original), para que la tienda nueva no dependa
// de Tiendanube.
//
// El producto de Tiendanube se vincula con el del sistema por SKU (el SKU de
// alguna de sus variantes = el SKU del producto). Datos en colecciones propias
// para no engordar productos_catalogo (que tiene ~20.000 filas):
//   productos_tienda : { orgId, productoId, imagenes:[{imagenId}], descripcionHtml,
//                        tienda:{ productId, handle, url, nombre, seoTitulo,
//                        seoDescripcion, tags, categorias, importadoEn }, updatedAt }
//   tienda_imagenes  : { orgId, tnProductId, tnImageId, origen, contentType, ancho,
//                        alto, bytes, data, creadoEn }  (las subidas a mano no tienen tnImageId)
//
// Rutas (montadas en /api/tienda-import):
//   GET  /vista-previa                  cuántos productos coinciden, sin importar nada
//   POST /importar { sobrescribir }     arranca el import (progreso: /api/productos/import/estado/:id)
//   GET  /imagen/:id                    la foto (pública: la usan <img> y la tienda nueva)
//   GET  /producto/:id                  fotos + descripción + datos de tienda de un producto
//   PUT  /producto/:id/descripcion      edita la descripción
//   POST /producto/:id/imagenes         sube una foto (dataUrl base64)
//   POST /producto/:id/imagen/:imagenId/principal   la pasa al primer lugar
//   DELETE /producto/:id/imagen/:imagenId
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId, Binary } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const cotizador = require('./cotizador');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('productos')];
const TN_API = () => (process.env.TN_API_URL || 'https://api.tiendanube.com/v1').replace(/\/$/, '');
const MAX_IMAGENES_POR_PRODUCTO = 20;

let client, conectando;
async function getDb() {
  if (!client) {
    if (!conectando) conectando = new MongoClient(process.env.MONGODB_URI).connect().then(c => { client = c; return c; }).catch(e => { conectando = null; throw e; });
    await conectando;
  }
  return client.db(DB_NAME);
}
const err = (status, message) => Object.assign(new Error(message), { status });
const oid = id => { try { return new ObjectId(String(id)); } catch (e) { return null; } };
const esperar = ms => new Promise(r => setTimeout(r, ms));
const loc = c => (!c ? '' : (typeof c === 'string' ? c : (c.es || Object.values(c)[0] || '')));

// HTML de la descripción: se conserva el formato básico y se sacan scripts,
// estilos, iframes, manejadores on*="..." y links javascript:.
function limpiarHtml(h) {
  return String(h || '')
    .replace(/<\s*(script|style|iframe|object|embed)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
    .trim();
}

async function tnGet(store, ruta) {
  for (let intento = 0; intento < 6; intento++) {
    const r = await fetch(TN_API() + '/' + store.store_id + ruta, { headers: { Authorization: 'Bearer ' + store.access_token, 'Content-Type': 'application/json', 'User-Agent': process.env.USER_AGENT || 'metroscuadrados' } });
    if (r.status === 429) { await esperar(Math.min(10000, 1500 * (intento + 1))); continue; }
    if (r.status === 404) return [];
    if (!r.ok) throw err(502, 'Tiendanube respondió ' + r.status);
    return r.json();
  }
  throw err(502, 'Tiendanube está limitando las consultas; probá de nuevo en unos minutos.');
}

async function tiendaDeOrg(db, orgId) {
  const org = await db.collection('organizaciones').findOne({ _id: orgId }).catch(() => null);
  const candidatos = [];
  for (const id of [org && org.tiendanubeStoreId, process.env.TIENDA_REAL_STORE_ID]) {
    if (id && !candidatos.includes(String(id).trim())) candidatos.push(String(id).trim());
  }
  if (!candidatos.length) throw err(400, 'Esta organización no tiene una tienda de Tiendanube vinculada (falta tiendanubeStoreId o TIENDA_REAL_STORE_ID).');
  for (const id of candidatos) {
    const store = await cotizador.getStoreById(id).catch(() => null);
    if (store && store.access_token) return store;
  }
  // Último recurso: si hay una única tienda instalada con token, usar esa.
  try {
    const todas = await db.collection('stores').find({ access_token: { $exists: true, $ne: null } }).limit(3).toArray();
    if (todas.length === 1) return todas[0];
  } catch (e) { /* sigue al error */ }
  throw err(400, 'No encuentro el token de acceso de la tienda de Tiendanube (probé con el ID ' + candidatos.join(' y ') + '). Revisá que ese ID coincida con una tienda instalada en la colección "stores".');
}

async function* productosTienda(store) {
  for (let page = 1; page < 500; page++) {
    const lote = await tnGet(store, `/products?per_page=200&page=${page}`);
    if (!Array.isArray(lote) || !lote.length) return;
    for (const p of lote) yield p;
    if (lote.length < 200) return;
    await esperar(600); // la API de Tiendanube permite ~2 consultas por segundo
  }
}

async function indiceSkus(db, orgId) {
  const filas = await db.collection('productos_catalogo').find({ orgId, sku: { $nin: [null, ''] } }).project({ sku: 1 }).toArray();
  const m = new Map();
  for (const f of filas) { const k = String(f.sku).trim().toLowerCase(); if (!m.has(k)) m.set(k, []); m.get(k).push(f._id); }
  return m;
}
function productosCoincidentes(p, indice) {
  const ids = new Map();
  for (const v of (p.variants || [])) {
    const k = v.sku ? String(v.sku).trim().toLowerCase() : '';
    for (const id of (indice.get(k) || [])) ids.set(String(id), id);
  }
  return [...ids.values()];
}

router.get('/vista-previa', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const store = await tiendaDeOrg(db, req.orgId);
    const indice = await indiceSkus(db, req.orgId);
    let total = 0, conFotos = 0, fotos = 0, coinciden = 0, sinSku = 0;
    const sinCoincidencia = [];
    for await (const p of productosTienda(store)) {
      total++;
      const imgs = (p.images || []).length; if (imgs) conFotos++; fotos += imgs;
      if (!(p.variants || []).some(v => v.sku)) sinSku++;
      if (productosCoincidentes(p, indice).length) coinciden++;
      else if (sinCoincidencia.length < 40) sinCoincidencia.push({ nombre: loc(p.name), skus: (p.variants || []).map(v => v.sku).filter(Boolean).slice(0, 3) });
    }
    const yaImportados = await db.collection('productos_tienda').countDocuments({ orgId: req.orgId, 'imagenes.0': { $exists: true } });
    res.json({ total, conFotos, fotos, coinciden, sinCoincidencia: total - coinciden, sinSku, ejemplosSinCoincidencia: sinCoincidencia, yaImportados });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- imágenes
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }
// Sin recomprimir ni achicar: la foto se guarda tal cual vino (misma calidad).
// Solo se lee el tamaño para informarlo.
async function prepararImagen(buf, contentType) {
  let ancho = null, alto = null, ct = contentType;
  if (sharp) {
    try { const m = await sharp(buf, { failOn: 'none' }).metadata(); ancho = m.width || null; alto = m.height || null; if (!ct && m.format) ct = 'image/' + (m.format === 'jpg' ? 'jpeg' : m.format); }
    catch (e) { throw new Error('No es una imagen válida.'); }
  }
  return { data: buf, contentType: ct || 'image/jpeg', ancho, alto };
}
// Tiendanube sirve las fotos con un sufijo de tamaño (ej. nombre-1024-1024.jpg).
// Primero se intenta la versión sin sufijo (la original); si no existe, la de la lista.
async function descargar(src) {
  const url = String(src).startsWith('//') ? 'https:' + src : String(src);
  const candidatas = [];
  const sinSufijo = url.replace(/-\d{2,4}-\d{2,4}(\.[a-z0-9]+)(\?.*)?$/i, '$1$2');
  if (sinSufijo !== url) candidatas.push(sinSufijo);
  candidatas.push(url);
  let ultimo = 'sin respuesta';
  for (const u of candidatas) {
    try {
      const r = await fetch(u);
      if (!r.ok) { ultimo = 'HTTP ' + r.status; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length) return { buf, contentType: (r.headers.get('content-type') || '').split(';')[0] };
    } catch (e) { ultimo = e.message; }
  }
  throw new Error(ultimo);
}
async function guardarImagen(db, orgId, extra, buf, contentType) {
  const im = await prepararImagen(buf, contentType);
  if (im.data.length > 12 * 1024 * 1024) throw new Error('La imagen pesa más de 12 MB.');
  const r = await db.collection('tienda_imagenes').insertOne(Object.assign({
    orgId, contentType: im.contentType, ancho: im.ancho, alto: im.alto, bytes: im.data.length, data: new Binary(im.data), creadoEn: new Date()
  }, extra));
  return r.insertedId;
}

// ---- importación
router.post('/importar', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const store = await tiendaDeOrg(db, req.orgId);
    const activo = await db.collection('productos_import_jobs').findOne({ orgId: req.orgId, tipo: 'importar-tiendanube', estado: 'procesando', creadoEn: { $gt: new Date(Date.now() - 3 * 3600 * 1000) } });
    if (activo) return res.json({ jobId: activo._id, yaEnCurso: true });
    const sobrescribir = !!(req.body && req.body.sobrescribir);
    const { insertedId: jobId } = await db.collection('productos_import_jobs').insertOne({
      orgId: req.orgId, tipo: 'importar-tiendanube', total: 0, procesados: 0, productos: 0, imagenes: 0, sinCoincidencia: 0,
      sinFotos: 0, errores: [], estado: 'procesando', creadoEn: new Date(), terminadoEn: null
    });
    res.json({ jobId });
    procesarImport(db, store, req.orgId, jobId, sobrescribir).catch(async e => {
      try { await db.collection('productos_import_jobs').updateOne({ _id: jobId }, { $set: { estado: 'error', errorGeneral: e.message, terminadoEn: new Date() } }); } catch (e2) { /* nada más */ }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function procesarImport(db, store, orgId, jobId, sobrescribir) {
  const jobs = db.collection('productos_import_jobs');
  const indice = await indiceSkus(db, orgId);
  const stats = { total: 0, procesados: 0, productos: 0, imagenes: 0, sinCoincidencia: 0, sinFotos: 0 };
  const errores = [];
  const guardarProgreso = () => jobs.updateOne({ _id: jobId }, { $set: Object.assign({}, stats, { errores: errores.slice(0, 50) }) });
  let ultimo = 0;
  for await (const p of productosTienda(store)) {
    stats.total++;
    const ids = productosCoincidentes(p, indice);
    if (!ids.length) { stats.sinCoincidencia++; stats.procesados++; continue; }
    try {
      const nombre = loc(p.name);
      const existentes = await db.collection('productos_tienda').find({ orgId, productoId: { $in: ids } }).toArray();
      const porProd = new Map(existentes.map(e => [String(e.productoId), e]));
      // fotos del producto de Tiendanube: se descargan UNA vez aunque haya varios SKU vinculados
      const yaGuardadas = await db.collection('tienda_imagenes').find({ orgId, tnProductId: p.id }).project({ tnImageId: 1 }).toArray();
      const mapaImg = new Map(yaGuardadas.map(i => [String(i.tnImageId), i._id]));
      const orden = [];
      const imgsTn = (p.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).slice(0, MAX_IMAGENES_POR_PRODUCTO);
      const necesitaFotos = sobrescribir || ids.some(id => !((porProd.get(String(id)) || {}).imagenes || []).length);
      if (!imgsTn.length) stats.sinFotos++;
      if (necesitaFotos) {
        for (const im of imgsTn) {
          let id = mapaImg.get(String(im.id));
          if (!id) {
            try { const d = await descargar(im.src); id = await guardarImagen(db, orgId, { tnProductId: p.id, tnImageId: im.id, origen: im.src }, d.buf, d.contentType); stats.imagenes++; }
            catch (e) { errores.push(`${nombre}: foto no descargada (${e.message})`); continue; }
          }
          orden.push(id);
        }
      }
      const handle = loc(p.handle);
      const url = store.domain && handle ? `https://${store.domain}/productos/${handle}` : null;
      const tienda = { productId: p.id, handle, url, nombre, seoTitulo: loc(p.seo_title), seoDescripcion: loc(p.seo_description),
        tags: p.tags || '', categorias: (p.categories || []).map(c => loc(c.name)).filter(Boolean), marca: typeof p.brand === 'string' ? p.brand : loc(p.brand), importadoEn: new Date() };
      const desc = limpiarHtml(loc(p.description));
      for (const id of ids) {
        const e = porProd.get(String(id)) || {};
        const set = { tienda, updatedAt: new Date() };
        if (necesitaFotos && orden.length && (sobrescribir || !(e.imagenes || []).length)) set.imagenes = orden.map(x => ({ imagenId: x }));
        if (desc && (sobrescribir || !e.descripcionHtml)) set.descripcionHtml = desc;
        await db.collection('productos_tienda').updateOne({ orgId, productoId: id }, { $set: set, $setOnInsert: { orgId, productoId: id } }, { upsert: true });
        stats.productos++;
      }
    } catch (e) { errores.push(`${loc(p.name)}: ${e.message}`); }
    stats.procesados++;
    if (stats.procesados - ultimo >= 5) { ultimo = stats.procesados; await guardarProgreso(); }
  }
  await guardarProgreso();
  await jobs.updateOne({ _id: jobId }, { $set: { estado: 'listo', terminadoEn: new Date() } });
}

// ---- lectura y edición por producto
router.get('/imagen/:id', async (req, res) => {
  try {
    const id = oid(req.params.id);
    if (!id) return res.sendStatus(404);
    const db = await getDb();
    const d = await db.collection('tienda_imagenes').findOne({ _id: id }, { projection: { data: 1, contentType: 1 } });
    if (!d) return res.sendStatus(404);
    res.set('Content-Type', d.contentType || 'image/webp');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(d.data.buffer ? Buffer.from(d.data.buffer) : d.data);
  } catch (e) { res.sendStatus(500); }
});

async function productoDeOrg(db, req) {
  const id = oid(req.params.id);
  if (!id) throw err(400, 'id inválido');
  const p = await db.collection('productos_catalogo').findOne(Object.assign({ _id: id }, filtroOrg(req)), { projection: { _id: 1, orgId: 1 } });
  if (!p) throw err(404, 'Producto no encontrado');
  return p;
}

router.get('/producto/:id', auth, async (req, res) => {
  try {
    const db = await getDb();
    const p = await productoDeOrg(db, req);
    const t = await db.collection('productos_tienda').findOne({ orgId: p.orgId, productoId: p._id });
    res.json({ imagenes: ((t && t.imagenes) || []).map(i => String(i.imagenId)), descripcionHtml: (t && t.descripcionHtml) || '', tienda: (t && t.tienda) || null, publicado: !!(t && t.publicado) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/producto/:id/descripcion', auth, async (req, res) => {
  try {
    const db = await getDb();
    const p = await productoDeOrg(db, req);
    await db.collection('productos_tienda').updateOne({ orgId: p.orgId, productoId: p._id },
      { $set: { descripcionHtml: limpiarHtml((req.body || {}).descripcionHtml), updatedAt: new Date() }, $setOnInsert: { orgId: p.orgId, productoId: p._id, imagenes: [] } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/producto/:id/imagenes', auth, async (req, res) => {
  try {
    const db = await getDb();
    const p = await productoDeOrg(db, req);
    const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(String((req.body || {}).dataUrl || ''));
    if (!m) throw err(400, 'Mandá la foto como imagen (data URL base64).');
    const t = await db.collection('productos_tienda').findOne({ orgId: p.orgId, productoId: p._id });
    if (((t && t.imagenes) || []).length >= MAX_IMAGENES_POR_PRODUCTO) throw err(400, `Máximo ${MAX_IMAGENES_POR_PRODUCTO} fotos por producto.`);
    let id;
    try { id = await guardarImagen(db, p.orgId, { origen: 'subida' }, Buffer.from(m[1], 'base64'), (/^data:(image\/[a-z+.-]+);/i.exec(String(req.body.dataUrl)) || [])[1]); } catch (e) { throw err(400, 'No se pudo leer la imagen: ' + e.message); }
    await db.collection('productos_tienda').updateOne({ orgId: p.orgId, productoId: p._id },
      { $push: { imagenes: { imagenId: id } }, $set: { updatedAt: new Date() }, $setOnInsert: { orgId: p.orgId, productoId: p._id, descripcionHtml: '' } }, { upsert: true });
    res.json({ ok: true, imagenId: String(id) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/producto/:id/imagen/:imagenId/principal', auth, async (req, res) => {
  try {
    const db = await getDb();
    const p = await productoDeOrg(db, req);
    const iid = oid(req.params.imagenId);
    const t = await db.collection('productos_tienda').findOne({ orgId: p.orgId, productoId: p._id });
    const lista = (t && t.imagenes) || [];
    const elegida = lista.find(i => String(i.imagenId) === String(iid));
    if (!elegida) throw err(404, 'Esa foto no está en el producto.');
    await db.collection('productos_tienda').updateOne({ _id: t._id }, { $set: { imagenes: [elegida].concat(lista.filter(i => i !== elegida)), updatedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/producto/:id/imagen/:imagenId', auth, async (req, res) => {
  try {
    const db = await getDb();
    const p = await productoDeOrg(db, req);
    const iid = oid(req.params.imagenId);
    if (!iid) throw err(400, 'id inválido');
    await db.collection('productos_tienda').updateOne({ orgId: p.orgId, productoId: p._id }, { $pull: { imagenes: { imagenId: iid } }, $set: { updatedAt: new Date() } });
    // si ningún otro producto usa esa foto, se borra del todo
    const otra = await db.collection('productos_tienda').findOne({ orgId: p.orgId, 'imagenes.imagenId': iid });
    if (!otra) await db.collection('tienda_imagenes').deleteOne({ _id: iid, orgId: p.orgId });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- espacio de la base (Atlas gratis = 512 MB) y limpieza de fotos importadas
router.get('/almacenamiento', auth, async (req, res) => {
  try {
    const db = await getDb();
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    const filas = [];
    for (const c of cols) {
      try {
        const st = await db.command({ collStats: c.name });
        filas.push({ coleccion: c.name, mb: Math.round(((st.storageSize || 0) + (st.totalIndexSize || 0)) / 1048576 * 10) / 10, docs: st.count || 0 });
      } catch (e) { /* vista o sin permisos */ }
    }
    filas.sort((a, b) => b.mb - a.mb);
    const total = Math.round(filas.reduce((t, f) => t + f.mb, 0) * 10) / 10;
    const img = await db.collection('tienda_imagenes').aggregate([{ $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$bytes' } } }]).toArray();
    res.json({ totalMb: total, limiteMb: 512, top: filas.slice(0, 8), fotos: img[0] ? img[0].n : 0, fotosMb: img[0] ? Math.round(img[0].bytes / 1048576 * 10) / 10 : 0 });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/imagenes', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const r = await db.collection('tienda_imagenes').deleteMany({ orgId: req.orgId });
    await db.collection('productos_tienda').updateMany({ orgId: req.orgId }, { $set: { imagenes: [] } }).catch(() => {});
    res.json({ ok: true, borradas: r.deletedCount });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
