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
      filas.push({ stock: v.stock == null ? null : Number(v.stock), promo: v.promotional_price != null && v.promotional_price !== '' ? parseFloat(v.promotional_price) : null, sku: String(v.sku || '').trim(), nombre: (nombreP + (vals ? ' ' + vals : '')).trim(), productId: p.id, variantId: v.id, precio: parseFloat(v.price), url: (store.domain && p.handle) ? `https://${store.domain}/productos/${p.handle}` : null });
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
    const prods = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ sku: 1, nombre: 1, skuTiendanube: 1, precio: 1, preciosPorLista: 1, unidadesPorBulto: 1, costo: 1, moneda: 1, porcentajeIva: 1 }).toArray();
    const porSku = new Map(), porTn = new Map();
    for (const p of prods) { if (p.sku) porSku.set(K(p.sku), p); if (p.skuTiendanube) porTn.set(K(p.skuTiendanube), p); }
    const out = filas.map(f => {
      const k = K(f.sku); let p = null, tipo = 'sin';
      if (k && porTn.has(k)) { p = porTn.get(k); tipo = 'manual'; } else if (k && porSku.has(k)) { p = porSku.get(k); tipo = 'sku'; }
      let precioSistema = null;
      if (p && lista) { try { precioSistema = precioResuelto(p, lista, cot).precio; } catch (e) { precioSistema = null; } }
      return { tn: { sku: f.sku, nombre: f.nombre, precio: f.precio, promo: f.promo, stock: f.stock, url: f.url, productId: f.productId, variantId: f.variantId },
        producto: p ? { _id: String(p._id), sku: p.sku || '', nombre: p.nombre || '' } : null, tipo, precioSistema: precioSistema == null ? null : precioSistema };
    });
    const resumen = { total: out.length, porSku: out.filter(r => r.tipo === 'sku').length, manuales: out.filter(r => r.tipo === 'manual').length, sinVinculo: out.filter(r => r.tipo === 'sin').length,
      conDiferencia: out.filter(r => r.producto && r.precioSistema != null && Number.isFinite(r.tn.precio) && Math.abs(r.precioSistema - r.tn.precio) >= 0.5).length,
      sinPrecioSistema: out.filter(r => r.producto && r.precioSistema == null).length };
    res.json({ lista: lista ? String(lista._id) : null, listas: listas.map(l => ({ _id: String(l._id), nombre: l.nombre })), resumen, filas: out });
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

router.get('/estado', auth, async (req, res) => {
  try {
    const db = await getDb();
    res.json({ vinculados: await db.collection('productos_catalogo').countDocuments(Object.assign({ activo: { $ne: false }, skuTiendanube: { $exists: true, $ne: '' } }, filtroOrg(req))) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
module.exports = router;
