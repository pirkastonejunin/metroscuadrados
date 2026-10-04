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

// 4/10/2026, bug real reportado por Mato ("al cargar una orden o una
// compra no trae proveedor ni producto" — el dato estaba bien en la
// base, el fetch manual a mano andaba, pero las 5 llamadas en paralelo
// de cargarListasBase() a veces no): el `if (!mongoClient)` de acá
// abajo no alcanza para evitar la carrera cuando llegan varios
// requests al mismo tiempo contra un proceso recién arrancado. Como
// `new MongoClient(...)` se asignaba de forma SÍNCRONA antes del
// `await connect()`, un segundo request que entraba mientras el
// primero todavía estaba conectando veía `mongoClient` ya asignado
// (verdadero) y seguía de largo usándolo SIN esperar a que
// `connect()` hubiera terminado — con mala suerte, ese segundo (o
// tercer, cuarto...) request podía fallar o devolver vacío. El fix:
// en vez de guardar el cliente, se guarda la PROMESA de conexión —
// así cualquier request que llegue mientras se está conectando espera
// esa misma promesa en vez de asumir que ya está lista.
let mongoClientPromise = null;
async function getDb() {
  if (!mongoClientPromise) {
    mongoClientPromise = new MongoClient(process.env.MONGODB_URI).connect()
      .catch(e => { mongoClientPromise = null; throw e; });
  }
  const cliente = await mongoClientPromise;
  return cliente.db(DB_NAME);
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    mongoClientPromise = null;
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

// Búsqueda de productos en el servidor (4/10/2026): con +25.000 productos
// bajar el catálogo entero tardaba ~7 segundos en cada carga. Ahora el
// buscador pide solo lo que se está tipeando: ?q=texto (cada palabra
// tiene que aparecer en el SKU o en el nombre, en cualquier orden), o
// ?ids=a,b,c para traer productos puntuales (ej. los de una orden).
function escaparRegex(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
router.get('/productos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const limite = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    if (req.query.ids) {
      const ids = String(req.query.ids).split(',').map(toObjectId).filter(Boolean).slice(0, 200);
      match._id = { $in: ids };
    } else {
      const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
      if (palabras.length) {
        match.$and = palabras.map(p => {
          const re = new RegExp(escaparRegex(p), 'i');
          return { $or: [{ sku: re }, { nombre: re }] };
        });
      }
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo')
        .find(match, { projection: { sku: 1, nombre: 1, costo: 1, moneda: 1, unidad: 1, unidadesPorBulto: 1, proveedorId: 1 } })
        .sort({ nombre: 1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/cotizacion-dolar', authAdmin, async (req, res) => {
  try {
    const valor = await conReintento(async () => {
      const db = await getDb();
      return obtenerCotizacionOrg(db, req);
    });
    res.json({ valor });
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

async function aplicarMovimientoStock(db, req, { productoId, depositoId, tipo, cantidad, motivo, observaciones, compraId, ordenId, usuarioNombre, fecha }) {
  const movimiento = {
    productoId, depositoId, tipo, cantidad, motivo,
    sucursal: '', codigoExterno: '', observaciones: observaciones || '',
    compraId: compraId || null, ordenId: ordenId || null, usuarioNombre, fecha: fecha || new Date(), orgId: req.orgId, createdAt: new Date()
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
    // `cantidadYaRecibida` (si está presente) es lo que de este ítem ya
    // había entrado a stock antes, por una recepción directa contra la
    // orden de compra (ver POST /ordenes/:id/recibir) — eso no se
    // vuelve a ingresar. `cantidadIngresoStock` queda registrado en el
    // ítem para que una anulación posterior revierta exactamente esto
    // (ver egresarStockDeCompra), no el total facturado.
    const aIngresar = Math.round((item.cantidad - (item.cantidadYaRecibida || 0)) * 1000) / 1000;
    item.cantidadIngresoStock = aIngresar;
    if (!item.productoId || aIngresar <= 0) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId, tipo: 'ingreso', cantidad: aIngresar,
      motivo: 'Compra', observaciones: `Compra ${compra.numero ? '#' + compra.numero : ''}`.trim(),
      compraId: compra._id, usuarioNombre: compra.usuarioNombre, fecha: compra.fecha
    });
  }
  await db.collection('compras').updateOne({ _id: compra._id }, { $set: { items: compra.items } });
}

// Reversa el stock de una compra ya recibida (usado al anular) — un
// egreso por cada ítem, con la misma validación de stock negativo que
// cualquier egreso (si ya se vendió parte de lo que entró, no se puede
// sacar de nuevo sin dejarlo en negativo, salvo `aceptaStockNegativo`).
async function egresarStockDeCompra(db, req, compra) {
  if (!compra.depositoId) return;
  const deposito = await db.collection('depositos').findOne(Object.assign({ _id: compra.depositoId }, filtroOrg(req)));
  // `cantidadIngresoStock` (si está presente) es lo que ESTA compra
  // realmente empujó a stock — puede ser menos que `cantidad` cuando la
  // compra viene de convertir una orden que ya tenía parte recibida de
  // antes (ver POST /ordenes/:id/convertir). Si no está, es una compra
  // "normal" (no por orden) y se ingresó el total, como siempre.
  for (const item of compra.items) {
    if (!item.productoId) continue;
    const aRevertir = item.cantidadIngresoStock != null ? item.cantidadIngresoStock : item.cantidad;
    if (aRevertir <= 0) continue;
    const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: item.productoId }, filtroOrg(req)));
    if (!producto) continue;
    if (!producto.aceptaStockNegativo) {
      const actual = await db.collection('stock_actual').findOne(Object.assign({ productoId: item.productoId, depositoId: compra.depositoId }, filtroOrg(req)));
      const cantidadActual = actual ? actual.cantidad : 0;
      if (aRevertir > cantidadActual) {
        throw err(400, `No se puede anular: ya no hay suficiente stock de "${item.nombre}" en ${deposito ? deposito.nombre : 'el depósito'} para revertir el ingreso (disponible: ${cantidadActual}, probablemente ya se vendió). Corregilo con un movimiento de ajuste a mano en Stock.`);
      }
    }
  }
  for (const item of compra.items) {
    if (!item.productoId) continue;
    const aRevertir = item.cantidadIngresoStock != null ? item.cantidadIngresoStock : item.cantidad;
    if (aRevertir <= 0) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId: compra.depositoId, tipo: 'egreso', cantidad: aRevertir,
      motivo: 'Anulación de compra', observaciones: `Anulación de compra ${compra.numero ? '#' + compra.numero : ''}`.trim(),
      compraId: compra._id, usuarioNombre: compra.usuarioNombre, fecha: new Date()
    });
  }
}

