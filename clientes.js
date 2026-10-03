// ---------------------------------------------------------------------------
// Clientes — registro maestro de clientes (siguiente paso de migrar todo lo
// que hoy se lleva en Dux a este sistema, decisión con Mato, 28/9/2026).
//
// Mismo criterio que Productos: los campos se alinean a propósito con los
// mismos que usa Dux al crear un cliente (relevado de "Crea y gestiona tus
// clientes" en su ayuda oficial), para que cargar lo que ya existe en Dux
// sea directo — de ahí en más se sacan o agregan campos según haga falta.
//
// Campo obligatorio, igual que en Dux: `apellidoRazonSocial` y
// `categoriaFiscal`. Todo lo demás es opcional, también igual que en Dux
// (a diferencia de Productos, donde el SKU/Código si es obligatorio acá
// porque así lo pidió Mato).
//
// PENDIENTE DE DECISIÓN (ver roadmap-modulos.md, "Entidades compartidas"):
// Visitas y CRM (oportunidades) siguen teniendo su propio bloque de texto
// suelto de cliente — todavía no se migraron a apuntar acá con un
// `clienteId`. Este módulo es el punto de partida para esa entidad
// compartida, pero la migración de Visitas/CRM es un paso aparte, a
// propósito no incluido en esta primera versión.
//
// Colección nueva (en la misma base `calculadora_m2`):
//   clientes : { codigo, apellidoRazonSocial, nombre, nombreFantasia, sexo,
//     tipoCliente, origenCliente, fechaNacimiento, noEditable,
//     limiteCtaCteFacturacion, limiteCtaCtePedido, categoriaFiscal,
//     tipoDocumento, numeroDocumento, cuit, listaPrecioPorDefecto,
//     condicionPago, porcentajeDescuento, vendedor,
//     tipoComprobantePorDefecto, transporteEntregaPorDefecto,
//     lugarEntregaPorDefecto, provincia, localidad, domicilio, barrio,
//     codigoPostal, zona, telefono, fax, companiaCelular, celular,
//     personaContacto, email, paginaWeb, observaciones, descripcion,
//     notas, activo, orgId, createdAt, updatedAt }
//
// Módulo con clave propia ('clientes'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const clientesRouter = require('./clientes');
//   app.use('/api/clientes', clientesRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx, exportarPlantillaXlsx, parsearXlsxBase64 } = require('./importExport');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
// Índices (1/10/2026, mismo motivo que en productos.js: "que ande más
// fluido" — la búsqueda de clientes de Nueva Venta recorría la colección
// entera en cada letra tipeada).
let indicesListos = false;
async function asegurarIndices(db) {
  if (indicesListos) return;
  indicesListos = true;
  try {
    const col = db.collection('clientes');
    await Promise.all([
      col.createIndex({ orgId: 1, activo: 1, apellidoRazonSocial: 1 }),
      col.createIndex({ orgId: 1, cuit: 1 }),
      col.createIndex({ orgId: 1, codigo: 1 }),
      db.collection('cuenta_corriente_movimientos').createIndex({ clienteId: 1, fecha: -1, createdAt: -1 }),
      db.collection('cuenta_corriente_saldos').createIndex({ clienteId: 1 }, { unique: true })
    ]);
  } catch (e) {
    indicesListos = false;
    console.error('No se pudieron crear los índices de clientes:', e.message);
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

const authAdmin = [authUsuario, resolverOrg, requiereModulo('clientes')];

const CATEGORIAS_FISCALES_VALIDAS = ['consumidor_final', 'exento', 'monotributista', 'responsable_inscripto', 'exterior', 'iva_no_alcanzado'];
const TIPOS_DOCUMENTO_VALIDOS = ['cuil', 'cuit', 'dni', 'pasaporte'];
const SEXOS_VALIDOS = ['femenino', 'masculino'];
const TIPOS_COMPROBANTE_VALIDOS = ['comprobante_venta', 'factura'];
const TIPOS_MOVIMIENTO_CC_VALIDOS = ['debito', 'credito'];

// -----------------------------------------------------------------------
// Cuenta corriente — libro de deuda/pago por cliente, independiente de en
// qué caja/banco entró la plata (eso lo lleva Tesorería). Pedido de Mato
// (2/10/2026): "tambien en tesoreria deberiamos poder realizar una
// cobranza en la cuenta del cliente, para lo que tenemos que crear la
// cuenta corriente del cliente para ver los movimientos dentro de la
// ficha del cliente".
//
// Débito = el cliente debe más (se genera una venta, por el total).
// Crédito = el cliente debe menos (un cobro, atado a una venta puntual o
// "a cuenta" sin venta puntual). Un cobro contra una venta (ventas.js
// POST /:id/pagos) genera acá un crédito Y, por separado, el ingreso de
// plata de verdad en Tesorería (aplicarMovimientoCuenta, en tesoreria.js)
// — son dos cosas distintas: una es "cuánto me debe el cliente", la otra
// es "en qué caja/banco está la plata". Un "cobro a cuenta" desde
// Tesorería (sin venta puntual, ver POST /cobros-cuenta-cliente en
// tesoreria.js) solo toca esta cuenta corriente (y, si no es cheque,
// también Tesorería) — no hay una venta puntual a la que reducirle el
// saldo.
//
// Mismo criterio que aplicarMovimientoCuenta en tesoreria.js: esto SÍ se
// comparte entre routers (en vez de reimplementarlo en cada uno), porque
// es lógica de negocio sensible al dinero, no una lectura liviana para
// armar un formulario. Se cuelga de `router` (no de `module.exports`
// directamente) por el mismo motivo documentado en tesoreria.js: más
// abajo `module.exports = router` reemplaza el objeto exports entero, y
// dejarla en module.exports acá se perdería sin avisar.
//
// Colecciones nuevas:
//   cuenta_corriente_movimientos: { clienteId, clienteNombre, tipo
//     (debito/credito), monto, moneda, concepto, origen
//     (venta/cobro_venta/cobro_cuenta), ventaId, chequeId, observaciones,
//     usuarioNombre, fecha, orgId, createdAt } — libro inmutable, sin
//     PUT/DELETE, mismo criterio que tesoreria_movimientos/stock_movimientos.
//   cuenta_corriente_saldos: { clienteId, saldo, actualizadoEn } — caché
//     por cliente, actualizado con $inc en cada movimiento (saldo > 0 =
//     el cliente debe; saldo < 0 = tiene a favor / pagó por adelantado).
// -----------------------------------------------------------------------
async function registrarMovimientoCuentaCorriente(db, req, { clienteId, clienteNombre, tipo, monto, moneda, concepto, origen, ventaId, chequeId, observaciones, fecha }) {
  if (!clienteId) throw err(400, 'Falta el cliente');
  if (!TIPOS_MOVIMIENTO_CC_VALIDOS.includes(tipo)) throw err(400, 'Tipo de movimiento de cuenta corriente inválido');
  const montoNum = Number(monto);
  if (!Number.isFinite(montoNum) || montoNum <= 0) throw err(400, 'El monto tiene que ser mayor a 0');
  const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
  const movimiento = {
    clienteId, clienteNombre: clienteNombre || '', tipo, monto: montoNum, moneda: moneda || 'ARS',
    concepto: concepto || '', origen: origen || 'manual',
    ventaId: ventaId || null, chequeId: chequeId || null, observaciones: observaciones || '',
    usuarioNombre, fecha: fecha || new Date(), orgId: req.orgId, createdAt: new Date()
  };
  await db.collection('cuenta_corriente_movimientos').insertOne(movimiento);
  const delta = tipo === 'debito' ? montoNum : -montoNum;
  await db.collection('cuenta_corriente_saldos').updateOne(
    { clienteId },
    { $inc: { saldo: delta }, $set: { actualizadoEn: new Date() }, $setOnInsert: { clienteId } },
    { upsert: true }
  );
  return movimiento;
}
router.registrarMovimientoCuentaCorriente = registrarMovimientoCuentaCorriente;

// Columnas del Excel de import/export (30/9/2026, pedido de Mato: "todas
// las bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js para el formato de esta lista y cómo se usa.
const COLUMNAS_CLIENTES = [
  { clave: 'codigo', titulo: 'Código' },
  { clave: 'apellidoRazonSocial', titulo: 'Apellido / Razón social' },
  { clave: 'nombre', titulo: 'Nombre' },
  { clave: 'nombreFantasia', titulo: 'Nombre de fantasía' },
  { clave: 'categoriaFiscal', titulo: 'Categoría fiscal' },
  { clave: 'tipoDocumento', titulo: 'Tipo de documento' },
  { clave: 'numeroDocumento', titulo: 'Número de documento' },
  { clave: 'cuit', titulo: 'CUIT/CUIL' },
  { clave: 'tipoCliente', titulo: 'Tipo de cliente' },
  { clave: 'vendedor', titulo: 'Vendedor' },
  { clave: 'condicionPago', titulo: 'Condición de pago' },
  { clave: 'porcentajeDescuento', titulo: 'Descuento %', tipo: 'numero' },
  { clave: 'provincia', titulo: 'Provincia' },
  { clave: 'localidad', titulo: 'Localidad' },
  { clave: 'domicilio', titulo: 'Domicilio' },
  { clave: 'barrio', titulo: 'Barrio' },
  { clave: 'codigoPostal', titulo: 'Código postal' },
  { clave: 'telefono', titulo: 'Teléfono' },
  { clave: 'celular', titulo: 'Celular' },
  { clave: 'email', titulo: 'Email' },
  { clave: 'personaContacto', titulo: 'Persona de contacto' },
  { clave: 'observaciones', titulo: 'Observaciones' },
  { clave: 'notas', titulo: 'Notas' }
];

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function normalizarBooleano(v) { return !!v; }

function normalizarOpcional(v) {
  const s = normalizarTexto(v);
  return s ? s : null;
}

function normalizarNumeroOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, `${etiqueta} tiene que ser un número mayor o igual a 0`);
  return n;
}

