// ---------------------------------------------------------------------------
// Tesorería — cajas, bancos, sus movimientos (ingreso/egreso) y cheques (de
// terceros, recibidos como cobro de una venta, y propios, emitidos para
// pagarle a un proveedor). Pedido de Mato (2/10/2026): "siguiendo el
// esquema venta-entrega-cobro, deberiamos armar el modulo de tesoreria, en
// donde tenemos que armar cajas, bancos, cheques, etc."
//
// Campos de Dux relevados: "Organiza tu tesorería" dio 403 al intentar
// relevarlo directo. "¿Cómo crear y configurar cajas en Dux?" sí se pudo
// consultar — una caja en Dux puede ser "simple" (administrativa, recibe
// saldos de otras cajas) o "diaria" (con apertura/cierre). "¿Cómo gestionar
// cheques propios?" también se pudo consultar — un cheque propio tiene
// estados Emitido → Pagado / Anulado / Rechazado, y se paga desde Compras
// (Pagos a proveedor, forma de valor "Cuenta"). El artículo de cheques DE
// TERCEROS dio 403 — los estados usados acá para esos (en_cartera /
// depositado / rechazado / endosado / anulado) son razonamiento propio,
// mismo criterio honesto que ya se usó con Proveedores.
//
// DECISIONES DE ALCANCE v1 (confirmadas con Mato, 2/10/2026):
//   - Cajas y bancos, cheques de terceros Y propios, todo en la misma
//     vuelta (Mato lo pidió así explícitamente, no por partes).
//   - Cajas "simples" únicamente — SIN apertura/cierre diario (eso queda
//     para una vuelta aparte si hiciera falta más adelante).
//   - Se conecta YA con Ventas y Compras: el cobro de una venta (o el pago
//     de una compra) elige a qué caja/banco va, o si es un cheque. Ver
//     POST /:id/pagos en ventas.js y compras.js — la lógica de aplicar el
//     movimiento o crear el cheque está replicada ahí (mismo criterio que
//     ya usa el resto de la app: cada router mantiene su propia conexión y
//     repite la lógica mínima sobre las mismas colecciones, en vez de
//     requerir este archivo).
//   - Habilitación de cajas/bancos por SUCURSAL y por USUARIO (pedido
//     explícito de Mato) — una caja/banco puede estar habilitada para más
//     de una sucursal (ej: una cuenta bancaria que varias sucursales usan
//     para depositar) y, dentro de eso, restringida a ciertos usuarios
//     (vacío = cualquier usuario con el módulo Tesorería, en esa
//     sucursal). El saldo de cada cuenta es ÚNICO y global (no por
//     sucursal) — es la plata real de esa caja o cuenta bancaria, venga de
//     donde venga; los movimientos sí guardan `orgId` (desde qué sucursal
//     se hizo) para poder reportar por sucursal más adelante si hiciera
//     falta.
//   - El ALTA y la habilitación de cajas/bancos viven en un panel dentro
//     de Configuración (`admin-usuarios.html`, pestaña "Cajas y Bancos"),
//     gateado por el módulo 'usuarios' — no por 'tesoreria'. El día a día
//     (ver saldos, cargar movimientos, gestionar cheques) es la pantalla
//     `admin-tesoreria.html`, gateada por 'tesoreria'.
//   - Cheques propios: sin vínculo obligatorio a una Compra (se puede
//     emitir un cheque propio para cualquier pago, no solo a un
//     proveedor cargado en Compras) — si se asocia a una compra, se
//     resuelve igual que un pago común de Compras.
//   - Cuenta corriente por CLIENTE agregada el 2/10/2026 (pedido de
//     Mato) — ver POST /cobros-cuenta-cliente más abajo y
//     registrarMovimientoCuentaCorriente en clientes.js. Sigue sin haber
//     cuenta corriente de PROVEEDOR (no la pidió) ni conciliación
//     bancaria automática.
//
// Colecciones nuevas:
//   tesoreria_cajas: { nombre, moneda (ARS/USD), sucursalesHabilitadas:
//     [orgId], usuariosHabilitados: [usuarioId] (vacío = todos), activa,
//     notas, createdAt, updatedAt }
//   tesoreria_bancos: { nombre, banco (nombre real del banco), tipoCuenta
//     (cuenta_corriente/caja_ahorro), cbu, aliasCbu, numeroCuenta, moneda,
//     sucursalesHabilitadas, usuariosHabilitados, activo, notas,
//     createdAt, updatedAt }
//   tesoreria_movimientos: { cuentaTipo (caja/banco), cuentaId, tipo
//     (ingreso/egreso), monto, moneda, motivo, observaciones, origen
//     (manual/venta/compra/cheque), ventaId, compraId, chequeId,
//     usuarioNombre, fecha, orgId, createdAt } — libro inmutable, sin
//     PUT/DELETE, mismo criterio que `stock_movimientos`.
//   tesoreria_saldos: { cuentaTipo, cuentaId, saldo, actualizadoEn } —
//     caché por cuenta (GLOBAL, no por sucursal — ver arriba), actualizado
//     con $inc en cada movimiento.
//   cheques: { tipo (tercero/propio), numero, banco (texto libre, terceros),
//     cuentaId (propios — de qué banco propio sale), clienteId,
//     clienteNombre, proveedorId, proveedorNombre, ventaId, compraId,
//     librador, cuitLibrador (solo terceros, pedido de Mato 2/10/2026),
//     fechaEmision, fechaVencimiento, moneda, monto, estado
//     (terceros: en_cartera/depositado/rechazado/endosado/anulado —
//     propios: emitido/pagado/rechazado/anulado), depositadoEnCuentaId,
//     endosadoA, observaciones, usuarioNombre, fecha, orgId, createdAt,
//     updatedAt }.
//
// Módulos: 'tesoreria' (operación diaria) y, para el alta/habilitación,
// el ya existente 'usuarios' (vive dentro de Configuración).
//
// Integración (en server.js):
//   const tesoreriaRouter = require('./tesoreria');
//   app.use('/api/tesoreria', tesoreriaRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
// Cuenta corriente del cliente (2/10/2026, pedido de Mato) — ver el
// comentario grande de registrarMovimientoCuentaCorriente en clientes.js.
const { registrarMovimientoCuentaCorriente } = require('./clientes');
// Imprimibles (3/10/2026, pedido de Mato) — ver imprimibles.js.
const { paginaImprimible, escapeHtml: escHtml, money: moneyImp, fechaLarga } = require('./imprimibles');

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
      db.collection('tesoreria_saldos').createIndex({ cuentaTipo: 1, cuentaId: 1 }, { unique: true }),
      db.collection('tesoreria_movimientos').createIndex({ orgId: 1, fecha: -1, createdAt: -1 }),
      db.collection('tesoreria_movimientos').createIndex({ cuentaTipo: 1, cuentaId: 1, fecha: -1 }),
      db.collection('cheques').createIndex({ orgId: 1, tipo: 1, estado: 1, fechaVencimiento: 1 })
    ]);
  } catch (e) {
    indicesListos = false;
    console.error('No se pudieron crear los índices de tesorería:', e.message);
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
function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function normalizarMontoPositivo(v, etiqueta) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw err(400, `${etiqueta} tiene que ser un número mayor a 0`);
  return n;
}

