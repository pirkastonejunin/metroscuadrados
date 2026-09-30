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
//
// Actualización (30/9/2026, sincronización con Productos): al crear o
// actualizar un producto de Costos CON SKU, se crea/actualiza automática
// su ficha en productos_catalogo (mismo SKU) — ver
// `sincronizarProductoEnCatalogo` más abajo. Productos sigue siendo la
// fuente de verdad de precio y demás datos comerciales.
// ---------------------------------------------------------------------------

const express = require('express');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, backfillOrgId, tieneModulo } = require('./usuarios');

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

// SKU (código) del producto — vincula un producto de Costos con el mismo
// producto en Tiendanube/Cotizador (rubro "Revestimientos Piedra") y con su
// CÓDIGO en Dux, para el ingreso de stock generado por Producción. No es
// obligatorio, pero si se carga tiene que ser único dentro de la
// organización (si no, el archivo para Dux quedaría ambiguo).
function normalizarSkuOpcional(v) {
  if (v === undefined || v === null || !String(v).trim()) return null;
  return String(v).trim();
}
async function validarSkuUnico(db, req, sku, idExcluir) {
  if (!sku) return;
  const match = Object.assign({ sku, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('costos_productos').findOne(match);
  if (existente) throw err(400, `Ya hay otro producto activo con el SKU "${sku}" (${existente.nombre}).`);
}

// Sincronización Producción→Productos (30/9/2026, pedido de Mato: "los
// productos de produccion deberian aparecer en productos tal cual con el
// mismo sku"). Al crear o actualizar un producto de Costos de Producción
// CON SKU, se crea/actualiza automáticamente su ficha en
// productos_catalogo (mismo SKU) — así no hay que cargarlo dos veces a
// mano para que la conexión Fábrica→Stock lo encuentre.
//
// Decisión (con Mato, 30/9/2026): Productos sigue siendo la fuente de
// verdad de precio, rubro, marca y demás datos comerciales — la
// sincronización SOLO toca nombre y el vínculo `costoProductoId` en una
// ficha ya existente; el resto de los campos comerciales, una vez
// creados, los edita Mato desde Productos y no se vuelven a pisar acá.
// Si la ficha no existe todavía, se crea con datos mínimos razonables
// (unidad/tipoUnidad según tipoCosteo, tipoProducto:'produccion') para
// que Mato la complete con precio y demás cuando haga falta. Sin SKU no
// hay nada que sincronizar — ese caso ya se avisa aparte como "sinSku"
// en la conexión a Stock.
async function sincronizarProductoEnCatalogo(db, req, costosProducto) {
  if (!costosProducto || !costosProducto.sku) return;
  const match = Object.assign({ sku: costosProducto.sku }, filtroOrg(req));
  const existente = await db.collection('productos_catalogo').findOne(match);
  const ahora = new Date();
  if (existente) {
    await db.collection('productos_catalogo').updateOne(
      { _id: existente._id },
      { $set: { nombre: costosProducto.nombre, costoProductoId: costosProducto._id, updatedAt: ahora } }
    );
  } else {
    const esM2 = costosProducto.tipoCosteo === 'm2';
    const nuevo = {
      sku: costosProducto.sku, nombre: costosProducto.nombre,
      unidad: esM2 ? 'm2' : 'unidad', tipoUnidad: esM2 ? 'superficie' : 'unidad',
      disponiblePara: 'todos', moneda: 'ARS', tipoProducto: 'produccion',
      rubro: '', subrubro: '', marca: '', codigoBarra: '', codigoExterno: '',
      proveedor: '', proveedorId: null, embalaje: '', descripcion: '', notas: '',
      precio: null, costo: null, porcentajeIva: null, impuestoInterno: null,
      unidadesPorBulto: null, fechaVencimiento: null,
      stockeable: true, aceptaStockNegativo: false, trazable: false,
      utilizaVariantes: false, indicaCtdBultos: false,
      costoProductoId: costosProducto._id, cantidadMinima: null, stockIdeal: null,
      activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
    };
    await db.collection('productos_catalogo').insertOne(nuevo);
  }
}

// Módulo con clave propia — decisión tomada con Mato (28/9/2026): datos
// separados por organización, mismo mecanismo que visitas/obras/CRM.
const authAdmin = [authUsuario, resolverOrg, requiereModulo('costos')];

// La carga diaria de producción la puede hacer tanto el personal de fábrica
// (módulo 'fabrica', y NADA MÁS del resto de este router) como alguien de
// oficina con el módulo 'costos' — de ahí este segundo gate, que acepta
// cualquiera de los dos en vez de exigir uno puntual como requiereModulo().
function requiereModuloAlguno(...claves) {
  return (req, res, next) => {
    const ok = claves.some(k => tieneModulo(req.usuario, k));
    if (!ok) return res.status(403).json({ error: 'Tu usuario no tiene acceso a este módulo. Pedile a un administrador que te lo habilite.' });
    next();
  };
}
const authProduccion = [authUsuario, resolverOrg, requiereModuloAlguno('fabrica', 'costos')];

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

// Sincronización masiva Producción→Productos (30/9/2026, pedido de Mato:
// "podes incluirme todo lo que ya esta en el modulo de produccion en
// productos?"). La sincronización automática de `sincronizarProductoEnCatalogo`
// (ver arriba) solo corre cuando se crea o edita un producto de Costos DE
// ACÁ EN ADELANTE — esta ruta es el "backfill" de una sola vez para los
// productos de Costos que ya existían antes de esa conexión.
router.post('/productos/sincronizar-catalogo', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de sincronizar.');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
      const productos = await db.collection('costos_productos').find(match).toArray();
      let sincronizados = 0;
      const sinSku = [];
      for (const p of productos) {
        if (!p.sku) { sinSku.push(p.nombre); continue; }
        await sincronizarProductoEnCatalogo(db, req, p);
        sincronizados++;
      }
      return { total: productos.length, sincronizados, sinSku };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
    const { nombre, sku, tipoCosteo, receta, unidadesPorPaquete, rendimientoPorPaquete } = req.body || {};
    if (!nombre || !String(nombre).trim()) throw err(400, 'Falta el nombre del producto');
    if (!TIPOS_COSTEO_VALIDOS.includes(tipoCosteo)) throw err(400, 'tipoCosteo tiene que ser "unidad" o "m2"');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const skuNorm = normalizarSkuOpcional(sku);
      await validarSkuUnico(db, req, skuNorm, null);
      const recetaNorm = await normalizarReceta(db, req, receta);
      const ahora = new Date();
      const doc = {
        nombre: String(nombre).trim(),
        // Código que vincula este producto con Tiendanube/Cotizador (rubro
        // "Revestimientos Piedra") y con el CÓDIGO del producto en Dux.
        sku: skuNorm,
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
      await sincronizarProductoEnCatalogo(db, req, doc);
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
    const { nombre, sku, tipoCosteo, receta, activo, unidadesPorPaquete, rendimientoPorPaquete } = req.body || {};

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_productos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Producto no encontrado');

      const set = { updatedAt: new Date() };
      if (nombre !== undefined) {
        if (!String(nombre).trim()) throw err(400, 'El producto necesita un nombre');
        set.nombre = String(nombre).trim();
      }
      if (sku !== undefined) {
        const skuNorm = normalizarSkuOpcional(sku);
        await validarSkuUnico(db, req, skuNorm, id);
        set.sku = skuNorm;
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
      const doc = await db.collection('costos_productos').findOne({ _id: id });
      await sincronizarProductoEnCatalogo(db, req, doc);
      return doc;
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
// Producción — carga diaria de fábrica: el personal de fábrica indica qué
// productos hizo hoy y cuántos PAQUETES de cada uno, y acá se convierte
// solo a la cantidad real (m² o unidades) usando el rendimiento por
// paquete ya configurado en cada producto. Con esa carga se genera un
// archivo listo para importar como INGRESO de stock en Dux (mismo formato
// que la plantilla de "Importar stock" del panel de importación de Dux:
// CODIGO, TALLE, COLOR, CANTIDAD DISPONIBLE, CANTIDAD MÍNIMA, TIPO
// MOVIMIENTO, NÚMERO IDENTIFICACIÓN TRAZABLE — ver instructivo de Dux).
//
// Colección nueva: costos_produccion_diaria : { orgId, fecha ('AAAA-MM-DD'),
//   items: [{ productoId, nombre, sku, tipoCosteo, paquetes,
//             unidadesPorPaquete, rendimientoPorPaquete, cantidadConvertida,
//             unidadConvertida }], actualizadoPor: {usuarioId, nombre},
//   depositoId, stockIngresado, stockIngresadoEn, stockIngresadoPor,
//   createdAt, updatedAt }
//
// Rol dedicado: el módulo 'fabrica' (ver MODULOS en usuarios.js) da acceso
// SOLO a esto (público en public/fabrica.html) — no al resto de Costos de
// Producción. Alguien de oficina con el módulo 'costos' también puede
// entrar acá (authProduccion acepta cualquiera de los dos).
//
// Conexión con Stock (pedido de Mato, 29/9/2026, inmediatamente después de
// construir el módulo Stock): "fábrica debería estar conectado con stock de
// tal manera que cuando se ingresa el stock fabricado impacte en las
// cantidades de stock del producto terminado". Reemplaza (para el flujo
// normal) el archivo de importación manual a Dux, que se deja igual como
// respaldo por si hace falta.
//
// Se implementa como una acción EXPLÍCITA y separada de "Guardar carga del
// día" — POST /produccion/:fecha/ingresar-stock — en vez de aplicar el
// impacto en cada guardado. Motivo: la carga del día se puede guardar
// (POST /produccion) varias veces mientras se va completando/corrigiendo
// antes de cerrarla, y los movimientos de Stock son un LIBRO INMUTABLE (ver
// stock.js) — aplicar en cada guardado duplicaría el ingreso. Por eso:
//   - "Ingresar a stock" se hace una sola vez por día (se guarda
//     `stockIngresado: true` en el documento de producción del día, y un
//     segundo intento se rechaza con el detalle de quién y cuándo ya lo
//     hizo — si hace falta corregir, se carga un movimiento de ajuste a
//     mano en el módulo Stock, igual que cualquier otra corrección).
//   - Solo entran los ítems con SKU (sin SKU no hay forma de saber a qué
//     producto del catálogo de Stock corresponde) Y con conversión real a
//     m²/unidad (si el producto no tiene `rendimientoPorPaquete` cargado,
//     la cantidad quedó en "paquetes" y no es una cantidad de stock
//     confiable — se avisa y se deja afuera, igual que ya pasaba con el
//     archivo de Dux).
//   - El vínculo entre un producto de Costos/Fábrica (`costos_productos`) y
//     su equivalente en el catálogo de Stock (`productos_catalogo`) es el
//     SKU — mismo criterio que ya usaba el archivo de Dux.
// ---------------------------------------------------------------------

function validarFecha(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw err(400, 'Fecha inválida (formato AAAA-MM-DD)');
  return String(v);
}

// Recalcula, a partir de los productos ACTUALES (no de lo que haya guardado
// una carga anterior), cuánto representa "N paquetes" de cada ítem. Si el
// producto no tiene rendimiento por paquete cargado, no hay forma de
// convertir — se guarda tal cual en paquetes, para no inventar un número.
function convertirItemProduccion(producto, paquetes) {
  const rinde = producto.rendimientoPorPaquete || null;
  const cantidadConvertida = rinde ? paquetes * rinde : paquetes;
  const unidadConvertida = rinde ? (producto.tipoCosteo === 'm2' ? 'm2' : 'unidad') : 'paquete';
  return {
    productoId: producto._id,
    nombre: producto.nombre,
    sku: producto.sku || null,
    tipoCosteo: producto.tipoCosteo,
    paquetes,
    unidadesPorPaquete: producto.unidadesPorPaquete || null,
    rendimientoPorPaquete: rinde,
    cantidadConvertida,
    unidadConvertida
  };
}

// Lista liviana de productos activos para la pantalla de fábrica — no hace
// falta el costo (por eso no reusa GET /productos, que además exige el
// módulo 'costos' específicamente en vez de 'fabrica' o 'costos').
router.get('/productos-produccion', authProduccion, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const productos = await conReintento(async () => {
      const db = await getDb();
      return db.collection('costos_productos')
        .find(match, { projection: { nombre: 1, sku: 1, tipoCosteo: 1, unidadesPorPaquete: 1, rendimientoPorPaquete: 1 } })
        .sort({ nombre: 1 }).toArray();
    });
    res.json(productos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/produccion', authProduccion, async (req, res) => {
  try {
    const fecha = validarFecha(req.query.fecha);
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('costos_produccion_diaria').findOne(Object.assign({ fecha }, filtroOrg(req)));
    });
    const items = (doc && doc.items) || [];
    res.json({
      fecha,
      items,
      actualizadoPor: doc ? doc.actualizadoPor : null,
      updatedAt: doc ? doc.updatedAt : null,
      // Sin SKU no hay CÓDIGO posible para la fila de Dux — se avisa acá para
      // que la pantalla de fábrica lo muestre ANTES de generar el archivo.
      sinSku: items.filter(it => !it.sku).map(it => it.nombre),
      depositoId: doc ? doc.depositoId : null,
      stockIngresado: !!(doc && doc.stockIngresado),
      stockIngresadoEn: doc ? doc.stockIngresadoEn : null,
      stockIngresadoPor: doc ? doc.stockIngresadoPor : null
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/produccion', authProduccion, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar producción.');
    const fecha = validarFecha(req.body && req.body.fecha);
    const itemsRaw = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    const depositoIdBody = req.body && req.body.depositoId ? toObjectId(req.body.depositoId) : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const items = [];
      for (const it of itemsRaw) {
        const productoId = toObjectId(it.productoId);
        if (!productoId) throw err(400, 'productoId inválido');
        const paquetes = Number(it.paquetes);
        if (!Number.isFinite(paquetes) || paquetes <= 0) throw err(400, 'La cantidad de paquetes tiene que ser un número mayor a 0');
        const producto = await db.collection('costos_productos').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
        if (!producto) throw err(400, 'Uno de los productos cargados no existe (o no pertenece a esta organización)');
        items.push(convertirItemProduccion(producto, paquetes));
      }
      const ahora = new Date();
      const set = {
        items,
        actualizadoPor: { usuarioId: req.usuario._id, nombre: req.usuario.nombre },
        orgId: req.orgId,
        fecha,
        updatedAt: ahora
      };
      // El depósito elegido se recuerda en el documento del día (para que
      // "Ingresar a stock" lo tenga precargado), pero solo si vino en el
      // body — no se pisa con null si la pantalla todavía no cargó ninguno.
      if (depositoIdBody) set.depositoId = depositoIdBody;
      await db.collection('costos_produccion_diaria').updateOne(
        { orgId: req.orgId, fecha },
        { $set: set, $setOnInsert: { createdAt: ahora } },
        { upsert: true }
      );
      return db.collection('costos_produccion_diaria').findOne({ orgId: req.orgId, fecha });
    });
    res.json({
      fecha: resultado.fecha,
      items: resultado.items,
      actualizadoPor: resultado.actualizadoPor,
      updatedAt: resultado.updatedAt,
      sinSku: resultado.items.filter(it => !it.sku).map(it => it.nombre),
      depositoId: resultado.depositoId || null,
      stockIngresado: !!resultado.stockIngresado,
      stockIngresadoEn: resultado.stockIngresadoEn || null,
      stockIngresadoPor: resultado.stockIngresadoPor || null
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Depósitos activos de la organización, para que la pantalla de fábrica
// (rol 'fabrica', sin acceso al módulo 'stock') pueda elegir a cuál
// depósito va a impactar la producción del día — misma colección que usa
// el módulo Stock (`depositos`), pero expuesta acá bajo el gate de
// producción (authProduccion) en vez del de Stock (authAdmin de stock.js).
router.get('/produccion/depositos', authProduccion, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('depositos').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ingresa a Stock, de una sola vez, lo fabricado ese día — ver el comentario
// grande más arriba ("Conexión con Stock") para el porqué del diseño.
router.post('/produccion/:fecha/ingresar-stock', authProduccion, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de ingresar a stock.');
    const fecha = validarFecha(req.params.fecha);
    const depositoId = toObjectId(req.body && req.body.depositoId);
    if (!depositoId) throw err(400, 'Elegí a qué depósito va a ingresar lo fabricado.');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const doc = await db.collection('costos_produccion_diaria').findOne(Object.assign({ fecha }, filtroOrg(req)));
      if (!doc || !doc.items || !doc.items.length) throw err(400, 'No hay producción cargada ese día.');
      if (doc.stockIngresado) {
        const cuando = doc.stockIngresadoEn ? new Date(doc.stockIngresadoEn).toLocaleString('es-AR') : '';
        const quien = doc.stockIngresadoPor ? doc.stockIngresadoPor.nombre : '';
        const detalle = [quien, cuando].filter(Boolean).join(', ');
        throw err(400, `La producción de este día ya se ingresó a stock${detalle ? ' (' + detalle + ')' : ''}. Si hace falta corregir, cargá un movimiento de ajuste a mano en el módulo Stock.`);
      }
      const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
      if (!deposito) throw err(404, 'Depósito no encontrado');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const fechaMovimiento = new Date(fecha + 'T12:00:00');
      const aplicados = [];
      const sinCatalogo = [];
      const sinConvertir = [];

      for (const it of doc.items) {
        if (!it.sku) continue; // ya se avisa por separado como "sinSku"
        if (it.unidadConvertida === 'paquete') { sinConvertir.push(it.nombre); continue; }
        const producto = await db.collection('productos_catalogo').findOne(Object.assign({ sku: it.sku, activo: { $ne: false } }, filtroOrg(req)));
        if (!producto) { sinCatalogo.push(`${it.nombre} (SKU ${it.sku})`); continue; }

        const cantidad = Number(it.cantidadConvertida);
        if (!Number.isFinite(cantidad) || cantidad <= 0) continue;

        const movimiento = {
          productoId: producto._id,
          depositoId,
          tipo: 'ingreso',
          cantidad,
          motivo: 'Producción de fábrica',
          sucursal: '',
          codigoExterno: '',
          observaciones: `Carga de producción del ${fecha}`,
          usuarioNombre,
          fecha: fechaMovimiento,
          orgId: req.orgId,
          createdAt: new Date()
        };
        await db.collection('stock_movimientos').insertOne(movimiento);
        await db.collection('stock_actual').findOneAndUpdate(
          Object.assign({ productoId: producto._id, depositoId }, filtroOrg(req)),
          {
            $inc: { cantidad },
            $set: { actualizadoEn: new Date() },
            $setOnInsert: Object.assign({ productoId: producto._id, depositoId }, filtroOrg(req))
          },
          { upsert: true }
        );
        aplicados.push({ nombre: it.nombre, sku: it.sku, cantidad, unidad: it.unidadConvertida, deposito: deposito.nombre });
      }

      const ahora = new Date();
      const stockIngresadoPor = { usuarioId: req.usuario._id, nombre: usuarioNombre };
      await db.collection('costos_produccion_diaria').updateOne(
        { _id: doc._id },
        { $set: { depositoId, stockIngresado: true, stockIngresadoEn: ahora, stockIngresadoPor } }
      );

      return { aplicados, sinCatalogo, sinConvertir, stockIngresadoEn: ahora, stockIngresadoPor };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Archivo de ingreso de stock para Dux, con las columnas EXACTAS de su
// plantilla de importación (mismo orden — Dux no publica que el orden
// importe, pero para no arriesgar se respeta el de la plantilla real).
// Solo entran las filas con SKU cargado (sin código no hay forma de
// identificar el producto en Dux); TIPO MOVIMIENTO fijo en "INGRESO" (suma
// a lo que ya había en stock, no lo pisa) y el resto de las columnas
// (talle/color/cantidad mínima/trazabilidad) van vacías — estos productos
// no tienen variantes ni son trazables.
router.get('/produccion/:fecha/dux', authProduccion, async (req, res) => {
  try {
    const fecha = validarFecha(req.params.fecha);
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('costos_produccion_diaria').findOne(Object.assign({ fecha }, filtroOrg(req)));
    });
    const items = (doc && doc.items) || [];
    const conSku = items.filter(it => it.sku);
    if (!conSku.length) throw err(400, 'Ninguno de los productos cargados ese día tiene SKU asignado — no se puede generar el archivo para Dux.');

    const filas = [
      ['CODIGO', 'TALLE', 'COLOR', 'CANTIDAD DISPONIBLE', 'CANTIDAD MÍNIMA', 'TIPO MOVIMIENTO', 'NUMERO IDENTIFICACION TRAZABLE']
    ];
    conSku.forEach(it => filas.push([
      it.sku, '', '', Number(it.cantidadConvertida.toFixed(4)), '', 'INGRESO', ''
    ]));

    const hoja = XLSX.utils.aoa_to_sheet(filas);
    hoja['!cols'] = [{ wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 24 }];
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Stock');
    const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="ingreso-stock-dux-' + fecha + '.xlsx"');
    res.send(buffer);
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