function normalizarEnumOpcional(v, opciones, etiqueta) {
  const s = normalizarTexto(v).toLowerCase();
  if (!s) return null;
  if (!opciones.includes(s)) throw err(400, `${etiqueta} inválido (opciones: ${opciones.join(', ')})`);
  return s;
}

function normalizarFechaOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw err(400, `${etiqueta} inválida`);
  return d;
}

async function validarCodigoUnico(db, req, codigo, idExcluir) {
  if (!codigo) return;
  const match = Object.assign({ codigo, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('clientes').findOne(match);
  if (existente) throw err(400, `Ya hay otro cliente activo con el código "${codigo}" (${existente.apellidoRazonSocial}).`);
}

async function validarCuitUnico(db, req, cuit, idExcluir) {
  if (!cuit) return;
  const match = Object.assign({ cuit, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('clientes').findOne(match);
  if (existente) throw err(400, `Ya hay otro cliente activo con el CUIT/CUIL "${cuit}" (${existente.apellidoRazonSocial}).`);
}

// Campos alineados con la ficha de cliente de Dux — ver comentario de
// cabecera. Apellido/razón social y categoría fiscal son obligatorios,
// igual que en Dux; todo el resto es opcional, también igual que en Dux.
function validarCliente(body) {
  const apellidoRazonSocial = normalizarTexto(body.apellidoRazonSocial);
  if (!apellidoRazonSocial) throw err(400, 'El apellido / razón social es obligatorio');
  const categoriaFiscal = normalizarEnumOpcional(body.categoriaFiscal, CATEGORIAS_FISCALES_VALIDAS, 'Categoría fiscal');
  if (!categoriaFiscal) throw err(400, 'La categoría fiscal es obligatoria');

  const codigo = normalizarOpcional(body.codigo);
  const nombre = normalizarTexto(body.nombre);
  const nombreFantasia = normalizarTexto(body.nombreFantasia);
  const sexo = normalizarEnumOpcional(body.sexo, SEXOS_VALIDOS, 'Sexo');
  const tipoCliente = normalizarTexto(body.tipoCliente);
  const origenCliente = normalizarTexto(body.origenCliente);
  const fechaNacimiento = normalizarFechaOpcional(body.fechaNacimiento, 'La fecha de nacimiento');
  const noEditable = normalizarBooleano(body.noEditable);
  const limiteCtaCteFacturacion = normalizarNumeroOpcional(body.limiteCtaCteFacturacion, 'El límite de cta. cte. en facturación');
  const limiteCtaCtePedido = normalizarNumeroOpcional(body.limiteCtaCtePedido, 'El límite de cta. cte. en pedido');

  const tipoDocumento = normalizarEnumOpcional(body.tipoDocumento, TIPOS_DOCUMENTO_VALIDOS, 'Tipo de documento');
  const numeroDocumento = normalizarTexto(body.numeroDocumento);
  const cuit = normalizarOpcional(body.cuit);
  const listaPrecioPorDefecto = normalizarTexto(body.listaPrecioPorDefecto);
  const condicionPago = normalizarTexto(body.condicionPago);
  const porcentajeDescuento = normalizarNumeroOpcional(body.porcentajeDescuento, 'El porcentaje de descuento');
  const vendedor = normalizarTexto(body.vendedor);
  const tipoComprobantePorDefecto = normalizarEnumOpcional(body.tipoComprobantePorDefecto, TIPOS_COMPROBANTE_VALIDOS, 'Tipo de comprobante por defecto');
  const transporteEntregaPorDefecto = normalizarTexto(body.transporteEntregaPorDefecto);
  const lugarEntregaPorDefecto = normalizarTexto(body.lugarEntregaPorDefecto);

  const provincia = normalizarTexto(body.provincia);
  const localidad = normalizarTexto(body.localidad);
  const domicilio = normalizarTexto(body.domicilio);
  const barrio = normalizarTexto(body.barrio);
  const codigoPostal = normalizarTexto(body.codigoPostal);
  const zona = normalizarTexto(body.zona);
  const telefono = normalizarTexto(body.telefono);
  const fax = normalizarTexto(body.fax);
  const companiaCelular = normalizarTexto(body.companiaCelular);
  const celular = normalizarTexto(body.celular);
  const personaContacto = normalizarTexto(body.personaContacto);
  const email = normalizarTexto(body.email);
  const paginaWeb = normalizarTexto(body.paginaWeb);
  const observaciones = normalizarTexto(body.observaciones);
  const descripcion = normalizarTexto(body.descripcion);
  const notas = normalizarTexto(body.notas);

  return {
    codigo, apellidoRazonSocial, nombre, nombreFantasia, sexo, tipoCliente, origenCliente,
    fechaNacimiento, noEditable, limiteCtaCteFacturacion, limiteCtaCtePedido,
    categoriaFiscal, tipoDocumento, numeroDocumento, cuit, listaPrecioPorDefecto,
    condicionPago, porcentajeDescuento, vendedor, tipoComprobantePorDefecto,
    transporteEntregaPorDefecto, lugarEntregaPorDefecto,
    provincia, localidad, domicilio, barrio, codigoPostal, zona, telefono, fax,
    companiaCelular, celular, personaContacto, email, paginaWeb, observaciones,
    descripcion, notas
  };
}

router.get('/', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrg(req));
    if (soloActivos) match.activo = { $ne: false };
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ apellidoRazonSocial: re }, { nombre: re }, { codigo: re }, { cuit: re }, { numeroDocumento: re }];
    }
    const clientes = await conReintento(async () => {
      const db = await getDb();
      return db.collection('clientes').find(match).sort({ apellidoRazonSocial: 1 }).toArray();
    });
    res.json(clientes);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Import / export en Excel (.xlsx) — ver importExport.js.
// -----------------------------------------------------------------------

router.get('/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
    const clientes = await conReintento(async () => {
      const db = await getDb();
      return db.collection('clientes').find(match).sort({ apellidoRazonSocial: 1 }).toArray();
    });
    exportarXlsx(res, 'clientes.xlsx', COLUMNAS_CLIENTES, clientes);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/plantilla-import', authAdmin, (req, res) => {
  exportarPlantillaXlsx(res, 'plantilla-clientes.xlsx', COLUMNAS_CLIENTES);
});

