// ---------------------------------------------------------------------------
// Productos — catálogo maestro de productos del negocio (paso 1 de migrar
// todo lo que hoy se lleva en Dux a este sistema, decisión con Mato,
// 28/9/2026). Es la base de la que van a colgar Ventas, Stock, Compras y
// Facturación más adelante — ver roadmap-modulos.md.
//
// Decisión con Mato (28/9/2026, 2da vuelta): el SKU pasa a ser
// OBLIGATORIO (antes era opcional) — es el CÓDIGO de Dux, y sin él no hay
// forma de migrar un producto 1 a 1. Además, los campos del catálogo se
// alinean a propósito con los mismos campos que usa Dux al crear un
// producto (ver "¿Cómo crear productos/servicios de manera manual?" en la
// ayuda de Dux), así una migración real es más directa: se cargan los
// mismos datos, y de ahí en más se sacan o agregan campos según haga
// falta — no al revés (inventar campos propios y despues tener que
// traducirlos a los de Dux al migrar).
//
// Campos alineados con Dux (nombre acá → concepto en Dux):
//   sku → Código*, nombre → Producto*, disponiblePara → Disponible para*,
//   porcentajeIva → Porcentaje IVA*, tipoUnidad → Tipo de unidad*,
//   rubro → Rubro, subrubro → Subrubro, marca → Marca,
//   codigoBarra → Código de barra, moneda → Moneda, costo → Costo,
//   impuestoInterno → Impuesto interno, precio → Precios de Venta
//   (simplificado a un solo precio por ahora, Dux permite varias listas),
//   stockeable/aceptaStockNegativo/trazable/utilizaVariantes → checkboxes
//   homónimos, tipoProducto → Tipo de producto (Simple/Combo/De
//   producción — "De producción" es justo lo que ya vincula
//   `costoProductoId` con Costos de Producción), codigoExterno → Código
//   externo (código del proveedor), proveedor → PROVEEDOR (texto libre
//   por ahora, sin módulo de Proveedores todavía), fechaVencimiento →
//   Fecha de vencimiento, indicaCtdBultos/unidadesPorBulto → Indica Ctd.
//   Bultos / Ctd. Unidades por Bulto, embalaje → Mostrar Embalaje,
//   descripcion → Descripción.
//
// V1 — a propósito afuera de esta primera versión (se suma después, sin
// romper lo de acá):
//   - Sin atributos/variantes (talle, color) — Mato decidió (29/9/2026)
//     que esto no hace falta, Piedra Negra no vende por talle/color, así
//     que esto queda descartado (no solo pospuesto). `utilizaVariantes`
//     sigue existiendo como flag por si algún día hiciera falta, pero no
//     se va a construir el sub-esquema de variantes.
//   - Sin "otros costos" (necesitan configuración previa en Dux).
//   - Sin listas de precio propias (a diferencia de Costos de
//     Producción) — un solo precio de venta por producto por ahora.
//
// Actualización (30/9/2026, prerrequisito para Compras): se suma
// `proveedorId` (vínculo real con la colección `proveedores`), que
// convive con el viejo campo `proveedor` (texto libre, se deja para no
// romper productos ya cargados sin proveedor vinculado — Dux en su ficha
// real solo tiene un campo de texto "PROVEEDOR", este `proveedorId` es
// una mejora propia para que Compras pueda autocompletar). Se expone
// `GET /proveedores-lite` (bajo el mismo gate de Productos, no el de
// Proveedores) para que el formulario de producto pueda armar el
// desplegable sin exigir también el módulo 'proveedores'.
//
// Actualización (29/9/2026, módulo Stock): se suman `cantidadMinima` y
// `stockIdeal` — son campos que Dux ya trae en la ficha de producto y que
// se habían dejado afuera a propósito en la v1 porque son del dominio de
// Stock. Quedan acá (a nivel producto, no por depósito — simplificación
// de v1, ver stock.js) para poder marcar "bajo mínimo" en la vista de
// Stock actual sin duplicar el concepto en otra colección.
//
// Relación con costos_productos (Costos de Producción, módulo 'costos'):
// SON DOS COSAS DISTINTAS a propósito. costos_productos es el costeo
// interno de lo que se FABRICA (receta de insumos, costo calculado). Este
// módulo (`productos_catalogo`) es el catálogo de TODO lo que se vende o
// compra — productos fabricados (que pueden opcionalmente enlazar a su
// costos_productos vía `costoProductoId`, para más adelante poder mostrar
// margen) y productos de reventa que nunca tienen receta propia. No se
// fusionan las dos colecciones: costos_productos sigue existiendo tal cual,
// este es un catálogo nuevo y más amplio por encima.
//
// Colección (en la misma base `calculadora_m2`):
//   productos_catalogo : { sku, nombre, disponiblePara, porcentajeIva,
//     tipoUnidad, unidad, rubro, subrubro, marca, codigoBarra, moneda,
//     costo, impuestoInterno, precio, stockeable, aceptaStockNegativo,
//     trazable, utilizaVariantes, tipoProducto, costoProductoId,
//     codigoExterno, proveedor, proveedorId, fechaVencimiento,
//     indicaCtdBultos, unidadesPorBulto, embalaje, descripcion, notas,
//     cantidadMinima, stockIdeal, activo, orgId, createdAt, updatedAt }
//
// Módulo con clave propia ('productos'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const productosRouter = require('./productos');
//   app.use('/api/productos', productosRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, tieneModulo } = require('./usuarios');
const { exportarXlsx, exportarPlantillaXlsx, parsearXlsxBase64, leerEncabezadosXlsxBase64, sugerirMapeo } = require('./importExport');
// Para mostrar en la ficha de producto el link y las fotos de Tiendanube
// (30/9/2026, pedido de Mato) — ver buscarProductoTiendanubePorSku en
// cotizador.js.
const { buscarProductoTiendanubePorSku, sincronizarPreciosTiendanube, obtenerPreciosTiendanubePorSku } = require('./cotizador');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
// Índices (1/10/2026, pedido de Mato: "que ande más fluido... tarda
// mucho cuando tiene que cargar las bases e ir a buscar un producto").
// El catálogo real tiene ~20.000 productos (el export de Dux) y nunca se
// habían creado índices: cada búsqueda (por nombre/SKU, por rubro, por
// marca) y cada distinct() de /rubros y /marcas recorría la colección
// entera. createIndex es no-op si el índice ya existe, así que es seguro
// llamarlo en cada arranque; se dispara una sola vez por proceso (recién
// conectado), no en cada request.
let indicesListos = false;
async function asegurarIndices(db) {
  if (indicesListos) return;
  indicesListos = true;
  try {
    const col = db.collection('productos_catalogo');
    await Promise.all([
      col.createIndex({ orgId: 1, activo: 1, nombre: 1 }),
      col.createIndex({ orgId: 1, sku: 1 }),
      col.createIndex({ orgId: 1, activo: 1, rubro: 1 }),
      col.createIndex({ orgId: 1, activo: 1, marca: 1 }),
      col.createIndex({ orgId: 1, proveedorId: 1 })
    ]);
    await db.collection('productos_listas_precio').createIndex({ orgId: 1 });
    await db.collection('productos_import_jobs').createIndex({ orgId: 1, creadoEn: -1 });
  } catch (e) {
    indicesListos = false; // si falló, reintentar en la próxima conexión
    console.error('No se pudieron crear los índices de productos:', e.message);
  }
}
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
  const db = mongoClient.db(DB_NAME);
  asegurarIndices(db).catch(() => {});
  return db;
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    mongoClient = null;
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const authAdmin = [authUsuario, resolverOrg, requiereModulo('productos')];

// Las listas de precio (30/9/2026, pedido de Mato) se LEEN también desde
// Ventas (para elegir qué lista aplica a una venta), así que el gate de
// lectura acepta 'productos' O 'ventas' — pero crear/editar/borrar listas
// y overrides de precio sigue exigiendo 'productos' (authAdmin), como
// cualquier otro dato maestro de este módulo.
function requiereModuloAlguno(...claves) {
  return (req, res, next) => {
    const ok = claves.some(k => tieneModulo(req.usuario, k));
    if (!ok) return res.status(403).json({ error: 'Tu usuario no tiene acceso a este módulo. Pedile a un administrador que te lo habilite.' });
    next();
  };
}
const authListasPrecio = [authUsuario, resolverOrg, requiereModuloAlguno('productos', 'ventas')];
// Solo para EL LISTADO (nombre + id, nada sensible) — se suma 'clientes'
// (3/10/2026, pedido de Mato: poder elegir una lista de precio por
// defecto en la ficha del cliente). Las operaciones más sensibles
// (exportar, importar, editar precios de una lista) siguen con
// authListasPrecio tal como estaba, sin abrirle nada nuevo a Clientes.
const authListasPrecioListado = [authUsuario, resolverOrg, requiereModuloAlguno('productos', 'ventas', 'clientes')];

const UNIDADES_VALIDAS = ['unidad', 'm2', 'ml', 'kg', 'litro', 'paquete', 'jornal'];
// "Tipo de unidad" de Dux — una categoría más amplia que la unidad de
// medida puntual (ej: tipoUnidad "superficie" + unidad "m2").
const TIPOS_UNIDAD_VALIDOS = ['unidad', 'peso', 'longitud', 'capacidad', 'superficie', 'tiempo', 'volumen'];
const DISPONIBLE_PARA_VALIDOS = ['ventas', 'compras', 'todos'];
const MONEDAS_VALIDAS = ['ARS', 'USD'];
const TIPOS_PRODUCTO_VALIDOS = ['simple', 'combo', 'produccion'];

