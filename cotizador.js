// ---------------------------------------------------------------------------
// Cotizador de obra — módulo adicional para la app "Calculadora m2".
//
// Se monta como router Express dentro del server.js existente. Lee la MISMA
// base Mongo Atlas (db "calculadora_m2") y las mismas colecciones "stores" y
// "rendimientos" que ya usa la app (no las toca, solo lee), y agrega
// colecciones nuevas propias de este módulo:
//   - tipos_obra        : tipos de obra configurados (Piso flotante, Deck...)
//                         con el rubro real de Tiendanube para piso y zócalo
//   - tipo_obra_items   : catálogos por SKU propios de cada tipo de obra
//                         (categoria: 'puerta' | 'nivelacion' | 'manta' |
//                         'pegamento') — productos que no tienen rubro propio
//                         en Tiendanube, precargados una vez y reutilizados
//                         en cada cotización de ESE tipo de obra puntual
//   - formas_pago       : formas de pago con % de descuento o recargo
//   - tarifas_mano_obra : tarifa de mano de obra, propia de cada tipo de obra
//                         (store_id + tipoObraId) — cada tipo de obra cotiza
//                         su propia mano de obra, con un mínimo de m²
//                         cotizables (minimoM2Cotizable)
//   - cotizaciones      : historial de presupuestos armados
//
// Integración (ver INTEGRACION.md): en server.js
//   const cotizadorRouter = require('./cotizador');
//   app.use('/api/cotizador', cotizadorRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const PDFDocument = require('pdfkit');

const router = express.Router();

// Logo de Piedra Negra (PNG con fondo transparente), para el encabezado del
// PDF y para el header de las páginas HTML (servido como estático en
// /assets/logo-piedra-negra.png). El PNG no se sube como archivo binario
// aparte: se guarda acá en base64 y se escribe a disco una sola vez al
// arrancar el servidor, si todavía no existe.
const LOGO_PNG_PATH = path.join(__dirname, 'public', 'assets', 'logo-piedra-negra.png');
const LOGO_PNG_BASE64 = "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";
try {
  if (!fs.existsSync(LOGO_PNG_PATH)) {
    fs.mkdirSync(path.dirname(LOGO_PNG_PATH), { recursive: true });
    fs.writeFileSync(LOGO_PNG_PATH, Buffer.from(LOGO_PNG_BASE64, 'base64'));
  }
} catch (e) {
  // Si falla (por ejemplo, filesystem de solo lectura), dibujarMarca() más
  // abajo cae al wordmark en texto como respaldo.
}

const API_BASE = 'https://api.tiendanube.com/v1';
const CATEGORIAS_ITEM = ['puerta', 'nivelacion', 'manta', 'pegamento'];
const ETIQUETA_CATEGORIA = {
  puerta: 'Niveladores de puerta',
  nivelacion: 'Nivelantes de piso',
  manta: 'Manta',
  pegamento: 'Silicona/pegamento para zócalo'
};

// Descripción corta y legible del alcance de la obra, en base a los datos
// cargados en el paso 2 (sin precios ni productos puntuales). La usan tanto
// la vista detallada como la vista "llave en mano" del PDF.
function descripcionObra(o) {
  o = o || {};
  const datos = [];
  if (o.m2Pisos) datos.push(o.m2Pisos + ' m2 de piso');
  if (o.mlZocalos) datos.push(o.mlZocalos + ' ml de zócalo');
  if (o.cantidadPuertas) datos.push(o.cantidadPuertas + ' puerta(s)');
  if (o.requiereNivelacion) datos.push('con nivelación');
  if (o.utilizaManta) datos.push('con manta');
  if (o.manoObra) datos.push('con mano de obra');
  return datos.join(' · ');
}

// ---------- Mongo (misma base que server.js) ----------

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (err) {
      mongoClient = null;
      throw err;
    }
  }
  return mongoClient.db('calculadora_m2');
}

async function conReintento(fn) {
  try {
    return await fn();
  } catch (err) {
    mongoClient = null; // fuerza reconexion, igual que en server.js
    return await fn();
  }
}

async function getStoresCollection() { return (await getDb()).collection('stores'); }
async function getRendimientosCollection() { return (await getDb()).collection('rendimientos'); }
async function getTarifasCollection() { return (await getDb()).collection('tarifas_mano_obra'); }
async function getCotizacionesCollection() { return (await getDb()).collection('cotizaciones'); }
async function getTiposObraCollection() { return (await getDb()).collection('tipos_obra'); }
async function getTipoObraItemsCollection() { return (await getDb()).collection('tipo_obra_items'); }
async function getFormasPagoCollection() { return (await getDb()).collection('formas_pago'); }

async function getStoreById(storeId) {
  return conReintento(async () => {
    const col = await getStoresCollection();
    return col.findOne({ _id: parseInt(storeId, 10) });
  });
}

async function getStoreFromQuery(req) {
  const storeId = req.query.store_id || (req.body && req.body.store_id);
  if (!storeId) {
    const err = new Error('Falta el parametro store_id.');
    err.status = 400;
    throw err;
  }
  const store = await getStoreById(storeId);
  if (!store) {
    const err = new Error('Esa tienda no esta instalada todavia.');
    err.status = 404;
    throw err;
  }
  return store;
}

