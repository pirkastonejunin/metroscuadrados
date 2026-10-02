// ---------------------------------------------------------------------------
// Stock — depósitos, movimientos (ingresos/egresos/transferencias) y
// existencias actuales por producto y depósito. Se construye sobre el
// catálogo de Productos (`productos_catalogo`) — decisión ya cerrada, ver
// "Productos y Stock" en roadmap-modulos.md. Siguiente etapa después de
// Clientes y Proveedores, pedido de Mato el 29/9/2026 (saltando
// Atributos/variantes de producto, que Mato decidió no construir porque
// Piedra Negra no vende por talle/color).
//
// Campos de Dux relevados (a diferencia de Proveedores, este SÍ se pudo
// consultar): "Registrar ingresos y egresos de stock"
// (ayuda.duxsoftware.com.ar/es/articles/7860954) — un movimiento manual
// en Dux tiene: Fecha, Código Externo, Personal, Sucursal, Depósito,
// Observaciones, Producto, Tipo de Movimiento (INGRESO/EGRESO), Cantidad.
// Se sigue ese mismo esquema acá (`sucursal`, `codigoExterno`,
// `observaciones` como campos propios, aunque `sucursal` por ahora es
// texto libre — no hay módulo de Sucursales). Los artículos sobre
// "Consulta de stock" y "Transferencias entre depósitos" dieron 403 al
// intentar relevarlos (mismo problema que con Proveedores) — el diseño de
// depósitos/transferencias/stock-actual de acá es razonamiento propio
// sobre lo que hace falta, no una copia 1 a 1 de Dux.
//
// DECISIÓN DE ALCANCE v1 (a propósito afuera, para no intentar todo de
// una vez):
//   - `cantidadMinima`/`stockIdeal` quedan a nivel de PRODUCTO, no por
//     depósito (Dux los permite por depósito — acá se simplifica).
//   - El "stock en tránsito" y "reserva de stock" de Dux no se
//     construyen — son conceptos de Ventas/Compras, que todavía no
//     existen acá.
//   - Los movimientos son un LIBRO INMUTABLE: no hay edición ni borrado
//     de un movimiento ya cargado (igual que un libro contable) — un
//     error se corrige con otro movimiento en sentido contrario, nunca
//     editando el original. Por eso no hay PUT/DELETE de movimientos.
//   - Fábrica (`fabrica.js`) TODAVÍA sigue generando el archivo para
//     importar a mano en Dux — no se conectó (a propósito, en esta
//     vuelta) para que la carga diaria impacte acá directo. Es el
//     siguiente paso natural una vez que este módulo esté probado en uso
//     real (ver roadmap).
//
// Colecciones nuevas (en la misma base `calculadora_m2`):
//   depositos        : { nombre, direccion, notas, activo, orgId,
//                         createdAt, updatedAt }
//   stock_movimientos: { productoId, depositoId, tipo (ingreso/egreso),
//                         cantidad, motivo, sucursal, codigoExterno,
//                         observaciones, transferenciaId (si es una pata
//                         de una transferencia, liga ambos movimientos),
//                         usuarioNombre, fecha, orgId, createdAt }
//   stock_actual     : { productoId, depositoId, cantidad, orgId,
//                         actualizadoEn } — caché mantenido en cada
//                         movimiento (no se recalcula sumando el libro
//                         entero cada vez que se consulta).
//
// Módulo con clave propia ('stock'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const stockRouter = require('./stock');
//   app.use('/api/stock', stockRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx, exportarPlantillaXlsx, parsearXlsxBase64 } = require('./importExport');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
// Índices (1/10/2026, mismo motivo que en productos.js: "que ande más
// fluido" — depósitos y stock también se cargan seguido desde Nueva
// Venta/Stock sin índices).
let indicesListos = false;
async function asegurarIndices(db) {
  if (indicesListos) return;
  indicesListos = true;
  try {
    await Promise.all([
      db.collection('depositos').createIndex({ orgId: 1, activo: 1, nombre: 1 }),
      db.collection('stock_actual').createIndex({ orgId: 1, productoId: 1, depositoId: 1 }),
      db.collection('stock_movimientos').createIndex({ orgId: 1, fecha: -1, createdAt: -1 })
    ]);
  } catch (e) {
    indicesListos = false;
    console.error('No se pudieron crear los índices de stock:', e.message);
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

const authAdmin = [authUsuario, resolverOrg, requiereModulo('stock')];

const TIPOS_MOVIMIENTO_VALIDOS = ['ingreso', 'egreso'];

// Columnas del Excel de import/export (30/9/2026, pedido de Mato: "todas
// las bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js. Stock tiene TRES planillas distintas: depósitos
// (import/export), stock actual (solo export, es un caché calculado) y
// movimientos (export de historial + import para carga inicial de stock,
// que arma un movimiento de ingreso por cada fila con SKU+Depósito+Cantidad).
const COLUMNAS_DEPOSITOS = [
  { clave: 'nombre', titulo: 'Nombre' },
  { clave: 'direccion', titulo: 'Dirección' },
  { clave: 'notas', titulo: 'Notas' }
];
const COLUMNAS_STOCK_ACTUAL = [
  { clave: 'sku', titulo: 'SKU' },
  { clave: 'nombre', titulo: 'Producto' },
  { clave: 'deposito', titulo: 'Depósito' },
  { clave: 'cantidad', titulo: 'Cantidad', tipo: 'numero' },
  { clave: 'cantidadComprometida', titulo: 'Comprometido', tipo: 'numero' },
  { clave: 'disponible', titulo: 'Disponible', tipo: 'numero' },
  { clave: 'unidad', titulo: 'Unidad' },
  { clave: 'cantidadMinima', titulo: 'Cantidad mínima', tipo: 'numero' },
  { clave: 'stockIdeal', titulo: 'Stock ideal', tipo: 'numero' }
];
const COLUMNAS_MOVIMIENTOS_EXPORT = [
  { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
  { clave: 'tipo', titulo: 'Tipo' },
  { clave: 'sku', titulo: 'SKU' },
  { clave: 'producto', titulo: 'Producto' },
  { clave: 'deposito', titulo: 'Depósito' },
  { clave: 'cantidad', titulo: 'Cantidad', tipo: 'numero' },
  { clave: 'motivo', titulo: 'Motivo' },
  { clave: 'sucursal', titulo: 'Sucursal' },
  { clave: 'codigoExterno', titulo: 'Código externo' },
  { clave: 'observaciones', titulo: 'Observaciones' },
  { clave: 'usuarioNombre', titulo: 'Usuario' }
];
// Para el import (carga inicial de stock): mismas columnas mínimas que
// pide el form manual de "Nuevo movimiento".
const COLUMNAS_MOVIMIENTOS_IMPORT = [
  { clave: 'sku', titulo: 'SKU' },
  { clave: 'deposito', titulo: 'Depósito' },
  { clave: 'tipo', titulo: 'Tipo (ingreso/egreso)' },
  { clave: 'cantidad', titulo: 'Cantidad', tipo: 'numero' },
  { clave: 'motivo', titulo: 'Motivo' },
  { clave: 'observaciones', titulo: 'Observaciones' }
];

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

function normalizarCantidad(v, etiqueta) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw err(400, `${etiqueta} tiene que ser un número mayor a 0`);
  return n;
}

function normalizarFecha(v) {
  if (!v) return new Date();
  const d = new Date(v);
  if (isNaN(d.getTime())) throw err(400, 'La fecha es inválida');
  return d;
}

// -----------------------------------------------------------------------
// Depósitos
// -----------------------------------------------------------------------

router.get('/depositos', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrg(req));
    if (soloActivos) match.activo = { $ne: false };
    const depositos = await conReintento(async () => {
      const db = await getDb();
      return db.collection('depositos').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(depositos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/depositos', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un depósito.');
    const nombre = normalizarTexto(req.body && req.body.nombre);
    if (!nombre) throw err(400, 'El nombre del depósito es obligatorio');
    const direccion = normalizarTexto(req.body && req.body.direccion);
    const notas = normalizarTexto(req.body && req.body.notas);
    const doc = await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ nombre, activo: { $ne: false } }, filtroOrg(req));
      const existente = await db.collection('depositos').findOne(match);
      if (existente) throw err(400, `Ya hay un depósito activo llamado "${nombre}".`);
      const ahora = new Date();
      const nuevo = { nombre, direccion, notas, activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora };
      const r = await db.collection('depositos').insertOne(nuevo);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/depositos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const nombre = normalizarTexto(req.body && req.body.nombre);
    if (!nombre) throw err(400, 'El nombre del depósito es obligatorio');
    const direccion = normalizarTexto(req.body && req.body.direccion);
    const notas = normalizarTexto(req.body && req.body.notas);
    const doc = await conReintento(async () => {
      const db = await getDb();
      const matchDup = Object.assign({ nombre, activo: { $ne: false }, _id: { $ne: id } }, filtroOrg(req));
      const existente = await db.collection('depositos').findOne(matchDup);
      if (existente) throw err(400, `Ya hay otro depósito activo llamado "${nombre}".`);
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const update = { nombre, direccion, notas, updatedAt: new Date() };
      // Permite reactivar un depósito desactivado desde la misma pantalla
      // de edición (1/10/2026, pedido de Mato: alta de depósitos en Bases
      // y catálogos, mismo criterio que rubros/subrubros).
      if (req.body && req.body.activo !== undefined) update.activo = !!req.body.activo;
      const r = await db.collection('depositos').findOneAndUpdate(
        match,
        { $set: update },
        { returnDocument: 'after' }
      );
      return r && r.value !== undefined ? r.value : r;
    });
    if (!doc) throw err(404, 'Depósito no encontrado');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/depositos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('depositos').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
      if (!r.matchedCount) throw err(404, 'Depósito no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Import / export de depósitos en Excel (.xlsx) — ver importExport.js.
router.get('/depositos/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const depositos = await conReintento(async () => {
      const db = await getDb();
      return db.collection('depositos').find(match).sort({ nombre: 1 }).toArray();
    });
    exportarXlsx(res, 'depositos.xlsx', COLUMNAS_DEPOSITOS, depositos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/depositos/plantilla-import', authAdmin, (req, res) => {
  exportarPlantillaXlsx(res, 'plantilla-depositos.xlsx', COLUMNAS_DEPOSITOS);
});

router.post('/depositos/import', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, COLUMNAS_DEPOSITOS);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      let creados = 0, actualizados = 0;
      const errores = [];
      for (const fila of filas) {
        try {
          const nombre = normalizarTexto(fila.nombre);
          if (!nombre) throw err(400, 'Falta el nombre del depósito');
          const direccion = normalizarTexto(fila.direccion);
          const notas = normalizarTexto(fila.notas);
          const match = Object.assign({ nombre, activo: { $ne: false } }, filtroOrg(req));
          const existente = await db.collection('depositos').findOne(match);
          const ahora = new Date();
          if (existente) {
            await db.collection('depositos').updateOne({ _id: existente._id }, { $set: { direccion, notas, updatedAt: ahora } });
            actualizados++;
          } else {
            await db.collection('depositos').insertOne({ nombre, direccion, notas, activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora });
            creados++;
          }
        } catch (e) {
          errores.push({ fila: fila.__fila, motivo: e.message });
        }
      }
      return { creados, actualizados, errores };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Stock actual (caché por producto + depósito)
// -----------------------------------------------------------------------

// Aplica un movimiento al caché de stock_actual — suma si es ingreso,
// resta si es egreso. Devuelve la cantidad resultante.
async function aplicarAlStockActual(db, req, productoId, depositoId, tipo, cantidad) {
  const delta = tipo === 'ingreso' ? cantidad : -cantidad;
  const match = Object.assign({ productoId, depositoId }, filtroOrg(req));
  const r = await db.collection('stock_actual').findOneAndUpdate(
    match,
    { $inc: { cantidad: delta }, $set: { actualizadoEn: new Date() }, $setOnInsert: Object.assign({ productoId, depositoId }, filtroOrg(req)) },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return doc ? doc.cantidad : delta;
}

// Detalle de qué ventas componen el "comprometido" de un producto en un
// depósito (2/10/2026, pedido de Mato: poder ver a qué cliente y cuánta
// cantidad corresponde ese número antes de hacer click). Lee directo de
// la colección `ventas` — mismo criterio ya usado en este archivo para
// replicar la mínima lógica necesaria de otro módulo sin importarlo.
router.get('/comprometido', authAdmin, async (req, res) => {
  try {
    const productoId = toObjectId(req.query.productoId);
    const depositoId = toObjectId(req.query.depositoId);
    if (!productoId || !depositoId) throw err(400, 'Falta productoId o depositoId');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const ventas = await db.collection('ventas').find(Object.assign({
        estado: 'pendiente', depositoId, 'items.productoId': productoId
      }, filtroOrg(req))).sort({ fecha: 1 }).toArray();
      return ventas.map(v => {
        const item = (v.items || []).find(it => String(it.productoId) === String(productoId));
        return {
          ventaId: v._id,
          numero: v.numero,
          tipoComprobante: v.tipoComprobante,
          clienteNombre: v.clienteNombre,
          cantidad: item ? item.cantidad : 0,
          fecha: v.fecha
        };
      });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/actual', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.depositoId) {
      const depId = toObjectId(req.query.depositoId);
      if (!depId) throw err(400, 'depositoId inválido');
      match.depositoId = depId;
    }
    if (req.query.productoId) {
      const prodId = toObjectId(req.query.productoId);
      if (!prodId) throw err(400, 'productoId inválido');
      match.productoId = prodId;
    }
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const [existencias, productos, depositos] = await Promise.all([
        db.collection('stock_actual').find(match).toArray(),
        db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).toArray(),
        db.collection('depositos').find(filtroOrg(req)).toArray()
      ]);
      const productosPorId = new Map(productos.map(p => [String(p._id), p]));
      const depositosPorId = new Map(depositos.map(d => [String(d._id), d]));
      let filas = existencias
        .filter(e => productosPorId.has(String(e.productoId)))
        .map(e => {
          const p = productosPorId.get(String(e.productoId));
          const d = depositosPorId.get(String(e.depositoId));
          // cantidadComprometida (2/10/2026): reservada por ventas que
          // todavía no generaron remito — ver ventas.js. "Disponible" es
          // lo que realmente se puede vender de nuevo.
          const comprometida = e.cantidadComprometida || 0;
          const disponible = e.cantidad - comprometida;
          return {
            productoId: e.productoId,
            depositoId: e.depositoId,
            sku: p.sku,
            nombre: p.nombre,
            deposito: d ? d.nombre : '(depósito eliminado)',
            cantidad: e.cantidad,
            cantidadComprometida: comprometida,
            disponible,
            cantidadMinima: p.cantidadMinima != null ? p.cantidadMinima : null,
            stockIdeal: p.stockIdeal != null ? p.stockIdeal : null,
            bajoMinimo: p.cantidadMinima != null && e.cantidad < p.cantidadMinima,
            unidad: p.unidad,
            actualizadoEn: e.actualizadoEn
          };
        });
      if (req.query.q) {
        const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filas = filas.filter(f => re.test(f.nombre) || re.test(f.sku));
      }
      if (req.query.soloBajoMinimo === '1') filas = filas.filter(f => f.bajoMinimo);
      filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      return filas;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Export de stock actual en Excel (.xlsx) — ver importExport.js. Es un
// caché calculado, no tiene sentido importarlo (se "importa" cargando
// movimientos, ver /movimientos/import más abajo).
router.get('/actual/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.depositoId) {
      const depId = toObjectId(req.query.depositoId);
      if (depId) match.depositoId = depId;
    }
    const filas = await conReintento(async () => {
      const db = await getDb();
      const [existencias, productos, depositos] = await Promise.all([
        db.collection('stock_actual').find(match).toArray(),
        db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).toArray(),
        db.collection('depositos').find(filtroOrg(req)).toArray()
      ]);
      const productosPorId = new Map(productos.map(p => [String(p._id), p]));
      const depositosPorId = new Map(depositos.map(d => [String(d._id), d]));
      return existencias
        .filter(e => productosPorId.has(String(e.productoId)))
        .map(e => {
          const p = productosPorId.get(String(e.productoId));
          const d = depositosPorId.get(String(e.depositoId));
          const comprometida = e.cantidadComprometida || 0;
          return {
            sku: p.sku, nombre: p.nombre, deposito: d ? d.nombre : '(depósito eliminado)',
            cantidad: e.cantidad, cantidadComprometida: comprometida, disponible: e.cantidad - comprometida,
            unidad: p.unidad,
            cantidadMinima: p.cantidadMinima != null ? p.cantidadMinima : null,
            stockIdeal: p.stockIdeal != null ? p.stockIdeal : null
          };
        })
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    });
    exportarXlsx(res, 'stock-actual.xlsx', COLUMNAS_STOCK_ACTUAL, filas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Movimientos (ingreso / egreso) — libro inmutable, sin PUT ni DELETE.
// -----------------------------------------------------------------------

router.get('/movimientos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.productoId) {
      const pid = toObjectId(req.query.productoId);
      if (!pid) throw err(400, 'productoId inválido');
      match.productoId = pid;
    }
    if (req.query.depositoId) {
      const did = toObjectId(req.query.depositoId);
      if (!did) throw err(400, 'depositoId inválido');
      match.depositoId = did;
    }
    if (req.query.tipo) {
      if (!TIPOS_MOVIMIENTO_VALIDOS.includes(req.query.tipo)) throw err(400, 'Tipo de movimiento inválido');
      match.tipo = req.query.tipo;
    }
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const limite = Math.min(Number(req.query.limite) || 200, 500);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const [movimientos, productos, depositos] = await Promise.all([
        db.collection('stock_movimientos').find(match).sort({ fecha: -1, createdAt: -1 }).limit(limite).toArray(),
        db.collection('productos_catalogo').find({}).project({ sku: 1, nombre: 1 }).toArray(),
        db.collection('depositos').find({}).project({ nombre: 1 }).toArray()
      ]);
      const productosPorId = new Map(productos.map(p => [String(p._id), p]));
      const depositosPorId = new Map(depositos.map(d => [String(d._id), d]));
      return movimientos.map(m => {
        const p = productosPorId.get(String(m.productoId));
        const d = depositosPorId.get(String(m.depositoId));
        return Object.assign({}, m, {
          sku: p ? p.sku : null,
          producto: p ? p.nombre : '(producto eliminado)',
          deposito: d ? d.nombre : '(depósito eliminado)'
        });
      });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Un movimiento manual (ingreso o egreso) — campos alineados con el
// formulario de Dux: producto, depósito, tipo, cantidad, fecha, personal
// (usuarioNombre — se toma del usuario logueado, no se pide en el form),
// sucursal, código externo, observaciones/motivo.
router.post('/movimientos', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar un movimiento.');
    const body = req.body || {};
    const productoId = toObjectId(body.productoId);
    if (!productoId) throw err(400, 'Elegí un producto');
    const depositoId = toObjectId(body.depositoId);
    if (!depositoId) throw err(400, 'Elegí un depósito');
    const tipo = normalizarTexto(body.tipo).toLowerCase();
    if (!TIPOS_MOVIMIENTO_VALIDOS.includes(tipo)) throw err(400, `Tipo de movimiento inválido (opciones: ${TIPOS_MOVIMIENTO_VALIDOS.join(', ')})`);
    const cantidad = normalizarCantidad(body.cantidad, 'La cantidad');
    const motivo = normalizarTexto(body.motivo);
    const sucursal = normalizarTexto(body.sucursal);
    const codigoExterno = normalizarTexto(body.codigoExterno);
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = normalizarFecha(body.fecha);

    const doc = await conReintento(async () => {
      const db = await getDb();
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(404, 'Producto no encontrado');
      const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
      if (!deposito) throw err(404, 'Depósito no encontrado');

      if (tipo === 'egreso' && !producto.aceptaStockNegativo) {
        const actual = await db.collection('stock_actual').findOne(Object.assign({ productoId, depositoId }, filtroOrg(req)));
        const cantidadActual = actual ? actual.cantidad : 0;
        if (cantidad > cantidadActual) {
          throw err(400, `No hay stock suficiente en ${deposito.nombre} (disponible: ${cantidadActual}, este producto no acepta stock negativo).`);
        }
      }

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const nuevo = {
        productoId, depositoId, tipo, cantidad, motivo, sucursal, codigoExterno, observaciones,
        usuarioNombre, fecha, orgId: req.orgId, createdAt: new Date()
      };
      const r = await db.collection('stock_movimientos').insertOne(nuevo);
      await aplicarAlStockActual(db, req, productoId, depositoId, tipo, cantidad);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ajuste de inventario (2/10/2026, pedido de Mato) — en vez de que Mato
// tenga que calcular a mano la diferencia y cargar un ingreso o un
// egreso, acá dice directamente "lo que conté fue tal cantidad" y el
// sistema calcula la diferencia contra `stock_actual` y carga el
// ingreso/egreso correspondiente — mismo libro `stock_movimientos` de
// siempre (un ajuste es, al final, una corrección más, con su propio
// motivo para que quede trazado como tal).
router.post('/ajustar', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de ajustar stock.');
    const body = req.body || {};
    const productoId = toObjectId(body.productoId);
    if (!productoId) throw err(400, 'Elegí un producto');
    const depositoId = toObjectId(body.depositoId);
    if (!depositoId) throw err(400, 'Elegí un depósito');
    const cantidadReal = Number(body.cantidadReal);
    if (!Number.isFinite(cantidadReal) || cantidadReal < 0) throw err(400, 'La cantidad contada tiene que ser un número mayor o igual a 0');
    const motivo = normalizarTexto(body.motivo) || 'Ajuste de inventario';
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = normalizarFecha(body.fecha);

    const doc = await conReintento(async () => {
      const db = await getDb();
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(404, 'Producto no encontrado');
      const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
      if (!deposito) throw err(404, 'Depósito no encontrado');

      const actualDoc = await db.collection('stock_actual').findOne(Object.assign({ productoId, depositoId }, filtroOrg(req)));
      const cantidadAnterior = actualDoc ? actualDoc.cantidad : 0;
      const diferencia = cantidadReal - cantidadAnterior;
      if (diferencia === 0) throw err(400, `El stock de "${producto.nombre}" en ${deposito.nombre} ya es ${cantidadAnterior} — no hay diferencia para ajustar.`);
      const tipo = diferencia > 0 ? 'ingreso' : 'egreso';
      const cantidadMovimiento = Math.abs(diferencia);

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const nuevo = {
        productoId, depositoId, tipo, cantidad: cantidadMovimiento,
        motivo: `${motivo} (${cantidadAnterior} → ${cantidadReal})`,
        sucursal: '', codigoExterno: '', observaciones,
        usuarioNombre, fecha, orgId: req.orgId, createdAt: new Date()
      };
      const r = await db.collection('stock_movimientos').insertOne(nuevo);
      await aplicarAlStockActual(db, req, productoId, depositoId, tipo, cantidadMovimiento);
      return Object.assign({ _id: r.insertedId }, nuevo, { cantidadAnterior, cantidadNueva: cantidadReal });
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Transferencia entre depósitos = un egreso del depósito origen + un
// ingreso al depósito destino, ligados por transferenciaId. No pasa por
// la validación de "no acepta stock negativo" de una forma distinta al
// egreso normal — es exactamente eso, un egreso, más un ingreso.
router.post('/transferencias', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de transferir stock.');
    const body = req.body || {};
    const productoId = toObjectId(body.productoId);
    if (!productoId) throw err(400, 'Elegí un producto');
    const depositoOrigenId = toObjectId(body.depositoOrigenId);
    if (!depositoOrigenId) throw err(400, 'Elegí el depósito de origen');
    const depositoDestinoId = toObjectId(body.depositoDestinoId);
    if (!depositoDestinoId) throw err(400, 'Elegí el depósito de destino');
    if (String(depositoOrigenId) === String(depositoDestinoId)) throw err(400, 'El depósito de origen y destino no pueden ser el mismo');
    const cantidad = normalizarCantidad(body.cantidad, 'La cantidad');
    const motivo = normalizarTexto(body.motivo) || 'Transferencia entre depósitos';
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = normalizarFecha(body.fecha);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(404, 'Producto no encontrado');
      const [origen, destino] = await Promise.all([
        db.collection('depositos').findOne(Object.assign({ _id: depositoOrigenId }, filtroOrg(req))),
        db.collection('depositos').findOne(Object.assign({ _id: depositoDestinoId }, filtroOrg(req)))
      ]);
      if (!origen) throw err(404, 'Depósito de origen no encontrado');
      if (!destino) throw err(404, 'Depósito de destino no encontrado');

      if (!producto.aceptaStockNegativo) {
        const actual = await db.collection('stock_actual').findOne(Object.assign({ productoId, depositoId: depositoOrigenId }, filtroOrg(req)));
        const cantidadActual = actual ? actual.cantidad : 0;
        if (cantidad > cantidadActual) {
          throw err(400, `No hay stock suficiente en ${origen.nombre} para transferir (disponible: ${cantidadActual}).`);
        }
      }

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const transferenciaId = new ObjectId();
      const base = { productoId, cantidad, motivo, observaciones, usuarioNombre, fecha, transferenciaId, orgId: req.orgId, createdAt: new Date() };
      const egreso = Object.assign({}, base, { depositoId: depositoOrigenId, tipo: 'egreso' });
      const ingreso = Object.assign({}, base, { depositoId: depositoDestinoId, tipo: 'ingreso' });
      const rEgreso = await db.collection('stock_movimientos').insertOne(egreso);
      const rIngreso = await db.collection('stock_movimientos').insertOne(ingreso);
      await aplicarAlStockActual(db, req, productoId, depositoOrigenId, 'egreso', cantidad);
      await aplicarAlStockActual(db, req, productoId, depositoDestinoId, 'ingreso', cantidad);
      return {
        transferenciaId,
        egreso: Object.assign({ _id: rEgreso.insertedId }, egreso),
        ingreso: Object.assign({ _id: rIngreso.insertedId }, ingreso)
      };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Export del historial de movimientos en Excel (.xlsx) — mismo filtro que
// GET /movimientos, hasta 2000 filas (más que el límite de 500 de la
// vista en pantalla, para que el export sirva como respaldo real).
router.get('/movimientos/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.depositoId) {
      const did = toObjectId(req.query.depositoId);
      if (did) match.depositoId = did;
    }
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const filas = await conReintento(async () => {
      const db = await getDb();
      const [movimientos, productos, depositos] = await Promise.all([
        db.collection('stock_movimientos').find(match).sort({ fecha: -1, createdAt: -1 }).limit(2000).toArray(),
        db.collection('productos_catalogo').find({}).project({ sku: 1, nombre: 1 }).toArray(),
        db.collection('depositos').find({}).project({ nombre: 1 }).toArray()
      ]);
      const productosPorId = new Map(productos.map(p => [String(p._id), p]));
      const depositosPorId = new Map(depositos.map(d => [String(d._id), d]));
      return movimientos.map(m => {
        const p = productosPorId.get(String(m.productoId));
        const d = depositosPorId.get(String(m.depositoId));
        return Object.assign({}, m, {
          sku: p ? p.sku : null,
          producto: p ? p.nombre : '(producto eliminado)',
          deposito: d ? d.nombre : '(depósito eliminado)'
        });
      });
    });
    exportarXlsx(res, 'movimientos-stock.xlsx', COLUMNAS_MOVIMIENTOS_EXPORT, filas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/movimientos/plantilla-import', authAdmin, (req, res) => {
  exportarPlantillaXlsx(res, 'plantilla-carga-inicial-stock.xlsx', COLUMNAS_MOVIMIENTOS_IMPORT);
});

// Importa una carga inicial (o masiva) de stock: cada fila con SKU +
// Depósito + Cantidad genera un movimiento real (ingreso por defecto,
// egreso si se indica) — pasa por la MISMA validación de stock negativo
// que un movimiento manual. Pensado sobre todo para cargar el stock
// inicial al migrar un depósito completo desde Dux.
router.post('/movimientos/import', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, COLUMNAS_MOVIMIENTOS_IMPORT);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const [productos, depositos] = await Promise.all([
        db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).toArray(),
        db.collection('depositos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).toArray()
      ]);
      const productoPorSku = new Map(productos.filter(p => p.sku).map(p => [p.sku.trim().toLowerCase(), p]));
      const depositoPorNombre = new Map(depositos.map(d => [d.nombre.trim().toLowerCase(), d]));
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';

      let creados = 0;
      const errores = [];
      for (const fila of filas) {
        try {
          if (!fila.sku) throw err(400, 'Falta el SKU');
          if (!fila.deposito) throw err(400, 'Falta el depósito');
          const producto = productoPorSku.get(String(fila.sku).trim().toLowerCase());
          if (!producto) throw err(400, `No existe ningún producto activo con SKU "${fila.sku}"`);
          const deposito = depositoPorNombre.get(String(fila.deposito).trim().toLowerCase());
          if (!deposito) throw err(400, `No existe ningún depósito activo llamado "${fila.deposito}"`);
          const tipo = (normalizarTexto(fila.tipo).toLowerCase() || 'ingreso');
          if (!TIPOS_MOVIMIENTO_VALIDOS.includes(tipo)) throw err(400, `Tipo inválido (opciones: ${TIPOS_MOVIMIENTO_VALIDOS.join(', ')})`);
          const cantidad = normalizarCantidad(fila.cantidad, 'La cantidad');

          if (tipo === 'egreso' && !producto.aceptaStockNegativo) {
            const actual = await db.collection('stock_actual').findOne(Object.assign({ productoId: producto._id, depositoId: deposito._id }, filtroOrg(req)));
            const cantidadActual = actual ? actual.cantidad : 0;
            if (cantidad > cantidadActual) throw err(400, `No hay stock suficiente en ${deposito.nombre} (disponible: ${cantidadActual}).`);
          }

          const nuevo = {
            productoId: producto._id, depositoId: deposito._id, tipo, cantidad,
            motivo: normalizarTexto(fila.motivo) || 'Carga por importación de Excel',
            sucursal: '', codigoExterno: '', observaciones: normalizarTexto(fila.observaciones),
            usuarioNombre, fecha: new Date(), orgId: req.orgId, createdAt: new Date()
          };
          await db.collection('stock_movimientos').insertOne(nuevo);
          await aplicarAlStockActual(db, req, producto._id, deposito._id, tipo, cantidad);
          creados++;
        } catch (e) {
          errores.push({ fila: fila.__fila, motivo: e.message });
        }
      }
      return { creados, errores };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
