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
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, filtroOrgClientes, cargarClienteParaOperar } = require('./usuarios');
const { exportarXlsx } = require('./importExport');
// Tesorería (2/10/2026): un cobro en efectivo/cuenta/tarjeta tiene que
// acreditarse YA en una caja/banco real; un cobro en cheque crea un
// cheque "de terceros" en cartera. Se reusan estas dos funciones de
// tesoreria.js (en vez de reimplementarlas) porque son lógica de
// negocio sensible al dinero — ver la nota en tesoreria.js.
const { aplicarMovimientoCuenta, cuentaHabilitada, calcularPlanTarjeta } = require('./tesoreria');
// Cuenta corriente del cliente (2/10/2026, pedido de Mato) — ver el
// comentario grande de registrarMovimientoCuentaCorriente en clientes.js.
const { registrarMovimientoCuentaCorriente } = require('./clientes');
// Fiscal (5/10/2026, "parte fiscal") — IVA por alícuota y autorización en
// ARCA (CAE) de las ventas fiscales. Ver fiscalEmision.js / arca.js.
const emisionFiscal = require('./fiscalEmision');
const arcaLib = require('./arca');
const QRCode = require('qrcode');

// Retenciones sufridas en un cobro (5/10/2026, pedido de Mato: "en
// cobranzas, muchas veces tenemos retenciones") — ver impuestos.js. El
// monto cobrado (efectivo/cheque/transferencia) es lo que entra a la
// caja o banco; la retención cancela deuda del cliente sin que entre
// plata, así que lo aplicado a la venta/cuenta corriente es cobrado +
// retenciones.
const { normalizarLineasImpuesto, TIPOS_RETENCION, sumarMontos, registrarRetencionesSufridas, tiposImpuestosHandler } = require('./impuestos');
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
let mongoConectando = null;
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
  const db = mongoClient.db(DB_NAME);
  await asegurarIndices(db);
  return db;
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e && e.status) throw e; // un rechazo de negocio (400/404…) no se reintenta: si ya había escrito algo, lo duplicaría
    mongoClient = null;
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }

// Nombre completo del cliente para mostrar/imprimir: "Apellido Nombre" (apellido/razón social + nombre). Si el comprobante se
// guardó antes con solo el apellido, al imprimir se vuelve a armar desde la ficha del cliente.
function nombreCompletoCliente(c) { return c ? [c.apellidoRazonSocial, c.nombre].filter(Boolean).join(' ').trim() : ''; }
async function nombreClienteImpreso(clienteId, guardado) {
  try {
    if (!clienteId) return guardado || '';
    const db = await getDb();
    const c = await db.collection('clientes').findOne({ _id: clienteId }, { projection: { apellidoRazonSocial: 1, nombre: 1 } });
    return nombreCompletoCliente(c) || guardado || '';
  } catch (e) { return guardado || ''; }
}

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
const TIPOS_COMPROBANTE_VALIDOS = ['comprobante_x', 'fiscal', 'nota_credito', 'nota_debito'];

// Nota de Crédito/Débito (3/10/2026, pedido de Mato: "agregar la
// posibilidad de hacer nota de credito y debito") — se guardan en la
// MISMA colección "ventas" (reutilizan cliente/ítems/numeración/
// impresión), pero no pasan por el circuito de entrega/remito de una
// venta normal: se resuelven en el momento, con estado 'entregada'
// directo. Una Nota de Crédito reingresa stock de verdad (ingreso
// directo, no comprometido) y resta deuda del cliente (movimiento
// 'credito'); una Nota de Débito solo agrega deuda (movimiento
// 'debito', igual que una venta) sin tocar stock para nada — no hay
// mercadería física de por medio. Numeración propia para cada una (ver
// proximoNumero, que ya separa por tipoComprobante).
const PREFIJO_COMPROBANTE = { fiscal: 'F', comprobante_x: 'X', nota_credito: 'NC', nota_debito: 'ND' };
const TITULO_DOC_RECIBO = (v, conArticulo) => v.tipoComprobante === 'nota_debito' ? (conArticulo ? 'la Nota de Débito' : 'Nota de Débito') : v.tipoComprobante === 'nota_credito' ? (conArticulo ? 'la Nota de Crédito' : 'Nota de Crédito') : (conArticulo ? 'la Venta' : 'Venta');
const TITULO_COMPROBANTE = { fiscal: 'FACTURA', comprobante_x: 'COMPROBANTE', nota_credito: 'NOTA DE CRÉDITO', nota_debito: 'NOTA DE DÉBITO' };
// Usado solo como FALLBACK al imprimir un comprobante viejo (de antes del
// 3/10/2026) que no tiene `letra` guardada — todo lo nuevo usa
// directamente `venta.letra` (ver letraFiscalParaCliente más abajo).
function prefijoComprobante(tipo) { return PREFIJO_COMPROBANTE[tipo] || 'X'; }

// Letra real de AFIP para un comprobante fiscal (3/10/2026, pedido de
// Mato: "nota de credito y debito tambien pueden ser fiscal... x para
// no fiscal y las letras fiscales para la que corresponda"; regla
// confirmada: "A = Responsable Inscripto, B = el resto"). El punto de
// venta real (ej. 00007) queda para cuando se arme la parte fiscal
// completa (Mato: "es un campo que vamos a asignar cuando armemos la
// parte fiscal") — por ahora el comprobante sigue imprimiéndose como
// "<letra>-<correlativo>".
function letraFiscalParaCliente(cliente) {
  // Un Responsable Inscripto emite A a otro Responsable Inscripto y también al
  // monotributista; B al resto (consumidor final, exento, no alcanzado).
  const cat = cliente && cliente.categoriaFiscal;
  return (cat === 'responsable_inscripto' || cat === 'monotributista') ? 'A' : 'B';
}

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
// En "vista todas" las acciones se hacen con la sucursal de operación elegida arriba; si la venta es de OTRA sucursal
// no se encontraba ("Venta no encontrada"). Acá se busca por id y se opera con la sucursal propia de la venta.
async function buscarVentaOperable(db, req, id) {
  let venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
  if (!venta && req.vistaTodas) {
    venta = await db.collection('ventas').findOne({ _id: id });
    if (venta && venta.orgId) { req.orgId = venta.orgId; req.orgOperar = venta.orgId; }
  }
  return venta;
}



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

router.get('/tipos-impuestos', authAdmin, tiposImpuestosHandler);

