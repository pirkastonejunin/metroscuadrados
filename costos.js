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
//   - costos_insumos       : { nombre, unidad, costoActual, historial:
//                              [{costo, fecha, nota, usuario}], activo,
//                              orgId, createdAt, updatedAt }
//   - costos_productos     : { nombre, tipoCosteo ('unidad'|'m2'),
//                              receta: [{insumoId, cantidad, rendimiento?}],
//                              unidadesPorPaquete?, rendimientoPorPaquete?,
//                              activo, orgId, createdAt, updatedAt }
//   - costos_listas_precio : { nombre, porcentaje, activa, orgId,
//                              createdAt, updatedAt } — precio de lista =
//                              costo actual del producto * (1+porcentaje/100),
//                              calculado al vuelo, nunca guardado congelado.
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
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, backfillOrgId } = require('./usuarios');

const router = express.Router();

const DB_NAME = 'calculadora_m2';

// Logo para los PDF brandeados de listas de precio — mismo archivo que usa
// cotizador.js. Si no existe, dibujarMarcaCostos() cae a un wordmark en
// texto para que el PDF nunca se rompa por faltar el logo.
const LOGO_PNG_PATH = path.join(__dirname, 'public', 'assets', 'logo-piedra-negra.png');

function moneyPdfCostos(n) {
  return '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Encabezado con marca Piedra Negra para los PDF de este módulo (copiado del
// mismo patrón que usa cotizador.js, ver dibujarMarca() ahí).
function dibujarMarcaCostos(pdf) {
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
  pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#1f2937').lineWidth(1.4).stroke();
  pdf.strokeColor('#ddd').lineWidth(1);
  pdf.moveDown(0.6);
  pdf.fillColor('#000');
}

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

// Número opcional (>0) para los datos de empaque del producto — se guarda
// `null` si no se cargó nada, nunca 0 ni NaN.
function normalizarNumeroOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw err(400, `${etiqueta} tiene que ser un número mayor a 0`);
  return n;
}
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

const seedHecho = {}; // por orgId (string) — una vez por proceso
async function seedInsumosPorDefecto(db, orgId) {
  // Nunca sembrar sin una organización puntual — si no hay orgId (viendo
  // "todas") no hay forma de saber a quién pertenecerían estos insumos por
  // defecto. Bug corregido el 28/9/2026: antes esto creaba insumos con
  // orgId=null la primera vez que alguien entraba viendo "todas", y esos
  // insumos quedaban invisibles (huérfanos) en cuanto se elegía una
  // organización puntual — ver reconciliarHuerfanosInsumos más abajo, que
  // recupera los que ya se crearon así.
  if (!orgId) return;
  const clave = orgId.toString();
  if (seedHecho[clave]) return;
  seedHecho[clave] = true;
  const hayAlguno = await db.collection('costos_insumos').countDocuments({ orgId }, { limit: 1 });
  if (hayAlguno) return;
  const ahora = new Date();
  const docs = INSUMOS_POR_DEFECTO.map(i => ({
    nombre: i.nombre,
    unidad: i.unidad,
    costoActual: 0,
    historial: [],
    activo: true,
    orgId,
    createdAt: ahora,
    updatedAt: ahora
  }));
  await db.collection('costos_insumos').insertMany(docs);
}

