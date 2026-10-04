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
// Tesorería (2/10/2026): un pago en efectivo/cuenta/tarjeta sale YA de
// una caja/banco real; un pago en cheque propio crea el cheque
// "emitido" (sin mover plata hasta que se confirme el pago, desde
// Tesorería). Se reusa esta función de tesoreria.js en vez de
// reimplementarla — ver la nota en tesoreria.js.
const { aplicarMovimientoCuenta } = require('./tesoreria');

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

// Comprobante fiscal (4/10/2026, pedido de Mato: "hay que agregar
// comprobantes con numeracion y fiscal o no para luego poder sacar
// libro iva compra y venta") — numeración real del comprobante que
// emitió el proveedor (punto de venta + número, tal cual figura en el
// papel) más el IVA discriminado, para poder armar más adelante el
// Libro IVA Compras. `esFiscal` se calcula solo a partir del tipo (no
// es un campo que se tipee aparte) — Recibo/Ticket/Otro no cuentan
// para el Libro IVA, el resto sí.
const TIPOS_COMPROBANTE_VALIDOS = [
  'factura_a', 'factura_b', 'factura_c', 'factura_m',
  'nota_credito_a', 'nota_credito_b', 'nota_credito_c', 'nota_credito_m',
  'nota_debito_a', 'nota_debito_b', 'nota_debito_c', 'nota_debito_m',
  'recibo', 'ticket', 'otro'
];
const TIPOS_COMPROBANTE_FISCALES = new Set([
  'factura_a', 'factura_b', 'factura_c', 'factura_m',
  'nota_credito_a', 'nota_credito_b', 'nota_credito_c', 'nota_credito_m',
  'nota_debito_a', 'nota_debito_b', 'nota_debito_c', 'nota_debito_m'
]);
const TIPO_COMPROBANTE_LABEL = {
  factura_a: 'Factura A', factura_b: 'Factura B', factura_c: 'Factura C', factura_m: 'Factura M',
  nota_credito_a: 'Nota de Crédito A', nota_credito_b: 'Nota de Crédito B', nota_credito_c: 'Nota de Crédito C', nota_credito_m: 'Nota de Crédito M',
  nota_debito_a: 'Nota de Débito A', nota_debito_b: 'Nota de Débito B', nota_debito_c: 'Nota de Débito C', nota_debito_m: 'Nota de Débito M',
  recibo: 'Recibo', ticket: 'Ticket', otro: 'Otro (no fiscal)'
};
// Alícuotas de IVA vigentes en Argentina (0 = exento/no gravado, para
// que el ítem se cargue en importeExento en vez de importeNeto).
const ALICUOTAS_IVA_VALIDAS = [0, 2.5, 5, 10.5, 21, 27];

// Valida los datos del comprobante que NO dependen de los ítems (el
// IVA, en cambio, se calcula por artículo — ver calcularComprobanteDesdeItems
// más abajo, 4/10/2026: "el tema del iva debe ir por articulo no por
// factura", corrección de Mato). Compartido entre Compras y Gastos
// (misma estructura, duplicado a propósito: cada router maneja su
// propia colección y no hay un módulo común de "comprobantes" todavía).
function normalizarComprobante(body) {
  const tipoComprobante = normalizarTexto(body.tipoComprobante).toLowerCase();
  if (!TIPOS_COMPROBANTE_VALIDOS.includes(tipoComprobante)) throw err(400, `Tipo de comprobante inválido (opciones: ${TIPOS_COMPROBANTE_VALIDOS.join(', ')})`);
  const puntoVenta = normalizarTexto(body.puntoVenta);
  if (!puntoVenta) throw err(400, 'Falta el punto de venta del comprobante');
  const comprobanteNumero = normalizarTexto(body.comprobanteNumero);
  if (!comprobanteNumero) throw err(400, 'Falta el número del comprobante');
  const esFiscal = TIPOS_COMPROBANTE_FISCALES.has(tipoComprobante);
  return { tipoComprobante, puntoVenta, comprobanteNumero, esFiscal };
}

