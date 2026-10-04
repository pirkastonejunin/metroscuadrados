// ---------------------------------------------------------------------------
// Gastos — erogaciones NO vinculadas a artículos (alquileres, servicios,
// honorarios, etc.), a diferencia de Compras que sí impacta stock e
// inventario. Pedido de Mato (3/10/2026): "los gastos son erogaciones que
// no estan vinculadas con articulos... debemos crear un menu con
// conceptos de gastos que la debemos cargar en configuracion bases y
// catalogos... los conceptos son iguales a los de compra, comprobante
// numero, fecha, etc".
//
// Es un espejo simplificado de Compras: mismo proveedor (reusa la
// colección `proveedores`), mismo circuito de pagos contra Tesorería
// (confirmado por Mato: "igual que Compras: sale de una caja/banco
// real"), pero SIN nada de stock/depósito/recepción — un gasto no
// ingresa ni egresa mercadería. En lugar de ítems de producto, cada
// línea de un gasto apunta a un "concepto de gasto" (colección nueva
// `gastos_conceptos`, catálogo con el mismo patrón de alta/baja que
// Rubros en productos.js — ver `/config/conceptos` más abajo),
// administrable desde Configuración → Bases y catálogos, pero también
// se puede crear un concepto nuevo al vuelo desde la propia pantalla de
// Gastos (confirmado por Mato: "en caso de que no esté que se pueda
// cargar de la misma pantalla").
//
// DECISIONES DE ALCANCE v1 (mismo criterio que Compras/Ventas):
//   - Sin AFIP ni numeración fiscal — comprobanteNumero es un campo de
//     texto libre (el número de la factura/recibo del proveedor), más
//     un correlativo interno propio (numero) para referenciar el gasto
//     dentro del sistema.
//   - Sin stock, sin depósito, sin "recepción" — un gasto queda
//     "activo" apenas se crea (no existe un estado intermedio como el
//     "pendiente" de Compras antes de recibir).
//   - Pagos simplificados, mismo mecanismo que Compras: efectivo/cuenta/
//     tarjeta salen de una caja/banco real (vía `aplicarMovimientoCuenta`
//     de tesoreria.js); cheque propio queda "emitido" en la colección
//     `cheques` hasta que se confirme desde Tesorería.
//   - Anular un gasto NO revierte los pagos ya registrados (mismo
//     criterio que anular una compra: los pagos quedan como registro
//     histórico; revertir movimientos de caja/banco se hace a mano
//     desde Tesorería si hiciera falta).
//
// Colección nueva: gastos : { numero (correlativo interno), comprobanteNumero,
//   proveedorId, proveedorNombre, fecha, moneda (ARS/USD), cotizacionDolar,
//   condicionPago, estado (activo/anulada), items: [{ conceptoId,
//   conceptoNombre, cantidad, precioUnitario, subtotal, observaciones }],
//   descuentoPorcentaje, descuentoMonto, subtotal, total, pagos: [{
//   tipoValor, monto, fecha, nota, usuarioNombre, ... }], totalPagado,
//   saldoPendiente, observaciones, anuladaEn, anuladaPor, anuladaMotivo,
//   usuarioNombre, orgId, createdAt, updatedAt }
//
// Catálogo nuevo: gastos_conceptos : { nombre, activo, orgId, createdAt,
//   updatedAt } — mismo patrón de alta/baja (soft-delete) que
//   productos_rubros_base en productos.js.
//
// Módulo con clave propia ('gastos'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const gastosRouter = require('./gastos');
//   app.use('/api/gastos', gastosRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx } = require('./importExport');
// Tesorería (igual que Compras): un pago en efectivo/cuenta/tarjeta sale
// YA de una caja/banco real; un pago en cheque propio crea el cheque
// "emitido" (sin mover plata hasta que se confirme el pago, desde
// Tesorería). Se reusa esta función de tesoreria.js en vez de
// reimplementarla.
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

const ESTADOS_VALIDOS = ['activo', 'anulada'];
const MONEDAS_VALIDAS = ['ARS', 'USD'];
const TIPOS_VALOR_VALIDOS = ['efectivo', 'cheque', 'cuenta', 'tarjeta'];