// Importa filas de un Excel: si viene Código o CUIT y ya existe un
// cliente activo con ese mismo dato, lo actualiza; si no, lo crea. Nunca
// aborta el archivo entero por una fila con error — esa fila se saltea y
// se informa en `errores`.
router.post('/import', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, COLUMNAS_CLIENTES);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      let creados = 0, actualizados = 0;
      const errores = [];
      for (const fila of filas) {
        try {
          const datos = validarCliente(fila);
          let existente = null;
          if (datos.codigo) {
            existente = await db.collection('clientes').findOne(Object.assign({ codigo: datos.codigo, activo: { $ne: false } }, filtroOrg(req)));
          }
          if (!existente && datos.cuit) {
            existente = await db.collection('clientes').findOne(Object.assign({ cuit: datos.cuit, activo: { $ne: false } }, filtroOrg(req)));
          }
          const ahora = new Date();
          if (existente) {
            await db.collection('clientes').updateOne(
              { _id: existente._id },
              { $set: Object.assign({}, datos, { updatedAt: ahora }) }
            );
            actualizados++;
          } else {
            await db.collection('clientes').insertOne(
              Object.assign({}, datos, { activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora })
            );
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

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un cliente.');
    const datos = validarCliente(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarCodigoUnico(db, req, datos.codigo, null);
      await validarCuitUnico(db, req, datos.cuit, null);
      const ahora = new Date();
      const nuevo = Object.assign({}, datos, { activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora });
      const r = await db.collection('clientes').insertOne(nuevo);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const datos = validarCliente(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarCodigoUnico(db, req, datos.codigo, id);
      await validarCuitUnico(db, req, datos.cuit, id);
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('clientes').findOneAndUpdate(
        match,
        { $set: Object.assign({}, datos, { updatedAt: new Date() }) },
        { returnDocument: 'after' }
      );
      return r && r.value !== undefined ? r.value : r;
    });
    if (!doc) throw err(404, 'Cliente no encontrado');
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
      const r = await db.collection('clientes').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
      if (!r.matchedCount) throw err(404, 'Cliente no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Cuenta corriente de un cliente — historial de movimientos (ventas que
// generan deuda, cobros que la reducen, atados o no a una venta puntual)
// más el saldo actual. Pensada para mostrarse dentro de la ficha del
// cliente (ver comentario de registrarMovimientoCuentaCorriente arriba).
// -----------------------------------------------------------------------
router.get('/:id/cuenta-corriente', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const limite = Math.min(Number(req.query.limite) || 300, 1000);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cliente = await db.collection('clientes').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!cliente) throw err(404, 'Cliente no encontrado');
      const [movimientos, saldoDoc] = await Promise.all([
        db.collection('cuenta_corriente_movimientos').find({ clienteId: id }).sort({ fecha: -1, createdAt: -1 }).limit(limite).toArray(),
        db.collection('cuenta_corriente_saldos').findOne({ clienteId: id })
      ]);
      // Saldo pendiente por venta (3/10/2026, pedido de Mato: poder
      // generar un cobro de cada factura, o uno parcial, directo desde
      // la cuenta corriente). Se resuelve acá, no en el frontend, porque
      // el saldo real de cada venta vive en `ventas` (ya tiene en cuenta
      // cobros parciales y anulaciones) — la cuenta corriente solo
      // refleja el efecto neto, no alcanza para saber cuánto falta
      // cobrar de UNA venta puntual.
      const ventaIds = [...new Set(movimientos.filter(m => m.ventaId).map(m => String(m.ventaId)))].map(toObjectId).filter(Boolean);
      const ventasPorId = {};
      if (ventaIds.length) {
        const ventas = await db.collection('ventas')
          .find({ _id: { $in: ventaIds } })
          .project({ numero: 1, estado: 1, saldoPendiente: 1, moneda: 1, total: 1, stockDescontado: 1 })
          .toArray();
        for (const v of ventas) ventasPorId[String(v._id)] = v;
      }
      return { cliente, saldo: (saldoDoc && saldoDoc.saldo) || 0, movimientos, ventasPorId };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