async function getRendimientosDeTienda(storeId) {
  return conReintento(async () => {
    const col = await getRendimientosCollection();
    return col.find({ store_id: storeId }).toArray();
  });
}

// ---------- Tarifas de mano de obra ----------

const TARIFA_DEFAULT = {
  pisos_m2: 0,
  zocalos_ml: 0,
  puertas_unidad: 0,
  nivelacion_m2: 0,
  minimoM2Cotizable: 0
};

// Las tarifas de mano de obra son propias de cada tipo de obra (cada obra
// tiene su propia cotización de mano de obra), por eso se buscan/guardan por
// store_id + tipoObraId en vez de una única tarifa por tienda.
// minimoM2Cotizable: aunque la obra tenga menos m2, la mano de obra ligada a
// m2 (piso y nivelación) se cobra como mínimo sobre esta cantidad.
async function getTarifas(storeId, tipoObraId) {
  return conReintento(async () => {
    const col = await getTarifasCollection();
    const doc = await col.findOne({ store_id: storeId, tipoObraId: String(tipoObraId) });
    return Object.assign({}, TARIFA_DEFAULT, doc || {});
  });
}

async function setTarifas(storeId, tipoObraId, tarifas) {
  const datos = {
    pisos_m2: Number(tarifas.pisos_m2) || 0,
    zocalos_ml: Number(tarifas.zocalos_ml) || 0,
    puertas_unidad: Number(tarifas.puertas_unidad) || 0,
    nivelacion_m2: Number(tarifas.nivelacion_m2) || 0,
    minimoM2Cotizable: Number(tarifas.minimoM2Cotizable) || 0
  };
  await conReintento(async () => {
    const col = await getTarifasCollection();
    await col.updateOne(
      { store_id: storeId, tipoObraId: String(tipoObraId) },
      { $set: Object.assign({ store_id: storeId, tipoObraId: String(tipoObraId) }, datos) },
      { upsert: true }
    );
  });
  return datos;
}

// ---------- Tiendanube: productos configurados (con rendimiento + precio) ----------

function apiHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': process.env.USER_AGENT
  };
}

function nombreLocalizado(campo) {
  if (!campo) return '';
  return campo.es || Object.values(campo)[0] || '';
}

async function fetchAllProducts(storeId, accessToken) {
  let todos = [];
  let page = 1;
  while (true) {
    const response = await fetch(
      API_BASE + '/' + storeId + '/products?per_page=200&page=' + page +
        '&fields=id,name,variants,handle,categories,images',
      { headers: apiHeaders(accessToken) }
    );
    const pagina = await response.json();
    if (!Array.isArray(pagina) || pagina.length === 0) break;
    todos = todos.concat(pagina);
    if (pagina.length < 200) break;
    page++;
  }
  return todos;
}

// Devuelve solo los productos que Mato ya configuro con rendimiento (misma
// info que carga en el admin de la calculadora m2), sumando precio actual e
// imagen desde Tiendanube para poder armar el presupuesto.
async function productosConfigurados(store) {
  const [productos, rendimientos] = await Promise.all([
    fetchAllProducts(store.store_id, store.access_token),
    getRendimientosDeTienda(store.store_id)
  ]);

  const porProductId = {};
  rendimientos.forEach((r) => { porProductId[r.product_id] = r; });

  return productos
    .filter((p) => porProductId[p.id])
    .map((p) => {
      const cache = porProductId[p.id];
      const variante = p.variants && p.variants[0];
      return {
        id: p.id,
        nombre: nombreLocalizado(p.name),
        handle: nombreLocalizado(p.handle),
        categoria: (p.categories && p.categories.length)
          ? p.categories.map((c) => nombreLocalizado(c.name)).filter(Boolean).join(' / ')
          : '',
        tipo: cache.tipo,
        cobertura: parseFloat(cache.cobertura),
        envase: cache.envase || 'caja',
        precio: variante && variante.price ? parseFloat(variante.price) : null,
        imagen: p.images && p.images[0] ? p.images[0].src : null
      };
    })
    .filter((p) => p.cobertura > 0 && p.precio !== null);
}

// Busca UN producto puntual por SKU exacto en Tiendanube (para niveladores de
// puerta, nivelantes de piso, manta y silicona/pegamento, que no tienen rubro
// propio). No usa cache: el precio que trae siempre es el vigente.
async function productoPorSku(store, sku) {
  const response = await fetch(
    API_BASE + '/' + store.store_id + '/products?q=' + encodeURIComponent(sku) +
      '&fields=id,name,handle,variants,images&per_page=10',
    { headers: apiHeaders(store.access_token) }
  );
  const productos = await response.json();
  if (!Array.isArray(productos)) return null;

  for (const p of productos) {
    if (!p.variants) continue;
    for (const v of p.variants) {
      if (v.sku && String(v.sku).toLowerCase() === String(sku).toLowerCase()) {
        return {
          nombre: nombreLocalizado(p.name),
          precio: v.price ? parseFloat(v.price) : null,
          imagen: p.images && p.images[0] ? p.images[0].src : null,
          variant_id: v.id
        };
      }
    }
  }
  return null;
}

