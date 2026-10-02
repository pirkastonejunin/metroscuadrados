// ---------------------------------------------------------------------------
// Ventas — registro interno de ventas (SIN facturación electrónica AFIP,
// que queda para la etapa aparte ya anotada en roadmap-modulos.md). Es el
// equivalente al "Comprobante de venta (no fiscal)" de Dux, no a una
// Factura — no tiene numeración fiscal ni valida contra AFIP.
//
// Campos de Dux relevados: "¿Cómo generar una nueva venta?"
// (ayuda.duxsoftware.com.ar/es/articles/7856073) y "¿Cómo utilizar el
// módulo de ventas?" (.../7866979). El formulario real de Dux tiene, entre
// otros: Cliente, Tipo de comprobante (Comprobante de venta / Factura /
// Factura de Crédito MiPyMEs), Punto de Venta, Fecha, Moneda, Tipo de
// Entrega ("Entrega inmediata": genera remito y hace el movimiento de
// stock — o "No entrega": venta pendiente, sin remito), Depósito,
// Vendedor, Descuento, Observaciones, ítems (código, producto, lista de
// precio, cantidad, precio unitario) y una sección de Cobranza (caja, tipo
// de valor, monto total o parcial → saldo pendiente en cuenta corriente,
// vuelto). Estados de venta: Emitida/Vencida/Anulada; de remito:
// Pendiente/Con remito/Remito parcial.
//
// DECISIONES DE ALCANCE v1 (a propósito afuera, ver roadmap):
//   - Sin AFIP ni numeración fiscal — comprobante interno únicamente
//     (Punto de Venta y Letra de Dux no aplican acá).
//   - Sin "Lista de precio" como concepto propio todavía — el precio
//     unitario se autocompleta con `productos_catalogo.precio` (editable
//     por línea, igual que en Dux se puede pisar el autocompletado). Las
//     listas de precio con markup que ya existen en Costos
//     (`costos_listas_precio`) están armadas sobre OTRO catálogo
//     (`costos_productos`, el de fabricación) — no son lo mismo, no se
//     mezclan acá.
//   - "Vendedor" es texto libre (por defecto, quien carga la venta) — no
//     hay todavía un módulo de Personal/empleados separado de Usuarios.
//   - Cobranza simplificada: se registran cobros (pagos) contra la venta,
//     con su saldo pendiente, pero NO se construye un mayor de cuenta
//     corriente por cliente (eso es parte de la etapa grande de
//     Facturación electrónica/cuenta corriente, ver roadmap) — el saldo
//     vive únicamente a nivel de cada venta.
//   - "Entrega inmediata" aplica el egreso de stock en el momento de crear
//     la venta (mismo momento que en Dux). Una venta creada como "no
//     entrega" queda `pendiente` y se puede entregar después
//     (POST /:id/entregar), que ahí sí aplica el egreso — una sola vez,
//     igual criterio que Fábrica→Stock (no se puede entregar dos veces).
//   - Anular una venta con stock ya descontado reingresa el stock
//     automáticamente (a diferencia de la corrección manual de Fábrica —
//     acá "anular" es una operación bien definida y frecuente, tiene
//     sentido automatizar la reversión). Una venta anulada no se puede
//     volver a anular ni entregar.
//   - Sin devoluciones parciales todavía (anular es todo o nada).
//
// Colección nueva: ventas : { numero (correlativo interno, NO fiscal,
//   separado por tipoComprobante), tipoComprobante (comprobante_x/fiscal —
//   1/10/2026, preparación para el módulo de ARCA, ver más abajo),
//   clienteId, clienteNombre, vendedor, fecha, moneda (ARS/USD),
//   cotizacionDolar, tipoEntrega (inmediata/pendiente), depositoId,
//   estado (pendiente/entregada/anulada), items: [{ productoId, sku,
//   nombre, cantidad, precioUnitario, subtotal }], descuentoPorcentaje,
//   descuentoMonto, subtotal, total, pagos: [{ tipoValor, monto, fecha,
//   nota, usuarioNombre }], totalCobrado, saldoPendiente, observaciones,
//   stockDescontado (bool), stockDescontadoEn, entregadaEn, anuladaEn,
//   anuladaPor, anuladaMotivo, usuarioNombre, orgId, createdAt, updatedAt }
//
// Módulo con clave propia ('ventas'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const ventasRouter = require('./ventas');
//   app.use('/api/ventas', ventasRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx } = require('./importExport');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
// Índices (2/10/2026, pedido de Mato: "optimizar todas las bases para
// que el sistema sea fluido y rápido" — mismo patrón que ya se usó en
// productos/clientes/stock): el listado de Ventas filtra siempre por
// orgId y ordena por fecha/número, a veces además por cliente o estado
// — sin índice, cada carga de la pantalla de Ventas recorre toda la
// colección para ordenar. createIndex es no-op si ya existe.
let indicesListos = false;
async function asegurarIndices(db) {
  if (indicesListos) return;
  indicesListos = true;
  try {
    const col = db.collection('ventas');
    await Promise.all([
      col.createIndex({ orgId: 1, fecha: -1, numero: -1 }),
      col.createIndex({ orgId: 1, estado: 1, fecha: -1 }),
      col.createIndex({ orgId: 1, clienteId: 1, fecha: -1 }),
      // Remitos (2/10/2026): numeración y búsqueda por venta.
      db.collection('remitos').createIndex({ orgId: 1, numero: -1 }),
      db.collection('remitos').createIndex({ orgId: 1, ventaId: 1 })
    ]);
  } catch (e) {
    indicesListos = false; // si falló, reintentar en la próxima conexión
    console.error('No se pudieron crear los índices de ventas:', e.message);
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
  await asegurarIndices(db);
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
function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

const TIPOS_ENTREGA_VALIDOS = ['inmediata', 'pendiente'];
const ESTADOS_VALIDOS = ['pendiente', 'entregada', 'anulada'];
// Tipo de comprobante (1/10/2026, pedido de Mato: preparar el terreno para
// cuando esté el módulo de ARCA/facturación electrónica). Por ahora NINGUNO
// de los dos es un comprobante fiscal de verdad — "fiscal" es un rótulo
// para separar esas ventas de entrada, con su propia numeración, de las de
// "Comprobante X" (lo que ya se venía usando) — el día que se conecte
// ARCA, esas ventas marcadas "fiscal" van a ser las candidatas a facturar,
// con CAE y numeración real de AFIP/ARCA en vez de este correlativo interno.
const TIPOS_COMPROBANTE_VALIDOS = ['comprobante_x', 'fiscal'];

// Columnas del Excel de export (30/9/2026, pedido de Mato: "todas las
// bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js. Solo EXPORT: una venta se genera operativamente desde
// la pantalla (entrega/cobros descuentan stock y quedan ligados a un
// movimiento real), no tiene sentido cargarla masiva desde Excel como sí
// lo tiene un catálogo — si en algún momento hace falta importar ventas
// históricas de Dux, es una decisión aparte con Mato, no algo genérico.
const COLUMNAS_VENTAS_EXPORT = [
  { clave: 'numero', titulo: 'Nº' },
  { clave: 'tipoComprobante', titulo: 'Tipo de comprobante' },
  { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
  { clave: 'clienteNombre', titulo: 'Cliente' },
  { clave: 'vendedor', titulo: 'Vendedor' },
  { clave: 'tipoEntrega', titulo: 'Tipo de entrega' },
  { clave: 'estado', titulo: 'Estado' },
  { clave: 'moneda', titulo: 'Moneda' },
  { clave: 'subtotal', titulo: 'Subtotal', tipo: 'numero' },
  { clave: 'descuentoPorcentaje', titulo: 'Descuento %', tipo: 'numero' },
  { clave: 'descuentoMonto', titulo: 'Descuento $', tipo: 'numero' },
  { clave: 'total', titulo: 'Total', tipo: 'numero' },
  { clave: 'totalCobrado', titulo: 'Cobrado', tipo: 'numero' },
  { clave: 'saldoPendiente', titulo: 'Saldo', tipo: 'numero' },
  { clave: 'observaciones', titulo: 'Observaciones' }
];
const MONEDAS_VALIDAS = ['ARS', 'USD'];
const TIPOS_VALOR_VALIDOS = ['efectivo', 'cheque', 'cuenta', 'tarjeta'];

const authAdmin = [authUsuario, resolverOrg, requiereModulo('ventas')];

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
// Listas livianas para armar el formulario — clientes y productos activos
// de la organización, y depósitos (mismos que administra Stock, expuestos
// acá bajo el gate de Ventas para no exigir también el módulo 'clientes'
// o 'stock' a quien solo carga ventas).
// -----------------------------------------------------------------------

router.get('/clientes', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('clientes')
        .find(match, { projection: { apellidoRazonSocial: 1, nombre: 1, tipoCliente: 1, cuit: 1 } })
        .sort({ apellidoRazonSocial: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/productos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      // costo y preciosPorLista se agregan acá (30/9/2026) para que la
      // pantalla de Ventas pueda resolver el precio de cada ítem según la
      // lista de precio elegida (ver Productos: productos_catalogo guarda
      // `preciosPorLista: [{listaId, precio}]` como override puntual sobre
      // costo + % de cada lista).
      // unidadesPorBulto se agrega acá (1/10/2026, pedido de Mato) para que
      // el ítem de la venta se pueda cargar en bultos y convertir solo a la
      // unidad real del producto (ver normalizarItems más abajo — la
      // conversión la hace el frontend antes de mandar la cantidad).
      return db.collection('productos_catalogo')
        .find(match, { projection: { sku: 1, nombre: 1, precio: 1, costo: 1, preciosPorLista: 1, unidad: 1, unidadesPorBulto: 1, stockeable: 1, aceptaStockNegativo: 1 } })
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
// Helpers de stock — mismo mecanismo que stock.js (movimiento + $inc sobre
// stock_actual). No se importa stock.js directamente: cada router maneja
// su propia conexión a Mongo (mismo patrón ya usado en toda la app), así
// que se replica acá la lógica mínima necesaria sobre las mismas
// colecciones (`stock_movimientos`, `stock_actual`).
// -----------------------------------------------------------------------

async function aplicarMovimientoStock(db, req, { productoId, depositoId, tipo, cantidad, motivo, observaciones, ventaId, usuarioNombre, fecha }) {
  const movimiento = {
    productoId, depositoId, tipo, cantidad, motivo,
    sucursal: '', codigoExterno: '', observaciones: observaciones || '',
    ventaId, usuarioNombre, fecha: fecha || new Date(), orgId: req.orgId, createdAt: new Date()
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

// -----------------------------------------------------------------------
// Stock comprometido vs. disponible (2/10/2026, pedido de Mato; ajustado
// el mismo día) — la venta se carga SIEMPRE, haya o no stock: un cliente
// puede dejarla pendiente de retiro mientras entra mercadería o se
// fabrica. Lo que hace la venta es COMPROMETER el stock del depósito
// elegido (no se puede prometer dos veces lo mismo), sin bloquear la
// carga aunque el comprometido ya supere lo que hay — eso es justamente
// la señal de que hace falta reponer o fabricar ese faltante (se ve en
// Stock como "Disponible" negativo). Recién al GENERAR EL REMITO se
// cruza contra el stock físico de verdad: si no alcanza, ahí sí se
// rechaza. Con "entrega inmediata" el remito se genera en el mismo
// momento de cargar la venta (ver POST /). A diferencia de un
// ingreso/egreso real, comprometer o liberar NO queda en el libro
// `stock_movimientos` (no es un movimiento físico) — el libro solo
// registra bajas reales (remito generado) y altas reales (reingreso por
// anulación), igual que antes de este cambio.
// -----------------------------------------------------------------------

// Valida que haya stock FÍSICO suficiente (cantidad real en el depósito,
// sin restar lo comprometido) para los ítems de una venta puntual, salvo
// `aceptaStockNegativo`. Se usa SOLO al generar el remito — es la
// mercadería real que se va a entregar en este momento, no importa
// cuánto más esté comprometido por otras ventas pendientes.
async function validarStockFisicoParaRemito(db, req, items, depositoId) {
  const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
  if (!deposito) throw err(404, 'Depósito no encontrado');
  for (const item of items) {
    if (!item.productoId) continue; // ítem cargado sin vínculo a Stock — no se valida
    const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: item.productoId }, filtroOrg(req)));
    if (!producto) continue;
    if (!producto.aceptaStockNegativo) {
      const actual = await db.collection('stock_actual').findOne(Object.assign({ productoId: item.productoId, depositoId }, filtroOrg(req)));
      const cantidadActual = actual ? actual.cantidad : 0;
      if (item.cantidad > cantidadActual) {
        throw err(400, `No hay stock suficiente de "${item.nombre}" en ${deposito.nombre} para generar el remito (disponible físico: ${cantidadActual}).`);
      }
    }
  }
}

// Reserva stock (sin descontarlo todavía) para cada ítem con producto
// vinculado. NO valida disponibilidad — la venta se compromete siempre,
// aunque el comprometido termine superando el stock físico (ver nota
// arriba). El chequeo real pasa a generarRemitoDeVenta.
async function comprometerStockDeVenta(db, req, items, depositoId) {
  for (const item of items) {
    if (!item.productoId) continue;
    await db.collection('stock_actual').updateOne(
      Object.assign({ productoId: item.productoId, depositoId }, filtroOrg(req)),
      {
        $inc: { cantidadComprometida: item.cantidad },
        $setOnInsert: Object.assign({ productoId: item.productoId, depositoId, cantidad: 0 }, filtroOrg(req))
      },
      { upsert: true }
    );
  }
}

// Libera una reserva de stock sin haberla convertido en una baja real —
// usado al anular una venta que todavía no tenía remito generado.
async function liberarCompromisoDeVenta(db, req, venta) {
  if (!venta.depositoId) return;
  for (const item of venta.items) {
    if (!item.productoId) continue;
    await db.collection('stock_actual').updateOne(
      Object.assign({ productoId: item.productoId, depositoId: venta.depositoId }, filtroOrg(req)),
      { $inc: { cantidadComprometida: -item.cantidad }, $set: { actualizadoEn: new Date() } }
    );
  }
}

// Numeración de remitos — correlativo propio por organización, separado
// de la numeración de comprobantes de venta.
async function proximoNumeroRemito(db, orgId) {
  const r = await db.collection('remitos_contadores').findOneAndUpdate(
    { orgId },
    { $inc: { ultimo: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return doc.ultimo;
}

// Genera el remito de una venta: aplica la baja REAL de stock (egreso +
// libera la reserva de ese mismo ítem), crea el documento de remito
// (numerado, imprimible más adelante) y marca la venta como entregada.
// Para "entrega inmediata" se llama en el mismo momento de crear la
// venta (ver POST /); para una venta que había quedado pendiente, se
// llama desde POST /:id/entregar.
async function generarRemitoDeVenta(db, req, venta, depositoId) {
  const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
  if (!deposito) throw err(404, 'Depósito no encontrado');
  // Recién ACÁ se cruza contra el stock físico real — si no alcanza, se
  // rechaza el remito (la venta sigue existiendo, pendiente, comprometida).
  await validarStockFisicoParaRemito(db, req, venta.items, depositoId);
  for (const item of venta.items) {
    if (!item.productoId) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId, tipo: 'egreso', cantidad: item.cantidad,
      motivo: 'Venta', observaciones: `Venta ${venta.numero ? '#' + venta.numero : ''}`.trim(),
      ventaId: venta._id, usuarioNombre: venta.usuarioNombre, fecha: venta.fecha
    });
    await db.collection('stock_actual').updateOne(
      Object.assign({ productoId: item.productoId, depositoId }, filtroOrg(req)),
      { $inc: { cantidadComprometida: -item.cantidad } }
    );
  }
  const numero = await proximoNumeroRemito(db, req.orgId);
  const ahora = new Date();
  const remito = {
    numero,
    ventaId: venta._id,
    ventaNumero: venta.numero,
    tipoComprobante: venta.tipoComprobante,
    clienteId: venta.clienteId,
    clienteNombre: venta.clienteNombre,
    depositoId: deposito._id,
    depositoNombre: deposito.nombre,
    items: venta.items.map(it => ({ productoId: it.productoId, sku: it.sku, nombre: it.nombre, cantidad: it.cantidad })),
    fecha: ahora,
    usuarioNombre: venta.usuarioNombre,
    orgId: req.orgId,
    createdAt: ahora
  };
  const r = await db.collection('remitos').insertOne(remito);
  remito._id = r.insertedId;
  await db.collection('ventas').updateOne(
    { _id: venta._id },
    { $set: { estado: 'entregada', depositoId, stockDescontado: true, stockDescontadoEn: ahora, entregadaEn: ahora, remitoId: remito._id, remitoNumero: remito.numero, updatedAt: ahora } }
  );
  return remito;
}

// Reingresa el stock FÍSICO de una venta que ya tenía remito generado
// (usado al anular). La reserva (`cantidadComprometida`) de esa venta ya
// se había liberado al generar el remito, así que acá no hay que tocarla.
async function reingresarStockDeVenta(db, req, venta) {
  if (!venta.depositoId) return;
  for (const item of venta.items) {
    if (!item.productoId) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId: venta.depositoId, tipo: 'ingreso', cantidad: item.cantidad,
      motivo: 'Anulación de venta', observaciones: `Anulación de venta ${venta.numero ? '#' + venta.numero : ''}`.trim(),
      ventaId: venta._id, usuarioNombre: venta.usuarioNombre, fecha: new Date()
    });
  }
}

// -----------------------------------------------------------------------
// Numeración interna — correlativo simple por organización, NO fiscal
// (no reemplaza el punto de venta/letra de AFIP). Se guarda un contador
// en `ventas_contadores` para no tener que escanear toda la colección.
// -----------------------------------------------------------------------

// Numeración separada por tipo de comprobante (1/10/2026) — antes había un
// solo contador por organización ({orgId}, sin tipo). Para no reiniciar la
// numeración de las ventas que ya existen, "comprobante_x" sigue ESE mismo
// contador viejo (se migra la primera vez que se pide un número nuevo);
// "fiscal" arranca de cero, es un tipo nuevo.
async function proximoNumero(db, orgId, tipoComprobante) {
  const filtro = { orgId, tipoComprobante };
  const r = await db.collection('ventas_contadores').findOneAndUpdate(
    filtro,
    { $inc: { ultimo: 1 } },
    { returnDocument: 'after' }
  );
  let doc = r && r.value !== undefined ? r.value : r;
  if (doc) return doc.ultimo;

  let desde = 0;
  if (tipoComprobante === 'comprobante_x') {
    const legacy = await db.collection('ventas_contadores').findOne({ orgId, tipoComprobante: { $exists: false } });
    if (legacy) desde = legacy.ultimo;
  }
  const r2 = await db.collection('ventas_contadores').findOneAndUpdate(
    filtro,
    { $setOnInsert: { orgId, tipoComprobante }, $inc: { ultimo: desde + 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  doc = r2 && r2.value !== undefined ? r2.value : r2;
  return doc.ultimo;
}

// Valida y normaliza los ítems de una venta contra el catálogo de
// Productos — el precio unitario se autocompleta con `producto.precio`
// pero se puede pisar (igual que en Dux).
async function normalizarItems(db, req, itemsRaw) {
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw err(400, 'La venta necesita al menos un ítem');
  const items = [];
  let subtotal = 0;
  for (const it of itemsRaw) {
    const productoId = it.productoId ? toObjectId(it.productoId) : null;
    let nombre = normalizarTexto(it.nombre);
    let sku = normalizarTexto(it.sku) || null;
    let precioBase = it.precioUnitario;
    if (productoId) {
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(400, 'Uno de los productos de la venta no existe (o no pertenece a esta organización)');
      nombre = producto.nombre;
      sku = producto.sku || null;
      if (precioBase === undefined || precioBase === null || precioBase === '') precioBase = producto.precio;
    }
    if (!nombre) throw err(400, 'Falta el nombre de un ítem de la venta');
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
// Ventas — CRUD + acciones
// -----------------------------------------------------------------------

router.get('/', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.clienteId) {
      const cid = toObjectId(req.query.clienteId);
      if (!cid) throw err(400, 'clienteId inválido');
      match.clienteId = cid;
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
      return db.collection('ventas').find(match).sort({ fecha: -1, numero: -1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Export en Excel (.xlsx) — mismos filtros que GET /, hasta 2000 filas
// (una fila por venta, no por ítem — ver comentario de COLUMNAS_VENTAS_EXPORT).
router.get('/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.clienteId) {
      const cid = toObjectId(req.query.clienteId);
      if (cid) match.clienteId = cid;
    }
    if (req.query.estado && ESTADOS_VALIDOS.includes(req.query.estado)) match.estado = req.query.estado;
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('ventas').find(match).sort({ fecha: -1, numero: -1 }).limit(2000).toArray();
    });
    exportarXlsx(res, 'ventas.xlsx', COLUMNAS_VENTAS_EXPORT, lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const venta = await conReintento(async () => {
      const db = await getDb();
      return db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!venta) throw err(404, 'Venta no encontrada');
    res.json(venta);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Remito de una venta (2/10/2026) — se usa para mostrarlo/imprimirlo.
// Nota de ruta: '/remitos/:id' tiene dos segmentos, así que nunca choca
// con el '/:id' de arriba (que solo matchea un segmento).
router.get('/remitos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const remito = await conReintento(async () => {
      const db = await getDb();
      return db.collection('remitos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!remito) throw err(404, 'Remito no encontrado');
    res.json(remito);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar una venta.');
    const body = req.body || {};
    const clienteId = toObjectId(body.clienteId);
    if (!clienteId) throw err(400, 'Elegí un cliente');
    const tipoEntrega = normalizarTexto(body.tipoEntrega).toLowerCase();
    if (!TIPOS_ENTREGA_VALIDOS.includes(tipoEntrega)) throw err(400, `Tipo de entrega inválido (opciones: ${TIPOS_ENTREGA_VALIDOS.join(', ')})`);
    const tipoComprobante = normalizarTexto(body.tipoComprobante).toLowerCase() || 'comprobante_x';
    if (!TIPOS_COMPROBANTE_VALIDOS.includes(tipoComprobante)) throw err(400, `Tipo de comprobante inválido (opciones: ${TIPOS_COMPROBANTE_VALIDOS.join(', ')})`);
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const depositoId = body.depositoId ? toObjectId(body.depositoId) : null;
    // El depósito ahora es obligatorio siempre (2/10/2026) — aunque la
    // entrega sea "pendiente", hace falta saber de qué depósito se
    // compromete el stock desde el momento en que se carga la venta.
    if (!depositoId) throw err(400, 'Elegí a qué depósito le vas a comprometer el stock.');
    const vendedor = normalizarTexto(body.vendedor) || (req.usuario && req.usuario.nombre) || '';
    const descuentoPorcentaje = body.descuentoPorcentaje ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : 0;
    const descuentoMonto = body.descuentoMonto ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : 0;
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cliente = await db.collection('clientes').findOne(Object.assign({ _id: clienteId }, filtroOrg(req)));
      if (!cliente) throw err(400, 'El cliente no existe (o no pertenece a esta organización)');
      const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
      if (!deposito) throw err(404, 'Depósito no encontrado');
      const { items, subtotal } = await normalizarItems(db, req, body.items);
      // La venta se carga SIEMPRE, haya o no stock (2/10/2026, pedido de
      // Mato) — puede quedar pendiente de retiro mientras entra
      // mercadería o se fabrica. No hay validación de stock acá; el
      // chequeo real es al generar el remito (ver generarRemitoDeVenta).
      const total = calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto);
      const numero = await proximoNumero(db, req.orgId, tipoComprobante);
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();

      // listaPrecioId es solo informativo (30/9/2026): qué lista de precio
      // de Productos se usó para sugerir los precios al cargar la venta.
      // No afecta nada del cálculo — cada ítem ya trae su precioUnitario
      // resuelto por el frontend, editable como siempre.
      const listaPrecioId = body.listaPrecioId ? toObjectId(body.listaPrecioId) : null;

      const venta = {
        numero,
        tipoComprobante,
        clienteId,
        clienteNombre: cliente.apellidoRazonSocial || cliente.nombre || '',
        vendedor,
        fecha,
        moneda,
        listaPrecioId,
        cotizacionDolar: body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null,
        tipoEntrega,
        depositoId,
        estado: 'pendiente',
        items,
        descuentoPorcentaje,
        descuentoMonto,
        subtotal,
        total,
        pagos: [],
        totalCobrado: 0,
        saldoPendiente: total,
        observaciones,
        stockDescontado: false,
        stockDescontadoEn: null,
        remitoId: null,
        remitoNumero: null,
        entregadaEn: null,
        anuladaEn: null,
        anuladaPor: null,
        anuladaMotivo: null,
        usuarioNombre,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };

      const r = await db.collection('ventas').insertOne(venta);
      venta._id = r.insertedId;
      // El stock se COMPROMETE siempre, sea cual sea el tipo de entrega —
      // queda reservado desde que se carga la venta.
      await comprometerStockDeVenta(db, req, items, depositoId);

      if (tipoEntrega === 'inmediata') {
        // Entrega inmediata: la misma venta dispara el remito en el acto
        // (pedido de Mato, 2/10/2026) — se descuenta el stock de verdad y
        // queda numerado el remito, sin pasar por el estado "pendiente".
        // Si no hay stock físico para generarlo, la venta NO se pierde
        // (ya quedó comprometida arriba): queda guardada como pendiente,
        // y se avisa en la respuesta en vez de rechazar toda la carga.
        try {
          await generarRemitoDeVenta(db, req, venta, depositoId);
          return db.collection('ventas').findOne({ _id: venta._id });
        } catch (eRemito) {
          if (eRemito.status !== 400) throw eRemito; // error real, no de stock
          const ventaFinal = await db.collection('ventas').findOne({ _id: venta._id });
          ventaFinal.avisoRemito = eRemito.message;
          return ventaFinal;
        }
      }
      return venta;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Genera el remito de una venta que había quedado "pendiente" — recién
// ahí se descuenta de verdad el stock que ya estaba comprometido.
router.post('/:id/entregar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const depositoIdBody = (req.body && req.body.depositoId) ? toObjectId(req.body.depositoId) : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada.');
      if (venta.estado === 'entregada') throw err(400, 'Esta venta ya tiene remito generado.');

      const depositoId = venta.depositoId || depositoIdBody;
      if (!depositoId) throw err(400, 'Elegí a qué depósito le vas a descontar el stock.');

      if (!venta.depositoId) {
        // Venta cargada antes de este cambio (sin depósito ni reserva
        // hecha al momento de guardarla) — se compromete recién ahora,
        // como paso previo a generar el remito (que valida el stock
        // físico real antes de descontar — ver generarRemitoDeVenta).
        await comprometerStockDeVenta(db, req, venta.items, depositoId);
      }

      await generarRemitoDeVenta(db, req, venta, depositoId);
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anula una venta. Si ya tenía remito generado (stock descontado de
// verdad), reingresa el stock físico automáticamente. Si todavía estaba
// "pendiente" (solo comprometido, sin remito), libera esa reserva sin
// tocar el stock físico — nunca se había descontado nada.
router.post('/:id/anular', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = normalizarTexto(req.body && req.body.motivo);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta ya está anulada.');

      if (venta.stockDescontado) {
        await reingresarStockDeVenta(db, req, venta);
      } else {
        await liberarCompromisoDeVenta(db, req, venta);
      }

      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      await db.collection('ventas').updateOne(
        { _id: id },
        { $set: { estado: 'anulada', anuladaEn: ahora, anuladaPor: usuarioNombre, anuladaMotivo: motivo, updatedAt: ahora } }
      );
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Registra un cobro contra la venta (parcial o total). Los pagos son un
// detalle append-only (no se editan ni se borran — un error se corrige
// con un pago en sentido contrario, mismo criterio que el libro de Stock).
router.post('/:id/pagos', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const tipoValor = normalizarTexto(body.tipoValor).toLowerCase();
    if (!TIPOS_VALOR_VALIDOS.includes(tipoValor)) throw err(400, `Tipo de valor inválido (opciones: ${TIPOS_VALOR_VALIDOS.join(', ')})`);
    const monto = normalizarMontoNoNegativo(body.monto, 'El monto');
    if (monto <= 0) throw err(400, 'El monto del cobro tiene que ser mayor a 0.');
    const nota = normalizarTexto(body.nota);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada, no se le pueden registrar cobros.');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const pago = { tipoValor, monto, fecha: new Date(), nota, usuarioNombre };
      const totalCobrado = (venta.totalCobrado || 0) + monto;
      const saldoPendiente = Math.max(0, venta.total - totalCobrado);
      await db.collection('ventas').updateOne(
        { _id: id },
        { $push: { pagos: pago }, $set: { totalCobrado, saldoPendiente, updatedAt: new Date() } }
      );
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