const MONEDAS_VALIDAS = ['ARS', 'USD'];
const TIPOS_CUENTA_BANCARIA_VALIDOS = ['cuenta_corriente', 'caja_ahorro'];
const TIPOS_MOVIMIENTO_VALIDOS = ['ingreso', 'egreso'];
const ESTADOS_CHEQUE_TERCERO = ['en_cartera', 'depositado', 'cobrado', 'rechazado', 'endosado', 'anulado'];
const ESTADOS_CHEQUE_PROPIO = ['emitido', 'pagado', 'rechazado', 'anulado'];
// Mismas formas de valor que un cobro de venta (ventas.js) — ver
// POST /cobros-cuenta-cliente más abajo.
const TIPOS_VALOR_COBRO_CUENTA_VALIDOS = ['efectivo', 'cheque', 'cuenta', 'tarjeta'];

const authConfig = [authUsuario, resolverOrg, requiereModulo('usuarios')];
const authOperar = [authUsuario, resolverOrg, requiereModulo('tesoreria')];

// Una cuenta (caja o banco) está habilitada para este request si está
// activa, y si está habilitada para la sucursal actual (o no tiene
// restricción de sucursal) y para el usuario actual (o no tiene
// restricción de usuario). req.orgId === null (protegido, "todas") pasa
// siempre la parte de sucursal.
function cuentaHabilitada(cuenta, req) {
  if (!cuenta || cuenta.activa === false || cuenta.activo === false) return false;
  const sucursales = cuenta.sucursalesHabilitadas || [];
  if (sucursales.length && req.orgId && !sucursales.some(id => String(id) === String(req.orgId))) return false;
  const usuarios = cuenta.usuariosHabilitados || [];
  if (usuarios.length && req.usuario && !usuarios.some(id => String(id) === String(req.usuario._id))) return false;
  return true;
}

function normalizarIdsArray(raw) {
  return (Array.isArray(raw) ? raw : []).map(toObjectId).filter(Boolean);
}

// -----------------------------------------------------------------------
// Movimientos — aplica un ingreso/egreso a una cuenta (caja o banco):
// inserta el renglón inmutable y actualiza el saldo en caché con $inc.
// Exportada para que ventas.js/compras.js la puedan reusar en vez de
// reimplementar esta parte (a diferencia del resto de la app, acá sí
// conviene compartir: es lógica de negocio sensible al dinero, no una
// lectura liviana para armar un formulario).
// -----------------------------------------------------------------------
async function aplicarMovimientoCuenta(db, req, { cuentaTipo, cuentaId, tipo, monto, moneda, motivo, observaciones, origen, ventaId, compraId, chequeId, fecha }) {
  if (!['caja', 'banco'].includes(cuentaTipo)) throw err(400, 'cuentaTipo inválido (caja o banco)');
  if (!TIPOS_MOVIMIENTO_VALIDOS.includes(tipo)) throw err(400, 'Tipo de movimiento inválido');
  const coleccion = cuentaTipo === 'caja' ? 'tesoreria_cajas' : 'tesoreria_bancos';
  const cuenta = await db.collection(coleccion).findOne({ _id: cuentaId });
  if (!cuenta) throw err(404, `${cuentaTipo === 'caja' ? 'Caja' : 'Banco'} no encontrado`);
  if (!cuentaHabilitada(cuenta, req)) throw err(403, `No tenés habilitada esta ${cuentaTipo === 'caja' ? 'caja' : 'cuenta bancaria'} en esta sucursal.`);
  const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
  const movimiento = {
    cuentaTipo, cuentaId, tipo, monto, moneda: moneda || cuenta.moneda || 'ARS',
    motivo: motivo || '', observaciones: observaciones || '', origen: origen || 'manual',
    ventaId: ventaId || null, compraId: compraId || null, chequeId: chequeId || null,
    usuarioNombre, fecha: fecha || new Date(), orgId: req.orgId, createdAt: new Date()
  };
  const { insertedId } = await db.collection('tesoreria_movimientos').insertOne(movimiento);
  movimiento._id = insertedId; // 3/10/2026: lo necesita el recibo imprimible de un cobro a cuenta (ver /cobros-cuenta-cliente e imprimibles.js) — el driver no lo completa solo.
  const delta = tipo === 'ingreso' ? monto : -monto;
  await db.collection('tesoreria_saldos').updateOne(
    { cuentaTipo, cuentaId },
    { $inc: { saldo: delta }, $set: { actualizadoEn: new Date() }, $setOnInsert: { cuentaTipo, cuentaId } },
    { upsert: true }
  );
  return movimiento;
}
// Se cuelgan como propiedades de `router` (no de `module.exports`
// directamente) porque más abajo `module.exports = router` REEMPLAZA el
// objeto exports entero — si se dejaran en module.exports acá, esa
// reasignación las borraba sin avisar (bug real, 2/10/2026: ventas.js
// tiraba "aplicarMovimientoCuenta is not a function" en producción).
// Colgarlas de `router` en cambio sobrevive esa reasignación, porque es
// el mismo objeto al que apunta `module.exports` al final.
router.aplicarMovimientoCuenta = aplicarMovimientoCuenta;
router.cuentaHabilitada = cuentaHabilitada;

// -----------------------------------------------------------------------
// Configuración — alta y habilitación de cajas/bancos. Vive dentro de
// Configuración (módulo 'usuarios'), no de Tesorería.
// -----------------------------------------------------------------------