// ---------- Calculo de la cotizacion (funcion pura, sin red ni DB) ----------

// producto: { id, nombre, tipo, cobertura, envase, precio, categoria }
function calcularItem({ rubro, unidadObra, cantidadObra, producto, desperdicioPct }) {
  const pct = Number(desperdicioPct) || 0;
  const factor = 1 + pct / 100;
  const cantidadConDesperdicio = cantidadObra * factor;
  const necesarios = cantidadConDesperdicio / producto.cobertura;
  const paquetes = Math.ceil(necesarios - 1e-9); // tolerancia de redondeo
  const subtotal = round2(paquetes * producto.precio);
  return {
    rubro,
    productoId: producto.id,
    producto: producto.nombre,
    categoria: producto.categoria || '',
    imagen: producto.imagen || null,
    unidadObra,
    cantidadObra: round2(cantidadObra),
    desperdicioPct: pct,
    cantidadConDesperdicio: round2(cantidadConDesperdicio),
    rendimiento: producto.cobertura,
    envase: producto.envase,
    paquetesNecesarios: paquetes,
    precioUnitario: producto.precio,
    subtotal
  };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// productos: { piso, zocalo, puerta, nivelacion, manta, pegamento } -> cada uno (si aplica)
// obra: { m2Pisos, mlZocalos, cantidadPuertas, requiereNivelacion, utilizaManta, manoObra, desperdicioPctPiso }
// tarifas: { pisos_m2, zocalos_ml, puertas_unidad, nivelacion_m2, minimoM2Cotizable }
// formasPago: [{ nombre, tipo: 'descuento'|'recargo', porcentaje }]
function calcularCotizacion({ obra, productos, tarifas, formasPago }) {
  const items = [];
  const faltantes = [];
  let totalProductos = 0;
  let totalManoObra = 0;
  const t = Object.assign({}, TARIFA_DEFAULT, tarifas || {});

  const m2Pisos = Number(obra.m2Pisos) || 0;
  const mlZocalos = Number(obra.mlZocalos) || 0;
  const cantidadPuertas = Number(obra.cantidadPuertas) || 0;
  const requiereNivelacion = !!obra.requiereNivelacion;
  const utilizaManta = !!obra.utilizaManta;
  const manoObra = !!obra.manoObra;
  const desperdicioPctPiso = Number(obra.desperdicioPctPiso) || 0;

  // La mano de obra ligada a m2 (piso y nivelación) se cobra como mínimo
  // sobre minimoM2Cotizable, aunque la obra real tenga menos metros.
  const minimoM2 = Number(t.minimoM2Cotizable) || 0;
  const m2CotizableManoObra = m2Pisos > 0 ? Math.max(m2Pisos, minimoM2) : 0;

  if (m2Pisos > 0) {
    if (!productos.piso) faltantes.push('piso');
    else {
      const it = calcularItem({
        rubro: 'Piso', unidadObra: 'm2', cantidadObra: m2Pisos,
        producto: productos.piso, desperdicioPct: desperdicioPctPiso
      });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(m2CotizableManoObra * t.pisos_m2);
    }
  }

  if (mlZocalos > 0) {
    if (!productos.zocalo) faltantes.push('zocalo');
    else {
      const it = calcularItem({ rubro: 'Zócalo', unidadObra: 'ml', cantidadObra: mlZocalos, producto: productos.zocalo });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(mlZocalos * t.zocalos_ml);
    }

    // Silicona/pegamento para pegar el zócalo: catálogo por SKU propio del
    // tipo de obra (como niveladores de puerta), sin check aparte porque se
    // necesita siempre que se cotiza zócalo. Sin tarifa propia de mano de
    // obra: su colocación va incluida en la tarifa de zócalo (zocalos_ml).
    if (!productos.pegamento) faltantes.push('pegamento');
    else {
      const it = calcularItem({ rubro: 'Silicona/pegamento', unidadObra: 'ml', cantidadObra: mlZocalos, producto: productos.pegamento });
      items.push(it);
      totalProductos += it.subtotal;
    }
  }

  if (cantidadPuertas > 0) {
    if (!productos.puerta) faltantes.push('puerta');
    else {
      const it = calcularItem({ rubro: 'Nivelador de puerta', unidadObra: 'unidad', cantidadObra: cantidadPuertas, producto: productos.puerta });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(cantidadPuertas * t.puertas_unidad);
    }
  }

  if (requiereNivelacion) {
    if (!productos.nivelacion) faltantes.push('nivelacion');
    else if (m2Pisos > 0) {
      const it = calcularItem({ rubro: 'Nivelación de piso', unidadObra: 'm2', cantidadObra: m2Pisos, producto: productos.nivelacion });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(m2CotizableManoObra * t.nivelacion_m2);
    }
  }

  if (utilizaManta) {
    if (!productos.manta) faltantes.push('manta');
    else if (m2Pisos > 0) {
      const it = calcularItem({ rubro: 'Manta', unidadObra: 'm2', cantidadObra: m2Pisos, producto: productos.manta });
      items.push(it);
      totalProductos += it.subtotal;
      // Sin tarifa propia: la mano de obra de colocar la manta va incluida
      // en la tarifa de piso (pisos_m2).
    }
  }

  totalProductos = round2(totalProductos);
  totalManoObra = round2(totalManoObra);
  const total = round2(totalProductos + totalManoObra);

  const formasPagoCalculadas = (formasPago || []).map((fp) => {
    const pct = Number(fp.porcentaje) || 0;
    const factor = fp.tipo === 'recargo' ? (1 + pct / 100) : (1 - pct / 100);
    return {
      nombre: fp.nombre,
      tipo: fp.tipo,
      porcentaje: pct,
      total: round2(total * factor)
    };
  });

  return { items, faltantes, totalProductos, totalManoObra, total, formasPago: formasPagoCalculadas };
}

// ---------- Helper: resuelve un item de catálogo por SKU (puerta/nivelacion/manta/pegamento) ----------

async function resolverItemCatalogo(store, tipoObraId, categoria, itemId) {
  const col = await getTipoObraItemsCollection();
  let item = null;
  try {
    item = await col.findOne({
      _id: new ObjectId(itemId),
      store_id: store.store_id,
      tipoObraId: String(tipoObraId),
      categoria
    });
  } catch (e) { item = null; }
  if (!item) return null;

  const info = await productoPorSku(store, item.sku);
  if (!info || info.precio === null) return null;

  return {
    id: item._id,
    nombre: info.nombre,
    categoria: ETIQUETA_CATEGORIA[categoria] || categoria,
    imagen: info.imagen || null,
    tipo: 'unidad',
    cobertura: Number(item.cobertura) || 1,
    envase: 'unidad',
    precio: info.precio
  };
}

// ---------- Helper: arma el detalle de "productos" para calcularCotizacion
// a partir de los ids elegidos en el front ----------

async function resolverProductosElegidos(store, seleccion, tipoObraId) {
  seleccion = seleccion || {};
  const resultado = {};

  const necesitaCatalogo = ['piso', 'zocalo'].some((k) => seleccion[k]);
  if (necesitaCatalogo) {
    const catalogo = await productosConfigurados(store);
    ['piso', 'zocalo'].forEach((clave) => {
      const id = seleccion[clave];
      if (!id) return;
      const prod = catalogo.find((p) => p.id === parseInt(id, 10) || p.id === id);
      if (prod) resultado[clave] = prod;
    });
  }

  for (const categoria of CATEGORIAS_ITEM) {
    if (seleccion[categoria]) {
      const prod = await resolverItemCatalogo(store, tipoObraId, categoria, seleccion[categoria]);
      if (prod) resultado[categoria] = prod;
    }
  }

  return resultado;
}

// =====================================================================
// Rutas: catálogo / rubros
// =====================================================================

// Catalogo completo de productos ya configurados (con rendimiento y precio).
router.get('/productos', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const productos = await productosConfigurados(store);
    res.json(productos);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Rubros (categorías reales de Tiendanube) agrupados por tipo de unidad,
// para usar como ayuda al configurar un tipo de obra (piso y zócalo).
router.get('/rubros-disponibles', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const productos = await productosConfigurados(store);
    const grupos = { m2: new Set(), ml: new Set(), unidad: new Set(), litro: new Set() };
    productos.forEach((p) => {
      if (p.categoria && grupos[p.tipo]) grupos[p.tipo].add(p.categoria);
    });
    const ordenar = (set) => Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
    res.json({ m2: ordenar(grupos.m2), ml: ordenar(grupos.ml), unidad: ordenar(grupos.unidad), litro: ordenar(grupos.litro) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// Rutas: tipos de obra
// =====================================================================

function normalizarTipoObra(doc) {
  return {
    id: doc._id,
    nombre: doc.nombre,
    rubroPiso: doc.rubroPiso || '',
    rubroZocalo: doc.rubroZocalo || '',
    desperdicioDefaultPct: doc.desperdicioDefaultPct || 0
  };
}

router.get('/tipos-obra', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getTiposObraCollection();
    const items = await col.find({ store_id: store.store_id }).sort({ nombre: 1 }).toArray();
    res.json(items.map(normalizarTipoObra));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tipos-obra', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { id, nombre, rubroPiso, rubroZocalo, desperdicioDefaultPct } = req.body || {};
    if (!nombre || !rubroPiso) {
      return res.status(400).json({ error: 'Falta el nombre o el rubro de piso.' });
    }
    const datos = {
      store_id: store.store_id,
      nombre: String(nombre).trim(),
      rubroPiso: String(rubroPiso).trim(),
      rubroZocalo: rubroZocalo ? String(rubroZocalo).trim() : '',
      desperdicioDefaultPct: Number(desperdicioDefaultPct) || 0
    };
    const col = await getTiposObraCollection();
    if (id) {
      await col.updateOne({ _id: new ObjectId(id), store_id: store.store_id }, { $set: datos });
      res.json(Object.assign({ id }, datos));
    } else {
      const { insertedId } = await col.insertOne(datos);
      res.json(Object.assign({ id: insertedId }, datos));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/tipos-obra/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getTiposObraCollection();
    await col.deleteOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
    // Se borran en cascada los catálogos por SKU y la tarifa de mano de obra
    // propios de este tipo de obra.
    const itemsCol = await getTipoObraItemsCollection();
    await itemsCol.deleteMany({ store_id: store.store_id, tipoObraId: String(req.params.id) });
    const tarifasCol = await getTarifasCollection();
    await tarifasCol.deleteMany({ store_id: store.store_id, tipoObraId: String(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// Rutas: catálogos por SKU de un tipo de obra puntual
// (categoria: 'puerta' | 'nivelacion' | 'manta' | 'pegamento')
// =====================================================================

router.get('/tipos-obra/:tipoObraId/items', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const categoria = req.query.categoria;
    if (CATEGORIAS_ITEM.indexOf(categoria) === -1) {
      return res.status(400).json({ error: 'Categoria invalida.' });
    }
    const col = await getTipoObraItemsCollection();
    const items = await col.find({
      store_id: store.store_id,
      tipoObraId: String(req.params.tipoObraId),
      categoria
    }).toArray();

    const resultado = [];
    for (const it of items) {
      const info = await productoPorSku(store, it.sku);
      resultado.push({
        id: it._id,
        sku: it.sku,
        cobertura: Number(it.cobertura) || 1,
        nombre: info ? info.nombre : ('SKU ' + it.sku + ' (no encontrado en Tiendanube)'),
        precio: info ? info.precio : null,
        imagen: info ? info.imagen : null
      });
    }
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tipos-obra/:tipoObraId/items', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { categoria, sku, cobertura } = req.body || {};
    if (CATEGORIAS_ITEM.indexOf(categoria) === -1) {
      return res.status(400).json({ error: 'Categoria invalida.' });
    }
    if (!sku) return res.status(400).json({ error: 'Falta el SKU.' });

    const info = await productoPorSku(store, sku);
    if (!info) return res.status(404).json({ error: 'No se encontro ningun producto con ese SKU en Tiendanube.' });

    const datos = {
      store_id: store.store_id,
      tipoObraId: String(req.params.tipoObraId),
      categoria,
      sku: String(sku).trim(),
      cobertura: Number(cobertura) || 1
    };
    const col = await getTipoObraItemsCollection();
    const { insertedId } = await col.insertOne(datos);
    res.json(Object.assign({ id: insertedId }, datos, info));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/tipos-obra/:tipoObraId/items/:itemId', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getTipoObraItemsCollection();
    await col.deleteOne({
      _id: new ObjectId(req.params.itemId),
      store_id: store.store_id,
      tipoObraId: String(req.params.tipoObraId)
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// Rutas: formas de pago
// =====================================================================

router.get('/formas-pago', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getFormasPagoCollection();
    const items = await col.find({ store_id: store.store_id }).toArray();
    res.json(items.map((d) => ({ id: d._id, nombre: d.nombre, tipo: d.tipo, porcentaje: d.porcentaje })));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/formas-pago', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { id, nombre, tipo, porcentaje } = req.body || {};
    if (!nombre || !tipo) return res.status(400).json({ error: 'Falta el nombre o el tipo.' });
    if (['descuento', 'recargo'].indexOf(tipo) === -1) return res.status(400).json({ error: 'Tipo invalido.' });

    const datos = { store_id: store.store_id, nombre: String(nombre).trim(), tipo, porcentaje: Number(porcentaje) || 0 };
    const col = await getFormasPagoCollection();
    if (id) {
      await col.updateOne({ _id: new ObjectId(id), store_id: store.store_id }, { $set: datos });
      res.json(Object.assign({ id }, datos));
    } else {
      const { insertedId } = await col.insertOne(datos);
      res.json(Object.assign({ id: insertedId }, datos));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/formas-pago/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getFormasPagoCollection();
    await col.deleteOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// Rutas: tarifas de mano de obra (propias de cada tipo de obra)
// =====================================================================

router.get('/tipos-obra/:tipoObraId/tarifas', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const tarifas = await getTarifas(store.store_id, req.params.tipoObraId);
    res.json(tarifas);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tipos-obra/:tipoObraId/tarifas', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const tarifas = await setTarifas(store.store_id, req.params.tipoObraId, req.body || {});
    res.json(tarifas);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// Rutas: calcular / guardar / historial / pdf
// =====================================================================

router.post('/calcular', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { obra, productos, tipoObraId } = req.body || {};
    if (!obra) return res.status(400).json({ error: 'Falta obra.' });
    if (!tipoObraId) return res.status(400).json({ error: 'Falta tipoObraId.' });

    const [productosElegidos, tarifas, formasPago] = await Promise.all([
      resolverProductosElegidos(store, productos, tipoObraId),
      getTarifas(store.store_id, tipoObraId),
      (await getFormasPagoCollection()).find({ store_id: store.store_id }).toArray()
    ]);

    const resultado = calcularCotizacion({ obra, productos: productosElegidos, tarifas, formasPago });
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Guardar recibe los items ya resueltos desde el resumen (paso 4), que Mato
// puede haber ajustado a mano (cantidades editadas y/o items manuales de
// "Otros") antes de guardar. No vuelve a resolver por SKU/rubro: solo
// recalcula subtotales y totales a partir de lo que llega, para que la
// cotización guardada sea siempre consistente con lo que se ve en pantalla.
function finalizarItems(items) {
  return (items || []).map((it) => {
    const cantidad = Number(it.paquetesNecesarios) || 0;
    const precioUnitario = Number(it.precioUnitario) || 0;
    return {
      rubro: String(it.rubro || 'Item').trim() || 'Item',
      productoId: it.productoId != null ? it.productoId : null,
      producto: String(it.producto || '').trim(),
      categoria: it.categoria || '',
      imagen: it.imagen || null,
      unidadObra: it.unidadObra || '',
      cantidadObra: it.cantidadObra != null ? Number(it.cantidadObra) || 0 : cantidad,
      desperdicioPct: Number(it.desperdicioPct) || 0,
      cantidadConDesperdicio: it.cantidadConDesperdicio != null ? Number(it.cantidadConDesperdicio) || 0 : cantidad,
      rendimiento: it.rendimiento != null ? Number(it.rendimiento) : null,
      envase: it.envase || 'unidad',
      paquetesNecesarios: cantidad,
      precioUnitario,
      subtotal: round2(cantidad * precioUnitario),
      manual: !!it.manual
    };
  });
}

router.post('/guardar', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { obra, tipoObraId, cliente, direccion, tipoObraNombre, items, totalManoObra, formasPago } = req.body || {};
    if (!obra) return res.status(400).json({ error: 'Falta obra.' });
    if (!tipoObraId) return res.status(400).json({ error: 'Falta tipoObraId.' });
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'No hay items para guardar.' });
    }

    const itemsFinales = finalizarItems(items);
    const totalProductos = round2(itemsFinales.reduce((s, it) => s + it.subtotal, 0));
    const totalManoObraFinal = round2(Number(totalManoObra) || 0);
    const total = round2(totalProductos + totalManoObraFinal);
    const formasPagoFinales = (formasPago || []).map((fp) => {
      const pct = Number(fp.porcentaje) || 0;
      const factor = fp.tipo === 'recargo' ? (1 + pct / 100) : (1 - pct / 100);
      return { nombre: fp.nombre, tipo: fp.tipo, porcentaje: pct, total: round2(total * factor) };
    });

    const doc = {
      store_id: store.store_id,
      fecha: new Date(),
      cliente: cliente || '',
      direccion: direccion || '',
      tipoObraId: String(tipoObraId),
      tipoObraNombre: tipoObraNombre || '',
      obra,
      items: itemsFinales,
      totalProductos,
      totalManoObra: totalManoObraFinal,
      total,
      formasPago: formasPagoFinales
    };

    const col = await getCotizacionesCollection();
    const { insertedId } = await col.insertOne(doc);
    res.json(Object.assign({ _id: insertedId }, doc));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/historial', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getCotizacionesCollection();
    const lista = await col
      .find({ store_id: store.store_id })
      .project({ cliente: 1, direccion: 1, fecha: 1, total: 1, tipoObraNombre: 1 })
      .sort({ fecha: -1 })
      .limit(200)
      .toArray();
    res.json(lista);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/historial/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getCotizacionesCollection();
    const doc = await col.findOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
    if (!doc) return res.status(404).json({ error: 'No encontrada.' });
    res.json(doc);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Trae la imagen del producto como Buffer para insertarla en el PDF. Si
// falla (sin imagen, red, formato no soportado por pdfkit) devuelve null y
// la fila se dibuja igual, con un recuadro vacío en vez de la foto.
async function descargarImagenPdf(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length ? buf : null;
  } catch (e) {
    return null;
  }
}

// Layout de la tabla de items: foto + producto (nombre simple, sin la
// categoría cruda de Tiendanube) + cantidad (con la nota de m²/ml y
// desperdicio en chico, aparte) + precio unit. + subtotal.
const PDF_IMG_X = 50, PDF_IMG_W = 34;
const PDF_COL_PRODUCTO_X = 92, PDF_COL_PRODUCTO_W = 150;
const PDF_COL_CANT_X = 250, PDF_COL_CANT_W = 100;
const PDF_COL_PRECIO_X = 358, PDF_COL_PRECIO_W = 80;
const PDF_COL_SUBTOTAL_X = 446, PDF_COL_SUBTOTAL_W = 110;
const PDF_TABLE_RIGHT = 556;

// Encabezado con marca Piedra Negra: usa el logo del archivo si está
// disponible, y si no dibuja el wordmark en texto como respaldo (para que
// el PDF nunca se rompa si falta el archivo del logo).
function dibujarMarca(pdf) {
  const y0 = pdf.y;
  let dibujoLogo = false;
  try {
    pdf.image(LOGO_PNG_PATH, 50, y0, { height: 30 });
    pdf.y = y0 + 34;
    dibujoLogo = true;
  } catch (e) { dibujoLogo = false; }
  if (!dibujoLogo) {
    pdf.fontSize(15).fillColor('#000').font('Helvetica-Bold').text('PIEDRA NEGRA', 50, y0, { characterSpacing: 1.2 });
    pdf.font('Helvetica');
    pdf.y = y0 + 20;
  }
  pdf.moveDown(0.3);
  pdf.moveTo(50, pdf.y).lineTo(PDF_TABLE_RIGHT, pdf.y).strokeColor('#1f2937').lineWidth(1.4).stroke();
  pdf.strokeColor('#ddd').lineWidth(1);
  pdf.moveDown(0.6);
  pdf.fillColor('#000');
}

// Galería de fotos para la vista "llave en mano" del PDF: una grilla de
// fotos de producto sin cantidades ni precios (eso es justamente lo que la
// vista simple oculta), para que quede prolijo y presentable para el
// cliente. Se anima con la misma imagen que usa la tabla de desglose.
const PDF_GALERIA_COLS = 4;
const PDF_GALERIA_GAP = 14;
const PDF_GALERIA_NOMBRE_ALTO = 22;

async function dibujarGaleriaLlaveEnMano(pdf, items) {
  if (!items || !items.length) return;
  const totalWidth = PDF_TABLE_RIGHT - 50;
  const cellW = (totalWidth - PDF_GALERIA_GAP * (PDF_GALERIA_COLS - 1)) / PDF_GALERIA_COLS;
  const filaAlto = cellW + 6 + PDF_GALERIA_NOMBRE_ALTO;
  const pageBottom = pdf.page.height - pdf.page.margins.bottom;

  for (let i = 0; i < items.length; i++) {
    const col = i % PDF_GALERIA_COLS;
    if (col === 0 && pdf.y + filaAlto > pageBottom) {
      pdf.addPage();
    }
    const it = items[i];
    const x = 50 + col * (cellW + PDF_GALERIA_GAP);
    const y = pdf.y;
    const imgBuffer = await descargarImagenPdf(it.imagen);
    if (imgBuffer) {
      try { pdf.image(imgBuffer, x, y, { width: cellW, height: cellW }); } catch (e) {
        pdf.rect(x, y, cellW, cellW).strokeColor('#e2e0db').stroke();
      }
    } else {
      pdf.rect(x, y, cellW, cellW).strokeColor('#e2e0db').stroke();
    }
    pdf.fillColor('#000').fontSize(8).text(it.producto || '', x, y + cellW + 6, { width: cellW, align: 'center' });
    pdf.fillColor('#000');

    if (col === PDF_GALERIA_COLS - 1 || i === items.length - 1) {
      pdf.y = y + filaAlto + 8;
    }
  }
  pdf.moveDown(0.4);
}

function dibujarEncabezadoTabla(pdf) {
  const y0 = pdf.y;
  pdf.fontSize(9).fillColor('#555');
  pdf.text('Producto', PDF_COL_PRODUCTO_X, y0, { width: PDF_COL_PRODUCTO_W });
  pdf.text('Cantidad', PDF_COL_CANT_X, y0, { width: PDF_COL_CANT_W });
  pdf.text('Precio unit.', PDF_COL_PRECIO_X, y0, { width: PDF_COL_PRECIO_W });
  pdf.text('Subtotal', PDF_COL_SUBTOTAL_X, y0, { width: PDF_COL_SUBTOTAL_W });
  pdf.fillColor('#000');
  pdf.y = y0 + 14;
  pdf.moveDown(0.4);
  pdf.moveTo(50, pdf.y).lineTo(PDF_TABLE_RIGHT, pdf.y).strokeColor('#ddd').stroke();
  pdf.moveDown(0.3);
}

router.get('/pdf/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getCotizacionesCollection();
    const doc = await col.findOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
    if (!doc) return res.status(404).json({ error: 'No encontrada.' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="cotizacion-' + req.params.id + '.pdf"');

    const vistaSimple = req.query.vista === 'simple';

    const pdf = new PDFDocument({ margin: 50 });
    pdf.pipe(res);

    dibujarMarca(pdf);

    pdf.fontSize(16).text(vistaSimple ? 'Presupuesto de obra — Llave en mano' : 'Presupuesto de obra', { align: 'left' });
    pdf.moveDown(0.3);
    pdf.fontSize(10).fillColor('#555')
      .text('Fecha: ' + new Date(doc.fecha).toLocaleDateString('es-AR') + (doc.tipoObraNombre ? '  ·  Tipo de obra: ' + doc.tipoObraNombre : ''));
    pdf.fillColor('#000');
    pdf.moveDown(0.8);

    if (doc.cliente) pdf.fontSize(11).text('Cliente: ' + doc.cliente);
    if (doc.direccion) pdf.fontSize(11).text('Dirección: ' + doc.direccion);
    pdf.moveDown(0.6);

    const o = doc.obra || {};
    const datosObraTxt = descripcionObra(o);
    if (datosObraTxt) pdf.fontSize(10).fillColor('#555').text(datosObraTxt);
    pdf.fillColor('#000');
    pdf.moveDown(1);

    if (vistaSimple) {
      pdf.fontSize(10).fillColor('#555').text(
        'Provisión de materiales y mano de obra necesarios para la ejecución de la obra detallada, llave en mano.',
        { width: PDF_TABLE_RIGHT - 50 }
      );
      pdf.fillColor('#000');
      pdf.moveDown(1);
      await dibujarGaleriaLlaveEnMano(pdf, doc.items);
      pdf.moveDown(0.8);
      pdf.fontSize(16).text('Total: $ ' + doc.total.toFixed(2), { align: 'right' });
    } else {
      dibujarEncabezadoTabla(pdf);

      const pageBottom = pdf.page.height - pdf.page.margins.bottom;

      for (const it of (doc.items || [])) {
        const imgBuffer = await descargarImagenPdf(it.imagen);

        let notaCantidad = '';
        if (it.unidadObra) {
          notaCantidad = it.cantidadObra + ' ' + it.unidadObra + (it.desperdicioPct ? ' (+' + it.desperdicioPct + '% desp.)' : '');
        }
        const envaseTxt = (it.envase || 'unidad') + (Number(it.paquetesNecesarios) === 1 ? '' : '(s)');
        const cantTexto = it.paquetesNecesarios + ' ' + envaseTxt;

        // Medir antes de dibujar, para saber cuánto ocupa la fila y si hace
        // falta pasar de página.
        pdf.fontSize(8.5);
        const hRubro = pdf.heightOfString(it.rubro || '', { width: PDF_COL_PRODUCTO_W });
        pdf.fontSize(10);
        const hNombre = pdf.heightOfString(it.producto || '', { width: PDF_COL_PRODUCTO_W });
        const hProductoCol = hRubro + hNombre + 2;

        pdf.fontSize(10);
        const hCant = pdf.heightOfString(cantTexto, { width: PDF_COL_CANT_W });
        pdf.fontSize(8);
        const hNota = notaCantidad ? pdf.heightOfString(notaCantidad, { width: PDF_COL_CANT_W }) : 0;
        const hCantCol = hCant + (hNota ? hNota + 2 : 0);

        const filaAlto = Math.max(PDF_IMG_W, hProductoCol, hCantCol, 14);

        if (pdf.y + filaAlto > pageBottom) {
          pdf.addPage();
          dibujarEncabezadoTabla(pdf);
        }

        const y0 = pdf.y;

        if (imgBuffer) {
          try { pdf.image(imgBuffer, PDF_IMG_X, y0, { width: PDF_IMG_W, height: PDF_IMG_W }); } catch (e) { /* formato no soportado, seguimos sin foto */ }
        } else {
          pdf.rect(PDF_IMG_X, y0, PDF_IMG_W, PDF_IMG_W).strokeColor('#e2e0db').stroke();
        }

        pdf.fillColor('#888').fontSize(8.5).text(it.rubro || '', PDF_COL_PRODUCTO_X, y0, { width: PDF_COL_PRODUCTO_W });
        pdf.fillColor('#000').fontSize(10).text(it.producto || '', PDF_COL_PRODUCTO_X, y0 + hRubro + 2, { width: PDF_COL_PRODUCTO_W });

        pdf.fillColor('#000').fontSize(10).text(cantTexto, PDF_COL_CANT_X, y0, { width: PDF_COL_CANT_W });
        if (notaCantidad) {
          pdf.fillColor('#888').fontSize(8).text(notaCantidad, PDF_COL_CANT_X, y0 + hCant + 2, { width: PDF_COL_CANT_W });
        }
        pdf.fillColor('#000');

        pdf.fontSize(10).text('$ ' + Number(it.precioUnitario).toFixed(2), PDF_COL_PRECIO_X, y0, { width: PDF_COL_PRECIO_W });
        pdf.fontSize(10).text('$ ' + Number(it.subtotal).toFixed(2), PDF_COL_SUBTOTAL_X, y0, { width: PDF_COL_SUBTOTAL_W });

        pdf.y = y0 + filaAlto + 10;
      }

      pdf.moveDown(0.4);
      pdf.moveTo(50, pdf.y).lineTo(PDF_TABLE_RIGHT, pdf.y).strokeColor('#ddd').stroke();
      pdf.moveDown(0.5);

      pdf.fontSize(10);
      pdf.text('Subtotal productos: $ ' + doc.totalProductos.toFixed(2), { align: 'right' });
      if (doc.totalManoObra) pdf.text('Mano de obra: $ ' + doc.totalManoObra.toFixed(2), { align: 'right' });
      pdf.fontSize(13).text('Total: $ ' + doc.total.toFixed(2), { align: 'right' });
    }

    if (doc.formasPago && doc.formasPago.length) {
      pdf.moveDown(0.8);
      pdf.fontSize(10).fillColor('#555').text('Formas de pago', { align: 'right' });
      pdf.fillColor('#000');
      doc.formasPago.forEach((fp) => {
        const signo = fp.tipo === 'recargo' ? '+' : '-';
        pdf.fontSize(10).text(
          fp.nombre + (fp.porcentaje ? ' (' + signo + fp.porcentaje + '%)' : '') + ': $ ' + fp.total.toFixed(2),
          { align: 'right' }
        );
      });
    }

    pdf.end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.calcularCotizacion = calcularCotizacion; // exportado para tests
