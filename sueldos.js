// ---------------------------------------------------------------------------
// Sueldos — control de costo laboral (7/10/2026, pedido de Mato).
//
// Alcance (acordado con Mato): legajo de empleados con su sector, carga
// mensual de lo que cuesta cada empleado (sueldo, adicionales, aguinaldo,
// cargas sociales y descuentos), adelantos, y pago desde Tesorería (caja o
// banco). NO calcula la liquidación legal ni emite recibos de sueldo.
//
// Colecciones nuevas:
//   empleados : { nombre, cuil, vendedorId (opcional, vincula con Vendedores), sector (produccion|administracion|ventas|
//     logistica|obra|otro), sueldoBasico (referencia), fechaIngreso, notas, activo,
//     frecuencia (semanal|quincenal|mensual: cada cuánto cobra; la liquidación sigue siendo mensual),
//     comisionPago (fin_de_mes: comisiones todas juntas un día | con_sueldo: se suman a cada pago),
//     comisionTipo (porcentaje | por_visita), usuarioId, montoVisita, pctMostrador (esquema por visita),
//     orgId, createdAt, updatedAt }
//   sueldos_liquidaciones : { empleadoId, empleadoNombre, sector, periodo
//     ('AAAA-MM'), sueldo, adicionales, comisiones (+ comisionPct, comisionBase),
//     aguinaldo, cargasSociales, descuentos,
//     adelantosDescontados, observaciones, bruto, costoEmpresa, neto,
//     pagos: [{ monto, fecha, cuentaTipo, cuentaId, nota, usuarioNombre }],
//     totalPagado, estado (pendiente|parcial|pagada), orgId, ... }
//   sueldos_adelantos : { empleadoId, empleadoNombre, monto, fecha, nota,
//     cuentaTipo, cuentaId, estado (pendiente|descontado), liquidacionId, orgId }
//
// Comisiones por ventas (7/10/2026): cada vendedor (Configuración > Vendedores) tiene
// un % de comisión. Si el empleado está vinculado a un vendedor, la liquidación
// calcula la comisión del mes = % x ventas del vendedor en el mes (valor CON IVA,
// en pesos, las notas de crédito restan, sin anuladas; se atribuyen por el usuario
// vinculado al vendedor, igual que en el tablero). Es devengada: cuenta por fecha
// de venta, se cobre o no. El monto queda editable en la liquidación.
//
// Cuentas:
//   bruto = sueldo + adicionales + comisiones + aguinaldo
//   costo para la empresa = bruto + cargas sociales
//   neto a pagar al empleado = bruto - descuentos - adelantos descontados
//   (los descuentos son aportes y retenciones: ya están dentro del bruto, o sea
//   del costo; solo bajan lo que se le deposita al empleado).
// Los adelantos pendientes del empleado se descuentan solos al cargar su
// liquidación, del más viejo al más nuevo, mientras no hagan pasar el neto de 0.
//
// Pagos: salen de una caja/banco en pesos de Tesorería (egreso, origen
// 'sueldo'). El pago de cargas sociales y aportes a ARCA se sigue cargando en
// Gastos; ese concepto hay que marcarlo en el Estado de resultados como
// "ya contado" para que no se reste dos veces (el costo ya viene de acá).
//
// Estado de resultados (informes.js): el costo de empresa de cada liquidación
// entra por período; el sector Producción se muestra como "ya incluido en el
// costo de los productos" y el resto como gasto "Sueldos y cargas · <sector>".
//
// Módulo con clave propia ('sueldos'), datos por organización.
// Integración (server.js):  app.use('/api/sueldos', require('./sueldos'));
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx } = require('./importExport');
const tesoreria = require('./tesoreria');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(
        () => { mongoClient = nuevo; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try { return await fn(); }
  catch (e) { if (e && e.status) throw e; mongoClient = null; return await fn(); }
}
function toObjectId(id) { try { return id ? new ObjectId(String(id)) : null; } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function responder(res, e) { res.status(e.status || 500).json({ error: e.message || 'Error' }); }
function r2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }
function texto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

const authSueldos = [authUsuario, resolverOrg, requiereModulo('sueldos'), (req, res, next) => {
  if (!req.orgId) return res.status(400).json({ error: 'Elegí con qué sucursal estás trabajando.' });
  next();
}];

const SECTORES = { obra: 'Obra', produccion: 'Producción', administracion: 'Administración', ventas: 'Ventas', logistica: 'Logística', otro: 'Otros' };
// Frecuencia de pago: el sueldo se liquida igual una vez por mes, pero se paga en cuotas.
const FRECUENCIAS = { semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };
const CUOTAS = { semanal: 4, quincenal: 2, mensual: 1 };
// Cómo cobra las comisiones quien no cobra por mes: sumadas a cada pago o todas juntas al cierre del mes.
// Tipo de comisión: % de las ventas del vendedor vinculado, o esquema por visita (ver calcularComisionVisitas).
const COMISION_TIPO = { porcentaje: 'Porcentaje de ventas', por_visita: 'Por visita + ventas de mostrador' };
const COMISION_PAGO = { fin_de_mes: 'Todas juntas, un solo día', con_sueldo: 'Se suman a cada pago' };

function monto(v, etiqueta) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, etiqueta + ' tiene que ser un número mayor o igual a 0.');
  return r2(n);
}
function validarPeriodo(p) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ''))) throw err(400, 'El período tiene que ser AAAA-MM.');
  return p;
}
function periodoActual() {
  const x = new Date(Date.now() - 3 * 3600e3);
  return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0');
}
function finPeriodo(p) {
  const [y, m] = p.split('-').map(Number);
  const dia = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(p + '-' + String(dia).padStart(2, '0') + 'T23:59:59.999-03:00');
}
function fechaDe(s) {
  if (!s) return new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) { const d = new Date(s + 'T12:00:00.000-03:00'); if (!isNaN(d.getTime())) return d; }
  throw err(400, 'La fecha tiene que ser AAAA-MM-DD.');
}
function estadoPago(l) {
  const neto = l.neto || 0, pagado = l.totalPagado || 0;
  if (pagado <= 0 && neto > 0) return 'pendiente';
  return pagado + 0.005 >= neto ? 'pagada' : 'parcial';
}
function calcular(l) {
  l.bruto = r2(l.sueldo + l.adicionales + (l.comisiones || 0) + l.aguinaldo);
  l.costoEmpresa = r2(l.bruto + l.cargasSociales);
  l.neto = r2(l.bruto - l.descuentos - (l.adelantosDescontados || 0));
  l.estado = estadoPago(l);
  return l;
}

