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
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, backfillOrgId, tieneModulo, asegurarOrgPorDefecto } = require('./usuarios');

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
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    // Carrera de conexión (4/10/2026, ver compras.js): se guarda la
    // conexión EN CURSO para que los requests simultáneos de un proceso
    // recién arrancado esperen la misma, en vez de usar un cliente que
    // todavía no terminó de conectar.
    if (!mongoConectando) {
      const nuevoCliente = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevoCliente.connect().then(
        () => { mongoClient = nuevoCliente; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.status) throw e; // un rechazo de negocio (400/404…) no se reintenta: si ya había escrito algo, lo duplicaría
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
// .toUpperCase() acá (30/9/2026, bug detectado por Mato): el SKU acá y en
// productos.js tienen que guardarse con el mismo criterio de mayúsculas,
// si no la sincronización Producción→Productos (más abajo) y el import
// de Dux pueden crear un producto duplicado para el mismo SKU con
// distinto casing. Ver el comentario igual en productos.js.
function normalizarSkuOpcional(v) {
  if (v === undefined || v === null || !String(v).trim()) return null;
  return String(v).trim().toUpperCase();
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
  // .toUpperCase() acá además de en normalizarSkuOpcional (30/9/2026):
  // así la sincronización encuentra bien el producto en productos_catalogo
  // aunque el documento de costos_productos sea viejo y todavía tenga el
  // SKU guardado con otro casing de antes de este fix.
  const sku = String(costosProducto.sku).trim().toUpperCase();
  const match = Object.assign({ sku }, filtroOrg(req));
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
      sku, nombre: costosProducto.nombre,
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
// La producción es única para todo el grupo (pedido de Mato, 7/10/2026): la fábrica
// no depende de la sucursal elegida arriba (PN Factory es una sucursal virtual que
// solo vende a mayoristas), así que todas las pantallas y rutas de producción
// trabajan siempre con la organización de la planta (la de por defecto, "Piedra
// Negra", donde están los productos y recetas) y su depósito Junín.
async function fijarOrgProduccion(req, res, next) {
  try {
    req.orgId = await conReintento(async () => asegurarOrgPorDefecto(await getDb()));
    next();
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}
const authProduccion = [authUsuario, requiereModuloAlguno('fabrica', 'costos'), fijarOrgProduccion];
// Costos de Producción (insumos, recetas, listas) también es único para todo el grupo (13/10/2026, pedido de Mato).
const authAdmin = [authUsuario, requiereModulo('costos'), fijarOrgProduccion];
// Vínculo Producción -> Productos: cualquier cambio en insumos, recetas o listas dispara la sincronización (ver programarSincronizacion).
router.use((req, res, next) => {
  if (req.method !== 'GET' && /^\/(insumos|productos|listas-precio|matriz-listas)(\/|$)/.test(req.path) && !/sincronizar-productos/.test(req.path)) {
    res.on('finish', () => { if (res.statusCode < 400 && req.orgId) programarSincronizacion(req); });
  }
  next();
});

// Depósito donde entra toda la producción: el depósito Junín de la planta.
async function depositoProduccion(db, orgId) {
  return db.collection('depositos').findOne({ orgId, activo: { $ne: false }, nombre: /jun[ií]n/i });
}

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

// Productos ya cargados en el catálogo (módulo Productos) que todavía no tienen
// receta de costos: sirven para elegir uno al crear un producto de producción.
router.get('/productos/catalogo-disponibles', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      const usados = await db.collection('costos_productos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req)), { projection: { sku: 1 } }).toArray();
      const skusUsados = new Set(usados.map(p => String(p.sku || '').toUpperCase()).filter(Boolean));
      const cat = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req)), { projection: { sku: 1, nombre: 1, unidad: 1 } }).sort({ nombre: 1 }).toArray();
      return cat.filter(c => !c.sku || !skusUsados.has(String(c.sku).toUpperCase()))
        .map(c => ({ _id: c._id, sku: c.sku || '', nombre: c.nombre || '', unidad: c.unidad || '' }));
    });
    res.json(lista);
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
// (21/10/2026) Un producto que se maneja por unidad y no tiene "Unidades por paquete" ni rendimiento cargado
// no necesita conversión: cada "paquete" cargado es una unidad (1 a 1).
function rendimientoEfectivo(p) {
  if (!p) return null;
  if (p.rendimientoPorPaquete) return p.rendimientoPorPaquete;
  return (p.tipoCosteo === 'unidad' && !p.unidadesPorPaquete) ? 1 : null;
}
function convertirItemProduccion(producto, paquetes, unidades) {
  const rinde = rendimientoEfectivo(producto);
  // Si se cargó por unidad / m² (15/10/2026), esa cantidad manda tal cual y los paquetes se deducen.
  if (unidades && rinde) paquetes = Math.round(unidades / rinde * 10000) / 10000;
  const cantidadConvertida = rinde ? (unidades ? unidades : paquetes * rinde) : paquetes;
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
    const dep = await conReintento(async () => depositoProduccion(await getDb(), req.orgId));
    res.json(dep ? [dep] : []);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Cargas del día (7/10/2026, pedido de Mato): se puede cargar producción varias veces por día. Cada carga
// es un documento propio de costos_produccion_diaria que se guarda y se ingresa a Stock en un solo paso, en
// el depósito Junín.
router.post('/produccion/ingresar', authProduccion, async (req, res) => {
  try {
    const fecha = validarFecha(req.body && req.body.fecha);
    const itemsRaw = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!itemsRaw.length) throw err(400, 'Cargá al menos un producto con paquetes mayores a 0.');
    const out = await conReintento(async () => {
      const db = await getDb();
      const deposito = await depositoProduccion(db, req.orgId);
      if (!deposito) throw err(400, 'No existe el depósito Junín. Crealo en Stock con ese nombre: toda la producción entra ahí.');
      const items = [];
      for (const it of itemsRaw) {
        const productoId = toObjectId(it.productoId);
        if (!productoId) throw err(400, 'productoId inválido');
        const unidades = it.unidades !== undefined && it.unidades !== null && it.unidades !== '' ? Number(it.unidades) : null;
        const paquetes = Number(it.paquetes);
        if (unidades !== null) { if (!Number.isFinite(unidades) || unidades <= 0) throw err(400, 'La cantidad (unidades o m²) tiene que ser un número mayor a 0'); }
        else if (!Number.isFinite(paquetes) || paquetes <= 0) throw err(400, 'La cantidad de paquetes tiene que ser un número mayor a 0');
        const producto = await db.collection('costos_productos').findOne({ _id: productoId, orgId: req.orgId });
        if (!producto) throw err(400, 'Uno de los productos cargados no existe');
        if (unidades !== null && !rendimientoEfectivo(producto)) throw err(400, `"${producto.nombre}" no tiene rendimiento por paquete configurado: cargalo en paquetes.`);
        items.push(convertirItemProduccion(producto, unidades !== null ? 0 : paquetes, unidades));
      }
      const ahora = new Date();
      const doc = { orgId: req.orgId, fecha, items, actualizadoPor: { usuarioId: req.usuario._id, nombre: req.usuario.nombre }, createdAt: ahora, updatedAt: ahora };
      const r = await db.collection('costos_produccion_diaria').insertOne(doc);
      doc._id = r.insertedId;
      const res2 = await aplicarProduccionAStock(db, req, doc, fecha, deposito);
      return Object.assign(res2, { sinSku: items.filter(it => !it.sku).map(it => it.nombre) });
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Cargas de un día, para mostrarlas en la pantalla de producción.
router.get('/produccion/cargas', authProduccion, async (req, res) => {
  try {
    const fecha = validarFecha(req.query.fecha);
    const docs = await conReintento(async () => (await getDb()).collection('costos_produccion_diaria').find({ orgId: req.orgId, fecha }).sort({ createdAt: 1 }).toArray());
    res.json(docs.map(d => ({ _id: d._id, hora: d.createdAt, por: d.actualizadoPor ? d.actualizadoPor.nombre : '', ingresada: !!d.stockIngresado, items: (d.items || []).map(it => ({ nombre: it.nombre, paquetes: it.paquetes, cantidad: it.cantidadConvertida, unidad: it.unidadConvertida })) })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Panel de producción (17/10/2026, pedido de Mato): producción día a día y, por cada producto de
// producción, stock físico, comprometido (ventas pendientes de entrega) y faltante (lo comprometido
// que el stock no cubre = lo que hay que fabricar). El stock y lo comprometido se leen de stock_actual
// por producto del catálogo (se vincula por SKU con el producto de Costos) sumando todos los depósitos
// y la demanda sin depósito asignado: el catálogo es compartido entre sucursales.
// GET /produccion/panel?dias=14  (hasta 90)
function fechaARCostos(d) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
const redond2 = n => Math.round((Number(n) || 0) * 100) / 100;
router.get('/produccion/panel', authProduccion, async (req, res) => {
  try {
    const nDias = Math.min(90, Math.max(1, parseInt(req.query.dias, 10) || 14));
    const hoy = fechaARCostos(new Date());
    const fechas = [];
    for (let i = nDias - 1; i >= 0; i--) fechas.push(fechaARCostos(new Date(new Date(hoy + 'T12:00:00-03:00').getTime() - i * 864e5)));
    const out = await conReintento(async () => {
      const db = await getDb();
      const productos = await db.collection('costos_productos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req)))
        .project({ nombre: 1, sku: 1, tipoCosteo: 1, rendimientoPorPaquete: 1, unidadesPorPaquete: 1 }).sort({ nombre: 1 }).toArray();
      const docs = await db.collection('costos_produccion_diaria').find(Object.assign({ fecha: { $gte: fechas[0], $lte: hoy } }, filtroOrg(req)))
        .project({ fecha: 1, items: 1 }).toArray();
      // Catálogo: se vincula por el enlace que deja la sincronización (costoProductoId) o por SKU (sin distinguir
      // mayúsculas ni espacios, porque los SKU viejos pueden estar guardados con otro formato).
      const normSku = v => String(v == null ? '' : v).trim().toUpperCase();
      const skusUp = [...new Set(productos.map(p => normSku(p.sku)).filter(Boolean))];
      const catalogo = productos.length ? await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req), {
        $or: [{ costoProductoId: { $in: productos.map(p => p._id) } }].concat(skusUp.length ? [{ sku: { $in: skusUp } }] : [])
      })).project({ sku: 1, unidad: 1, cantidadMinima: 1, costoProductoId: 1 }).toArray() : [];
      const catPorSku = new Map(catalogo.map(c => [normSku(c.sku), c]));
      const catPorCosto = new Map(catalogo.filter(c => c.costoProductoId).map(c => [String(c.costoProductoId), c]));
      const catDe = p => catPorCosto.get(String(p._id)) || (p.sku ? catPorSku.get(normSku(p.sku)) : null) || null;
      const existencias = catalogo.length ? await db.collection('stock_actual').find({ productoId: { $in: catalogo.map(c => c._id) } }).toArray() : [];
      const stockPorProd = new Map();
      for (const e of existencias) {
        const k = String(e.productoId);
        const a = stockPorProd.get(k) || { stock: 0, comprometido: 0 };
        if (e.depositoId != null) a.stock += Number(e.cantidad) || 0;
        a.comprometido += Number(e.cantidadComprometida) || 0;
        stockPorProd.set(k, a);
      }
      // Producción por día y por producto (misma clave que usa la carga: productoId, y si no, SKU o nombre).
      const idx = new Map(fechas.map((f, i) => [f, i]));
      const claveDe = it => String(it.productoId || it.sku || it.nombre);
      const porProd = new Map();
      const dias = fechas.map(f => ({ fecha: f, m2: 0, unidades: 0, paquetes: 0, cargas: 0 }));
      const sinProducto = new Map(); // producido de productos que ya no están en Costos
      for (const d of docs) {
        const i = idx.get(d.fecha);
        if (i === undefined) continue;
        dias[i].cargas += 1;
        for (const it of (d.items || [])) {
          const cant = Number(it.cantidadConvertida) || 0, paq = Number(it.paquetes) || 0, u = it.unidadConvertida || 'paquete';
          if (!cant && !paq) continue;
          if (u === 'm2') dias[i].m2 += cant; else if (u === 'unidad') dias[i].unidades += cant;
          dias[i].paquetes += paq;
          const k = claveDe(it);
          const arr = porProd.get(k) || (porProd.set(k, new Array(fechas.length).fill(0)), porProd.get(k));
          arr[i] += cant || paq;
          if (!productos.some(p => String(p._id) === k) && !sinProducto.has(k)) sinProducto.set(k, { nombre: it.nombre || it.sku || 'Sin nombre', sku: it.sku || null, unidad: u });
        }
      }
      const fila = (p, nombre, sku, unidad, rinde, porDia, cat) => {
        const st = cat ? (stockPorProd.get(String(cat._id)) || { stock: 0, comprometido: 0 }) : null;
        const disponible = st ? st.stock - st.comprometido : null;
        const faltante = st ? Math.max(0, st.comprometido - st.stock) : null;
        return {
          productoId: p ? p._id : null, nombre, sku, unidad,
          porDia: porDia.map(redond2),
          hoy: redond2(porDia[porDia.length - 1]),
          periodo: redond2(porDia.reduce((s, n) => s + n, 0)),
          vinculado: !!st,
          unidadStock: cat ? (cat.unidad || null) : null,
          stock: st ? redond2(st.stock) : null,
          comprometido: st ? redond2(st.comprometido) : null,
          disponible: st ? redond2(disponible) : null,
          faltante: st ? redond2(faltante) : null,
          paquetesAFabricar: st && rinde && faltante > 0 ? Math.ceil(faltante / rinde) : null
        };
      };
      const filas = productos.map(p => {
        const rinde = rendimientoEfectivo(p);
        const unidad = rinde ? (p.tipoCosteo === 'm2' ? 'm2' : 'unidad') : 'paquete';
        return fila(p, p.nombre, p.sku || null, unidad, rinde, porProd.get(String(p._id)) || new Array(fechas.length).fill(0), catDe(p));
      });
      // Los que no se pudieron vincular: motivo y posibles candidatos del catálogo por nombre (solo lectura, para ayudar a corregir).
      const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const sinVinc = filas.filter(f => !f.vinculado && f.productoId).slice(0, 12);
      for (const f of sinVinc) {
        f.motivo = f.sku ? 'sku_no_encontrado' : 'sin_sku';
        const palabras = norm(f.nombre).split(' ').filter(w => w.length > 3).slice(0, 4);
        if (!palabras.length) continue;
        const posibles = await db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req), {
          $or: palabras.map(w => ({ nombre: new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }))
        })).project({ sku: 1, nombre: 1 }).limit(60).toArray();
        const minimo = Math.max(1, Math.ceil(palabras.length / 2));
        f.candidatos = posibles.map(c => ({ sku: c.sku, nombre: c.nombre, puntos: palabras.filter(w => norm(c.nombre).includes(w)).length }))
          .filter(c => c.puntos >= minimo).sort((x, y) => y.puntos - x.puntos).slice(0, 3).map(c => ({ sku: c.sku, nombre: c.nombre }));
        // Si el SKU sugerido ya lo usa OTRO producto de Costos (típico de un producto cargado dos veces), se avisa cuál.
        const usados = f.candidatos.length ? await db.collection('costos_productos').find(Object.assign({ activo: { $ne: false }, _id: { $ne: f.productoId }, sku: { $in: f.candidatos.map(c => normSku(c.sku)) } }, filtroOrg(req)))
          .project({ nombre: 1, sku: 1 }).toArray() : [];
        for (const c of f.candidatos) { const u = usados.find(x => normSku(x.sku) === normSku(c.sku)); if (u) c.usadoPor = u.nombre; }
      }
      for (const [k, v] of sinProducto) filas.push(Object.assign(fila(null, v.nombre, v.sku, v.unidad, null, porProd.get(k), v.sku ? catPorSku.get(normSku(v.sku)) : null), { archivado: true }));
      const conFaltante = filas.filter(f => f.faltante > 0);
      return {
        hoy, dias: dias.map(d => ({ fecha: d.fecha, m2: redond2(d.m2), unidades: redond2(d.unidades), paquetes: redond2(d.paquetes), cargas: d.cargas })),
        productos: filas,
        resumen: {
          m2Hoy: redond2(dias[dias.length - 1].m2), unidadesHoy: redond2(dias[dias.length - 1].unidades),
          m2Periodo: redond2(dias.reduce((s, d) => s + d.m2, 0)), unidadesPeriodo: redond2(dias.reduce((s, d) => s + d.unidades, 0)),
          diasConProduccion: dias.filter(d => d.cargas > 0).length,
          productosConFaltante: conFaltante.length, sinVincular: filas.filter(f => !f.vinculado && !f.archivado).length
        }
      };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Detalle del comprometido de un producto de producción (17/10/2026, pedido de Mato: "ver a quién le debemos"):
// las ventas pendientes de entrega (o con entrega parcial) que lo reservan, con cliente, comprobante, fecha y la
// cantidad que falta entregar. Incluye todas las sucursales y depósitos, igual que el comprometido del panel.
// GET /produccion/comprometido?productoId=<id del producto de Costos>
router.get('/produccion/comprometido', authProduccion, async (req, res) => {
  try {
    const productoId = toObjectId(req.query.productoId);
    if (!productoId) throw err(400, 'Falta el producto');
    const out = await conReintento(async () => {
      const db = await getDb();
      const prod = await db.collection('costos_productos').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!prod) throw err(404, 'Producto no encontrado');
      const sku = prod.sku ? String(prod.sku).trim().toUpperCase() : null;
      const cat = await db.collection('productos_catalogo').findOne(Object.assign({ activo: { $ne: false } }, filtroOrg(req), {
        $or: [{ costoProductoId: prod._id }].concat(sku ? [{ sku }] : [])
      }));
      if (!cat) return { producto: prod.nombre, vinculado: false, ventas: [], total: 0, comprometidoStock: null };
      const ventas = await db.collection('ventas').find({
        estado: { $in: ['pendiente', 'parcialmente_entregada'] }, canceladaPorNota: { $ne: true },
        tipoComprobante: { $nin: ['nota_credito', 'nota_debito'] }, 'items.productoId': cat._id
      }).sort({ fecha: 1 }).toArray();
      const orgIds = [...new Set(ventas.map(v => String(v.orgId || '')).filter(Boolean))].map(toObjectId).filter(Boolean);
      const orgs = orgIds.length ? await db.collection('organizaciones').find({ _id: { $in: orgIds } }).project({ nombre: 1 }).toArray() : [];
      const nombreOrg = new Map(orgs.map(o => [String(o._id), o.nombre]));
      const filas = [];
      for (const v of ventas) {
        let cantidad = 0;
        for (const it of (v.items || [])) if (String(it.productoId) === String(cat._id)) cantidad += Math.max(0, (it.cantidad || 0) - (it.cantidadEntregada || 0) - (it.cantidadAcreditada || 0));
        if (cantidad <= 0) continue;
        filas.push({
          ventaId: v._id, clienteId: v.clienteId || null, clienteNombre: v.clienteNombre || 'Sin cliente',
          comprobante: v.numeroOriginal || ((v.letra || (v.tipoComprobante === 'fiscal' ? 'F' : 'X')) + '-' + String(v.numero || '').padStart(5, '0')),
          estado: v.estado, fecha: v.fecha, sucursal: nombreOrg.get(String(v.orgId || '')) || '', cantidad: redond2(cantidad)
        });
      }
      const existencias = await db.collection('stock_actual').find({ productoId: cat._id }).toArray();
      const comprometidoStock = redond2(existencias.reduce((a, e) => a + (Number(e.cantidadComprometida) || 0), 0));
      const stock = redond2(existencias.filter(e => e.depositoId != null).reduce((a, e) => a + (Number(e.cantidad) || 0), 0));
      return { producto: prod.nombre, vinculado: true, unidad: cat.unidad || null, ventas: filas, total: redond2(filas.reduce((a, f) => a + f.cantidad, 0)), clientes: new Set(filas.map(f => f.clienteNombre)).size, comprometidoStock, stock };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ingresa a Stock los ítems de una carga de producción (un documento de costos_produccion_diaria)
// en el depósito dado y la marca como ingresada. Los movimientos de Stock son un libro inmutable,
// por eso cada carga se ingresa una sola vez.
async function aplicarProduccionAStock(db, req, doc, fecha, deposito) {
  const depositoId = deposito._id;
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
}

// Reintenta la conversión de una carga que quedó en "paquetes" porque el producto no tenía rendimiento (15/10/2026):
// si ahora lo tiene, se convierte a m²/unidades y esos ítems entran a stock.
router.post('/produccion/cargas/:id/reintentar', authProduccion, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const out = await conReintento(async () => {
      const db = await getDb();
      const doc = await db.collection('costos_produccion_diaria').findOne({ _id: id, orgId: req.orgId });
      if (!doc) throw err(404, 'Carga no encontrada');
      const deposito = await depositoProduccion(db, req.orgId);
      if (!deposito) throw err(400, 'No existe el depósito Junín. Crealo en Stock con ese nombre: toda la producción entra ahí.');
      const items = doc.items || [];
      const aplicar = [];
      const faltan = [];
      const nuevos = [];
      for (const it of items) {
        if (it.unidadConvertida !== 'paquete') { nuevos.push(it); continue; }
        // Producto actual: por id; si no, por SKU o nombre (puede haber una copia con el rendimiento cargado).
        const cand = await db.collection('costos_productos').find({ orgId: req.orgId, activo: { $ne: false }, $or: [{ _id: it.productoId }].concat(it.sku ? [{ sku: it.sku }] : [{ nombre: it.nombre }]) }).toArray();
        const prod = cand.find(c => rendimientoEfectivo(c)) || null;
        if (!prod) {
          const base = cand[0];
          faltan.push(`"${it.nombre}"${base && base.unidadesPorPaquete ? ` (tiene "Unidades por paquete" = ${base.unidadesPorPaquete}, pero falta "Rinde por paquete")` : ''}`);
          nuevos.push(it);
          continue;
        }
        const conv = convertirItemProduccion(prod, it.paquetes);
        nuevos.push(conv); aplicar.push(conv);
      }
      if (!aplicar.length && !faltan.length) throw err(400, 'Esta carga no tiene ítems pendientes de conversión.');
      if (!aplicar.length) throw err(400, 'Sigue sin rendimiento por paquete: ' + faltan.join(', ') + '. Cargalo en Costos (campo "Rinde por paquete") y reintentá.');
      await db.collection('costos_produccion_diaria').updateOne({ _id: id }, { $set: { items: nuevos, updatedAt: new Date() } });
      const res2 = await aplicarProduccionAStock(db, req, Object.assign({}, doc, { items: aplicar }), doc.fecha, deposito);
      return Object.assign(res2, { siguenSinRendimiento: faltan });
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ingresa a Stock, de una sola vez, lo fabricado ese día — ver el comentario
// grande más arriba ("Conexión con Stock") para el porqué del diseño.
router.post('/produccion/:fecha/ingresar-stock', authProduccion, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de ingresar a stock.');
    const fecha = validarFecha(req.params.fecha);

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
      const deposito = await depositoProduccion(db, req.orgId);
      if (!deposito) throw err(400, 'No existe el depósito Junín. Crealo en Stock con ese nombre: toda la producción entra ahí.');
      const depositoId = deposito._id;

      return aplicarProduccionAStock(db, req, doc, fecha, deposito);
    });
    res.json(resultado);
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

const TIPOS_LISTA = ['porcentaje', 'monto', 'manual'];
// Lee y valida el "cómo se calcula" de una lista: % sobre el costo, $ fijo sobre el costo, o solo precios cargados a mano por artículo.
function leerCalculoLista(b, base) {
  const tipo = b.tipo === undefined ? (base && base.tipo) || 'porcentaje' : b.tipo;
  if (!TIPOS_LISTA.includes(tipo)) throw err(400, 'El tipo de lista tiene que ser porcentaje, monto fijo o manual.');
  const out = { tipo };
  if (tipo === 'porcentaje') {
    const pct = b.porcentaje === undefined && base ? base.porcentaje : Number(b.porcentaje);
    if (!Number.isFinite(pct)) throw err(400, 'El porcentaje tiene que ser un número (puede ser 0)');
    out.porcentaje = pct;
  } else if (tipo === 'monto') {
    const m = b.monto === undefined && base ? base.monto : Number(b.monto);
    if (!Number.isFinite(m)) throw err(400, 'El monto tiene que ser un número (puede ser 0)');
    out.monto = m; out.porcentaje = 0;
  } else { out.porcentaje = 0; }
  return out;
}

router.post('/listas-precio', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear una lista de precio.');
    const b = req.body || {};
    if (!b.nombre || !String(b.nombre).trim()) throw err(400, 'Falta el nombre de la lista (ej: Mayorista, Consumidor final)');
    const calculo = leerCalculoLista(b, null);
    const ahora = new Date();
    const doc = Object.assign({
      nombre: String(b.nombre).trim(),
      activa: true,
      sincronizar: b.sincronizar !== false,
      listaProductosId: b.listaProductosId ? toObjectId(b.listaProductosId) : null,
      precios: [],
      orgId: req.orgId,
      createdAt: ahora,
      updatedAt: ahora
    }, calculo);
    const r = await conReintento(async () => (await getDb()).collection('costos_listas_precio').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/listas-precio/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('costos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Lista de precio no encontrada');
      const set = Object.assign({ updatedAt: new Date() }, leerCalculoLista(b, actual));
      if (b.nombre !== undefined) {
        if (!String(b.nombre).trim()) throw err(400, 'La lista necesita un nombre');
        set.nombre = String(b.nombre).trim();
      }
      if (b.activa !== undefined) set.activa = !!b.activa;
      if (b.sincronizar !== undefined) set.sincronizar = !!b.sincronizar;
      if (b.listaProductosId !== undefined) set.listaProductosId = b.listaProductosId ? toObjectId(b.listaProductosId) : null;
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

const r2c = n => Math.round((Number(n) || 0) * 100) / 100;
// Precio de un producto en una lista de Producción: el precio cargado a mano para ese artículo, o si no el que sale del costo
// (% o $ fijo sobre el costo). En una lista "manual" sin precio cargado para el artículo, el precio queda vacío (null).
function precioDeLista(lista, producto, costoTotal) {
  const ov = (lista.precios || []).find(x => String(x.productoId) === String(producto._id));
  if (ov) {
    // Celda propia del artículo: un % sobre su costo, o un precio en $ (las cargas viejas son solo precio).
    if (ov.modo === 'porcentaje' && Number.isFinite(Number(ov.valor))) return { precio: costoTotal * (1 + Number(ov.valor) / 100), manual: true };
    const v = ov.modo === 'precio' ? ov.valor : ov.precio;
    if (Number.isFinite(Number(v))) return { precio: Number(v), manual: true };
  }
  if (lista.tipo === 'manual') return { precio: null, manual: false };
  if (lista.tipo === 'monto') return { precio: costoTotal + (Number(lista.monto) || 0), manual: false };
  return { precio: costoTotal * (1 + (Number(lista.porcentaje) || 0) / 100), manual: false };
}

// ---------------------------------------------------------------------
// Vínculo Producción <-> Productos (29/10/2026, pedido de Mato: "la lista de producción quiero que esté vinculada con la ficha
// de los productos, tanto el costo como el precio de venta mayorista, venta público y venta colocado... listamos todo en el
// módulo de producción donde tenemos todo concentrado").
//   - Las listas de Producción mandan sus precios a las listas de Productos (preciosPorLista de cada ficha vinculada; si la lista
//     de Productos es Consumidor Final también `precio`). Cada lista de Producción se vincula con una lista de Productos
//     (listaProductosId; si no tiene, se busca por nombre o se crea).
//   - El costo de la ficha (`costo`, en pesos) se mantiene igual al costo de receta.
//   - Se ejecuta solo (con una pequeña demora) después de cualquier cambio en insumos, recetas o listas, y a pedido con el
//     botón "Sincronizar con Productos". Solo escribe lo que cambió.
//   - Solo toca fichas vinculadas a un producto de Producción (costoProductoId).
// ---------------------------------------------------------------------
async function sincronizarListasConProductos(db, req) {
  const out = { productos: 0, costos: 0, precios: 0, listasCreadas: 0, sinFicha: 0 };
  const cfg = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'produccionSincronizaCosto' });
  const sincCosto = !cfg || cfg.valor !== false;
  const cps = await db.collection('costos_productos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).toArray();
  if (!cps.length) return out;
  const insumosPorId = await traerInsumosDeProductos(db, req, cps);
  const fichas = await db.collection('productos_catalogo').find(Object.assign({ costoProductoId: { $in: cps.map(c => c._id) }, activo: { $ne: false } }, filtroOrg(req))).toArray();
  const fichaDe = new Map(); fichas.forEach(f => fichaDe.set(String(f.costoProductoId), f));
  out.sinFicha = cps.filter(c => !fichaDe.has(String(c._id))).length;
  const costoDe = new Map(cps.map(c => [String(c._id), calcularCostoProducto(c, insumosPorId).costoTotal]));

  const listas = await db.collection('costos_listas_precio').find(Object.assign({ activa: { $ne: false }, sincronizar: { $ne: false } }, filtroOrg(req))).toArray();
  const lp = db.collection('productos_listas_precio');
  const destinos = [];
  for (const l of listas) {
    let dest = l.listaProductosId ? await lp.findOne({ _id: l.listaProductosId }) : null;
    if (!dest) {
      const esc = String(l.nombre).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      dest = await lp.findOne(Object.assign({ nombre: new RegExp('^\\s*' + esc + '\\s*$', 'i') }, filtroOrg(req)));
      if (!dest) {
        const ahora = new Date();
        const nueva = { nombre: String(l.nombre).trim(), porcentaje: 0, predeterminada: false, activa: true, alcance: 'seleccion', formula: 'costo_porcentaje', productosIds: [], incluyeIva: null, orden: 100, origen: 'produccion', orgId: req.orgId, createdAt: ahora, updatedAt: ahora };
        const r = await lp.insertOne(nueva); dest = Object.assign({ _id: r.insertedId }, nueva); out.listasCreadas++;
      }
      await db.collection('costos_listas_precio').updateOne({ _id: l._id }, { $set: { listaProductosId: dest._id } });
    }
    destinos.push({ lista: l, dest });
  }

  const ahora = new Date();
  for (const f of fichas) {
    const cp = cps.find(c => String(c._id) === String(f.costoProductoId)); if (!cp) continue;
    const costo = r2c(costoDe.get(String(cp._id)));
    const set = {};
    if (sincCosto && (f.costo == null || Math.abs(Number(f.costo) - costo) > 0.005 || f.moneda === 'USD')) { set.costo = costo; set.moneda = 'ARS'; out.costos++; }
    let precios = Array.isArray(f.preciosPorLista) ? f.preciosPorLista.slice() : [];
    let cambioPrecios = false;
    for (const { lista, dest } of destinos) {
      const { precio } = precioDeLista(lista, cp, costoDe.get(String(cp._id)));
      if (precio == null) continue; // lista manual sin precio para este artículo: no se toca lo que haya en Productos
      const nuevo = r2c(precio);
      const idx = precios.findIndex(x => String(x.listaId) === String(dest._id));
      if (idx < 0 || Math.abs(Number(precios[idx].precio) - nuevo) > 0.005) {
        if (idx >= 0) precios[idx] = { listaId: dest._id, precio: nuevo }; else precios.push({ listaId: dest._id, precio: nuevo });
        cambioPrecios = true; out.precios++;
      }
      if (dest.predeterminada && (f.precio == null || Math.abs(Number(f.precio) - nuevo) > 0.005)) set.precio = nuevo;
      if (dest.alcance === 'seleccion' && !(dest.productosIds || []).some(x => String(x) === String(f._id))) {
        await lp.updateOne({ _id: dest._id }, { $addToSet: { productosIds: f._id } });
        dest.productosIds = (dest.productosIds || []).concat([f._id]);
      }
    }
    if (cambioPrecios) set.preciosPorLista = precios;
    if (Object.keys(set).length) { set.updatedAt = ahora; await db.collection('productos_catalogo').updateOne({ _id: f._id }, { $set: set }); }
    out.productos++;
  }
  return out;
}

// Sincroniza solo después de cambios en insumos, recetas o listas (una vez por ráfaga de cambios).
const syncPendiente = new Map();
function programarSincronizacion(req) {
  const k = String(req.orgId);
  if (syncPendiente.has(k)) clearTimeout(syncPendiente.get(k));
  syncPendiente.set(k, setTimeout(async () => {
    syncPendiente.delete(k);
    try { await conReintento(async () => sincronizarListasConProductos(await getDb(), req)); }
    catch (e) { console.error('sincronizarListasConProductos:', e.message); }
  }, 2500));
}
// Tabla de precios: todos los productos en filas y una columna por lista; cada celda es un % sobre el costo o un precio en $
// (vacía = se usa el cálculo general de la lista).
async function armarMatriz(req) {
  return conReintento(async () => {
    const db = await getDb();
    const [listas, cps] = await Promise.all([
      db.collection('costos_listas_precio').find(Object.assign({ activa: { $ne: false } }, filtroOrg(req))).sort({ nombre: 1 }).toArray(),
      db.collection('costos_productos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).sort({ nombre: 1 }).toArray()
    ]);
    const insumosPorId = await traerInsumosDeProductos(db, req, cps);
    const productos = cps.map(p => {
      const costo = calcularCostoProducto(p, insumosPorId).costoTotal;
      const celdas = {};
      listas.forEach(l => {
        const ov = (l.precios || []).find(x => String(x.productoId) === String(p._id));
        const { precio } = precioDeLista(l, p, costo);
        celdas[String(l._id)] = { modo: ov ? (ov.modo === 'porcentaje' ? 'porcentaje' : 'precio') : '', valor: ov ? (ov.modo === 'porcentaje' ? ov.valor : (ov.modo === 'precio' ? ov.valor : ov.precio)) : null, precio };
      });
      return { productoId: String(p._id), nombre: p.nombre, sku: p.sku || '', rubro: p.rubroLista || '', costo, celdas };
    });
    return { listas: listas.map(l => ({ _id: String(l._id), nombre: l.nombre, tipo: l.tipo || 'porcentaje', porcentaje: l.porcentaje || 0, monto: l.monto || 0 })), productos };
  });
}
router.get('/matriz-listas', authAdmin, async (req, res) => {
  try { res.json(await armarMatriz(req)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// PDF imprimible con las listas elegidas (?listas=id1,id2): una columna de precios por lista, sin costos internos.
router.get('/matriz-listas/pdf', authAdmin, async (req, res) => {
  try {
    const m = await armarMatriz(req);
    const ids = String(req.query.listas || '').split(',').filter(Boolean);
    const listas = m.listas.filter(l => ids.includes(l._id));
    if (!listas.length) throw err(400, 'Elegí al menos una lista.');
    const productos = m.productos.filter(p => listas.some(l => p.celdas[l._id].precio != null));
    const horizontal = listas.length > 3;
    const pdf = new PDFDocument({ margin: 40, size: 'A4', layout: horizontal ? 'landscape' : 'portrait' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="lista-de-precios.pdf"');
    pdf.pipe(res);
    const L = 40, R = pdf.page.width - 40, anchoTot = R - L;
    const wPrecio = Math.min(110, Math.floor((anchoTot * 0.6) / listas.length));
    const xPrecio0 = R - wPrecio * listas.length, wProd = xPrecio0 - L - 8;
    const fecha = new Date().toLocaleDateString('es-AR');
    const fondo = () => pdf.page.height - pdf.page.margins.bottom;
    const encabezado = () => {
      dibujarMarcaCostos(pdf);
      pdf.fontSize(16).fillColor('#000').text('Lista de precios', L, pdf.y, { align: 'left' });
      pdf.moveDown(0.2); pdf.fontSize(10).fillColor('#555').text('Fecha: ' + fecha); pdf.fillColor('#000'); pdf.moveDown(0.6);
      const y0 = pdf.y; pdf.fontSize(9).fillColor('#555');
      pdf.text('Producto', L, y0, { width: wProd });
      listas.forEach((l, i) => pdf.text(l.nombre, xPrecio0 + i * wPrecio, y0, { width: wPrecio - 4, align: 'right' }));
      pdf.fillColor('#000'); pdf.y = y0 + 16;
      pdf.moveTo(L, pdf.y).lineTo(R, pdf.y).strokeColor('#ddd').stroke(); pdf.moveDown(0.3);
    };
    encabezado();
    const porRubros = req.query.rubros !== '0' && productos.some(p => p.rubro);
    const grupos = [];
    if (porRubros) {
      const mapa = new Map();
      productos.forEach(p => { const k = p.rubro || ''; if (!mapa.has(k)) mapa.set(k, []); mapa.get(k).push(p); });
      [...mapa.keys()].filter(k => k).sort((a, b) => a.localeCompare(b, 'es')).forEach(k => grupos.push({ titulo: k, items: mapa.get(k) }));
      if (mapa.has('')) grupos.push({ titulo: 'Otros', items: mapa.get('') });
    } else grupos.push({ titulo: '', items: productos });
    grupos.forEach(g => {
      if (g.titulo) {
        if (pdf.y + 50 > fondo()) { pdf.addPage(); encabezado(); }
        pdf.moveDown(0.5);
        const yt = pdf.y;
        pdf.rect(L, yt - 2, anchoTot, 16).fill('#f0eeea'); pdf.fillColor('#000').fontSize(10).font('Helvetica-Bold').text(g.titulo.toUpperCase(), L + 4, yt + 1, { width: anchoTot - 8 }); pdf.font('Helvetica');
        pdf.y = yt + 18;
      }
      g.items.forEach(p => {
        pdf.fontSize(10);
        const alto = Math.max(16, pdf.heightOfString(p.nombre, { width: wProd }) + 4);
        if (pdf.y + alto > fondo()) { pdf.addPage(); encabezado(); }
        const y0 = pdf.y;
        pdf.fontSize(10).fillColor('#000').text(p.nombre, L, y0, { width: wProd });
        listas.forEach((l, i) => { const pr = p.celdas[l._id].precio; pdf.text(pr == null ? '—' : moneyPdfCostos(pr), xPrecio0 + i * wPrecio, y0, { width: wPrecio - 4, align: 'right' }); });
        pdf.y = y0 + alto;
      });
    });
    pdf.moveDown(0.8); pdf.fontSize(9).fillColor('#777').text(LEYENDA_LISTA_PRECIO, L, pdf.y, { width: anchoTot });
    pdf.end();
  } catch (e) { if (!res.headersSent) res.status(e.status || 500).json({ error: e.message }); }
});
router.put('/matriz-listas', authAdmin, async (req, res) => {
  try {
    const cambios = Array.isArray((req.body || {}).cambios) ? req.body.cambios : [];
    const rubros = Array.isArray((req.body || {}).rubros) ? req.body.rubros : [];
    if (!cambios.length && !rubros.length) throw err(400, 'No hay cambios para guardar.');
    if (rubros.length) {
      // Rubro solo para ordenar/dividir la lista impresa (no cambia nada en Productos).
      await conReintento(async () => {
        const col = (await getDb()).collection('costos_productos');
        for (const r of rubros) {
          const pid = toObjectId(r.productoId); if (!pid) continue;
          const nombre = String(r.rubro || '').trim().slice(0, 60);
          await col.updateOne(Object.assign({ _id: pid }, filtroOrg(req)), nombre ? { $set: { rubroLista: nombre } } : { $unset: { rubroLista: '' } });
        }
      });
    }
    if (cambios.length > 20000) throw err(400, 'Demasiados cambios juntos.');
    let guardados = 0;
    await conReintento(async () => {
      const db = await getDb(); const col = db.collection('costos_listas_precio');
      const porLista = new Map();
      cambios.forEach(c => { const lid = String(c.listaId); if (!porLista.has(lid)) porLista.set(lid, []); porLista.get(lid).push(c); });
      guardados = 0;
      for (const [lid, lst] of porLista) {
        const lista = await col.findOne(Object.assign({ _id: toObjectId(lid) }, filtroOrg(req)));
        if (!lista) throw err(404, 'Una de las listas ya no existe.');
        let precios = (lista.precios || []).slice();
        for (const c of lst) {
          const pid = toObjectId(c.productoId); if (!pid) continue;
          precios = precios.filter(x => String(x.productoId) !== String(pid));
          const vacio = c.valor === null || c.valor === undefined || c.valor === '';
          if (!vacio) {
            const v = Number(c.valor);
            if (!Number.isFinite(v) || v < 0 && c.modo !== 'porcentaje') throw err(400, 'Hay un valor que no es un número válido.');
            if (c.modo === 'porcentaje') precios.push({ productoId: pid, modo: 'porcentaje', valor: v });
            else precios.push({ productoId: pid, modo: 'precio', valor: r2c(v), precio: r2c(v) });
          }
          guardados++;
        }
        await col.updateOne({ _id: lista._id }, { $set: { precios, updatedAt: new Date() } });
      }
    });
    res.json({ ok: true, guardados });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// A pedido: "Sincronizar con Productos".
router.post('/listas-precio/sincronizar-productos', authAdmin, async (req, res) => {
  try {
    const out = await conReintento(async () => sincronizarListasConProductos(await getDb(), req));
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Fija o quita (precio:null) el precio cargado a mano de un artículo en una lista de Producción.
router.put('/listas-precio/:id/precio/:productoId', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id), productoId = toObjectId(req.params.productoId);
    if (!id || !productoId) throw err(400, 'id inválido');
    const b = (req.body || {}).precio;
    const precio = (b === null || b === undefined || b === '') ? null : Number(b);
    if (precio !== null && (!Number.isFinite(precio) || precio < 0)) throw err(400, 'El precio tiene que ser un número mayor o igual a 0');
    await conReintento(async () => {
      const db = await getDb();
      const col = db.collection('costos_listas_precio');
      const lista = await col.findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!lista) throw err(404, 'Lista de precio no encontrada');
      await col.updateOne({ _id: id }, { $pull: { precios: { productoId } } });
      if (precio !== null) await col.updateOne({ _id: id }, { $push: { precios: { productoId, precio: r2c(precio) } }, $set: { updatedAt: new Date() } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Costo de la ficha igual al de receta (sí/no).
router.get('/config-listas', authAdmin, async (req, res) => {
  try {
    const d = await conReintento(async () => (await getDb()).collection('config_general').findOne({ orgId: req.orgId, clave: 'produccionSincronizaCosto' }));
    res.json({ sincronizaCosto: !d || d.valor !== false });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put('/config-listas', authAdmin, async (req, res) => {
  try {
    const v = (req.body || {}).sincronizaCosto !== false;
    await conReintento(async () => (await getDb()).collection('config_general').updateOne({ orgId: req.orgId, clave: 'produccionSincronizaCosto' },
      { $set: { valor: v, updatedAt: new Date() }, $setOnInsert: { orgId: req.orgId, clave: 'produccionSincronizaCosto', createdAt: new Date() } }, { upsert: true }));
    res.json({ sincronizaCosto: v });
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
    const { precio, manual } = precioDeLista(lista, p, costoTotal);
    return {
      productoId: p._id,
      nombre: p.nombre,
      sku: p.sku || '',
      tipoCosteo: p.tipoCosteo,
      costoActual: costoTotal,
      precio,
      manual,
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
    const { lista, productos: todosProd } = await obtenerDetalleLista(req, id);
    const productos = todosProd.filter(p => p.precio != null);

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
    const { lista, productos: todosProd } = await obtenerDetalleLista(req, id);
    const productos = todosProd.filter(p => p.precio != null);

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
