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
//   - Sin atributos/variantes (talle, color) — Mato pidió sumarlos
//     después; `utilizaVariantes` queda como flag preparado, pero sin
//     sub-esquema de variantes todavía.
//   - Sin stock/depósitos ni movimientos ni "otros costos" (necesitan
//     configuración previa en Dux) — eso es la siguiente etapa ("Stock").
//   - Sin vínculo real con proveedores (`proveedor` es texto libre) — el
//     módulo de Proveedores todavía no existe.
//   - Sin listas de precio propias (a diferencia de Costos de
//     Producción) — un solo precio de venta por producto por ahora.
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
//     codigoExterno, proveedor, fechaVencimiento, indicaCtdBultos,
//     unidadesPorBulto, embalaje, descripcion, notas, activo, orgId,
//     createdAt, updatedAt }
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
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');

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
    mongoClient = null;
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const authAdmin = [authUsuario, resolverOrg, requiereModulo('productos')];

const UNIDADES_VALIDAS = ['unidad', 'm2', 'ml', 'kg', 'litro', 'paquete', 'jornal'];
// "Tipo de unidad" de Dux — una categoría más amplia que la unidad de
// medida puntual (ej: tipoUnidad "superficie" + unidad "m2").
const TIPOS_UNIDAD_VALIDOS = ['unidad', 'peso', 'longitud', 'capacidad', 'superficie', 'tiempo', 'volumen'];
const DISPONIBLE_PARA_VALIDOS = ['ventas', 'compras', 'todos'];
const MONEDAS_VALIDAS = ['ARS', 'USD'];
const TIPOS_PRODUCTO_VALIDOS = ['simple', 'combo', 'produccion'];

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function normalizarBooleano(v) { return !!v; }

function normalizarSku(v) {
  const s = normalizarTexto(v);
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

  const unidad = normalizarTexto(body.unidad) || 'unidad';
  if (!UNIDADES_VALIDAS.includes(unidad)) throw err(400, `Unidad inválida (opciones: ${UNIDADES_VALIDAS.join(', ')})`);
  const tipoUnidad = normalizarEnum(body.tipoUnidad, TIPOS_UNIDAD_VALIDOS, 'Tipo de unidad', 'unidad');
  const disponiblePara = normalizarEnum(body.disponiblePara, DISPONIBLE_PARA_VALIDOS, 'Disponible para', 'todos');
  const moneda = normalizarEnum(body.moneda, MONEDAS_VALIDAS, 'Moneda', 'ARS');
  const tipoProducto = normalizarEnum(body.tipoProducto, TIPOS_PRODUCTO_VALIDOS, 'Tipo de producto', 'simple');

  const rubro = normalizarTexto(body.rubro);
  const subrubro = normalizarTexto(body.subrubro);
  const marca = normalizarTexto(body.marca);
  const codigoBarra = normalizarTexto(body.codigoBarra);
  const codigoExterno = normalizarTexto(body.codigoExterno);
  const proveedor = normalizarTexto(body.proveedor);
  const embalaje = normalizarTexto(body.embalaje);
  const descripcion = normalizarTexto(body.descripcion);
  const notas = normalizarTexto(body.notas);

  const precio = normalizarPrecioOpcional(body.precio, 'El precio');
  const costo = normalizarPrecioOpcional(body.costo, 'El costo');
  const porcentajeIva = normalizarPrecioOpcional(body.porcentajeIva, 'El porcentaje de IVA');
  const impuestoInterno = normalizarPrecioOpcional(body.impuestoInterno, 'El impuesto interno');
  const unidadesPorBulto = normalizarPrecioOpcional(body.unidadesPorBulto, 'Las unidades por bulto');

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
    rubro, subrubro, marca, codigoBarra, codigoExterno, proveedor, embalaje, descripcion, notas,
    precio, costo, porcentajeIva, impuestoInterno, unidadesPorBulto, fechaVencimiento,
    stockeable, aceptaStockNegativo, trazable, utilizaVariantes, indicaCtdBultos,
    costoProductoId
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

router.get('/', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrg(req));
    if (soloActivos) match.activo = { $ne: false };
    if (req.query.rubro) match.rubro = req.query.rubro;
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ nombre: re }, { sku: re }];
    }
    const productos = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(productos);
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
