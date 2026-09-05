// ---------------------------------------------------------------------------
// Cotizador de obra — módulo adicional para la app "Calculadora m2".
//
// Se monta como router Express dentro del server.js existente. Lee la MISMA
// base Mongo Atlas (db "calculadora_m2") y las mismas colecciones "stores" y
// "rendimientos" que ya usa la app (no las toca, solo lee), y agrega
// colecciones nuevas propias de este módulo:
//   - tipos_obra         : tipos de obra configurados (Piso flotante, Deck...)
//                          con el rubro real de Tiendanube para cada material
//   - niveladores_puerta : niveladores de puerta precargados por SKU (no
//                          tienen rubro propio en Tiendanube)
//   - formas_pago        : formas de pago con % de descuento o recargo
//   - tarifas_mano_obra  : tarifa configurable por tienda (store_id)
//   - cotizaciones       : historial de presupuestos armados
//
// Integración (ver INTEGRACION.md): en server.js
//   const cotizadorRouter = require('./cotizador');
//   app.use('/api/cotizador', cotizadorRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const PDFDocument = require('pdfkit');

const router = express.Router();

const API_BASE = 'https://api.tiendanube.com/v1';

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
async function getNiveladoresPuertaCollection() { return (await getDb()).collection('niveladores_puerta'); }
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
  nivelacion_m2: 0
};

async function getTarifas(storeId) {
  return conReintento(async () => {
    const col = await getTarifasCollection();
    const doc = await col.findOne({ _id: storeId });
    return Object.assign({}, TARIFA_DEFAULT, doc || {});
  });
}

