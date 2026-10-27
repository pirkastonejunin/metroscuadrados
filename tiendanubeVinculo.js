// ---------------------------------------------------------------------------
// Vincular los productos que ya están en Tiendanube con los del sistema (13/10/2026, pedido de Mato: "solo quiero vincular los
// que ya están en Tiendanube hacia nuestro sistema, a fines de poder actualizar precio y stock").
// Las fotos NO se copian: quedan en Tiendanube. El vínculo es el campo `skuTiendanube` del producto (el SKU con el que está
// publicado en Tiendanube); la sincronización de precios y la ficha lo usan en lugar del SKU propio si está cargado.
//   GET  /analizar   lee la tienda y propone pares (por SKU de Dux → producto viejo → producto nuevo por descripción)
//   POST /vincular   { pares:[{productoId, sku, productId, variantId}] }  guarda el vínculo
//   GET  /estado     cuántos productos tienen vínculo
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { tokensNombre, parecido } = require('./similitud');
const cotizador = require('./cotizador');
const portales = require('./portalesProveedores');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('productos')];
let client, conectando;
async function getDb() {
  if (!client) {
    if (!conectando) conectando = new MongoClient(process.env.MONGODB_URI).connect().then(c => { client = c; return c; }).catch(e => { conectando = null; throw e; });
    await conectando;
  }
  return client.db(DB_NAME);
}
const err = (status, message) => Object.assign(new Error(message), { status });
const oid = v => { try { return v ? new ObjectId(String(v)) : null; } catch (e) { return null; } };
const K = s => String(s == null ? '' : s).trim().toUpperCase();

async function productosTienda() {
  const storeId = process.env.TIENDA_REAL_STORE_ID;
  if (!storeId) throw err(400, 'Falta configurar la tienda de Tiendanube (TIENDA_REAL_STORE_ID).');
  const store = await cotizador.getStoreById(storeId);
  if (!store || !store.access_token) throw err(400, 'La tienda de Tiendanube no tiene un token de acceso válido.');
  const lista = await cotizador.fetchAllProducts(store.store_id, store.access_token);
  const filas = [];
  for (const p of lista) {
    const nombreP = cotizador.nombreLocalizado(p.name);
    for (const v of (p.variants || [])) {
      const vals = (v.values || []).map(x => cotizador.nombreLocalizado(x)).filter(Boolean).join(' ');
      filas.push({ publicado: p.published !== false, stock: v.stock == null ? null : Number(v.stock), promo: v.promotional_price != null && v.promotional_price !== '' ? parseFloat(v.promotional_price) : null, sku: String(v.sku || '').trim(), nombre: (nombreP + (vals ? ' ' + vals : '')).trim(), productId: p.id, variantId: v.id, precio: parseFloat(v.price), url: p.canonical_url || ((store.domain && cotizador.nombreLocalizado(p.handle)) ? `https://${store.domain}/productos/${cotizador.nombreLocalizado(p.handle)}` : null) });
    }
  }
  return filas;
}

