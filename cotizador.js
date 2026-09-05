// ---------------------------------------------------------------------------
// Cotizador de obra — módulo adicional para la app "Calculadora m2".
//
// Se monta como router Express dentro del server.js existente. Lee la MISMA
// base Mongo Atlas (db "calculadora_m2") y las mismas colecciones "stores" y
// "rendimientos" que ya usa la app (no las toca, solo lee), y agrega dos
// colecciones nuevas propias de este módulo:
//   - tarifas_mano_obra : una tarifa configurable por tienda (store_id)
//   - cotizaciones      : historial de presupuestos armados
//
// Integración (ver INTEGRACION.md): en server.js
//   const cotizadorRouter = require('./cotizador');
//   app.use('/api/cotizador', cotizadorRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient } = require('mongodb');
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
async function productosConfigurados(store, { rubro, q } = {}) {
  const [productos, rendimientos] = await Promise.all([
    fetchAllProducts(store.store_id, store.access_token),
    getRendimientosDeTienda(store.store_id)
  ]);

  const porProductId = {};
  rendimientos.forEach((r) => { porProductId[r.product_id] = r; });

  let resultado = productos
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

  if (rubro) {
    const rubroLower = String(rubro).toLowerCase();
    resultado = resultado.filter((p) => p.categoria.toLowerCase().includes(rubroLower));
  }
  if (q) {
    const qLower = String(q).toLowerCase();
    resultado = resultado.filter((p) => p.nombre.toLowerCase().includes(qLower));
  }
  return resultado;
}

// ---------- Calculo de la cotizacion (funcion pura, sin red ni DB) ----------

// productos: { piso, zocalo, puerta, nivelacion } -> cada uno (si aplica)
//   { id, nombre, tipo, cobertura, envase, precio, categoria }
// obra: { m2Pisos, mlZocalos, cantidadPuertas, requiereNivelacion, manoObra }
// tarifas: { pisos_m2, zocalos_ml, puertas_unidad, nivelacion_m2 }
function calcularItem({ rubro, unidadObra, cantidadObra, producto }) {
  const necesarios = cantidadObra / producto.cobertura;
  const paquetes = Math.ceil(necesarios - 1e-9); // tolerancia de redondeo
  const subtotal = round2(paquetes * producto.precio);
  return {
    rubro,
    productoId: producto.id,
    producto: producto.nombre,
    categoria: producto.categoria || '',
    unidadObra,
    cantidadObra: round2(cantidadObra),
    rendimiento: producto.cobertura,
    envase: producto.envase,
    paquetesNecesarios: paquetes,
    precioUnitario: producto.precio,
    subtotal
  };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function calcularCotizacion({ obra, productos, tarifas }) {
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

  if (m2Pisos > 0) {
    if (!productos.piso) faltantes.push('piso');
    else {
      const it = calcularItem({ rubro: 'Piso', unidadObra: 'm2', cantidadObra: m2Pisos, producto: productos.piso });
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
      const it = calcularItem({ rubro: 'Puerta', unidadObra: 'unidad', cantidadObra: cantidadPuertas, producto: productos.puerta });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(cantidadPuertas * t.puertas_unidad);
    }
  }

  if (requiereNivelacion) {
    if (!productos.nivelacion) faltantes.push('nivelacion');
    else if (m2Pisos > 0) {
      const it = calcularItem({ rubro: 'Nivelación', unidadObra: 'm2', cantidadObra: m2Pisos, producto: productos.nivelacion });
      items.push(it);
      totalProductos += it.subtotal;
      if (manoObra) totalManoObra += round2(m2Pisos * t.nivelacion_m2);
    }
  }

  totalProductos = round2(totalProductos);
  totalManoObra = round2(totalManoObra);
  const total = round2(totalProductos + totalManoObra);

  return { items, faltantes, totalProductos, totalManoObra, total };
}

// ---------- Helper: arma el detalle de "productos" para calcularCotizacion
// a partir de los ids elegidos en el front, buscando cobertura/precio real ----------

async function resolverProductosElegidos(store, seleccion) {
  const ids = Object.values(seleccion || {}).filter(Boolean);
  if (ids.length === 0) return {};

  const catalogo = await productosConfigurados(store);
  const porId = {};
  catalogo.forEach((p) => { porId[p.id] = p; });

  const resultado = {};
  for (const clave of Object.keys(seleccion || {})) {
    const id = seleccion[clave];
    if (!id) continue;
    const prod = porId[parseInt(id, 10)] || porId[id];
    if (prod) resultado[clave] = prod;
  }
  return resultado;
}

// =====================================================================
// Rutas
// =====================================================================

// Catalogo de productos ya configurados (con rendimiento), filtrable por
// rubro (categoria de Tiendanube) y/o texto libre. Usado por el selector
// de productos del cotizador.
router.get('/productos', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const productos = await productosConfigurados(store, { rubro: req.query.rubro, q: req.query.q });
    res.json(productos);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Tarifas de mano de obra por tienda
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

// Calcula (sin guardar) — vista previa
router.post('/calcular', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { obra, productos } = req.body || {};
    if (!obra) return res.status(400).json({ error: 'Falta obra.' });

    const [productosElegidos, tarifas] = await Promise.all([
      resolverProductosElegidos(store, productos),
      getTarifas(store.store_id)
    ]);

    const resultado = calcularCotizacion({ obra, productos: productosElegidos, tarifas });
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Calcula y guarda en el historial
router.post('/guardar', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { obra, productos, cliente, direccion } = req.body || {};
    if (!obra) return res.status(400).json({ error: 'Falta obra.' });

    const [productosElegidos, tarifas] = await Promise.all([
      resolverProductosElegidos(store, productos),
      getTarifas(store.store_id)
    ]);

    const resultado = calcularCotizacion({ obra, productos: productosElegidos, tarifas });
    if (resultado.faltantes.length > 0) {
      return res.status(400).json({ error: 'Falta elegir producto para: ' + resultado.faltantes.join(', ') });
    }

    const doc = {
      store_id: store.store_id,
      fecha: new Date(),
      cliente: cliente || '',
      direccion: direccion || '',
      obra,
      items: resultado.items,
      totalProductos: resultado.totalProductos,
      totalManoObra: resultado.totalManoObra,
      total: resultado.total
    };

    const col = await getCotizacionesCollection();
    const { insertedId } = await col.insertOne(doc);
    res.json(Object.assign({ _id: insertedId }, doc));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Historial: listado resumido
router.get('/historial', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const col = await getCotizacionesCollection();
    const lista = await col
      .find({ store_id: store.store_id })
      .project({ cliente: 1, direccion: 1, fecha: 1, total: 1 })
      .sort({ fecha: -1 })
      .limit(200)
      .toArray();
    res.json(lista);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Historial: una cotizacion completa
router.get('/historial/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { ObjectId } = require('mongodb');
    const col = await getCotizacionesCollection();
    const doc = await col.findOne({ _id: new ObjectId(req.params.id), store_id: store.store_id });
    if (!doc) return res.status(404).json({ error: 'No encontrada.' });
    res.json(doc);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PDF de una cotizacion guardada
router.get('/pdf/:id', async (req, res) => {
  try {
    const store = await getStoreFromQuery(req);
    const { ObjectId } = require('mongodb');
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
      .text('Fecha: ' + new Date(doc.fecha).toLocaleDateString('es-AR'));
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
      pdf.text(it.rubro + ' — ' + it.producto, colX[0], y0, { width: 145 });
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

    pdf.end();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.calcularCotizacion = calcularCotizacion; // exportado para tests