async function setTarifas(storeId, tarifas) {
  const datos = {
    pisos_m2: Number(tarifas.pisos_m2) || 0,
    zocalos_ml: Number(tarifas.zocalos_ml) || 0,
    puertas_unidad: Number(tarifas.puertas_unidad) || 0,
    nivelacion_m2: Number(tarifas.nivelacion_m2) || 0
  };
  await conReintento(async () => {
    const col = await getTarifasCollection();
    await col.updateOne({ _id: storeId }, { $set: datos }, { upsert: true });
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

// Busca UN producto puntual por SKU exacto en Tiendanube (para los
// niveladores de puerta, que no tienen rubro propio). No usa cache: el
// precio que trae siempre es el vigente.
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

// productos: { piso, zocalo, puerta, nivelacion } -> cada uno (si aplica)
// obra: { m2Pisos, mlZocalos, cantidadPuertas, requiereNivelacion, manoObra, desperdicioPctPiso }
// tarifas: { pisos_m2, zocalos_ml, puertas_unidad, nivelacion_m2 }
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
  const manoObra = !!obra.manoObra;
  const desperdicioPctPiso = Number(obra.desperdicioPctPiso) || 0;

  if (m2Pisos > 0) {
    if (!productos.piso) faltantes.push('piso');
    else {
      const it = calcularItem({
        rubro: 'Piso', unidadObra: 'm2', cantidadObra: m2Pisos,
        producto: productos.piso, desperdicioPct: desperdicioPctPiso
      });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(m2Pisos * t.pisos_m2);
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
      if (manoObra) totalManoObra += round2(m2Pisos * t.nivelacion_m2);
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

// ---------- Helper: arma el detalle de "productos" para calcularCotizacion
// a partir de los ids elegidos en el front ----------

async function resolverProductosElegidos(store, seleccion) {
  seleccion = seleccion || {};
  const resultado = {};

  const necesitaCatalogo = ['piso', 'zocalo', 'nivelacion'].some((k) => seleccion[k]);
  if (necesitaCatalogo) {
    const catalogo = await productosConfigurados(store);
    ['piso', 'zocalo', 'nivelacion'].forEach((clave) => {
      const id = seleccion[clave];
      if (!id) return;
      const prod = catalogo.find((p) => p.id === parseInt(id, 10) || p.id === id);
      if (prod) resultado[clave] = prod;
    });
  }

  if (seleccion.puerta) {
    const col = await getNiveladoresPuertaCollection();
    let item = null;
    try {
      item = await col.findOne({ _id: new ObjectId(seleccion.puerta), store_id: store.store_id });
    } catch (e) { item = null; }
    if (item) {
      const info = await productoPorSku(store, item.sku);
      if (info && info.precio !== null) {
        resultado.puerta = {
          id: item._id,
          nombre: info.nombre,
          categoria: 'Niveladores de puerta',
          tipo: 'unidad',
          cobertura: Number(item.cobertura) || 1,
          envase: 'unidad',
          precio: info.precio
        };
      }
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
// para usar como ayuda al configurar un tipo de obra.
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
    rubroNivelacion: doc.rubroNivelacion || '',
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
    const { id, nombre, rubroPiso, rubroZocalo, rubroNivelacion, desperdicioDefaultPct } = req.body || {};
    if (!nombre || !rubroPiso) {
      return res.status(400).json({ error: 'Falta el nombre o el rubro de piso.' });
    }
    const datos = {
      store_id: store.store_id,
      nombre: String(nombre).trim(),
      rubroPiso: String(rubroPiso).trim(),
      rubroZocalo: rubroZocalo ? String(rubroZocalo).trim() : '',
      rubroNivelacion: rubroNivelacion ? String(rubroNivelacion).trim() : '',
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
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =====================================================================
// Rutas: niveladores de puerta (precargados por SKU, sin rubro propio)
// =====================================================================

router.get('/niveladores-puerta', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getNiveladoresPuertaCollection();
    const items = await col.find({ store_id: store.store_id }).toArray();
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

router.post('/niveladores-puerta', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { sku, cobertura } = req.body || {};
    if (!sku) return res.status(400).json({ error: 'Falta el SKU.' });

    const info = await productoPorSku(store, sku);
    if (!info) return res.status(404).json({ error: 'No se encontro ningun producto con ese SKU en Tiendanube.' });

    const datos = { store_id: store.store_id, sku: String(sku).trim(), cobertura: Number(cobertura) || 1 };
    const col = await getNiveladoresPuertaCollection();
    const { insertedId } = await col.insertOne(datos);
    res.json(Object.assign({ id: insertedId }, datos, info));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/niveladores-puerta/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getNiveladoresPuertaCollection();
    await col.deleteOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
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
// Rutas: tarifas de mano de obra
// =====================================================================

router.get('/tarifas', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const tarifas = await getTarifas(store.store_id);
    res.json(tarifas);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/tarifas', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const tarifas = await setTarifas(store.store_id, req.body || {});
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
    const { obra, productos } = req.body || {};
    if (!obra) return res.status(400).json({ error: 'Falta obra.' });

    const [productosElegidos, tarifas, formasPago] = await Promise.all([
      resolverProductosElegidos(store, productos),
      getTarifas(store.store_id),
      (await getFormasPagoCollection()).find({ store_id: store.store_id }).toArray()
    ]);

    const resultado = calcularCotizacion({ obra, productos: productosElegidos, tarifas, formasPago });
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/guardar', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { obra, productos, cliente, direccion, tipoObraNombre } = req.body || {};
    if (!obra) return res.status(400).json({ error: 'Falta obra.' });

    const [productosElegidos, tarifas, formasPago] = await Promise.all([
      resolverProductosElegidos(store, productos),
      getTarifas(store.store_id),
      (await getFormasPagoCollection()).find({ store_id: store.store_id }).toArray()
    ]);

    const resultado = calcularCotizacion({ obra, productos: productosElegidos, tarifas, formasPago });
    if (resultado.faltantes.length > 0) {
      return res.status(400).json({ error: 'Falta elegir producto para: ' + resultado.faltantes.join(', ') });
    }

    const doc = {
      store_id: store.store_id,
      fecha: new Date(),
      cliente: cliente || '',
      direccion: direccion || '',
      tipoObraNombre: tipoObraNombre || '',
      obra,
      items: resultado.items,
      totalProductos: resultado.totalProductos,
      totalManoObra: resultado.totalManoObra,
      total: resultado.total,
      formasPago: resultado.formasPago
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

router.get('/pdf/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getCotizacionesCollection();
    const doc = await col.findOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
    if (!doc) return res.status(404).json({ error: 'No encontrada.' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="cotizacion-' + req.params.id + '.pdf"');

    const pdf = new PDFDocument({ margin: 50 });
    pdf.pipe(res);

    pdf.fontSize(18).text('Presupuesto de obra', { align: 'left' });
    pdf.moveDown(0.3);
    pdf.fontSize(10).fillColor('#555')
      .text('Fecha: ' + new Date(doc.fecha).toLocaleDateString('es-AR') + (doc.tipoObraNombre ? '  ·  Tipo de obra: ' + doc.tipoObraNombre : ''));
    pdf.fillColor('#000');
    pdf.moveDown(0.8);

    if (doc.cliente) pdf.fontSize(11).text('Cliente: ' + doc.cliente);
    if (doc.direccion) pdf.fontSize(11).text('Dirección: ' + doc.direccion);
    pdf.moveDown(0.6);

    const o = doc.obra || {};
    const datosObra = [];
    if (o.m2Pisos) datosObra.push(o.m2Pisos + ' m2 de piso');
    if (o.mlZocalos) datosObra.push(o.mlZocalos + ' ml de zócalo');
    if (o.cantidadPuertas) datosObra.push(o.cantidadPuertas + ' puerta(s)');
    if (o.requiereNivelacion) datosObra.push('con nivelación');
    if (o.manoObra) datosObra.push('con mano de obra');
    if (datosObra.length) pdf.fontSize(10).fillColor('#555').text(datosObra.join(' · '));
    pdf.fillColor('#000');
    pdf.moveDown(1);

    // Tabla de items
    const colX = [50, 200, 320, 390, 460];
    pdf.fontSize(9).fillColor('#555');
    pdf.text('Rubro / Producto', colX[0], pdf.y, { width: 145 });
    pdf.text('Cant. obra', colX[1], pdf.y - pdf.currentLineHeight(), { width: 110 });
    pdf.moveUp();
    pdf.text('Rendim.', colX[2], pdf.y, { width: 65 });
    pdf.text('Necesita', colX[3], pdf.y, { width: 65 });
    pdf.text('Subtotal', colX[4], pdf.y, { width: 90 });
    pdf.fillColor('#000');
    pdf.moveDown(0.4);
    pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#ddd').stroke();
    pdf.moveDown(0.3);

    (doc.items || []).forEach((it) => {
      const y0 = pdf.y;
      pdf.fontSize(9);
      const nombreConDesperdicio = it.desperdicioPct
        ? it.rubro + ' — ' + it.producto + ' (+' + it.desperdicioPct + '% desp.)'
        : it.rubro + ' — ' + it.producto;
      pdf.text(nombreConDesperdicio, colX[0], y0, { width: 145 });
      pdf.text(it.cantidadObra + ' ' + it.unidadObra, colX[1], y0, { width: 110 });
      pdf.text(String(it.rendimiento) + '/' + it.envase, colX[2], y0, { width: 65 });
      pdf.text(it.paquetesNecesarios + ' ' + it.envase + '(s)', colX[3], y0, { width: 65 });
      pdf.text('$ ' + it.subtotal.toFixed(2), colX[4], y0, { width: 90 });
      pdf.moveDown(0.6);
    });

    pdf.moveDown(0.4);
    pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#ddd').stroke();
    pdf.moveDown(0.5);

    pdf.fontSize(10);
    pdf.text('Subtotal productos: $ ' + doc.totalProductos.toFixed(2), { align: 'right' });
    if (doc.totalManoObra) pdf.text('Mano de obra: $ ' + doc.totalManoObra.toFixed(2), { align: 'right' });
    pdf.fontSize(13).text('Total: $ ' + doc.total.toFixed(2), { align: 'right' });

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