router.get('/clientes', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrgClientes(req));
    const lista = await conReintento(async () => {
      const db = await getDb();
      // categoriaFiscal (3/10/2026) se agrega a la proyección para que el
      // front pueda mostrar en el momento qué letra (A/B) le va a tocar a
      // una Factura o a una Nota de Crédito/Débito fiscal antes de guardar.
      return db.collection('clientes')
        .find(match, { projection: { apellidoRazonSocial: 1, nombre: 1, tipoCliente: 1, cuit: 1, categoriaFiscal: 1 } })
        .sort({ apellidoRazonSocial: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/productos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    // Búsqueda en el servidor (3/10/2026): ya no se baja el catálogo entero
    // (25.000+ productos). ?q= (todas las palabras en sku o nombre),
    // ?ids=a,b,c (productos puntuales) y ?limite=.
    if (req.query.q) {
      const palabras = String(req.query.q).trim().split(/\s+/).filter(Boolean).slice(0, 6);
      if (palabras.length) match.$and = palabras.map(w => {
        const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return { $or: [{ sku: re }, { nombre: re }] };
      });
    }
    if (req.query.ids) {
      const ids = String(req.query.ids).split(',').map(x => toObjectId(x.trim())).filter(Boolean).slice(0, 200);
      match._id = { $in: ids };
    }
    const limiteProd = req.query.limite ? Math.min(Math.max(parseInt(req.query.limite, 10) || 30, 1), 200) : 0;
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
        .find(match, { projection: { sku: 1, nombre: 1, precio: 1, costo: 1, preciosPorLista: 1, unidad: 1, unidadesPorBulto: 1, porcentajeIva: 1, stockeable: 1, aceptaStockNegativo: 1 } })
        .sort({ nombre: 1 }).limit(limiteProd || 0).toArray();
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
// El comprometido es siempre contra el depósito Junín de la sucursal (15/10/2026, pedido de Mato: Colome es solo el depósito del
// proveedor; el faltante se compara contra Junín). Devuelve su _id, o null si la organización no tiene un depósito Junín.
async function depositoJuninDe(db, orgId) {
  const d = await db.collection('depositos').findOne({ orgId, activo: { $ne: false }, nombre: /jun[ií]n/i });
  return d ? d._id : null;
}
async function comprometerStockDeVenta(db, req, items, depositoId) {
  for (const item of items) {
    if (!item.productoId) continue;
    const aComprometer = cantidadPendiente(item); // lo ya entregado (p. ej. migrado de Dux) no se compromete
    if (aComprometer <= 0) continue;
    await db.collection('stock_actual').updateOne(
      Object.assign({ productoId: item.productoId, depositoId }, filtroOrg(req)),
      {
        $inc: { cantidadComprometida: aComprometer },
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
  return Math.max(0, (item.cantidad || 0) - (item.cantidadEntregada || 0) - (item.cantidadAcreditada || 0));
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
async function generarRemitoDeVenta(db, req, venta, depositoId, entregas, observaciones) {
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
    // (14/10/2026, pedido de Mato) en el remito se puede entregar en m²/unidades o en bultos, sin forzar bulto entero.
    itemsAEntregar.push({ index, productoId: it.productoId, sku: it.sku, nombre: it.nombre, cantidad });
  }
  if (!itemsAEntregar.length) throw err(400, 'No hay nada pendiente para entregar en esta venta.');

  // Recién ACÁ se cruza contra el stock físico real — si no alcanza, se
  // rechaza el remito (la venta sigue como estaba, con lo pendiente
  // todavía comprometido).
  // Ventas migradas de Dux: el stock cargado puede no reflejar lo pendiente de entrega histórico, no se bloquea el remito.
  if (!venta.importado) await validarStockFisicoParaRemito(db, req, itemsAEntregar, depositoId);
  for (const item of itemsAEntregar) {
    if (!item.productoId) continue;
    await aplicarMovimientoStock(db, req, {
      productoId: item.productoId, depositoId, tipo: 'egreso', cantidad: item.cantidad,
      motivo: 'Venta', observaciones: `Venta ${venta.numero ? '#' + venta.numero : ''}`.trim(),
      ventaId: venta._id, usuarioNombre: (req.usuario && req.usuario.nombre) || venta.usuarioNombre, fecha: new Date() // la baja es del día del remito, no de la venta
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
    observaciones: String(observaciones || '').trim().slice(0, 1000),
    usuarioNombre: (req.usuario && req.usuario.nombre) || venta.usuarioNombre,
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
  const totalCerrado = totalEntregada + itemsActualizados.reduce((s, it) => s + (it.cantidadAcreditada || 0), 0);
  const nuevoEstado = totalCerrado <= 0 ? 'pendiente' : (totalCerrado >= totalCantidad - 1e-9 ? 'entregada' : 'parcialmente_entregada');

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
  if (venta.tipoComprobante === 'nota_credito') {
    if (venta.reingresaStock === false || !venta.stockDescontado) return; // no movió stock
    // Al crearse, una Nota de Crédito reingresa stock DE VERDAD (ingreso
    // directo, ver POST /) — anularla deshace exactamente eso: un egreso
    // por la misma cantidad, del mismo depósito.
    for (const item of venta.items || []) {
      if (!item.productoId) continue;
      await aplicarMovimientoStock(db, req, {
        productoId: item.productoId, depositoId: venta.depositoId, tipo: 'egreso', cantidad: item.cantidad,
        motivo: 'Anulación de nota de crédito', observaciones: `Anulación de nota de crédito ${venta.numero ? '#' + venta.numero : ''}`.trim(),
        ventaId: venta._id, usuarioNombre: (req.usuario && req.usuario.nombre) || venta.usuarioNombre, fecha: new Date()
      });
    }
    return;
  }
  // Nota de Débito: nunca movió stock, no hay nada que revertir acá — el
  // loop de abajo es un no-op para ella (stockComprometido es false y
  // cantidadEntregada nunca se usó para reservar nada).
  for (const item of venta.items || []) {
    if (!item.productoId) continue;
    const entregada = item.cantidadEntregada || 0;
    const pendiente = cantidadPendiente(item);
    if (entregada > 0) {
      await aplicarMovimientoStock(db, req, {
        productoId: item.productoId, depositoId: venta.depositoId, tipo: 'ingreso', cantidad: entregada,
        motivo: 'Anulación de venta', observaciones: `Anulación de venta ${venta.numero ? '#' + venta.numero : ''}`.trim(),
        ventaId: venta._id, usuarioNombre: (req.usuario && req.usuario.nombre) || venta.usuarioNombre, fecha: new Date()
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
    // Descuento por artículo (15/10/2026, pedido de Mato, igual que en Compras): % sobre el precio de esa línea.
    const descuentoPorcentaje = it.descuentoPorcentaje ? Number(it.descuentoPorcentaje) : 0;
    if (!Number.isFinite(descuentoPorcentaje) || descuentoPorcentaje < 0 || descuentoPorcentaje > 100) throw err(400, `El descuento (%) de "${nombre}" tiene que estar entre 0 y 100`);
    const itemSubtotal = Math.round(cantidad * precioUnitario * (1 - descuentoPorcentaje / 100) * 100) / 100;
    subtotal += itemSubtotal;
    // cantidadEntregada (3/10/2026, pedido de Mato: "una venta puede
    // tener varios remitos" — el cliente puede retirar parcialmente) va
    // acumulando cuánto de este ítem ya salió por remito; arranca en 0.
    // porcentajeIva (5/10/2026, parte fiscal): alícuota de IVA del producto al
    // momento de la venta; null si el producto no la tiene cargada (para una
    // venta fiscal se usa entonces la alícuota por defecto de Fiscal).
    let porcentajeIva = (producto && producto.porcentajeIva !== undefined && producto.porcentajeIva !== null && producto.porcentajeIva !== '') ? Number(producto.porcentajeIva) : null;
    // IVA editable por ítem (15/10/2026, pedido de Mato): si el ítem trae su alícuota, manda sobre la del producto.
    if (it.porcentajeIva !== undefined && it.porcentajeIva !== null && it.porcentajeIva !== '') {
      const p = Number(it.porcentajeIva);
      if (!Number.isFinite(p) || ![0, 2.5, 5, 10.5, 21, 27].some(a => Math.abs(a - p) < 1e-9)) throw err(400, `La alícuota de IVA de "${nombre}" tiene que ser 0, 2.5, 5, 10.5, 21 o 27`);
      porcentajeIva = p;
    }
    items.push({ productoId, sku, nombre, cantidad, precioUnitario, descuentoPorcentaje, subtotal: itemSubtotal, porcentajeIva, cantidadEntregada: 0 });
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

// Resumen de ventas del día y del mes (7/10/2026, pedido de Mato): tarjetas
// bajo los filtros del listado. Día/mes en horario de Argentina (-03:00).
// No cuenta anuladas; las notas de crédito restan y las de débito suman al
// monto, y ninguna de las dos cuenta como "venta" en la cantidad.
// Próximo número de comprobante (sin consumirlo) para mostrarlo en la
// pantalla de carga: ?tipo=comprobante_x|fiscal|nota_credito|nota_debito&letra=A|B|X
// Criterios fiscales por defecto de la sucursal (para mostrar el IVA al cargar una factura).
router.get('/fiscal-defaults', authAdmin, async (req, res) => {
  try {
    const db = await getDb();
    const cfg = await emisionFiscal.getConfig(db, req.orgId);
    res.json({ ivaDefecto: cfg.ivaDefecto, preciosIncluyenIvaDefecto: cfg.preciosIncluyenIvaDefecto !== false });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Asociar una Nota de Crédito a una factura (15/10/2026, pedido de Mato): la nota se "aplica" a la factura, que baja su saldo
// (y queda CANCELADA si la nota la cubre entera). La cuenta corriente del cliente no se toca: la nota ya le acreditó el total.
// En la factura: totalAcreditado + notasAplicadas:[{notaId, numero, letra, monto, fecha}]. En la nota: aplicadaA:{ventaId, ...}, totalAplicado.
// ---------------------------------------------------------------------------
const r2n = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function etiquetaNota(n) { return `${n.letra || 'X'}-${String(n.numero).padStart(5, '0')}`; }
async function aplicarNotaAFactura(db, req, nota, facturaId, montoPedido) {
  if (nota.tipoComprobante !== 'nota_credito') throw err(400, 'Solo una Nota de Crédito se puede aplicar a una factura.');
  if (nota.estado === 'anulada') throw err(400, 'La nota está anulada.');
  const fact = await db.collection('ventas').findOne(Object.assign({ _id: facturaId }, filtroOrg(req)));
  if (!fact) throw err(404, 'El comprobante a cancelar no existe.');
  if (fact.estado === 'anulada') throw err(400, 'El comprobante está anulado.');
  if (fact.tipoComprobante === 'nota_credito') throw err(400, 'No se puede aplicar una nota de crédito a otra nota de crédito.');
  if (String(fact.clienteId) !== String(nota.clienteId)) throw err(400, 'La nota y el comprobante son de clientes distintos.');
  if ((fact.moneda || 'ARS') !== (nota.moneda || 'ARS')) throw err(400, 'La nota y el comprobante están en monedas distintas.');
  if (nota.aplicadaA && nota.aplicadaA.ventaId) throw err(400, 'Esta nota ya está aplicada a un comprobante. Desasociala primero.');
  const disponibleNota = r2n(nota.total - (nota.totalAplicado || 0));
  const saldoFact = r2n(fact.saldoPendiente != null ? fact.saldoPendiente : fact.total);
  if (!(saldoFact > 0)) throw err(400, 'Ese comprobante no tiene saldo pendiente.');
  let monto = montoPedido === undefined || montoPedido === null || montoPedido === '' ? Math.min(disponibleNota, saldoFact) : r2n(montoPedido);
  if (!(monto > 0)) throw err(400, 'No hay monto para aplicar.');
  if (monto > disponibleNota + 0.009) throw err(400, `El monto supera lo disponible de la nota (${disponibleNota}).`);
  if (monto > saldoFact + 0.009) throw err(400, `El monto supera el saldo del comprobante (${saldoFact}).`);
  const ahora = new Date();
  const nuevoSaldo = Math.max(0, r2n(saldoFact - monto));
  const totalAcreditado = r2n((fact.totalAcreditado || 0) + monto);
  const upd = await db.collection('ventas').updateOne(
    { _id: fact._id, saldoPendiente: fact.saldoPendiente },
    { $set: { saldoPendiente: nuevoSaldo, totalAcreditado, canceladaPorNota: nuevoSaldo <= 0.005, updatedAt: ahora },
      $push: { notasAplicadas: { notaId: nota._id, numero: nota.numero, letra: nota.letra || 'X', monto, fecha: ahora } } }
  );
  if (!upd.modifiedCount) throw err(409, 'El comprobante cambió mientras se aplicaba la nota. Probá de nuevo.');
  await db.collection('ventas').updateOne({ _id: nota._id }, {
    $set: { aplicadaA: { ventaId: fact._id, numero: fact.numero, letra: fact.letra || 'X', tipoComprobante: fact.tipoComprobante, monto, fecha: ahora }, totalAplicado: r2n((nota.totalAplicado || 0) + monto), updatedAt: ahora },
    $unset: { desasociadaEn: '' }
  });
  if (nota.reingresaStock === false) await ajustarCompromisoPorNota(db, nota, fact, true);
  return { monto, saldoFactura: nuevoSaldo, cancelada: nuevoSaldo <= 0.005 };
}
// Una nota de crédito que NO reingresa mercadería (la factura no salió) cancela también lo que la factura tenía comprometido sin entregar
// (15/10/2026, pedido de Mato). liberar=true: libera el compromiso por las cantidades de la nota; liberar=false: lo restituye.
function estadoSegunItems(items) {
  const total = items.reduce((s, it) => s + (it.cantidad || 0), 0);
  const ent = items.reduce((s, it) => s + (it.cantidadEntregada || 0), 0);
  const cerrado = ent + items.reduce((s, it) => s + (it.cantidadAcreditada || 0), 0);
  return cerrado <= 0 ? 'pendiente' : (cerrado >= total - 1e-9 ? 'entregada' : (ent > 0 || cerrado > 0 ? 'parcialmente_entregada' : 'pendiente'));
}
async function ajustarCompromisoPorNota(db, nota, fact, liberar) {
  if (!fact || !fact.stockComprometido) return;
  const ahora = new Date();
  const incStock = (productoId, depositoId, delta) => db.collection('stock_actual').updateOne(
    { productoId, depositoId: depositoId || null, orgId: fact.orgId }, { $inc: { cantidadComprometida: delta } });
  const items = (fact.items || []).map(i => Object.assign({}, i));
  if (liberar) {
    if (fact.estado !== 'pendiente' && fact.estado !== 'parcialmente_entregada') return;
    if ((fact.acreditadoPorNota || []).some(e => String(e.notaId) === String(nota._id))) return;
    const reducciones = [];
    for (const ni of nota.items || []) {
      if (!ni.productoId) continue;
      let resto = ni.cantidad || 0;
      items.forEach((fi, idx) => {
        if (resto <= 0 || !fi.productoId || String(fi.productoId) !== String(ni.productoId)) return;
        const r = Math.min(cantidadPendiente(fi), resto);
        if (r <= 0) return;
        fi.cantidadAcreditada = (fi.cantidadAcreditada || 0) + r; resto -= r;
        reducciones.push({ index: idx, productoId: fi.productoId, cantidad: r });
      });
    }
    if (!reducciones.length) return;
    for (const r of reducciones) await incStock(r.productoId, fact.depositoId, -r.cantidad);
    await db.collection('ventas').updateOne({ _id: fact._id }, {
      $set: { items, estado: estadoSegunItems(items), updatedAt: ahora },
      $push: { acreditadoPorNota: { notaId: nota._id, reducciones, fecha: ahora } }
    });
  } else {
    const entrada = (fact.acreditadoPorNota || []).find(e => String(e.notaId) === String(nota._id));
    if (!entrada) return;
    for (const r of entrada.reducciones || []) {
      if (items[r.index]) items[r.index].cantidadAcreditada = Math.max(0, (items[r.index].cantidadAcreditada || 0) - r.cantidad);
      await incStock(r.productoId, fact.depositoId, r.cantidad);
    }
    const set = { items, updatedAt: ahora };
    if (fact.estado !== 'anulada') set.estado = estadoSegunItems(items);
    await db.collection('ventas').updateOne({ _id: fact._id }, { $set: set, $pull: { acreditadoPorNota: { notaId: nota._id } } });
  }
}
// Deshace la aplicación de una nota (al anularla o al desasociarla): la factura recupera el saldo.
async function desaplicarNota(db, nota) {
  const ap = nota.aplicadaA;
  if (!ap || !ap.ventaId) return null;
  const fact = await db.collection('ventas').findOne({ _id: ap.ventaId });
  const ahora = new Date();
  if (fact) await ajustarCompromisoPorNota(db, nota, fact, false);
  if (fact) {
    const total = fact.total || 0;
    const totalAcreditado = Math.max(0, r2n((fact.totalAcreditado || 0) - ap.monto));
    const saldo = Math.max(0, r2n(total - (fact.totalCobrado || 0) - totalAcreditado));
    await db.collection('ventas').updateOne({ _id: fact._id }, {
      $set: { totalAcreditado, saldoPendiente: fact.estado === 'anulada' ? 0 : saldo, canceladaPorNota: totalAcreditado > 0 && saldo <= 0.005, updatedAt: ahora },
      $pull: { notasAplicadas: { notaId: nota._id } }
    });
  }
  await db.collection('ventas').updateOne({ _id: nota._id }, { $unset: { aplicadaA: '' }, $set: { totalAplicado: 0, desasociadaEn: ahora, updatedAt: ahora } });
  return ap;
}

// Notas de crédito del cliente que todavía tienen importe sin aplicar (para asociarlas a una factura).
router.get('/notas-sin-aplicar', authAdmin, async (req, res) => {
  try {
    const cid = toObjectId(req.query.clienteId);
    if (!cid) throw err(400, 'clienteId inválido');
    const db = await getDb();
    const lista = await db.collection('ventas').find(Object.assign({ clienteId: cid, tipoComprobante: 'nota_credito', estado: { $ne: 'anulada' } }, filtroOrg(req))).sort({ fecha: -1 }).limit(100).toArray();
    res.json(lista.map(n => ({ _id: n._id, numero: n.numero, letra: n.letra || 'X', fecha: n.fecha, total: n.total, moneda: n.moneda || 'ARS', disponible: r2n(n.total - (n.totalAplicado || 0)) })).filter(n => n.disponible > 0.005));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Comprobantes del cliente con saldo pendiente (para asociarles una nota de crédito).
router.get('/con-saldo', authAdmin, async (req, res) => {
  try {
    const cid = toObjectId(req.query.clienteId);
    if (!cid) throw err(400, 'clienteId inválido');
    const db = await getDb();
    const lista = await db.collection('ventas').find(Object.assign({ clienteId: cid, tipoComprobante: { $in: ['fiscal', 'comprobante_x', 'nota_debito'] }, estado: { $ne: 'anulada' }, saldoPendiente: { $gt: 0.005 } }, filtroOrg(req))).sort({ fecha: -1 }).limit(100).toArray();
    res.json(lista.map(v => ({ _id: v._id, numero: v.numero, letra: v.letra || 'X', tipoComprobante: v.tipoComprobante, fecha: v.fecha, total: v.total, saldoPendiente: v.saldoPendiente, moneda: v.moneda || 'ARS' })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Asocia una nota de crédito existente a una factura. body: { facturaId, monto? }
router.post('/:id/asociar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    const facturaId = toObjectId(req.body && req.body.facturaId);
    if (!id || !facturaId) throw err(400, 'Faltan datos.');
    const r = await conReintento(async () => {
      const db = await getDb();
      const nota = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!nota) throw err(404, 'Nota no encontrada');
      return aplicarNotaAFactura(db, req, nota, facturaId, req.body.monto);
    });
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/:id/desasociar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const nota = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!nota) throw err(404, 'Nota no encontrada');
      if (!nota.aplicadaA) throw err(400, 'La nota no está asociada a ningún comprobante.');
      await desaplicarNota(db, nota);
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/proximo-numero', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) return res.json({ numero: null });
    const tipo = normalizarTexto(req.query.tipo).toLowerCase() || 'comprobante_x';
    if (!TIPOS_COMPROBANTE_VALIDOS.includes(tipo)) throw err(400, 'Tipo de comprobante inválido');
    let letra = normalizarTexto(req.query.letra).toUpperCase();
    if (tipo === 'comprobante_x') letra = 'X';
    else if (!['A', 'B', 'X'].includes(letra)) letra = 'B';
    const clave = tipo === 'comprobante_x' ? 'comprobante_x' : `${tipo}_${letra}`;
    const db = await getDb();
    let doc = await db.collection('ventas_contadores').findOne({ orgId: req.orgId, tipoComprobante: clave });
    let ultimo = doc ? doc.ultimo : 0;
    if (!doc && clave === 'comprobante_x') {
      const legacy = await db.collection('ventas_contadores').findOne({ orgId: req.orgId, tipoComprobante: { $exists: false } });
      if (legacy) ultimo = legacy.ultimo;
    }
    let puntoVenta = null;
    try {
      const cfg = await emisionFiscal.getConfig(db, req.orgId);
      puntoVenta = cfg && cfg.puntoVenta ? cfg.puntoVenta : null;
    } catch (e) { /* sin config fiscal */ }
    res.json({ numero: ultimo + 1, letra, tipo, puntoVenta });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Convierte una venta cargada como NO fiscal (Comprobante X) en una factura
// fiscal (A/B según el cliente). Queda con número nuevo de la serie fiscal
// (el X anterior se guarda en numeroXAnterior) y pendiente de autorizar en ARCA.
router.post('/:id/convertir-fiscal', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.estado === 'anulada') throw err(400, 'La venta está anulada.');
      if (venta.importado) throw err(400, 'Es una venta histórica importada: no se puede convertir.');
      if (venta.tipoComprobante !== 'comprobante_x' || venta.esFiscal) throw err(400, 'Solo se puede convertir un Comprobante X (no fiscal).');
      const orgVenta = venta.orgId;
      const reqOrg = Object.assign({}, req, { orgId: orgVenta });
      const cliente = await db.collection('clientes').findOne({ _id: venta.clienteId });
      if (!cliente) throw err(400, 'El cliente de la venta ya no existe.');
      const letra = letraFiscalParaCliente(cliente);
      const cfgFiscal = await emisionFiscal.getConfig(db, orgVenta);
      const incluyeIva = await emisionFiscal.preciosIncluyenIvaDe(db, cfgFiscal, venta.listaPrecioId || null);
      let fiscal;
      try {
        fiscal = emisionFiscal.calcularFiscalVenta({ items: venta.items, descuentoPorcentaje: venta.descuentoPorcentaje || 0, descuentoMonto: venta.descuentoMonto || 0, preciosIncluyenIva: incluyeIva, letra, ivaDefecto: cfgFiscal.ivaDefecto });
      } catch (eF) { throw err(400, eF.message); }
      const totalNuevo = fiscal.total;
      const diferencia = Math.round((totalNuevo - venta.total) * 100) / 100;
      const numero = await proximoNumero(db, orgVenta, `fiscal_${letra}`);
      const ahora = new Date();
      const nuevoSaldo = Math.max(0, Math.round((totalNuevo - (venta.totalCobrado || 0) - (venta.totalAcreditado || 0)) * 100) / 100);
      const upd = await db.collection('ventas').updateOne(
        { _id: id, tipoComprobante: 'comprobante_x', estado: { $ne: 'anulada' } },
        { $set: {
          tipoComprobante: 'fiscal', letra, esFiscal: true, fiscal, numero,
          numeroXAnterior: venta.numero, total: totalNuevo, saldoPendiente: nuevoSaldo,
          fiscalEstado: 'pendiente', fiscalMensaje: null, convertidaAFiscalEn: ahora, updatedAt: ahora
        } }
      );
      if (!upd.modifiedCount) throw err(409, 'La venta cambió mientras se convertía. Probá de nuevo.');
      if (Math.abs(diferencia) >= 0.01) {
        await registrarMovimientoCuentaCorriente(db, reqOrg, {
          clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: diferencia > 0 ? 'debito' : 'credito', monto: Math.abs(diferencia), moneda: venta.moneda || 'ARS',
          concepto: `Conversión a factura fiscal (venta X Nº ${venta.numero} → ${letra} Nº ${numero}): ajuste de IVA`, origen: 'venta', ventaId: id
        });
      }
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(await autorizarAlGuardar(Object.assign({}, req, { orgId: resultado.orgId }), resultado));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/resumen', authAdmin, async (req, res) => {
  try {
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
    const [y, m] = hoy.split('-');
    const desdeDia = new Date(hoy + 'T00:00:00-03:00');
    const desdeMes = new Date(`${y}-${m}-01T00:00:00-03:00`);
    const ventas = await conReintento(async () => {
      const db = await getDb();
      return db.collection('ventas')
        .find(Object.assign({ estado: { $ne: 'anulada' }, fecha: { $gte: desdeMes } }, filtroOrg(req)))
        .project({ fecha: 1, total: 1, moneda: 1, tipoComprobante: 1 }).toArray();
    });
    const vacio = () => ({ cantidad: 0, monto: {} });
    const out = { dia: vacio(), mes: vacio(), hoy };
    for (const v of ventas) {
      const mon = v.moneda || 'ARS';
      const signo = v.tipoComprobante === 'nota_credito' ? -1 : 1;
      const esNota = v.tipoComprobante === 'nota_credito' || v.tipoComprobante === 'nota_debito';
      const buckets = [out.mes];
      if (new Date(v.fecha) >= desdeDia) buckets.push(out.dia);
      for (const b of buckets) {
        b.monto[mon] = (b.monto[mon] || 0) + signo * (Number(v.total) || 0);
        if (!esNota) b.cantidad += 1;
      }
    }
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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

// Listado de remitos emitidos (3/10/2026, pedido de Mato: "tenemos que
// tener en el menu comercial un submenu para ver los remitos emitidos")
// — mismo patrón de filtros que GET / de ventas (cliente, rango de
// fecha), pero sobre la colección `remitos` en vez de `ventas`.
router.get('/remitos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.clienteId) {
      const cid = toObjectId(req.query.clienteId);
      if (!cid) throw err(400, 'clienteId inválido');
      match.clienteId = cid;
    }
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const limite = Math.min(Number(req.query.limite) || 200, 500);
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('remitos').find(match).sort({ fecha: -1, numero: -1 }).limit(limite).toArray();
    });
    res.json(lista);
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
    // `letra` es lo nuevo (3/10/2026: X/A/B reales); si el comprobante es
    // de antes de ese cambio y no la tiene guardada, se cae al F/X/NC/ND
    // de siempre.
    const prefijo = venta.letra || prefijoComprobante(venta.tipoComprobante);
    // Dux numera "punto de venta - correlativo" (ej. 00007-00000718); acá
    // no hay punto de venta propio (sin AFIP, ver "Decisiones de alcance
    // v1" más arriba), así que se imprime solo el correlativo interno,
    // con el mismo relleno de ceros a la izquierda.
    const numeroDigitos = venta.cae
      ? `${String(venta.puntoVenta).padStart(4, '0')}-${String(venta.numeroFiscal).padStart(8, '0')}`
      : String(venta.numero).padStart(5, '0');
    // Factura electrónica (5/10/2026): si la venta tiene bloque fiscal, el
    // detalle muestra neto, alícuota y total con IVA de cada línea.
    const fiscalV = (venta.fiscal && venta.fiscal.discriminaIva && Array.isArray(venta.fiscal.items) && venta.fiscal.items.length === (venta.items || []).length) ? venta.fiscal : null;
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
    const filas = (venta.items || []).map((it, idx) => {
      const prod = it.productoId ? productosPorId[String(it.productoId)] : null;
      const fl = fiscalV ? fiscalV.items[idx] : null;
      const unidad = (prod && prod.unidad) ? prod.unidad : '';
      const cantidadHtml = `${numImp(it.cantidad)}${unidad ? ' ' + escHtml(unidad) : ''}`;
      const bultosHtml = (prod && prod.unidadesPorBulto > 0) ? numImp(it.cantidad / prod.unidadesPorBulto) : '—';
      return `
        <tr>
          <td>${escHtml(it.sku || '—')} - ${escHtml(it.nombre)}</td>
          <td class="num">${cantidadHtml}</td>
          <td class="num">${bultosHtml}</td>
          <td class="num">${moneyImp(fl ? (it.cantidad ? fl.neto / it.cantidad : 0) : it.precioUnitario, venta.moneda)}${(!fl && it.descuentoPorcentaje) ? `<br><small>(-${numImp(it.descuentoPorcentaje)}%)</small>` : ''}</td>
          <td class="num">${moneyImp(fl ? fl.neto : it.subtotal, venta.moneda)}</td>
          <td class="num">${fl ? String(fl.porcentajeIva).replace('.', ',') + '%' : '0%'}</td>
          <td class="num">${moneyImp(fl ? fl.total : it.subtotal, venta.moneda)}</td>
        </tr>
      `;
    }).join('');
    const esNota = venta.tipoComprobante === 'nota_credito' || venta.tipoComprobante === 'nota_debito';
    // Con CAE, el receptor impreso es el que se mandó a ARCA, no el dato vivo
    // del cliente (que pudo editarse después).
    const catFiscalImpresa = (venta.cae && venta.fiscalCondIvaReceptor)
      ? (Object.keys(arcaLib.COND_IVA_RECEPTOR).find(k => arcaLib.COND_IVA_RECEPTOR[k] === venta.fiscalCondIvaReceptor) || (cliente && cliente.categoriaFiscal))
      : (cliente && cliente.categoriaFiscal);
    const ivaClienteLabel = (catFiscalImpresa && CATEGORIA_FISCAL_LABEL[catFiscalImpresa]) || '';
    const cuitImpreso = (venta.cae && venta.fiscalDocNro && venta.fiscalDocNro !== '0') ? String(venta.fiscalDocNro) : (cliente ? cliente.cuit : '');
    const detalleVenta = [];
    if (venta.vendedor) detalleVenta.push(`Vendedor: ${escHtml(venta.vendedor)}`);
    if (venta.moneda && venta.moneda !== 'ARS') detalleVenta.push(`Moneda: ${escHtml(venta.moneda)}`);
    if (!esNota) detalleVenta.push(venta.tipoEntrega === 'inmediata' ? 'Entrega inmediata' : 'Entrega pendiente');
    if (venta.comprobanteOrigenNumero) {
      const prefijoOrigen = venta.comprobanteOrigenLetra || prefijoComprobante(venta.comprobanteOrigenTipo);
      detalleVenta.push(`Referente a comprobante ${prefijoOrigen}-${String(venta.comprobanteOrigenNumero).padStart(5, '0')}`);
    }
    const headerHtml = encabezadoComprobante(org, {
      letra: prefijo,
      numeroFmt: numeroDigitos,
      fecha: (venta.cae && /^\d{8}$/.test(String(venta.fiscalFecha || ''))) ? `${String(venta.fiscalFecha).slice(6, 8)}/${String(venta.fiscalFecha).slice(4, 6)}/${String(venta.fiscalFecha).slice(0, 4)}` : fechaCorta(venta.fecha),
      tituloGrande: TITULO_COMPROBANTE[venta.tipoComprobante] || 'COMPROBANTE',
      codigo: venta.cae ? String(venta.cbteTipo).padStart(3, '0') : null
    });
    // Aviso y pie fiscal (5/10/2026): CAE + QR si está autorizada; carteles
    // claros si está pendiente de autorizar o si se autorizó en el entorno de
    // PRUEBA de ARCA (esa factura no tiene validez fiscal).
    let avisoFiscalHtml = '';
    let pieFiscalHtml = '';
    if (venta.esFiscal && !venta.cae) {
      avisoFiscalHtml = '<div class="cmp-homologacion">COMPROBANTE PENDIENTE DE AUTORIZACIÓN EN ARCA — TODAVÍA SIN VALOR FISCAL</div>';
    }
    if (venta.cae) {
      if (venta.fiscalEntorno !== 'produccion') avisoFiscalHtml = '<div class="cmp-homologacion">AUTORIZADO EN EL ENTORNO DE PRUEBA DE ARCA (HOMOLOGACIÓN) — NO TIENE VALIDEZ FISCAL</div>';
      const urlQr = arcaLib.urlQr({ fecha: venta.fiscalFecha, cuit: org && org.cuit, ptoVta: venta.puntoVenta, cbteTipo: venta.cbteTipo, cbteNro: venta.numeroFiscal,
        importe: venta.total, moneda: venta.fiscalMoneda || 'PES', cotiz: venta.fiscalCotiz || 1, docTipo: venta.fiscalDocTipo, docNro: venta.fiscalDocNro, cae: venta.cae });
      const qrImg = await QRCode.toDataURL(urlQr, { margin: 0, width: 220 });
      const vto = venta.caeVto ? fechaCorta(venta.caeVto) : '';
      pieFiscalHtml = `
        <div class="cmp-fiscal-pie">
          <img src="${qrImg}" alt="QR de ARCA">
          <div class="cmp-cae">
            <div><strong>CAE Nº:</strong> ${escHtml(venta.cae)}</div>
            <div><strong>Fecha de vencimiento del CAE:</strong> ${escHtml(vto)}</div>
            <div class="muted" style="font-size:11px">Comprobante autorizado por ARCA.</div>
          </div>
        </div>`;
    }
    const bodyHtml = `
      ${avisoFiscalHtml}
      ${recuadroClienteComprobante({
        nombre: await nombreClienteImpreso(venta.clienteId, venta.clienteNombre),
        iva: ivaClienteLabel,
        cuit: cuitImpreso,
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
        ${fiscalV ? `
        <tr><td>Subtotal neto</td><td class="num">${moneyImp(fiscalV.neto, venta.moneda)}</td></tr>
        ${(fiscalV.grupos || []).map(g => `<tr><td>IVA ${String(g.porcentaje).replace('.', ',')}%</td><td class="num">${moneyImp(g.importe, venta.moneda)}</td></tr>`).join('')}
        ` : `
        <tr><td>Subtotal</td><td class="num">${moneyImp(venta.subtotal, venta.moneda)}</td></tr>
        ${venta.descuentoMonto ? `<tr><td>Descuento</td><td class="num">-${moneyImp(venta.descuentoMonto, venta.moneda)}</td></tr>` : ''}
        <tr><td>Monto IVA</td><td class="num">${moneyImp(0, venta.moneda)}</td></tr>`}
        <tr class="total-final"><td>Total</td><td class="num">${moneyImp(venta.total, venta.moneda)}</td></tr>
        ${venta.tipoComprobante === 'nota_credito' ? '' : `<tr><td>Cobrado</td><td class="num">${moneyImp(venta.totalCobrado, venta.moneda)}</td></tr>`}
        ${venta.saldoPendiente > 0 ? `<tr><td>Saldo pendiente</td><td class="num">${moneyImp(venta.saldoPendiente, venta.moneda)}</td></tr>` : ''}
      </table>
      ${org && org.condicionVenta ? `<div class="cmp-condicion-venta"><strong>Condición de venta:</strong><br>${escHtml(org.condicionVenta)}</div>` : ''}
      ${pieFiscalHtml}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({
      titulo: `Comprobante Nº ${prefijo}-${numeroDigitos}`,
      org: datosNegocioParaImprimir(org),
      headerHtml,
      bodyHtml,
      telefono: cliente ? (cliente.celular || cliente.telefono || '') : ''
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
          <strong>Cliente:</strong> ${escHtml(await nombreClienteImpreso(remito.clienteId, remito.clienteNombre))}<br>
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
      ${remito.observaciones ? `<p style="margin-top:14px"><strong>Observaciones:</strong> ${escHtml(remito.observaciones).replace(/\n/g, '<br>')}</p>` : ''}
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
    // Varios medios cobrados juntos: un solo recibo con todos.
    const grupo = pago.reciboGrupo ? (venta.pagos || []).filter(p => p.reciboGrupo === pago.reciboGrupo && !p.anulado) : [pago];
    const totalMedios = grupo.reduce((a, p) => a + p.monto, 0);
    const totalRet = grupo.reduce((a, p) => a + (p.totalRetenciones || 0), 0);
    const recargoTotal = grupo.reduce((a, p) => a + (p.tarjetaRecargo || 0), 0);
    const retsTodas = grupo.reduce((a, p) => a.concat(p.retenciones || []), []);
    const detalleMedio = p => (TIPO_VALOR_LABEL[p.tipoValor] || escHtml(p.tipoValor))
      + (p.tipoValor === 'tarjeta' ? ` (Lote ${escHtml(p.tarjetaLote || '—')} / Cupón ${escHtml(p.tarjetaCupon || '—')})` : '');
    const bodyHtml = `
      <h1>Recibo — ${TITULO_DOC_RECIBO(venta)} Nº ${String(venta.numero).padStart(5, '0')}</h1>
      <div class="datos-doc">
        <div>
          <strong>Recibí de:</strong> ${escHtml(await nombreClienteImpreso(venta.clienteId, venta.clienteNombre))}<br>
          <strong>La suma de:</strong> ${moneyImp(totalMedios, venta.moneda)}${retsTodas.length ? `<br><strong>Retenciones practicadas:</strong> ${retsTodas.map(r => escHtml(r.tipoNombre) + ' ' + moneyImp(r.monto, venta.moneda)).join(' — ')}<br><strong>Total aplicado a la venta:</strong> ${moneyImp(totalMedios + totalRet, venta.moneda)}` : ''}${recargoTotal > 0 ? `<br><strong>Recargo por financiación (tarjeta):</strong> ${moneyImp(recargoTotal, venta.moneda)}<br><strong>Total cobrado con tarjeta:</strong> ${moneyImp(grupo.reduce((a, p) => a + (p.tarjetaTotalCobrado || 0), 0), venta.moneda)}` : ''}
        </div>
        <div>
          <strong>Fecha:</strong> ${fechaLarga(pago.fecha)}<br>
          ${grupo.length > 1 ? '<strong>Forma de pago:</strong> Varios medios' : `<strong>Forma de pago:</strong> ${detalleMedio(pago)}`}
        </div>
      </div>
      ${grupo.length > 1 ? `<table style="width:100%;border-collapse:collapse;margin:10px 0"><thead><tr><th style="text-align:left;border-bottom:1px solid #999">Medio</th><th style="text-align:right;border-bottom:1px solid #999">Importe</th></tr></thead><tbody>${grupo.map(p => `<tr><td>${detalleMedio(p)}</td><td style="text-align:right">${moneyImp(p.monto, venta.moneda)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p>En concepto de pago de ${TITULO_DOC_RECIBO(venta, true)} Nº ${String(venta.numero).padStart(5, '0')}.${pago.nota ? ` ${escHtml(pago.nota)}` : ''}</p>
      <p class="muted" style="margin-top:40px">Firma y aclaración: ________________________________</p>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({ titulo: `Recibo — ${TITULO_DOC_RECIBO(venta)} Nº ${venta.numero}`, org: datosNegocioParaImprimir(org), bodyHtml }));
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
    // Nota de Crédito/Débito (3/10/2026): no pasan por el circuito de
    // entrega/remito de una venta normal — tipoEntrega llega igual desde
    // el front (tiene que mandar algo válido) pero se ignora para estos
    // dos tipos. La Nota de Crédito SÍ necesita depósito (reingresa stock
    // de verdad ahí mismo); la de Débito nunca lo necesita, no mueve
    // stock para nada.
    const esNotaCredito = tipoComprobante === 'nota_credito';
    const esNotaDebito = tipoComprobante === 'nota_debito';
    // Si una Nota de Crédito/Débito es fiscal (3/10/2026, pedido de Mato)
    // se decide con este casillero aparte — a Factura/Comprobante X no
    // les hace falta, ya lo dice el tipo de comprobante elegido.
    const esFiscalNota = !!body.esFiscal;
    if (esNotaDebito) { /* depositoId no aplica */ }
    // (15/10/2026, pedido de Mato) la nota de crédito reingresa la mercadería
    // solo si se elige: si la factura nunca salió no hay nada que devolver.
    // Sin el dato (clientes viejos) se mantiene el comportamiento anterior.
    const reingresaStock = esNotaCredito ? (body.reingresaStock === undefined ? true : !!body.reingresaStock) : false;
    if (esNotaCredito && reingresaStock && !depositoId) throw err(400, 'Elegí a qué depósito reingresa la mercadería de esta nota de crédito.');
    else if (tipoEntrega === 'inmediata' && !depositoId) throw err(400, 'Elegí a qué depósito le vas a entregar la venta.');
    const vendedor = normalizarTexto(body.vendedor) || (req.usuario && req.usuario.nombre) || '';
    const descuentoPorcentaje = body.descuentoPorcentaje ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : 0;
    const descuentoMonto = body.descuentoMonto ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : 0;
    const observaciones = normalizarTexto(body.observaciones);
    // "2026-10-05" (solo día) se toma como mediodía de Argentina: con new Date()
    // directo sería medianoche UTC = el día anterior a las 21 h, y la factura
    // saldría con la fecha corrida.
    const fecha = body.fecha ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(body.fecha)) ? `${body.fecha}T12:00:00-03:00` : body.fecha) : new Date();
    // Comprobante de origen (botón "Generar Nota de Crédito" desde una
    // venta ya cargada, precarga estos datos) — opcional, solo
    // informativo/para imprimir la referencia en el PDF.
    const comprobanteOrigenId = body.comprobanteOrigenId ? toObjectId(body.comprobanteOrigenId) : null;
    const comprobanteOrigenNumero = (comprobanteOrigenId && body.comprobanteOrigenNumero) ? Number(body.comprobanteOrigenNumero) || null : null;
    const comprobanteOrigenTipo = (comprobanteOrigenId && body.comprobanteOrigenTipo) ? normalizarTexto(body.comprobanteOrigenTipo) : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cliente = await cargarClienteParaOperar(db, req, clienteId);
      if (!cliente) throw err(400, 'El cliente no existe (o no pertenece a esta organización)');
      let comprobanteOrigenLetra = null;
      if (comprobanteOrigenId) {
        const origen = await db.collection('ventas').findOne(Object.assign({ _id: comprobanteOrigenId }, filtroOrg(req)));
        if (!origen) throw err(400, 'El comprobante de origen no existe (o no pertenece a esta organización).');
        comprobanteOrigenLetra = origen.letra || null;
      }
      // Letra real del comprobante (3/10/2026): X para lo no fiscal, A/B
      // (según la condición fiscal del cliente) para lo fiscal. Factura
      // ya era "fiscal" de por sí; Comprobante X ya era "no fiscal"; para
      // Nota de Crédito/Débito ahora lo decide el casillero "Es fiscal".
      const letra = tipoComprobante === 'comprobante_x'
        ? 'X'
        : tipoComprobante === 'fiscal'
          ? letraFiscalParaCliente(cliente)
          : (esFiscalNota ? ((comprobanteOrigenLetra === 'A' || comprobanteOrigenLetra === 'B') ? comprobanteOrigenLetra : letraFiscalParaCliente(cliente)) : 'X');
      const esFiscal = letra !== 'X';
      if (depositoId) {
        const deposito = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
        if (!deposito) throw err(404, 'Depósito no encontrado');
      }
      // Sin depósito elegido, la venta (no las notas) reserva contra Junín.
      const depositoCompromiso = (depositoId || esNotaCredito || esNotaDebito) ? depositoId : await depositoJuninDe(db, req.orgId);
      const { items, subtotal } = await normalizarItems(db, req, body.items);
      // La venta se carga SIEMPRE, haya o no stock (2/10/2026, pedido de
      // Mato) — puede quedar pendiente de retiro mientras entra
      // mercadería o se fabrica. No hay validación de stock acá; el
      // chequeo real es al generar el remito (ver generarRemitoDeVenta).
      let total = calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto);
      // Bloque fiscal (5/10/2026): para un comprobante fiscal se discrimina el
      // IVA según la alícuota de cada producto. Si los precios de la lista
      // son NETOS, el IVA se suma y el total de la venta pasa a ser el de la
      // factura (si ya incluyen IVA, el total no cambia).
      let fiscal = null;
      if (esFiscal) {
        const cfgFiscal = await emisionFiscal.getConfig(db, req.orgId);
        const incluyeIva = await emisionFiscal.preciosIncluyenIvaDe(db, cfgFiscal, body.listaPrecioId ? toObjectId(body.listaPrecioId) : null);
        try {
          fiscal = emisionFiscal.calcularFiscalVenta({ items, descuentoPorcentaje, descuentoMonto, preciosIncluyenIva: incluyeIva, letra, ivaDefecto: cfgFiscal.ivaDefecto });
        } catch (eFiscal) { throw err(400, eFiscal.message); }
        total = fiscal.total;
      }
      // Comprobante X sigue contando con la clave de siempre (no romper
      // la numeración histórica); Factura y Nota de Crédito/Débito ahora
      // cuentan por separado para cada letra (A, B o X), como realmente
      // funciona la numeración de AFIP (3/10/2026, pedido de Mato:
      // "Separado por letra").
      const claveContador = tipoComprobante === 'comprobante_x' ? 'comprobante_x' : `${tipoComprobante}_${letra}`;
      const numero = await proximoNumero(db, req.orgId, claveContador);
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();

      // listaPrecioId es solo informativo (30/9/2026): qué lista de precio
      // de Productos se usó para sugerir los precios al cargar la venta.
      // No afecta nada del cálculo — cada ítem ya trae su precioUnitario
      // resuelto por el frontend, editable como siempre.
      const listaPrecioId = body.listaPrecioId ? toObjectId(body.listaPrecioId) : null;

      // Nota de Crédito/Débito: se resuelven en el momento, sin pasar por
      // "pendiente" ni remito — items.forEach abajo las marca como
      // cantidadEntregada = cantidad (nada queda pendiente de entregar).
      const itemsFinales = (esNotaCredito || esNotaDebito)
        ? items.map(it => Object.assign({}, it, { cantidadEntregada: it.cantidad }))
        : items;

      const venta = {
        numero,
        tipoComprobante,
        letra, esFiscal,
        clienteId,
        clienteNombre: nombreCompletoCliente(cliente) || cliente.apellidoRazonSocial || cliente.nombre || '',
        vendedor,
        usuarioId: (req.usuario && req.usuario._id) || null,
        fecha,
        moneda,
        listaPrecioId,
        cotizacionDolar: body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null,
        tipoEntrega: (esNotaCredito || esNotaDebito) ? null : tipoEntrega,
        depositoId: esNotaDebito ? null : depositoCompromiso,
        comprobanteOrigenId, comprobanteOrigenNumero, comprobanteOrigenTipo, comprobanteOrigenLetra,
        // stockComprometido (3/10/2026): true desde ahora, siempre, para
        // una venta normal — se compromete al cargar la venta tenga o no
        // depósito elegido (ver más abajo). Distingue de una venta vieja
        // (de antes de este cambio) sin depósito, que en cambio nunca
        // comprometió nada — POST /:id/entregar lo necesita para decidir
        // si hay que comprometer recién ahora o solo migrar lo ya
        // comprometido. Una Nota de Crédito/Débito nunca compromete nada
        // (la de crédito mueve stock real directo, sin pasar por
        // "comprometido"; la de débito no toca stock para nada).
        stockComprometido: !esNotaCredito && !esNotaDebito,
        estado: (esNotaCredito || esNotaDebito) ? 'entregada' : 'pendiente',
        items: itemsFinales,
        descuentoPorcentaje,
        descuentoMonto,
        subtotal,
        total,
        fiscal,
        fiscalEstado: esFiscal ? 'pendiente' : null,
        fiscalMensaje: null,
        pagos: [],
        totalCobrado: 0,
        // Una Nota de Crédito no se "cobra" — ya quedó resuelta al
        // registrar el movimiento de crédito en la cuenta corriente, así
        // que arranca sin saldo pendiente (y sin botón de Cobrar en el
        // front). Nota de Débito sí funciona como una venta para esto.
        saldoPendiente: esNotaCredito ? 0 : total,
        observaciones,
        reingresaStock: esNotaCredito ? reingresaStock : undefined,
        stockDescontado: esNotaCredito && reingresaStock, // reingreso directo ya aplicado (ver más abajo)
        stockDescontadoEn: (esNotaCredito && reingresaStock) ? ahora : null,
        remitoId: null,
        remitoNumero: null,
        remitosIds: [],
        entregadaEn: (esNotaCredito || esNotaDebito) ? ahora : null,
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

      // Cuenta corriente del cliente (2/10/2026, pedido de Mato; ramas de
      // Nota de Crédito/Débito agregadas 3/10/2026): una venta o una Nota
      // de Débito generan deuda por el total (débito); una Nota de
      // Crédito la cancela (crédito) — ninguna de las dos carga cobros en
      // el mismo paso, así que una venta/ND siempre arranca con
      // saldoPendiente = total.
      if (total > 0) {
        const conceptoCC = esNotaCredito ? `Nota de Crédito Nº ${numero}` : esNotaDebito ? `Nota de Débito Nº ${numero}` : `Venta Nº ${numero}`;
        await registrarMovimientoCuentaCorriente(db, req, {
          clienteId, clienteNombre: venta.clienteNombre, tipo: esNotaCredito ? 'credito' : 'debito', monto: total, moneda,
          concepto: conceptoCC, origen: 'venta', ventaId: venta._id, fecha
        });
      }

      if (esNotaDebito) {
        // No mueve stock para nada: no hay mercadería física de por
        // medio, solo un cargo en la cuenta corriente.
        return venta;
      }

      if (esNotaCredito) {
        // Reingresa stock DE VERDAD ahora mismo (no es un compromiso: es
        // la devolución física de la mercadería) al depósito elegido.
        for (const item of items) {
          if (!item.productoId || !reingresaStock) continue;
          await aplicarMovimientoStock(db, req, {
            productoId: item.productoId, depositoId, tipo: 'ingreso', cantidad: item.cantidad,
            motivo: 'Nota de crédito', observaciones: `Nota de crédito Nº ${numero}`.trim(),
            ventaId: venta._id, usuarioNombre, fecha
          });
        }
        // Si la nota viene de una factura (o se asoció a una), esa factura queda cancelada por el monto de la nota.
        if (comprobanteOrigenId) {
          try { await aplicarNotaAFactura(db, req, venta, comprobanteOrigenId); } catch (eAp) { venta.avisoAsociacion = eAp.message; }
        }
        return venta;
      }

      // El stock se COMPROMETE ya mismo siempre (3/10/2026, pedido de
      // Mato: "quiero que comprometas la mercaderia igual
      // independientemente si hay deposito o no") — antes, sin depósito
      // elegido (solo posible con "no entrega"), quedaba sin reservar
      // hasta entregar; ahora se reserva igual, en un "depósito" null
      // (sin asignar todavía) que Stock muestra aparte. Cuando se elija
      // un depósito real (al generar el remito), ese compromiso se
      // migra ahí — ver migrarCompromisoDeposito.
      await comprometerStockDeVenta(db, req, items, depositoCompromiso);

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
    const ventaFinal = await autorizarAlGuardar(req, resultado);
    res.json(ventaFinal);
    // Mail al cliente con el comprobante (una factura fiscal solo sale si ya tiene CAE; ver correo.js).
    try { const correo = require('./correo'); correo.enviarComprobante(ventaFinal._id, correo.baseUrlDe(req)); } catch (e) { /* el mail nunca frena la venta */ }
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Autorización automática en ARCA al guardar una venta fiscal (5/10/2026,
// pedido de Mato: "automático al guardar"). Si ARCA falla o no está
// configurado, la venta NO se pierde: queda 'pendiente' con el motivo en
// `avisoFiscal`, y se reintenta con el botón "Autorizar en ARCA".
async function autorizarAlGuardar(req, venta) {
  if (!venta || !venta.esFiscal) return venta;
  try {
    const db = await getDb();
    const cfg = await emisionFiscal.getConfig(db, req.orgId);
    if (cfg.emisionAutomatica === false) return venta;
    if (emisionFiscal.listoParaEmitir(cfg)) {
      // Sin configurar todavía: se guarda igual, avisando una sola línea.
      return Object.assign({}, venta, { avisoFiscal: 'Venta guardada. La factura quedó pendiente de autorizar: ' + emisionFiscal.listoParaEmitir(cfg) });
    }
    return await emisionFiscal.autorizarVenta(db, { orgId: req.orgId, ventaId: venta._id, usuarioNombre: (req.usuario && req.usuario.nombre) || '' });
  } catch (e) {
    try {
      const db = await getDb();
      const actual = await db.collection('ventas').findOne({ _id: venta._id });
      return Object.assign({}, actual || venta, { avisoFiscal: 'La venta se guardó, pero no se pudo autorizar en ARCA: ' + e.message + ' Podés reintentar con "Autorizar en ARCA".' });
    } catch (e2) { return Object.assign({}, venta, { avisoFiscal: 'La venta se guardó, pero no se pudo autorizar en ARCA: ' + e.message }); }
  }
}

// Editar una venta NO fiscal ya cargada (20/10/2026, pedido de Mato: "las ventas que no son fiscales las pueda editar una vez que ya
// están cargadas" — p. ej. se cargó a precio de contado y el cliente paga con tarjeta: se cambia la lista de precio y se recalculan los precios).
// Reglas: solo comprobante X no anulado. Fecha, vendedor y observaciones siempre. En una venta migrada de Dux, solo eso. En el resto además
// cliente y moneda (si no tiene cobros), lista de precio, descuentos y productos (no se puede quitar ni bajar de lo ya entregado ni cambiar el
// producto de una línea entregada). Ajusta solo: la reserva de stock de lo pendiente, y la cuenta corriente con un movimiento por la diferencia.
// El nuevo total no puede quedar por debajo de lo ya cobrado.
router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await buscarVentaOperable(db, req, id);
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.tipoComprobante !== 'comprobante_x' || venta.esFiscal) throw err(400, 'Solo se pueden editar las ventas no fiscales (comprobante X). Un comprobante fiscal se corrige con una nota de crédito.');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada: no se puede editar.');
      if (venta.cae || venta.canceladaPorNota) throw err(400, 'Esta venta no se puede editar (tiene CAE o está cancelada por una nota de crédito).');
      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const set = { updatedAt: ahora };
      const cambios = [];
      // --- cabecera: siempre editable ---
      if (body.fecha) {
        const dia = String(body.fecha).slice(0, 10); const actual = new Date(new Date(venta.fecha).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dia) && dia !== actual) { set.fecha = new Date(`${dia}T12:00:00-03:00`); cambios.push('fecha'); }
      }
      if (body.vendedor !== undefined && normalizarTexto(body.vendedor) !== (venta.vendedor || '')) { set.vendedor = normalizarTexto(body.vendedor); cambios.push('vendedor'); }
      if (body.observaciones !== undefined && normalizarTexto(body.observaciones) !== (venta.observaciones || '')) { set.observaciones = normalizarTexto(body.observaciones); cambios.push('observaciones'); }
      if (venta.importado) {
        if (body.items || body.clienteId || body.moneda || body.descuentoPorcentaje !== undefined || body.descuentoMonto !== undefined) throw err(400, 'Es una venta migrada de Dux: solo se puede cambiar la fecha, el vendedor y las observaciones.');
      } else {
        const originales = venta.items || [];
        const hayCobros = Number(venta.totalCobrado) > 0.005 || Math.abs(Number(venta.saldoPendiente) - Number(venta.total)) > 0.005;
        // cliente y moneda
        const nuevoClienteId = body.clienteId ? toObjectId(body.clienteId) : venta.clienteId;
        if (!nuevoClienteId) throw err(400, 'Cliente inválido');
        const clienteCambia = String(nuevoClienteId) !== String(venta.clienteId);
        const monedaNueva = body.moneda ? normalizarTexto(body.moneda).toUpperCase() : (venta.moneda || 'ARS');
        if (!MONEDAS_VALIDAS.includes(monedaNueva)) throw err(400, 'Moneda inválida (ARS o USD)');
        const monedaCambia = monedaNueva !== (venta.moneda || 'ARS');
        if ((clienteCambia || monedaCambia) && hayCobros) throw err(400, 'Esta venta ya tiene cobros: no se puede cambiar el cliente ni la moneda. Anulá primero esos cobros (Tesorería → Cobranzas).');
        let cliente = null;
        if (clienteCambia) { cliente = await cargarClienteParaOperar(db, req, nuevoClienteId); if (!cliente) throw err(400, 'El cliente no existe (o no pertenece a esta organización)'); }
        // productos
        let items = originales, subtotal = Number(venta.subtotal) || 0;
        if (Array.isArray(body.items)) {
          if (!body.items.length) throw err(400, 'La venta necesita al menos un producto.');
          if (originales.some(o => (o.cantidadAcreditada || 0) > 0)) throw err(400, 'Esta venta tiene notas de crédito aplicadas: no se pueden cambiar sus productos.');
          const usados = new Set();
          body.items.forEach(it => { if (it.index !== undefined && it.index !== null && it.index !== '') { const i = Number(it.index); if (!Number.isInteger(i) || i < 0 || i >= originales.length || usados.has(i)) throw err(400, 'Hay un producto inválido en la venta.'); usados.add(i); } });
          originales.forEach((o, i) => { if (!usados.has(i) && (o.cantidadEntregada || 0) > 0) throw err(400, `No se puede quitar "${o.nombre}": ya se entregó.`); });
          const norm = await normalizarItems(db, req, body.items);
          items = norm.items.map((n, k) => {
            const raw = body.items[k]; if (raw.index === undefined || raw.index === null || raw.index === '') return n;
            const o = originales[Number(raw.index)]; const ent = o.cantidadEntregada || 0;
            if (ent > 0 && String(o.productoId || '') !== String(n.productoId || '')) throw err(400, `No se puede cambiar el producto "${o.nombre}": ya se entregó.`);
            if (n.cantidad < ent - 1e-9) throw err(400, `De "${o.nombre}" ya se entregaron ${ent}: no se puede bajar la cantidad por debajo de eso.`);
            return Object.assign({}, o, n, { cantidadEntregada: ent });
          });
          subtotal = norm.subtotal;
        }
        const dp = body.descuentoPorcentaje !== undefined ? (body.descuentoPorcentaje ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : 0) : (venta.descuentoPorcentaje || 0);
        const dm = body.descuentoMonto !== undefined ? (body.descuentoMonto ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : 0) : (venta.descuentoMonto || 0);
        const total = calcularTotal(subtotal, dp, dm);
        const saldoNuevo = Math.round((Number(venta.saldoPendiente) + (total - Number(venta.total))) * 100) / 100;
        if (saldoNuevo < -0.005) throw err(400, `El nuevo total ($ ${total.toFixed(2)}) queda por debajo de lo ya cobrado ($ ${(Number(venta.total) - Number(venta.saldoPendiente)).toFixed(2)}). Anulá un cobro (Tesorería → Cobranzas) o subí el total.`);
        if (Math.abs(total - Number(venta.total)) > 0.004) cambios.push(`total $ ${Number(venta.total).toFixed(2)} → $ ${total.toFixed(2)}`);
        if (Array.isArray(body.items)) { const sig = it => `${it.productoId || ''}|${it.cantidad}|${it.precioUnitario}|${it.descuentoPorcentaje || 0}`; if (items.map(sig).join(';') !== originales.map(sig).join(';')) cambios.push('productos'); }
        if (clienteCambia) { set.clienteId = nuevoClienteId; set.clienteNombre = nombreCompletoCliente(cliente) || cliente.apellidoRazonSocial || cliente.nombre || ''; cambios.push('cliente'); }
        if (monedaCambia) { set.moneda = monedaNueva; cambios.push('moneda'); }
        if (body.listaPrecioId !== undefined) { const l = body.listaPrecioId ? toObjectId(body.listaPrecioId) : null; if (String(l || '') !== String(venta.listaPrecioId || '')) { set.listaPrecioId = l; cambios.push('lista de precio'); } }
        if (dp !== (venta.descuentoPorcentaje || 0)) { set.descuentoPorcentaje = dp; cambios.push('descuento %'); }
        if (dm !== (venta.descuentoMonto || 0)) { set.descuentoMonto = dm; cambios.push('descuento $'); }
        Object.assign(set, { items, subtotal, total, saldoPendiente: saldoNuevo, estado: estadoSegunItems(items) });
        if (set.estado === 'entregada' && !venta.entregadaEn) set.entregadaEn = ahora;
        if (set.estado !== 'entregada') set.entregadaEn = null;
        // efectos: reserva de stock y cuenta corriente (después de validar todo)
        if (cambios.length) {
          const reserva = (lista) => { const m = new Map(); for (const it of lista) { if (!it.productoId) continue; const k = String(it.productoId); m.set(k, { productoId: it.productoId, q: (m.get(k) ? m.get(k).q : 0) + cantidadPendiente(it) }); } return m; };
          const antes = reserva(originales), despues = reserva(items);
          // se toma la versión de la venta que leímos: si en el medio cambió (un cobro, otra edición) se rechaza en vez de pisarla
          const guarda = await db.collection('ventas').updateOne({ _id: id, updatedAt: venta.updatedAt }, { $set: Object.assign({}, set, { editadaEn: ahora }), $push: { ediciones: { at: ahora, usuario: usuarioNombre, cambios } } });
          if (!guarda.matchedCount) throw err(409, 'La venta cambió mientras la editabas (por ejemplo, se registró un cobro). Abrila de nuevo y repetí el cambio.');
          if (venta.stockComprometido) {
            for (const k of new Set([...antes.keys(), ...despues.keys()])) {
              const delta = Math.round(((despues.get(k) ? despues.get(k).q : 0) - (antes.get(k) ? antes.get(k).q : 0)) * 1000) / 1000; if (Math.abs(delta) < 1e-9) continue;
              const pid = (antes.get(k) || despues.get(k)).productoId;
              await db.collection('stock_actual').updateOne(Object.assign({ productoId: pid, depositoId: venta.depositoId || null }, filtroOrg(req)),
                { $inc: { cantidadComprometida: delta }, $set: { actualizadoEn: ahora }, $setOnInsert: Object.assign({ productoId: pid, depositoId: venta.depositoId || null, cantidad: 0 }, filtroOrg(req)) }, { upsert: true });
            }
          }
          const concepto = `Ajuste por edición de Venta Nº ${venta.numero}`;
          if (clienteCambia) {
            if (Number(venta.saldoPendiente) > 0) await registrarMovimientoCuentaCorriente(db, req, { clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto: Number(venta.saldoPendiente), moneda: venta.moneda || 'ARS', concepto: `Cambio de cliente de Venta Nº ${venta.numero}`, origen: 'venta', ventaId: venta._id });
            if (total > 0) await registrarMovimientoCuentaCorriente(db, req, { clienteId: nuevoClienteId, clienteNombre: set.clienteNombre, tipo: 'debito', monto: total, moneda: monedaNueva, concepto: `Venta Nº ${venta.numero}`, origen: 'venta', ventaId: venta._id, fecha: set.fecha || venta.fecha });
          } else {
            const dif = Math.round((total - Number(venta.total)) * 100) / 100;
            if (Math.abs(dif) >= 0.01) await registrarMovimientoCuentaCorriente(db, req, { clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: dif > 0 ? 'debito' : 'credito', monto: Math.abs(dif), moneda: venta.moneda || 'ARS', concepto, origen: 'venta', ventaId: venta._id });
          }
          return db.collection('ventas').findOne({ _id: id });
        }
      }
      if (cambios.length) {
        await db.collection('ventas').updateOne({ _id: id }, { $set: Object.assign({}, set, { editadaEn: ahora }), $push: { ediciones: { at: ahora, usuario: usuarioNombre, cambios } } });
      }
      return db.collection('ventas').findOne({ _id: id });
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
      const venta = await buscarVentaOperable(db, req, id);
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.tipoComprobante === 'nota_credito' || venta.tipoComprobante === 'nota_debito') {
        throw err(400, 'Las notas de crédito/débito no generan remito.');
      }
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada.');
      if (venta.estado === 'entregada') throw err(400, 'Esta venta ya tiene todo entregado.');
      if (venta.canceladaPorNota) throw err(400, 'Esta factura está cancelada con una nota de crédito: no se entrega.');

      const depositoId = depositoIdBody || venta.depositoId;
      if (!depositoId) throw err(400, 'Elegí a qué depósito le vas a descontar el stock.');

      if (venta.stockComprometido) {
        // (3/10/2026) ya estaba comprometido en algún lado — en el
        // depósito de la venta si tenía uno, o en el "sin asignar"
        // (null) si no. Si el depósito elegido ahora es otro, se migra
        // lo pendiente antes de generar el remito.
        await migrarCompromisoDeposito(db, req, venta, venta.depositoId || null, depositoId);
      } else {
        // Venta cargada antes de este cambio (sin depósito ni reserva
        // hecha al momento de guardarla) — se compromete recién ahora,
        // como paso previo a generar el remito (que valida el stock
        // físico real antes de descontar — ver generarRemitoDeVenta).
        await comprometerStockDeVenta(db, req, venta.items, depositoId);
      }

      const entregas = itemsBody ? itemsBody.map(it => ({ index: it.index, cantidad: it.cantidad })) : null;
      try {
        await generarRemitoDeVenta(db, req, venta, depositoId, entregas, req.body && req.body.observaciones);
      } catch (e) {
        // Si el remito falla, no dejar comprometido lo que recién se reservó (quedaba stock "comprometido" sin explicación).
        if (!venta.stockComprometido) {
          for (const item of venta.items) {
            if (!item.productoId) continue;
            const q = cantidadPendiente(item);
            if (q > 0) await db.collection('stock_actual').updateOne(Object.assign({ productoId: item.productoId, depositoId }, filtroOrg(req)), { $inc: { cantidadComprometida: -q } });
          }
        } else {
          await migrarCompromisoDeposito(db, req, venta, depositoId, venta.depositoId || null).catch(() => {});
        }
        throw e;
      }
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Corrige lo entregado de una venta migrada de Dux (14/10/2026, pedido de Mato: figuraba entregada completa pero era parcial).
// No mueve stock: solo ajusta cantidadEntregada y el estado, para poder generar remitos por lo que falta.
router.post('/:id/ajustar-entrega', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const items = req.body && Array.isArray(req.body.items) ? req.body.items : null;
    if (!items) throw err(400, 'Faltan los ítems.');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await buscarVentaOperable(db, req, id);
      if (!venta) throw err(404, 'Venta no encontrada');
      if (!venta.importado) throw err(400, 'Solo se puede corregir la entrega de ventas migradas de Dux.');
      if (venta.estado === 'anulada') throw err(400, 'Esta venta está anulada.');
      const nuevos = venta.items.map((it, idx) => {
        const e = items.find(x => Number(x.index) === idx);
        if (!e) return it;
        const c = Number(e.cantidadEntregada);
        if (!Number.isFinite(c) || c < 0 || c > (it.cantidad || 0) + 1e-9) throw err(400, `Cantidad entregada inválida para "${it.nombre}".`);
        return Object.assign({}, it, { cantidadEntregada: c });
      });
      const total = nuevos.reduce((s, it) => s + (it.cantidad || 0), 0);
      const ent = nuevos.reduce((s, it) => s + (it.cantidadEntregada || 0), 0);
      const estado = ent <= 0 ? 'pendiente' : (ent >= total - 1e-9 ? 'entregada' : 'parcialmente_entregada');
      await db.collection('ventas').updateOne({ _id: id }, { $set: { items: nuevos, estado, entregaCorregida: true, updatedAt: new Date() } });
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
      if (venta.importado) throw err(400, 'Es una venta histórica importada de Dux: no se puede anular desde acá.');
      // Un comprobante con CAE existe para ARCA: no se borra, se compensa (5/10/2026).
      if (venta.cae) throw err(400, (venta.tipoComprobante === 'nota_credito' || venta.tipoComprobante === 'nota_debito')
        ? `Esta nota ya fue autorizada por ARCA (CAE ${venta.cae}) y no se puede borrar: se compensa con la nota contraria (${venta.tipoComprobante === 'nota_credito' ? 'Nota de Débito' : 'Nota de Crédito'}).`
        : `Este comprobante ya fue autorizado por ARCA (CAE ${venta.cae}) y no se puede anular: hacé una Nota de Crédito.`);
      if (venta.fiscalEstado === 'autorizando') throw err(409, 'Se está autorizando en ARCA en este momento. Esperá unos segundos.');
      if (venta.fiscalIntento) throw err(409, 'La autorización en ARCA de este comprobante quedó incierta (se cortó la conexión). Pedí el CAE de nuevo desde el detalle para confirmar si ARCA lo emitió; después, si hace falta, hacé una Nota de Crédito.');

      // (3/10/2026) una sola función cubre los tres casos — pendiente sin
      // nada entregado, entregada del todo, o con uno o varios remitos
      // parciales — porque ahora puede haber una mezcla de ambas cosas
      // en la misma venta (parte entregada, parte todavía comprometida).
      await revertirStockDeVentaAnulada(db, req, venta);

      // Cuenta corriente del cliente (2/10/2026; rama de Nota de Crédito
      // agregada 3/10/2026): al anular una venta o Nota de Débito, se le
      // devuelve al cliente la deuda que le quedaba pendiente de ESTE
      // comprobante (lo ya cobrado ya generó su propio crédito al
      // cobrarse — acá solo se cancela lo que faltaba). Una Nota de
      // Crédito no tiene saldoPendiente (nunca se "cobra", ver POST /),
      // así que anularla necesita el movimiento inverso explícito: un
      // débito por el total, deshaciendo el crédito que se había dado.
      if (venta.tipoComprobante === 'nota_credito') {
        await desaplicarNota(db, venta);
        if (venta.total > 0) {
          await registrarMovimientoCuentaCorriente(db, req, {
            clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'debito', monto: venta.total, moneda: venta.moneda || 'ARS',
            concepto: `Anulación Nota de Crédito Nº ${venta.numero}`, origen: 'venta', ventaId: venta._id, observaciones: motivo
          });
        }
      } else if (venta.saldoPendiente > 0) {
        await registrarMovimientoCuentaCorriente(db, req, {
          clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto: venta.saldoPendiente, moneda: venta.moneda || 'ARS',
          concepto: `Anulación venta Nº ${venta.numero}`, origen: 'venta', ventaId: venta._id, observaciones: motivo
        });
      }

      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      await db.collection('ventas').updateOne(
        { _id: id, cae: { $exists: false }, fiscalEstado: { $ne: 'autorizando' } },
        { $set: { estado: 'anulada', anuladaEn: ahora, anuladaPor: usuarioNombre, anuladaMotivo: motivo, updatedAt: ahora } }
      );
      return db.collection('ventas').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Cambia si una Nota de Crédito ya emitida reingresó o no la mercadería
// (15/10/2026): quita el ingreso (egreso compensatorio) o lo agrega.
router.post('/:id/stock-nota', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const reingresa = !!(req.body && req.body.reingresa);
    const depositoIdBody = (req.body && req.body.depositoId) ? toObjectId(req.body.depositoId) : null;
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const venta = await buscarVentaOperable(db, req, id);
      if (!venta) throw err(404, 'Venta no encontrada');
      if (venta.tipoComprobante !== 'nota_credito') throw err(400, 'Solo aplica a notas de crédito.');
      if (venta.estado === 'anulada') throw err(400, 'La nota está anulada.');
      const yaReingreso = venta.reingresaStock !== false && !!venta.stockDescontado;
      const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
      if (reingresa) {
        if (yaReingreso) throw err(400, 'Esta nota ya reingresó la mercadería.');
        const depositoId = depositoIdBody || venta.depositoId;
        if (!depositoId) throw err(400, 'Elegí el depósito.');
        for (const item of venta.items || []) {
          if (!item.productoId) continue;
          await aplicarMovimientoStock(db, req, { productoId: item.productoId, depositoId, tipo: 'ingreso', cantidad: item.cantidad,
            motivo: 'Nota de crédito', observaciones: `Nota de crédito Nº ${venta.numero}`, ventaId: venta._id, usuarioNombre, fecha: new Date() });
        }
        await db.collection('ventas').updateOne({ _id: id }, { $set: { reingresaStock: true, stockDescontado: true, stockDescontadoEn: new Date(), depositoId, updatedAt: new Date() } });
      } else {
        if (!yaReingreso) throw err(400, 'Esta nota no reingresó stock.');
        for (const item of venta.items || []) {
          if (!item.productoId) continue;
          await aplicarMovimientoStock(db, req, { productoId: item.productoId, depositoId: venta.depositoId, tipo: 'egreso', cantidad: item.cantidad,
            motivo: 'Corrección de nota de crédito', observaciones: `Se quita el reingreso de la nota de crédito Nº ${venta.numero}`, ventaId: venta._id, usuarioNombre, fecha: new Date() });
        }
        await db.collection('ventas').updateOne({ _id: id }, { $set: { reingresaStock: false, stockDescontado: false, updatedAt: new Date() } });
      }
      const notaFinal = await db.collection('ventas').findOne({ _id: id });
      if (notaFinal.aplicadaA && notaFinal.aplicadaA.ventaId) {
        const fact = await db.collection('ventas').findOne({ _id: notaFinal.aplicadaA.ventaId });
        await ajustarCompromisoPorNota(db, notaFinal, fact, !reingresa);
      }
      return notaFinal;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Registra un cobro contra la venta (parcial o total). Los pagos son un
// detalle append-only (no se editan ni se borran — un error se corrige
// con un pago en sentido contrario, mismo criterio que el libro de Stock).
// Un cobro (un medio de pago) sobre la venta. `reciboGrupo` agrupa varios
// medios cobrados juntos para que salgan en un mismo recibo.
async function procesarPagoVenta(req, id, body, reciboGrupo) {
  {
    const tipoValor = normalizarTexto(body.tipoValor).toLowerCase();
    if (!TIPOS_VALOR_VALIDOS.includes(tipoValor)) throw err(400, `Tipo de valor inválido (opciones: ${TIPOS_VALOR_VALIDOS.join(', ')})`);
    const monto = normalizarMontoNoNegativo(body.monto, 'El monto');
    if (monto <= 0) throw err(400, 'El monto del cobro tiene que ser mayor a 0.');
    const nota = normalizarTexto(body.nota);
    const retenciones = normalizarLineasImpuesto(body.retenciones, TIPOS_RETENCION, 'Retenciones');
    const totalRetenciones = sumarMontos(retenciones);
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
      if (venta.canceladaPorNota) throw err(400, 'Este comprobante ya está cancelado con una nota de crédito: no tiene saldo para cobrar.');
      if (venta.importado) throw err(400, 'Es una venta histórica importada de Dux: no admite cobros nuevos.');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      let chequeId = null;
      let planTarjeta = null;

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
        // Plan de tarjeta: al banco entra lo cobrado (más el recargo, si hay) menos el costo del plan.
        if (tipoValor === 'tarjeta' && body.tarjetaPlanId) planTarjeta = await calcularPlanTarjeta(db, req, { planId: body.tarjetaPlanId, monto, aplicarRecargo: body.aplicarRecargo, listaPrecioId: venta.listaPrecioId || null });
        const observacionesMovimiento = tipoValor === 'tarjeta'
          ? [nota, `Lote ${tarjetaDatos.tarjetaLote || '—'} / Cupón ${tarjetaDatos.tarjetaCupon || '—'}`, planTarjeta ? `${planTarjeta.tarjetaPlanNombre} (costo ${planTarjeta.tarjetaCostoFinanciero})` : ''].filter(Boolean).join(' — ')
          : nota;
        await aplicarMovimientoCuenta(db, req, {
          cuentaTipo, cuentaId, tipo: 'ingreso', monto: planTarjeta ? planTarjeta.tarjetaIngresoNeto : monto, moneda: venta.moneda || 'ARS',
          motivo: `Cobro venta Nº ${venta.numero}`, observaciones: observacionesMovimiento, origen: 'venta', ventaId: id, fecha
        });
      }

      const pago = Object.assign(
        { tipoValor, monto, fecha, nota, usuarioNombre },
        retenciones.length ? { retenciones, totalRetenciones } : {},
        cuentaTipo ? { cuentaTipo, cuentaId } : {},
        chequeId ? { chequeId } : {},
        tarjetaDatos || {},
        planTarjeta || {},
        reciboGrupo ? { reciboGrupo } : {}
      );
      const totalCobrado = (venta.totalCobrado || 0) + monto + totalRetenciones; // las retenciones también cancelan deuda
      const saldoPendiente = Math.max(0, Math.round((venta.total - totalCobrado - (venta.totalAcreditado || 0)) * 100) / 100);
      await db.collection('ventas').updateOne(
        { _id: id },
        { $push: { pagos: pago }, $set: { totalCobrado, saldoPendiente, updatedAt: new Date() } }
      );
      await registrarRetencionesSufridas(db, req, { origen: 'cobro_venta', retenciones, fecha, moneda: venta.moneda || 'ARS',
        referencia: { ventaId: id, ventaNumero: venta.numero, clienteId: venta.clienteId || null, clienteNombre: venta.clienteNombre || '' } });

      // Cuenta corriente del cliente (2/10/2026): el cobro reduce la
      // deuda, además del ingreso real en Tesorería (o el cheque en
      // cartera) ya aplicado arriba.
      await registrarMovimientoCuentaCorriente(db, req, {
        clienteId: venta.clienteId, clienteNombre: venta.clienteNombre, tipo: 'credito', monto: monto + totalRetenciones, moneda: venta.moneda || 'ARS',
        concepto: `Cobro venta Nº ${venta.numero}`, origen: 'cobro_venta', ventaId: id, chequeId, fecha,
        observaciones: retenciones.length ? 'Incluye retenciones: ' + retenciones.map(r => `${r.tipoNombre} $${r.monto}`).join(', ') : ''
      });

      return db.collection('ventas').findOne({ _id: id });
    });
    return resultado;
  }
}

// Anti duplicado de cobros (21/10/2026): cada pantalla de cobro manda una clave única; si el mismo pedido llega dos veces
// (doble clic, conexión lenta) el segundo no registra otro pago: espera y devuelve el resultado del primero.
const _pagosClaves = new Map();
function limpiarClavesPago() { const lim = Date.now() - 10 * 60 * 1000; for (const [k, v] of _pagosClaves) if (v.t < lim) _pagosClaves.delete(k); }
router.post('/:id/pagos', authAdmin, async (req, res, next) => {
  const clave = req.body && req.body.claveUnica ? String(req.body.claveUnica).slice(0, 80) : '';
  if (!clave) return next();
  limpiarClavesPago();
  const k = String(req.params.id) + '|' + clave;
  const previo = _pagosClaves.get(k);
  if (previo) {
    try { const r = await previo.promesa; return res.json(r); }
    catch (e) { return res.status(409).json({ error: 'El pago anterior no se pudo registrar: volvé a intentar.' }); }
  }
  const entrada = { t: Date.now() };
  entrada.promesa = new Promise((resolve, reject) => { entrada.resolve = resolve; entrada.reject = reject; });
  entrada.promesa.catch(() => {});
  _pagosClaves.set(k, entrada);
  const jsonOrig = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 400) { _pagosClaves.delete(k); entrada.reject(new Error('fallo')); } else entrada.resolve(data);
    return jsonOrig(data);
  };
  next();
});
router.post('/:id/pagos', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    // Varios medios de pago en un mismo recibo (13/10/2026, pedido de Mato):
    // cada medio queda como un cobro propio (cheque en cartera, ingreso en
    // caja/banco), todos con el mismo reciboGrupo; las retenciones van en el primero.
    if (Array.isArray(body.valores) && body.valores.length > 1) {
      const grupo = new ObjectId().toString();
      let venta = null;
      for (let i = 0; i < body.valores.length; i++) {
        const v = Object.assign({}, body.valores[i], { fecha: body.fecha, nota: body.nota, retenciones: i === 0 ? body.retenciones : [] });
        try { venta = await procesarPagoVenta(req, id, v, grupo); }
        catch (e) { if (i > 0) e.message = `Se registraron ${i} de ${body.valores.length} medios de pago y falló el siguiente: ${e.message}`; throw e; }
      }
      res.json(venta);
      try { const correo = require('./correo'); const iG = (venta.pagos || []).findIndex(p => p.reciboGrupo === grupo); correo.enviarRecibo(id, iG >= 0 ? iG : (venta.pagos || []).length - 1, correo.baseUrlDe(req)); } catch (e) { /* el mail nunca frena el cobro */ }
      return;
    }
    const ventaPago = await procesarPagoVenta(req, id, body.valores && body.valores.length === 1 ? Object.assign({}, body, body.valores[0]) : body, null);
    res.json(ventaPago);
    try { const correo = require('./correo'); correo.enviarRecibo(id, (ventaPago.pagos || []).length - 1, correo.baseUrlDe(req)); } catch (e) { /* el mail nunca frena el cobro */ }
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Link público de un documento (14/10/2026, pedido de Mato: "que me copie en el portapapeles el link" para mandarle al
// cliente sin pasar por WhatsApp). Se guarda un token imposible de adivinar que apunta a un comprobante, remito o recibo;
// GET /d/:token (sin sesión, ver server.js) devuelve el mismo documento imprimible.
// -----------------------------------------------------------------------
router.post('/link-publico', authAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const tipo = String(b.tipo || '');
    if (!['comprobante', 'remito', 'recibo'].includes(tipo)) throw err(400, 'Tipo de documento inválido.');
    const id = toObjectId(b.id);
    if (!id) throw err(400, 'id inválido');
    const index = tipo === 'recibo' ? Number(b.index) : null;
    if (tipo === 'recibo' && (!Number.isInteger(index) || index < 0)) throw err(400, 'índice de pago inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const col = tipo === 'remito' ? 'remitos' : 'ventas';
      let doc = await db.collection(col).findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!doc && req.vistaTodas) doc = await db.collection(col).findOne({ _id: id });
      if (!doc) throw err(404, 'Documento no encontrado');
      const filtro = { tipo, docId: id, index, orgId: doc.orgId };
      let link = await db.collection('links_publicos').findOne(filtro);
      if (!link) {
        link = Object.assign({ token: require('crypto').randomBytes(24).toString('hex'), createdAt: new Date(), creadoPor: (req.usuario && req.usuario.nombre) || '' }, filtro);
        await db.collection('links_publicos').insertOne(link);
      }
      return { token: link.token };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Sin sesión: se monta en server.js como GET /d/:token.
router.servirLinkPublico = async (req, res) => {
  try {
    const token = String(req.params.token || '');
    if (!/^[0-9a-f]{48}$/.test(token)) return res.status(404).send('Link inválido');
    const db = await getDb();
    const link = await db.collection('links_publicos').findOne({ token });
    if (!link) return res.status(404).send('Link inválido o vencido');
    const path = link.tipo === 'comprobante' ? '/:id/comprobante' : (link.tipo === 'remito' ? '/remitos/:id/imprimir' : '/:id/pagos/:index/recibo');
    const layer = router.stack.find(l => l.route && l.route.path === path && l.route.methods.get);
    if (!layer) return res.status(404).send('Documento no disponible');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const fake = Object.create(req);
    fake.params = { id: String(link.docId), index: String(link.index == null ? '' : link.index) };
    fake.orgId = link.orgId; fake.usuario = { nombre: '', rol: {} }; fake.query = {};
    res.set('X-Robots-Tag', 'noindex, nofollow');
    // Quien recibe el link es el cliente: sin los botones de Compartir / WhatsApp (son de uso interno). Imprimir se deja.
    const enviar = res.send.bind(res);
    res.send = (html) => enviar(typeof html === 'string' ? html.replace(/<button onclick="compartirDocumento\(\)">Compartir<\/button>\s*/g, '').replace(/<button onclick="whatsappDocumento\(\)">WhatsApp<\/button>\s*/g, '') : html);
    await handler(fake, res);
  } catch (e) { res.status(500).send('No se pudo generar el documento'); }
};

module.exports = router;
