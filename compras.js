// ---------------------------------------------------------------------------
// Compras — registro interno de compras a proveedores (SIN facturación
// electrónica AFIP, misma salvedad que Ventas). Es el espejo de Ventas:
// donde una venta descuenta stock y registra cobros, una compra lo
// ingresa y registra pagos.
//
// Campos de Dux relevados: "¿Cómo registrar una nueva compra?"
// (ayuda.duxsoftware.com.ar/es/articles/7861161 — dio 403 al intentar
// relevarlo directo) y, con más suerte, "¿Cómo utilizar las órdenes de
// compra?" (.../7883792) y "¿Cómo generar un pago a proveedor?"
// (.../7880364), que sí se pudieron consultar. El formulario real de una
// Orden de Compra en Dux tiene: Proveedor, Fecha, Sucursal, Depósito (para
// el ingreso posterior de mercadería), Personal, Moneda, Condición de
// pago, Lugar y condiciones de entrega, Fecha de entrega estimada, Fecha
// de vencimiento, Observaciones, Cotización, e ítems (código/SKU/nombre,
// cantidad, precio unitario). Las órdenes pueden facturarse (compra
// definitiva) y/o recepcionarse (genera ingreso de stock) por separado, y
// solo se pueden modificar/anular si no pasó ninguna de las dos cosas. El
// pago a proveedor (Dux) tiene: Proveedor, Fecha, Concepto, facturas
// pendientes del proveedor con saldo (elegís monto parcial o total por
// una), retenciones, y forma de pago (caja, tipo de valor, moneda, monto).
//
// DECISIONES DE ALCANCE v1 (a propósito afuera, ver roadmap — mismo
// criterio que Ventas):
//   - Sin AFIP ni numeración fiscal — comprobante interno únicamente.
//   - Sin el paso previo de "Orden de compra" separada de la compra
//     definitiva (Dux los separa: orden → factura/recepción). Acá una
//     compra es un único documento, igual que Ventas simplificó el
//     presupuesto/pedido de Dux — más adelante se puede sumar el estado
//     "orden" si hace falta.
//   - Sin retenciones.
//   - Pagos simplificados: se registran contra la compra con su saldo
//     pendiente, pero NO se construye un mayor de cuenta corriente por
//     proveedor (mismo motivo que en Ventas — es parte de la etapa
//     grande de Facturación electrónica/cuenta corriente).
//   - "Recepción" (ingreso a stock) funciona igual que "entrega" en
//     Ventas: inmediata (se descuenta — perdón, se INGRESA el stock en
//     el momento de crear la compra) o pendiente (se recibe después,
//     `POST /:id/recibir`, una sola vez — no se puede recibir dos veces).
//   - Anular una compra con stock ya ingresado reingresa — es decir,
//     EGRESA el stock que había entrado (reversión automática, mismo
//     criterio que anular una venta).
//   - Sin devoluciones parciales a proveedor todavía.
//
// Colección nueva: compras : { numero (correlativo interno, NO fiscal),
//   proveedorId, proveedorNombre, fecha, moneda (ARS/USD),
//   cotizacionDolar, condicionPago, tipoRecepcion (inmediata/pendiente),
//   depositoId, estado (pendiente/recibida/anulada), items: [{
//   productoId, sku, nombre, cantidad, precioUnitario, subtotal }],
//   descuentoPorcentaje, descuentoMonto, subtotal, total, pagos: [{
//   tipoValor, monto, fecha, nota, usuarioNombre }], totalPagado,
//   saldoPendiente, observaciones, stockIngresado, stockIngresadoEn,
//   recibidaEn, anuladaEn, anuladaPor, anuladaMotivo, usuarioNombre,
//   orgId, createdAt, updatedAt }
//
// Módulo con clave propia ('compras'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const comprasRouter = require('./compras');
//   app.use('/api/compras', comprasRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx } = require('./importExport');

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
function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

