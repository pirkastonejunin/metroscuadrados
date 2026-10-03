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
//   - Cobranza: se registran cobros (pagos) contra la venta, con su saldo
//     pendiente a nivel de cada venta. Desde el 2/10/2026 además se
//     mantiene un mayor de cuenta corriente POR CLIENTE (débito al crear
//     la venta, crédito al cobrarla o al cobrar "a cuenta" desde
//     Tesorería sin venta puntual) — ver registrarMovimientoCuentaCorriente
//     en clientes.js. Sigue faltando la etapa grande de Facturación
//     electrónica (AFIP), eso no cambió.
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
// Tesorería (2/10/2026): un cobro en efectivo/cuenta/tarjeta tiene que
// acreditarse YA en una caja/banco real; un cobro en cheque crea un
// cheque "de terceros" en cartera. Se reusan estas dos funciones de
// tesoreria.js (en vez de reimplementarlas) porque son lógica de
// negocio sensible al dinero — ver la nota en tesoreria.js.
const { aplicarMovimientoCuenta, cuentaHabilitada } = require('./tesoreria');
// Cuenta corriente del cliente (2/10/2026, pedido de Mato) — ver el
// comentario grande de registrarMovimientoCuentaCorriente en clientes.js.
const { registrarMovimientoCuentaCorriente } = require('./clientes');
// Imprimibles (3/10/2026, pedido de Mato) — plantilla de impresión
// compartida (sin acceso a Mongo), ver el comentario grande al principio
// de imprimibles.js.
const {
  paginaImprimible, encabezadoComprobante, recuadroClienteComprobante,
  escapeHtml: escHtml, money: moneyImp, numero: numImp, fechaLarga, fechaCorta,
  CATEGORIA_FISCAL_LABEL
} = require('./imprimibles');

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
const ESTADOS_VALIDOS = ['pendiente', 'parcialmente_entregada', 'entregada', 'anulada'];
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

// (3/10/2026, pedido de Mato: "una venta puede tener varios remitos" —
// el cliente puede retirar parcialmente) cuánto queda sin entregar de
// cada ítem — lo que ya salió por algún remito anterior no cuenta.
function cantidadPendiente(item) {
  return Math.max(0, (item.cantidad || 0) - (item.cantidadEntregada || 0));
}