// ---------------------------------------------------------------------
// Recuperación de insumos huérfanos (orgId: null) — corrige el bug de
// seedInsumosPorDefecto de más arriba, que hasta el 28/9/2026 podía crear
// insumos sin organización asignada. Al entrar a una organización puntual
// por primera vez, si existen insumos huérfanos se les asigna esa
// organización — si ya existe un insumo con el mismo nombre recién creado
// por el seed (sin costo ni historial cargado todavía), se borra ese
// duplicado vacío y se conserva el huérfano (que tiene los datos reales).
// Una sola vez por proceso y por organización — después de la primera
// reconciliación ya no quedan huérfanos con ese nombre.
const reconciliacionHecha = {};
async function reconciliarHuerfanosInsumos(db, orgId) {
  if (!orgId) return;
  const clave = orgId.toString();
  if (reconciliacionHecha[clave]) return;
  reconciliacionHecha[clave] = true;
  const huerfanos = await db.collection('costos_insumos').find({ orgId: null }).toArray();
  if (!huerfanos.length) return;
  for (const h of huerfanos) {
    const duplicado = await db.collection('costos_insumos').findOne({ orgId, nombre: h.nombre, _id: { $ne: h._id } });
    if (duplicado && !(duplicado.historial || []).length && !duplicado.costoActual) {
      await db.collection('costos_insumos').deleteOne({ _id: duplicado._id });
      await db.collection('costos_insumos').updateOne({ _id: h._id }, { $set: { orgId, updatedAt: new Date() } });
    } else if (!duplicado) {
      await db.collection('costos_insumos').updateOne({ _id: h._id }, { $set: { orgId, updatedAt: new Date() } });
    }
    // Si hay un duplicado CON datos propios (caso raro), no se toca nada acá
    // — queda el huérfano sin asignar para revisar a mano, en vez de arriesgar
    // pisar datos reales de los dos lados.
  }
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
      await reconciliarHuerfanosInsumos(db, req.orgId);
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
    const { nombre, tipoCosteo, receta, unidadesPorPaquete, rendimientoPorPaquete } = req.body || {};
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
        // Datos de empaque (opcionales): cuántas unidades físicas trae un
        // paquete/caja/bolsón, y cuánto rinde ese paquete (en la misma
        // unidad del producto — m² si tipoCosteo='m2', unidades si no).
        unidadesPorPaquete: normalizarNumeroOpcional(unidadesPorPaquete, 'Unidades por paquete'),
        rendimientoPorPaquete: normalizarNumeroOpcional(rendimientoPorPaquete, 'Rendimiento por paquete'),
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
    const { nombre, tipoCosteo, receta, activo, unidadesPorPaquete, rendimientoPorPaquete } = req.body || {};

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
      if (unidadesPorPaquete !== undefined) set.unidadesPorPaquete = normalizarNumeroOpcional(unidadesPorPaquete, 'Unidades por paquete');
      if (rendimientoPorPaquete !== undefined) set.rendimientoPorPaquete = normalizarNumeroOpcional(rendimientoPorPaquete, 'Rendimiento por paquete');

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

// ---------------------------------------------------------------------
// Listas de precio — un % de markup fijo sobre el costo ACTUAL de cada
// producto (ej: "Mayorista" +30%, "Consumidor final" +60%). No guardan un
// precio congelado por producto: el detalle siempre se recalcula con el
// costo de hoy, así que subir el costo de un insumo actualiza todas las
// listas solas, sin tener que tocarlas una por una.
//
// Colección nueva: costos_listas_precio : { nombre, porcentaje, activa,
//                                            orgId, createdAt, updatedAt }
// ---------------------------------------------------------------------

router.get('/listas-precio', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('costos_listas_precio').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/listas-precio', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear una lista de precio.');
    const { nombre, porcentaje } = req.body || {};
    if (!nombre || !String(nombre).trim()) throw err(400, 'Falta el nombre de la lista (ej: Mayorista, Consumidor final)');
    const pct = Number(porcentaje);
    if (!Number.isFinite(pct)) throw err(400, 'El porcentaje tiene que ser un número (puede ser 0)');

    const ahora = new Date();
    const doc = {
      nombre: String(nombre).trim(),
      porcentaje: pct,
      activa: true,
      orgId: req.orgId,
      createdAt: ahora,
      updatedAt: ahora
    };
    const r = await conReintento(async () => (await getDb()).collection('costos_listas_precio').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/listas-precio/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { nombre, porcentaje, activa } = req.body || {};
    const set = { updatedAt: new Date() };
    if (nombre !== undefined) {
      if (!String(nombre).trim()) throw err(400, 'La lista necesita un nombre');
      set.nombre = String(nombre).trim();
    }
    if (porcentaje !== undefined) {
      const pct = Number(porcentaje);
      if (!Number.isFinite(pct)) throw err(400, 'El porcentaje tiene que ser un número (puede ser 0)');
      set.porcentaje = pct;
    }
    if (activa !== undefined) set.activa = !!activa;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Lista de precio no encontrada');
      await db.collection('costos_listas_precio').updateOne({ _id: id }, { $set: set });
      return db.collection('costos_listas_precio').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/listas-precio/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Lista de precio no encontrada');
      await db.collection('costos_listas_precio').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Arma { lista, productos: filas } — reutilizado por el JSON de detalle y
// por los exports PDF/Excel, para no tener la misma lógica tres veces.
async function obtenerDetalleLista(req, id) {
  const { lista, productos, insumosPorId } = await conReintento(async () => {
    const db = await getDb();
    const lista = await db.collection('costos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    if (!lista) throw err(404, 'Lista de precio no encontrada');
    const productos = await db.collection('costos_productos')
      .find(Object.assign({ activo: { $ne: false } }, filtroOrg(req)))
      .sort({ nombre: 1 }).toArray();
    const insumosPorId = await traerInsumosDeProductos(db, req, productos);
    return { lista, productos, insumosPorId };
  });
  const filas = productos.map(p => {
    const { costoTotal } = calcularCostoProducto(p, insumosPorId);
    const precio = costoTotal * (1 + lista.porcentaje / 100);
    return {
      productoId: p._id,
      nombre: p.nombre,
      tipoCosteo: p.tipoCosteo,
      costoActual: costoTotal,
      precio,
      unidadesPorPaquete: p.unidadesPorPaquete || null,
      rendimientoPorPaquete: p.rendimientoPorPaquete || null
    };
  });
  return { lista, productos: filas };
}

// Detalle: la lista + el precio de cada producto activo, calculado con el
// costo de HOY — precio = costoActual * (1 + porcentaje/100).
router.get('/listas-precio/:id/detalle', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const data = await obtenerDetalleLista(req, id);
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const LEYENDA_LISTA_PRECIO = 'Los precios pueden variar sin previo aviso.';

// PDF brandeado de la lista de precio: logo, fecha, tabla (sin costo interno)
// y la leyenda legal al pie.
router.get('/listas-precio/:id/pdf', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { lista, productos } = await obtenerDetalleLista(req, id);

    const nombreArchivo = String(lista.nombre).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="lista-precio-' + nombreArchivo + '.pdf"');

    const fecha = new Date().toLocaleDateString('es-AR');
    const COL_PRODUCTO_X = 50, COL_PRODUCTO_W = 250;
    const COL_UNID_X = 300, COL_UNID_W = 80;
    const COL_RINDE_X = 380, COL_RINDE_W = 80;
    const COL_PRECIO_X = 460, COL_PRECIO_W = 85;
    const TABLE_RIGHT = 545;
    const PAGE_BOTTOM = () => pdf.page.height - pdf.page.margins.bottom;

    const pdf = new PDFDocument({ margin: 50 });
    pdf.pipe(res);

    function dibujarEncabezado() {
      dibujarMarcaCostos(pdf);
      pdf.fontSize(16).fillColor('#000').text('Lista de precios — ' + lista.nombre, { align: 'left' });
      pdf.moveDown(0.2);
      // Ojo: esta lista se manda a clientes, así que ni el costo interno ni
      // el % de margen aplicado tienen que aparecer acá — solo la fecha.
      pdf.fontSize(10).fillColor('#555').text('Fecha: ' + fecha);
      pdf.fillColor('#000');
      pdf.moveDown(0.6);
      const y0 = pdf.y;
      pdf.fontSize(9).fillColor('#555');
      pdf.text('Producto', COL_PRODUCTO_X, y0, { width: COL_PRODUCTO_W });
      pdf.text('Unid./caja', COL_UNID_X, y0, { width: COL_UNID_W });
      pdf.text('Rinde/caja', COL_RINDE_X, y0, { width: COL_RINDE_W });
      pdf.text('Precio', COL_PRECIO_X, y0, { width: COL_PRECIO_W, align: 'right' });
      pdf.fillColor('#000');
      pdf.y = y0 + 14;
      pdf.moveDown(0.3);
      pdf.moveTo(50, pdf.y).lineTo(TABLE_RIGHT, pdf.y).strokeColor('#ddd').stroke();
      pdf.moveDown(0.3);
    }

    dibujarEncabezado();

    productos.forEach(p => {
      if (pdf.y + 20 > PAGE_BOTTOM()) {
        pdf.addPage();
        dibujarEncabezado();
      }
      const y0 = pdf.y;
      pdf.fontSize(10).fillColor('#000');
      pdf.text(p.nombre, COL_PRODUCTO_X, y0, { width: COL_PRODUCTO_W });
      pdf.text(p.unidadesPorPaquete ? Number(p.unidadesPorPaquete).toLocaleString('es-AR') : '—', COL_UNID_X, y0, { width: COL_UNID_W });
      pdf.text(p.rendimientoPorPaquete ? Number(p.rendimientoPorPaquete).toLocaleString('es-AR') + (p.tipoCosteo === 'm2' ? ' m²' : ' u') : '—', COL_RINDE_X, y0, { width: COL_RINDE_W });
      pdf.text(moneyPdfCostos(p.precio), COL_PRECIO_X, y0, { width: COL_PRECIO_W, align: 'right' });
      pdf.y = Math.max(pdf.y, y0 + 16);
    });

    pdf.moveDown(1);
    if (pdf.y + 20 > PAGE_BOTTOM()) pdf.addPage();
    pdf.fontSize(9).fillColor('#777').font('Helvetica-Oblique')
      .text(LEYENDA_LISTA_PRECIO, 50, pdf.y, { width: TABLE_RIGHT - 50 });
    pdf.font('Helvetica').fillColor('#000');

    pdf.end();
  } catch (e) {
    if (!res.headersSent) res.status(e.status || 500).json({ error: e.message });
    else res.end();
  }
});

// Excel de la lista de precio: mismas columnas que el PDF/CSV (sin costo
// interno), con la fecha y la leyenda legal como filas al pie.
router.get('/listas-precio/:id/xlsx', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { lista, productos } = await obtenerDetalleLista(req, id);

    const fecha = new Date().toLocaleDateString('es-AR');
    // Esta lista se manda a clientes: ni el costo interno ni el % de margen
    // aplicado van acá, solo la fecha.
    const filas = [
      ['Lista de precios — ' + lista.nombre],
      ['Fecha: ' + fecha],
      [],
      ['Producto', 'Unidades por caja', 'Rinde por caja', 'Precio de lista']
    ];
    productos.forEach(p => filas.push([
      p.nombre,
      p.unidadesPorPaquete || '',
      p.rendimientoPorPaquete ? p.rendimientoPorPaquete + (p.tipoCosteo === 'm2' ? ' m²' : ' u') : '',
      Number(p.precio.toFixed(2))
    ]));
    filas.push([]);
    filas.push([LEYENDA_LISTA_PRECIO]);

    const hoja = XLSX.utils.aoa_to_sheet(filas);
    hoja['!cols'] = [{ wch: 38 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Lista de precios');
    const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });

    const nombreArchivo = String(lista.nombre).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="lista-precio-' + nombreArchivo + '.xlsx"');
    res.send(buffer);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