const TIPOS_RECEPCION_VALIDOS = ['inmediata', 'pendiente'];
const ESTADOS_VALIDOS = ['pendiente', 'recibida', 'anulada'];
const MONEDAS_VALIDAS = ['ARS', 'USD'];
const TIPOS_VALOR_VALIDOS = ['efectivo', 'cheque', 'cuenta', 'tarjeta'];

// Columnas del Excel de export (30/9/2026, pedido de Mato: "todas las
// bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js. Solo EXPORT, mismo motivo que en Ventas: una compra se
// genera operativamente (recepción/pagos ligados a movimientos reales de
// stock), no se carga masiva desde Excel.
const COLUMNAS_COMPRAS_EXPORT = [
  { clave: 'numero', titulo: 'Nº' },
  { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
  { clave: 'proveedorNombre', titulo: 'Proveedor' },
  { clave: 'condicionPago', titulo: 'Condición de pago' },
  { clave: 'tipoRecepcion', titulo: 'Tipo de recepción' },
  { clave: 'estado', titulo: 'Estado' },
  { clave: 'moneda', titulo: 'Moneda' },
  { clave: 'subtotal', titulo: 'Subtotal', tipo: 'numero' },
  { clave: 'descuentoPorcentaje', titulo: 'Descuento %', tipo: 'numero' },
  { clave: 'descuentoMonto', titulo: 'Descuento $', tipo: 'numero' },
  { clave: 'total', titulo: 'Total', tipo: 'numero' },
  { clave: 'totalPagado', titulo: 'Pagado', tipo: 'numero' },
  { clave: 'saldoPendiente', titulo: 'Saldo', tipo: 'numero' },
  { clave: 'observaciones', titulo: 'Observaciones' }
];

const authAdmin = [authUsuario, resolverOrg, requiereModulo('compras')];

function normalizarCantidadPositiva(v, etiqueta) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw err(400, `${etiqueta} tiene que ser un número mayor a 0`);
  return n;
}
function normalizarMontoNoNegativo(v, etiqueta) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, `${etiqueta} tiene que ser un número mayor o igual a 0`);
  return n;
}

// -----------------------------------------------------------------------
// Listas livianas para armar el formulario — proveedores y productos
// activos de la organización, y depósitos (mismos que administra Stock,
// expuestos acá bajo el gate de Compras para no exigir también el módulo
// 'proveedores' o 'stock' a quien solo carga compras).
// -----------------------------------------------------------------------