// Mueve lo comprometido de un depósito a otro (3/10/2026, pedido de
// Mato: "quiero que comprometas la mercaderia igual independientemente
// si hay deposito o no") — una venta "pendiente" sin depósito elegido
// queda comprometida en el depósito `null` ("sin asignar"); cuando se
// elige un depósito real para generar el remito, el compromiso de lo
// que todavía está pendiente se traslada ahí. `depositoViejo` puede ser
// `null`. No toca lo que ya se haya entregado (eso ya se descontó de
// donde correspondía en su momento).
async function migrarCompromisoDeposito(db, req, venta, depositoViejo, depositoNuevo) {
  if (String(depositoViejo) === String(depositoNuevo)) return;
  for (const item of venta.items) {
    if (!item.productoId) continue;
    const pendiente = cantidadPendiente(item);
    if (pendiente <= 0) continue;
    await db.collection('stock_actual').updateOne(
      Object.assign({ productoId: item.productoId, depositoId: depositoViejo }, filtroOrg(req)),
      { $inc: { cantidadComprometida: -pendiente }, $set: { actualizadoEn: new Date() } }
    );
    await db.collection('stock_actual').updateOne(
      Object.assign({ productoId: item.productoId, depositoId: depositoNuevo }, filtroOrg(req)),
      {
        $inc: { cantidadComprometida: pendiente },
        $setOnInsert: Object.assign({ productoId: item.productoId, depositoId: depositoNuevo, cantidad: 0 }, filtroOrg(req))
      },
      { upsert: true }
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
// (numerado, imprimible más adelante) y actualiza el estado de la venta.
// Para "entrega inmediata" se llama en el mismo momento de crear la
// venta (ver POST /); para una venta pendiente o parcialmente entregada,
// se llama desde POST /:id/entregar.
//
// `entregas` (3/10/2026, pedido de Mato: "una venta puede tener varios
// remitos... el cliente puede retirar parcialmente") es opcional: un
// array de `{ index, cantidad }` con el índice del ítem dentro de
// `venta.items` y cuánto se entrega AHORA de ese ítem (puede ser menos
// que lo pendiente). Si se omite, se entrega todo lo pendiente de todos
// los ítems (comportamiento de antes, y el que usa "entrega inmediata").
async function generarRemitoDeVenta(db, req, venta, depositoId, entregas) {
  const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
  if (!deposito) throw err(404, 'Depósito no encontrado');

  if (!entregas) {
    entregas = venta.items.map((it, index) => ({ index, cantidad: cantidadPendiente(it) }));
  }
  const itemsAEntregar = [];
  for (const e of entregas) {
    const index = Number(e.index);
    const it = venta.items[index];
    if (!it) throw err(400, 'Uno de los ítems a entregar no existe en esta venta.');
    let cantidad = Number(e.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) continue; // nada a entregar de este ítem ahora
    const pendiente = cantidadPendiente(it);
    if (cantidad > pendiente + 1e-9) {
      throw err(400, `No se puede entregar ${cantidad} de "${it.nombre}": solo queda pendiente ${pendiente}.`);
    }
    // Los bultos no se fraccionan (igual que al cargar la venta, ver
    // normalizarItems): red de seguridad server-side, el front ya manda la
    // cantidad redondeada al bulto entero. Si el redondeo para arriba se
    // pasa de lo pendiente (pendiente ya viene ajustado a bulto entero),
    // se entrega directamente todo lo pendiente.
    if (it.productoId) {
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: it.productoId }, filtroOrg(req)));
      if (producto && producto.unidadesPorBulto > 0) {
        const bultos = Math.ceil(cantidad / producto.unidadesPorBulto - 1e-9);
        cantidad = Math.round(bultos * producto.unidadesPorBulto * 100) / 100;
        if (cantidad > pendiente + 1e-9) cantidad = Math.round(pendiente * 100) / 100;
      }
    }
    itemsAEntregar.push({ index, productoId: it.productoId, sku: it.sku, nombre: it.nombre, cantidad });
  }
  if (!itemsAEntregar.length) throw err(400, 'No hay nada pendiente para entregar en esta venta.');

  // Recién ACÁ se cruza contra el stock físico real — si no alcanza, se
  // rechaza el remito (la venta sigue como estaba, con lo pendiente
  // todavía comprometido).
  await validarStockFisicoParaRemito(db, req, itemsAEntregar, depositoId);
  for (const item of itemsAEntregar) {
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
    items: itemsAEntregar.map(it => ({ productoId: it.productoId, sku: it.sku, nombre: it.nombre, cantidad: it.cantidad })),
    fecha: ahora,
    usuarioNombre: venta.usuarioNombre,
    orgId: req.orgId,
    createdAt: ahora
  };
  const r = await db.collection('remitos').insertOne(remito);
  remito._id = r.insertedId;

  // Acumula lo entregado en cada ítem de la venta y recalcula el estado
  // general: "entregada" solo cuando no quede nada pendiente en ningún
  // ítem, "parcialmente_entregada" si ya salió algo pero falta el resto,
  // "pendiente" si por algún motivo no se entregó nada (no debería pasar
  // acá, ya se valida arriba, pero queda la rama por si itemsAEntregar
  // termina vacío de cantidad real en algún caso límite).
  const itemsActualizados = venta.items.map((it, idx) => {
    const entrega = itemsAEntregar.find(e => e.index === idx);
    if (!entrega) return it;
    return Object.assign({}, it, { cantidadEntregada: (it.cantidadEntregada || 0) + entrega.cantidad });
  });
  const totalCantidad = itemsActualizados.reduce((s, it) => s + (it.cantidad || 0), 0);
  const totalEntregada = itemsActualizados.reduce((s, it) => s + (it.cantidadEntregada || 0), 0);
  const nuevoEstado = totalEntregada <= 0 ? 'pendiente' : (totalEntregada >= totalCantidad - 1e-9 ? 'entregada' : 'parcialmente_entregada');

  await db.collection('ventas').updateOne(
    { _id: venta._id },
    {
      $set: {
        items: itemsActualizados,
        estado: nuevoEstado,
        depositoId,
        stockDescontado: totalEntregada > 0,
        stockDescontadoEn: ahora,
        entregadaEn: nuevoEstado === 'entregada' ? ahora : (venta.entregadaEn || null),
        remitoId: remito._id,
        remitoNumero: remito.numero,
        updatedAt: ahora
      },
      $push: { remitosIds: remito._id }
    }
  );
  return remito;
}