// Columnas del Excel de import/export (30/9/2026, pedido de Mato: "todas
// las bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js para el formato de esta lista y cómo se usa.
//
// `aliases` (30/9/2026, 2da vuelta: Mato subió el archivo REAL que
// exporta Dux de productos) — Dux usa sus propios títulos de columna
// (ALGO DISTINTO a los nuestros, ej. "CODIGO" en vez de "SKU (Código)"),
// así que cada columna que aparece en ese export lista también el título
// real de Dux como alias, para poder importar el archivo tal cual sale
// de Dux sin pedirle a Mato que edite encabezados a mano. Confirmado
// contra el archivo real (20.327 filas): Dux NO trae columna de precio de
// venta (maneja precios aparte, en listas de precio) — por eso `precio`
// sigue sin alias, va a quedar vacío en los productos importados de Dux
// y Mato lo tiene que completar o importar aparte.
const COLUMNAS_PRODUCTOS = [
  { clave: 'sku', titulo: 'SKU (Código)', aliases: ['Codigo'] },
  { clave: 'nombre', titulo: 'Nombre', aliases: ['Producto'] },
  { clave: 'rubro', titulo: 'Rubro' },
  { clave: 'subrubro', titulo: 'Subrubro', aliases: ['Sub Rubro'] },
  { clave: 'marca', titulo: 'Marca' },
  { clave: 'unidad', titulo: 'Unidad', aliases: ['Unidad Medida'] },
  { clave: 'tipoUnidad', titulo: 'Tipo de unidad', aliases: ['Tipo Unidad'] },
  { clave: 'disponiblePara', titulo: 'Disponible para' },
  { clave: 'tipoProducto', titulo: 'Tipo de producto' },
  {
    clave: 'moneda', titulo: 'Moneda',
    mapaValores: { PESOS: 'ARS', DOLARES: 'USD', ARS: 'ARS', USD: 'USD' }
  },
  { clave: 'precio', titulo: 'Precio', tipo: 'numero' },
  { clave: 'costo', titulo: 'Costo', tipo: 'numero' },
  { clave: 'porcentajeIva', titulo: 'IVA %', tipo: 'numero', aliases: ['Porcentaje Iva'] },
  { clave: 'impuestoInterno', titulo: 'Impuesto interno', tipo: 'numero' },
  { clave: 'codigoBarra', titulo: 'Código de barra', aliases: ['Cod Barra'] },
  { clave: 'codigoExterno', titulo: 'Código externo (proveedor)', aliases: ['Codigo Externo'] },
  { clave: 'proveedor', titulo: 'Proveedor' },
  { clave: 'unidadesPorBulto', titulo: 'Unidades por bulto', tipo: 'numero' },
  { clave: 'cantidadMinima', titulo: 'Cantidad mínima', tipo: 'numero' },
  { clave: 'stockIdeal', titulo: 'Stock ideal', tipo: 'numero' },
  { clave: 'stockeable', titulo: 'Stockeable', tipo: 'booleano' },
  { clave: 'aceptaStockNegativo', titulo: 'Acepta stock negativo', tipo: 'booleano' },
  { clave: 'trazable', titulo: 'Trazable', tipo: 'booleano' },
  { clave: 'indicaCtdBultos', titulo: 'Indica ctd. bultos', tipo: 'booleano', aliases: ['Indica Ctd Bultos'] },
  { clave: 'embalaje', titulo: 'Embalaje' },
  { clave: 'descripcion', titulo: 'Descripción' },
  { clave: 'fechaVencimiento', titulo: 'Fecha de vencimiento', tipo: 'fecha', aliases: ['Fecha Vencimiento'] },
  { clave: 'notas', titulo: 'Notas' }
];

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function normalizarBooleano(v) { return !!v; }

// .toUpperCase() acá (30/9/2026, bug detectado por Mato): antes el SKU se
// guardaba tal cual venía escrito, así que "fibra1" y "FIBRA1" quedaban
// como dos productos distintos — justo lo que pasó al importar el
// archivo de Dux (en mayúsculas) contra productos que Producción ya
// había sincronizado con otro casing. De acá en más el SKU siempre se
// guarda en MAYÚSCULAS (acá y en costos.js) para que la comparación sea
// consistente en todos lados.
function normalizarSku(v) {
  const s = normalizarTexto(v).toUpperCase();
  return s ? s : null;
}

function normalizarPrecioOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, `${etiqueta} tiene que ser un número mayor o igual a 0`);
  return n;
}

function normalizarEnum(v, opciones, etiqueta, porDefecto) {
  const s = normalizarTexto(v).toLowerCase();
  if (!s) return porDefecto;
  if (!opciones.includes(s)) throw err(400, `${etiqueta} inválido (opciones: ${opciones.join(', ')})`);
  return s;
}

// Corrección (30/9/2026, detectado al adaptar el import del export real de
// Dux): a diferencia de los demás enums de este módulo, MONEDAS_VALIDAS
// se guarda en MAYÚSCULAS ('ARS'/'USD') porque así la usan ventas.js y
// proveedores.js. Usar `normalizarEnum` acá (que compara en minúsculas)
// hacía que CUALQUIER valor de moneda no vacío fallara la validación
// siempre — es decir, romper el guardado de productos desde el
// formulario para cualquier producto, porque el <select> de moneda
// siempre manda un valor. Se resuelve con una función propia, igual al
// patrón ya usado en ventas.js.
function normalizarMoneda(v) {
  const s = normalizarTexto(v).toUpperCase() || 'ARS';
  if (!MONEDAS_VALIDAS.includes(s)) throw err(400, `Moneda inválida (opciones: ${MONEDAS_VALIDAS.join(', ')})`);
  return s;
}

function normalizarFechaOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw err(400, `${etiqueta} inválida`);
  return d;
}

async function validarSkuUnico(db, req, sku, idExcluir) {
  const match = Object.assign({ sku, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('productos_catalogo').findOne(match);
  if (existente) throw err(400, `Ya hay otro producto activo con el SKU "${sku}" (${existente.nombre}).`);
}

// Campos alineados con la ficha de producto de Dux — ver comentario de
// cabecera. El SKU (Código en Dux) es obligatorio: sin código no hay
// producto, ni forma de migrarlo 1 a 1.
function validarProducto(body) {
  const sku = normalizarSku(body.sku);
  if (!sku) throw err(400, 'El SKU (código) es obligatorio');
  const nombre = normalizarTexto(body.nombre);
  if (!nombre) throw err(400, 'El nombre es obligatorio');

  // .toLowerCase() acá (además de en UNIDADES_VALIDAS) para que un
  // import de Dux con "M2"/"KG"/"UNIDAD" en mayúsculas valide igual que
  // si viniera del formulario, que ya manda minúsculas.
  const unidad = normalizarTexto(body.unidad).toLowerCase() || 'unidad';
  if (!UNIDADES_VALIDAS.includes(unidad)) throw err(400, `Unidad inválida (opciones: ${UNIDADES_VALIDAS.join(', ')})`);
  const tipoUnidad = normalizarEnum(body.tipoUnidad, TIPOS_UNIDAD_VALIDOS, 'Tipo de unidad', 'unidad');
  const disponiblePara = normalizarEnum(body.disponiblePara, DISPONIBLE_PARA_VALIDOS, 'Disponible para', 'todos');
  const moneda = normalizarMoneda(body.moneda);
  const tipoProducto = normalizarEnum(body.tipoProducto, TIPOS_PRODUCTO_VALIDOS, 'Tipo de producto', 'simple');

  const rubro = normalizarTexto(body.rubro);
  const subrubro = normalizarTexto(body.subrubro);
  const marca = normalizarTexto(body.marca);
  const codigoBarra = normalizarTexto(body.codigoBarra);
  const codigoExterno = normalizarTexto(body.codigoExterno);
  const proveedor = normalizarTexto(body.proveedor);
  const proveedorId = body.proveedorId ? toObjectId(body.proveedorId) : null;
  if (body.proveedorId && !proveedorId) throw err(400, 'proveedorId inválido');
  const embalaje = normalizarTexto(body.embalaje);
  const descripcion = normalizarTexto(body.descripcion);
  const notas = normalizarTexto(body.notas);

  const precio = normalizarPrecioOpcional(body.precio, 'El precio');
  const costo = normalizarPrecioOpcional(body.costo, 'El costo');
  const porcentajeIva = normalizarPrecioOpcional(body.porcentajeIva, 'El porcentaje de IVA');
  const impuestoInterno = normalizarPrecioOpcional(body.impuestoInterno, 'El impuesto interno');
  const unidadesPorBulto = normalizarPrecioOpcional(body.unidadesPorBulto, 'Las unidades por bulto');
  const cantidadMinima = normalizarPrecioOpcional(body.cantidadMinima, 'La cantidad mínima');
  const stockIdeal = normalizarPrecioOpcional(body.stockIdeal, 'El stock ideal');

  const fechaVencimiento = normalizarFechaOpcional(body.fechaVencimiento, 'La fecha de vencimiento');

  const stockeable = normalizarBooleano(body.stockeable);
  const aceptaStockNegativo = normalizarBooleano(body.aceptaStockNegativo);
  const trazable = normalizarBooleano(body.trazable);
  const utilizaVariantes = normalizarBooleano(body.utilizaVariantes);
  const indicaCtdBultos = normalizarBooleano(body.indicaCtdBultos);

  const costoProductoId = body.costoProductoId ? toObjectId(body.costoProductoId) : null;
  if (body.costoProductoId && !costoProductoId) throw err(400, 'costoProductoId inválido');

  return {
    sku, nombre, unidad, tipoUnidad, disponiblePara, moneda, tipoProducto,
    rubro, subrubro, marca, codigoBarra, codigoExterno, proveedor, proveedorId, embalaje, descripcion, notas,
    precio, costo, porcentajeIva, impuestoInterno, unidadesPorBulto, fechaVencimiento,
    stockeable, aceptaStockNegativo, trazable, utilizaVariantes, indicaCtdBultos,
    costoProductoId, cantidadMinima, stockIdeal
  };
}

// GET /rubros — lista de rubros ya usados, para el filtro y el autocomplete
// del formulario (no es una tabla separada, se calcula de los productos
// existentes: no hay necesidad de una entidad "Rubro" propia todavía).
router.get('/rubros', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false }, rubro: { $nin: [null, ''] } }, filtroOrg(req));
    const rubros = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo').distinct('rubro', match);
    });
    res.json(rubros.sort((a, b) => a.localeCompare(b, 'es')));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// GET /marcas — igual que /rubros pero de marca, para el filtro (30/9/2026,