router.get('/proveedores', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('proveedores')
        .find(match, { projection: { razonSocial: 1, nombreFantasia: 1, condicionPago: 1, diasPago: 1 } })
        .sort({ razonSocial: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/productos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo')
        .find(match, { projection: { sku: 1, nombre: 1, costo: 1, unidad: 1, proveedorId: 1 } })
        .sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/depositos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('depositos').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Helpers de stock — mismo mecanismo que stock.js/ventas.js (movimiento +
// $inc sobre stock_actual). Cada router maneja su propia conexión a
// Mongo, así que se replica acá la lógica mínima sobre las mismas
// colecciones (`stock_movimientos`, `stock_actual`).
// -----------------------------------------------------------------------

async function aplicarMovimientoStock(db, req, { productoId, depositoId, tipo, cantidad, motivo, observaciones, compraId, usuarioNombre, fecha }) {
  const movimiento = {
    productoId, depositoId, tipo, cantidad, motivo,
    sucursal: '', codigoExterno: '', observaciones: observaciones || '',
    compraId, usuarioNombre, fecha: fecha || new Date(), orgId: req.orgId, createdAt: new Date()
  };
  await db.collection('stock_movimientos').insertOne(movimiento);
  const delta = tipo === 'ingreso' ? cantidad : -cantidad;
  await db.collection('stock_actual').findOneAndUpdate(
    Object.assign({ productoId, depositoId }, filtroOrg(req)),
    {
      $inc: { cantidad: delta },
      $set: { actualizadoEn: new Date() },
      $setOnInsert: Object.assign({ productoId, depositoId }, filtroOrg(req))
    },
    { upsert: true }
  );
}

// Ingresa a stock cada ítem de la compra (sin validación de stock
// negativo — un ingreso nunca deja el stock en negativo). Los ítems sin
// `productoId` (cargados a mano, sin vínculo al catálogo) no generan
// movimiento.
async function ingresarStockDeCompra(db, req, compra, depositoId) {
  const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
  if (!deposito) throw err(404, 'Depósito no encontrado');
  for (const item of compra.items) {
    if (!item.productoId) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId, tipo: 'ingreso', cantidad: item.cantidad,
      motivo: 'Compra', observaciones: `Compra ${compra.numero ? '#' + compra.numero : ''}`.trim(),
      compraId: compra._id, usuarioNombre: compra.usuarioNombre, fecha: compra.fecha
    });
  }
}

// Reversa el stock de una compra ya recibida (usado al anular) — un
// egreso por cada ítem, con la misma validación de stock negativo que
// cualquier egreso (si ya se vendió parte de lo que entró, no se puede
// sacar de nuevo sin dejarlo en negativo, salvo `aceptaStockNegativo`).
async function egresarStockDeCompra(db, req, compra) {
  if (!compra.depositoId) return;
  const deposito = await db.collection('depositos').findOne(Object.assign({ _id: compra.depositoId }, filtroOrg(req)));
  for (const item of compra.items) {
    if (!item.productoId) continue;
    const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: item.productoId }, filtroOrg(req)));
    if (!producto) continue;
    if (!producto.aceptaStockNegativo) {
      const actual = await db.collection('stock_actual').findOne(Object.assign({ productoId: item.productoId, depositoId: compra.depositoId }, filtroOrg(req)));
      const cantidadActual = actual ? actual.cantidad : 0;
      if (item.cantidad > cantidadActual) {
        throw err(400, `No se puede anular: ya no hay suficiente stock de "${item.nombre}" en ${deposito ? deposito.nombre : 'el depósito'} para revertir el ingreso (disponible: ${cantidadActual}, probablemente ya se vendió). Corregilo con un movimiento de ajuste a mano en Stock.`);
      }
    }
  }
  for (const item of compra.items) {
    if (!item.productoId) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId: compra.depositoId, tipo: 'egreso', cantidad: item.cantidad,
      motivo: 'Anulación de compra', observaciones: `Anulación de compra ${compra.numero ? '#' + compra.numero : ''}`.trim(),
      compraId: compra._id, usuarioNombre: compra.usuarioNombre, fecha: new Date()
    });
  }
}

// -----------------------------------------------------------------------
// Numeración interna — correlativo simple por organización, NO fiscal,
// en su propio contador (no se mezcla con el de Ventas).
// -----------------------------------------------------------------------