// -----------------------------------------------------------------------
// Numeración interna — correlativo simple por organización, NO fiscal,
// en su propio contador (no se mezcla con el de Ventas).
// -----------------------------------------------------------------------

// Cotización del dólar de la organización (la misma que usa Productos
// para las listas de precio — colección config_general). null si no hay.
async function obtenerCotizacionOrg(db, req) {
  const doc = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' });
  return doc && doc.valor > 0 ? Number(doc.valor) : null;
}

// Cotización a usar en un documento: la que se cargó a mano o, si no,
// la vigente de la organización. En USD, si `requerida` y no hay
// ninguna, se rechaza (sin cotización no se puede pasar a pesos para
// el Libro IVA ni comparar contra costos en pesos).
async function resolverCotizacion(db, req, moneda, cotizacionCargada, requerida) {
  if (moneda !== 'USD') return cotizacionCargada || null;
  if (cotizacionCargada > 0) return cotizacionCargada;
  const org = await obtenerCotizacionOrg(db, req);
  if (org) return org;
  if (requerida) throw err(400, 'Un documento en dólares necesita la cotización del dólar: cargala en el formulario o configurala en Productos.');
  return null;
}

// Actualiza el costo del producto con lo que se pagó (pedido de Mato:
// "que la compra actualice el costo del producto") respetando monedas
// (4/10/2026: "que pase a dolares"): una compra en USD deja el costo
// en USD y pasa el producto a moneda USD. Una compra en ARS de un
// producto en USD se convierte a USD con la cotización del documento
// (si no hay, no se toca el costo).
async function actualizarCostoProductoDesdeCompra(db, req, item, moneda, cotizacion) {
  if (!item.productoId) return;
  const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: item.productoId }, filtroOrg(req)));
  if (!producto) return;
  const set = { updatedAt: new Date() };
  if (moneda === 'USD') {
    set.costo = item.precioUnitario;
    set.moneda = 'USD';
  } else if ((producto.moneda || 'ARS') === 'USD') {
    if (!(cotizacion > 0)) return;
    set.costo = Math.round((item.precioUnitario / cotizacion) * 100) / 100;
  } else {
    set.costo = item.precioUnitario;
  }
  await db.collection('productos_catalogo').updateOne({ _id: producto._id }, { $set: set });
}

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
// Órdenes de compra (4/10/2026, pedido de Mato: "para cerrar el ciclo
// debemos armar ordenes de compra... es para cuando hago un pedido y
// aun no llega la factura. no mueve stock, ni saldos. es un comprobante
// de orden para mapear que es lo que falta ingresar") — es el pedido
// que se le hace a un proveedor ANTES de que llegue la factura real:
// no toca stock (sin recepción) ni Tesorería (sin pagos). Cuando llega
// la factura, se "convierte" (total o parcialmente — un pedido puede
// llegar en varias entregas/facturas) en una Compra de verdad, que ahí
// sí es la que mueve stock y saldos — ver POST /ordenes/:id/convertir.
//
// Colección nueva: ordenes_compra : { numero (correlativo propio, NO
//   fiscal, NO se mezcla con el de compras), proveedorId,
//   proveedorNombre, fecha, moneda, cotizacionDolar, condicionPago,
//   estado (pendiente/parcial/convertida/anulada), items: [{
//   productoId, sku, nombre, cantidad, precioUnitario (estimado),
//   subtotal, cantidadConvertida }], subtotal, observaciones,
//   anuladaEn, anuladaPor, anuladaMotivo, usuarioNombre, orgId,
//   createdAt, updatedAt } — y su propio contador,
//   ordenes_compra_contadores.
// -----------------------------------------------------------------------

