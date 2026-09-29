// ---------------------------------------------------------------------------
// Productos — catálogo maestro de productos del negocio (paso 1 de migrar
// todo lo que hoy se lleva en Dux a este sistema, decisión con Mato,
// 28/9/2026). Es la base de la que van a colgar Ventas, Stock, Compras y
// Facturación más adelante — ver roadmap-modulos.md.
//
// V1 — a propósito afuera de esta primera versión (se suma después, sin
// romper lo de acá):
//   - Sin stock/depósitos ni movimientos — eso es la siguiente etapa
//     ("Stock"), una vez que el catálogo esté firme.
//   - Sin vínculo obligatorio con proveedores — el módulo de Proveedores
//     todavía no existe; cuando exista, se suma `proveedorId` opcional.
//   - Sin listas de precio propias (a diferencia de Costos de Producción) —
//     un solo precio de venta por producto por ahora.
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
// Colección nueva (en la misma base `calculadora_m2`):
//   productos_catalogo : { nombre, sku, rubro, unidad, precio, costo,
//     costoProductoId, activo, notas, orgId, createdAt, updatedAt }
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

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

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

async function validarSkuUnico(db, req, sku, idExcluir) {
  if (!sku) return;
  const match = Object.assign({ sku, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('productos_catalogo').findOne(match);
  if (existente) throw err(400, `Ya hay otro producto activo con el SKU "${sku}" (${existente.nombre}).`);
}

function validarProducto(body) {
  const nombre = normalizarTexto(body.nombre);
  if (!nombre) throw err(400, 'El nombre es obligatorio');
  const unidad = normalizarTexto(body.unidad) || 'unidad';
  if (!UNIDADES_VALIDAS.includes(unidad)) throw err(400, `Unidad inválida (opciones: ${UNIDADES_VALIDAS.join(', ')})`);
  const rubro = normalizarTexto(body.rubro);
  const sku = normalizarSku(body.sku);
  const precio = normalizarPrecioOpcional(body.precio, 'El precio');
  const costo = normalizarPrecioOpcional(body.costo, 'El costo');
  const notas = normalizarTexto(body.notas);
  const costoProductoId = body.costoProductoId ? toObjectId(body.costoProductoId) : null;
  if (body.costoProductoId && !costoProductoId) throw err(400, 'costoProductoId inválido');
  return { nombre, unidad, rubro, sku, precio, costo, notas, costoProductoId };
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