async function proximoNumero(db, orgId) {
  const r = await db.collection('compras_contadores').findOneAndUpdate(
    { orgId },
    { $inc: { ultimo: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return doc ? doc.ultimo : 1;
}

// Valida y normaliza los ítems de una compra contra el catálogo de
// Productos — el precio unitario se autocompleta con `producto.costo`
// (es lo que se está pagando, no el precio de venta) pero se puede pisar.
async function normalizarItems(db, req, itemsRaw) {
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw err(400, 'La compra necesita al menos un ítem');
  const items = [];
  let subtotal = 0;
  for (const it of itemsRaw) {
    const productoId = it.productoId ? toObjectId(it.productoId) : null;
    let nombre = normalizarTexto(it.nombre);
    let sku = normalizarTexto(it.sku) || null;
    let precioBase = it.precioUnitario;
    if (productoId) {
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(400, 'Uno de los productos de la compra no existe (o no pertenece a esta organización)');
      nombre = producto.nombre;
      sku = producto.sku || null;
      if (precioBase === undefined || precioBase === null || precioBase === '') precioBase = producto.costo;
    }
    if (!nombre) throw err(400, 'Falta el nombre de un ítem de la compra');
    const cantidad = normalizarCantidadPositiva(it.cantidad, `La cantidad de "${nombre}"`);
    const precioUnitario = normalizarMontoNoNegativo(precioBase, `El precio unitario de "${nombre}"`);
    const itemSubtotal = cantidad * precioUnitario;
    subtotal += itemSubtotal;
    items.push({ productoId, sku, nombre, cantidad, precioUnitario, subtotal: itemSubtotal });
  }
  return { items, subtotal };
}

function calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto) {
  let total = subtotal;
  if (descuentoPorcentaje) total -= total * (descuentoPorcentaje / 100);
  if (descuentoMonto) total -= descuentoMonto;
  return Math.max(0, total);
}

// -----------------------------------------------------------------------
// Compras — CRUD + acciones
// -----------------------------------------------------------------------

router.get('/', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.proveedorId) {
      const pid = toObjectId(req.query.proveedorId);
      if (!pid) throw err(400, 'proveedorId inválido');
      match.proveedorId = pid;
    }
    if (req.query.estado) {
      if (!ESTADOS_VALIDOS.includes(req.query.estado)) throw err(400, 'Estado inválido');
      match.estado = req.query.estado;
    }
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const limite = Math.min(Number(req.query.limite) || 200, 500);
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('compras').find(match).sort({ fecha: -1, numero: -1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Export en Excel (.xlsx) — mismos filtros que GET /, hasta 2000 filas
// (una fila por compra, no por ítem — ver comentario de COLUMNAS_COMPRAS_EXPORT).
router.get('/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.proveedorId) {
      const pid = toObjectId(req.query.proveedorId);
      if (pid) match.proveedorId = pid;
    }
    if (req.query.estado && ESTADOS_VALIDOS.includes(req.query.estado)) match.estado = req.query.estado;
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('compras').find(match).sort({ fecha: -1, numero: -1 }).limit(2000).toArray();
    });
    exportarXlsx(res, 'compras.xlsx', COLUMNAS_COMPRAS_EXPORT, lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const compra = await conReintento(async () => {
      const db = await getDb();
      return db.collection('compras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!compra) throw err(404, 'Compra no encontrada');
    res.json(compra);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar una compra.');
    const body = req.body || {};
    const proveedorId = toObjectId(body.proveedorId);
    if (!proveedorId) throw err(400, 'Elegí un proveedor');
    const tipoRecepcion = normalizarTexto(body.tipoRecepcion).toLowerCase();
    if (!TIPOS_RECEPCION_VALIDOS.includes(tipoRecepcion)) throw err(400, `Tipo de recepción inválido (opciones: ${TIPOS_RECEPCION_VALIDOS.join(', ')})`);
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const depositoId = body.depositoId ? toObjectId(body.depositoId) : null;
    if (tipoRecepcion === 'inmediata' && !depositoId) throw err(400, 'Elegí a qué depósito le vas a ingresar el stock.');
    const condicionPago = normalizarTexto(body.condicionPago);
    const descuentoPorcentaje = body.descuentoPorcentaje ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : 0;
    const descuentoMonto = body.descuentoMonto ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : 0;
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: proveedorId }, filtroOrg(req)));
      if (!proveedor) throw err(400, 'El proveedor no existe (o no pertenece a esta organización)');
      const { items, subtotal } = await normalizarItems(db, req, body.items);
      const total = calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto);
      const numero = await proximoNumero(db, req.orgId);
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();

      const compra = {
        numero,
        proveedorId,
        proveedorNombre: proveedor.razonSocial || proveedor.nombreFantasia || '',
        fecha,
        moneda,
        cotizacionDolar: body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null,
        condicionPago: condicionPago || proveedor.condicionPago || '',
        tipoRecepcion,
        depositoId,
        estado: tipoRecepcion === 'inmediata' ? 'recibida' : 'pendiente',
        items,
        descuentoPorcentaje,
        descuentoMonto,
        subtotal,
        total,
        pagos: [],
        totalPagado: 0,
        saldoPendiente: total,
        observaciones,
        stockIngresado: false,
        stockIngresadoEn: null,
        recibidaEn: null,
        anuladaEn: null,
        anuladaPor: null,
        anuladaMotivo: null,
        usuarioNombre,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };

      const r = await db.collection('compras').insertOne(compra);
      compra._id = r.insertedId;

      if (tipoRecepcion === 'inmediata') {
        await ingresarStockDeCompra(db, req, compra, depositoId);
        await db.collection('compras').updateOne({ _id: compra._id }, { $set: { stockIngresado: true, stockIngresadoEn: ahora, recibidaEn: ahora } });
        compra.stockIngresado = true;
        compra.stockIngresadoEn = ahora;
        compra.recibidaEn = ahora;
      }
      return compra;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Recibe una compra que había quedado "pendiente" — recién acá se
// elige/confirma el depósito y se ingresa el stock, una sola vez.
router.post('/:id/recibir', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const depositoId = toObjectId(req.body && req.body.depositoId);
    if (!depositoId) throw err(400, 'Elegí a qué depósito le vas a ingresar el stock.');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const compra = await db.collection('compras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!compra) throw err(404, 'Compra no encontrada');
      if (compra.estado === 'anulada') throw err(400, 'Esta compra está anulada.');
      if (compra.estado === 'recibida') throw err(400, 'Esta compra ya fue recibida.');

      await ingresarStockDeCompra(db, req, compra, depositoId);
      const ahora = new Date();
      await db.collection('compras').updateOne(
        { _id: id },
        { $set: { estado: 'recibida', depositoId, stockIngresado: true, stockIngresadoEn: ahora, recibidaEn: ahora, updatedAt: ahora } }
      );
      return db.collection('compras').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anula una compra. Si ya tenía el stock ingresado, lo revierte
// automáticamente (egreso) — se bloquea si ya no hay stock suficiente
// para revertir (por ejemplo, si ya se vendió parte de lo comprado).
router.post('/:id/anular', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = normalizarTexto(req.body && req.body.motivo);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const compra = await db.collection('compras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!compra) throw err(404, 'Compra no encontrada');
      if (compra.estado === 'anulada') throw err(400, 'Esta compra ya está anulada.');

      if (compra.stockIngresado) await egresarStockDeCompra(db, req, compra);

      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      await db.collection('compras').updateOne(
        { _id: id },
        { $set: { estado: 'anulada', anuladaEn: ahora, anuladaPor: usuarioNombre, anuladaMotivo: motivo, updatedAt: ahora } }
      );
      return db.collection('compras').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Registra un pago contra la compra (parcial o total) — append-only,
// mismo criterio que los cobros de Ventas y el libro de Stock.
router.post('/:id/pagos', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const tipoValor = normalizarTexto(body.tipoValor).toLowerCase();
    if (!TIPOS_VALOR_VALIDOS.includes(tipoValor)) throw err(400, `Tipo de valor inválido (opciones: ${TIPOS_VALOR_VALIDOS.join(', ')})`);
    const monto = normalizarMontoNoNegativo(body.monto, 'El monto');
    if (monto <= 0) throw err(400, 'El monto del pago tiene que ser mayor a 0.');
    const nota = normalizarTexto(body.nota);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const compra = await db.collection('compras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!compra) throw err(404, 'Compra no encontrada');
      if (compra.estado === 'anulada') throw err(400, 'Esta compra está anulada, no se le pueden registrar pagos.');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const pago = { tipoValor, monto, fecha: new Date(), nota, usuarioNombre };
      const totalPagado = (compra.totalPagado || 0) + monto;
      const saldoPendiente = Math.max(0, compra.total - totalPagado);
      await db.collection('compras').updateOne(
        { _id: id },
        { $push: { pagos: pago }, $set: { totalPagado, saldoPendiente, updatedAt: new Date() } }
      );
      return db.collection('compras').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