const ESTADOS_ORDEN_VALIDOS = ['pendiente', 'parcial', 'convertida', 'anulada'];

async function proximoNumeroOrden(db, orgId) {
  const r = await db.collection('ordenes_compra_contadores').findOneAndUpdate(
    { orgId },
    { $inc: { ultimo: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return doc ? doc.ultimo : 1;
}

// Ítems de una orden — a diferencia de normalizarItems (la compra real),
// acá NO hay IVA por artículo: es un pedido previo a la factura, el IVA
// discriminado recién se carga cuando se convierte (con los datos reales
// del comprobante que mandó el proveedor). El precio unitario es
// estimado (se autocompleta con el costo del producto, pero no es
// obligatorio que sea exacto).
async function normalizarItemsOrden(db, req, itemsRaw) {
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw err(400, 'La orden de compra necesita al menos un ítem');
  const items = [];
  let subtotal = 0;
  for (const it of itemsRaw) {
    const productoId = it.productoId ? toObjectId(it.productoId) : null;
    let nombre = normalizarTexto(it.nombre);
    let sku = normalizarTexto(it.sku) || null;
    let precioBase = it.precioUnitario;
    if (productoId) {
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(400, 'Uno de los productos de la orden no existe (o no pertenece a esta organización)');
      nombre = producto.nombre;
      sku = producto.sku || null;
      if (precioBase === undefined || precioBase === null || precioBase === '') precioBase = producto.costo;
    }
    if (!nombre) throw err(400, 'Falta el nombre de un ítem de la orden');
    const cantidad = normalizarCantidadPositiva(it.cantidad, `La cantidad de "${nombre}"`);
    const precioUnitario = normalizarMontoNoNegativo(precioBase || 0, `El precio unitario estimado de "${nombre}"`);
    const itemSubtotal = Math.round(cantidad * precioUnitario * 100) / 100;
    subtotal += itemSubtotal;
    items.push({ productoId, sku, nombre, cantidad, precioUnitario, subtotal: itemSubtotal, cantidadConvertida: 0, cantidadRecibida: 0 });
  }
  return { items, subtotal: Math.round(subtotal * 100) / 100 };
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

// -----------------------------------------------------------------------
// Alta rápida de producto (4/10/2026, pedido de Mato: "la posibilidad de
// dar de alta la mercadería desde ahí") — pensada para cargar un
// producto al vuelo mientras se arma una orden de compra, sin tener que
// salir a Productos (que además exige su propio módulo). Crea un
// producto mínimo (sku + nombre, costo opcional); el resto de la ficha
// se completa después, en Productos, si hace falta. Mismo patrón que
// la alta rápida de "conceptos" en Gastos.
// -----------------------------------------------------------------------

router.post('/productos-rapido', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un producto.');
    const body = req.body || {};
    const sku = normalizarTexto(body.sku).toUpperCase();
    if (!sku) throw err(400, 'El SKU (código) es obligatorio');
    const nombre = normalizarTexto(body.nombre);
    if (!nombre) throw err(400, 'El nombre es obligatorio');
    const costo = (body.costo !== undefined && body.costo !== null && body.costo !== '') ? normalizarMontoNoNegativo(body.costo, 'El costo') : null;
    const unidad = normalizarTexto(body.unidad).toLowerCase() || 'unidad';

    const doc = await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ sku, activo: { $ne: false } }, filtroOrg(req));
      const existente = await db.collection('productos_catalogo').findOne(match);
      if (existente) throw err(400, `Ya hay otro producto activo con el SKU "${sku}" (${existente.nombre}).`);
      const ahora = new Date();
      const nuevo = {
        sku, nombre, unidad, costo, precio: null, activo: true,
        tipoProducto: 'simple', disponiblePara: 'todos', moneda: 'ARS',
        stockeable: true, aceptaStockNegativo: false, trazable: false,
        orgId: req.orgId, createdAt: ahora, updatedAt: ahora
      };
      const r = await db.collection('productos_catalogo').insertOne(nuevo);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Órdenes de compra — CRUD + conversión a Compra real.
// -----------------------------------------------------------------------

router.get('/ordenes', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.proveedorId) {
      const pid = toObjectId(req.query.proveedorId);
      if (!pid) throw err(400, 'proveedorId inválido');
      match.proveedorId = pid;
    }
    if (req.query.estado) {
      if (!ESTADOS_ORDEN_VALIDOS.includes(req.query.estado)) throw err(400, 'Estado inválido');
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
      return db.collection('ordenes_compra').find(match).sort({ fecha: -1, numero: -1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/ordenes/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const orden = await conReintento(async () => {
      const db = await getDb();
      return db.collection('ordenes_compra').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!orden) throw err(404, 'Orden de compra no encontrada');
    res.json(orden);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/ordenes', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar una orden de compra.');
    const body = req.body || {};
    const proveedorId = toObjectId(body.proveedorId);
    if (!proveedorId) throw err(400, 'Elegí un proveedor');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const condicionPago = normalizarTexto(body.condicionPago);
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();
    let cotizacionDolar = body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: proveedorId }, filtroOrg(req)));
      if (!proveedor) throw err(400, 'El proveedor no existe (o no pertenece a esta organización)');
      cotizacionDolar = await resolverCotizacion(db, req, moneda, cotizacionDolar, false);
      const { items, subtotal } = await normalizarItemsOrden(db, req, body.items);
      const numero = await proximoNumeroOrden(db, req.orgId);
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();
      const orden = {
        numero,
        proveedorId,
        proveedorNombre: proveedor.razonSocial || proveedor.nombreFantasia || '',
        fecha,
        moneda,
        cotizacionDolar,
        condicionPago: condicionPago || proveedor.condicionPago || '',
        estado: 'pendiente',
        // Recepción física de la mercadería — independiente de
        // convertir la orden en compra (eso es cuando llega la
        // factura). 4/10/2026, pedido de Mato: "la orden de compra
        // ademas de poder convertirla en compra nos deberia de
        // permitir recibir la mercaderia, impactando en el stock".
        estadoRecepcion: 'pendiente',
        items,
        subtotal,
        observaciones,
        anuladaEn: null,
        anuladaPor: null,
        anuladaMotivo: null,
        usuarioNombre,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };
      const r = await db.collection('ordenes_compra').insertOne(orden);
      orden._id = r.insertedId;
      return orden;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Recibe mercadería contra una orden de compra ANTES de que llegue la
// factura — a diferencia de "convertir en compra" (que exige los datos
// del comprobante fiscal), esto solo ingresa stock, sin tocar saldos ni
// Tesorería. Se puede recibir de a partes (varias entregas) y después,
// cuando llegue la factura, "convertir" la orden la va a tomar en
// cuenta para no volver a sumar el mismo stock dos veces.
router.post('/ordenes/:id/recibir', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const depositoId = toObjectId(body.depositoId);
    if (!depositoId) throw err(400, 'Elegí a qué depósito le vas a ingresar el stock.');
    if (!Array.isArray(body.items) || !body.items.length) throw err(400, 'Elegí al menos un ítem para recibir');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const orden = await db.collection('ordenes_compra').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!orden) throw err(404, 'Orden de compra no encontrada');
      if (orden.estado === 'anulada') throw err(400, 'Esa orden está anulada, no se puede recibir mercadería.');

      const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
      if (!deposito) throw err(404, 'Depósito no encontrado');

      const usados = new Set();
      const porIndice = new Map();
      for (const it of body.items) {
        const idx = Number(it.ordenItemIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= orden.items.length) throw err(400, 'Ítem de la orden inválido');
        if (usados.has(idx)) throw err(400, 'No se puede recibir el mismo ítem de la orden dos veces en la misma recepción');
        usados.add(idx);
        const ordenItem = orden.items[idx];
        const cantidad = normalizarCantidadPositiva(it.cantidad, `La cantidad a recibir de "${ordenItem.nombre}"`);
        const pendienteRecibir = Math.round((ordenItem.cantidad - (ordenItem.cantidadRecibida || 0)) * 1000) / 1000;
        if (cantidad > pendienteRecibir + 0.0001) throw err(400, `No se puede recibir más de lo pendiente de "${ordenItem.nombre}" (pendiente de recibir: ${pendienteRecibir})`);
        porIndice.set(idx, cantidad);
      }
      if (!porIndice.size) throw err(400, 'Elegí al menos un ítem para recibir');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();
      for (const [idx, cantidad] of porIndice) {
        const ordenItem = orden.items[idx];
        if (!ordenItem.productoId) continue; // ítems manuales sin vínculo al catálogo no mueven stock
        await aplicarMovimientoStock(db, req, {
          productoId: ordenItem.productoId, depositoId, tipo: 'ingreso', cantidad,
          motivo: 'Recepción de orden de compra', observaciones: `Orden de compra #${orden.numero}`.trim(),
          ordenId: orden._id, usuarioNombre, fecha: ahora
        });
      }

      const itemsActualizados = orden.items.map((oi, i) => {
        if (!porIndice.has(i)) return oi;
        const nuevaCantidadRecibida = Math.round(((oi.cantidadRecibida || 0) + porIndice.get(i)) * 1000) / 1000;
        return Object.assign({}, oi, { cantidadRecibida: nuevaCantidadRecibida });
      });
      const totalmenteRecibida = itemsActualizados.every(it => (it.cantidadRecibida || 0) >= it.cantidad - 0.0001);
      const algoRecibido = itemsActualizados.some(it => (it.cantidadRecibida || 0) > 0);
      const nuevoEstadoRecepcion = totalmenteRecibida ? 'recibida' : (algoRecibido ? 'parcial' : 'pendiente');

      await db.collection('ordenes_compra').updateOne({ _id: id }, { $set: {
        items: itemsActualizados, estadoRecepcion: nuevoEstadoRecepcion, updatedAt: new Date()
      } });
      return db.collection('ordenes_compra').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/ordenes/:id/anular', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = normalizarTexto((req.body || {}).motivo);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const orden = await db.collection('ordenes_compra').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!orden) throw err(404, 'Orden de compra no encontrada');
      if (orden.estado === 'anulada') throw err(400, 'Esa orden ya está anulada');
      if (orden.estado === 'convertida') throw err(400, 'Esa orden ya se convirtió por completo en una compra, no se puede anular');
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      await db.collection('ordenes_compra').updateOne({ _id: id }, { $set: {
        estado: 'anulada', anuladaEn: new Date(), anuladaPor: usuarioNombre, anuladaMotivo: motivo, updatedAt: new Date()
      } });
      return db.collection('ordenes_compra').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Convierte (total o parcialmente) una orden de compra en una Compra
// real — recién acá se cargan los datos del comprobante fiscal (tipo,
// punto de venta, número, IVA por artículo) porque recién acá existe la
// factura de verdad. Es la ÚNICA de las rutas de órdenes que mueve stock
// (si tipoRecepcion es inmediata) o deja saldo pendiente de pago — la
// orden en sí nunca toca ninguno de los dos.
router.post('/ordenes/:id/convertir', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
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
    let cotizacionDolar = body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null;
    const comprobante = normalizarComprobante(body);
    if (!Array.isArray(body.items) || !body.items.length) throw err(400, 'Elegí al menos un ítem de la orden para convertir');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const orden = await db.collection('ordenes_compra').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!orden) throw err(404, 'Orden de compra no encontrada');
      if (orden.estado === 'anulada') throw err(400, 'Esa orden está anulada, no se puede convertir');
      if (orden.estado === 'convertida') throw err(400, 'Esa orden ya se convirtió por completo en una compra');

      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: orden.proveedorId }, filtroOrg(req)));
      if (!proveedor) throw err(400, 'El proveedor de la orden no existe (o no pertenece a esta organización)');

      cotizacionDolar = await resolverCotizacion(db, req, moneda, cotizacionDolar, true);

      // Mismo chequeo de comprobante duplicado que en POST / de compras.
      const dupe = await db.collection('compras').findOne(Object.assign({
        proveedorId: orden.proveedorId, tipoComprobante: comprobante.tipoComprobante,
        puntoVenta: comprobante.puntoVenta, comprobanteNumero: comprobante.comprobanteNumero,
        estado: { $ne: 'anulada' }
      }, filtroOrg(req)));
      if (dupe) throw err(400, `Ya hay una compra cargada con ese comprobante (${TIPO_COMPROBANTE_LABEL[comprobante.tipoComprobante]} ${comprobante.puntoVenta}-${comprobante.comprobanteNumero}) para este proveedor — es la compra #${dupe.numero}.`);

      // Valida cada ítem a convertir contra lo que todavía está
      // pendiente en la orden (permite convertir de a partes).
      const usados = new Set();
      const itemsRaw = [];
      const cantidadesPorIndice = [];
      for (const it of body.items) {
        const idx = Number(it.ordenItemIndex);
        if (!Number.isInteger(idx) || idx < 0 || idx >= orden.items.length) throw err(400, 'Ítem de la orden inválido');
        if (usados.has(idx)) throw err(400, 'No se puede convertir el mismo ítem de la orden dos veces en la misma compra');
        usados.add(idx);
        const ordenItem = orden.items[idx];
        const pendiente = Math.round((ordenItem.cantidad - (ordenItem.cantidadConvertida || 0)) * 1000) / 1000;
        const cantidad = normalizarCantidadPositiva(it.cantidad, `La cantidad a convertir de "${ordenItem.nombre}"`);
        if (cantidad > pendiente + 0.0001) throw err(400, `No se puede convertir más de lo pendiente de "${ordenItem.nombre}" (pendiente: ${pendiente})`);
        itemsRaw.push({
          productoId: ordenItem.productoId,
          sku: ordenItem.sku,
          nombre: ordenItem.nombre,
          cantidad,
          precioUnitario: (it.precioUnitario !== undefined && it.precioUnitario !== null && it.precioUnitario !== '') ? it.precioUnitario : ordenItem.precioUnitario,
          alicuotaIva: it.alicuotaIva
        });
        cantidadesPorIndice.push([idx, cantidad]);
      }

      const { items, subtotal } = await normalizarItems(db, req, itemsRaw);
      // Cuánto de lo que se está convirtiendo ya había entrado a stock
      // por una recepción directa contra la orden (y todavía no se
      // había facturado) — eso NO se vuelve a ingresar acá (ver más
      // abajo, donde se calcula cantidadIngresoStock de cada ítem).
      items.forEach((item, i) => {
        const [idx, cantidadConv] = cantidadesPorIndice[i];
        const ordenItem = orden.items[idx];
        const recibidoSinFacturar = Math.max(0, Math.round(((ordenItem.cantidadRecibida || 0) - (ordenItem.cantidadConvertida || 0)) * 1000) / 1000);
        item.cantidadYaRecibida = Math.min(recibidoSinFacturar, cantidadConv);
      });
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
        proveedorId: orden.proveedorId,
        proveedorNombre: proveedor.razonSocial || proveedor.nombreFantasia || '',
        fecha,
        moneda,
        cotizacionDolar,
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
        ordenCompraId: orden._id,
        ordenCompraNumero: orden.numero,
        usuarioNombre,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };

      const r = await db.collection('compras').insertOne(compra);
      compra._id = r.insertedId;

      for (const item of items) {
        await actualizarCostoProductoDesdeCompra(db, req, item, moneda, cotizacionDolar);
      }

      if (tipoRecepcion === 'inmediata') {
        await ingresarStockDeCompra(db, req, compra, depositoId);
        await db.collection('compras').updateOne({ _id: compra._id }, { $set: { stockIngresado: true, stockIngresadoEn: ahora, recibidaEn: ahora } });
        compra.stockIngresado = true;
        compra.stockIngresadoEn = ahora;
        compra.recibidaEn = ahora;
      } else {
        // Igual que una compra pendiente normal: no se ingresa nada
        // ahora. Lo que ya se había recibido antes de la orden se deja
        // registrado en cantidadIngresoStock=0 para que, si más
        // adelante se usa "Recibir (ingresar stock)" sobre esta compra,
        // ingresarStockDeCompra vuelva a descontarlo correctamente.
        for (const item of compra.items) item.cantidadIngresoStock = 0;
        await db.collection('compras').updateOne({ _id: compra._id }, { $set: { items: compra.items } });
      }

      // Actualiza cuánto se convirtió de cada ítem de la orden, y
      // recalcula su estado — esto NO toca stock ni saldos, solo lo que
      // ya se actualizó arriba en la compra recién creada.
      const porIndice = new Map(cantidadesPorIndice);
      const itemsActualizados = orden.items.map((oi, i) => {
        if (!porIndice.has(i)) return oi;
        const nuevaCantidadConvertida = Math.round(((oi.cantidadConvertida || 0) + porIndice.get(i)) * 1000) / 1000;
        return Object.assign({}, oi, { cantidadConvertida: nuevaCantidadConvertida });
      });
      const totalmenteConvertida = itemsActualizados.every(it => (it.cantidadConvertida || 0) >= it.cantidad - 0.0001);
      const algoConvertido = itemsActualizados.some(it => (it.cantidadConvertida || 0) > 0);
      const nuevoEstadoOrden = totalmenteConvertida ? 'convertida' : (algoConvertido ? 'parcial' : 'pendiente');
      await db.collection('ordenes_compra').updateOne({ _id: orden._id }, { $set: {
        items: itemsActualizados, estado: nuevoEstadoOrden, updatedAt: new Date()
      } });

      return compra;
    });
    res.json(resultado);
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
      const cotizacionDolar = await resolverCotizacion(db, req, moneda, body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null, true);
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
        cotizacionDolar,
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
        await actualizarCostoProductoDesdeCompra(db, req, item, moneda, cotizacionDolar);
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