// pedido de Mato: poder filtrar por rubro, marca y proveedor).
router.get('/marcas', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false }, marca: { $nin: [null, ''] } }, filtroOrg(req));
    const marcas = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo').distinct('marca', match);
    });
    res.json(marcas.sort((a, b) => a.localeCompare(b, 'es')));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Base de Rubros y Subrubros (1/10/2026, pedido de Mato: que en
// Configuración se puedan dar de alta "distintas bases" — se arranca con
// ésta — para que rubro/subrubro dejen de ser texto libre en la ficha de
// producto y pasen a elegirse de una lista, así se evita que el mismo
// rubro quede duplicado por tipeo ("Revestimientos" vs "revestimiento").
//
// El producto SIGUE guardando `rubro`/`subrubro` como texto (no se tocan
// los filtros, el export ni los reportes que ya dependen de eso) — lo que
// cambia es de dónde sale ese texto: antes se tipeaba a mano, ahora se
// elige de `productos_rubros_base` / `productos_subrubros_base`. Si se
// renombra un rubro/subrubro acá, se actualiza en cascada en los
// productos que ya lo tenían cargado, para que no quede desincronizado.
//
// Subrubro cuelga de un rubro (rubroId) porque así es como se usa en la
// práctica (ej: Revestimientos > Piedra, Pisos > Cerámica) — no son dos
// listas sueltas sin relación.
// -----------------------------------------------------------------------

router.get('/config/rubros', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.incluirInactivos !== '1') match.activo = { $ne: false };
    const rubros = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_rubros_base').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(rubros);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/config/rubros', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const nombre = normalizarTexto(req.body.nombre);
    if (!nombre) throw err(400, 'El nombre del rubro es obligatorio');
    const db = await conReintento(getDb);
    const dupMatch = Object.assign(
      { nombre: new RegExp('^' + nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') },
      filtroOrg(req)
    );
    const existente = await db.collection('productos_rubros_base').findOne(dupMatch);
    if (existente) throw err(400, 'Ya existe un rubro con ese nombre');
    const ahora = new Date();
    const doc = { nombre, activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora };
    const r = await db.collection('productos_rubros_base').insertOne(doc);
    res.json(Object.assign({ _id: r.insertedId }, doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config/rubros/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'Id inválido');
    const db = await conReintento(getDb);
    const match = Object.assign({ _id: id }, filtroOrg(req));
    const rubro = await db.collection('productos_rubros_base').findOne(match);
    if (!rubro) throw err(404, 'No encontrado');
    const update = { updatedAt: new Date() };
    if (req.body.nombre !== undefined) {
      const nombre = normalizarTexto(req.body.nombre);
      if (!nombre) throw err(400, 'El nombre no puede quedar vacío');
      update.nombre = nombre;
    }
    if (req.body.activo !== undefined) update.activo = !!req.body.activo;
    await db.collection('productos_rubros_base').updateOne(match, { $set: update });
    // Si se le cambió el nombre, se actualiza en cascada en los productos
    // y subrubros que ya lo tenían cargado con el nombre viejo.
    if (update.nombre && update.nombre !== rubro.nombre) {
      await db.collection('productos_catalogo').updateMany(
        Object.assign({ rubro: rubro.nombre }, filtroOrg(req)),
        { $set: { rubro: update.nombre, updatedAt: new Date() } }
      );
      await db.collection('productos_subrubros_base').updateMany(
        Object.assign({ rubroId: id }, filtroOrg(req)),
        { $set: { rubroNombre: update.nombre, updatedAt: new Date() } }
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// No se borra nunca de verdad (soft delete) — así no se pierde el dato en
// productos que ya lo tengan cargado, y no revienta nada si algo todavía
// lo referencia; simplemente deja de aparecer para elegir en productos nuevos.
router.delete('/config/rubros/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'Id inválido');
    const db = await conReintento(getDb);
    const match = Object.assign({ _id: id }, filtroOrg(req));
    const r = await db.collection('productos_rubros_base').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
    if (!r.matchedCount) throw err(404, 'No encontrado');
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/config/subrubros', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.incluirInactivos !== '1') match.activo = { $ne: false };
    if (req.query.rubroId) {
      const rid = toObjectId(req.query.rubroId);
      if (rid) match.rubroId = rid;
    }
    const subrubros = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_subrubros_base').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(subrubros);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/config/subrubros', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const nombre = normalizarTexto(req.body.nombre);
    if (!nombre) throw err(400, 'El nombre del subrubro es obligatorio');
    const rubroId = toObjectId(req.body.rubroId);
    if (!rubroId) throw err(400, 'Elegí a qué rubro pertenece');
    const db = await conReintento(getDb);
    const rubro = await db.collection('productos_rubros_base').findOne(Object.assign({ _id: rubroId }, filtroOrg(req)));
    if (!rubro) throw err(400, 'El rubro elegido no existe');
    const dupMatch = Object.assign(
      { rubroId, nombre: new RegExp('^' + nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') },
      filtroOrg(req)
    );
    const existente = await db.collection('productos_subrubros_base').findOne(dupMatch);
    if (existente) throw err(400, 'Ese rubro ya tiene un subrubro con ese nombre');
    const ahora = new Date();
    const doc = { nombre, rubroId, rubroNombre: rubro.nombre, activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora };
    const r = await db.collection('productos_subrubros_base').insertOne(doc);
    res.json(Object.assign({ _id: r.insertedId }, doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config/subrubros/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'Id inválido');
    const db = await conReintento(getDb);
    const match = Object.assign({ _id: id }, filtroOrg(req));
    const subrubro = await db.collection('productos_subrubros_base').findOne(match);
    if (!subrubro) throw err(404, 'No encontrado');
    const update = { updatedAt: new Date() };
    if (req.body.nombre !== undefined) {
      const nombre = normalizarTexto(req.body.nombre);
      if (!nombre) throw err(400, 'El nombre no puede quedar vacío');
      update.nombre = nombre;
    }
    if (req.body.activo !== undefined) update.activo = !!req.body.activo;
    await db.collection('productos_subrubros_base').updateOne(match, { $set: update });
    if (update.nombre && update.nombre !== subrubro.nombre) {
      await db.collection('productos_catalogo').updateMany(
        Object.assign({ rubro: subrubro.rubroNombre, subrubro: subrubro.nombre }, filtroOrg(req)),
        { $set: { subrubro: update.nombre, updatedAt: new Date() } }
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/config/subrubros/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'Id inválido');
    const db = await conReintento(getDb);
    const match = Object.assign({ _id: id }, filtroOrg(req));
    const r = await db.collection('productos_subrubros_base').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
    if (!r.matchedCount) throw err(404, 'No encontrado');
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Carga inicial de la base (1/10/2026): escanea los productos ya cargados
// y crea en la base cualquier rubro/subrubro que todavía no esté — así
// Mato no tiene que volver a tipear a mano lo que ya estaba en uso. Se
// puede correr más de una vez sin duplicar (salta lo que ya existe).
router.post('/config/rubros/importar-existentes', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await conReintento(getDb);
    const matchProd = Object.assign({}, filtroOrg(req));
    const productos = await db.collection('productos_catalogo')
      .find(matchProd, { projection: { rubro: 1, subrubro: 1 } }).toArray();

    const rubrosEncontrados = new Map(); // key minúscula -> nombre original
    const subrubrosPorRubro = new Map(); // key rubro -> Map(key sub -> nombre original)
    productos.forEach(p => {
      const rubro = normalizarTexto(p.rubro);
      if (!rubro) return;
      const rubroKey = rubro.toLowerCase();
      if (!rubrosEncontrados.has(rubroKey)) rubrosEncontrados.set(rubroKey, rubro);
      const subrubro = normalizarTexto(p.subrubro);
      if (!subrubro) return;
      if (!subrubrosPorRubro.has(rubroKey)) subrubrosPorRubro.set(rubroKey, new Map());
      const subMap = subrubrosPorRubro.get(rubroKey);
      if (!subMap.has(subrubro.toLowerCase())) subMap.set(subrubro.toLowerCase(), subrubro);
    });

    const existentesRubros = await db.collection('productos_rubros_base').find(filtroOrg(req)).toArray();
    const rubrosPorKey = new Map(existentesRubros.map(r => [r.nombre.toLowerCase(), r]));
    const ahora = new Date();
    let rubrosCreados = 0, subrubrosCreados = 0;

    for (const [rubroKey, nombreRubro] of rubrosEncontrados) {
      let rubroDoc = rubrosPorKey.get(rubroKey);
      if (!rubroDoc) {
        const doc = { nombre: nombreRubro, activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora };
        const r = await db.collection('productos_rubros_base').insertOne(doc);
        rubroDoc = Object.assign({ _id: r.insertedId }, doc);
        rubrosPorKey.set(rubroKey, rubroDoc);
        rubrosCreados++;
      }
      const subMap = subrubrosPorRubro.get(rubroKey);
      if (!subMap) continue;
      const existentesSub = await db.collection('productos_subrubros_base')
        .find(Object.assign({ rubroId: rubroDoc._id }, filtroOrg(req))).toArray();
      const subKeysExistentes = new Set(existentesSub.map(s => s.nombre.toLowerCase()));
      for (const [subKey, nombreSub] of subMap) {
        if (subKeysExistentes.has(subKey)) continue;
        await db.collection('productos_subrubros_base').insertOne({
          nombre: nombreSub, rubroId: rubroDoc._id, rubroNombre: rubroDoc.nombre,
          activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
        });
        subrubrosCreados++;
      }
    }
    res.json({ rubrosCreados, subrubrosCreados });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Lista liviana de proveedores activos, para el desplegable de Proveedor
// en el formulario de producto — bajo el gate de Productos, no el de
// Proveedores (ver comentario de cabecera).
router.get('/proveedores-lite', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('proveedores')
        .find(match, { projection: { razonSocial: 1, nombreFantasia: 1 } })
        .sort({ razonSocial: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Info de Tiendanube para la ficha de producto (30/9/2026, pedido de Mato):
// si ese SKU está publicado en la tienda, devuelve el link a la página
// pública y las fotos. Si no está configurada la tienda o no se encuentra
// el SKU, devuelve { encontrado: false } (no es un error) — la ficha
// simplemente no muestra esa sección.
router.get('/tiendanube/:sku', authAdmin, async (req, res) => {
  try {
    const info = await buscarProductoTiendanubePorSku(req.params.sku);
    if (!info) return res.json({ encontrado: false });
    res.json(Object.assign({ encontrado: true }, info));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Listas de precio (30/9/2026, pedido de Mato: "agregarle precios a los
// productos, con varias listas configurables"). Decisiones (confirmadas
// con Mato):
//   - El precio de cada producto en cada lista sale de un % de margen
//     sobre el Costo, configurable por lista — pero se puede pisar a mano
//     el precio de un producto puntual en una lista puntual (override).
//   - Las listas aplican a TODO el catálogo (no solo a Producción, que ya
//     tenía esto mismo por separado en costos_listas_precio — eso se deja
//     como está, es otra cosa).
//   - El viejo campo único "precio" de cada producto PASA A SER el
//     override de una lista especial "Consumidor Final" (predeterminada,
//     no se puede borrar) — así no se pierde nada de lo ya cargado, y
//     cualquier código que todavía lea `producto.precio` directamente
//     (Ventas, Cotizador, la tabla de Productos) sigue andando igual,
//     porque ese campo se mantiene sincronizado con el override de esa
//     lista en los dos sentidos (ver sincronizarPrecioConsumidorFinal).
//
// Colección nueva: productos_listas_precio : { nombre, porcentaje,
//   predeterminada, activa, orden, orgId, createdAt, updatedAt }
// Campo nuevo en productos_catalogo: preciosPorLista : [{ listaId, precio }]
// -----------------------------------------------------------------------

function round2(n) { return Math.round(n * 100) / 100; }

// No todas las listas tienen todo el catálogo (1/10/2026, pedido de
// Mato: "no todas las listas tienen todos los productos, ejemplo la de
// mayorista debe tener los artículos de producción y algún que otro
// producto adicional"). Una lista con alcance 'seleccion' solo aplica a
// los productos que tiene en `productosIds` — las demás ('todos', y
// siempre la predeterminada "Consumidor Final") siguen aplicando a todo
// el catálogo activo, como antes.
function perteneceALista(producto, lista) {
  if (!lista || lista.alcance !== 'seleccion') return true;
  const ids = lista.productosIds || [];
  return ids.some(id => String(id) === String(producto._id));
}

// Costo en pesos de un producto (1/10/2026, pedido de Mato: "hay
// productos que los vamos a tener en dólares y otros en pesos... que
// tomando ese valor de dólar calcule el precio en pesos automáticamente").
// `producto.moneda` (ya existía) dice en qué moneda está cargado el
// costo; si es USD se convierte con la cotización vigente de la
// organización (ver /config/cotizacion-dolar más abajo). Sin cotización
// cargada todavía, no se puede resolver el costo en pesos de un producto
// en dólares (devuelve null en vez de un número inventado).
function costoEnPesos(producto, cotizacion) {
  if (producto.costo == null) return null;
  if (producto.moneda === 'USD') return cotizacion ? round2(producto.costo * cotizacion) : null;
  return producto.costo;
}

const FORMULAS_LISTA_VALIDAS = ['costo_porcentaje', 'cf_x_bulto'];

// Precio resuelto de un producto en una lista: el override si existe; si
// no, según la fórmula de la lista:
//   - 'costo_porcentaje' (default): costo (convertido a pesos si está en
//     USD) + % de la lista.
//   - 'cf_x_bulto' (1/10/2026, pedido de Mato: "generar una lista de
//     precio que calcule el precio de la lista de consumidor final por
//     las unidades por bulto... la que vamos a usar para sincronizar con
//     Tiendanube"): el precio de venta (Consumidor Final, ya guardado tal
//     cual en `producto.precio`) multiplicado por "Unidades por bulto" de
//     la ficha — si el producto no tiene bultos cargados, se usa 1 (el
//     precio queda igual). El % de la lista no aplica a esta fórmula.
// null si no se puede calcular (sin costo/precio cargado, sin cotización
// para convertir un costo en USD, o el producto no pertenece a una lista
// de alcance "selección").
function precioResuelto(producto, lista, cotizacion) {
  if (!perteneceALista(producto, lista)) return { precio: null, override: false, fueraDeAlcance: true };
  const overrides = producto.preciosPorLista || [];
  const ov = overrides.find(x => String(x.listaId) === String(lista._id));
  if (ov) return { precio: ov.precio, override: true };
  // La lista predeterminada (Consumidor Final) NO calcula nada con costo +
  // %: su precio es directamente `producto.precio`, el mismo campo que se
  // carga desde la ficha de Productos o el import de Productos (ver
  // comentario de cabecera, y el de 'cf_x_bulto' más abajo que depende de
  // este mismo campo). Antes, un producto sin un ajuste puntual guardado
  // para esta lista (o sea, cualquiera cargado/editado por la ficha de
  // Productos en vez de por la pantalla de Listas de precio) caía en el
  // cálculo de costo + % de más abajo, que daba vacío sin costo cargado
  // — eso era lo que hacía ver "todo vacío" en Consumidor Final (2/10/2026,
  // bug reportado por Mato).
  if (lista.predeterminada) {
    return { precio: producto.precio != null ? producto.precio : null, override: false };
  }
  if (lista.formula === 'cf_x_bulto') {
    if (producto.precio == null) return { precio: null, override: false };
    const bultos = (producto.unidadesPorBulto && producto.unidadesPorBulto > 0) ? producto.unidadesPorBulto : 1;
    return { precio: round2(producto.precio * bultos), override: false };
  }
  const costo = costoEnPesos(producto, cotizacion);
  if (costo == null) return { precio: null, override: false };
  return { precio: round2(costo * (1 + (lista.porcentaje || 0) / 100)), override: false };
}

// Lee la cotización del dólar configurada para la organización (null si
// todavía no se cargó ninguna).
async function obtenerCotizacionDolar(db, req) {
  const doc = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' });
  return doc ? doc.valor : null;
}

// Trae (y crea si hace falta) la lista "Consumidor Final" de esta
// organización. La primera vez que se crea, hace el backfill: copia el
// `precio` actual de cada producto activo como override de esta lista,
// así ningún precio ya cargado se pierde.
async function obtenerListaPredeterminada(db, req) {
  const match = Object.assign({ predeterminada: true }, filtroOrg(req));
  let lista = await db.collection('productos_listas_precio').findOne(match);
  if (lista) {
    // Autocorrección (2/10/2026, bug reportado por Mato: "la de consumidor
    // final no me la está importando"): el botón de activar/desactivar no
    // distinguía la predeterminada, así que se podía desactivar por
    // accidente — y al estar inactiva, "Exportar todas las listas" la
    // sacaba de la planilla (filtra solo listas activas) pero el import
    // seguía esperando su columna iguel, así que nunca se volvía a
    // actualizar desde el archivo que Mato reexportaba. Ahora ya no se
    // puede desactivar (ver PUT /listas-precio/:id), pero si ya había
    // quedado así, se corrige sola acá.
    if (lista.activa === false) {
      await db.collection('productos_listas_precio').updateOne(match, { $set: { activa: true, updatedAt: new Date() } });
      lista.activa = true;
    }
    return lista;
  }

  const ahora = new Date();
  const nueva = {
    nombre: 'Consumidor Final', porcentaje: 0, predeterminada: true, activa: true, orden: 0,
    alcance: 'todos', formula: 'costo_porcentaje', productosIds: [],
    orgId: req.orgId, createdAt: ahora, updatedAt: ahora
  };
  const r = await db.collection('productos_listas_precio').insertOne(nueva);
  lista = Object.assign({ _id: r.insertedId }, nueva);

  // Backfill: todo producto activo con `precio` cargado pasa a tener ese
  // valor como override de esta lista recién creada.
  const productosConPrecio = await db.collection('productos_catalogo')
    .find(Object.assign({ activo: { $ne: false }, precio: { $ne: null } }, filtroOrg(req)))
    .project({ precio: 1 }).toArray();
  if (productosConPrecio.length) {
    const ops = productosConPrecio.map(p => ({
      updateOne: {
        filter: { _id: p._id },
        update: { $push: { preciosPorLista: { listaId: lista._id, precio: p.precio } } }
      }
    }));
    for (let i = 0; i < ops.length; i += 500) {
      await db.collection('productos_catalogo').bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
  }
  return lista;
}

// Cuando se guarda/edita el override de la lista Consumidor Final, se
// refleja también en el campo plano `producto.precio` — así Ventas,
// Cotizador y la tabla de Productos (que leen ese campo directo) ven el
// precio actualizado sin que haya que tocar esos módulos.
async function sincronizarPrecioConsumidorFinal(db, req, productoId, precio) {
  await db.collection('productos_catalogo').updateOne(
    Object.assign({ _id: productoId }, filtroOrg(req)),
    { $set: { precio, updatedAt: new Date() } }
  );
}

router.get('/listas-precio', authListasPrecioListado, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const listas = await conReintento(async () => {
      const db = await getDb();
      await obtenerListaPredeterminada(db, req); // se asegura que exista
      return db.collection('productos_listas_precio').find(filtroOrg(req)).sort({ orden: 1, nombre: 1 }).toArray();
    });
    res.json(listas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/listas-precio', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const nombre = normalizarTexto((req.body || {}).nombre);
    if (!nombre) throw err(400, 'Falta el nombre de la lista (ej: Mayorista, Pintores)');
    const porcentaje = Number((req.body || {}).porcentaje);
    if (!Number.isFinite(porcentaje)) throw err(400, 'El % de margen tiene que ser un número');
    // alcance: 'todos' (default, aplica a todo el catálogo activo) o
    // 'seleccion' (solo a los productos que se le vayan agregando — ej:
    // "Mayorista" con los artículos de Producción + algún extra).
    const alcance = (req.body || {}).alcance === 'seleccion' ? 'seleccion' : 'todos';
    // formula: 'costo_porcentaje' (default) o 'cf_x_bulto' (1/10/2026,
    // ver precioResuelto arriba — la que arma Mato para sincronizar con
    // Tiendanube, precio de Consumidor Final × Unidades por bulto).
    const formula = FORMULAS_LISTA_VALIDAS.includes((req.body || {}).formula) ? req.body.formula : 'costo_porcentaje';
    const doc = await conReintento(async () => {
      const db = await getDb();
      const ahora = new Date();
      const nueva = {
        nombre, porcentaje, predeterminada: false, activa: true, alcance, formula, productosIds: [],
        orden: 100, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
      };
      const r = await db.collection('productos_listas_precio').insertOne(nueva);
      return Object.assign({ _id: r.insertedId }, nueva);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/listas-precio/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const set = { updatedAt: new Date() };
    if (body.nombre !== undefined) {
      const nombre = normalizarTexto(body.nombre);
      if (!nombre) throw err(400, 'La lista necesita un nombre');
      set.nombre = nombre;
    }
    if (body.porcentaje !== undefined) {
      const porcentaje = Number(body.porcentaje);
      if (!Number.isFinite(porcentaje)) throw err(400, 'El % de margen tiene que ser un número');
      set.porcentaje = porcentaje;
    }
    const doc = await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const lista = await db.collection('productos_listas_precio').findOne(match);
      if (!lista) throw err(404, 'Lista no encontrada');
      // El alcance, la fórmula y el estado activa/inactiva de la lista
      // predeterminada (Consumidor Final) no se pueden tocar — tiene que
      // seguir cubriendo todo el catálogo con costo + %, porque de ahí
      // sale el campo `producto.precio` que usan Ventas/Cotizador (y que
      // a su vez usa la fórmula 'cf_x_bulto' de otras listas). Desactivarla
      // además rompía "Importar/Exportar todas las listas" (2/10/2026, ver
      // comentario en obtenerListaPredeterminada): al quedar inactiva,
      // "Exportar todas" la sacaba de la planilla, pero el import seguía
      // esperando su columna igual, así que nunca se volvía a actualizar.
      if (body.activa !== undefined && !lista.predeterminada) {
        set.activa = !!body.activa;
      }
      if (body.alcance !== undefined && !lista.predeterminada) {
        set.alcance = body.alcance === 'seleccion' ? 'seleccion' : 'todos';
      }
      if (body.formula !== undefined && !lista.predeterminada && FORMULAS_LISTA_VALIDAS.includes(body.formula)) {
        set.formula = body.formula;
      }
      const r = await db.collection('productos_listas_precio').findOneAndUpdate(
        match, { $set: set }, { returnDocument: 'after' }
      );
      return r && r.value !== undefined ? r.value : r;
    });
    if (!doc) throw err(404, 'Lista no encontrada');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/listas-precio/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const lista = await db.collection('productos_listas_precio').findOne(match);
      if (!lista) throw err(404, 'Lista no encontrada');
      if (lista.predeterminada) throw err(400, 'La lista "Consumidor Final" no se puede borrar.');
      await db.collection('productos_listas_precio').deleteOne({ _id: id });
      await db.collection('productos_catalogo').updateMany(
        Object.assign({ 'preciosPorLista.listaId': id }, filtroOrg(req)),
        { $pull: { preciosPorLista: { listaId: id } } }
      );
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Cotización del dólar (1/10/2026, pedido de Mato: "vamos a tener
// productos en dólares y otros en pesos... tenemos que tener en algún
// panel de configuración la cotización del dólar... que tomando ese
// valor calcule el precio en pesos automáticamente"). Un valor por
// organización (colección `config_general`, un documento por orgId +
// clave) — se usa para convertir a pesos el costo de un producto cargado
// en USD antes de aplicarle el % de margen de cada lista de precio. El
// costo/precio "plano" del producto queda tal cual Mato lo cargó, en su
// moneda original — esto solo afecta el cálculo derivado de las listas.
// Pantalla: Bases y catálogos.
// -----------------------------------------------------------------------
router.get('/config/cotizacion-dolar', authListasPrecio, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' });
    });
    res.json({ valor: doc ? doc.valor : null, actualizadoEn: doc ? doc.updatedAt : null });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config/cotizacion-dolar', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const valor = Number((req.body || {}).valor);
    if (!Number.isFinite(valor) || valor <= 0) throw err(400, 'La cotización tiene que ser un número mayor a 0');
    const ahora = new Date();
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('config_general').updateOne(
        { orgId: req.orgId, clave: 'cotizacionDolar' },
        { $set: { valor, updatedAt: ahora }, $setOnInsert: { orgId: req.orgId, clave: 'cotizacionDolar', createdAt: ahora } },
        { upsert: true }
      );
    });
    res.json({ valor, actualizadoEn: ahora });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Filtro de productos de una lista: todo el catálogo activo, salvo que
// sea una lista de alcance "seleccion", en cuyo caso solo los que están
// en su `productosIds` (1/10/2026, ver perteneceALista arriba).
function matchProductosDeLista(req, lista) {
  const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
  if (lista.alcance === 'seleccion') match._id = { $in: lista.productosIds || [] };
  return match;
}

// Precio resuelto de cada producto de una lista puntual (todo el
// catálogo, o solo los que pertenecen a ella si es de alcance
// "selección") — para la pantalla de "ver/editar precios" de esa lista.
router.get('/listas-precio/:id/precios', authListasPrecio, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!lista) throw err(404, 'Lista no encontrada');
      const cotizacion = await obtenerCotizacionDolar(db, req);
      const productos = await db.collection('productos_catalogo')
        .find(matchProductosDeLista(req, lista))
        .project({ sku: 1, nombre: 1, rubro: 1, moneda: 1, costo: 1, precio: 1, unidadesPorBulto: 1, preciosPorLista: 1 }).sort({ nombre: 1 }).toArray();
      const filas = productos.map(p => {
        const { precio, override } = precioResuelto(p, lista, cotizacion);
        return { _id: p._id, sku: p.sku, nombre: p.nombre, rubro: p.rubro, moneda: p.moneda, costo: p.costo, precio, override };
      });
      return { lista, filas, cotizacion };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const COLUMNAS_LISTA_PRECIO = [
  { clave: 'sku', titulo: 'SKU (Código)' },
  { clave: 'nombre', titulo: 'Nombre' },
  { clave: 'precio', titulo: 'Precio', tipo: 'numero' }
];

router.get('/listas-precio/:id/export', authListasPrecio, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { lista, filas } = await conReintento(async () => {
      const db = await getDb();
      const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!lista) throw err(404, 'Lista no encontrada');
      const cotizacion = await obtenerCotizacionDolar(db, req);
      const productos = await db.collection('productos_catalogo')
        .find(matchProductosDeLista(req, lista))
        .project({ sku: 1, nombre: 1, moneda: 1, costo: 1, precio: 1, unidadesPorBulto: 1, preciosPorLista: 1 }).sort({ nombre: 1 }).toArray();
      const filas = productos.map(p => Object.assign({ sku: p.sku, nombre: p.nombre }, { precio: precioResuelto(p, lista, cotizacion).precio }));
      return { lista, filas };
    });
    const nombreArchivo = `lista-precio-${String(lista.nombre).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.xlsx`;
    exportarXlsx(res, nombreArchivo, COLUMNAS_LISTA_PRECIO, filas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Export/import de TODAS las listas activas de una — una sola planilla
// con SKU, Nombre, Moneda, Costo y una columna por lista (1/10/2026,
// pedido de Mato: "esa plantilla estaría buena que tenga moneda y una
// columna para cada lista de precios"). Moneda y Costo viajan como
// referencia (para saber en qué moneda está cargado cada producto); no
// se reimportan — para cambiar costo o moneda se usa el import de
// Productos, que ya tiene esas columnas.
function columnasTodasLasListas(listas) {
  return [
    { clave: 'sku', titulo: 'SKU (Código)' },
    { clave: 'nombre', titulo: 'Nombre' },
    { clave: 'moneda', titulo: 'Moneda' },
    { clave: 'costo', titulo: 'Costo', tipo: 'numero' },
    ...listas.map(l => ({ clave: 'lista_' + l._id, titulo: l.nombre, tipo: 'numero' }))
  ];
}

router.get('/listas-precio/exportar-todas', authListasPrecio, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const { columnas, filas } = await conReintento(async () => {
      const db = await getDb();
      const listas = await db.collection('productos_listas_precio')
        .find(Object.assign({ activa: { $ne: false } }, filtroOrg(req))).sort({ orden: 1, nombre: 1 }).toArray();
      const cotizacion = await obtenerCotizacionDolar(db, req);
      const productos = await db.collection('productos_catalogo')
        .find(Object.assign({ activo: { $ne: false } }, filtroOrg(req)))
        .project({ sku: 1, nombre: 1, moneda: 1, costo: 1, precio: 1, unidadesPorBulto: 1, preciosPorLista: 1 }).sort({ nombre: 1 }).toArray();
      const columnas = columnasTodasLasListas(listas);
      const filas = productos.map(p => {
        const fila = { sku: p.sku, nombre: p.nombre, moneda: p.moneda || 'ARS', costo: p.costo };
        listas.forEach(l => { fila['lista_' + l._id] = precioResuelto(p, l, cotizacion).precio; });
        return fila;
      });
      return { columnas, filas };
    });
    exportarXlsx(res, 'listas-precio.xlsx', columnas, filas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Import de listas de precio EN SEGUNDO PLANO (1/10/2026, pedido de
// Mato: "cuando importo los precios y tarda, que lo haga en segundo
// plano o que me vaya avisando el progreso porque no puedo ver si está
// trabado o no") — mismo patrón que ya usa el import de Productos (ver
// /import más abajo): el POST valida el archivo, crea un job en
// `productos_import_jobs` y responde ENSEGUIDA con un `jobId`; el
// trabajo de verdad (fila por fila, porque cada una puede tocar varias
// listas) sigue corriendo en el servidor y el frontend consulta el
// progreso con el mismo GET /import/estado/:id cada par de segundos.
const TANDA_IMPORT_LISTAS = 500;

// Importa precios de VARIAS listas a la vez, una columna por lista (como
// las exporta /exportar-todas). Igual que el import de una lista puntual:
// si una lista es de alcance "selección", un SKU nuevo en su columna se
// agrega solo como miembro. Una columna de lista que no viene en el
// archivo (porque se borró al editar) se interpreta como "sin cambios"
// para esa lista — a diferencia de la celda vacía, que si saca el precio
// manual cargado.
// Antes de importar de verdad, le muestra a Mato qué encabezados trae el
// archivo + una sugerencia automática de a qué columna corresponde cada
// uno, para que pueda elegir la equivalencia a mano si no coinciden con
// la plantilla (2/10/2026, pedido de Mato: "que me deje elegir
// equivalencia de columna cuando no coincide con la plantilla").
router.post('/listas-precio/importar-todas/encabezados', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await conReintento(getDb);
    const listas = await db.collection('productos_listas_precio').find(filtroOrg(req)).toArray();
    const columnas = columnasTodasLasListas(listas);
    const encabezados = leerEncabezadosXlsxBase64((req.body || {}).archivoBase64);
    const sugeridos = sugerirMapeo(encabezados, columnas);
    res.json({ encabezados, columnas: columnas.map(c => ({ clave: c.clave, titulo: c.titulo })), sugeridos });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/listas-precio/importar-todas', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await conReintento(getDb);
    const listas = await db.collection('productos_listas_precio').find(filtroOrg(req)).toArray();
    const columnas = columnasTodasLasListas(listas);
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, columnas, (req.body || {}).mapeo);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');

    const ahora = new Date();
    const { insertedId: jobId } = await db.collection('productos_import_jobs').insertOne({
      orgId: req.orgId, tipo: 'listas-precio-todas', total: filas.length, procesados: 0,
      actualizados: 0, nuevosMiembros: 0, errores: [], estado: 'procesando', creadoEn: ahora, terminadoEn: null
    });
    res.json({ jobId, total: filas.length });

    procesarImportTodasListas(db, req, jobId, listas, filas).catch(async (e) => {
      try {
        await db.collection('productos_import_jobs').updateOne(
          { _id: jobId }, { $set: { estado: 'error', errorGeneral: e.message, terminadoEn: new Date() } }
        );
      } catch (e2) { /* nada más para hacer del lado del servidor */ }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Reescrito en bulk (1/10/2026, 2da vuelta — Mato: "la importación sigue
// muy lenta"): la versión anterior hacía, POR CADA FILA, un findOne +
// hasta 2 updateOne por cada lista con columna en el archivo (más el
// sync de Consumidor Final) — con 5 listas y ~20.000 filas eso eran
// decenas de miles de viajes secuenciales, uno por uno, a Mongo Atlas.
// Ahora: 1) se traen de UNA sola vez (en tandas de $in) todos los
// productos de los SKU del archivo, 2) se calcula en memoria el estado
// final de preciosPorLista/precio de cada producto tocado (una fila
// posterior sigue pisando a una anterior para la misma lista, igual que
// antes), y 3) se manda todo en bulkWrite por tandas — mismo patrón que
// ya usa el import de Productos.
async function procesarImportTodasListas(db, req, jobId, listas, filas) {
  const errores = [];
  const skusArchivo = [...new Set(filas.map(f => normalizarTexto(f.sku)).filter(Boolean))];
  const productosPorSku = new Map();
  for (let i = 0; i < skusArchivo.length; i += 1000) {
    const grupo = skusArchivo.slice(i, i + 1000);
    const productos = await db.collection('productos_catalogo')
      .find(Object.assign({ sku: { $in: grupo }, activo: { $ne: false } }, filtroOrg(req)))
      .project({ sku: 1, preciosPorLista: 1 }).toArray();
    for (const p of productos) productosPorSku.set(p.sku, p);
  }

  const cambiosPorProducto = new Map(); // id (string) -> {preciosPorLista, precio, _id}
  const nuevosMiembrosPorLista = new Map();
  for (const fila of filas) {
    const sku = normalizarTexto(fila.sku);
    if (!sku) { errores.push({ fila: fila.__fila, motivo: 'Falta el SKU' }); continue; }
    const producto = productosPorSku.get(sku);
    if (!producto) { errores.push({ fila: fila.__fila, motivo: `No existe ningún producto activo con SKU "${sku}"` }); continue; }
    const idStr = String(producto._id);
    if (!cambiosPorProducto.has(idStr)) {
      cambiosPorProducto.set(idStr, { _id: producto._id, preciosPorLista: (producto.preciosPorLista || []).slice(), precio: undefined });
    }
    const cambio = cambiosPorProducto.get(idStr);
    for (const lista of listas) {
      const clave = 'lista_' + lista._id;
      if (!(clave in fila)) continue; // columna no vino en el archivo: sin cambios para esta lista
      const precio = fila[clave];
      if (precio !== null && (!Number.isFinite(precio) || precio < 0)) {
        errores.push({ fila: fila.__fila, motivo: `${lista.nombre}: el precio tiene que ser un número mayor o igual a 0` });
        continue;
      }
      cambio.preciosPorLista = cambio.preciosPorLista.filter(x => String(x.listaId) !== String(lista._id));
      if (precio !== null) cambio.preciosPorLista.push({ listaId: lista._id, precio });
      if (lista.predeterminada) cambio.precio = precio;
      if (lista.alcance === 'seleccion' && !(lista.productosIds || []).some(x => String(x) === idStr)) {
        if (!nuevosMiembrosPorLista.has(String(lista._id))) nuevosMiembrosPorLista.set(String(lista._id), new Set());
        nuevosMiembrosPorLista.get(String(lista._id)).add(producto._id);
      }
    }
  }

  const ahora = new Date();
  const idsTocados = [...cambiosPorProducto.keys()];
  let actualizados = 0;
  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId }, { $set: { procesados: 0, total: idsTocados.length, actualizados: 0, errores } }
  );
  for (let i = 0; i < idsTocados.length; i += TANDA_IMPORT_LISTAS) {
    const grupo = idsTocados.slice(i, i + TANDA_IMPORT_LISTAS);
    const tanda = grupo.map(idStr => {
      const cambio = cambiosPorProducto.get(idStr);
      const set = { preciosPorLista: cambio.preciosPorLista, updatedAt: ahora };
      if (cambio.precio !== undefined) set.precio = cambio.precio;
      return { updateOne: { filter: { _id: cambio._id }, update: { $set: set } } };
    });
    if (tanda.length) {
      const r = await db.collection('productos_catalogo').bulkWrite(tanda, { ordered: false });
      actualizados += r.matchedCount || 0;
    }
    await db.collection('productos_import_jobs').updateOne(
      { _id: jobId }, { $set: { procesados: Math.min(idsTocados.length, i + TANDA_IMPORT_LISTAS), actualizados, errores } }
    );
  }
  for (const [listaId, ids] of nuevosMiembrosPorLista) {
    await db.collection('productos_listas_precio').updateOne({ _id: toObjectId(listaId) }, { $addToSet: { productosIds: { $each: [...ids] } } });
  }
  const nuevosMiembros = [...nuevosMiembrosPorLista.values()].reduce((acc, ids) => acc + ids.size, 0);
  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId },
    { $set: { estado: 'listo', procesados: idsTocados.length, total: idsTocados.length, actualizados, nuevosMiembros, errores, terminadoEn: new Date() } }
  );
}

router.get('/listas-precio/:id/plantilla-import', authListasPrecio, (req, res) => {
  exportarPlantillaXlsx(res, 'plantilla-lista-precio.xlsx', COLUMNAS_LISTA_PRECIO);
});

// Importa precios (y, si la lista es de alcance "selección", de paso da
// de alta como miembros a los SKU que todavía no estaban) desde un Excel
// con las mismas columnas que el export de esta misma lista (1/10/2026,
// pedido de Mato: "debería tener la posibilidad de elegir y de importar
// una o varias listas" — se importa lista por lista, se puede repetir
// para varias). Fila sin precio (celda vacía) saca el override puntual
// (vuelve a Costo + %). También en segundo plano con progreso, igual que
// /importar-todas arriba.
// Mismo propósito que la de arriba, para el import de una lista puntual.
router.post('/listas-precio/:id/import/encabezados', authAdmin, async (req, res) => {
  try {
    const encabezados = leerEncabezadosXlsxBase64((req.body || {}).archivoBase64);
    const sugeridos = sugerirMapeo(encabezados, COLUMNAS_LISTA_PRECIO);
    res.json({ encabezados, columnas: COLUMNAS_LISTA_PRECIO.map(c => ({ clave: c.clave, titulo: c.titulo })), sugeridos });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/listas-precio/:id/import', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await conReintento(getDb);
    const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    if (!lista) throw err(404, 'Lista no encontrada');
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, COLUMNAS_LISTA_PRECIO, (req.body || {}).mapeo);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');

    const ahora = new Date();
    const { insertedId: jobId } = await db.collection('productos_import_jobs').insertOne({
      orgId: req.orgId, tipo: 'lista-precio', listaId: id, total: filas.length, procesados: 0,
      actualizados: 0, nuevosMiembros: 0, errores: [], estado: 'procesando', creadoEn: ahora, terminadoEn: null
    });
    res.json({ jobId, total: filas.length });

    procesarImportListaPrecio(db, req, jobId, lista, filas).catch(async (e) => {
      try {
        await db.collection('productos_import_jobs').updateOne(
          { _id: jobId }, { $set: { estado: 'error', errorGeneral: e.message, terminadoEn: new Date() } }
        );
      } catch (e2) { /* nada más para hacer del lado del servidor */ }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Misma reescritura en bulk que procesarImportTodasListas (ver comentario
// ahí) para el import de una lista puntual.
async function procesarImportListaPrecio(db, req, jobId, lista, filas) {
  const errores = [];
  const skusArchivo = [...new Set(filas.map(f => normalizarTexto(f.sku)).filter(Boolean))];
  const productosPorSku = new Map();
  for (let i = 0; i < skusArchivo.length; i += 1000) {
    const grupo = skusArchivo.slice(i, i + 1000);
    const productos = await db.collection('productos_catalogo')
      .find(Object.assign({ sku: { $in: grupo }, activo: { $ne: false } }, filtroOrg(req)))
      .project({ sku: 1, preciosPorLista: 1 }).toArray();
    for (const p of productos) productosPorSku.set(p.sku, p);
  }

  const cambiosPorProducto = new Map();
  const nuevosMiembros = new Set();
  for (const fila of filas) {
    const sku = normalizarTexto(fila.sku);
    if (!sku) { errores.push({ fila: fila.__fila, motivo: 'Falta el SKU' }); continue; }
    const producto = productosPorSku.get(sku);
    if (!producto) { errores.push({ fila: fila.__fila, motivo: `No existe ningún producto activo con SKU "${sku}"` }); continue; }
    const precio = fila.precio;
    if (precio !== null && (!Number.isFinite(precio) || precio < 0)) {
      errores.push({ fila: fila.__fila, motivo: 'El precio tiene que ser un número mayor o igual a 0' });
      continue;
    }
    const idStr = String(producto._id);
    const preciosPorLista = (producto.preciosPorLista || []).filter(x => String(x.listaId) !== String(lista._id));
    if (precio !== null) preciosPorLista.push({ listaId: lista._id, precio });
    cambiosPorProducto.set(idStr, {
      _id: producto._id, preciosPorLista,
      precio: lista.predeterminada ? precio : undefined
    });
    if (lista.alcance === 'seleccion' && !(lista.productosIds || []).some(x => String(x) === idStr)) {
      nuevosMiembros.add(idStr);
    }
  }

  const ahora = new Date();
  const idsTocados = [...cambiosPorProducto.keys()];
  let actualizados = 0;
  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId }, { $set: { procesados: 0, total: idsTocados.length, actualizados: 0, errores } }
  );
  for (let i = 0; i < idsTocados.length; i += TANDA_IMPORT_LISTAS) {
    const grupo = idsTocados.slice(i, i + TANDA_IMPORT_LISTAS);
    const tanda = grupo.map(idStr => {
      const cambio = cambiosPorProducto.get(idStr);
      const set = { preciosPorLista: cambio.preciosPorLista, updatedAt: ahora };
      if (cambio.precio !== undefined) set.precio = cambio.precio;
      return { updateOne: { filter: { _id: cambio._id }, update: { $set: set } } };
    });
    if (tanda.length) {
      const r = await db.collection('productos_catalogo').bulkWrite(tanda, { ordered: false });
      actualizados += r.matchedCount || 0;
    }
    await db.collection('productos_import_jobs').updateOne(
      { _id: jobId }, { $set: { procesados: Math.min(idsTocados.length, i + TANDA_IMPORT_LISTAS), actualizados, errores } }
    );
  }
  const idsNuevosMiembros = [...nuevosMiembros].map(idStr => cambiosPorProducto.get(idStr)._id);
  if (idsNuevosMiembros.length) {
    await db.collection('productos_listas_precio').updateOne({ _id: lista._id }, { $addToSet: { productosIds: { $each: idsNuevosMiembros } } });
  }
  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId },
    { $set: { estado: 'listo', procesados: idsTocados.length, total: idsTocados.length, actualizados, nuevosMiembros: idsNuevosMiembros.length, errores, terminadoEn: new Date() } }
  );
}

// Agrega de una todos los productos activos de un rubro a una lista de
// alcance "selección" (1/10/2026, pedido de Mato: arrancar rápido una
// lista como "Mayorista" con "los artículos de Producción" y de ahí
// sumar algún producto extra a mano o por import).
router.post('/listas-precio/:id/productos/por-rubro', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const rubro = normalizarTexto((req.body || {}).rubro);
    if (!rubro) throw err(400, 'Elegí un rubro');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!lista) throw err(404, 'Lista no encontrada');
      if (lista.alcance !== 'seleccion') throw err(400, 'Esta lista ya aplica a todo el catálogo — no hace falta agregar productos a mano.');
      const productos = await db.collection('productos_catalogo')
        .find(Object.assign({ activo: { $ne: false }, rubro }, filtroOrg(req)))
        .project({ _id: 1 }).toArray();
      const ids = productos.map(p => p._id);
      if (ids.length) await db.collection('productos_listas_precio').updateOne({ _id: id }, { $addToSet: { productosIds: { $each: ids } } });
      return { agregados: ids.length };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Agrega un producto puntual a una lista de alcance "selección" sin
// fijarle precio manual (queda en Costo + %) — usado desde el botón
// "Agregar a esta lista" en "Precios por lista" de la ficha del producto.
router.post('/listas-precio/:id/productos/:productoId', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    const productoId = toObjectId(req.params.productoId);
    if (!id || !productoId) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!lista) throw err(404, 'Lista no encontrada');
      if (lista.alcance !== 'seleccion') throw err(400, 'Esta lista ya aplica a todo el catálogo.');
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(404, 'Producto no encontrado');
      await db.collection('productos_listas_precio').updateOne({ _id: id }, { $addToSet: { productosIds: productoId } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Saca un producto puntual de una lista de alcance "selección" (y de
// paso su override puntual, si tenía uno cargado en esa lista).
router.delete('/listas-precio/:id/productos/:productoId', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    const productoId = toObjectId(req.params.productoId);
    if (!id || !productoId) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('productos_listas_precio').updateOne(
        Object.assign({ _id: id }, filtroOrg(req)),
        { $pull: { productosIds: productoId } }
      );
      await db.collection('productos_catalogo').updateOne(
        { _id: productoId },
        { $pull: { preciosPorLista: { listaId: id } } }
      );
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Fija o quita (precio:null) el override de un producto puntual en una
// lista puntual. Si la lista es la predeterminada (Consumidor Final),
// además sincroniza producto.precio (ver comentario de cabecera).
router.put('/listas-precio/:listaId/precio/:productoId', authAdmin, async (req, res) => {
  try {
    const listaId = toObjectId(req.params.listaId);
    const productoId = toObjectId(req.params.productoId);
    if (!listaId || !productoId) throw err(400, 'id inválido');
    const precioBody = (req.body || {}).precio;
    const precio = (precioBody === null || precioBody === undefined || precioBody === '') ? null : Number(precioBody);
    if (precio !== null && (!Number.isFinite(precio) || precio < 0)) throw err(400, 'El precio tiene que ser un número mayor o igual a 0');

    await conReintento(async () => {
      const db = await getDb();
      const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: listaId }, filtroOrg(req)));
      if (!lista) throw err(404, 'Lista no encontrada');
      const match = Object.assign({ _id: productoId }, filtroOrg(req));
      const producto = await db.collection('productos_catalogo').findOne(match);
      if (!producto) throw err(404, 'Producto no encontrado');

      if (precio === null) {
        await db.collection('productos_catalogo').updateOne(match, { $pull: { preciosPorLista: { listaId } } });
      } else {
        await db.collection('productos_catalogo').updateOne(match, { $pull: { preciosPorLista: { listaId } } });
        await db.collection('productos_catalogo').updateOne(match, { $push: { preciosPorLista: { listaId, precio } } });
      }
      if (lista.predeterminada) {
        await sincronizarPrecioConsumidorFinal(db, req, productoId, precio);
      }
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// `campos` (2/10/2026, pedido de Mato: "sigue tardando mucho en mostrar
// la base del stock") — opcional, lista separada por comas de los campos
// que hacen falta. Sin esto, esta ruta devolvía el documento COMPLETO de
// cada producto (con descripción, preciosPorLista, etc.) — con el
// catálogo real de Dux (20.327 filas, ver nota del import más abajo) eso
// es un montón de datos para pantallas como Stock que solo necesitan
// unos pocos campos para armar el buscador y la grilla. Que no se pida
// `campos` sigue devolviendo todo (compatibilidad con quien ya lo usaba
// así, como esta misma pantalla de Productos).
const CAMPOS_PRODUCTOS_PERMITIDOS = [
  'sku', 'nombre', 'activo', 'unidad', 'tipoUnidad', 'unidadesPorBulto',
  'cantidadMinima', 'stockIdeal', 'rubro', 'marca', 'moneda', 'costo',
  'precio', 'preciosPorLista', 'stockeable', 'aceptaStockNegativo'
];
router.get('/', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrg(req));
    if (soloActivos) match.activo = { $ne: false };
    if (req.query.rubro) match.rubro = req.query.rubro;
    if (req.query.marca) match.marca = req.query.marca;
    if (req.query.proveedorId) {
      const pid = toObjectId(req.query.proveedorId);
      if (pid) match.proveedorId = pid;
    }
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ nombre: re }, { sku: re }];
    }
    let projection = null;
    if (req.query.campos) {
      const pedidos = String(req.query.campos).split(',').map(s => s.trim()).filter(s => CAMPOS_PRODUCTOS_PERMITIDOS.includes(s));
      if (pedidos.length) {
        projection = {};
        pedidos.forEach(c => { projection[c] = 1; });
      }
    }
    const productos = await conReintento(async () => {
      const db = await getDb();
      let cursor = db.collection('productos_catalogo').find(match).sort({ nombre: 1 });
      if (projection) cursor = cursor.project(projection);
      return cursor.toArray();
    });
    res.json(productos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Import / export en Excel (.xlsx) — ver importExport.js.
// -----------------------------------------------------------------------

router.get('/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const productos = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo').find(match).sort({ nombre: 1 }).toArray();
    });
    exportarXlsx(res, 'productos.xlsx', COLUMNAS_PRODUCTOS, productos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/plantilla-import', authAdmin, (req, res) => {
  exportarPlantillaXlsx(res, 'plantilla-productos.xlsx', COLUMNAS_PRODUCTOS);
});

// Importa filas de un Excel: si el SKU ya existe (activo), actualiza ese
// producto; si no existe, lo crea. Nunca aborta el archivo entero por una
// fila con error — esa fila se saltea y se informa en `errores`.
//
// Asincrónico, en segundo plano (30/9/2026, 3ra vuelta — con el archivo
// real de Dux, 20.327 filas, la primera versión en bulk dejaba la
// request HTTP abierta el tiempo que tardaran todas las tandas, y en
// algún punto la conexión se cortaba antes de terminar — al navegador le
// llegaba una respuesta vacía ("Unexpected end of JSON input"), aparte de
// que la UI no mostraba ningún indicio de que algo estuviera pasando).
// Ahora el POST devuelve ENSEGUIDA un `jobId` apenas termina de leer el
// archivo, y el trabajo pesado (validar fila por fila + bulkWrite por
// tandas de 500) sigue corriendo en el servidor sin que el navegador
// tenga que sostener la conexión — el progreso se guarda en
// `productos_import_jobs` y el frontend lo consulta con
// GET /import/estado/:id cada par de segundos hasta que termina.
const TANDA_IMPORT = 500;

// Equivalencia de columnas al importar Productos (2/10/2026, pedido de
// Mato: "podés poner para validar los campos, como en las listas de
// precio" — mismo mecanismo que ya existe para las listas de precio:
// antes de importar de verdad, se le muestra qué encabezados trae el
// archivo y se lo deja elegir a mano la equivalencia cuando no coincide
// con la plantilla. Importante en Dux: la columna "PRODUCTO" es el
// nombre del artículo (ya matchea con nuestro "Nombre" por el alias) y
// la columna "DESCRIPCION" es el detalle para catálogo/tienda (matchea
// directo con nuestra "Descripción") — pero como Dux cambia de
// plantilla con el tiempo, esta pantalla deja confirmar a mano
// cualquier columna que alguna vez no matchee sola.
router.post('/import/encabezados', authAdmin, async (req, res) => {
  try {
    const encabezados = leerEncabezadosXlsxBase64((req.body || {}).archivoBase64);
    const sugeridos = sugerirMapeo(encabezados, COLUMNAS_PRODUCTOS);
    res.json({ encabezados, columnas: COLUMNAS_PRODUCTOS.map(c => ({ clave: c.clave, titulo: c.titulo })), sugeridos });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/import', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, COLUMNAS_PRODUCTOS, (req.body || {}).mapeo);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');

    const db = await conReintento(getDb);
    const ahora = new Date();
    const { insertedId: jobId } = await db.collection('productos_import_jobs').insertOne({
      orgId: req.orgId, total: filas.length, procesados: 0, creados: 0, actualizados: 0,
      errores: [], estado: 'procesando', creadoEn: ahora, terminadoEn: null
    });
    res.json({ jobId, total: filas.length });

    // A partir de acá la respuesta ya se mandó — todo esto corre en
    // segundo plano. Si algo inesperado revienta acá (no los errores de
    // fila, que ya se manejan adentro), se deja constancia en el job para
    // que no quede "procesando" para siempre sin explicación.
    procesarImportProductos(db, req, jobId, filas).catch(async (e) => {
      try {
        await db.collection('productos_import_jobs').updateOne(
          { _id: jobId },
          { $set: { estado: 'error', errorGeneral: e.message, terminadoEn: new Date() } }
        );
      } catch (e2) { /* si esto también falla, no hay más para hacer del lado del servidor */ }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function procesarImportProductos(db, req, jobId, filas) {
  const proveedoresActivos = await db.collection('proveedores')
    .find(Object.assign({ activo: { $ne: false } }, filtroOrg(req)))
    .project({ razonSocial: 1, nombreFantasia: 1 }).toArray();
  const proveedorIdPorNombre = new Map();
  proveedoresActivos.forEach(p => {
    if (p.razonSocial) proveedorIdPorNombre.set(p.razonSocial.trim().toLowerCase(), p._id);
    if (p.nombreFantasia) proveedorIdPorNombre.set(p.nombreFantasia.trim().toLowerCase(), p._id);
  });

  const errores = [];
  const skusVistos = new Set();
  const ahora = new Date();
  let tanda = [];
  let creados = 0, actualizados = 0, procesados = 0;

  async function vaciarTanda() {
    if (tanda.length) {
      const r = await db.collection('productos_catalogo').bulkWrite(tanda, { ordered: false });
      creados += r.upsertedCount || 0;
      actualizados += r.matchedCount || 0;
      tanda = [];
    }
    await db.collection('productos_import_jobs').updateOne(
      { _id: jobId },
      { $set: { procesados, creados, actualizados, errores } }
    );
  }

  for (const fila of filas) {
    procesados++;
    try {
      if (!fila.sku) throw err(400, 'Falta el SKU');
      // .toUpperCase() acá también: dos filas con el mismo SKU pero
      // distinto casing ("fibra1" / "FIBRA1") son el mismo producto para
      // validarProducto (que ahora normaliza a mayúsculas), así que
      // tienen que detectarse como repetidas acá también.
      const skuMayus = String(fila.sku).trim().toUpperCase();
      if (skusVistos.has(skuMayus)) throw err(400, `SKU "${fila.sku}" repetido en el archivo (se usó la primera aparición)`);
      const datos = validarProducto(fila);
      if (fila.proveedor) {
        const pid = proveedorIdPorNombre.get(String(fila.proveedor).trim().toLowerCase());
        if (pid) datos.proveedorId = pid;
      }
      skusVistos.add(skuMayus);
      const match = Object.assign({ sku: datos.sku, activo: { $ne: false } }, filtroOrg(req));
      tanda.push({
        updateOne: {
          filter: match,
          update: {
            $set: Object.assign({}, datos, { updatedAt: ahora }),
            $setOnInsert: { activo: true, orgId: req.orgId, createdAt: ahora }
          },
          upsert: true
        }
      });
    } catch (e) {
      errores.push({ fila: fila.__fila, motivo: e.message });
    }
    if (tanda.length >= TANDA_IMPORT) await vaciarTanda();
  }
  await vaciarTanda();

  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId },
    { $set: { estado: 'listo', procesados, creados, actualizados, errores, terminadoEn: new Date() } }
  );
}

// Sincronización a demanda con la tienda real de Tiendanube (2/10/2026,
// pedido de Mato: la lista con fórmula 'cf_x_bulto' ya se calcula sola
// dentro de la app — ver precioResuelto más arriba — pero el precio
// real que ve el cliente en la tienda no se actualiza solo; este botón
// es lo que empuja esos precios calculados a Tiendanube, buscando cada
// producto por SKU). Mismo patrón de job en segundo plano que el import
// (reusa la colección y el endpoint de progreso /import/estado/:id).
router.post('/listas-precio/:id/sincronizar-tiendanube', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const db = await conReintento(getDb);
    const lista = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    if (!lista) throw err(404, 'Lista no encontrada');
    if (lista.formula !== 'cf_x_bulto') {
      throw err(400, 'Esta lista no está configurada para sincronizar con Tiendanube (necesita el cálculo "Consumidor Final × bulto")');
    }

    const productos = await db.collection('productos_catalogo')
      .find(matchProductosDeLista(req, lista))
      .project({ sku: 1, precio: 1, unidadesPorBulto: 1, preciosPorLista: 1 }).toArray();
    const preciosPorSku = new Map();
    productos.forEach(p => {
      if (!p.sku) return;
      const { precio } = precioResuelto(p, lista, null);
      if (precio != null) preciosPorSku.set(String(p.sku), precio);
    });
    if (!preciosPorSku.size) throw err(400, 'No hay productos con precio calculado para sincronizar en esta lista');

    const ahora = new Date();
    const { insertedId: jobId } = await db.collection('productos_import_jobs').insertOne({
      orgId: req.orgId, tipo: 'sync-tiendanube', listaId: id, total: preciosPorSku.size, procesados: 0,
      actualizados: 0, sinCambios: 0, noEncontrados: 0, errores: [], estado: 'procesando', creadoEn: ahora, terminadoEn: null
    });
    res.json({ jobId, total: preciosPorSku.size });

    procesarSincronizacionTiendanube(db, jobId, preciosPorSku).catch(async (e) => {
      try {
        await db.collection('productos_import_jobs').updateOne(
          { _id: jobId }, { $set: { estado: 'error', errorGeneral: e.message, terminadoEn: new Date() } }
        );
      } catch (e2) { /* nada más para hacer del lado del servidor */ }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function procesarSincronizacionTiendanube(db, jobId, preciosPorSku) {
  const resultado = await sincronizarPreciosTiendanube(preciosPorSku, async (procesados, total) => {
    await db.collection('productos_import_jobs').updateOne({ _id: jobId }, { $set: { procesados, total } });
  });
  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId },
    { $set: Object.assign({ estado: 'listo', terminadoEn: new Date() }, resultado) }
  );
}

// Recuperación de precios vacíos desde Tiendanube (2/10/2026, bug
// grave: un error de parseo de números — ya corregido, ver
// importExport.js — hizo que varios imports de Consumidor Final
// guardaran vacío cualquier precio de 4+ cifras, en vez del valor real).
// SOLO completa `producto.precio` donde hoy está vacío (null) — nunca
// pisa un precio que ya tenga algo cargado, así que es seguro de
// reintentar y no puede tapar una corrección manual que Mato ya haya
// hecho. La fuente es el catálogo real de Tiendanube (buscarProductoPorSku),
// que nunca se tocó con este bug porque la sincronización hacia la
// tienda solo empuja precios que están cargados, nunca vacíos.
router.post('/recuperar-precios-tiendanube', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await conReintento(getDb);
    const productos = await db.collection('productos_catalogo')
      .find(Object.assign({ activo: { $ne: false }, precio: null }, filtroOrg(req)))
      .project({ sku: 1 }).toArray();
    if (!productos.length) throw err(400, 'No hay productos activos con el precio vacío — no hay nada para recuperar.');

    const ahora = new Date();
    const { insertedId: jobId } = await db.collection('productos_import_jobs').insertOne({
      orgId: req.orgId, tipo: 'recuperar-precios-tiendanube', total: productos.length, procesados: 0,
      actualizados: 0, noEncontrados: 0, errores: [], estado: 'procesando', creadoEn: ahora, terminadoEn: null
    });
    res.json({ jobId, total: productos.length });

    procesarRecuperacionPreciosTiendanube(db, jobId, productos).catch(async (e) => {
      try {
        await db.collection('productos_import_jobs').updateOne(
          { _id: jobId }, { $set: { estado: 'error', errorGeneral: e.message, terminadoEn: new Date() } }
        );
      } catch (e2) { /* nada más para hacer del lado del servidor */ }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function procesarRecuperacionPreciosTiendanube(db, jobId, productos) {
  const preciosPorSku = await obtenerPreciosTiendanubePorSku();
  let actualizados = 0;
  let noEncontrados = 0;
  const ahora = new Date();
  for (let i = 0; i < productos.length; i += TANDA_IMPORT_LISTAS) {
    const grupo = productos.slice(i, i + TANDA_IMPORT_LISTAS);
    const tanda = [];
    for (const p of grupo) {
      const precio = p.sku ? preciosPorSku.get(String(p.sku).toUpperCase()) : undefined;
      if (precio === undefined) { noEncontrados++; continue; }
      tanda.push({ updateOne: { filter: { _id: p._id, precio: null }, update: { $set: { precio, updatedAt: ahora } } } });
    }
    if (tanda.length) {
      const r = await db.collection('productos_catalogo').bulkWrite(tanda, { ordered: false });
      actualizados += r.modifiedCount || 0;
    }
    await db.collection('productos_import_jobs').updateOne(
      { _id: jobId }, { $set: { procesados: Math.min(productos.length, i + TANDA_IMPORT_LISTAS), actualizados, noEncontrados } }
    );
  }
  await db.collection('productos_import_jobs').updateOne(
    { _id: jobId },
    { $set: { estado: 'listo', actualizados, noEncontrados, terminadoEn: new Date() } }
  );
}

// Progreso de un import en curso (o terminado) — el frontend lo consulta
// cada par de segundos mientras `estado` es 'procesando'.
router.get('/import/estado/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const job = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_import_jobs').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!job) throw err(404, 'No se encontró ese import');
    res.json(job);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Consolidación de SKUs duplicados por mayúsculas/minúsculas (30/9/2026,
// bug que Mato detectó tras importar el archivo de Dux): antes el SKU se
// guardaba tal cual se escribía, así que el mismo producto que
// Producción ya sincronizaba con un casing (ej "FIBRA1") quedó duplicado
// al importar el mismo SKU en otro casing desde Dux. Ya se corrigió para
// que de acá en más el SKU siempre se guarde en MAYÚSCULAS (acá y en
// costos.js) — esto es para arreglar lo que ya quedó duplicado.
//
// GET /duplicados-sku: solo DETECTA y devuelve una vista previa, no toca
// nada — para revisar antes de confirmar.
// POST /consolidar-sku: fusiona SOLO los grupos "seguros" (exactamente 2
// productos activos con el mismo SKU sin distinguir mayúsculas, a lo
// sumo uno de los dos vinculado a Producción, y el que se va a
// desactivar sin movimientos de stock/ventas/compras ya registrados
// contra su _id) — completa en el que se conserva los campos vacíos con
// los datos del otro, nunca pisa un dato ya cargado. Cualquier grupo que
// no cumpla estas condiciones se deja sin tocar y se informa en
// `revisionManual` para resolver a mano.
// -----------------------------------------------------------------------

async function detectarDuplicadosSku(db, req) {
  const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
  const productos = await db.collection('productos_catalogo').find(match).toArray();
  const porSku = new Map();
  for (const p of productos) {
    if (!p.sku) continue;
    const clave = String(p.sku).trim().toUpperCase();
    if (!porSku.has(clave)) porSku.set(clave, []);
    porSku.get(clave).push(p);
  }
  const grupos = [];
  for (const [sku, lista] of porSku.entries()) {
    if (lista.length > 1) grupos.push({ sku, productos: lista });
  }
  return grupos;
}

router.get('/duplicados-sku', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const grupos = await conReintento(async () => {
      const db = await getDb();
      return detectarDuplicadosSku(db, req);
    });
    res.json({
      totalGrupos: grupos.length,
      grupos: grupos.map(g => ({
        sku: g.sku,
        productos: g.productos.map(p => ({
          _id: p._id, sku: p.sku, nombre: p.nombre, tipoProducto: p.tipoProducto,
          costoProductoId: p.costoProductoId || null, rubro: p.rubro, marca: p.marca,
          costo: p.costo, precio: p.precio, proveedor: p.proveedor, createdAt: p.createdAt
        }))
      }))
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const CAMPOS_A_COMPLETAR_FUSION = [
  'rubro', 'subrubro', 'marca', 'unidad', 'tipoUnidad', 'disponiblePara', 'moneda',
  'precio', 'costo', 'porcentajeIva', 'impuestoInterno', 'codigoBarra', 'codigoExterno',
  'proveedor', 'proveedorId', 'unidadesPorBulto', 'cantidadMinima', 'stockIdeal',
  'embalaje', 'descripcion', 'fechaVencimiento', 'notas'
];

router.post('/consolidar-sku', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const grupos = await detectarDuplicadosSku(db, req);
      let fusionados = 0;
      const revisionManual = [];
      const detalle = [];

      for (const grupo of grupos) {
        const { sku, productos } = grupo;
        if (productos.length !== 2) {
          revisionManual.push({ sku, motivo: `${productos.length} productos activos con este SKU — revisar a mano`, ids: productos.map(p => String(p._id)) });
          continue;
        }
        const conLink = productos.filter(p => p.costoProductoId);
        if (conLink.length > 1) {
          revisionManual.push({ sku, motivo: 'Más de un producto vinculado a Producción con este SKU — revisar a mano', ids: productos.map(p => String(p._id)) });
          continue;
        }
        const keeper = conLink[0] || productos[0];
        const donante = productos.find(p => String(p._id) !== String(keeper._id));

        // Nunca se fusiona si el que se va a desactivar ya tiene
        // historial real (movimientos de stock, ventas, compras) contra
        // su _id — ahí se perdería ese historial, mejor resolverlo a
        // mano.
        const [movStock, stockActualRef, ventasRef, comprasRef] = await Promise.all([
          db.collection('stock_movimientos').countDocuments(Object.assign({ productoId: donante._id }, filtroOrg(req))),
          db.collection('stock_actual').countDocuments(Object.assign({ productoId: donante._id }, filtroOrg(req))),
          db.collection('ventas').countDocuments(Object.assign({ 'items.productoId': donante._id }, filtroOrg(req))),
          db.collection('compras').countDocuments(Object.assign({ 'items.productoId': donante._id }, filtroOrg(req)))
        ]);
        if (movStock || stockActualRef || ventasRef || comprasRef) {
          revisionManual.push({ sku, motivo: 'El producto duplicado ya tiene movimientos de stock, ventas, compras o stock actual registrados — fusionar a mano para no perder ese historial', ids: productos.map(p => String(p._id)) });
          continue;
        }

        const set = { sku, updatedAt: new Date() };
        const completados = [];
        for (const campo of CAMPOS_A_COMPLETAR_FUSION) {
          const vacio = keeper[campo] === undefined || keeper[campo] === null || keeper[campo] === '';
          const tieneDato = donante[campo] !== undefined && donante[campo] !== null && donante[campo] !== '';
          if (vacio && tieneDato) { set[campo] = donante[campo]; completados.push(campo); }
        }
        await db.collection('productos_catalogo').updateOne({ _id: keeper._id }, { $set: set });
        await db.collection('productos_catalogo').updateOne(
          { _id: donante._id },
          { $set: {
            activo: false, updatedAt: new Date(),
            notas: `${donante.notas || ''}\n[Fusionado en el producto ${keeper._id} el ${new Date().toLocaleDateString('es-AR')} — SKU duplicado por mayúsculas/minúsculas]`.trim()
          } }
        );
        fusionados++;
        detalle.push({ sku, keeperId: String(keeper._id), donanteDesactivado: String(donante._id), camposCompletados: completados });
      }

      // De paso, uppercasea el sku de costos_productos para que la
      // sincronización Producción→Productos quede 100% consistente con
      // el nuevo criterio (esto es solo normalización de texto, no toca
      // ningún vínculo ni dato comercial).
      await db.collection('costos_productos').updateMany(
        Object.assign({ sku: { $ne: null } }, filtroOrg(req)),
        [{ $set: { sku: { $toUpper: '$sku' } } }]
      );

      return { fusionados, revisionManual, detalle };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un producto.');
    const datos = validarProducto(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarSkuUnico(db, req, datos.sku, null);
      const ahora = new Date();
      const nuevo = Object.assign({}, datos, { activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora });
      const r = await db.collection('productos_catalogo').insertOne(nuevo);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const datos = validarProducto(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarSkuUnico(db, req, datos.sku, id);
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('productos_catalogo').findOneAndUpdate(
        match,
        { $set: Object.assign({}, datos, { updatedAt: new Date() }) },
        { returnDocument: 'after' }
      );
      return r && r.value !== undefined ? r.value : r;
    });
    if (!doc) throw err(404, 'Producto no encontrado');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('productos_catalogo').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
      if (!r.matchedCount) throw err(404, 'Producto no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