// Columnas del Excel de export (30/9/2026, pedido de Mato: "todas las
// bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js. Solo EXPORT, mismo motivo que en Ventas: una compra se
// genera operativamente (recepción/pagos ligados a movimientos reales de
// stock), no se carga masiva desde Excel.
const COLUMNAS_COMPRAS_EXPORT = [
  { clave: 'numero', titulo: 'Nº interno' },
  { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
  { clave: 'proveedorNombre', titulo: 'Proveedor' },
  { clave: 'tipoComprobanteLabel', titulo: 'Tipo comprobante' },
  { clave: 'puntoVenta', titulo: 'Punto de venta' },
  { clave: 'comprobanteNumero', titulo: 'Número comprobante' },
  { clave: 'esFiscal', titulo: 'Fiscal' },
  { clave: 'condicionPago', titulo: 'Condición de pago' },
  { clave: 'tipoRecepcion', titulo: 'Tipo de recepción' },
  { clave: 'estado', titulo: 'Estado' },
  { clave: 'moneda', titulo: 'Moneda' },
  { clave: 'importeNeto', titulo: 'Importe neto', tipo: 'numero' },
  { clave: 'importeIva', titulo: 'Importe IVA', tipo: 'numero' },
  { clave: 'importeExento', titulo: 'Importe exento', tipo: 'numero' },
  { clave: 'importeTotalComprobante', titulo: 'Total comprobante', tipo: 'numero' },
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
    // IVA por artículo (4/10/2026, corrección de Mato: "el tema del iva
    // debe ir por articulo no por factura" — cada ítem puede tener su
    // propia alícuota, no una sola para todo el comprobante).
    const alicuotaIva = Number(it.alicuotaIva);
    if (!ALICUOTAS_IVA_VALIDAS.includes(alicuotaIva)) throw err(400, `Alícuota de IVA inválida para "${nombre}" (opciones: ${ALICUOTAS_IVA_VALIDAS.join(', ')})`);
    const itemSubtotal = cantidad * precioUnitario;
    const itemIva = Math.round(itemSubtotal * alicuotaIva) / 100;
    subtotal += itemSubtotal;
    items.push({ productoId, sku, nombre, cantidad, precioUnitario, subtotal: itemSubtotal, alicuotaIva, importeIva: itemIva });
  }
  return { items, subtotal };
}

