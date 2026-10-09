// ---------------------------------------------------------------------------
// Presupuestos — 3/10/2026, pedido de Mato: "en el mismo menu comercial
// tenemos que dar de alta Presupuestos, que seria lo mismo que venta pero
// que no comprometa ningun stock ni cuenta, ademas debemos poder
// asignarle estados y seguimiento. otra cosa que podamos recuperar los
// presupuestos del cotizador".
//
// Es deliberadamente un primo liviano de Ventas (mismo cliente/ítems/
// descuento/total), pero:
//   - NO compromete stock (ver comprometerStockDeVenta en ventas.js —
//     acá no se llama nunca).
//   - NO genera movimiento de cuenta corriente (ver
//     registrarMovimientoCuentaCorriente en clientes.js — tampoco se
//     llama).
//   - Tiene su propio circuito de estados para seguimiento comercial:
//     presupuestado -> en_seguimiento -> aprobado | rechazado (confirmado
//     con Mato, 3/10/2026). Cada cambio de estado se guarda en
//     `seguimiento` (historial, con nota opcional).
//   - "En seguimiento" puede llevar una fecha de próximo contacto
//     (`proximoContactoFecha`) que se sincroniza como recordatorio en el
//     calendario de Google PROPIO del usuario que lo está cargando (ver
//     usuarios.js, POST /:id/calendario — mismo mecanismo que ya usan
//     vendedores/colocadores, ver google-calendar.js).
//   - Un presupuesto "aprobado" se puede convertir en una Venta real sin
//     volver a tipear todo (ver admin-presupuestos.html, botón "Convertir
//     en venta"): a propósito NO se duplica acá la lógica de alta de
//     venta (stock comprometido, letra fiscal, cuenta corriente, etc. —
//     ver POST / en ventas.js) por lo sensible que es esa lógica; en vez
//     de eso, el botón prellena el formulario de "Nueva venta" en
//     admin-ventas.html (vía sessionStorage) y, una vez que esa venta se
//     guarda de verdad con su propio circuito ya probado, se llama a
//     POST /:id/vincular-venta acá para dejar registrado a qué venta
//     terminó convirtiéndose este presupuesto.
//   - "Recuperar del cotizador" (ver GET /cotizador/historial y
//     GET /cotizador/:id más abajo): el cotizador ya existente
//     (cotizador.js) guarda su propio historial en la colección
//     "cotizaciones" de la tienda real de Tiendanube (store_id =
//     TIENDA_REAL_STORE_ID, mismo patrón que ya usa visitas.js para
//     vincular una cotización a una visita) — estas dos rutas solo LEEN
//     esa colección para que el formulario de "Nuevo presupuesto" pueda
//     ofrecer un botón "Importar del cotizador" que trae cliente/items/
//     total ya calculados, sin tocar nada de cotizador.js.
//
// Colección nueva: presupuestos : { numero (correlativo propio, por
//   organización), clienteId, clienteNombre, vendedor, fecha, moneda,
//   cotizacionDolar, items: [{ productoId, sku, nombre, cantidad,
//   precioUnitario, subtotal }], descuentoPorcentaje, descuentoMonto,
//   subtotal, total, observaciones, estado (presupuestado/en_seguimiento/
//   aprobado/rechazado), seguimiento: [{ fecha, estado, nota,
//   usuarioNombre }], proximoContactoFecha, googleEventId,
//   googleCalendarId, origenCotizador: { cotizacionId, storeId,
//   tipoObraNombre, direccion } | null, convertidoEnVentaId,
//   convertidoEnVentaNumero, usuarioId, usuarioNombre, orgId, createdAt,
//   updatedAt }
//
// Módulo SIN clave propia: reusa 'ventas' (vive en el mismo menú
// Comercial, lo carga el mismo personal que carga ventas — no tiene
// sentido pedir un módulo aparte, mismo criterio ya usado para el
// listado de Remitos).
//
// Integración (en server.js):
//   const presupuestosRouter = require('./presupuestos');
//   app.use('/api/presupuestos', presupuestosRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const googleCalendar = require('./google-calendar');
const {
  paginaImprimible, encabezadoComprobante, recuadroClienteComprobante,
  escapeHtml: escHtml, money: moneyImp, numero: numImp, fechaCorta,
  CATEGORIA_FISCAL_LABEL
} = require('./imprimibles');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
let indicesListos = false;
async function asegurarIndices(db) {
  if (indicesListos) return;
  indicesListos = true;
  try {
    await Promise.all([
      db.collection('presupuestos').createIndex({ orgId: 1, fecha: -1, numero: -1 }),
      db.collection('presupuestos').createIndex({ orgId: 1, estado: 1, fecha: -1 }),
      db.collection('presupuestos').createIndex({ orgId: 1, clienteId: 1, fecha: -1 })
    ]);
  } catch (e) {
    indicesListos = false;
    console.error('No se pudieron crear los índices de presupuestos:', e.message);
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
    mongoClient = null;
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
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
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

const MONEDAS_VALIDAS = ['ARS', 'USD'];
// Circuito confirmado con Mato (3/10/2026): "Presupuestado, en
// seguimiento, aprobado, rechazado".
const ESTADOS_VALIDOS = ['presupuestado', 'en_seguimiento', 'aprobado', 'rechazado'];
const ESTADO_LABEL = {
  presupuestado: 'Presupuestado',
  en_seguimiento: 'En seguimiento',
  aprobado: 'Aprobado',
  rechazado: 'Rechazado'
};

const authAdmin = [authUsuario, resolverOrg, requiereModulo('ventas')];

// -----------------------------------------------------------------------
// Ítems — versión liviana de normalizarItems (ventas.js): NO valida ni
// toca stock (un presupuesto no compromete mercadería), así que acepta
// tanto un producto real del catálogo (para sugerir precio/sku) como un
// ítem 100% a mano (cotizaciones del cotizador, o algo que todavía no
// está en Productos).
// -----------------------------------------------------------------------
async function normalizarItemsPresupuesto(db, req, itemsRaw) {
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw err(400, 'El presupuesto necesita al menos un ítem');
  const items = [];
  let subtotal = 0;
  for (const it of itemsRaw) {
    const productoId = it.productoId ? toObjectId(it.productoId) : null;
    let nombre = normalizarTexto(it.nombre);
    let sku = normalizarTexto(it.sku) || null;
    let precioBase = it.precioUnitario;
    if (productoId) {
      const producto = await db.collection('productos_catalogo').findOne(Object.assign({ _id: productoId }, filtroOrg(req)));
      if (producto) {
        if (!nombre) nombre = producto.nombre;
        if (!sku) sku = producto.sku || null;
        if (precioBase === undefined || precioBase === null || precioBase === '') precioBase = producto.precio;
      }
    }
    if (!nombre) throw err(400, 'Falta el nombre de un ítem del presupuesto');
    const cantidad = normalizarCantidadPositiva(it.cantidad, `La cantidad de "${nombre}"`);
    const precioUnitario = normalizarMontoNoNegativo(precioBase, `El precio unitario de "${nombre}"`);
    const itemSubtotal = round2(cantidad * precioUnitario);
    subtotal += itemSubtotal;
    items.push({ productoId, sku, nombre, cantidad, precioUnitario, subtotal: itemSubtotal });
  }
  return { items, subtotal: round2(subtotal) };
}

function calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto) {
  let total = subtotal;
  if (descuentoPorcentaje) total -= total * (descuentoPorcentaje / 100);
  if (descuentoMonto) total -= descuentoMonto;
  return round2(Math.max(total, 0));
}

async function proximoNumeroPresupuesto(db, orgId) {
  const r = await db.collection('presupuestos_contadores').findOneAndUpdate(
    { orgId },
    { $inc: { ultimo: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return doc.ultimo;
}

// Calendario propio del usuario que está cargando/dando seguimiento al
// presupuesto (ver usuarios.js, POST /:id/calendario) — si todavía no
// tiene uno configurado, cae al calendario general de respaldo
// (GOOGLE_CALENDAR_ID) dentro de googleCalendar.upsertEvento, igual que
// vendedores/colocadores sin calendario propio.
async function calendarIdDeUsuario(db, usuarioId) {
  if (!usuarioId) return null;
  try {
    const usuarioDoc = await db.collection('usuarios').findOne({ _id: toObjectId(usuarioId) });
    return (usuarioDoc && usuarioDoc.googleCalendarId) || null;
  } catch (e) { return null; }
}

// Crea/actualiza/borra el evento de recordatorio de seguimiento en
// Google Calendar, según el estado y la fecha que tenga el presupuesto.
// Solo "en_seguimiento" con `proximoContactoFecha` cargada tiene evento;
// cualquier otro caso (otro estado, o se borró la fecha) elimina el que
// hubiera. Muta `presupuesto` in place (googleEventId/googleCalendarId);
// quien llama es responsable de persistir esos dos campos.
async function sincronizarEventoSeguimiento(db, presupuesto, usuarioId) {
  const corresponde = presupuesto.estado === 'en_seguimiento' && !!presupuesto.proximoContactoFecha;
  if (!corresponde) {
    if (presupuesto.googleEventId) {
      await googleCalendar.eliminarEvento(presupuesto.googleEventId, presupuesto.googleCalendarId);
    }
    presupuesto.googleEventId = null;
    presupuesto.googleCalendarId = null;
    return;
  }
  const calendarIdDestino = await calendarIdDeUsuario(db, usuarioId) || process.env.GOOGLE_CALENDAR_ID || null;
  if (!calendarIdDestino) return; // sin calendario propio ni general: no hay dónde sincronizar

  if (presupuesto.googleEventId && presupuesto.googleCalendarId && presupuesto.googleCalendarId !== calendarIdDestino) {
    await googleCalendar.eliminarEvento(presupuesto.googleEventId, presupuesto.googleCalendarId);
    presupuesto.googleEventId = null;
  }

  const inicio = new Date(presupuesto.proximoContactoFecha);
  const fin = new Date(inicio.getTime() + 60 * 60 * 1000); // 1 hora, solo para que tenga un bloque en el día
  presupuesto.googleEventId = await googleCalendar.upsertEvento(presupuesto.googleEventId, {
    titulo: `Seguimiento presupuesto Nº ${presupuesto.numero} — ${presupuesto.clienteNombre}`,
    descripcion: [
      `Cliente: ${presupuesto.clienteNombre}`,
      `Total: ${presupuesto.moneda} ${presupuesto.total}`,
      presupuesto.observaciones ? `Notas: ${presupuesto.observaciones}` : null
    ].filter(Boolean).join('\n'),
    inicio,
    fin
  }, calendarIdDestino);
  presupuesto.googleCalendarId = calendarIdDestino;
}

// -----------------------------------------------------------------------
// Listado y detalle
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
      return db.collection('presupuestos').find(match).sort({ fecha: -1, numero: -1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('presupuestos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!doc) throw err(404, 'Presupuesto no encontrado');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Alta
// -----------------------------------------------------------------------
router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar un presupuesto.');
    const body = req.body || {};
    const clienteId = toObjectId(body.clienteId);
    if (!clienteId) throw err(400, 'Elegí un cliente');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const vendedor = normalizarTexto(body.vendedor) || (req.usuario && req.usuario.nombre) || '';
    const descuentoPorcentaje = body.descuentoPorcentaje ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : 0;
    const descuentoMonto = body.descuentoMonto ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : 0;
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

    // Si este presupuesto se armó importando una cotización del
    // cotizador (ver GET /cotizador/:id), el front manda este bloque solo
    // informativo — para poder mostrar "viene del cotizador" y, más
    // adelante, evitar importar la misma cotización dos veces.
    const origenCotizador = (body.origenCotizador && body.origenCotizador.cotizacionId)
      ? {
        cotizacionId: normalizarTexto(body.origenCotizador.cotizacionId),
        storeId: body.origenCotizador.storeId != null ? Number(body.origenCotizador.storeId) : null,
        tipoObraNombre: normalizarTexto(body.origenCotizador.tipoObraNombre),
        direccion: normalizarTexto(body.origenCotizador.direccion)
      }
      : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cliente = await db.collection('clientes').findOne(Object.assign({ _id: clienteId }, filtroOrg(req)));
      if (!cliente) throw err(400, 'El cliente no existe (o no pertenece a esta organización)');
      const { items, subtotal } = await normalizarItemsPresupuesto(db, req, body.items);
      const total = calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto);
      const numero = await proximoNumeroPresupuesto(db, req.orgId);
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const ahora = new Date();

      const presupuesto = {
        numero,
        clienteId,
        clienteNombre: cliente.apellidoRazonSocial || cliente.nombre || '',
        vendedor,
        fecha,
        moneda,
        cotizacionDolar: body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null,
        items,
        descuentoPorcentaje,
        descuentoMonto,
        subtotal,
        total,
        observaciones,
        estado: 'presupuestado',
        seguimiento: [{ fecha: ahora, estado: 'presupuestado', nota: '', usuarioNombre }],
        proximoContactoFecha: null,
        googleEventId: null,
        googleCalendarId: null,
        origenCotizador,
        convertidoEnVentaId: null,
        convertidoEnVentaNumero: null,
        usuarioId: req.usuario && req.usuario._id ? req.usuario._id : null,
        usuarioNombre,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };
      const r = await db.collection('presupuestos').insertOne(presupuesto);
      presupuesto._id = r.insertedId;
      return presupuesto;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Edición (cliente/ítems/observaciones/etc.) — bloqueada una vez que el
// presupuesto ya se convirtió en una venta, para no desincronizar los
// dos documentos.
// -----------------------------------------------------------------------
router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('presupuestos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Presupuesto no encontrado');
      if (actual.convertidoEnVentaId) throw err(400, 'Este presupuesto ya se convirtió en una venta — no se puede editar.');

      const set = { updatedAt: new Date() };

      if (body.clienteId !== undefined) {
        const clienteId = toObjectId(body.clienteId);
        if (!clienteId) throw err(400, 'Elegí un cliente');
        const cliente = await db.collection('clientes').findOne(Object.assign({ _id: clienteId }, filtroOrg(req)));
        if (!cliente) throw err(400, 'El cliente no existe (o no pertenece a esta organización)');
        set.clienteId = clienteId;
        set.clienteNombre = cliente.apellidoRazonSocial || cliente.nombre || '';
      }
      if (body.items !== undefined) {
        const { items, subtotal } = await normalizarItemsPresupuesto(db, req, body.items);
        set.items = items;
        set.subtotal = subtotal;
        const descuentoPorcentaje = body.descuentoPorcentaje !== undefined ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : (actual.descuentoPorcentaje || 0);
        const descuentoMonto = body.descuentoMonto !== undefined ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : (actual.descuentoMonto || 0);
        set.descuentoPorcentaje = descuentoPorcentaje;
        set.descuentoMonto = descuentoMonto;
        set.total = calcularTotal(subtotal, descuentoPorcentaje, descuentoMonto);
      } else if (body.descuentoPorcentaje !== undefined || body.descuentoMonto !== undefined) {
        const descuentoPorcentaje = body.descuentoPorcentaje !== undefined ? normalizarMontoNoNegativo(body.descuentoPorcentaje, 'El descuento (%)') : (actual.descuentoPorcentaje || 0);
        const descuentoMonto = body.descuentoMonto !== undefined ? normalizarMontoNoNegativo(body.descuentoMonto, 'El descuento ($)') : (actual.descuentoMonto || 0);
        set.descuentoPorcentaje = descuentoPorcentaje;
        set.descuentoMonto = descuentoMonto;
        set.total = calcularTotal(actual.subtotal, descuentoPorcentaje, descuentoMonto);
      }
      if (body.vendedor !== undefined) set.vendedor = normalizarTexto(body.vendedor);
      if (body.observaciones !== undefined) set.observaciones = normalizarTexto(body.observaciones);
      if (body.fecha !== undefined) set.fecha = new Date(body.fecha);
      if (body.moneda !== undefined) {
        const moneda = normalizarTexto(body.moneda).toUpperCase();
        if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
        set.moneda = moneda;
      }

      await db.collection('presupuestos').updateOne({ _id: id }, { $set: set });
      return db.collection('presupuestos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Cambio de estado + seguimiento. body: { estado, nota, proximoContactoFecha }
// `proximoContactoFecha` solo tiene efecto real cuando estado ===
// 'en_seguimiento' (sincroniza/borra el recordatorio en el calendario del
// usuario que está haciendo el cambio — ver sincronizarEventoSeguimiento).
// -----------------------------------------------------------------------
router.post('/:id/estado', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const estado = normalizarTexto(body.estado);
    if (!ESTADOS_VALIDOS.includes(estado)) throw err(400, `Estado inválido (opciones: ${ESTADOS_VALIDOS.join(', ')})`);
    if (estado === 'en_seguimiento' && body.proximoContactoFecha === undefined) {
      // No es obligatorio poner fecha para pasar a "en seguimiento" (puede
      // ser solo una nota de "lo llamé, todavía no decide"), pero si no
      // viene el campo en el body se mantiene el que ya tuviera.
    }
    const nota = normalizarTexto(body.nota);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('presupuestos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Presupuesto no encontrado');
      if (actual.convertidoEnVentaId) throw err(400, 'Este presupuesto ya se convirtió en una venta — no se puede cambiar su estado.');

      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const usuarioId = req.usuario && req.usuario._id ? req.usuario._id : null;

      const proximoContactoFecha = body.proximoContactoFecha !== undefined
        ? (body.proximoContactoFecha ? new Date(body.proximoContactoFecha) : null)
        : (estado === 'en_seguimiento' ? actual.proximoContactoFecha : null);

      const presupuesto = Object.assign({}, actual, {
        estado,
        proximoContactoFecha,
        googleEventId: actual.googleEventId,
        googleCalendarId: actual.googleCalendarId
      });
      await sincronizarEventoSeguimiento(db, presupuesto, usuarioId);

      const set = {
        estado,
        proximoContactoFecha,
        googleEventId: presupuesto.googleEventId,
        googleCalendarId: presupuesto.googleCalendarId,
        updatedAt: ahora
      };
      const seguimientoEntry = { fecha: ahora, estado, nota, usuarioNombre };
      await db.collection('presupuestos').updateOne(
        { _id: id },
        { $set: set, $push: { seguimiento: seguimientoEntry } }
      );
      return db.collection('presupuestos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Vincula este presupuesto a la venta en la que terminó convirtiéndose
// (ver admin-presupuestos.html / admin-ventas.html, botón "Convertir en
// venta"). No crea la venta acá — eso ya lo hizo POST /api/ventas con su
// propio circuito completo; esto solo deja la trazabilidad y pasa el
// presupuesto a "aprobado" si todavía no lo estaba.
// -----------------------------------------------------------------------
router.post('/:id/vincular-venta', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const ventaId = toObjectId(req.body && req.body.ventaId);
    if (!ventaId) throw err(400, 'Falta ventaId');
    const ventaNumero = req.body && req.body.ventaNumero ? Number(req.body.ventaNumero) : null;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('presupuestos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Presupuesto no encontrado');
      const venta = await db.collection('ventas').findOne(Object.assign({ _id: ventaId }, filtroOrg(req)));
      if (!venta) throw err(400, 'La venta indicada no existe (o no pertenece a esta organización)');

      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const set = {
        convertidoEnVentaId: ventaId,
        convertidoEnVentaNumero: ventaNumero || venta.numero,
        updatedAt: ahora
      };
      const push = {};
      if (actual.estado !== 'aprobado') {
        set.estado = 'aprobado';
        push.seguimiento = { fecha: ahora, estado: 'aprobado', nota: `Convertido en venta Nº ${ventaNumero || venta.numero}`, usuarioNombre };
      }
      const update = { $set: set };
      if (push.seguimiento) update.$push = { seguimiento: push.seguimiento };
      await db.collection('presupuestos').updateOne({ _id: id }, update);
      return db.collection('presupuestos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('presupuestos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Presupuesto no encontrado');
      if (actual.convertidoEnVentaId) throw err(400, 'Este presupuesto ya se convirtió en una venta — no se puede borrar.');
      if (actual.googleEventId) {
        await googleCalendar.eliminarEvento(actual.googleEventId, actual.googleCalendarId);
      }
      await db.collection('presupuestos').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Importar del cotizador (3/10/2026, pedido de Mato) — solo LEE la
// colección "cotizaciones" propia del cotizador (ver cotizador.js), de la
// tienda real de Tiendanube. No requiere el módulo 'cotizador' porque
// esto es de solo lectura y vive adentro de Presupuestos (módulo
// 'ventas').
// -----------------------------------------------------------------------
router.get('/cotizador/historial', authAdmin, async (req, res) => {
  try {
    const storeId = Number(process.env.TIENDA_REAL_STORE_ID);
    if (!storeId) throw err(500, 'TIENDA_REAL_STORE_ID no está configurada en el servidor');
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('cotizaciones')
        .find({ store_id: storeId })
        .project({ cliente: 1, direccion: 1, fecha: 1, total: 1, tipoObraNombre: 1 })
        .sort({ fecha: -1 })
        .limit(200)
        .toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/cotizador/:id', authAdmin, async (req, res) => {
  try {
    const storeId = Number(process.env.TIENDA_REAL_STORE_ID);
    if (!storeId) throw err(500, 'TIENDA_REAL_STORE_ID no está configurada en el servidor');
    const cotId = toObjectId(req.params.id);
    if (!cotId) throw err(400, 'id inválido');
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('cotizaciones').findOne({ _id: cotId, store_id: storeId });
    });
    if (!doc) throw err(404, 'No se encontró esa cotización en el cotizador');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Impresión / vista para compartir con el cliente — mismo estilo que el
// comprobante de venta, sin letra fiscal ni numeración AFIP (esto nunca
// es un comprobante fiscal).
// -----------------------------------------------------------------------
router.get('/:id/imprimir', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const presupuesto = await db.collection('presupuestos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!presupuesto) throw err(404, 'Presupuesto no encontrado');
      const [org, cliente] = await Promise.all([
        db.collection('organizaciones').findOne({ _id: presupuesto.orgId }),
        presupuesto.clienteId ? db.collection('clientes').findOne({ _id: presupuesto.clienteId }) : null
      ]);
      return { presupuesto, org, cliente };
    });
    const { presupuesto, org, cliente } = resultado;
    const numeroDigitos = String(presupuesto.numero).padStart(5, '0');
    const filas = (presupuesto.items || []).map(it => `
      <tr>
        <td>${escHtml(it.sku || '—')} - ${escHtml(it.nombre)}</td>
        <td class="num">${numImp(it.cantidad)}</td>
        <td class="num">${moneyImp(it.precioUnitario, presupuesto.moneda)}</td>
        <td class="num">${moneyImp(it.subtotal, presupuesto.moneda)}</td>
      </tr>
    `).join('');
    const ivaClienteLabel = (cliente && cliente.categoriaFiscal && CATEGORIA_FISCAL_LABEL[cliente.categoriaFiscal]) || '';
    const headerHtml = encabezadoComprobante(org, {
      letra: 'P',
      numeroFmt: numeroDigitos,
      fecha: fechaCorta(presupuesto.fecha),
      tituloGrande: 'PRESUPUESTO'
    });
    const bodyHtml = `
      ${recuadroClienteComprobante({
        nombre: presupuesto.clienteNombre,
        iva: ivaClienteLabel,
        cuit: cliente ? cliente.cuit : '',
        domicilio: cliente ? cliente.domicilio : '',
        localidad: cliente ? cliente.localidad : '',
        provincia: cliente ? cliente.provincia : '',
        email: cliente ? cliente.email : '',
        condicionPago: cliente ? cliente.condicionPago : '',
        observaciones: presupuesto.observaciones
      })}
      <p class="muted" style="margin:-8px 0 10px 0;font-size:11.5px">Este presupuesto no es un comprobante fiscal — es una propuesta comercial, válida hasta que ${escHtml(org && org.nombre || 'nuestra empresa')} confirme stock y condiciones al momento de la venta.</p>
      <table>
        <thead><tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Precio Uni.</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${filas || '<tr><td colspan="4" class="muted">Sin ítems</td></tr>'}</tbody>
      </table>
      <table class="totales">
        <tr><td>Subtotal</td><td class="num">${moneyImp(presupuesto.subtotal, presupuesto.moneda)}</td></tr>
        ${presupuesto.descuentoMonto ? `<tr><td>Descuento</td><td class="num">-${moneyImp(presupuesto.descuentoMonto, presupuesto.moneda)}</td></tr>` : ''}
        <tr class="total-final"><td>Total</td><td class="num">${moneyImp(presupuesto.total, presupuesto.moneda)}</td></tr>
      </table>
      ${org && org.condicionVenta ? `<div class="cmp-condicion-venta"><strong>Condición de venta:</strong><br>${escHtml(org.condicionVenta)}</div>` : ''}
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({
      titulo: `Presupuesto Nº ${numeroDigitos}`,
      org: org || { nombre: 'Organización' },
      headerHtml,
      bodyHtml
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Presupuesto de una VISITA (9/10/2026, pedido de Mato): cuando el vendedor arma el presupuesto a mano en la
// visita (sin cotizador), se crea acá UN solo presupuesto comercial enlazado a la visita, para no tener dos
// presupuestos distintos. Mientras esté "presupuestado" o "en seguimiento" y no se haya convertido en venta,
// cada cambio de la visita actualiza ESE mismo presupuesto; una vez aprobado/rechazado/convertido queda
// congelado y la visita solo muestra el vínculo.
// ---------------------------------------------------------------------------
async function sincronizarDesdeVisita(db, { visita, clienteId, clienteNombre, items, formasPago, notas, usuarioNombre }) {
  const orgId = visita.orgId;
  const itemsPres = items.map(it => {
    const nombre = [it.tipoTrabajo, it.descripcion].filter(Boolean).join(' — ');
    return { productoId: null, sku: null, nombre, cantidad: it.cantidad, precioUnitario: it.valor, subtotal: round2(it.cantidad * it.valor) };
  });
  const subtotal = round2(itemsPres.reduce((s, i) => s + i.subtotal, 0));
  const obs = [
    'Visita #' + visita.numero + (visita.cliente && visita.cliente.direccion ? ' — ' + visita.cliente.direccion : ''),
    notas ? 'Notas: ' + notas : '',
    (formasPago || []).length ? 'Formas de pago: ' + formasPago.map(f => `${f.nombre} (${f.tipo === 'recargo' ? '+' : '-'}${f.porcentaje}%) $${f.total}`).join(' · ') : ''
  ].filter(Boolean).join('\n');
  const ahora = new Date();
  const existente = visita.presupuestoComercialId ? await db.collection('presupuestos').findOne({ _id: visita.presupuestoComercialId }) : null;
  if (existente) {
    const abierto = ['presupuestado', 'en_seguimiento'].includes(existente.estado) && !existente.convertidoEnVentaId;
    if (!abierto) return { presupuestoId: existente._id, numero: existente.numero, estado: existente.estado, congelado: true };
    await db.collection('presupuestos').updateOne({ _id: existente._id }, { $set: { clienteId, clienteNombre, items: itemsPres, subtotal, total: calcularTotal(subtotal, existente.descuentoPorcentaje || 0, existente.descuentoMonto || 0), observaciones: obs, updatedAt: ahora } });
    return { presupuestoId: existente._id, numero: existente.numero, estado: existente.estado, actualizado: true };
  }
  const numero = await proximoNumeroPresupuesto(db, orgId);
  const doc = {
    numero, clienteId, clienteNombre, vendedor: visita.vendedorNombre || usuarioNombre || '', fecha: ahora, moneda: 'ARS', cotizacionDolar: null,
    items: itemsPres, descuentoPorcentaje: 0, descuentoMonto: 0, subtotal, total: subtotal, observaciones: obs,
    estado: 'presupuestado', seguimiento: [{ fecha: ahora, estado: 'presupuestado', nota: 'Creado desde la visita #' + visita.numero, usuarioNombre: usuarioNombre || '' }],
    proximoContactoFecha: null, googleEventId: null, googleCalendarId: null, origenCotizador: null,
    origenVisita: { visitaId: visita._id, numero: visita.numero, direccion: (visita.cliente && visita.cliente.direccion) || '' },
    convertidoEnVentaId: null, convertidoEnVentaNumero: null, usuarioId: null, usuarioNombre: usuarioNombre || '', orgId, createdAt: ahora, updatedAt: ahora
  };
  const r = await db.collection('presupuestos').insertOne(doc);
  return { presupuestoId: r.insertedId, numero, estado: 'presupuestado', creado: true };
}
router.sincronizarDesdeVisita = sincronizarDesdeVisita;

module.exports = router;