// ---------------------------------------------------------------------------
// Cuentas de Tesorería habilitadas (para elegir de dónde sale el pago)
// ---------------------------------------------------------------------------
router.get('/cuentas', authSueldos, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const [cajas, bancos] = await Promise.all([db.collection('tesoreria_cajas').find({}).sort({ nombre: 1 }).toArray(), db.collection('tesoreria_bancos').find({}).sort({ nombre: 1 }).toArray()]);
      const ok = c => (c.moneda || 'ARS') === 'ARS' && tesoreria.cuentaHabilitada(c, req);
      return {
        cajas: cajas.filter(ok).map(c => ({ _id: String(c._id), nombre: c.nombre })),
        bancos: bancos.filter(ok).map(c => ({ _id: String(c._id), nombre: c.nombre }))
      };
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

async function egresoDeCuenta(db, req, { cuentaTipo, cuentaId, monto: m, motivo, observaciones, origen, fecha, tipo }) {
  const id = toObjectId(cuentaId);
  if (!['caja', 'banco'].includes(cuentaTipo) || !id) throw err(400, 'Elegí la caja o el banco de donde sale el pago.');
  const cuenta = await db.collection(cuentaTipo === 'caja' ? 'tesoreria_cajas' : 'tesoreria_bancos').findOne({ _id: id });
  if (!cuenta) throw err(404, 'No se encontró la caja o el banco elegido.');
  if ((cuenta.moneda || 'ARS') !== 'ARS') throw err(400, 'Los sueldos se pagan desde una caja o banco en pesos.');
  return tesoreria.aplicarMovimientoCuenta(db, req, { cuentaTipo, cuentaId: id, tipo: tipo || 'egreso', monto: m, moneda: 'ARS', motivo, observaciones, origen, fecha });
}

// Usuarios del sistema (para vincular a la persona que carga visitas y ventas).
router.get('/usuarios', authSueldos, async (req, res) => {
  try {
    const lista = await conReintento(async () => (await getDb()).collection('usuarios').find(Object.assign({ activo: { $ne: false } }, req.orgId ? { $or: [{ orgIds: req.orgId }, { orgIds: { $exists: false } }] } : {})).project({ nombre: 1 }).sort({ nombre: 1 }).toArray());
    res.json(lista.map(u => ({ _id: String(u._id), nombre: u.nombre })));
  } catch (e) { responder(res, e); }
});

router.get('/vendedores', authSueldos, async (req, res) => {
  try {
    const lista = await conReintento(async () => (await getDb()).collection('visitas_vendedores').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ nombre: 1, comisionPct: 1 }).sort({ nombre: 1 }).toArray());
    res.json(lista.map(v => ({ _id: String(v._id), nombre: v.nombre, comisionPct: v.comisionPct || 0 })));
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Empleados (legajo)
// ---------------------------------------------------------------------------
function datosEmpleado(b) {
  const nombre = texto(b.nombre);
  if (!nombre) throw err(400, 'El nombre es obligatorio.');
  const sector = texto(b.sector) || 'otro';
  if (!SECTORES[sector]) throw err(400, 'Sector inválido.');
  let fechaIngreso = null;
  if (b.fechaIngreso) fechaIngreso = fechaDe(b.fechaIngreso);
  const vendedorId = b.vendedorId ? toObjectId(b.vendedorId) : null;
  if (b.vendedorId && !vendedorId) throw err(400, 'vendedorId inválido');
  const comisionTipo = texto(b.comisionTipo) || 'porcentaje';
  if (!COMISION_TIPO[comisionTipo]) throw err(400, 'Tipo de comisión inválido.');
  const usuarioId = b.usuarioId ? toObjectId(b.usuarioId) : null;
  if (b.usuarioId && !usuarioId) throw err(400, 'usuarioId inválido');
  const montoVisita = monto(b.montoVisita, 'El monto por visita'), pctMostrador = monto(b.pctMostrador, 'El % de ventas de mostrador');
  if (pctMostrador > 100) throw err(400, 'El % de ventas de mostrador no puede pasar de 100.');
  if (comisionTipo === 'por_visita' && !usuarioId) throw err(400, 'Elegí el usuario que carga las visitas y las ventas de esta persona.');
  const frecuencia = texto(b.frecuencia) || 'mensual';
  if (!FRECUENCIAS[frecuencia]) throw err(400, 'Frecuencia de pago inválida.');
  const comisionPago = texto(b.comisionPago) || 'fin_de_mes';
  if (!COMISION_PAGO[comisionPago]) throw err(400, 'Modo de pago de comisiones inválido.');
  return { nombre, cuil: texto(b.cuil), vendedorId, sector, sueldoBasico: monto(b.sueldoBasico, 'El sueldo básico'), fechaIngreso, notas: texto(b.notas), frecuencia, comisionPago, comisionTipo, usuarioId: comisionTipo === 'por_visita' ? usuarioId : null, montoVisita, pctMostrador };
}
router.get('/empleados', authSueldos, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.todos !== '1') match.activo = { $ne: false };
    const lista = await conReintento(async () => (await getDb()).collection('empleados').find(match).sort({ nombre: 1 }).toArray());
    res.json(lista);
  } catch (e) { responder(res, e); }
});
router.post('/empleados', authSueldos, async (req, res) => {
  try {
    const doc = Object.assign(datosEmpleado(req.body || {}), { activo: true, orgId: req.orgId, createdAt: new Date(), updatedAt: new Date() });
    const r = await conReintento(async () => (await getDb()).collection('empleados').insertOne(doc));
    res.json(Object.assign(doc, { _id: r.insertedId }));
  } catch (e) { responder(res, e); }
});
router.put('/empleados/:id', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    const set = Object.assign(datosEmpleado(req.body || {}), { updatedAt: new Date() });
    if (req.body && req.body.activo !== undefined) set.activo = !!req.body.activo;
    const r = await conReintento(async () => (await getDb()).collection('empleados').updateOne(Object.assign({ _id: id }, filtroOrg(req)), { $set: set }));
    if (!r.matchedCount) throw err(404, 'Empleado no encontrado.');
    res.json({ ok: true });
  } catch (e) { responder(res, e); }
});
router.delete('/empleados/:id', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    const r = await conReintento(async () => (await getDb()).collection('empleados').updateOne(Object.assign({ _id: id }, filtroOrg(req)), { $set: { activo: false, updatedAt: new Date() } }));
    if (!r.matchedCount) throw err(404, 'Empleado no encontrado.');
    res.json({ ok: true });
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Comisión por ventas del mes de un empleado vinculado a un vendedor
// ---------------------------------------------------------------------------
function inicioMes(p) { return new Date(p + '-01T00:00:00.000-03:00'); }
// Base de comisión: total de la venta CON IVA, en pesos (la nota de crédito resta).
function netoVenta(v) {
  const nc = v.tipoComprobante === 'nota_credito' ? -1 : 1;
  const usd = v.moneda === 'USD' ? (Number(v.cotizacionDolar) || 1) : 1;
  return Number(v.total || 0) * usd * nc;
}
// desde/hasta (opcionales): ventana de fechas distinta del mes completo (pagos semanales con comisión).
async function calcularComision(db, req, emp, periodo, desde, hasta, sueldoBase) {
  if (emp && emp.comisionTipo === 'por_visita') return calcularComisionVisitas(db, req, emp, periodo, hasta, sueldoBase === undefined ? emp.sueldoBasico : sueldoBase);
  if (!emp || !emp.vendedorId) return { vinculado: false, pct: 0, base: 0, monto: 0, ventas: 0, notasCredito: 0, avisos: [] };
  const vend = await db.collection('visitas_vendedores').findOne({ _id: emp.vendedorId });
  const pct = vend && Number(vend.comisionPct) > 0 ? Number(vend.comisionPct) : 0;
  const avisos = [];
  if (!vend) avisos.push('El vendedor vinculado ya no existe.');
  else if (!pct) avisos.push('El vendedor ' + vend.nombre + ' no tiene un % de comisión cargado (Configuración > Vendedores).');
  const usuarios = await db.collection('usuarios').find({ vendedorId: emp.vendedorId }).project({ nombre: 1 }).toArray();
  if (!usuarios.length) avisos.push('El vendedor no tiene un usuario vinculado, así que no se le pueden atribuir ventas. Vinculalo en Configuración > Usuarios > Editar > "Vendedor vinculado".');
  let base = 0, ventas = 0, nc = 0;
  if (usuarios.length) {
    const d0 = desde || inicioMes(periodo), d1 = hasta || finPeriodo(periodo);
    // Con ventana propia, "desde" es el corte del pago anterior: no se cuenta dos veces.
    const lista = await db.collection('ventas').find({
      orgId: req.orgId, estado: { $ne: 'anulada' }, fecha: desde ? { $gt: d0, $lte: d1 } : { $gte: d0, $lte: d1 },
      $or: [{ usuarioId: { $in: usuarios.map(u => u._id) } }, { usuarioId: { $exists: false }, usuarioNombre: { $in: usuarios.map(u => u.nombre) } }]
    }).project({ total: 1, moneda: 1, cotizacionDolar: 1, tipoComprobante: 1, esFiscal: 1, cae: 1, fiscal: 1, fiscalMoneda: 1, fiscalCotiz: 1 }).toArray();
    lista.forEach(v => { base += netoVenta(v); if (v.tipoComprobante === 'nota_credito') nc++; else ventas++; });
  }
  base = Math.max(0, r2(base));
  return { vinculado: true, vendedor: vend ? vend.nombre : '', pct, base, monto: r2(base * pct / 100), ventas, notasCredito: nc, avisos };
}
// Esquema por visita (la empleada que carga las visitas):
//   variable = visitas hechas x monto + visitas vendidas x (2 x monto) + % x ventas de mostrador que cargó
//   cobra el mayor entre el variable y el básico: la liquidación lleva el básico como sueldo y la
//   comisión es solo lo que el variable pasa del básico.
// Visita hecha = estado presupuestada, vendido o instalado (vendida = vendido o instalado), por la fecha
// de la visita, cargada por su usuario (visitas.creadaPor). Ventas de mostrador = ventas del período cuyo
// "Vendedor" es ella (si carga una venta con otro vendedor, no suma; sin vendedor anotado cuenta quien la
// cargó). Total con IVA en pesos, las notas de crédito restan, sin anuladas.
async function calcularComisionVisitas(db, req, emp, periodo, hasta, sueldoBase) {
  const avisos = [], M = Number(emp.montoVisita) || 0, pct = Number(emp.pctMostrador) || 0;
  const usr = emp.usuarioId ? await db.collection('usuarios').findOne({ _id: emp.usuarioId }, { projection: { nombre: 1 } }) : null;
  if (!usr) avisos.push('El usuario vinculado ya no existe o no está elegido (solapa Empleados).');
  if (!M && !pct) avisos.push('No tiene cargado el monto por visita ni el % de ventas de mostrador (solapa Empleados).');
  const d0 = inicioMes(periodo), d1 = hasta || finPeriodo(periodo);
  let hechas = 0, vendidas = 0, base = 0, ventas = 0, nc = 0;
  if (usr) {
    const vis = await db.collection('visitas').find({ orgId: req.orgId, 'creadaPor.usuarioId': usr._id, fechaHora: { $gte: d0, $lte: d1 }, estado: { $in: ['presupuestada', 'vendido', 'instalado'] } }).project({ estado: 1 }).toArray();
    hechas = vis.length; vendidas = vis.filter(v => v.estado === 'vendido' || v.estado === 'instalado').length;
    const lista = await db.collection('ventas').find({
      orgId: req.orgId, estado: { $ne: 'anulada' }, fecha: { $gte: d0, $lte: d1 },
      // Cuenta la venta cuyo "Vendedor" es ella. Una venta que ella carga con otro vendedor no suma;
      // una venta sin vendedor anotado se le atribuye a quien la cargó.
      $or: [{ vendedor: new RegExp('^\\s*' + usr.nombre.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i') },
        { $and: [{ $or: [{ vendedor: { $exists: false } }, { vendedor: '' }, { vendedor: null }] }, { $or: [{ usuarioId: usr._id }, { usuarioId: { $exists: false }, usuarioNombre: usr.nombre }] }] }]
    }).project({ total: 1, moneda: 1, cotizacionDolar: 1, tipoComprobante: 1 }).toArray();
    lista.forEach(v => { base += netoVenta(v); if (v.tipoComprobante === 'nota_credito') nc++; else ventas++; });
  }
  base = Math.max(0, r2(base));
  const porVisitas = r2(hechas * M + vendidas * 2 * M), porMostrador = r2(base * pct / 100), variable = r2(porVisitas + porMostrador);
  const basico = r2(sueldoBase || 0);
  return { vinculado: true, tipo: 'por_visita', vendedor: usr ? usr.nombre : '', pct, base, monto: Math.max(0, r2(variable - basico)), variable, basico, montoVisita: M,
    visitas: hechas, visitasVendidas: vendidas, porVisitas, porMostrador, ventas, notasCredito: nc, avisos };
}
router.get('/comision', authSueldos, async (req, res) => {
  try {
    const periodo = validarPeriodo(req.query.periodo);
    const empId = toObjectId(req.query.empleadoId); if (!empId) throw err(400, 'Elegí el empleado.');
    const out = await conReintento(async () => {
      const db = await getDb();
      const emp = await db.collection('empleados').findOne(Object.assign({ _id: empId }, filtroOrg(req)));
      if (!emp) throw err(404, 'Empleado no encontrado.');
      return calcularComision(db, req, emp, periodo);
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Liquidaciones mensuales
// ---------------------------------------------------------------------------
async function liberarAdelantos(db, liquidacionId) {
  await db.collection('sueldos_adelantos').updateMany({ liquidacionId }, { $set: { estado: 'pendiente', liquidacionId: null } });
}
// Aplica adelantos pendientes del empleado (más viejos primero) sin pasar el neto de 0.
async function aplicarAdelantos(db, orgId, liq, piso) {
  const pend = await db.collection('sueldos_adelantos').find({ orgId, empleadoId: liq.empleadoId, estado: 'pendiente', fecha: { $lte: finPeriodo(liq.periodo) } }).sort({ fecha: 1 }).toArray();
  let disponible = liq.sueldo + liq.adicionales + (liq.comisiones || 0) + liq.aguinaldo - liq.descuentos - (piso || 0), total = 0;
  for (const a of pend) {
    if (a.monto > disponible + 0.005) break;
    disponible -= a.monto; total += a.monto;
    await db.collection('sueldos_adelantos').updateOne({ _id: a._id }, { $set: { estado: 'descontado', liquidacionId: liq._id } });
  }
  return r2(total);
}

async function guardarLiquidacion(db, req, b, emp) {
  const periodo = validarPeriodo(b.periodo);
  const datos = {
    sueldo: monto(b.sueldo, 'El sueldo'), adicionales: monto(b.adicionales, 'Los adicionales'), comisiones: monto(b.comisiones, 'Las comisiones'),
    comisionPct: monto(b.comisionPct, 'El % de comisión'), comisionBase: monto(b.comisionBase, 'La base de comisión'), aguinaldo: monto(b.aguinaldo, 'El aguinaldo'),
    cargasSociales: monto(b.cargasSociales, 'Las cargas sociales'), descuentos: monto(b.descuentos, 'Los descuentos'), observaciones: texto(b.observaciones)
  };
  if (datos.descuentos > datos.sueldo + datos.adicionales + datos.comisiones + datos.aguinaldo + 0.005) throw err(400, 'Los descuentos no pueden superar el bruto (sueldo + adicionales + comisiones + aguinaldo).');
  const col = db.collection('sueldos_liquidaciones');
  const existente = await col.findOne({ orgId: req.orgId, empleadoId: emp._id, periodo });
  const base = Object.assign({ empleadoId: emp._id, empleadoNombre: emp.nombre, sector: emp.sector, periodo, adelantosDescontados: 0 }, datos);
  if (existente) {
    const pagado = existente.totalPagado || 0;
    if (datos.sueldo + datos.adicionales + datos.comisiones + datos.aguinaldo - datos.descuentos + 0.005 < pagado) throw err(400, 'El neto no puede quedar por debajo de lo que ya se pagó (' + r2(pagado) + ').');
    await liberarAdelantos(db, existente._id);
    const liq = Object.assign({}, existente, base, { _id: existente._id });
    liq.adelantosDescontados = await aplicarAdelantos(db, req.orgId, liq, pagado);
    calcular(liq);
    liq.updatedAt = new Date();
    const { _id: _omitido, ...resto } = liq;
    await col.updateOne({ _id: existente._id }, { $set: resto });
    return liq;
  }
  const liq = Object.assign(base, { pagos: [], totalPagado: 0, orgId: req.orgId, createdAt: new Date(), updatedAt: new Date() });
  const ins = await col.insertOne(liq);
  liq._id = ins.insertedId;
  liq.adelantosDescontados = await aplicarAdelantos(db, req.orgId, liq);
  calcular(liq);
  await col.updateOne({ _id: liq._id }, { $set: { adelantosDescontados: liq.adelantosDescontados, bruto: liq.bruto, costoEmpresa: liq.costoEmpresa, neto: liq.neto, estado: liq.estado } });
  return liq;
}

function resumir(liqs) {
  const s = { empleados: liqs.length, bruto: 0, cargasSociales: 0, costoEmpresa: 0, neto: 0, pagado: 0, saldo: 0, porSector: {} };
  liqs.forEach(l => {
    s.bruto += l.bruto; s.cargasSociales += l.cargasSociales; s.costoEmpresa += l.costoEmpresa; s.neto += l.neto; s.pagado += l.totalPagado || 0;
    s.saldo += Math.max(0, l.neto - (l.totalPagado || 0));
    s.porSector[l.sector] = r2((s.porSector[l.sector] || 0) + l.costoEmpresa);
  });
  ['bruto', 'cargasSociales', 'costoEmpresa', 'neto', 'pagado', 'saldo'].forEach(k => { s[k] = r2(s[k]); });
  return s;
}

router.get('/liquidaciones', authSueldos, async (req, res) => {
  try {
    const periodo = validarPeriodo(req.query.periodo || periodoActual());
    const out = await conReintento(async () => {
      const db = await getDb();
      const org = filtroOrg(req);
      const [empleados, liqs, pend] = await Promise.all([
        db.collection('empleados').find(Object.assign({ activo: { $ne: false } }, org)).sort({ nombre: 1 }).toArray(),
        db.collection('sueldos_liquidaciones').find(Object.assign({ periodo }, org)).sort({ empleadoNombre: 1 }).toArray(),
        db.collection('sueldos_adelantos').aggregate([{ $match: Object.assign({ estado: 'pendiente' }, org) }, { $group: { _id: '$empleadoId', total: { $sum: '$monto' } } }]).toArray()
      ]);
      const conLiq = new Set(liqs.map(l => String(l.empleadoId)));
      return {
        periodo, liquidaciones: liqs, resumen: resumir(liqs),
        sinCargar: empleados.filter(e => !conLiq.has(String(e._id))),
        adelantosPendientes: Object.fromEntries(pend.map(p => [String(p._id), r2(p.total)]))
      };
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

router.post('/liquidaciones', authSueldos, async (req, res) => {
  try {
    const b = req.body || {};
    const empId = toObjectId(b.empleadoId); if (!empId) throw err(400, 'Elegí el empleado.');
    const liq = await conReintento(async () => {
      const db = await getDb();
      const emp = await db.collection('empleados').findOne(Object.assign({ _id: empId }, filtroOrg(req)));
      if (!emp) throw err(404, 'Empleado no encontrado.');
      return guardarLiquidacion(db, req, b, emp);
    });
    res.json(liq);
  } catch (e) { responder(res, e); }
});

// Copia el mes anterior para los empleados que todavía no tienen liquidación en este período.
router.post('/liquidaciones/copiar', authSueldos, async (req, res) => {
  try {
    const periodo = validarPeriodo((req.body || {}).periodo);
    const n = await conReintento(async () => {
      const db = await getDb(); const org = filtroOrg(req);
      const [empleados, existentes] = await Promise.all([
        db.collection('empleados').find(Object.assign({ activo: { $ne: false } }, org)).toArray(),
        db.collection('sueldos_liquidaciones').find(Object.assign({ periodo }, org)).project({ empleadoId: 1 }).toArray()
      ]);
      const tiene = new Set(existentes.map(l => String(l.empleadoId)));
      let creadas = 0;
      for (const emp of empleados) {
        if (tiene.has(String(emp._id))) continue;
        const prev = await db.collection('sueldos_liquidaciones').find({ orgId: req.orgId, empleadoId: emp._id, periodo: { $lt: periodo } }).sort({ periodo: -1 }).limit(1).toArray();
        const p = prev[0];
        const com = await calcularComision(db, req, emp, periodo, undefined, undefined, p ? p.sueldo : emp.sueldoBasico); // la comisión no se copia: se recalcula con las ventas del mes
        // Quien cobra la comisión sumada a cada pago la va devengando con cada pago: arranca el mes en 0.
        const conPagos = emp.frecuencia && emp.frecuencia !== 'mensual' && emp.comisionPago === 'con_sueldo';
        const c = conPagos ? { comisiones: 0, comisionPct: com.pct, comisionBase: 0 } : { comisiones: com.monto, comisionPct: com.pct, comisionBase: com.base };
        await guardarLiquidacion(db, req, p
          ? Object.assign({ periodo, sueldo: p.sueldo, adicionales: p.adicionales, aguinaldo: 0, cargasSociales: p.cargasSociales, descuentos: p.descuentos }, c)
          : Object.assign({ periodo, sueldo: emp.sueldoBasico }, c), emp);
        creadas++;
      }
      return creadas;
    });
    res.json({ creadas: n });
  } catch (e) { responder(res, e); }
});

router.delete('/liquidaciones/:id', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const liq = await db.collection('sueldos_liquidaciones').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!liq) throw err(404, 'Liquidación no encontrada.');
      if ((liq.totalPagado || 0) > 0) throw err(400, 'Esta liquidación ya tiene pagos registrados, no se puede borrar.');
      await liberarAdelantos(db, id);
      await db.collection('sueldos_liquidaciones').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { responder(res, e); }
});

// Registra un pago (egreso de Tesorería + renglón en la liquidación). montoComision: la parte del pago
// que corresponde a comisiones (el resto es sueldo), para llevar por separado lo pagado de cada cosa.
async function registrarPago(db, req, l, { monto: m, montoComision, fecha, cuentaTipo, cuentaId, nota }) {
  const saldo = r2(l.neto - (l.totalPagado || 0));
  if (m > saldo + 0.005) throw err(400, 'El monto supera lo que falta pagar (' + saldo + ').');
  const dd = fecha.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
  await egresoDeCuenta(db, req, { cuentaTipo, cuentaId, monto: m, motivo: 'Sueldo ' + l.empleadoNombre + ' ' + l.periodo + (l.frecuenciaPago && l.frecuenciaPago !== 'mensual' ? ' · pago del ' + dd : ''), observaciones: nota, origen: 'sueldo', fecha });
  const pago = { monto: m, fecha, cuentaTipo, cuentaId: toObjectId(cuentaId), nota, usuarioNombre: (req.usuario && req.usuario.nombre) || '' };
  if (montoComision > 0) pago.montoComision = r2(montoComision);
  l.pagos = (l.pagos || []).concat([pago]);
  l.totalPagado = r2((l.totalPagado || 0) + m);
  l.estado = estadoPago(l);
  await db.collection('sueldos_liquidaciones').updateOne({ _id: l._id }, { $set: { pagos: l.pagos, totalPagado: l.totalPagado, estado: l.estado, updatedAt: new Date() } });
  return l;
}

// ---------------------------------------------------------------------------
// Pagos del período: qué le toca cobrar a cada uno en una fecha, según su frecuencia.
//  - Sueldo: la parte fija del neto se paga en cuotas (semanal 4, quincenal 2, mensual 1). En el último
//    pago del mes se paga todo lo que falte, así que una quinta semana o el redondeo no dejan saldo suelto.
//  - Comisiones: mensual -> todo junto con el sueldo. Semanal/quincenal "se suma a cada pago" -> se suma la
//    comisión de las ventas desde el pago anterior hasta la fecha. "Todas juntas" -> se sugiere recién en
//    el último pago del mes, con la comisión que ya tiene la liquidación.
// ---------------------------------------------------------------------------
function ultimoPagoDelMes(freq, periodo, fecha) {
  const mes = fecha.slice(0, 7);
  if (mes > periodo) return true;
  if (mes < periodo) return false;
  const [y, m, d] = fecha.split('-').map(Number);
  const dias = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (freq === 'semanal') return d + 7 > dias;
  if (freq === 'quincenal') return d >= 16;
  return true;
}
function hoyAR() { return new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); }

async function armarPagos(db, req, periodo, fechaISO) {
  fechaDe(fechaISO); // valida el formato
  const org = filtroOrg(req);
  const [empleados, liqs] = await Promise.all([
    db.collection('empleados').find(Object.assign({ activo: { $ne: false } }, org)).sort({ nombre: 1 }).toArray(),
    db.collection('sueldos_liquidaciones').find(Object.assign({ periodo }, org)).toArray()
  ]);
  const porEmp = new Map(liqs.map(l => [String(l.empleadoId), l]));
  const finDia = new Date(fechaISO + 'T23:59:59.999-03:00');
  const filas = [];
  for (const emp of empleados) {
    const freq = emp.frecuencia || 'mensual', modo = emp.comisionPago || 'fin_de_mes';
    const f = { empleadoId: String(emp._id), nombre: emp.nombre, sector: emp.sector, frecuencia: freq, comisionPago: modo, sinLiquidacion: false };
    const l = porEmp.get(String(emp._id));
    if (!l) { f.sinLiquidacion = true; filas.push(f); continue; }
    const saldo = Math.max(0, r2(l.neto - (l.totalPagado || 0)));
    const pagos = l.pagos || [];
    const comPag = pagos.reduce((s, p) => s + (p.montoComision || 0), 0);
    const fijoPag = pagos.reduce((s, p) => s + p.monto - (p.montoComision || 0), 0);
    const fijoTotal = Math.max(0, r2(l.neto - (l.comisiones || 0)));
    const comTotal = r2(l.neto - fijoTotal);
    const fijoSaldo = Math.min(Math.max(0, r2(fijoTotal - fijoPag)), saldo);
    const comSaldo = Math.min(Math.max(0, r2(comTotal - comPag)), r2(saldo - fijoSaldo));
    const ultimo = ultimoPagoDelMes(freq, periodo, fechaISO);
    let comNueva = 0, comBase = 0, comHasta = null, avisos = [];
    if (freq !== 'mensual' && modo === 'con_sueldo' && emp.comisionTipo === 'por_visita') {
      // Esquema por visita: acumulado del mes hasta la fecha menos lo ya devengado (así el piso del básico se respeta).
      const tope = finPeriodo(periodo), hasta = finDia < tope ? finDia : tope;
      const c = await calcularComisionVisitas(db, req, emp, periodo, hasta, l.sueldo);
      comNueva = Math.max(0, r2(c.monto - (l.comisiones || 0))); comBase = 0; comHasta = hasta; avisos = c.avisos;
    } else if (freq !== 'mensual' && modo === 'con_sueldo' && emp.vendedorId) {
      const desde = l.comisionHasta ? new Date(l.comisionHasta) : null;
      const tope = finPeriodo(periodo);
      const hasta = finDia < tope ? finDia : tope;
      if (!desde || desde < hasta) {
        const c = await calcularComision(db, req, emp, periodo, desde, hasta);
        comNueva = c.monto; comBase = c.base; comHasta = hasta; avisos = c.avisos;
      }
    }
    const cuota = freq === 'mensual' || ultimo ? fijoSaldo : Math.min(fijoSaldo, r2(fijoTotal / CUOTAS[freq]));
    let comSug = 0;
    if (freq === 'mensual') comSug = comSaldo;
    else if (modo === 'con_sueldo') comSug = r2(comSaldo + comNueva);
    else comSug = ultimo ? comSaldo : 0;
    Object.assign(f, {
      liquidacionId: String(l._id), neto: l.neto, totalPagado: l.totalPagado || 0, saldo,
      fijoSaldo, sugeridoFijo: r2(cuota), comisionDisponible: freq !== 'mensual' && modo === 'con_sueldo' ? r2(comSaldo + comNueva) : comSaldo,
      sugeridaComision: r2(comSug), comisionNueva: comNueva, ultimoPago: ultimo, avisos,
      saldado: saldo <= 0.005
    });
    f._interno = { comBase, comHasta };
    filas.push(f);
  }
  return filas;
}

router.get('/pagos-periodo', authSueldos, async (req, res) => {
  try {
    const periodo = validarPeriodo(req.query.periodo || periodoActual());
    const fecha = req.query.fecha || hoyAR();
    const filas = await conReintento(async () => armarPagos(await getDb(), req, periodo, fecha));
    filas.forEach(f => { delete f._interno; });
    res.json({ periodo, fecha, filas });
  } catch (e) { responder(res, e); }
});

// Paga a varios empleados juntos, desde la misma caja o banco. Cada uno es un egreso aparte.
router.post('/pagar-lote', authSueldos, async (req, res) => {
  try {
    const b = req.body || {};
    const periodo = validarPeriodo(b.periodo);
    const fechaISO = b.fecha || hoyAR();
    const fecha = fechaDe(fechaISO);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw err(400, 'No elegiste a nadie para pagar.');
    const out = await conReintento(async () => {
      const db = await getDb();
      const filas = await armarPagos(db, req, periodo, fechaISO);
      const resultados = [];
      for (const it of items) {
        const f = filas.find(x => x.empleadoId === String(it.empleadoId));
        const nombre = f ? f.nombre : String(it.empleadoId);
        try {
          if (!f || f.sinLiquidacion) throw err(400, 'No tiene liquidación en ' + periodo + '.');
          const fijo = monto(it.fijo, 'El sueldo'), com = monto(it.comision, 'La comisión');
          if (fijo > f.fijoSaldo + 0.005) throw err(400, 'El sueldo supera lo que falta pagar (' + f.fijoSaldo + ').');
          if (com > f.comisionDisponible + 0.005) throw err(400, 'La comisión supera lo disponible (' + f.comisionDisponible + ').');
          const total = r2(fijo + com);
          if (!(total > 0)) throw err(400, 'El monto tiene que ser mayor a 0.');
          const col = db.collection('sueldos_liquidaciones');
          let l = await col.findOne({ _id: toObjectId(f.liquidacionId) });
          // Comisión nueva (ventas desde el pago anterior): pasa a la liquidación aunque se pague de menos;
          // lo que no se pague queda como saldo de comisión para el próximo pago.
          if (f.comisionNueva > 0) {
            l.comisiones = r2((l.comisiones || 0) + f.comisionNueva);
            l.comisionBase = r2((l.comisionBase || 0) + f._interno.comBase);
            l.comisionHasta = f._interno.comHasta;
            calcular(l);
            await col.updateOne({ _id: l._id }, { $set: { comisiones: l.comisiones, comisionBase: l.comisionBase, comisionHasta: l.comisionHasta, bruto: l.bruto, costoEmpresa: l.costoEmpresa, neto: l.neto, estado: l.estado, updatedAt: new Date() } });
          } else if (f._interno && f._interno.comHasta && f.frecuencia !== 'mensual') {
            await col.updateOne({ _id: l._id }, { $set: { comisionHasta: f._interno.comHasta } });
          }
          l.frecuenciaPago = f.frecuencia;
          await registrarPago(db, req, l, { monto: total, montoComision: com, fecha, cuentaTipo: b.cuentaTipo, cuentaId: b.cuentaId, nota: texto(b.nota) });
          resultados.push({ empleadoId: f.empleadoId, nombre, ok: true, monto: total });
        } catch (e) {
          if (!e.status) throw e;
          resultados.push({ empleadoId: String(it.empleadoId), nombre, ok: false, error: e.message });
        }
      }
      return resultados;
    });
    res.json({ resultados: out, pagados: out.filter(r => r.ok).length, total: r2(out.filter(r => r.ok).reduce((s, r) => s + r.monto, 0)) });
  } catch (e) { responder(res, e); }
});

router.post('/liquidaciones/:id/pagos', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const m = monto(b.monto, 'El monto');
    if (!(m > 0)) throw err(400, 'El monto tiene que ser mayor a 0.');
    const fecha = fechaDe(b.fecha), nota = texto(b.nota);
    const liq = await conReintento(async () => {
      const db = await getDb();
      const l = await db.collection('sueldos_liquidaciones').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!l) throw err(404, 'Liquidación no encontrada.');
      return registrarPago(db, req, l, { monto: m, fecha, cuentaTipo: b.cuentaTipo, cuentaId: b.cuentaId, nota });
    });
    res.json(liq);
  } catch (e) { responder(res, e); }
});

router.get('/liquidaciones/export', authSueldos, async (req, res) => {
  try {
    const periodo = validarPeriodo(req.query.periodo || periodoActual());
    const liqs = await conReintento(async () => (await getDb()).collection('sueldos_liquidaciones').find(Object.assign({ periodo }, filtroOrg(req))).sort({ empleadoNombre: 1 }).toArray());
    const filas = liqs.map(l => ({ empleado: l.empleadoNombre, sector: SECTORES[l.sector] || l.sector, sueldo: l.sueldo, adicionales: l.adicionales, comisiones: l.comisiones || 0, aguinaldo: l.aguinaldo, cargas: l.cargasSociales,
      costo: l.costoEmpresa, descuentos: l.descuentos, adelantos: l.adelantosDescontados, neto: l.neto, pagado: l.totalPagado || 0, saldo: r2(l.neto - (l.totalPagado || 0)), estado: l.estado }));
    const t = resumir(liqs);
    filas.push({ empleado: 'TOTAL', costo: t.costoEmpresa, cargas: t.cargasSociales, neto: t.neto, pagado: t.pagado, saldo: t.saldo });
    exportarXlsx(res, 'sueldos-' + periodo + '.xlsx', [
      { clave: 'empleado', titulo: 'Empleado' }, { clave: 'sector', titulo: 'Sector' }, { clave: 'sueldo', titulo: 'Sueldo', tipo: 'numero' }, { clave: 'adicionales', titulo: 'Adicionales', tipo: 'numero' }, { clave: 'comisiones', titulo: 'Comisiones', tipo: 'numero' },
      { clave: 'aguinaldo', titulo: 'Aguinaldo', tipo: 'numero' }, { clave: 'cargas', titulo: 'Cargas sociales', tipo: 'numero' }, { clave: 'costo', titulo: 'Costo empresa', tipo: 'numero' },
      { clave: 'descuentos', titulo: 'Descuentos', tipo: 'numero' }, { clave: 'adelantos', titulo: 'Adelantos descontados', tipo: 'numero' }, { clave: 'neto', titulo: 'Neto a pagar', tipo: 'numero' },
      { clave: 'pagado', titulo: 'Pagado', tipo: 'numero' }, { clave: 'saldo', titulo: 'Saldo', tipo: 'numero' }, { clave: 'estado', titulo: 'Estado' }
    ], filas);
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Adelantos
// ---------------------------------------------------------------------------
router.get('/adelantos', authSueldos, async (req, res) => {
  try {
    const match = Object.assign({}, filtroOrg(req));
    if (req.query.estado) match.estado = String(req.query.estado);
    if (req.query.empleadoId) { const e = toObjectId(req.query.empleadoId); if (!e) throw err(400, 'empleadoId inválido'); match.empleadoId = e; }
    const lista = await conReintento(async () => (await getDb()).collection('sueldos_adelantos').find(match).sort({ fecha: -1 }).limit(500).toArray());
    res.json(lista);
  } catch (e) { responder(res, e); }
});
router.post('/adelantos', authSueldos, async (req, res) => {
  try {
    const b = req.body || {};
    const empId = toObjectId(b.empleadoId); if (!empId) throw err(400, 'Elegí el empleado.');
    const m = monto(b.monto, 'El monto'); if (!(m > 0)) throw err(400, 'El monto tiene que ser mayor a 0.');
    const fecha = fechaDe(b.fecha), nota = texto(b.nota);
    const doc = await conReintento(async () => {
      const db = await getDb();
      const emp = await db.collection('empleados').findOne(Object.assign({ _id: empId }, filtroOrg(req)));
      if (!emp) throw err(404, 'Empleado no encontrado.');
      await egresoDeCuenta(db, req, { cuentaTipo: b.cuentaTipo, cuentaId: b.cuentaId, monto: m, motivo: 'Adelanto de sueldo ' + emp.nombre, observaciones: nota, origen: 'sueldo_adelanto', fecha });
      const d = { empleadoId: empId, empleadoNombre: emp.nombre, monto: m, fecha, nota, cuentaTipo: b.cuentaTipo, cuentaId: toObjectId(b.cuentaId), estado: 'pendiente', liquidacionId: null, usuarioNombre: (req.usuario && req.usuario.nombre) || '', orgId: req.orgId, createdAt: new Date() };
      const r = await db.collection('sueldos_adelantos').insertOne(d);
      return Object.assign(d, { _id: r.insertedId });
    });
    res.json(doc);
  } catch (e) { responder(res, e); }
});
// Anular un adelanto que todavía no se descontó: se devuelve la plata a la misma caja o banco.
router.delete('/adelantos/:id', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const a = await db.collection('sueldos_adelantos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!a) throw err(404, 'Adelanto no encontrado.');
      if (a.estado !== 'pendiente') throw err(400, 'Este adelanto ya se descontó en una liquidación, no se puede anular.');
      await egresoDeCuenta(db, req, { cuentaTipo: a.cuentaTipo, cuentaId: a.cuentaId, monto: a.monto, motivo: 'Anulación adelanto de sueldo ' + a.empleadoNombre, origen: 'sueldo_adelanto_anulado', fecha: new Date(), tipo: 'ingreso' });
      await db.collection('sueldos_adelantos').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Colocadores (Gestión de Obras). Se les paga por m² de cada tarea terminada (100 % de los m² x el costo por m²
// que quedó aplicado a la tarea), en el mes en que se terminó la tarea (devengado). Acá se ven por mes, se
// liquidan (por colocador y mes, se puede ir completando a medida que se terminan tareas) y se pagan desde
// Tesorería, en pagos parciales (por ejemplo semanales).
//   sueldos_colocadores : { colocadorId, colocadorNombre, periodo, tipo (parcial = semana | final = cierre del mes),
//     desde, hasta, tareas: [{ obraId, tareaId, obra, tipoTrabajo, m2, costoPorM2, monto, fecha }], total,
//     pagos: [...], totalPagado, estado, orgId, ... }  (varias por colocador y mes: cada semana una parcial y al final el cierre)
// ---------------------------------------------------------------------------
function rangoPeriodo(p) { return { d0: new Date(p + '-01T00:00:00.000-03:00'), d1: finPeriodo(p) }; }

async function tareasTerminadasDelPeriodo(db, req, periodo) {
  const { d0, d1 } = rangoPeriodo(periodo);
  const filas = await db.collection('obras').aggregate([
    { $match: Object.assign({ 'tareas.estado': 'terminada' }, filtroOrg(req)) }, { $unwind: '$tareas' },
    { $match: { 'tareas.estado': 'terminada', 'tareas.colocadorId': { $ne: null }, 'tareas.fechaFinReal': { $gte: d0, $lte: d1 } } },
    { $project: { numero: 1, cliente: '$cliente.nombre', t: '$tareas' } }
  ]).toArray();
  return filas.map(f => {
    const m2 = Number(f.t.m2Presupuestados || 0), costo = Number(f.t.costoPorM2Aplicado || 0);
    return { colocadorId: f.t.colocadorId, obraId: f._id, tareaId: f.t._id, obra: ('#' + (f.numero || '') + ' ' + (f.cliente || '')).trim(), tipoTrabajo: f.t.tipoTrabajo || '', m2, costoPorM2: costo, monto: r2(m2 * costo), fecha: f.t.fechaFinReal };
  });
}

function isoAR(d) { return new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().slice(0, 10); }

async function armarColocadores(db, req, periodo) {
  const org = filtroOrg(req);
  const tareas = await tareasTerminadasDelPeriodo(db, req, periodo);
  const liqs = await db.collection('sueldos_colocadores').find(Object.assign({ periodo }, org)).sort({ createdAt: 1 }).toArray();
  const ids = tareas.map(t => t.tareaId);
  // tarea -> liquidación que la incluye (puede ser de otro mes si la fecha de fin se movió)
  const liqDe = new Map();
  if (ids.length) (await db.collection('sueldos_colocadores').find(Object.assign({ 'tareas.tareaId': { $in: ids } }, org)).project({ 'tareas.tareaId': 1 }).toArray()).forEach(l => (l.tareas || []).forEach(t => liqDe.set(String(t.tareaId), String(l._id))));
  const colIds = [...new Set([...tareas.map(t => String(t.colocadorId)), ...liqs.map(l => String(l.colocadorId))])];
  const cols = colIds.length ? await db.collection('obras_colocadores').find({ _id: { $in: colIds.map(toObjectId) } }).project({ nombre: 1 }).toArray() : [];
  const nombre = Object.fromEntries(cols.map(c => [String(c._id), c.nombre]));
  return colIds.map(cid => {
    const mias = tareas.filter(t => String(t.colocadorId) === cid).map(t => Object.assign({}, t, { liquidacionId: liqDe.get(String(t.tareaId)) || null, liquidada: liqDe.has(String(t.tareaId)) })).sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    const ls = liqs.filter(x => String(x.colocadorId) === cid).map(l => ({ _id: String(l._id), tipo: l.tipo || 'parcial', desde: l.desde || '', hasta: l.hasta || '', total: l.total, totalPagado: l.totalPagado || 0, saldo: r2(l.total - (l.totalPagado || 0)), estado: l.estado, pagos: l.pagos || [], cantTareas: (l.tareas || []).length }));
    return {
      colocadorId: cid, nombre: nombre[cid] || (liqs.find(x => String(x.colocadorId) === cid) || {}).colocadorNombre || '(desconocido)',
      m2: r2(mias.reduce((s, t) => s + t.m2, 0)), devengado: r2(mias.reduce((s, t) => s + t.monto, 0)), pendienteLiquidar: r2(mias.filter(t => !t.liquidada).reduce((s, t) => s + t.monto, 0)),
      liquidado: r2(ls.reduce((s, l) => s + l.total, 0)), pagado: r2(ls.reduce((s, l) => s + l.totalPagado, 0)), saldo: r2(ls.reduce((s, l) => s + l.saldo, 0)),
      cerrado: ls.some(l => l.tipo === 'final'), tareas: mias, liquidaciones: ls
    };
  }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

router.get('/colocadores', authSueldos, async (req, res) => {
  try {
    const periodo = validarPeriodo(req.query.periodo || periodoActual());
    const filas = await conReintento(async () => armarColocadores(await getDb(), req, periodo));
    const sum = k => r2(filas.reduce((s, f) => s + f[k], 0));
    res.json({ periodo, colocadores: filas, totales: { m2: sum('m2'), devengado: sum('devengado'), pendienteLiquidar: sum('pendienteLiquidar'), liquidado: sum('liquidado'), pagado: sum('pagado'), saldo: sum('saldo') } });
  } catch (e) { responder(res, e); }
});

// Liquidación parcial (semana): tareas terminadas del mes, todavía sin liquidar, hasta la fecha "hasta".
// Liquidación final (cierre del mes): todo lo que quede sin liquidar del mes. Cada una es un registro propio
// con sus pagos. Se puede hacer para un colocador o para todos.
router.post('/colocadores/liquidar', authSueldos, async (req, res) => {
  try {
    const b = req.body || {};
    const periodo = validarPeriodo(b.periodo);
    const tipo = b.tipo === 'final' ? 'final' : 'parcial';
    const { d0, d1 } = rangoPeriodo(periodo);
    let corte = d1, hastaISO = isoAR(d1);
    if (tipo === 'parcial') {
      const h = fechaDe(b.hasta || hoyAR());
      if (h < d0) throw err(400, 'La fecha "hasta" tiene que estar dentro de ' + periodo + '.');
      hastaISO = isoAR(h) > isoAR(d1) ? isoAR(d1) : isoAR(h);
      corte = new Date(hastaISO + 'T23:59:59.999-03:00');
    }
    const soloCol = b.colocadorId ? String(b.colocadorId) : null;
    const out = await conReintento(async () => {
      const db = await getDb();
      const filas = await armarColocadores(db, req, periodo);
      let n = 0, tareasN = 0, total = 0;
      for (const f of filas) {
        if (soloCol && f.colocadorId !== soloCol) continue;
        const nuevas = f.tareas.filter(t => !t.liquidada && new Date(t.fecha) <= corte);
        if (!nuevas.length) continue;
        const docs = nuevas.map(t => ({ obraId: t.obraId, tareaId: t.tareaId, obra: t.obra, tipoTrabajo: t.tipoTrabajo, m2: t.m2, costoPorM2: t.costoPorM2, monto: t.monto, fecha: t.fecha }));
        const suma = r2(docs.reduce((s, t) => s + t.monto, 0));
        await db.collection('sueldos_colocadores').insertOne({ colocadorId: toObjectId(f.colocadorId), colocadorNombre: f.nombre, periodo, tipo, desde: isoAR(nuevas[0].fecha), hasta: hastaISO, tareas: docs, total: suma, pagos: [], totalPagado: 0, estado: suma > 0 ? 'pendiente' : 'pagada', orgId: req.orgId, createdAt: new Date(), updatedAt: new Date() });
        n++; tareasN += docs.length; total = r2(total + suma);
      }
      return { liquidados: n, tareas: tareasN, total };
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

router.post('/colocadores/liquidaciones/:id/pagos', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const m = monto(b.monto, 'El monto'); if (!(m > 0)) throw err(400, 'El monto tiene que ser mayor a 0.');
    const fecha = fechaDe(b.fecha), nota = texto(b.nota);
    const l = await conReintento(async () => {
      const db = await getDb();
      const l = await db.collection('sueldos_colocadores').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!l) throw err(404, 'Liquidación no encontrada.');
      const saldo = r2(l.total - (l.totalPagado || 0));
      if (m > saldo + 0.005) throw err(400, 'El monto supera lo que falta pagar (' + saldo + ').');
      await egresoDeCuenta(db, req, { cuentaTipo: b.cuentaTipo, cuentaId: b.cuentaId, monto: m, motivo: 'Colocación ' + l.colocadorNombre + ' ' + l.periodo, observaciones: nota, origen: 'sueldo_colocador', fecha });
      l.pagos = (l.pagos || []).concat([{ monto: m, fecha, cuentaTipo: b.cuentaTipo, cuentaId: toObjectId(b.cuentaId), nota, usuarioNombre: (req.usuario && req.usuario.nombre) || '' }]);
      l.totalPagado = r2((l.totalPagado || 0) + m);
      l.estado = estadoPago({ neto: l.total, totalPagado: l.totalPagado });
      await db.collection('sueldos_colocadores').updateOne({ _id: id }, { $set: { pagos: l.pagos, totalPagado: l.totalPagado, estado: l.estado, updatedAt: new Date() } });
      return l;
    });
    res.json(l);
  } catch (e) { responder(res, e); }
});

// Deshacer una liquidación sin pagos: las tareas vuelven a quedar pendientes de liquidar.
router.delete('/colocadores/liquidaciones/:id', authSueldos, async (req, res) => {
  try {
    const id = toObjectId(req.params.id); if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const l = await db.collection('sueldos_colocadores').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!l) throw err(404, 'Liquidación no encontrada.');
      if ((l.totalPagado || 0) > 0) throw err(400, 'Esta liquidación ya tiene pagos registrados, no se puede borrar.');
      await db.collection('sueldos_colocadores').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { responder(res, e); }
});

module.exports = router;
module.exports.SECTORES = SECTORES;