// Columnas del Excel de export — mismo criterio que Compras: solo
// export, un gasto se genera operativamente (ligado a pagos reales).
const COLUMNAS_GASTOS_EXPORT = [
  { clave: 'numero', titulo: 'Nº' },
  { clave: 'comprobanteNumero', titulo: 'Comprobante' },
  { clave: 'fecha', titulo: 'Fecha', tipo: 'fecha' },
  { clave: 'proveedorNombre', titulo: 'Proveedor' },
  { clave: 'condicionPago', titulo: 'Condición de pago' },
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

const authAdmin = [authUsuario, resolverOrg, requiereModulo('gastos')];

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
// Listas livianas para armar el formulario — proveedores de la
// organización (misma colección que usa Compras) y conceptos de gasto
// activos.
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

router.get('/conceptos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (!req.query.incluirInactivos) match.activo = { $ne: false };
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('gastos_conceptos').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Alta de concepto — se expone también bajo /config/conceptos (mismo
// recurso, dos rutas) para que tanto la pantalla de Gastos (alta rápida
// al vuelo) como Configuración → Bases y catálogos (administración
// completa) puedan usarlo sin duplicar lógica.
async function crearConceptoInterno(db, req, nombreRaw) {
  const nombre = normalizarTexto(nombreRaw);
  if (!nombre) throw err(400, 'Falta el nombre del concepto');
  const existente = await db.collection('gastos_conceptos').findOne(Object.assign({
    nombre: { $regex: `^${nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
  }, filtroOrg(req)));
  if (existente) {
    if (existente.activo === false) {
      await db.collection('gastos_conceptos').updateOne({ _id: existente._id }, { $set: { activo: true, updatedAt: new Date() } });
      return Object.assign({}, existente, { activo: true });
    }
    return existente;
  }
  const ahora = new Date();
  const doc = { nombre, activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora };
  const r = await db.collection('gastos_conceptos').insertOne(doc);
  doc._id = r.insertedId;
  return doc;
}

router.post('/conceptos', authAdmin, async (req, res) => {
  try {
    const resultado = await conReintento(async () => {
      const db = await getDb();
      return crearConceptoInterno(db, req, req.body && req.body.nombre);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/config/conceptos', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (!req.query.incluirInactivos) match.activo = { $ne: false };
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('gastos_conceptos').find(match).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/config/conceptos', authAdmin, async (req, res) => {
  try {
    const resultado = await conReintento(async () => {
      const db = await getDb();
      return crearConceptoInterno(db, req, req.body && req.body.nombre);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config/conceptos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const set = { updatedAt: new Date() };
    if (body.nombre !== undefined) {
      const nombre = normalizarTexto(body.nombre);
      if (!nombre) throw err(400, 'El nombre no puede quedar vacío');
      set.nombre = nombre;
    }
    if (body.activo !== undefined) set.activo = !!body.activo;

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('gastos_conceptos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!actual) throw err(404, 'Concepto no encontrado');
      await db.collection('gastos_conceptos').updateOne({ _id: id }, { $set: set });
      // Si se renombró, el nombre guardado en los gastos ya cargados NO
      // se actualiza en cascada a propósito (igual que Compras no
      // actualiza nombres de producto en ítems ya facturados — es una
      // foto del momento de la carga).
      return db.collection('gastos_conceptos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Baja de concepto — SIEMPRE soft-delete (activo:false), nunca se borra
// de verdad, así no se pierde el dato en los gastos que ya lo tengan
// cargado (mismo criterio que Rubros en productos.js).
router.delete('/config/conceptos/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const r = await db.collection('gastos_conceptos').updateOne(
        Object.assign({ _id: id }, filtroOrg(req)),
        { $set: { activo: false, updatedAt: new Date() } }
      );
      if (!r.matchedCount) throw err(404, 'Concepto no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Numeración interna — correlativo simple por organización, propio
// (no se mezcla con el de Compras ni Ventas).
// -----------------------------------------------------------------------

async function proximoNumero(db, orgId) {
  const r = await db.collection('gastos_contadores').findOneAndUpdate(
    { orgId },
    { $inc: { ultimo: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && r.value !== undefined ? r.value : r;
  return doc ? doc.ultimo : 1;
}

// Valida y normaliza los ítems (líneas de concepto) de un gasto — sin
// catálogo de productos ni stock, cada línea apunta a un concepto de
// gasto (existente o recién creado al vuelo desde el propio formulario).
async function normalizarItems(db, req, itemsRaw) {
  if (!Array.isArray(itemsRaw) || !itemsRaw.length) throw err(400, 'El gasto necesita al menos un concepto');
  const items = [];
  let subtotal = 0;
  for (const it of itemsRaw) {
    let conceptoId = it.conceptoId ? toObjectId(it.conceptoId) : null;
    let conceptoNombre = normalizarTexto(it.conceptoNombre);
    if (conceptoId) {
      const concepto = await db.collection('gastos_conceptos').findOne(Object.assign({ _id: conceptoId }, filtroOrg(req)));
      if (!concepto) throw err(400, 'Uno de los conceptos del gasto no existe (o no pertenece a esta organización)');
      conceptoNombre = concepto.nombre;
    } else if (conceptoNombre) {
      // Concepto nuevo cargado al vuelo desde la pantalla de Gastos —
      // se crea (o reactiva si estaba de baja) en el catálogo.
      const concepto = await crearConceptoInterno(db, req, conceptoNombre);
      conceptoId = concepto._id;
      conceptoNombre = concepto.nombre;
    }
    if (!conceptoNombre) throw err(400, 'Falta el concepto de una línea del gasto');
    const cantidad = normalizarCantidadPositiva(it.cantidad !== undefined && it.cantidad !== null && it.cantidad !== '' ? it.cantidad : 1, `La cantidad de "${conceptoNombre}"`);
    const precioUnitario = normalizarMontoNoNegativo(it.precioUnitario, `El monto de "${conceptoNombre}"`);
    const observaciones = normalizarTexto(it.observaciones);
    const itemSubtotal = cantidad * precioUnitario;
    subtotal += itemSubtotal;
    items.push({ conceptoId, conceptoNombre, cantidad, precioUnitario, subtotal: itemSubtotal, observaciones });
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
// Gastos — CRUD + acciones
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
      return db.collection('gastos').find(match).sort({ fecha: -1, numero: -1 }).limit(limite).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

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
      return db.collection('gastos').find(match).sort({ fecha: -1, numero: -1 }).limit(2000).toArray();
    });
    exportarXlsx(res, 'gastos.xlsx', COLUMNAS_GASTOS_EXPORT, lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const gasto = await conReintento(async () => {
      const db = await getDb();
      return db.collection('gastos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!gasto) throw err(404, 'Gasto no encontrado');
    res.json(gasto);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de cargar un gasto.');
    const body = req.body || {};
    const proveedorId = toObjectId(body.proveedorId);
    if (!proveedorId) throw err(400, 'Elegí un proveedor');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const condicionPago = normalizarTexto(body.condicionPago);
    const comprobanteNumero = normalizarTexto(body.comprobanteNumero);
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

      const gasto = {
        numero,
        comprobanteNumero,
        proveedorId,
        proveedorNombre: proveedor.razonSocial || proveedor.nombreFantasia || '',
        fecha,
        moneda,
        cotizacionDolar: body.cotizacionDolar ? normalizarMontoNoNegativo(body.cotizacionDolar, 'La cotización del dólar') : null,
        condicionPago: condicionPago || proveedor.condicionPago || '',
        estado: 'activo',
        items,
        descuentoPorcentaje,
        descuentoMonto,
        subtotal,
        total,
        pagos: [],
        totalPagado: 0,
        saldoPendiente: total,
        observaciones,
        anuladaEn: null,
        anuladaPor: null,
        anuladaMotivo: null,
        usuarioNombre,
        orgId: req.orgId,
        createdAt: ahora,
        updatedAt: ahora
      };

      const r = await db.collection('gastos').insertOne(gasto);
      gasto._id = r.insertedId;
      return gasto;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anula un gasto — sin stock de por medio, es una baja simple; los pagos
// ya registrados quedan como registro histórico (mismo criterio que
// anular una compra: revertir movimientos de caja/banco se hace a mano
// desde Tesorería si hiciera falta).
router.post('/:id/anular', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = normalizarTexto(req.body && req.body.motivo);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const gasto = await db.collection('gastos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!gasto) throw err(404, 'Gasto no encontrado');
      if (gasto.estado === 'anulada') throw err(400, 'Este gasto ya está anulado.');

      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      await db.collection('gastos').updateOne(
        { _id: id },
        { $set: { estado: 'anulada', anuladaEn: ahora, anuladaPor: usuarioNombre, anuladaMotivo: motivo, updatedAt: ahora } }
      );
      return db.collection('gastos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Registra un pago contra el gasto (parcial o total) — append-only,
// mismo circuito de Tesorería que Compras (efectivo/cuenta/tarjeta salen
// de una caja/banco real; cheque propio queda "emitido" hasta
// confirmarse desde Tesorería).
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
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

    // Mismo pedido de Mato que en Compras/Ventas: efectivo SOLO puede
    // salir de una caja; cuenta (transferencia) y tarjeta solo pueden
    // salir de un banco.
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
      const gasto = await db.collection('gastos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!gasto) throw err(404, 'Gasto no encontrado');
      if (gasto.estado === 'anulada') throw err(400, 'Este gasto está anulado, no se le pueden registrar pagos.');

      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      let chequeId = null;

      if (tipoValor === 'cheque') {
        const cheque = Object.assign({
          tipo: 'propio', moneda: gasto.moneda || 'ARS', monto, estado: 'emitido',
          proveedorId: gasto.proveedorId || null, proveedorNombre: gasto.proveedorNombre || '',
          ventaId: null, compraId: null, gastoId: id, clienteId: null, clienteNombre: '', librador: '',
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
          cuentaTipo, cuentaId, tipo: 'egreso', monto, moneda: gasto.moneda || 'ARS',
          motivo: `Pago gasto Nº ${gasto.numero}`, observaciones: observacionesMovimiento, origen: 'gasto', gastoId: id, fecha
        });
      }

      const pago = Object.assign(
        { tipoValor, monto, fecha, nota, usuarioNombre },
        cuentaTipo ? { cuentaTipo, cuentaId } : {},
        chequeId ? { chequeId } : {},
        tarjetaDatos || {}
      );
      const totalPagado = (gasto.totalPagado || 0) + monto;
      const saldoPendiente = Math.max(0, gasto.total - totalPagado);
      await db.collection('gastos').updateOne(
        { _id: id },
        { $push: { pagos: pago }, $set: { totalPagado, saldoPendiente, updatedAt: new Date() } }
      );
      return db.collection('gastos').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