router.get('/analizar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const filas = await productosTienda();
    const activos = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ sku: 1, nombre: 1, skuTiendanube: 1 }).toArray();
    const porSku = new Set(activos.map(p => K(p.sku)));
    const vinculados = new Set(activos.filter(p => p.skuTiendanube).map(p => K(p.skuTiendanube)));
    let directos = 0, yaVinculados = 0;
    const pendientes = [];
    for (const f of filas) {
      const k = K(f.sku);
      if (k && porSku.has(k)) { directos++; continue; }
      if (k && vinculados.has(k)) { yaVinculados++; continue; }
      pendientes.push(f);
    }
    // productos viejos (desactivados) con el SKU de Tiendanube: sirven de puente para encontrar el nuevo por nombre
    const skusPend = [...new Set(pendientes.map(f => K(f.sku)).filter(Boolean))];
    const viejos = new Map();
    const usarViejos = String(req.query.usarViejos || '') === '1';
    for (let i = 0; usarViejos && i < skusPend.length; i += 1000) {
      const lote = skusPend.slice(i, i + 1000);
      (await db.collection('productos_catalogo').find(Object.assign({ activo: false, sku: { $in: lote.concat(lote.map(x => x.toLowerCase())) } }, filtroOrg(req))).project({ sku: 1, nombre: 1 }).toArray()).forEach(p => viejos.set(K(p.sku), p.nombre));
    }
    // índice de palabras de los productos activos
    const cand = activos.filter(p => !p.skuTiendanube).map(p => ({ p, t: tokensNombre(p.nombre) }));
    const indice = new Map();
    cand.forEach((c, i) => c.t.forEach(w => { if (!indice.has(w)) indice.set(w, []); indice.get(w).push(i); }));
    const buscar = (tokens) => {
      const cuenta = new Map();
      for (const w of tokens) { const l = indice.get(w); if (!l || l.length > 2500) continue; for (const i of l) cuenta.set(i, (cuenta.get(i) || 0) + 1); }
      return [...cuenta.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([i]) => i);
    };
    const filasOut = pendientes.map(f => {
      const viejo = viejos.get(K(f.sku)) || null;
      const tf = tokensNombre(f.nombre), tv = viejo ? tokensNombre(viejo) : [];
      const idxs = buscar([...new Set([...tf, ...tv])]);
      const tops = idxs.map(i => ({ c: cand[i], s: Math.max(parecido(tf, cand[i].t), tv.length ? parecido(tv, cand[i].t) : 0) })).filter(x => x.s >= 0.3).sort((a, b) => b.s - a.s).slice(0, 3);
      return { f, viejo, tops };
    });
    const mejor = new Map();
    filasOut.forEach((r, i) => { const t = r.tops[0]; if (t) { const id = String(t.c.p._id); const p = mejor.get(id); if (!p || t.s > p.s) mejor.set(id, { s: t.s, i }); } });
    const propuestas = filasOut.map((r, i) => {
      const t = r.tops[0];
      const seguro = !!t && !!r.f.sku && t.s >= 0.6 && (!r.tops[1] || t.s - r.tops[1].s >= 0.1) && mejor.get(String(t.c.p._id)).i === i;
      return { sku: r.f.sku, nombre: r.f.nombre, productId: r.f.productId, variantId: r.f.variantId, precio: r.f.precio, url: r.f.url, productoViejo: r.viejo, seguro,
        candidatos: r.tops.map(x => ({ productoId: String(x.c.p._id), sku: x.c.p.sku || '', nombre: x.c.p.nombre || '', parecido: Math.round(x.s * 100) })) };
    }).sort((a, b) => (b.seguro - a.seguro) || ((b.candidatos[0] ? b.candidatos[0].parecido : -1) - (a.candidatos[0] ? a.candidatos[0].parecido : -1)));
    res.json({ enTienda: filas.length, directos, yaVinculados, pendientes: propuestas.length, sinSku: propuestas.filter(p => !p.sku).length, propuestas: propuestas.slice(0, 1500), hayMas: propuestas.length > 1500 });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/vincular', auth, async (req, res) => {
  try {
    const db = await getDb();
    const pares = Array.isArray((req.body || {}).pares) ? req.body.pares : [];
    let guardados = 0; const rechazados = []; const vistosSku = new Set(), vistosProd = new Set();
    for (const par of pares.slice(0, 3000)) {
      const sku = String(par.sku || '').trim(); const pid = oid(par.productoId);
      if (!sku || !pid) { rechazados.push({ sku, motivo: 'faltan datos (la variante necesita SKU en Tiendanube)' }); continue; }
      if (vistosSku.has(K(sku)) || vistosProd.has(String(pid))) { rechazados.push({ sku, motivo: 'repetido en la selección' }); continue; }
      const otro = await db.collection('productos_catalogo').findOne(Object.assign({ skuTiendanube: sku, _id: { $ne: pid }, activo: { $ne: false } }, filtroOrg(req)));
      if (otro) { rechazados.push({ sku, motivo: 'ya está vinculado con "' + (otro.nombre || otro.sku) + '"' }); continue; }
      const r = await db.collection('productos_catalogo').updateOne(Object.assign({ _id: pid }, filtroOrg(req)), { $set: { skuTiendanube: sku, tiendanube: { productId: Number(par.productId) || null, variantId: Number(par.variantId) || null, vinculadoEn: new Date() }, updatedAt: new Date() } });
      if (r.matchedCount) { guardados++; vistosSku.add(K(sku)); vistosProd.add(String(pid)); } else rechazados.push({ sku, motivo: 'producto no encontrado' });
    }
    res.json({ ok: true, guardados, rechazados });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Buscador manual: productos activos por SKU o por palabras del nombre (para las filas que no tuvieron pareja clara)
router.get('/buscar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!palabras.length || palabras.join('').length < 2) return res.json([]);
    const filtro = Object.assign({ activo: { $ne: false }, $and: palabras.map(w => ({ $or: [{ nombre: { $regex: w, $options: 'i' } }, { sku: { $regex: w, $options: 'i' } }] })) }, filtroOrg(req));
    const lista = await db.collection('productos_catalogo').find(filtro).project({ sku: 1, nombre: 1, skuTiendanube: 1 }).limit(15).toArray();
    res.json(lista.map(p => ({ productoId: String(p._id), sku: p.sku || '', nombre: p.nombre || '', vinculado: !!p.skuTiendanube })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Vínculos actuales: cada variante de Tiendanube con el producto del sistema al que corresponde, y los dos precios lado a lado.
router.get('/vinculos', auth, async (req, res) => {
  try {
    const db = await getDb();
    const { precioResuelto } = require('./productos');
    const listas = await db.collection('productos_listas_precio').find(Object.assign({ activa: { $ne: false } }, filtroOrg(req))).toArray();
    let lista = null;
    if (req.query.listaId) lista = listas.find(l => String(l._id) === String(req.query.listaId));
    if (!lista) lista = listas.find(l => l.formula === 'cf_x_bulto') || listas.find(l => /tienda/i.test(l.nombre || '')) || listas.find(l => l.predeterminada) || listas[0] || null;
    const cot = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' }).then(d => d && d.valor).catch(() => null);
    const filas = await productosTienda();
    const prods = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ sku: 1, nombre: 1, skuTiendanube: 1, precio: 1, preciosPorLista: 1, unidadesPorBulto: 1, costo: 1, moneda: 1, porcentajeIva: 1, unidad: 1, tipoUnidad: 1 }).toArray();
    const porSku = new Map(), porTn = new Map();
    for (const p of prods) { if (p.sku) porSku.set(K(p.sku), p); if (p.skuTiendanube) porTn.set(K(p.skuTiendanube), p); }
    const out = filas.map(f => {
      const k = K(f.sku); let p = null, tipo = 'sin';
      if (k && porTn.has(k)) { p = porTn.get(k); tipo = 'manual'; } else if (k && porSku.has(k)) { p = porSku.get(k); tipo = 'sku'; }
      let precioSistema = null;
      if (p && lista) { try { precioSistema = precioResuelto(p, lista, cot).precio; } catch (e) { precioSistema = null; } }
      return { tn: { publicado: f.publicado, sku: f.sku, nombre: f.nombre, precio: f.precio, promo: f.promo, stock: f.stock, url: f.url, productId: f.productId, variantId: f.variantId },
        producto: p ? { _id: String(p._id), sku: p.sku || '', nombre: p.nombre || '', unidad: p.unidad || '', porM2: p.unidad === 'm2' || p.tipoUnidad === 'superficie' || /\(m²\)\s*$/.test(String(p.nombre || '')), bulto: p.unidadesPorBulto > 0 ? p.unidadesPorBulto : null, precioUnitario: p.precio == null ? null : p.precio } : null, tipo, precioSistema: precioSistema == null ? null : precioSistema };
    });
    const resumen = { total: out.length, porSku: out.filter(r => r.tipo === 'sku').length, manuales: out.filter(r => r.tipo === 'manual').length, sinVinculo: out.filter(r => r.tipo === 'sin').length,
      conDiferencia: out.filter(r => r.producto && r.precioSistema != null && Number.isFinite(r.tn.precio) && Math.abs(r.precioSistema - r.tn.precio) >= 0.5).length,
      sinPrecioSistema: out.filter(r => r.producto && r.precioSistema == null).length,
      m2SinBulto: out.filter(r => r.producto && r.producto.porM2 && !r.producto.bulto).length, noPublicados: out.filter(r => r.tn.publicado === false).length };
    res.json({ lista: lista ? String(lista._id) : null, listas: listas.map(l => ({ _id: String(l._id), nombre: l.nombre })), resumen, filas: out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Datos actuales de UN producto del sistema (para refrescar la fila después de editarlo en la ventana emergente, sin volver a leer Tiendanube).
router.get('/vinculos/producto/:id', auth, async (req, res) => {
  try {
    const db = await getDb(); const { precioResuelto } = require('./productos'); const pid = oid(req.params.id);
    if (!pid) throw err(400, 'id inválido');
    const p = await db.collection('productos_catalogo').findOne(Object.assign({ _id: pid }, filtroOrg(req)));
    if (!p) throw err(404, 'Producto no encontrado');
    const { lista } = await listaDePrecios(db, req, req.query.listaId);
    const cot = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' }).then(d => d && d.valor).catch(() => null);
    let precioSistema = null; if (lista) { try { precioSistema = precioResuelto(p, lista, cot).precio; } catch (e) { precioSistema = null; } }
    res.json({ producto: { _id: String(p._id), sku: p.sku || '', nombre: p.nombre || '', unidad: p.unidad || '', porM2: p.unidad === 'm2' || p.tipoUnidad === 'superficie' || /\(m²\)\s*$/.test(String(p.nombre || '')), bulto: p.unidadesPorBulto > 0 ? p.unidadesPorBulto : null, precioUnitario: p.precio == null ? null : p.precio }, precioSistema: precioSistema == null ? null : precioSistema });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Deja marcados como vinculados (skuTiendanube = sku) los productos que están en la tienda con el MISMO SKU, para que se vean con el tilde en Productos.
router.post('/vinculos/confirmar-sku', auth, async (req, res) => {
  try {
    const db = await getDb(); const filas = await productosTienda(); const tn = new Map();
    for (const f of filas) { const k = K(f.sku); if (k && !tn.has(k)) tn.set(k, f); }
    const prods = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false }, skuTiendanube: { $in: [null, ''] }, sku: { $nin: [null, ''] } }, filtroOrg(req))).project({ sku: 1 }).toArray();
    const ops = []; const ahora = new Date();
    for (const p of prods) { const f = tn.get(K(p.sku)); if (f) ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { skuTiendanube: p.sku, tiendanube: { productId: f.productId || null, variantId: f.variantId || null, vinculadoEn: ahora }, updatedAt: ahora } } } }); }
    for (let i = 0; i < ops.length; i += 500) await db.collection('productos_catalogo').bulkWrite(ops.slice(i, i + 500), { ordered: false });
    res.json({ ok: true, marcados: ops.length });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/desvincular', auth, async (req, res) => {
  try {
    const db = await getDb(); const pid = oid((req.body || {}).productoId);
    if (!pid) throw err(400, 'Falta el producto.');
    const r = await db.collection('productos_catalogo').updateOne(Object.assign({ _id: pid }, filtroOrg(req)), { $unset: { skuTiendanube: '', tiendanube: '' }, $set: { updatedAt: new Date() } });
    res.json({ ok: true, modificados: r.modifiedCount });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});


// ---------------------------------------------------------------------------
// Publicar en Tiendanube productos que están en el sistema y todavía no en la tienda (13/10/2026). Se crean SIN PUBLICAR para
// revisarlos en Tiendanube. Nombre, SKU, precio (lista elegida), stock (todos los depósitos, menos lo comprometido), categoría
// (según el rubro), marca y fotos (de Maxipiso, por link, si el producto viene de su catálogo). Peso y medidas van en cero.
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tiendaConfig() {
  const storeId = process.env.TIENDA_REAL_STORE_ID;
  if (!storeId) throw err(400, 'Falta configurar la tienda de Tiendanube (TIENDA_REAL_STORE_ID).');
  const store = await cotizador.getStoreById(storeId);
  if (!store || !store.access_token) throw err(400, 'La tienda de Tiendanube no tiene un token de acceso válido.');
  return store;
}
async function tnFetch(store, ruta, opts) {
  const r = await fetch(cotizador.API_BASE + '/' + store.store_id + ruta, Object.assign({ headers: cotizador.apiHeaders(store.access_token) }, opts || {}));
  const txt = await r.text(); let data = null; try { data = JSON.parse(txt); } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}
async function listaDePrecios(db, req, listaId) {
  const listas = await db.collection('productos_listas_precio').find(Object.assign({ activa: { $ne: false } }, filtroOrg(req))).toArray();
  return { listas, lista: (listaId && listas.find(l => String(l._id) === String(listaId))) || listas.find(l => l.formula === 'cf_x_bulto') || listas.find(l => /tienda/i.test(l.nombre || '')) || listas.find(l => l.predeterminada) || listas[0] || null };
}
async function stockDisponible(db, ids) {
  const m = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.collection('stock_actual').aggregate([{ $match: { productoId: { $in: ids.slice(i, i + 1000) } } }, { $group: { _id: '$productoId', c: { $sum: { $ifNull: ['$cantidad', 0] } }, r: { $sum: { $ifNull: ['$cantidadComprometida', 0] } } } }]).toArray();
    rows.forEach(r => m.set(String(r._id), Math.max(0, (r.c || 0) - (r.r || 0))));
  }
  return m;
}
const normCat = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

router.get('/publicar/datos', auth, async (req, res) => {
  try {
    const db = await getDb(); const store = await tiendaConfig();
    const c = await tnFetch(store, '/categories?per_page=200');
    const categorias = Array.isArray(c.data) ? c.data.map(x => ({ id: x.id, nombre: cotizador.nombreLocalizado(x.name), padre: x.parent || null })) : [];
    const rubros = await db.collection('productos_catalogo').aggregate([{ $match: Object.assign({ activo: { $ne: false }, skuTiendanube: { $in: [null, ''] } }, filtroOrg(req)) }, { $group: { _id: '$rubro', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
    const guardado = await db.collection('config_general').findOne({ clave: 'tnCategoriasRubro', orgId: req.orgId }).then(d => (d && d.valor) || {}).catch(() => ({}));
    const sugerir = (rubro) => {
      const r = normCat(rubro); if (!r) return null;
      const palabras = r.split(' ').filter(w => w.length > 2); let mejor = null, ms = 0;
      for (const cat of categorias) { const n = normCat(cat.nombre); let s = 0; if (n === r) s = 100; else if (n.includes(r) || r.includes(n)) s = 60; else s = palabras.filter(w => n.includes(w.replace(/s$/, ''))).length * 10; if (s > ms) { ms = s; mejor = cat; } }
      return ms >= 10 && mejor ? mejor.id : null;
    };
    const { listas, lista } = await listaDePrecios(db, req, req.query.listaId);
    res.json({ categorias, rubros: rubros.map(r => ({ rubro: r._id || '', n: r.n, categoriaId: guardado[r._id || ''] || sugerir(r._id) })), listas: listas.map(l => ({ _id: String(l._id), nombre: l.nombre })), lista: lista ? String(lista._id) : null });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/publicar/mapa', auth, async (req, res) => {
  try {
    const db = await getDb(); const mapa = (req.body || {}).mapa || {};
    const limpio = {}; for (const k of Object.keys(mapa)) { const v = Number(mapa[k]); if (v) limpio[k] = v; }
    await db.collection('config_general').updateOne({ clave: 'tnCategoriasRubro', orgId: req.orgId }, { $set: { clave: 'tnCategoriasRubro', orgId: req.orgId, valor: limpio, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/publicar/candidatos', auth, async (req, res) => {
  try {
    const db = await getDb(); const { precioResuelto } = require('./productos');
    const { lista } = await listaDePrecios(db, req, req.query.listaId);
    const cot = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' }).then(d => d && d.valor).catch(() => null);
    const verDescartados = req.query.descartados === '1';
    const filtro = Object.assign({ activo: { $ne: false }, skuTiendanube: { $in: [null, ''] }, sku: { $nin: [null, ''] }, noTiendanube: verDescartados ? true : { $ne: true } }, filtroOrg(req));
    if (req.query.rubro !== undefined && req.query.rubro !== 'todos') filtro.rubro = req.query.rubro === '' ? { $in: [null, ''] } : req.query.rubro;
    const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (palabras.length) filtro.$and = palabras.map(w => ({ $or: [{ nombre: { $regex: w, $options: 'i' } }, { sku: { $regex: w, $options: 'i' } }, { marca: { $regex: w, $options: 'i' } }] }));
    // los que ya están en la tienda con ese SKU no se ofrecen
    const store = await tiendaConfig(); const enTienda = new Set((await productosTienda()).map(f => K(f.sku)).filter(Boolean));
    let prods = (await db.collection('productos_catalogo').find(filtro).project({ sku: 1, nombre: 1, rubro: 1, marca: 1, precio: 1, preciosPorLista: 1, unidadesPorBulto: 1, costo: 1, moneda: 1, codigoExterno: 1, proveedorId: 1, proveedor: 1, descripcion: 1 }).sort({ nombre: 1 }).limit(20000).toArray()).filter(p => !enTienda.has(K(p.sku)));
    const limite = Math.min(3000, Math.max(50, Number(req.query.limite) || 400));
    // Opciones de los filtros de marca y proveedor (sobre lo que ya pasó los otros filtros)
    const cuenta = (fn) => { const m = new Map(); prods.forEach(p => { const k = fn(p); if (k && k.v) m.set(k.v, { v: k.v, n: k.n, c: ((m.get(k.v) || {}).c || 0) + 1 }); }); return [...m.values()].sort((a, b) => String(a.n).localeCompare(String(b.n), 'es')); };
    const marcas = cuenta(p => p.marca ? { v: p.marca, n: p.marca } : null), proveedores = cuenta(p => (p.proveedorId || p.proveedor) ? { v: String(p.proveedorId || p.proveedor), n: p.proveedor || '(sin nombre)' } : null);
    if (req.query.marca) prods = prods.filter(p => (p.marca || '') === req.query.marca);
    if (req.query.proveedor) prods = prods.filter(p => String(p.proveedorId || p.proveedor || '') === req.query.proveedor);
    const filtroStock = req.query.stock === 'con' || req.query.stock === 'sin' ? req.query.stock : '';
    let stock;
    if (filtroStock) { stock = await stockDisponible(db, prods.map(p => p._id)); prods = prods.filter(p => { const s = stock.get(String(p._id)) || 0; return filtroStock === 'con' ? s > 0 : s <= 0; }); }
    else stock = await stockDisponible(db, prods.slice(0, limite).map(p => p._id));
    const { precioResuelto: pr } = { precioResuelto };
    res.json({ total: prods.length, productos: prods.slice(0, limite).map(p => { let precio = null; try { precio = lista ? pr(p, lista, cot).precio : null; } catch (e) { precio = null; } return { _id: String(p._id), sku: p.sku, nombre: p.nombre, rubro: p.rubro || '', marca: p.marca || '', precio, stock: stock.get(String(p._id)) || 0, proveedor: p.proveedor || '', conPortal: !!p.codigoExterno && !!p.proveedorId }; }), hayMas: prods.length > limite, limite, marcas, proveedores });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Fotos de Maxipiso (por producto del sistema), con caché de 10 minutos para no iniciar sesión en cada tanda.
const cachePortal = new Map();
async function fotosPorCodigo(db, provId, req) {
  const k = String(provId); const c = cachePortal.get(k);
  if (c && Date.now() - c.t < 600000) return c.m;
  const prov = await db.collection('proveedores').findOne(Object.assign({ _id: provId }, filtroOrg(req)));
  const m = new Map();
  if (prov && prov.portal) {
    const filas = await portales.filasDePortal(prov.portal, prov.reglaImport || {});
    for (const f of filas) if ((f.imagenes && f.imagenes.length) || f.pesoCaja) m.set(K(f.codigo), { imagenes: f.imagenes || [], pesoCaja: f.pesoCaja || null });
  }
  cachePortal.set(k, { t: Date.now(), m }); return m;
}

// "Este producto nunca va a Tiendanube": sale de la lista de candidatos (y se puede volver a traer con "Ver descartados").
router.post('/publicar/descartar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const ids = (Array.isArray((req.body || {}).productoIds) ? req.body.productoIds : []).map(oid).filter(Boolean).slice(0, 5000);
    const descartar = (req.body || {}).descartar !== false;
    const r = await db.collection('productos_catalogo').updateMany(Object.assign({ _id: { $in: ids } }, filtroOrg(req)), descartar ? { $set: { noTiendanube: true, noTiendanubeEn: new Date() } } : { $unset: { noTiendanube: '', noTiendanubeEn: '' } });
    res.json({ ok: true, modificados: r.modifiedCount });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/publicar', auth, async (req, res) => {
  try {
    const db = await getDb(); const store = await tiendaConfig(); const { precioResuelto } = require('./productos');
    const ids = (Array.isArray((req.body || {}).productoIds) ? req.body.productoIds : []).map(oid).filter(Boolean).slice(0, 12);
    const { lista } = await listaDePrecios(db, req, (req.body || {}).listaId);
    const cot = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' }).then(d => d && d.valor).catch(() => null);
    const mapa = await db.collection('config_general').findOne({ clave: 'tnCategoriasRubro', orgId: req.orgId }).then(d => (d && d.valor) || {}).catch(() => ({}));
    const prods = await db.collection('productos_catalogo').find(Object.assign({ _id: { $in: ids } }, filtroOrg(req))).toArray();
    const stock = await stockDisponible(db, prods.map(p => p._id));
    const resultados = [];
    for (const p of prods) {
      try {
        if (p.skuTiendanube) { resultados.push({ sku: p.sku, ok: false, motivo: 'ya está vinculado con Tiendanube' }); continue; }
        if (require('./productos').sinBultoPorM2(p)) { resultados.push({ sku: p.sku, ok: false, motivo: 'es por m² y no tiene los m² por caja cargados' }); continue; }
        const precio = lista ? precioResuelto(p, lista, cot).precio : null;
        if (!(precio > 0)) { resultados.push({ sku: p.sku, ok: false, motivo: 'no tiene precio en la lista elegida' }); continue; }
        let imagenes = [], pesoCaja = null;
        if (p.codigoExterno && p.proveedorId) { try { const m = await fotosPorCodigo(db, p.proveedorId, req); const d = m.get(K(p.codigoExterno)); if (d) { imagenes = d.imagenes; pesoCaja = d.pesoCaja; } } catch (e) { /* sin fotos */ } }
        const cat = mapa[p.rubro || ''];
        const body = { name: { es: p.nombre }, published: false, variants: [{ sku: p.sku, price: String(precio), stock_management: true, stock: Math.max(0, Math.floor(stock.get(String(p._id)) || 0)), weight: pesoCaja ? pesoCaja.toFixed(3) : '0.000', width: '0.00', height: '0.00', depth: '0.00' }] };
        if (p.descripcion) body.description = { es: String(p.descripcion) };
        if (p.marca) body.brand = p.marca;
        if (cat) body.categories = [cat];
        if (imagenes.length) body.images = imagenes.map(src => ({ src }));
        const r = await tnFetch(store, '/products', { method: 'POST', body: JSON.stringify(body) });
        if (!r.ok) { resultados.push({ sku: p.sku, ok: false, motivo: 'Tiendanube respondió ' + r.status + ': ' + (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).slice(0, 180) }); await sleep(600); continue; }
        const variante = r.data && r.data.variants && r.data.variants[0];
        await db.collection('productos_catalogo').updateOne({ _id: p._id }, { $set: { skuTiendanube: p.sku, tiendanube: { productId: r.data && r.data.id || null, variantId: variante && variante.id || null, vinculadoEn: new Date(), creadoDesdeSistema: true }, updatedAt: new Date() } });
        resultados.push({ sku: p.sku, ok: true, fotos: imagenes.length, categoria: !!cat });
        await sleep(600);
      } catch (e) { resultados.push({ sku: p.sku, ok: false, motivo: e.message }); }
    }
    res.json({ resultados });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Stock hacia Tiendanube (13/10/2026): stock de la tienda = suma de TODOS los depósitos (Junín + Colomé) menos lo comprometido.
// Primero se compara (no cambia nada) y después se envía lo tildado. Las variantes con stock ilimitado en la tienda no se tocan salvo que se pida.
// ---------------------------------------------------------------------------
router.get('/stock/comparar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const filas = await productosTienda();
    const prods = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ sku: 1, nombre: 1, skuTiendanube: 1 }).toArray();
    const porSku = new Map(), porTn = new Map();
    for (const p of prods) { if (p.sku) porSku.set(K(p.sku), p); if (p.skuTiendanube) porTn.set(K(p.skuTiendanube), p); }
    const pares = [];
    for (const f of filas) { const k = K(f.sku); const p = k && (porTn.get(k) || porSku.get(k)); if (p) pares.push({ f, p }); }
    const stock = await stockDisponible(db, pares.map(x => x.p._id));
    const out = pares.map(({ f, p }) => { const s = stock.get(String(p._id)) || 0; const ilimitado = f.stock == null;
      return { productoId: String(p._id), sku: p.sku, nombre: p.nombre || f.nombre, productId: f.productId, variantId: f.variantId, tnStock: f.stock, ilimitado, sistema: s, diferencia: ilimitado ? null : s - f.stock }; });
    const dif = out.filter(r => !r.ilimitado && Math.abs(r.diferencia) > 0.0001);
    res.json({ resumen: { vinculados: out.length, iguales: out.filter(r => !r.ilimitado && Math.abs(r.diferencia) <= 0.0001).length, distintos: dif.length, ilimitados: out.filter(r => r.ilimitado).length, sinPareja: filas.length - out.length }, filas: out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/stock/enviar', auth, async (req, res) => {
  try {
    const db = await getDb(); const store = await tiendaConfig();
    const items = (Array.isArray((req.body || {}).items) ? req.body.items : []).slice(0, 20);
    const ids = items.map(i => oid(i.productoId)).filter(Boolean);
    const prods = await db.collection('productos_catalogo').find(Object.assign({ _id: { $in: ids } }, filtroOrg(req))).project({ sku: 1 }).toArray();
    const ok = new Set(prods.map(p => String(p._id)));
    const stock = await stockDisponible(db, prods.map(p => p._id));
    const resultados = [];
    for (const it of items) {
      const pid = String(it.productoId || ''); const sku = (prods.find(p => String(p._id) === pid) || {}).sku;
      try {
        if (!ok.has(pid) || !Number(it.productId) || !Number(it.variantId)) { resultados.push({ sku, ok: false, motivo: 'datos incompletos' }); continue; }
        const cantidad = Math.floor(stock.get(pid) || 0);
        const r = await tnFetch(store, '/products/' + Number(it.productId) + '/variants/' + Number(it.variantId), { method: 'PUT', body: JSON.stringify({ stock: cantidad, stock_management: true }) });
        if (!r.ok) { resultados.push({ sku, ok: false, motivo: 'Tiendanube respondió ' + r.status }); await sleep(600); continue; }
        resultados.push({ sku, ok: true, stock: cantidad });
        await sleep(600);
      } catch (e) { resultados.push({ sku, ok: false, motivo: e.message }); }
    }
    res.json({ resultados });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/estado', auth, async (req, res) => {
  try {
    const db = await getDb();
    res.json({ vinculados: await db.collection('productos_catalogo').countDocuments(Object.assign({ activo: { $ne: false }, skuTiendanube: { $exists: true, $ne: '' } }, filtroOrg(req))) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
module.exports = router;