router.get('/config/cajas', authConfig, async (req, res) => {
  try {
    const cajas = await conReintento(async () => (await getDb()).collection('tesoreria_cajas').find({}).sort({ nombre: 1 }).toArray());
    res.json(cajas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/config/cajas', authConfig, async (req, res) => {
  try {
    const body = req.body || {};
    const nombre = normalizarTexto(body.nombre);
    if (!nombre) throw err(400, 'El nombre es obligatorio');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const doc = {
      nombre, moneda,
      sucursalesHabilitadas: normalizarIdsArray(body.sucursalesHabilitadas),
      usuariosHabilitados: normalizarIdsArray(body.usuariosHabilitados),
      activa: true, notas: normalizarTexto(body.notas),
      createdAt: new Date(), updatedAt: new Date()
    };
    const r = await conReintento(async () => (await getDb()).collection('tesoreria_cajas').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put('/config/cajas/:id', authConfig, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const nombre = normalizarTexto(body.nombre);
    if (!nombre) throw err(400, 'El nombre es obligatorio');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const set = {
      nombre, moneda,
      sucursalesHabilitadas: normalizarIdsArray(body.sucursalesHabilitadas),
      usuariosHabilitados: normalizarIdsArray(body.usuariosHabilitados),
      notas: normalizarTexto(body.notas),
      updatedAt: new Date()
    };
    if (body.activa !== undefined) set.activa = !!body.activa;
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const r = await db.collection('tesoreria_cajas').findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
      return (r && r.value !== undefined) ? r.value : r;
    });
    if (!resultado) throw err(404, 'Caja no encontrada');
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/config/cajas/:id', authConfig, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => (await getDb()).collection('tesoreria_cajas').updateOne({ _id: id }, { $set: { activa: false, updatedAt: new Date() } }));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/config/bancos', authConfig, async (req, res) => {
  try {
    const bancos = await conReintento(async () => (await getDb()).collection('tesoreria_bancos').find({}).sort({ nombre: 1 }).toArray());
    res.json(bancos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/config/bancos', authConfig, async (req, res) => {
  try {
    const body = req.body || {};
    const nombre = normalizarTexto(body.nombre);
    if (!nombre) throw err(400, 'El nombre es obligatorio');
    const tipoCuenta = normalizarTexto(body.tipoCuenta).toLowerCase() || 'cuenta_corriente';
    if (!TIPOS_CUENTA_BANCARIA_VALIDOS.includes(tipoCuenta)) throw err(400, 'Tipo de cuenta inválido');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const doc = {
      nombre, banco: normalizarTexto(body.banco), tipoCuenta,
      cbu: normalizarTexto(body.cbu), aliasCbu: normalizarTexto(body.aliasCbu), numeroCuenta: normalizarTexto(body.numeroCuenta),
      moneda,
      sucursalesHabilitadas: normalizarIdsArray(body.sucursalesHabilitadas),
      usuariosHabilitados: normalizarIdsArray(body.usuariosHabilitados),
      activo: true, notas: normalizarTexto(body.notas),
      createdAt: new Date(), updatedAt: new Date()
    };
    const r = await conReintento(async () => (await getDb()).collection('tesoreria_bancos').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.put('/config/bancos/:id', authConfig, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const body = req.body || {};
    const nombre = normalizarTexto(body.nombre);
    if (!nombre) throw err(400, 'El nombre es obligatorio');
    const tipoCuenta = normalizarTexto(body.tipoCuenta).toLowerCase() || 'cuenta_corriente';
    if (!TIPOS_CUENTA_BANCARIA_VALIDOS.includes(tipoCuenta)) throw err(400, 'Tipo de cuenta inválido');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const set = {
      nombre, banco: normalizarTexto(body.banco), tipoCuenta,
      cbu: normalizarTexto(body.cbu), aliasCbu: normalizarTexto(body.aliasCbu), numeroCuenta: normalizarTexto(body.numeroCuenta),
      moneda,
      sucursalesHabilitadas: normalizarIdsArray(body.sucursalesHabilitadas),
      usuariosHabilitados: normalizarIdsArray(body.usuariosHabilitados),
      notas: normalizarTexto(body.notas),
      updatedAt: new Date()
    };
    if (body.activo !== undefined) set.activo = !!body.activo;
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const r = await db.collection('tesoreria_bancos').findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: 'after' });
      return (r && r.value !== undefined) ? r.value : r;
    });
    if (!resultado) throw err(404, 'Banco no encontrado');
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/config/bancos/:id', authConfig, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => (await getDb()).collection('tesoreria_bancos').updateOne({ _id: id }, { $set: { activo: false, updatedAt: new Date() } }));
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Operación diaria (módulo 'tesoreria') — cajas/bancos habilitados para
// este usuario+sucursal, con su saldo actual.
// -----------------------------------------------------------------------

async function listarCuentasHabilitadas(db, req, coleccion, tipo) {
  const todas = await db.collection(coleccion).find({}).sort({ nombre: 1 }).toArray();
  const habilitadas = todas.filter(c => cuentaHabilitada(c, req));
  const saldos = await db.collection('tesoreria_saldos').find({ cuentaTipo: tipo, cuentaId: { $in: habilitadas.map(c => c._id) } }).toArray();
  const saldoPorId = new Map(saldos.map(s => [String(s.cuentaId), s.saldo]));
  return habilitadas.map(c => Object.assign({}, c, { saldo: saldoPorId.get(String(c._id)) || 0 }));
}

router.get('/cajas', authOperar, async (req, res) => {
  try {
    const cajas = await conReintento(async () => listarCuentasHabilitadas(await getDb(), req, 'tesoreria_cajas', 'caja'));
    res.json(cajas);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.get('/bancos', authOperar, async (req, res) => {
  try {
    const bancos = await conReintento(async () => listarCuentasHabilitadas(await getDb(), req, 'tesoreria_bancos', 'banco'));
    res.json(bancos);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Resumen de Tesorería (4/10/2026, pedido de Mato: "tesorería debería mostrarme
// un detalle de los saldos de banco, tarjeta y cheques todo en la misma
// pantalla"). Junta en una sola respuesta: saldos de cajas y bancos, cheques
// por estado (con vencimientos) y cobros con tarjeta. Los cobros con tarjeta
// se acreditan directo en el banco elegido (ya están dentro del saldo del
// banco); acá se muestran aparte solo como detalle de cuánto entró por tarjeta.
router.get('/resumen', authOperar, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const [cajas, bancos, cheques, ventasTarjeta, movTarjeta] = await Promise.all([
        listarCuentasHabilitadas(db, req, 'tesoreria_cajas', 'caja'),
        listarCuentasHabilitadas(db, req, 'tesoreria_bancos', 'banco'),
        db.collection('cheques').find(Object.assign({ estado: { $in: ['en_cartera', 'depositado', 'cobrado', 'emitido'] } }, filtroOrg(req)))
          .sort({ fechaVencimiento: 1 }).limit(1000).toArray(),
        db.collection('ventas').find(Object.assign({ estado: { $ne: 'anulada' }, 'pagos.tipoValor': 'tarjeta' }, filtroOrg(req)))
          .project({ numero: 1, clienteNombre: 1, moneda: 1, pagos: 1 }).sort({ createdAt: -1 }).limit(500).toArray(),
        db.collection('tesoreria_movimientos').find(Object.assign({ origen: 'cobro_cuenta', tipo: 'ingreso', observaciones: /Lote .* \/ Cup/ }, filtroOrg(req)))
          .sort({ fecha: -1 }).limit(200).toArray()
      ]);
      const nombreBanco = new Map(bancos.map(b => [String(b._id), b.nombre]));
      const sumar = (lista, campo) => {
        const t = {};
        lista.forEach(x => { const m = x.moneda || 'ARS'; t[m] = (t[m] || 0) + (Number(x[campo]) || 0); });
        return t;
      };
      // Cheques
      const grupos = { cartera: [], depositados: [], emitidos: [] };
      cheques.forEach(c => {
        if (c.tipo === 'tercero' && c.estado === 'en_cartera') grupos.cartera.push(c);
        else if (c.tipo === 'tercero' && (c.estado === 'depositado' || c.estado === 'cobrado')) grupos.depositados.push(c);
        else if (c.tipo === 'propio' && c.estado === 'emitido') grupos.emitidos.push(c);
      });
      const venc = (c) => c.fechaVencimiento ? new Date(c.fechaVencimiento) : null;
      const resumenGrupo = (lista) => ({
        cantidad: lista.length,
        total: sumar(lista, 'monto'),
        vencidos: sumar(lista.filter(c => venc(c) && venc(c) < hoy), 'monto'),
        cantidadVencidos: lista.filter(c => venc(c) && venc(c) < hoy).length,
        prox7: sumar(lista.filter(c => venc(c) && venc(c) >= hoy && venc(c) < new Date(hoy.getTime() + 7 * 86400000)), 'monto'),
        prox30: sumar(lista.filter(c => venc(c) && venc(c) >= hoy && venc(c) < new Date(hoy.getTime() + 30 * 86400000)), 'monto')
      });
      const proximos = grupos.cartera.concat(grupos.emitidos)
        .sort((a, b) => (venc(a) || 0) - (venc(b) || 0)).slice(0, 15)
        .map(c => ({ _id: c._id, tipo: c.tipo, numero: c.numero, banco: c.banco || '', fechaVencimiento: c.fechaVencimiento, monto: c.monto, moneda: c.moneda || 'ARS', estado: c.estado, contraparte: c.tipo === 'tercero' ? (c.clienteNombre || c.librador || '') : (c.proveedorNombre || '') }));
      // Tarjeta
      const cobrosTarjeta = [];
      ventasTarjeta.forEach(v => (v.pagos || []).filter(p => p.tipoValor === 'tarjeta').forEach(p => cobrosTarjeta.push({
        fecha: p.fecha, monto: p.monto, moneda: v.moneda || 'ARS',
        referencia: `Venta Nº ${v.numero}${v.clienteNombre ? ' — ' + v.clienteNombre : ''}`,
        entidad: p.tarjetaEntidad || '', tipoTarjeta: p.tarjetaTipo || '', cuotas: p.tarjetaCuotas || 1,
        lote: p.tarjetaLote || '', cupon: p.tarjetaCupon || '',
        banco: p.cuentaId ? (nombreBanco.get(String(p.cuentaId)) || '') : ''
      })));
      movTarjeta.forEach(m => {
        const mm = /Lote (.*?) \/ Cup[oó]n (.*)$/.exec(m.observaciones || '');
        cobrosTarjeta.push({
          fecha: m.fecha, monto: m.monto, moneda: m.moneda || 'ARS', referencia: m.motivo || 'Cobro a cuenta',
          entidad: '', tipoTarjeta: '', cuotas: 1, lote: mm ? mm[1] : '', cupon: mm ? mm[2] : '',
          banco: nombreBanco.get(String(m.cuentaId)) || ''
        });
      });
      cobrosTarjeta.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      const hace30 = new Date(hoy.getTime() - 30 * 86400000);
      const porBanco = {};
      cobrosTarjeta.forEach(c => { const k = (c.banco || 'Sin banco') + '|' + c.moneda; porBanco[k] = (porBanco[k] || 0) + (Number(c.monto) || 0); });
      return {
        cajas: cajas.map(c => ({ _id: c._id, nombre: c.nombre, moneda: c.moneda || 'ARS', saldo: c.saldo })),
        bancos: bancos.map(b => ({ _id: b._id, nombre: b.nombre, banco: b.banco || '', moneda: b.moneda || 'ARS', saldo: b.saldo })),
        totalCajas: sumar(cajas.map(c => ({ moneda: c.moneda, saldo: c.saldo })), 'saldo'),
        totalBancos: sumar(bancos.map(b => ({ moneda: b.moneda, saldo: b.saldo })), 'saldo'),
        cheques: { cartera: resumenGrupo(grupos.cartera), depositados: resumenGrupo(grupos.depositados), emitidos: resumenGrupo(grupos.emitidos), proximos },
        tarjeta: {
          cantidad: cobrosTarjeta.length,
          total: sumar(cobrosTarjeta, 'monto'),
          ultimos30: sumar(cobrosTarjeta.filter(c => new Date(c.fecha) >= hace30), 'monto'),
          porBanco: Object.keys(porBanco).map(k => { const [banco, moneda] = k.split('|'); return { banco, moneda, monto: porBanco[k] }; }),
          ultimos: cobrosTarjeta.slice(0, 15)
        }
      };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Transferencia entre cajas y/o bancos (4/10/2026, pedido de Mato): una
// caja→banco (depósito de efectivo), banco→caja (extracción), caja→caja o
// banco→banco. Genera un egreso en el origen y un ingreso en el destino, en
// la misma moneda. Si el segundo falla, se revierte el primero.
router.post('/transferencias', authOperar, async (req, res) => {
  try {
    const b = req.body || {};
    const origenTipo = normalizarTexto(b.origenTipo), destinoTipo = normalizarTexto(b.destinoTipo);
    if (!['caja', 'banco'].includes(origenTipo) || !['caja', 'banco'].includes(destinoTipo)) throw err(400, 'Elegí origen y destino');
    const origenId = toObjectId(b.origenId), destinoId = toObjectId(b.destinoId);
    if (!origenId || !destinoId) throw err(400, 'Elegí origen y destino');
    if (origenTipo === destinoTipo && String(origenId) === String(destinoId)) throw err(400, 'El origen y el destino no pueden ser la misma cuenta');
    const monto = normalizarMontoPositivo(b.monto, 'El monto');
    const nota = normalizarTexto(b.observaciones);
    const fecha = b.fecha ? new Date(b.fecha) : new Date();
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const col = (t) => t === 'caja' ? 'tesoreria_cajas' : 'tesoreria_bancos';
      const [orig, dest] = await Promise.all([
        db.collection(col(origenTipo)).findOne({ _id: origenId }),
        db.collection(col(destinoTipo)).findOne({ _id: destinoId })
      ]);
      if (!orig || !dest) throw err(404, 'No se encontró la cuenta de origen o destino');
      const monedaO = orig.moneda || 'ARS', monedaD = dest.moneda || 'ARS';
      if (monedaO !== monedaD) throw err(400, `No se puede transferir entre monedas distintas (${monedaO} → ${monedaD}). Registrá la compra/venta de divisas como movimientos manuales.`);
      const nombreO = orig.nombre, nombreD = dest.nombre;
      const egreso = await aplicarMovimientoCuenta(db, req, {
        cuentaTipo: origenTipo, cuentaId: origenId, tipo: 'egreso', monto, moneda: monedaO,
        motivo: `Transferencia a ${destinoTipo === 'caja' ? 'caja' : 'banco'} ${nombreD}`, observaciones: nota, origen: 'transferencia', fecha
      });
      try {
        await aplicarMovimientoCuenta(db, req, {
          cuentaTipo: destinoTipo, cuentaId: destinoId, tipo: 'ingreso', monto, moneda: monedaD,
          motivo: `Transferencia desde ${origenTipo === 'caja' ? 'caja' : 'banco'} ${nombreO}`, observaciones: nota, origen: 'transferencia', fecha
        });
      } catch (e) {
        // Revierte el egreso para no perder plata en el camino.
        await aplicarMovimientoCuenta(db, req, {
          cuentaTipo: origenTipo, cuentaId: origenId, tipo: 'ingreso', monto, moneda: monedaO,
          motivo: 'Reversión de transferencia fallida', observaciones: e.message, origen: 'transferencia', fecha: new Date()
        });
        throw e;
      }
      return { ok: true };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Planilla de caja diaria (4/10/2026, pedido de Mato: "una planilla de caja
// diaria para poder liquidar"). Para una caja (o banco) y un día: saldo
// inicial, ingresos y egresos por origen, saldo final según el sistema, el
// detalle de movimientos y el cierre del día (arqueo: efectivo contado vs
// sistema). Un movimiento cargado con solo fecha ("2026-10-04") se guarda a
// las 00:00 UTC, así que ese caso cuenta para ESE día; los movimientos con
// hora real se asignan al día según la hora argentina (UTC-3).
function diaDeMovimiento(f) {
  const d = new Date(f);
  const soloFecha = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return soloFecha ? d.toISOString().slice(0, 10) : new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}
function validarDia(v) {
  const t = normalizarTexto(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw err(400, 'Fecha inválida (AAAA-MM-DD)');
  return t;
}
async function armarCajaDiaria(db, req, cuentaTipo, cuentaId, dia) {
  const coleccion = cuentaTipo === 'caja' ? 'tesoreria_cajas' : 'tesoreria_bancos';
  const cuenta = await db.collection(coleccion).findOne({ _id: cuentaId });
  if (!cuenta) throw err(404, 'Cuenta no encontrada');
  if (!cuentaHabilitada(cuenta, req)) throw err(403, 'No tenés habilitada esta cuenta en esta sucursal.');
  const saldoDoc = await db.collection('tesoreria_saldos').findOne({ cuentaTipo, cuentaId });
  const saldoActual = (saldoDoc && saldoDoc.saldo) || 0;
  const desde = new Date(new Date(dia + 'T00:00:00Z').getTime() - 86400000);
  const movs = await db.collection('tesoreria_movimientos').find({ cuentaTipo, cuentaId, fecha: { $gte: desde } }).sort({ fecha: 1, createdAt: 1 }).toArray();
  const delta = (m) => m.tipo === 'ingreso' ? m.monto : -m.monto;
  const desdeElDia = movs.filter(m => diaDeMovimiento(m.fecha) >= dia);
  const delDia = desdeElDia.filter(m => diaDeMovimiento(m.fecha) === dia);
  const netoDesdeElDia = desdeElDia.reduce((a, m) => a + delta(m), 0);
  const saldoInicial = saldoActual - netoDesdeElDia;
  const ingresos = delDia.filter(m => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0);
  const egresos = delDia.filter(m => m.tipo === 'egreso').reduce((a, m) => a + m.monto, 0);
  const porOrigenMap = {};
  delDia.forEach(m => {
    const k = m.origen || 'manual';
    porOrigenMap[k] = porOrigenMap[k] || { origen: k, ingresos: 0, egresos: 0, cantidad: 0 };
    porOrigenMap[k][m.tipo === 'ingreso' ? 'ingresos' : 'egresos'] += m.monto;
    porOrigenMap[k].cantidad++;
  });
  const cierre = await db.collection('tesoreria_cierres').findOne({ cuentaTipo, cuentaId, dia });
  const cierres = await db.collection('tesoreria_cierres').find({ cuentaTipo, cuentaId }).sort({ dia: -1 }).limit(10).toArray();
  return {
    cuenta: { _id: cuenta._id, nombre: cuenta.nombre, moneda: cuenta.moneda || 'ARS', tipo: cuentaTipo, banco: cuenta.banco || '' },
    dia, saldoInicial, ingresos, egresos, saldoFinal: saldoInicial + ingresos - egresos,
    porOrigen: Object.keys(porOrigenMap).map(k => porOrigenMap[k]),
    movimientos: delDia.map(m => ({ _id: m._id, fecha: m.fecha, tipo: m.tipo, monto: m.monto, motivo: m.motivo, observaciones: m.observaciones, origen: m.origen, usuarioNombre: m.usuarioNombre })),
    cierre, cierres
  };
}
router.get('/caja-diaria', authOperar, async (req, res) => {
  try {
    const cuentaTipo = req.query.cuentaTipo === 'banco' ? 'banco' : 'caja';
    const cuentaId = toObjectId(req.query.cuentaId);
    if (!cuentaId) throw err(400, 'Elegí una cuenta');
    const dia = validarDia(req.query.dia);
    res.json(await conReintento(async () => armarCajaDiaria(await getDb(), req, cuentaTipo, cuentaId, dia)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/caja-diaria/cierre', authOperar, async (req, res) => {
  try {
    const b = req.body || {};
    const cuentaTipo = b.cuentaTipo === 'banco' ? 'banco' : 'caja';
    const cuentaId = toObjectId(b.cuentaId);
    if (!cuentaId) throw err(400, 'Elegí una cuenta');
    const dia = validarDia(b.dia);
    const contado = Number(b.efectivoContado);
    if (!isFinite(contado) || contado < 0 || b.efectivoContado === '' || b.efectivoContado == null) throw err(400, 'Cargá el efectivo contado (puede ser 0).');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const plan = await armarCajaDiaria(db, req, cuentaTipo, cuentaId, dia);
      if (plan.cierre) throw err(400, 'Este día ya está cerrado. Reabrilo si necesitás corregirlo.');
      const doc = {
        cuentaTipo, cuentaId, cuentaNombre: plan.cuenta.nombre, moneda: plan.cuenta.moneda, dia,
        saldoInicial: plan.saldoInicial, ingresos: plan.ingresos, egresos: plan.egresos, saldoSistema: plan.saldoFinal,
        efectivoContado: contado, diferencia: Math.round((contado - plan.saldoFinal) * 100) / 100,
        observaciones: normalizarTexto(b.observaciones),
        usuarioNombre: (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '',
        orgId: req.orgId, createdAt: new Date()
      };
      const { insertedId } = await db.collection('tesoreria_cierres').insertOne(doc);
      doc._id = insertedId;
      return doc;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/caja-diaria/cierre/:id', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const c = await db.collection('tesoreria_cierres').findOne({ _id: id });
      if (!c) throw err(404, 'Cierre no encontrado');
      const coleccion = c.cuentaTipo === 'caja' ? 'tesoreria_cajas' : 'tesoreria_bancos';
      const cuenta = await db.collection(coleccion).findOne({ _id: c.cuentaId });
      if (!cuentaHabilitada(cuenta, req)) throw err(403, 'No tenés habilitada esta cuenta en esta sucursal.');
      await db.collection('tesoreria_cierres').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/movimientos', authOperar, async (req, res) => {
  try {
    const match = {};
    if (req.query.cuentaTipo) match.cuentaTipo = req.query.cuentaTipo;
    if (req.query.cuentaId) {
      const cid = toObjectId(req.query.cuentaId);
      if (!cid) throw err(400, 'cuentaId inválido');
      match.cuentaId = cid;
    }
    if (req.query.tipo) {
      if (!TIPOS_MOVIMIENTO_VALIDOS.includes(req.query.tipo)) throw err(400, 'Tipo inválido');
      match.tipo = req.query.tipo;
    }
    if (req.query.desde || req.query.hasta) {
      match.fecha = {};
      if (req.query.desde) match.fecha.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fecha.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const limite = Math.min(Number(req.query.limite) || 200, 500);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const [movimientos, cajas, bancos] = await Promise.all([
        db.collection('tesoreria_movimientos').find(match).sort({ fecha: -1, createdAt: -1 }).limit(limite).toArray(),
        db.collection('tesoreria_cajas').find({}).project({ nombre: 1 }).toArray(),
        db.collection('tesoreria_bancos').find({}).project({ nombre: 1 }).toArray()
      ]);
      const cajasPorId = new Map(cajas.map(c => [String(c._id), c.nombre]));
      const bancosPorId = new Map(bancos.map(b => [String(b._id), b.nombre]));
      return movimientos.map(m => Object.assign({}, m, {
        cuentaNombre: m.cuentaTipo === 'caja' ? (cajasPorId.get(String(m.cuentaId)) || '(caja eliminada)') : (bancosPorId.get(String(m.cuentaId)) || '(banco eliminado)')
      }));
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/movimientos', authOperar, async (req, res) => {
  try {
    const body = req.body || {};
    const cuentaTipo = normalizarTexto(body.cuentaTipo).toLowerCase();
    const cuentaId = toObjectId(body.cuentaId);
    if (!cuentaId) throw err(400, 'Elegí una cuenta');
    const tipo = normalizarTexto(body.tipo).toLowerCase();
    const monto = normalizarMontoPositivo(body.monto, 'El monto');
    const motivo = normalizarTexto(body.motivo);
    const observaciones = normalizarTexto(body.observaciones);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();
    const resultado = await conReintento(async () => {
      const db = await getDb();
      await aplicarMovimientoCuenta(db, req, { cuentaTipo, cuentaId, tipo, monto, motivo, observaciones, origen: 'manual', fecha });
      return { ok: true };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Cobro a cuenta de un cliente — un cobro que no está atado a una venta
// puntual. Pedido de Mato (2/10/2026): "tambien en tesoreria deberiamos
// poder realizar una cobranza en la cuenta del cliente". Reduce el saldo
// de la cuenta corriente del cliente (ver clientes.js,
// registrarMovimientoCuentaCorriente) y, si no es cheque, acredita de
// verdad una caja/banco (aplicarMovimientoCuenta) — mismas reglas que un
// cobro de venta: efectivo solo a caja, cuenta/tarjeta solo a banco; un
// cheque entra "en cartera" (no mueve plata todavía, igual que uno
// recibido por una venta).
// -----------------------------------------------------------------------
router.post('/cobros-cuenta-cliente', authOperar, async (req, res) => {
  try {
    const body = req.body || {};
    const clienteId = toObjectId(body.clienteId);
    if (!clienteId) throw err(400, 'Elegí un cliente');
    const tipoValor = normalizarTexto(body.tipoValor).toLowerCase();
    if (!TIPOS_VALOR_COBRO_CUENTA_VALIDOS.includes(tipoValor)) throw err(400, `Tipo de valor inválido (opciones: ${TIPOS_VALOR_COBRO_CUENTA_VALIDOS.join(', ')})`);
    const monto = normalizarMontoPositivo(body.monto, 'El monto');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const nota = normalizarTexto(body.nota);
    const fecha = body.fecha ? new Date(body.fecha) : new Date();

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
        cuitLibrador: normalizarTexto(body.chequeCuitLibrador),
        fechaEmision: body.chequeFechaEmision ? new Date(body.chequeFechaEmision) : fecha,
        fechaVencimiento: body.chequeFechaVencimiento ? new Date(body.chequeFechaVencimiento) : null,
        observaciones: normalizarTexto(body.chequeObservaciones)
      };
      if (!chequeDatos.numero) throw err(400, 'Falta el número de cheque.');
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
      if (!tarjetaDatos.tarjetaLote) throw err(400, 'Falta el número de lote.');
      if (!tarjetaDatos.tarjetaCupon) throw err(400, 'Falta el número de cupón.');
    }

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cliente = await db.collection('clientes').findOne(Object.assign({ _id: clienteId }, filtroOrg(req)));
      if (!cliente) throw err(404, 'Cliente no encontrado');
      const clienteNombre = cliente.apellidoRazonSocial || cliente.nombre || '';
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      let chequeId = null;
      let movimientoId = null; // 3/10/2026: para poder imprimir el recibo de este cobro recién hecho.

      if (tipoValor === 'cheque') {
        const cheque = Object.assign({
          tipo: 'tercero', moneda, monto, estado: 'en_cartera',
          clienteId, clienteNombre,
          ventaId: null, compraId: null, cuentaId: null, depositadoEnCuentaId: null, endosadoA: null,
          usuarioNombre, fecha, orgId: req.orgId, createdAt: new Date(), updatedAt: new Date()
        }, chequeDatos);
        const { insertedId } = await db.collection('cheques').insertOne(cheque);
        chequeId = insertedId;
      } else {
        const observacionesMovimiento = tipoValor === 'tarjeta'
          ? [nota, `Lote ${tarjetaDatos.tarjetaLote || '—'} / Cupón ${tarjetaDatos.tarjetaCupon || '—'}`].filter(Boolean).join(' — ')
          : nota;
        const movimiento = await aplicarMovimientoCuenta(db, req, {
          cuentaTipo, cuentaId, tipo: 'ingreso', monto, moneda,
          motivo: `Cobro a cuenta — ${clienteNombre}`, observaciones: observacionesMovimiento,
          origen: 'cobro_cuenta', fecha
        });
        movimientoId = movimiento._id;
      }

      await registrarMovimientoCuentaCorriente(db, req, {
        clienteId, clienteNombre, tipo: 'credito', monto, moneda,
        concepto: 'Cobro a cuenta', origen: 'cobro_cuenta', chequeId, observaciones: nota, fecha
      });

      // Para el botón "Imprimir recibo" (ver imprimibles.js y
      // GET /recibo-cuenta/:tipo/:id más abajo) — el tipo le dice al
      // frontend cuál de las dos rutas de recibo usar.
      return { ok: true, reciboTipo: chequeId ? 'cheque' : 'movimiento', reciboId: chequeId || movimientoId };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Recibo imprimible de un cobro "a cuenta" (sin venta puntual) — ver
// `reciboTipo`/`reciboId` que devuelve el POST de arriba. `tipo` es
// 'movimiento' (efectivo/cuenta/tarjeta, ya acreditado) o 'cheque'
// (en cartera). Mismo criterio de ruta con fetch() + document.write en
// el frontend que el resto de los imprimibles (ver ventas.js).
router.get('/recibo-cuenta/:tipo/:id', authOperar, async (req, res) => {
  try {
    const tipo = req.params.tipo;
    if (!['movimiento', 'cheque'].includes(tipo)) throw err(400, 'tipo inválido');
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const doc = tipo === 'cheque'
        ? await db.collection('cheques').findOne(Object.assign({ _id: id }, filtroOrg(req)))
        : await db.collection('tesoreria_movimientos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!doc) throw err(404, 'No se encontró ese cobro');
      const org = await db.collection('organizaciones').findOne({ _id: doc.orgId });
      return { doc, org };
    });
    const { doc, org } = resultado;
    const esMovimiento = tipo === 'movimiento';
    const clienteNombre = doc.clienteNombre || (esMovimiento ? (doc.motivo || '').replace('Cobro a cuenta — ', '') : '');
    const bodyHtml = `
      <h1>Recibo — Cobro a cuenta</h1>
      <div class="datos-doc">
        <div>
          <strong>Recibí de:</strong> ${escHtml(clienteNombre || '—')}<br>
          <strong>La suma de:</strong> ${moneyImp(doc.monto, doc.moneda)}
        </div>
        <div>
          <strong>Fecha:</strong> ${fechaLarga(doc.fecha)}<br>
          <strong>Forma de pago:</strong> ${esMovimiento ? 'Ver movimiento de caja/banco' : 'Cheque Nº ' + escHtml(doc.numero || '—')}
        </div>
      </div>
      <p>En concepto de cobro a cuenta corriente, sin venta puntual asociada.${doc.observaciones ? ` ${escHtml(doc.observaciones)}` : ''}</p>
      <p class="muted" style="margin-top:40px">Firma y aclaración: ________________________________</p>
    `;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(paginaImprimible({ titulo: 'Recibo — Cobro a cuenta', org: org || { nombre: 'Organización' }, bodyHtml }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Cheques — de terceros (recibidos como cobro de una venta) y propios
// (emitidos para pagar). Se crean normalmente desde Ventas/Compras (ver
// POST /:id/pagos ahí), pero también se pueden cargar sueltos acá.
// -----------------------------------------------------------------------

router.get('/cheques', authOperar, async (req, res) => {
  try {
    const match = {};
    if (req.query.tipo) match.tipo = req.query.tipo;
    if (req.query.estado) match.estado = req.query.estado;
    if (req.query.desde || req.query.hasta) {
      match.fechaVencimiento = {};
      if (req.query.desde) match.fechaVencimiento.$gte = new Date(req.query.desde);
      if (req.query.hasta) match.fechaVencimiento.$lte = new Date(req.query.hasta + 'T23:59:59');
    }
    const cheques = await conReintento(async () => (await getDb()).collection('cheques').find(match).sort({ fechaVencimiento: 1 }).limit(500).toArray());
    res.json(cheques);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/cheques', authOperar, async (req, res) => {
  try {
    const body = req.body || {};
    const tipo = normalizarTexto(body.tipo).toLowerCase();
    if (!['tercero', 'propio'].includes(tipo)) throw err(400, 'Tipo de cheque inválido (tercero o propio)');
    const monto = normalizarMontoPositivo(body.monto, 'El monto');
    const fechaVencimiento = body.fechaVencimiento ? new Date(body.fechaVencimiento) : null;
    if (!fechaVencimiento) throw err(400, 'La fecha de vencimiento es obligatoria');
    const moneda = normalizarTexto(body.moneda).toUpperCase() || 'ARS';
    if (!MONEDAS_VALIDAS.includes(moneda)) throw err(400, 'Moneda inválida (ARS o USD)');
    const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
    const ahora = new Date();
    const doc = {
      tipo, numero: normalizarTexto(body.numero),
      banco: normalizarTexto(body.banco),
      cuentaId: body.cuentaId ? toObjectId(body.cuentaId) : null,
      clienteId: body.clienteId ? toObjectId(body.clienteId) : null,
      clienteNombre: normalizarTexto(body.clienteNombre),
      proveedorId: body.proveedorId ? toObjectId(body.proveedorId) : null,
      proveedorNombre: normalizarTexto(body.proveedorNombre),
      ventaId: body.ventaId ? toObjectId(body.ventaId) : null,
      compraId: body.compraId ? toObjectId(body.compraId) : null,
      librador: normalizarTexto(body.librador),
      // CUIT del librador (2/10/2026, pedido de Mato: un cheque de tercero
      // tiene que poder guardar el CUIT de quien lo libró) — solo tiene
      // sentido para cheques de tercero; en uno propio el librador es
      // Piedra Negra mismo, no hace falta.
      cuitLibrador: tipo === 'tercero' ? normalizarTexto(body.cuitLibrador) : '',
      fechaEmision: body.fechaEmision ? new Date(body.fechaEmision) : ahora,
      fechaVencimiento, moneda, monto,
      estado: tipo === 'tercero' ? 'en_cartera' : 'emitido',
      depositadoEnCuentaId: null, endosadoA: '',
      observaciones: normalizarTexto(body.observaciones),
      usuarioNombre, fecha: ahora, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
    };
    const r = await conReintento(async () => (await getDb()).collection('cheques').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function buscarCheque(db, id) {
  const cheque = await db.collection('cheques').findOne({ _id: id });
  if (!cheque) throw err(404, 'Cheque no encontrado');
  return cheque;
}

// Depositar un cheque de tercero: pasa a "depositado" y genera el ingreso
// en el banco elegido (recién ahí es plata disponible de verdad).
router.post('/cheques/:id/depositar', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const cuentaId = toObjectId(req.body && req.body.cuentaId);
    // cuentaTipo 'banco' = depositar; 'caja' = cobrarlo en efectivo y mandarlo a una caja.
    const cuentaTipo = (req.body && req.body.cuentaTipo) === 'caja' ? 'caja' : 'banco';
    if (!cuentaId) throw err(400, cuentaTipo === 'caja' ? 'Elegí en qué caja lo cobrás' : 'Elegí en qué banco lo depositás');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cheque = await buscarCheque(db, id);
      if (cheque.tipo !== 'tercero') throw err(400, 'Solo se depositan cheques de terceros');
      if (cheque.estado !== 'en_cartera') throw err(400, `Este cheque ya está "${cheque.estado}", no se puede ${cuentaTipo === 'caja' ? 'cobrar' : 'depositar'}.`);
      await aplicarMovimientoCuenta(db, req, {
        cuentaTipo, cuentaId, tipo: 'ingreso', monto: cheque.monto, moneda: cheque.moneda,
        motivo: cuentaTipo === 'caja' ? 'Cobro de cheque de tercero en caja' : 'Depósito de cheque de tercero', observaciones: `Cheque ${cheque.numero || ''} — ${cheque.clienteNombre || ''}`.trim(),
        origen: 'cheque', ventaId: cheque.ventaId, chequeId: cheque._id
      });
      const ahora = new Date();
      await db.collection('cheques').updateOne({ _id: id }, { $set: { estado: cuentaTipo === 'caja' ? 'cobrado' : 'depositado', depositadoEnCuentaId: cuentaId, depositadoEnCuentaTipo: cuentaTipo, updatedAt: ahora } });
      return buscarCheque(db, id);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Rechazar un cheque. Si era de tercero y ya estaba depositado, revierte
// el ingreso bancario (egreso). Si era propio y ya estaba pagado, revierte
// el egreso (ingreso). En cualquier otro estado previo, solo cambia el
// estado (todavía no había movido plata).
router.post('/cheques/:id/rechazar', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = normalizarTexto(req.body && req.body.motivo);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cheque = await buscarCheque(db, id);
      if (cheque.estado === 'rechazado' || cheque.estado === 'anulado') throw err(400, `Este cheque ya está "${cheque.estado}".`);
      if (cheque.tipo === 'tercero' && (cheque.estado === 'depositado' || cheque.estado === 'cobrado')) {
        await aplicarMovimientoCuenta(db, req, {
          cuentaTipo: cheque.depositadoEnCuentaTipo || 'banco', cuentaId: cheque.depositadoEnCuentaId, tipo: 'egreso', monto: cheque.monto, moneda: cheque.moneda,
          motivo: 'Rechazo de cheque de tercero depositado', observaciones: `Cheque ${cheque.numero || ''}`.trim(),
          origen: 'cheque', ventaId: cheque.ventaId, chequeId: cheque._id
        });
      }
      if (cheque.tipo === 'propio' && cheque.estado === 'pagado') {
        await aplicarMovimientoCuenta(db, req, {
          cuentaTipo: 'banco', cuentaId: cheque.cuentaId, tipo: 'ingreso', monto: cheque.monto, moneda: cheque.moneda,
          motivo: 'Rechazo de cheque propio ya pagado', observaciones: `Cheque ${cheque.numero || ''}`.trim(),
          origen: 'cheque', compraId: cheque.compraId, chequeId: cheque._id
        });
      }
      const ahora = new Date();
      await db.collection('cheques').updateOne({ _id: id }, { $set: { estado: 'rechazado', observaciones: (cheque.observaciones ? cheque.observaciones + ' — ' : '') + 'Rechazado: ' + motivo, updatedAt: ahora } });
      return buscarCheque(db, id);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Endosar un cheque de tercero (entregarlo para pagarle a alguien, sin
// pasar por banco) — no mueve caja/banco, solo cambia el estado.
router.post('/cheques/:id/endosar', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const endosadoA = normalizarTexto(req.body && req.body.endosadoA);
    if (!endosadoA) throw err(400, 'Decí a quién se lo entregaste');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cheque = await buscarCheque(db, id);
      if (cheque.tipo !== 'tercero') throw err(400, 'Solo se endosan cheques de terceros');
      if (cheque.estado !== 'en_cartera') throw err(400, `Este cheque ya está "${cheque.estado}", no se puede endosar.`);
      await db.collection('cheques').updateOne({ _id: id }, { $set: { estado: 'endosado', endosadoA, updatedAt: new Date() } });
      return buscarCheque(db, id);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Confirmar el pago de un cheque propio (el banco lo debitó de verdad) —
// recién acá genera el egreso real.
router.post('/cheques/:id/confirmar-pago', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cheque = await buscarCheque(db, id);
      if (cheque.tipo !== 'propio') throw err(400, 'Esta acción es solo para cheques propios');
      if (cheque.estado !== 'emitido') throw err(400, `Este cheque ya está "${cheque.estado}".`);
      if (!cheque.cuentaId) throw err(400, 'Este cheque no tiene un banco propio asignado — no se puede confirmar.');
      await aplicarMovimientoCuenta(db, req, {
        cuentaTipo: 'banco', cuentaId: cheque.cuentaId, tipo: 'egreso', monto: cheque.monto, moneda: cheque.moneda,
        motivo: 'Pago de cheque propio', observaciones: `Cheque ${cheque.numero || ''} — ${cheque.proveedorNombre || ''}`.trim(),
        origen: 'cheque', compraId: cheque.compraId, chequeId: cheque._id
      });
      const ahora = new Date();
      await db.collection('cheques').updateOne({ _id: id }, { $set: { estado: 'pagado', updatedAt: ahora } });
      return buscarCheque(db, id);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anular un cheque antes de que haya movido plata (en_cartera/emitido).
router.post('/cheques/:id/anular', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cheque = await buscarCheque(db, id);
      if (!['en_cartera', 'emitido'].includes(cheque.estado)) throw err(400, `Este cheque ya está "${cheque.estado}", no se puede anular directamente — usá "Rechazar" si ya movió plata.`);
      await db.collection('cheques').updateOne({ _id: id }, { $set: { estado: 'anulado', updatedAt: new Date() } });
      return buscarCheque(db, id);
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