// Arma el desglose fiscal del comprobante A PARTIR de los ítems (cada
// uno con su propia alícuota) — no es un dato que se tipee aparte a
// nivel comprobante. Los ítems con alícuota 0 se consideran exentos/no
// gravados; el resto suma a neto gravado + su IVA correspondiente.
function calcularComprobanteDesdeItems(items) {
  let importeNeto = 0, importeExento = 0, importeIva = 0;
  for (const it of items) {
    if (it.alicuotaIva === 0) importeExento += it.subtotal;
    else importeNeto += it.subtotal;
    importeIva += it.importeIva;
  }
  importeNeto = Math.round(importeNeto * 100) / 100;
  importeExento = Math.round(importeExento * 100) / 100;
  importeIva = Math.round(importeIva * 100) / 100;
  const importeTotalComprobante = Math.round((importeNeto + importeIva + importeExento) * 100) / 100;
  return { importeNeto, importeExento, importeIva, importeTotalComprobante };
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
    const listaExport = lista.map(c => Object.assign({}, c, {
      tipoComprobanteLabel: c.tipoComprobante ? (TIPO_COMPROBANTE_LABEL[c.tipoComprobante] || c.tipoComprobante) : '',
      esFiscal: c.tipoComprobante ? (c.esFiscal ? 'Sí' : 'No') : ''
    }));
    exportarXlsx(res, 'compras.xlsx', COLUMNAS_COMPRAS_EXPORT, listaExport);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Lista de pagos a proveedores (4/10/2026) — pestaña "Pagos" en
// Compras: junta tanto los pagos a cuenta como los que se registran
// desde el detalle de una compra puntual (ambos caen en esta misma
// colección, ver aplicarPagoProveedor).
router.get('/pagos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.proveedorId) {
      const pid = toObjectId(req.query.proveedorId);
      if (!pid) throw err(400, 'proveedorId inválido');
      match.proveedorId = pid;
    }
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const limite = Math.min(Number(req.query.limite) || 200, 500);
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('compras_pagos').find(match).sort({ fecha: -1, createdAt: -1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Saldo total adeudado por proveedor (4/10/2026, pedido de Mato) — suma
// el saldoPendiente de todas las compras activas (no anuladas) de cada
// proveedor, para la pestaña "Pagos".
router.get('/saldos-proveedores', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ estado: { $ne: 'anulada' }, saldoPendiente: { $gt: 0 } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('compras').aggregate([
        { $match: match },
        { $group: { _id: '$proveedorId', proveedorNombre: { $first: '$proveedorNombre' }, saldoPendiente: { $sum: '$saldoPendiente' }, cantidadCompras: { $sum: 1 } } },
        { $sort: { saldoPendiente: -1 } }
      ]).toArray();
    });
    res.json(lista.map(x => ({ proveedorId: x._id, proveedorNombre: x.proveedorNombre, saldoPendiente: Math.round(x.saldoPendiente * 100) / 100, cantidadCompras: x.cantidadCompras })));
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
    // Comprobante fiscal (4/10/2026) — numeración real del proveedor +
    // IVA discriminado, para el Libro IVA Compras.
    const comprobante = normalizarComprobante(body);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: proveedorId }, filtroOrg(req)));
      if (!proveedor) throw err(400, 'El proveedor no existe (o no pertenece a esta organización)');
      // Evita cargar el mismo comprobante dos veces para el mismo
      // proveedor (mismo tipo + punto de venta + número) — no bloquea
      // comprobantes anulados, por si hay que corregir y volver a cargar.
      const dupe = await db.collection('compras').findOne(Object.assign({
        proveedorId, tipoComprobante: comprobante.tipoComprobante,
        puntoVenta: comprobante.puntoVenta, comprobanteNumero: comprobante.comprobanteNumero,
        estado: { $ne: 'anulada' }
      }, filtroOrg(req)));
      if (dupe) throw err(400, `Ya hay una compra cargada con ese comprobante (${TIPO_COMPROBANTE_LABEL[comprobante.tipoComprobante]} ${comprobante.puntoVenta}-${comprobante.comprobanteNumero}) para este proveedor — es la compra #${dupe.numero}.`);
      const { items, subtotal } = await normalizarItems(db, req, body.items);
      const total = calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto);
      const fiscalItems = calcularComprobanteDesdeItems(items);
      const numero = await proximoNumero(db, req.orgId);
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();

      const compra = {
        numero,
        tipoComprobante: comprobante.tipoComprobante,
        puntoVenta: comprobante.puntoVenta,
        comprobanteNumero: comprobante.comprobanteNumero,
        esFiscal: comprobante.esFiscal,
        importeNeto: fiscalItems.importeNeto,
        importeIva: fiscalItems.importeIva,
        importeExento: fiscalItems.importeExento,
        importeTotalComprobante: fiscalItems.importeTotalComprobante,
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

      // Actualiza el costo del producto con lo que efectivamente se
      // pagó en esta compra (3/10/2026, pedido de Mato: "que la compra
      // actualice el costo del producto") — se pisa con el precio
      // unitario de CADA ítem comprado, en el orden en que vienen (si
      // el mismo producto aparece dos veces en la misma compra, gana el
      // último). Los ítems cargados a mano (sin productoId) no tocan
      // ningún costo.
      for (const item of items) {
        if (!item.productoId) continue;
        await db.collection('productos_catalogo').updateOne(
          Object.assign({ _id: item.productoId }, filtroOrg(req)),
          { $set: { costo: item.precioUnitario, updatedAt: new Date() } }
        );
      }

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
// Valida los datos del "valor" de un pago (tipo + de dónde sale, o
// datos del cheque/tarjeta) — compartido entre el pago de una compra
// puntual y el pago a cuenta (4/10/2026, pedido de Mato: "agreguemos
// pagos... para poder hacer pago a un proveedor a cuenta").
function normalizarDatosPago(body, fecha) {
  const tipoValor = normalizarTexto(body.tipoValor).toLowerCase();
  if (!TIPOS_VALOR_VALIDOS.includes(tipoValor)) throw err(400, `Tipo de valor inválido (opciones: ${TIPOS_VALOR_VALIDOS.join(', ')})`);

  // Tesorería (2/10/2026): efectivo/cuenta/tarjeta sale ya de una caja
  // o banco; cheque crea un cheque propio "emitido" (no mueve plata
  // todavía — eso pasa al confirmar el pago, desde Tesorería). Pedido
  // de Mato: efectivo SOLO puede salir de una caja; cuenta
  // (transferencia) y tarjeta solo pueden salir de un banco.
  let cuentaTipo = null, cuentaId = null;
  if (tipoValor !== 'cheque') {
    cuentaTipo = normalizarTexto(body.cuentaTipo).toLowerCase();
    if (!['caja', 'banco'].includes(cuentaTipo)) throw err(400, 'Elegí de qué caja o banco sale el pago.');
    if (tipoValor === 'efectivo' && cuentaTipo !== 'caja') throw err(400, 'Un pago en efectivo solo puede salir de una caja.');
    if ((tipoValor === 'cuenta' || tipoValor === 'tarjeta') && cuentaTipo !== 'banco') throw err(400, 'Un pago por transferencia o tarjeta solo puede salir de un banco.');
    cuentaId = toObjectId(body.cuentaId);
    if (!cuentaId) throw err(400, 'Caja/banco inválido');
  }

  let chequeDatos = null;
  if (tipoValor === 'cheque') {
    chequeDatos = {
      numero: normalizarTexto(body.chequeNumero),
      cuentaId: toObjectId(body.chequeCuentaId),
      fechaEmision: body.chequeFechaEmision ? new Date(body.chequeFechaEmision) : fecha,
      fechaVencimiento: body.chequeFechaVencimiento ? new Date(body.chequeFechaVencimiento) : null,
      observaciones: normalizarTexto(body.chequeObservaciones)
    };
    if (!chequeDatos.numero) throw err(400, 'Falta el número de cheque.');
    if (!chequeDatos.cuentaId) throw err(400, 'Elegí de qué banco propio sale el cheque.');
    if (!chequeDatos.fechaVencimiento) throw err(400, 'Falta la fecha de vencimiento del cheque.');
  }

  // Tarjeta (2/10/2026, mismo pedido de Mato que en Ventas): lote y
  // cupón son los que pide Dux; entidad/tipo/cuotas/código de
  // autorización se suman por los datos habituales de un cupón real
  // (razonamiento propio, Dux no los enumera).
  let tarjetaDatos = null;
  if (tipoValor === 'tarjeta') {
    tarjetaDatos = {
      tarjetaEntidad: normalizarTexto(body.tarjetaEntidad),
      tarjetaTipo: normalizarTexto(body.tarjetaTipo).toLowerCase(),
      tarjetaCuotas: body.tarjetaCuotas ? Number(body.tarjetaCuotas) : 1,
      tarjetaLote: normalizarTexto(body.tarjetaLote),
      tarjetaCupon: normalizarTexto(body.tarjetaCupon),
      tarjetaCodigoAutorizacion: normalizarTexto(body.tarjetaCodigoAutorizacion)
    };
  }
  return { tipoValor, cuentaTipo, cuentaId, chequeDatos, tarjetaDatos };
}

// Registra UN pago real (una salida de caja/banco, o un cheque emitido)
// y lo reparte entre una o más compras del mismo proveedor, elegidas a
// mano (4/10/2026, pedido de Mato: "que podamos elegir a qué factura
// aplicarlo" — nada de reparto automático). Queda además un registro
// único en `compras_pagos` para que se pueda ver el pago completo en la
// pestaña "Pagos", más allá de cómo haya quedado repartido.
async function aplicarPagoProveedor(db, req, { proveedorId, proveedorNombre, moneda, tipoValor, montoTotal, fecha, nota, cuentaTipo, cuentaId, chequeDatos, tarjetaDatos, aplicaciones, motivoMovimiento }) {
  const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
  let chequeId = null;

  if (tipoValor === 'cheque') {
    const cheque = Object.assign({
      tipo: 'propio', moneda: moneda || 'ARS', monto: montoTotal, estado: 'emitido',
      proveedorId: proveedorId || null, proveedorNombre: proveedorNombre || '',
      ventaId: null, compraId: aplicaciones.length === 1 ? aplicaciones[0].compraId : null, clienteId: null, clienteNombre: '', librador: '',
      banco: '', depositadoEnCuentaId: null, endosadoA: null,
      usuarioNombre, fecha, orgId: req.orgId, createdAt: new Date(), updatedAt: new Date()
    }, chequeDatos);
    const { insertedId } = await db.collection('cheques').insertOne(cheque);
    chequeId = insertedId;
  } else {
    const observacionesMovimiento = tipoValor === 'tarjeta'
      ? [nota, `Lote ${tarjetaDatos.tarjetaLote || '—'} / Cupón ${tarjetaDatos.tarjetaCupon || '—'}`].filter(Boolean).join(' — ')
      : nota;
    await aplicarMovimientoCuenta(db, req, {
      cuentaTipo, cuentaId, tipo: 'egreso', monto: montoTotal, moneda: moneda || 'ARS',
      motivo: motivoMovimiento, observaciones: observacionesMovimiento, origen: 'compra', fecha
    });
  }

  const compras = [];
  const aplicacionesGuardadas = [];
  for (const aplic of aplicaciones) {
    const compra = await db.collection('compras').findOne(Object.assign({ _id: aplic.compraId }, filtroOrg(req)));
    if (!compra) throw err(404, 'Una de las compras elegidas no existe (o no pertenece a esta organización)');
    if (compra.estado === 'anulada') throw err(400, `La compra #${compra.numero} está anulada, no se le pueden registrar pagos.`);
    if (String(compra.proveedorId) !== String(proveedorId)) throw err(400, `La compra #${compra.numero} no es de este proveedor.`);
    if (aplic.monto > compra.saldoPendiente + 0.01) throw err(400, `El monto aplicado a la compra #${compra.numero} (${aplic.monto}) es mayor que su saldo pendiente (${compra.saldoPendiente}).`);

    const pago = Object.assign(
      { tipoValor, monto: aplic.monto, fecha, nota, usuarioNombre },
      cuentaTipo ? { cuentaTipo, cuentaId } : {},
      chequeId ? { chequeId } : {},
      tarjetaDatos || {}
    );
    const totalPagado = (compra.totalPagado || 0) + aplic.monto;
    const saldoPendiente = Math.max(0, compra.total - totalPagado);
    await db.collection('compras').updateOne(
      { _id: aplic.compraId },
      { $push: { pagos: pago }, $set: { totalPagado, saldoPendiente, updatedAt: new Date() } }
    );
    const compraActualizada = await db.collection('compras').findOne({ _id: aplic.compraId });
    compras.push(compraActualizada);
    aplicacionesGuardadas.push({ compraId: aplic.compraId, compraNumero: compra.numero, monto: aplic.monto });
  }

  const ahora = new Date();
  const pagoCuenta = Object.assign({
    proveedorId, proveedorNombre, fecha, tipoValor, monto: montoTotal, nota, usuarioNombre,
    aplicaciones: aplicacionesGuardadas, orgId: req.orgId, createdAt: ahora
  }, cuentaTipo ? { cuentaTipo, cuentaId } : {}, chequeId ? { chequeId } : {}, tarjetaDatos || {});
  const r = await db.collection('compras_pagos').insertOne(pagoCuenta);
  pagoCuenta._id = r.insertedId;

  return { pagoCuenta, compras };
}

router.post('/:id/pagos', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const monto = normalizarMontoNoNegativo(body.monto, 'El monto');
    if (monto <= 0) throw err(400, 'El monto del pago tiene que ser mayor a 0.');
    const nota = normalizarTexto(body.nota);
    // Fecha del pago editable (2/10/2026, mismo pedido de Mato que en
    // Ventas: por si se carga más tarde con la fecha real en que pasó).
    const fecha = body.fecha ? new Date(body.fecha) : new Date();
    const datosPago = normalizarDatosPago(body, fecha);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const compra = await db.collection('compras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!compra) throw err(404, 'Compra no encontrada');
      if (compra.estado === 'anulada') throw err(400, 'Esta compra está anulada, no se le pueden registrar pagos.');
      if (monto > compra.saldoPendiente + 0.01) throw err(400, `El monto no puede ser mayor que el saldo pendiente (${compra.saldoPendiente}).`);

      const { compras } = await aplicarPagoProveedor(db, req, Object.assign({
        proveedorId: compra.proveedorId, proveedorNombre: compra.proveedorNombre, moneda: compra.moneda,
        montoTotal: monto, fecha, nota, aplicaciones: [{ compraId: id, monto }],
        motivoMovimiento: `Pago compra Nº ${compra.numero}`
      }, datosPago));
      return compras[0];
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Pago a cuenta de un proveedor (4/10/2026, pedido de Mato) — una sola
// salida real de caja/banco (o un solo cheque) que se reparte a mano
// entre una o más compras pendientes de ese proveedor, elegidas desde
// la pestaña "Pagos".
router.post('/pagos-cuenta', authAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const proveedorId = toObjectId(body.proveedorId);
    if (!proveedorId) throw err(400, 'Elegí un proveedor');
    const monto = normalizarMontoNoNegativo(body.monto, 'El monto');
    if (monto <= 0) throw err(400, 'El monto del pago tiene que ser mayor a 0.');
    const nota = normalizarTexto(body.nota);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();
    const datosPago = normalizarDatosPago(body, fecha);

    const aplicacionesRaw = Array.isArray(body.aplicaciones) ? body.aplicaciones : [];
    if (!aplicacionesRaw.length) throw err(400, 'Elegí a qué compra(s) aplicar el pago.');
    const aplicaciones = aplicacionesRaw.map(a => {
      const compraId = toObjectId(a.compraId);
      const montoAplicado = normalizarMontoNoNegativo(a.monto, 'El monto aplicado a una compra');
      if (!compraId) throw err(400, 'Una de las compras elegidas es inválida');
      if (montoAplicado <= 0) throw err(400, 'El monto aplicado a cada compra tiene que ser mayor a 0');
      return { compraId, monto: montoAplicado };
    });
    const sumaAplicaciones = Math.round(aplicaciones.reduce((a, x) => a + x.monto, 0) * 100) / 100;
    if (Math.abs(sumaAplicaciones - monto) > 0.01) throw err(400, `Lo repartido entre las compras (${sumaAplicaciones}) no coincide con el monto del pago (${monto}).`);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: proveedorId }, filtroOrg(req)));
      if (!proveedor) throw err(400, 'El proveedor no existe (o no pertenece a esta organización)');
      const proveedorNombre = proveedor.razonSocial || proveedor.nombreFantasia || '';

      const { pagoCuenta } = await aplicarPagoProveedor(db, req, Object.assign({
        proveedorId, proveedorNombre, moneda: 'ARS',
        montoTotal: monto, fecha, nota, aplicaciones,
        motivoMovimiento: `Pago a cuenta — ${proveedorNombre}`
      }, datosPago));
      return pagoCuenta;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
