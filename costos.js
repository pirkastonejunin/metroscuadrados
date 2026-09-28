// ---------------------------------------------------------------------------
// Costos de Producción — insumos con costo variable en el tiempo (con
// historial), productos con receta (qué insumos y cuánto de cada uno lleva
// una unidad o un m² de ese producto) y el costo calculado en base a los
// costos ACTUALES de los insumos de la receta.
//
// Decisiones de diseño (con Mato, 28/9/2026):
//   - Cada producto se costea "por unidad" o "por m²" (elegido por producto,
//     no fijo para todo el módulo) — campo `tipoCosteo`.
//   - Catálogo propio de insumos y productos en Mongo, independiente de
//     Tiendanube (la decisión de fondo de Productos/Stock — ver
//     roadmap-modulos.md — sigue sin cerrarse, y este módulo no depende de
//     ella).
//   - Módulo con clave propia ('costos'), datos separados por organización
//     (mismo mecanismo orgId/resolverOrg/filtroOrg que visitas/obras/CRM).
//   - Mano de obra se modela como un insumo más, con unidad 'jornal' — así
//     el costo del jornal tiene el mismo historial y la misma UI de
//     "actualizar costo" que cemento, arena, etc., sin duplicar código. En
//     la receta de un producto, el ítem de mano de obra se carga como
//     "rendimiento" (cuántas unidades/m² hace un jornal) en vez de una
//     cantidad directa — el servidor calcula `cantidad` (jornales por
//     unidad/m²) como 1/rendimiento.
//
// Colecciones nuevas (en la misma base `calculadora_m2`):
//   - costos_insumos   : { nombre, unidad, costoActual, historial:
//                          [{costo, fecha, nota, usuario}], activo, orgId,
//                          createdAt, updatedAt }
//   - costos_productos : { nombre, tipoCosteo ('unidad'|'m2'),
//                          receta: [{insumoId, cantidad, rendimiento?}],
//                          activo, orgId, createdAt, updatedAt }
//
// V1 — a propósito afuera de esta primera versión:
//   - No hay evolución histórica del costo CALCULADO de un producto (solo
//     de cada insumo por separado) — el costo de un producto siempre se
//     muestra con los costos ACTUALES de los insumos de su receta.
//   - No hay ninguna conexión con Obras/Stock/Tiendanube todavía — es un
//     catálogo propio, aislado, pensado para poder recalcular costos y
//     armar recetas ya mismo sin esperar esa decisión más grande.
//
// Integración (en server.js):
//   const costosRouter = require('./costos');
//   app.use('/api/costos', costosRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, backfillOrgId } = require('./usuarios');

const router = express.Router();

const DB_NAME = 'calculadora_m2';

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (e) {
      mongoClient = null;
      throw e;
    }
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    mongoClient = null; // fuerza reconexión, mismo patrón que el resto de la app
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const TIPOS_COSTEO_VALIDOS = ['unidad', 'm2'];
const UNIDAD_MANO_DE_OBRA = 'jornal';

// Módulo con clave propia — decisión tomada con Mato (28/9/2026): datos
// separados por organización, mismo mecanismo que visitas/obras/CRM.
const authAdmin = [authUsuario, resolverOrg, requiereModulo('costos')];

// ---------------------------------------------------------------------
// Insumos por defecto — se crean solos la primera vez que una
// organización pide su lista de insumos y todavía no tiene ninguno, así
// Mato no tiene que darlos de alta uno por uno. Cualquiera se puede
// desactivar o son un punto de partida nomás: se pueden sumar más
// insumos después sin límite.
// ---------------------------------------------------------------------
const INSUMOS_POR_DEFECTO = [
  { nombre: 'Cemento gris', unidad: 'kg' },
  { nombre: 'Cemento blanco', unidad: 'kg' },
  { nombre: 'Arena', unidad: 'kg' },
  { nombre: 'Piedra', unidad: 'kg' },
  { nombre: 'Grumo volcánico', unidad: 'kg' },
  { nombre: 'Pigmento negro', unidad: 'kg' },
  { nombre: 'Pigmento amarillo', unidad: 'kg' },
  { nombre: 'Pigmento rojo', unidad: 'kg' },
  { nombre: 'Pigmento marrón', unidad: 'kg' },
  { nombre: 'Packaging', unidad: 'unidad' },
  { nombre: 'Aditivos', unidad: 'kg' },
  { nombre: 'Hierro', unidad: 'kg' },
  { nombre: 'Mano de obra', unidad: UNIDAD_MANO_DE_OBRA }
];