// Revierte el stock de una venta anulada, cubriendo los tres casos
// posibles (3/10/2026, antes eran dos funciones separadas porque no
// existía la entrega parcial): lo que YA se entregó (tenía uno o varios
// remitos) se reingresa de verdad al físico; lo que todavía estaba
// comprometido sin entregar (toda la venta si estaba "pendiente", o el
// resto si estaba "parcialmente_entregada") se libera sin tocar el
// físico, porque nunca se había descontado.
async function revertirStockDeVentaAnulada(db, req, venta) {
  for (const item of venta.items || []) {
    if (!item.productoId) continue;
    const entregada = item.cantidadEntregada || 0;
    const pendiente = cantidadPendiente(item);
    if (entregada > 0) {
      await aplicarMovimientoStock(db, req, {
        productoId: item.productoId, depositoId: venta.depositoId, tipo: 'ingreso', cantidad: entregada,
        motivo: 'Anulación de venta', observaciones: `Anulación de venta ${venta.numero ? '#' + venta.numero : ''}`.trim(),
        ventaId: venta._id, usuarioNombre: venta.usuarioNombre, fecha: new Date()
      });
    }
    // (3/10/2026) antes se chequeaba `venta.depositoId` para saber si
    // había algo comprometido que liberar — pero ahora el compromiso
    // puede vivir en el depósito `null` ("sin asignar"), así que lo que
    // importa es `stockComprometido`, no si el depósito es un id real.
    if (pendiente > 0 && venta.stockComprometido) {
      await db.collection('stock_actual').updateOne(
        Object.assign({ productoId: item.productoId, depositoId: venta.depositoId }, filtroOrg(req)),
        { $inc: { cantidadComprometida: -pendiente }, $set: { actualizadoEn: new Date() } }
      );
    }
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
    let producto = null;
    if (productoId) {
      producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (!producto) throw err(400, 'Uno de los productos de la venta no existe (o no pertenece a esta organización)');
      nombre = producto.nombre;
      sku = producto.sku || null;
      if (precioBase === undefined || precioBase === null || precioBase === '') precioBase = producto.precio;
    }
    if (!nombre) throw err(400, 'Falta el nombre de un ítem de la venta');
    let cantidad = normalizarCantidadPositiva(it.cantidad, `La cantidad de "${nombre}"`);
    // Los bultos no se pueden fraccionar (3/10/2026, pedido de Mato: "los
    // bultos no pueden ser fracciones entonces tenemos que redondear
    // cuando hacemos la venta ajustando los m2") — se redondea siempre
    // PARA ARRIBA al bulto entero más cercano (nunca para abajo: el
    // cliente tiene que recibir al menos lo que pidió) y la cantidad
    // real (m2 u otra unidad) se reajusta para coincidir exacto con esos
    // bultos enteros. El frontend (admin-ventas.html) ya hace este mismo
    // ajuste en vivo mientras se carga la venta — esto es el resguardo
    // del lado del servidor, por si algo llega sin pasar por ahí.
    if (producto && producto.unidadesPorBulto > 0) {
      const bultos = Math.ceil(cantidad / producto.unidadesPorBulto - 1e-9);
      cantidad = Math.round(bultos * producto.unidadesPorBulto * 100) / 100;
    }
    const precioUnitario = normalizarMontoNoNegativo(precioBase, `El precio unitario de "${nombre}"`);
    const itemSubtotal = cantidad * precioUnitario;
    subtotal += itemSubtotal;
    // cantidadEntregada (3/10/2026, pedido de Mato: "una venta puede
    // tener varios remitos" — el cliente puede retirar parcialmente) va
    // acumulando cuánto de este ítem ya salió por remito; arranca en 0.
    items.push({ productoId, sku, nombre, cantidad, precioUnitario, subtotal: itemSubtotal, cantidadEntregada: 0 });
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

// Todos los remitos de una venta (3/10/2026, pedido de Mato: "una venta
// puede tener varios remitos... el cliente puede retirar parcialmente")
// — antes alcanzaba con el `remitoId` único de la venta; ahora puede
// haber uno por cada entrega parcial, así que el detalle de venta los
// lista a todos, más viejo primero.
router.get('/:id/remitos', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const remitos = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      return db.collection('remitos').find(Object.assign({ ventaId: id }, filtroOrg(req))).sort({ fecha: 1 }).toArray();
    });
    res.json(remitos);
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

// -----------------------------------------------------------------------
// Imprimibles (3/10/2026, pedido de Mato: "comencemos a trabajar en los
// imprimibles. el comprobante de venta..., recibo, remito, etc."). Las
// tres rutas de abajo devuelven HTML completo (texto, no JSON) armado
// con la plantilla compartida de imprimibles.js — el frontend las pide
// con fetch() (para poder mandar el header de autenticación, que una
// navegación directa a la URL no puede llevar) y abre el resultado en
// una pestaña nueva con document.write, igual que ya se hace para
// descargar los .xlsx (ver descargarBlob en los admin-*.html).
//
// Numeración (3/10/2026, pedido de Mato — pensando en la futura
// importación del historial de Dux): se imprime el `numero` que la
// venta/remito ya tiene (el correlativo interno, X/F + 5 dígitos). NO
// se inventa un formato nuevo. Cuando se importen las ventas viejas de
// Dux más adelante, la recomendación (a confirmar en ese momento) es
// conservar el número ORIGINAL de Dux tal cual estaba en el comprobante
// real (no renumerarlas para que encajen en este correlativo), marcadas
// con un origen "importado" — así el cliente sigue reconociendo su
// comprobante viejo, y el correlativo interno de acá no se pisa con
// números que nunca generó este sistema.
function datosNegocioParaImprimir(org) {
  return org || { nombre: 'Organización' };
}
// Rediseñado el 3/10/2026, pedido de Mato: "podes hacer el diseño del
// compr mas parecido a esto?" (mandó un comprobante real impreso desde
// Dux — logo en recuadro, razón social centrada, recuadro con la letra
// X/F, título+numeración+fecha a la derecha, línea de datos fiscales de
// la sucursal, recuadro de datos del cliente estilo Dux, tabla de ítems
// con % IVA/Subtotal c/IVA y condición de venta al pie). Ver
// `encabezadoComprobante`/`recuadroClienteComprobante` en imprimibles.js
// — es un encabezado propio del Comprobante, distinto del genérico que
// siguen usando Recibo y Remito.
//
// "Y cuando el producto tenga bultos pone las dos medidas" (mismo
// pedido, mismo día): la cantidad del ítem siempre está en la unidad
// real (m2, unidad, etc. — ver Stock), nunca en bultos; si el producto
// tiene `unidadesPorBulto` configurado, se muestra además la cantidad
// equivalente en bultos como una segunda línea chica debajo.
router.get('/:id/comprobante', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      const [org, cliente] = await Promise.all([
        db.collection('organizaciones').findOne({ _id: venta.orgId }),
        venta.clienteId ? db.collection('clientes').findOne({ _id: venta.clienteId }) : null
      ]);
      // (3/10/2026, corrección: "no aparece el dato" de bultos) algunos
      // ítems tienen `productoId` guardado como string en vez de
      // ObjectId (ventas viejas, u otro camino de carga) — el `$in`
      // contra `_id` no matchea un string contra un ObjectId, así que
      // hay que convertir cada uno con `toObjectId` antes de buscar.
      const productoIds = (venta.items || []).map(it => it.productoId ? toObjectId(it.productoId) : null).filter(Boolean);
      const productos = productoIds.length
        ? await db.collection('productos_catalogo').find({ _id: { $in: productoIds } }).project({ unidadesPorBulto: 1, unidad: 1 }).toArray()
        : [];
      const productosPorId = {};
      productos.forEach(p => { productosPorId[String(p._id)] = p; });
      return { venta, org, cliente, productosPorId };
    });
    const { venta, org, cliente, productosPorId } = resultado;
    const prefijo = venta.tipoComprobante === 'fiscal' ? 'F' : 'X';
    // Dux numera "punto de venta - correlativo" (ej. 00007-00000718); acá
    // no hay punto de venta propio (sin AFIP, ver "Decisiones de alcance
    // v1" más arriba), así que se imprime solo el correlativo interno,
    // con el mismo relleno de ceros a la izquierda.
    const numeroDigitos = String(venta.numero).padStart(5, '0');
    // Columna "Bultos" propia (3/10/2026, 2da vuelta — pedido de Mato: "no
    // aparecen los bultos... quiero que lo hagas tal cual dux"), en vez de
    // una línea chica debajo de la cantidad: Dux siempre tiene esa
    // columna en la tabla, así que acá también queda fija, con el valor
    // calculado (`cantidad / unidadesPorBulto`) cuando el producto tiene
    // `unidadesPorBulto` configurado, o "—" cuando no aplica.
    //
    // Bug real (3/10/2026, encontrado con el diagnóstico en vivo): la
    // condición pedía `unidadesPorBulto > 1`, pero hay productos (ej.
    // cerámicas por m2) donde un bulto es MENOS de 1 m2 —
    // `unidadesPorBulto` queda como 0.4, no como un entero mayor a 1.
    // Esa condición descartaba justo esos casos. Tiene que ser `> 0`.
    const filas = (venta.items || []).map(it => {
      const prod = it.productoId ? productosPorId[String(it.productoId)] : null;
      const unidad = (prod && prod.unidad) ? prod.unidad : '';
      const cantidadHtml = `${numImp(it.cantidad)}${unidad ? ' ' + escHtml(unidad) : ''}`;
      const bultosHtml = (prod && prod.unidadesPorBulto > 0) ? numImp(it.cantidad / prod.unidadesPorBulto) : '—';
      return `
        <tr>
          <td>${escHtml(it.sku || '—')} - ${escHtml(it.nombre)}</td>
          <td class="num">${cantidadHtml}</td>
          <td class="num">${bultosHtml}</td>
          <td class="num">${moneyImp(it.precioUnitario, venta.moneda)}</td>
          <td class="num">${moneyImp(it.subtotal, venta.moneda)}</td>
          <td class="num">0%</td>
          <td class="num">${moneyImp(it.subtotal, venta.moneda)}</td>
        </tr>
      `;
    }).join('');
    const ivaClienteLabel = (cliente && cliente.categoriaFiscal && CATEGORIA_FISCAL_LABEL[cliente.categoriaFiscal]) || '';
    const detalleVenta = [];
    if (venta.vendedor) detalleVenta.push(`Vendedor: ${escHtml(venta.vendedor)}`);
    if (venta.moneda && venta.moneda !== 'ARS') detalleVenta.push(`Moneda: ${escHtml(venta.moneda)}`);
    detalleVenta.push(venta.tipoEntrega === 'inmediata' ? 'Entrega inmediata' : 'Entrega pendiente');
    const headerHtml = encabezadoComprobante(org, {
      letra: prefijo,
      numeroFmt: numeroDigitos,
      fecha: fechaCorta(venta.fecha),
      tituloGrande: venta.tipoComprobante === 'fiscal' ? 'FACTURA' : 'COMPROBANTE'
    });
    const bodyHtml = `
      ${recuadroClienteComprobante({
        nombre: venta.clienteNombre,
        iva: ivaClienteLabel,
        cuit: cliente ? cliente.cuit : '',
        domicilio: cliente ? cliente.domicilio : '',
        localidad: cliente ? cliente.localidad : '',
        provincia: cliente ? cliente.provincia : '',
        email: cliente ? cliente.email : '',
        condicionPago: cliente ? cliente.condicionPago : '',
        observaciones: venta.observaciones
      })}
      <p class="muted" style="margin:-8px 0 10px 0;font-size:11.5px">${detalleVenta.join(' · ')}</p>
      <table>
        <thead><tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Bultos</th><th class="num">Precio Uni.</th><th class="num">Sub Total</th><th class="num">% IVA</th><th class="num">Sub Total c/IVA</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="7" class="muted">Sin ítems</td></tr>'}</tbody>
      </table>
      <table class="totales">
        <tr><td>Subtotal</td><td class="num">${moneyImp(venta.subtotal, venta.moneda)}</td></tr>
        ${venta.descuentoMonto ? `<tr><td>Descuento</td><td class="num">-${moneyImp(venta.descuentoMonto, venta.moneda)}</td></tr>` : ''}
        <tr><td>Monto IVA</td><td class="num">${moneyImp(0, venta.moneda)}</td></tr>
        <tr class="total-final"><td>Total</td><td class="num">${moneyImp(venta.total, venta.moneda)}</td></tr>
        <tr><td>Cobrado</td><td class="num">${moneyImp(venta.totalCobrado, venta.moneda)}</td></tr>
        ${venta.saldoPendiente > 0 ? `<tr><td>Saldo pendiente</td><td class="num">${moneyImp(venta.saldoPendiente, venta.moneda)}</td></tr>` : ''}
      </table>
      ${org && org.condicionVenta ? `<div class="cmp-condicion-venta"><strong>Condición de venta:</strong><br>${escHtml(org.condicionVenta)}</div>` : ''}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({
      titulo: `Comprobante Nº ${prefijo}-${numeroDigitos}`,
      org: datosNegocioParaImprimir(org),
      headerHtml,
      bodyHtml
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/remitos/:id/imprimir', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const remito = await db.collection('remitos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!remito) throw err(404, 'Remito no encontrado');
      const org = await db.collection('organizaciones').findOne({ _id: remito.orgId });
      // Mismo criterio que el Comprobante (3/10/2026, pedido de Mato: "en
      // remito tambien pone las dos unidades de medida") — se busca el
      // producto de cada ítem para saber si tiene `unidadesPorBulto`
      // configurado y mostrar la cantidad también en bultos.
      // Misma corrección que el Comprobante: convertir cada productoId a
      // ObjectId antes del `$in` (puede venir como string).
      const productoIds = (remito.items || []).map(it => it.productoId ? toObjectId(it.productoId) : null).filter(Boolean);
      const productos = productoIds.length
        ? await db.collection('productos_catalogo').find({ _id: { $in: productoIds } }).project({ unidadesPorBulto: 1, unidad: 1 }).toArray()
        : [];
      const productosPorId = {};
      productos.forEach(p => { productosPorId[String(p._id)] = p; });
      return { remito, org, productosPorId };
    });
    const { remito, org, productosPorId } = resultado;
    const numeroFmt = String(remito.numero).padStart(5, '0');
    const filas = (remito.items || []).map(it => {
      const prod = it.productoId ? productosPorId[String(it.productoId)] : null;
      const unidad = (prod && prod.unidad) ? prod.unidad : '';
      const cantidadHtml = `${numImp(it.cantidad)}${unidad ? ' ' + escHtml(unidad) : ''}`;
      const bultosHtml = (prod && prod.unidadesPorBulto > 0) ? numImp(it.cantidad / prod.unidadesPorBulto) : '—';
      return `
        <tr>
          <td>${escHtml(it.sku || '—')}</td>
          <td>${escHtml(it.nombre)}</td>
          <td class="num">${cantidadHtml}</td>
          <td class="num">${bultosHtml}</td>
        </tr>
      `;
    }).join('');
    const bodyHtml = `
      <h1>Remito Nº ${numeroFmt}</h1>
      <div class="datos-doc">
        <div>
          <strong>Cliente:</strong> ${escHtml(remito.clienteNombre)}<br>
          <span class="muted">Comprobante asociado: Nº ${String(remito.ventaNumero).padStart(5, '0')}</span>
        </div>
        <div>
          <strong>Fecha:</strong> ${fechaLarga(remito.fecha)}<br>
          <strong>Depósito:</strong> ${escHtml(remito.depositoNombre)}
        </div>
      </div>
      <table>
        <thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Bultos</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="4" class="muted">Sin ítems</td></tr>'}</tbody>
      </table>
      <p class="muted" style="margin-top:30px">Recibí conforme — firma y aclaración: ________________________________</p>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({ titulo: `Remito Nº ${numeroFmt}`, org: datosNegocioParaImprimir(org), bodyHtml }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Recibo de UN cobro puntual de la venta (`pagos[index]`) — los pagos
// son un array append-only sin _id propio (ver POST /:id/pagos), así que
// se identifican por posición, igual que ya hace el resto de la pantalla
// de detalle de venta para mostrarlos.
router.get('/:id/pagos/:index/recibo', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    const index = Number(req.params.index);
    if (!id) throw err(400, 'id inválido');
    if (!Number.isInteger(index) || index < 0) throw err(400, 'índice de pago inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      const pago = (venta.pagos || [])[index];
      if (!pago) throw err(404, 'Ese cobro no existe');
      const org = await db.collection('organizaciones').findOne({ _id: venta.orgId });
      return { venta, pago, org };
    });
    const { venta, pago, org } = resultado;
    const TIPO_VALOR_LABEL = { efectivo: 'Efectivo', cheque: 'Cheque', cuenta: 'Transferencia', tarjeta: 'Tarjeta' };
    const bodyHtml = `
      <h1>Recibo — Venta Nº ${String(venta.numero).padStart(5, '0')}</h1>
      <div class="datos-doc">
        <div>
          <strong>Recibí de:</strong> ${escHtml(venta.clienteNombre)}<br>
          <strong>La suma de:</strong> ${moneyImp(pago.monto, venta.moneda)}
        </div>
        <div>
          <strong>Fecha:</strong> ${fechaLarga(pago.fecha)}<br>
          <strong>Forma de pago:</strong> ${TIPO_VALOR_LABEL[pago.tipoValor] || escHtml(pago.tipoValor)}
          ${pago.tipoValor === 'tarjeta' ? `<br><span class="muted">Lote ${escHtml(pago.tarjetaLote || '—')} / Cupón ${escHtml(pago.tarjetaCupon || '—')}</span>` : ''}
        </div>
      </div>
      <p>En concepto de pago de la Venta Nº ${String(venta.numero).padStart(5, '0')}.${pago.nota ? ` ${escHtml(pago.nota)}` : ''}</p>
      <p class="muted" style="margin-top:40px">Firma y aclaración: ________________________________</p>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({ titulo: `Recibo — Venta Nº ${venta.numero}`, org: datosNegocioParaImprimir(org), bodyHtml }));
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
    // El depósito es obligatorio SOLO para "entrega inmediata" (3/10/2026,
    // corregido a pedido de Mato: "si no pongo entrega inmediata no me
    // deberia pedir deposito" — había quedado obligatorio siempre desde el
    // 2/10/2026, pero eso era un paso de más para una venta que todavía
    // no se va a entregar). Con "no entrega"/pendiente, el depósito es
    // opcional: si se elige, se compromete el stock ahí mismo; si no, el
    // compromiso se hace recién al entregar (POST /:id/entregar, que ya
    // sabía manejar este caso desde antes, para ventas viejas sin
    // depósito elegido al cargarlas).
    if (tipoEntrega === 'inmediata' && !depositoId) throw err(400, 'Elegí a qué depósito le vas a entregar la venta.');
    const vendedor = normalizarTexto(body.vendedor) || (req.usuario && req.usuario.nombre) || '';
    const descuentoPorcentaje = body.descuentoPorcentaje ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : 0;
    const descuentoMonto = body.descuentoMonto ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : 0;
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cliente = await db.collection('clientes').findOne(Object.assign({ _id: clienteId }, filtroOrg(req)));
      if (!cliente) throw err(400, 'El cliente no existe (o no pertenece a esta organización)');
      if (depositoId) {
        const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
        if (!deposito) throw err(404, 'Depósito no encontrado');
      }
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
        // stockComprometido (3/10/2026): true desde ahora, siempre — se
        // compromete al cargar la venta tenga o no depósito elegido
        // (ver más abajo). Distingue de una venta vieja (de antes de
        // este cambio) sin depósito, que en cambio nunca comprometió
        // nada — POST /:id/entregar lo necesita para decidir si hay que
        // comprometer recién ahora o solo migrar lo ya comprometido.
        stockComprometido: true,
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
        remitosIds: [],
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

      // Cuenta corriente del cliente (2/10/2026, pedido de Mato): la
      // venta genera deuda por el total — Nueva Venta no carga cobros en
      // el mismo paso, así que siempre arranca en saldoPendiente = total.
      if (total > 0) {
        await registrarMovimientoCuentaCorriente(db, req, {
          clienteId, clienteNombre: venta.clienteNombre, tipo: 'debito', monto: total, moneda,
          concepto: `Venta Nº ${numero}`, origen: 'venta', ventaId: venta._id, fecha
        });
      }

      // El stock se COMPROMETE ya mismo siempre (3/10/2026, pedido de
      // Mato: "quiero que comprometas la mercaderia igual
      // independientemente si hay deposito o no") — antes, sin depósito
      // elegido (solo posible con "no entrega"), quedaba sin reservar
      // hasta entregar; ahora se reserva igual, en un "depósito" null
      // (sin asignar todavía) que Stock muestra aparte. Cuando se elija
      // un depósito real (al generar el remito), ese compromiso se
      // migra ahí — ver migrarCompromisoDeposito.
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

// Genera un remito de una venta "pendiente" o "parcialmente_entregada"
// — recién ahí se descuenta de verdad el stock que ya estaba
// comprometido. `body.items` (3/10/2026, pedido de Mato: "una venta
// puede tener varios remitos... el cliente puede retirar parcialmente")
// es opcional: `[{ index, cantidad }]` con cuánto entregar AHORA de
// cada ítem (por índice dentro de venta.items). Si se omite, se entrega
// todo lo que estaba pendiente (comportamiento de antes).
router.post('/:id/entregar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const depositoIdBody = (req.body && req.body.depositoId) ? toObjectId(req.body.depositoId) : null;
    const itemsBody = (req.body && Array.isArray(req.body.items)) ? req.body.items : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada.');
      if (venta.estado === 'entregada') throw err(400, 'Esta venta ya tiene todo entregado.');

      const depositoId = venta.depositoId || depositoIdBody;
      if (!depositoId) throw err(400, 'Elegí a qué depósito le vas a descontar el stock.');

      if (venta.stockComprometido) {
        // (3/10/2026) ya estaba comprometido en algún lado — en el
        // depósito de la venta si tenía uno, o en el "sin asignar"
        // (null) si no. Si el depósito elegido ahora es otro, se migra
        // lo pendiente antes de generar el remito.
        await migrarCompromisoDeposito(db, req, venta, venta.depositoId, depositoId);
      } else {
        // Venta cargada antes de este cambio (sin depósito ni reserva
        // hecha al momento de guardarla) — se compromete recién ahora,
        // como paso previo a generar el remito (que valida el stock
        // físico real antes de descontar — ver generarRemitoDeVenta).
        await comprometerStockDeVenta(db, req, venta.items, depositoId);
      }

      const entregas = itemsBody ? itemsBody.map(it => ({ index: it.index, cantidad: it.cantidad })) : null;
      await generarRemitoDeVenta(db, req, venta, depositoId, entregas);
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anula una venta. Si ya se había entregado algo (uno o varios remitos),
// reingresa al físico lo entregado y libera lo que quedaba pendiente sin
// entregar. Si todavía estaba "pendiente" (solo comprometido, sin
// ningún remito), libera esa reserva sin tocar el stock físico — nunca
// se había descontado nada.
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

      // (3/10/2026) una sola función cubre los tres casos — pendiente sin
      // nada entregado, entregada del todo, o con uno o varios remitos
      // parciales — porque ahora puede haber una mezcla de ambas cosas
      // en la misma venta (parte entregada, parte todavía comprometida).
      await revertirStockDeVentaAnulada(db, req, venta);

      // Cuenta corriente del cliente (2/10/2026): al anular, se le
      // devuelve al cliente la deuda que le quedaba pendiente de ESTA
      // venta (lo ya cobrado ya generó su propio crédito al cobrarse —
      // acá solo se cancela lo que faltaba).
      if (venta.saldoPendiente > 0) {
        await registrarMovimientoCuentaCorriente(db, req, {
          clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto: venta.saldoPendiente, moneda: venta.moneda || 'ARS',
          concepto: `Anulación venta Nº ${venta.numero}`, origen: 'venta', ventaId: venta._id, observaciones: motivo
        });
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
    // Fecha del cobro editable (2/10/2026, pedido de Mato: "la cobranza
    // deberia dejarnos cambiar la fecha por si en algun momento se pasa y
    // lo cargamos despues") — por defecto es ahora, como siempre fue.
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

    // Tesorería (2/10/2026): efectivo/cuenta/tarjeta se acredita ya mismo
    // en una caja o banco; cheque crea un cheque de terceros en cartera
    // (no mueve plata todavía — eso pasa al depositarlo, desde Tesorería).
    // Pedido de Mato: efectivo SOLO puede ir a una caja (no a un banco —
    // un banco es cuando el cliente hace una transferencia real); cuenta
    // (transferencia) y tarjeta solo pueden ir a un banco.
    let cuentaTipo = null, cuentaId = null;
    if (tipoValor !== 'cheque') {
      cuentaTipo = normalizarTexto(body.cuentaTipo).toLowerCase();
      if (!['caja', 'banco'].includes(cuentaTipo)) throw err(400, 'Elegí a qué caja o banco va el cobro.');
      if (tipoValor === 'efectivo' && cuentaTipo !== 'caja') throw err(400, 'Un cobro en efectivo solo puede ir a una caja.');
      if ((tipoValor === 'cuenta' || tipoValor === 'tarjeta') && cuentaTipo !== 'banco') throw err(400, 'Un cobro por transferencia o tarjeta solo puede ir a un banco.');
      cuentaId = toObjectId(body.cuentaId);
      if (!cuentaId) throw err(400, 'Caja/banco inválido');
    }

    let chequeDatos = null;
    if (tipoValor === 'cheque') {
      chequeDatos = {
        numero: normalizarTexto(body.chequeNumero),
        banco: normalizarTexto(body.chequeBanco),
        librador: normalizarTexto(body.chequeLibrador),
        // CUIT del librador (2/10/2026, pedido de Mato).
        cuitLibrador: normalizarTexto(body.chequeCuitLibrador),
        fechaEmision: body.chequeFechaEmision ? new Date(body.chequeFechaEmision) : fecha,
        fechaVencimiento: body.chequeFechaVencimiento ? new Date(body.chequeFechaVencimiento) : null,
        observaciones: normalizarTexto(body.chequeObservaciones)
      };
      if (!chequeDatos.numero) throw err(400, 'Falta el número de cheque.');
      if (!chequeDatos.fechaVencimiento) throw err(400, 'Falta la fecha de vencimiento del cheque.');
    }

    // Tarjeta (2/10/2026, pedido de Mato: "las tarjetas esta bastante
    // incompleta" — Dux pide lote y cupón al cobrar con tarjeta; se suman
    // también entidad/tipo/cuotas/código de autorización, que no están
    // enumerados en el artículo de Dux pero son los datos habituales de un
    // cupón de tarjeta real — razonamiento propio, documentado acá).
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

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada, no se le pueden registrar cobros.');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      let chequeId = null;

      if (tipoValor === 'cheque') {
        const cheque = Object.assign({
          tipo: 'tercero', moneda: venta.moneda || 'ARS', monto, estado: 'en_cartera',
          clienteId: venta.clienteId || null, clienteNombre: venta.clienteNombre || '',
          ventaId: id, compraId: null, cuentaId: null, depositadoEnCuentaId: null, endosadoA: null,
          usuarioNombre, fecha, orgId: req.orgId, createdAt: new Date(), updatedAt: new Date()
        }, chequeDatos);
        const { insertedId } = await db.collection('cheques').insertOne(cheque);
        chequeId = insertedId;
      } else {
        const observacionesMovimiento = tipoValor === 'tarjeta'
          ? [nota, `Lote ${tarjetaDatos.tarjetaLote || '—'} / Cupón ${tarjetaDatos.tarjetaCupon || '—'}`].filter(Boolean).join(' — ')
          : nota;
        await aplicarMovimientoCuenta(db, req, {
          cuentaTipo, cuentaId, tipo: 'ingreso', monto, moneda: venta.moneda || 'ARS',
          motivo: `Cobro venta Nº ${venta.numero}`, observaciones: observacionesMovimiento, origen: 'venta', ventaId: id, fecha
        });
      }

      const pago = Object.assign(
        { tipoValor, monto, fecha, nota, usuarioNombre },
        cuentaTipo ? { cuentaTipo, cuentaId } : {},
        chequeId ? { chequeId } : {},
        tarjetaDatos || {}
      );
      const totalCobrado = (venta.totalCobrado || 0) + monto;
      const saldoPendiente = Math.max(0, venta.total - totalCobrado);
      await db.collection('ventas').updateOne(
        { _id: id },
        { $push: { pagos: pago }, $set: { totalCobrado, saldoPendiente, updatedAt: new Date() } }
      );

      // Cuenta corriente del cliente (2/10/2026): el cobro reduce la
      // deuda, además del ingreso real en Tesorería (o el cheque en
      // cartera) ya aplicado arriba.
      await registrarMovimientoCuentaCorriente(db, req, {
        clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto, moneda: venta.moneda || 'ARS',
        concepto: `Cobro venta Nº ${venta.numero}`, origen: 'cobro_venta', ventaId: id, chequeId, fecha
      });

      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