const seedHecho = {}; // por orgId (string) o 'null' para "sin organización" — una vez por proceso
async function seedInsumosPorDefecto(db, orgId) {
  const clave = orgId ? orgId.toString() : 'null';
  if (seedHecho[clave]) return;
  seedHecho[clave] = true;
  const filtro = orgId ? { orgId } : {};
  const hayAlguno = await db.collection('costos_insumos').countDocuments(filtro, { limit: 1 });
  if (hayAlguno) return;
  const ahora = new Date();
  const docs = INSUMOS_POR_DEFECTO.map(i => ({
    nombre: i.nombre,
    unidad: i.unidad,
    costoActual: 0,
    historial: [],
    activo: true,
    orgId: orgId || null,
    createdAt: ahora,
    updatedAt: ahora
  }));
  await db.collection('costos_insumos').insertMany(docs);
}

// ---------------------------------------------------------------------
// Insumos
// ---------------------------------------------------------------------

router.get('/insumos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (!req.query.incluirInactivos) match.activo = { $ne: false };
    const lista = await conReintento(async () => {
      const db = await getDb();
      await backfillOrgId(db, 'costos_insumos');
      await seedInsumosPorDefecto(db, req.orgId);
      return db.collection('costos_insumos').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/insumos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('costos_insumos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!doc) throw err(404, 'Insumo no encontrado');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/insumos', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un insumo.');
    const { nombre, unidad, costoInicial, nota } = req.body || {};
    if (!nombre || !String(nombre).trim()) throw err(400, 'Falta el nombre del insumo');
    if (!unidad || !String(unidad).trim()) throw err(400, 'Falta la unidad del insumo (kg, l, unidad, jornal, etc.)');
    const costo = Number(costoInicial) || 0;
    if (costo < 0) throw err(400, 'El costo no puede ser negativo');

    const ahora = new Date();
    const doc = {
      nombre: String(nombre).trim(),
      unidad: String(unidad).trim(),
      costoActual: costo,
      historial: costo ? [{ costo, fecha: ahora, nota: nota || 'Alta del insumo', usuario: req.usuario.nombre }] : [],
      activo: true,
      orgId: req.orgId,
      createdAt: ahora,
      updatedAt: ahora
    };
    const r = await conReintento(async () => (await getDb()).collection('costos_insumos').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/insumos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { nombre, unidad, activo } = req.body || {};
    const set = { updatedAt: new Date() };
    if (nombre !== undefined) {
      if (!String(nombre).trim()) throw err(400, 'El insumo necesita un nombre');
      set.nombre = String(nombre).trim();
    }
    if (unidad !== undefined) {
      if (!String(unidad).trim()) throw err(400, 'El insumo necesita una unidad');
      set.unidad = String(unidad).trim();
    }
    if (activo !== undefined) set.activo = !!activo;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_insumos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Insumo no encontrado');
      await db.collection('costos_insumos').updateOne({ _id: id }, { $set: set });
      return db.collection('costos_insumos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Actualizar el costo de un insumo — no pisa costoActual sin dejar rastro:
// suma un punto nuevo al historial y ESE pasa a ser el costo actual. Así
// "evolución histórica del costo" sale gratis, ordenando el array por fecha.
router.post('/insumos/:id/costo', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { costo, nota } = req.body || {};
    const costoNum = Number(costo);
    if (!Number.isFinite(costoNum) || costoNum < 0) throw err(400, 'Ingresá un costo válido (mayor o igual a 0)');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_insumos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Insumo no encontrado');
      const punto = { costo: costoNum, fecha: new Date(), nota: nota || '', usuario: req.usuario.nombre };
      await db.collection('costos_insumos').updateOne(
        { _id: id },
        { $set: { costoActual: costoNum, updatedAt: new Date() }, $push: { historial: punto } }
      );
      return db.collection('costos_insumos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Productos — receta de insumos + cálculo de costo
// ---------------------------------------------------------------------

// Valida y normaliza la receta contra los insumos reales de la organización.
// Para el ítem de mano de obra (insumo con unidad 'jornal'), si viene
// `rendimiento` (unidades o m² que hace un jornal) se usa eso para calcular
// `cantidad` (jornales por unidad/m²) = 1/rendimiento — más natural para
// cargar que pedir directamente "jornales por unidad".
async function normalizarReceta(db, req, recetaRaw) {
  if (!Array.isArray(recetaRaw) || !recetaRaw.length) throw err(400, 'La receta necesita al menos un insumo');
  const ids = [];
  for (const item of recetaRaw) {
    const iid = toObjectId(item.insumoId);
    if (!iid) throw err(400, 'Insumo inválido en la receta');
    ids.push(iid);
  }
  const insumos = await db.collection('costos_insumos')
    .find(Object.assign({ _id: { $in: ids } }, filtroOrg(req)))
    .toArray();
  const insumosPorId = {};
  insumos.forEach(i => { insumosPorId[i._id.toString()] = i; });

  const receta = [];
  const vistos = new Set();
  for (const item of recetaRaw) {
    const iid = toObjectId(item.insumoId);
    const insumo = insumosPorId[iid.toString()];
    if (!insumo) throw err(400, 'Algún insumo de la receta no existe o no es de esta organización');
    if (vistos.has(iid.toString())) throw err(400, `El insumo "${insumo.nombre}" está repetido en la receta`);
    vistos.add(iid.toString());

    let cantidad, rendimiento;
    if (insumo.unidad === UNIDAD_MANO_DE_OBRA) {
      rendimiento = Number(item.rendimiento);
      if (!Number.isFinite(rendimiento) || rendimiento <= 0) {
        throw err(400, `Ingresá el rendimiento de "${insumo.nombre}" (unidades o m² que hace un jornal)`);
      }
      cantidad = 1 / rendimiento;
    } else {
      cantidad = Number(item.cantidad);
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        throw err(400, `Ingresá una cantidad válida de "${insumo.nombre}"`);
      }
    }
    const fila = { insumoId: iid, cantidad };
    if (rendimiento !== undefined) fila.rendimiento = rendimiento;
    receta.push(fila);
  }
  return receta;
}

// Costo de un producto con los costos ACTUALES de sus insumos — no guarda
// nada, se recalcula al vuelo cada vez que se pide (ver nota de "V1" arriba:
// no hay snapshot histórico del costo del producto en sí).
function calcularCostoProducto(producto, insumosPorId) {
  let costoTotal = 0;
  const items = producto.receta.map(fila => {
    const insumo = insumosPorId[fila.insumoId.toString()];
    const costoUnitario = insumo ? (insumo.costoActual || 0) : 0;
    const subtotal = costoUnitario * fila.cantidad;
    costoTotal += subtotal;
    return {
      insumoId: fila.insumoId,
      nombre: insumo ? insumo.nombre : '(insumo borrado)',
      unidad: insumo ? insumo.unidad : '',
      esManoDeObra: !!(insumo && insumo.unidad === UNIDAD_MANO_DE_OBRA),
      cantidad: fila.cantidad,
      rendimiento: fila.rendimiento,
      costoUnitario,
      subtotal
    };
  });
  return { costoTotal, items };
}

async function traerInsumosDeProductos(db, req, productos) {
  const idsSet = new Set();
  productos.forEach(p => (p.receta || []).forEach(f => idsSet.add(f.insumoId.toString())));
  const ids = Array.from(idsSet).map(toObjectId).filter(Boolean);
  if (!ids.length) return {};
  const insumos = await db.collection('costos_insumos')
    .find(Object.assign({ _id: { $in: ids } }, filtroOrg(req)))
    .toArray();
  const porId = {};
  insumos.forEach(i => { porId[i._id.toString()] = i; });
  return porId;
}

router.get('/productos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (!req.query.incluirInactivos) match.activo = { $ne: false };
    const { productos, insumosPorId } = await conReintento(async () => {
      const db = await getDb();
      await backfillOrgId(db, 'costos_productos');
      const productos = await db.collection('costos_productos').find(match).sort({ nombre: 1 }).toArray();
      const insumosPorId = await traerInsumosDeProductos(db, req, productos);
      return { productos, insumosPorId };
    });
    const lista = productos.map(p => {
      const { costoTotal } = calcularCostoProducto(p, insumosPorId);
      return Object.assign({}, p, { costoActual: costoTotal });
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/productos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { producto, insumosPorId } = await conReintento(async () => {
      const db = await getDb();
      const producto = await db.collection('costos_productos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!producto) throw err(404, 'Producto no encontrado');
      const insumosPorId = await traerInsumosDeProductos(db, req, [producto]);
      return { producto, insumosPorId };
    });
    const { costoTotal, items } = calcularCostoProducto(producto, insumosPorId);
    res.json(Object.assign({}, producto, { costoActual: costoTotal, detalleCosto: items }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/productos', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un producto.');
    const { nombre, tipoCosteo, receta } = req.body || {};
    if (!nombre || !String(nombre).trim()) throw err(400, 'Falta el nombre del producto');
    if (!TIPOS_COSTEO_VALIDOS.includes(tipoCosteo)) throw err(400, 'tipoCosteo tiene que ser "unidad" o "m2"');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const recetaNorm = await normalizarReceta(db, req, receta);
      const ahora = new Date();
      const doc = {
        nombre: String(nombre).trim(),
        tipoCosteo,
        receta: recetaNorm,
        activo: true,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };
      const r = await db.collection('costos_productos').insertOne(doc);
      doc._id = r.insertedId;
      return doc;
    });
    const insumosPorId = await conReintento(async () => traerInsumosDeProductos(await getDb(), req, [resultado]));
    const { costoTotal, items } = calcularCostoProducto(resultado, insumosPorId);
    res.json(Object.assign({}, resultado, { costoActual: costoTotal, detalleCosto: items }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/productos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { nombre, tipoCosteo, receta, activo } = req.body || {};

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_productos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Producto no encontrado');

      const set = { updatedAt: new Date() };
      if (nombre !== undefined) {
        if (!String(nombre).trim()) throw err(400, 'El producto necesita un nombre');
        set.nombre = String(nombre).trim();
      }
      if (tipoCosteo !== undefined) {
        if (!TIPOS_COSTEO_VALIDOS.includes(tipoCosteo)) throw err(400, 'tipoCosteo tiene que ser "unidad" o "m2"');
        set.tipoCosteo = tipoCosteo;
      }
      if (receta !== undefined) set.receta = await normalizarReceta(db, req, receta);
      if (activo !== undefined) set.activo = !!activo;

      await db.collection('costos_productos').updateOne({ _id: id }, { $set: set });
      return db.collection('costos_productos').findOne({ _id: id });
    });
    const insumosPorId = await conReintento(async () => traerInsumosDeProductos(await getDb(), req, [resultado]));
    const { costoTotal, items } = calcularCostoProducto(resultado, insumosPorId);
    res.json(Object.assign({}, resultado, { costoActual: costoTotal, detalleCosto: items }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/productos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_productos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Producto no encontrado');
      await db.collection('costos_productos').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
