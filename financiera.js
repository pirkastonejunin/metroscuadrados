// ---------------------------------------------------------------------------
// Financiera (14/10/2026, pedido de Mato). Una financiera le entrega cheques de terceros; Mato se los da a sus proveedores y
// después le paga a la financiera en efectivo, por un importe MENOR al nominal según la tasa pactada por operación y el plazo de
// cada cheque. La diferencia (nominal - efectivo) es la "ganancia financiera" y va al Estado de resultados.
//
// Modelo:
//   financiera_operaciones: una operación = un lote de cheques recibidos con una tasa mensual. Guarda los cheques (que también
//     existen en la colección `cheques`, con origenFinanciera:true), el nominal, el efectivo pactado (lo que se le debe pagar) y
//     la ganancia. Un cheque rechazado se devuelve a la financiera: baja lo que se le debe por el costo de ESE cheque.
//   financiera_pagos: pagos parciales en efectivo (salen de una caja o banco de Tesorería). El saldo es
//     SUM(efectivo pactado - rechazos) - SUM(pagos). Los pagos se imputan a las operaciones más viejas primero (solo para mostrar).
// No toca Ventas. Módulo 'tesoreria'.
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, filtroOrgClientes } = require('./usuarios');
const { aplicarMovimientoCuenta } = require('./tesoreria');

const { leerChequesConIA, registrarRutasFacturaIA } = require('./facturaIA');
const gastosRouter = require('./gastos');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authOperar = [authUsuario, resolverOrg, requiereModulo('tesoreria')];
let mongoClient, mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(() => { mongoClient = nuevo; mongoConectando = null; }, (e) => { mongoConectando = null; throw e; });
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) { try { return await fn(); } catch (e) { if (e && e.status) throw e; mongoClient = null; return await fn(); } }
function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { const e = new Error(message); e.status = status; return e; }
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const txt = v => String(v == null ? '' : v).trim();
const DIA = 86400000;

function fechaDe(v, porDefecto) {
  if (!v) return porDefecto || new Date();
  const d = new Date(v);
  if (isNaN(d.getTime())) throw err(400, 'Fecha inválida');
  return d;
}
// Efectivo equivalente de un cheque a una tasa mensual simple: nominal / (1 + tasa × días / 30).
function costoCheque(monto, tasaMensual, dias) {
  return r2(monto / (1 + (tasaMensual / 100) * (Math.max(0, dias) / 30)));
}
function diasHasta(venc, desde) { return Math.max(0, Math.round((new Date(venc).getTime() - new Date(desde).getTime()) / DIA)); }

// Arma los ítems de una operación (sin guardar): días, costo teórico y costo asignado (si se pactó otro efectivo, se reparte proporcional).
// modo 'mensual': tasa mensual simple por los días de cada cheque. modo 'directa': descuento fijo sobre el nominal, sin importar el plazo.
function calcularOperacion(chequesRaw, tasa, fecha, efectivoPactadoRaw, modo) {
  modo = modo === 'directa' ? 'directa' : 'mensual';
  const tasaMensual = tasa;
  if (!Array.isArray(chequesRaw) || !chequesRaw.length) throw err(400, 'Cargá al menos un cheque.');
  if (!(tasa >= 0)) throw err(400, 'La tasa tiene que ser un número mayor o igual a 0.');
  if (modo === 'directa' && tasa >= 100) throw err(400, 'La tasa directa tiene que ser menor a 100%.');
  const items = chequesRaw.map((c, i) => {
    const monto = Number(c.monto);
    if (!(monto > 0)) throw err(400, `El cheque ${i + 1} necesita un monto mayor a 0.`);
    if (!c.fechaVencimiento) throw err(400, `El cheque ${i + 1} necesita fecha de vencimiento.`);
    const venc = fechaDe(c.fechaVencimiento);
    const dias = diasHasta(venc, fecha);
    return { numero: txt(c.numero), banco: txt(c.banco), librador: txt(c.librador), cuitLibrador: txt(c.cuitLibrador), monto: r2(monto), fechaVencimiento: venc, dias, costoTeorico: modo === 'directa' ? r2(monto * (1 - tasa / 100)) : costoCheque(monto, tasaMensual, dias) };
  });
  const nominal = r2(items.reduce((s, x) => s + x.monto, 0));
  const efectivoSugerido = r2(items.reduce((s, x) => s + x.costoTeorico, 0));
  let efectivoPactado = efectivoSugerido;
  if (efectivoPactadoRaw !== undefined && efectivoPactadoRaw !== null && efectivoPactadoRaw !== '') {
    efectivoPactado = Number(efectivoPactadoRaw);
    if (!(efectivoPactado > 0)) throw err(400, 'El efectivo pactado tiene que ser mayor a 0.');
    if (efectivoPactado > nominal + 0.005) throw err(400, 'El efectivo pactado no puede superar el nominal de los cheques.');
    efectivoPactado = r2(efectivoPactado);
  }
  let acumulado = 0;
  items.forEach((x, i) => {
    if (i === items.length - 1) x.costoAsignado = r2(efectivoPactado - acumulado);
    else { x.costoAsignado = r2(efectivoPactado * (efectivoSugerido ? x.costoTeorico / efectivoSugerido : 1 / items.length)); acumulado += x.costoAsignado; }
  });
  const ganancia = r2(nominal - efectivoPactado);
  return { items, nominal, efectivoSugerido, efectivoPactado, ganancia, gananciaPct: nominal ? r2(ganancia / nominal * 100) : 0 };
}

// Lectura de cheques con IA: foto o PDF de uno o varios cheques → datos para completar la operación.
router.post('/leer-cheques', authOperar, async (req, res) => {
  try {
    const b = req.body || {};
    res.json(await leerChequesConIA({ base64: b.archivoBase64, mimeType: b.mimeType, nombreArchivo: b.nombreArchivo }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

function leerTasa(b) {
  const modo = b.tasaModo === 'directa' ? 'directa' : 'mensual';
  const valor = Number(b.tasaValor !== undefined && b.tasaValor !== '' ? b.tasaValor : b.tasaMensual);
  return { modo, valor };
}

// Vista previa del cálculo (para la pantalla, mientras se cargan los cheques).
router.post('/calcular', authOperar, async (req, res) => {
  try {
    const b = req.body || {};
    const fecha = fechaDe(b.fecha);
    const t = leerTasa(b);
    const c = calcularOperacion(b.cheques, t.valor || 0, fecha, b.efectivoPactado, t.modo);
    res.json({ nominal: c.nominal, efectivoSugerido: c.efectivoSugerido, efectivoPactado: c.efectivoPactado, ganancia: c.ganancia, gananciaPct: c.gananciaPct, items: c.items.map(x => ({ dias: x.dias, costo: x.costoAsignado })) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/operaciones', authOperar, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué sucursal estás trabajando.');
    const b = req.body || {};
    const fecha = fechaDe(b.fecha);
    const t = leerTasa(b);
    const calc = calcularOperacion(b.cheques, t.valor, fecha, b.efectivoPactado, t.modo);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const ultima = await db.collection('financiera_operaciones').find(filtroOrg(req)).sort({ numero: -1 }).limit(1).toArray();
      const numero = (ultima[0] && ultima[0].numero || 0) + 1;
      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
      const op = {
        numero, fecha, tasaModo: t.modo, tasaValor: t.valor, tasaMensual: t.modo === 'mensual' ? t.valor : null, nominal: calc.nominal, efectivoSugerido: calc.efectivoSugerido, efectivoPactado: calc.efectivoPactado,
        ganancia: calc.ganancia, items: [], rechazos: [], observaciones: txt(b.observaciones), anulada: false,
        usuarioNombre, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
      };
      const { insertedId } = await db.collection('financiera_operaciones').insertOne(op);
      for (const it of calc.items) {
        const cheque = {
          tipo: 'tercero', numero: it.numero, banco: it.banco, cuentaId: null, clienteId: null, clienteNombre: '', proveedorId: null, proveedorNombre: '',
          ventaId: null, compraId: null, librador: it.librador, cuitLibrador: it.cuitLibrador, fechaEmision: fecha, fechaVencimiento: it.fechaVencimiento,
          moneda: 'ARS', monto: it.monto, estado: 'en_cartera', depositadoEnCuentaId: null, endosadoA: '',
          observaciones: `Financiera — operación #${numero}`, origenFinanciera: true, financieraOperacionId: insertedId,
          usuarioNombre, fecha: ahora, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
        };
        const r = await db.collection('cheques').insertOne(cheque);
        op.items.push(Object.assign({ chequeId: r.insertedId }, it));
      }
      await db.collection('financiera_operaciones').updateOne({ _id: insertedId }, { $set: { items: op.items } });
      op._id = insertedId;
      return op;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Editar una operación ya cargada (tasa, fecha, efectivo pactado, observaciones y cheques). Los cheques con chequeId se actualizan, los
// sin chequeId se agregan y los que ya no están en la lista se quitan (solo si siguen en cartera). No se edita si ya hay cheques devueltos.
router.put('/operaciones/:id', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const fecha = fechaDe(b.fecha);
    const t = leerTasa(b);
    const calc = calcularOperacion(b.cheques, t.valor, fecha, b.efectivoPactado, t.modo);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const op = await db.collection('financiera_operaciones').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!op) throw err(404, 'Operación no encontrada');
      if (op.anulada) throw err(400, 'Esta operación está anulada.');
      if ((op.rechazos || []).length) throw err(400, 'La operación tiene cheques devueltos a la financiera: ya no se puede editar.');
      const actuales = await db.collection('cheques').find({ _id: { $in: op.items.map(i => i.chequeId) } }).toArray();
      const porId = new Map(actuales.map(c => [String(c._id), c]));
      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
      const items = [];
      const mantenidos = new Set();
      // 1) validar todo antes de escribir
      b.cheques.forEach((raw, idx) => {
        if (!raw.chequeId) return;
        const ch = porId.get(String(raw.chequeId));
        if (!ch) throw err(400, `El cheque ${idx + 1} no pertenece a esta operación.`);
        const libre = ['en_cartera', 'endosado'].includes(ch.estado);
        const it = calc.items[idx];
        if (!libre && (Math.abs(ch.monto - it.monto) > 0.005 || new Date(ch.fechaVencimiento).getTime() !== it.fechaVencimiento.getTime())) {
          throw err(400, `El cheque Nº ${ch.numero || '(s/n)'} ya está "${ch.estado}": no se puede cambiar su monto ni su vencimiento.`);
        }
        mantenidos.add(String(ch._id));
      });
      for (const ch of actuales) if (!mantenidos.has(String(ch._id)) && ch.estado !== 'en_cartera') throw err(400, `El cheque Nº ${ch.numero || '(s/n)'} ya está "${ch.estado}": no se puede quitar de la operación.`);
      // 2) escribir
      for (let idx = 0; idx < b.cheques.length; idx++) {
        const raw = b.cheques[idx], it = calc.items[idx];
        let chequeId;
        if (raw.chequeId) {
          chequeId = toObjectId(raw.chequeId);
          await db.collection('cheques').updateOne({ _id: chequeId }, { $set: { numero: it.numero, banco: it.banco, librador: it.librador, cuitLibrador: it.cuitLibrador, monto: it.monto, fechaVencimiento: it.fechaVencimiento, fechaEmision: fecha, updatedAt: ahora } });
        } else {
          const cheque = {
            tipo: 'tercero', numero: it.numero, banco: it.banco, cuentaId: null, clienteId: null, clienteNombre: '', proveedorId: null, proveedorNombre: '',
            ventaId: null, compraId: null, librador: it.librador, cuitLibrador: it.cuitLibrador, fechaEmision: fecha, fechaVencimiento: it.fechaVencimiento,
            moneda: 'ARS', monto: it.monto, estado: 'en_cartera', depositadoEnCuentaId: null, endosadoA: '',
            observaciones: `Financiera — operación #${op.numero}`, origenFinanciera: true, financieraOperacionId: op._id,
            usuarioNombre, fecha: ahora, orgId: op.orgId, createdAt: ahora, updatedAt: ahora
          };
          chequeId = (await db.collection('cheques').insertOne(cheque)).insertedId;
        }
        items.push(Object.assign({ chequeId }, it));
      }
      const quitados = actuales.filter(c => !mantenidos.has(String(c._id))).map(c => c._id);
      if (quitados.length) await db.collection('cheques').updateMany({ _id: { $in: quitados } }, { $set: { estado: 'anulado', observaciones: 'Quitado de la operación de la financiera', updatedAt: ahora } });
      await db.collection('financiera_operaciones').updateOne({ _id: id }, { $set: {
        fecha, tasaModo: t.modo, tasaValor: t.valor, tasaMensual: t.modo === 'mensual' ? t.valor : null, nominal: calc.nominal, efectivoSugerido: calc.efectivoSugerido, efectivoPactado: calc.efectivoPactado, ganancia: calc.ganancia,
        items, observaciones: txt(b.observaciones), updatedAt: ahora } });
      return { ok: true };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anular una operación: solo si ninguno de sus cheques salió de cartera y no hay rechazos.
router.post('/operaciones/:id/anular', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const op = await db.collection('financiera_operaciones').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!op) throw err(404, 'Operación no encontrada');
      if (op.anulada) throw err(400, 'Esta operación ya está anulada.');
      if ((op.rechazos || []).length) throw err(400, 'La operación tiene cheques rechazados: no se puede anular.');
      const cheques = await db.collection('cheques').find({ _id: { $in: op.items.map(i => i.chequeId) } }).toArray();
      const fuera = cheques.find(c => c.estado !== 'en_cartera');
      if (fuera) throw err(400, `El cheque Nº ${fuera.numero || '(s/n)'} ya está "${fuera.estado}": no se puede anular la operación.`);
      await db.collection('cheques').updateMany({ _id: { $in: cheques.map(c => c._id) } }, { $set: { estado: 'anulado', updatedAt: new Date() } });
      await db.collection('financiera_operaciones').updateOne({ _id: id }, { $set: { anulada: true, anuladaEn: new Date(), updatedAt: new Date() } });
      return { ok: true };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Pago parcial en efectivo a la financiera: sale de una caja (o banco) de Tesorería.
router.post('/pagos', authOperar, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué sucursal estás trabajando.');
    const b = req.body || {};
    const monto = Number(b.monto);
    if (!(monto > 0)) throw err(400, 'El monto tiene que ser mayor a 0.');
    const cuentaTipo = txt(b.cuentaTipo).toLowerCase() || 'caja';
    const cuentaId = toObjectId(b.cuentaId);
    if (!cuentaId) throw err(400, 'Elegí de qué caja sale el efectivo.');
    const fecha = fechaDe(b.fecha);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const mov = await aplicarMovimientoCuenta(db, req, {
        cuentaTipo, cuentaId, tipo: 'egreso', monto: r2(monto), moneda: 'ARS', motivo: 'Pago a financiera',
        observaciones: txt(b.nota), origen: 'financiera', fecha
      });
      const ahora = new Date();
      const pago = { fecha, monto: r2(monto), cuentaTipo, cuentaId, movimientoId: mov._id, nota: txt(b.nota), anulado: false, usuarioNombre: (req.usuario && req.usuario.nombre) || '', orgId: req.orgId, createdAt: ahora };
      const r = await db.collection('financiera_pagos').insertOne(pago);
      pago._id = r.insertedId;
      return pago;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/pagos/:id/anular', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const pago = await db.collection('financiera_pagos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!pago) throw err(404, 'Pago no encontrado');
      if (pago.anulado) throw err(400, 'Este pago ya está anulado.');
      await aplicarMovimientoCuenta(db, req, {
        cuentaTipo: pago.cuentaTipo, cuentaId: pago.cuentaId, tipo: 'ingreso', monto: pago.monto, moneda: 'ARS',
        motivo: 'Anulación de pago a financiera', observaciones: txt(pago.nota), origen: 'financiera'
      });
      await db.collection('financiera_pagos').updateOne({ _id: id }, { $set: { anulado: true, anuladoEn: new Date() } });
      return { ok: true };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Cheque rechazado: se devuelve a la financiera. Baja lo que se le debe por el costo de ESE cheque (y la ganancia de ese cheque se revierte).
// Cómo lo cubre la financiera: con otro valor (se carga como una operación nueva) o con efectivo (ingreso manual en Tesorería).
router.post('/cheques/:id/rechazo', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = txt(req.body && req.body.motivo);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const cheque = await db.collection('cheques').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!cheque || !cheque.origenFinanciera) throw err(404, 'Ese cheque no viene de la financiera.');
      if (['depositado', 'cobrado'].includes(cheque.estado)) throw err(400, `El cheque está "${cheque.estado}": primero rechazalo en Tesorería para revertir el depósito.`);
      if (cheque.estado === 'anulado') throw err(400, 'El cheque está anulado.');
      const op = await db.collection('financiera_operaciones').findOne({ _id: cheque.financieraOperacionId });
      if (!op || op.anulada) throw err(400, 'La operación de este cheque no está vigente.');
      if ((op.rechazos || []).some(x => String(x.chequeId) === String(id))) throw err(400, 'Este cheque ya fue devuelto a la financiera.');
      const item = (op.items || []).find(x => String(x.chequeId) === String(id));
      if (!item) throw err(400, 'No se encontró el cheque dentro de la operación.');
      const ahora = new Date();
      const rechazo = { chequeId: id, fecha: ahora, costo: item.costoAsignado, ganancia: r2(item.monto - item.costoAsignado), motivo };
      if (cheque.estado !== 'rechazado') {
        await db.collection('cheques').updateOne({ _id: id }, { $set: { estado: 'rechazado', observaciones: ((cheque.observaciones ? cheque.observaciones + ' — ' : '') + 'Devuelto a la financiera' + (motivo ? ': ' + motivo : '')), updatedAt: ahora } });
      }
      await db.collection('financiera_operaciones').updateOne({ _id: op._id }, { $push: { rechazos: rechazo }, $set: { updatedAt: ahora } });
      return rechazo;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Saldo y listados. Los pagos se imputan a las operaciones más viejas primero.
async function armarResumen(db, req) {
  const f = filtroOrg(req);
  const [ops, pagos] = await Promise.all([
    db.collection('financiera_operaciones').find(f).sort({ fecha: 1, numero: 1 }).toArray(),
    db.collection('financiera_pagos').find(f).sort({ fecha: -1, createdAt: -1 }).toArray()
  ]);
  const chequeIds = ops.flatMap(o => (o.items || []).map(i => i.chequeId));
  const cheques = chequeIds.length ? await db.collection('cheques').find({ _id: { $in: chequeIds } }).toArray() : [];
  const chPorId = new Map(cheques.map(c => [String(c._id), c]));
  const vigentes = ops.filter(o => !o.anulada);
  let restoPagos = r2(pagos.filter(p => !p.anulado).reduce((s, p) => s + p.monto, 0));
  const operaciones = vigentes.map(o => {
    const rech = (o.rechazos || []);
    const rechCosto = r2(rech.reduce((s, x) => s + x.costo, 0)), rechGan = r2(rech.reduce((s, x) => s + x.ganancia, 0));
    const debe = r2(o.efectivoPactado - rechCosto);
    const imputado = Math.min(debe, restoPagos); restoPagos = r2(restoPagos - imputado);
    const nominalVigente = r2(o.nominal - rech.reduce((s, x) => { const it = (o.items || []).find(i => String(i.chequeId) === String(x.chequeId)); return s + (it ? it.monto : 0); }, 0));
    const gananciaNeta = r2(o.ganancia - rechGan);
    return {
      _id: o._id, numero: o.numero, fecha: o.fecha, tasaModo: o.tasaModo || 'mensual', tasaValor: o.tasaValor !== undefined ? o.tasaValor : o.tasaMensual, observaciones: o.observaciones || '', efectivoSugerido: o.efectivoSugerido, editable: rech.length === 0,
      nominal: o.nominal, nominalVigente, efectivoPactado: o.efectivoPactado, rechazado: rechCosto, debe, pagado: imputado, pendiente: r2(debe - imputado),
      ganancia: gananciaNeta, gananciaPct: nominalVigente ? r2(gananciaNeta / nominalVigente * 100) : 0,
      items: (o.items || []).map(i => {
        const c = chPorId.get(String(i.chequeId)) || {};
        const dev = rech.some(x => String(x.chequeId) === String(i.chequeId));
        return { chequeId: i.chequeId, numero: i.numero, banco: i.banco, librador: i.librador, cuitLibrador: i.cuitLibrador || '', libre: ['en_cartera', 'endosado'].includes(c.estado), monto: i.monto, fechaVencimiento: i.fechaVencimiento, dias: i.dias, costo: i.costoAsignado, estado: dev ? 'devuelto' : (c.estado || ''), endosadoA: c.endosadoA || '' };
      })
    };
  });
  const saldo = r2(operaciones.reduce((s, o) => s + o.pendiente, 0) - restoPagos); // restoPagos > 0 = pagado de más (a favor)
  const total = {
    saldo, nominal: r2(operaciones.reduce((s, o) => s + o.nominalVigente, 0)), efectivoPactado: r2(operaciones.reduce((s, o) => s + o.debe, 0)),
    pagado: r2(pagos.filter(p => !p.anulado).reduce((s, p) => s + p.monto, 0)), ganancia: r2(operaciones.reduce((s, o) => s + o.ganancia, 0))
  };
  total.gananciaPct = total.nominal ? r2(total.ganancia / total.nominal * 100) : 0;
  return { total, operaciones: operaciones.reverse(), pagos };
}
router.get('/resumen', authOperar, async (req, res) => {
  try { res.json(await conReintento(async () => armarResumen(await getDb(), req))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Préstamos (16/10/2026, pedido de Mato). Un crédito que se paga todos los meses con una liquidación del acreedor, que trae:
//   · una factura por los INTERESES (con IVA) → se carga como un Gasto fiscal (concepto "Gastos financieros · Intereses de
//     préstamos"), así entra solo al Libro IVA Compras (crédito fiscal) y al Estado de resultados como gasto financiero;
//   · el CAPITAL de la cuota → NO es gasto: baja el saldo del crédito.
// Colecciones: prestamos (el crédito: monto total, acreedor = un proveedor) y prestamo_liquidaciones (una por mes: interés neto, IVA,
// capital, factura/gasto asociado y de dónde se pagó). Saldo del crédito = monto total − Σ capital de las liquidaciones no anuladas.
// Pagar una liquidación saca de una caja/banco de Tesorería: el total de la factura (se registra como pago del gasto) y el capital.
// ---------------------------------------------------------------------------
const CONCEPTO_INTERES = 'Gastos financieros · Intereses de préstamos';
// Lectura de facturas con IA (la misma de Gastos): para completar la liquidación desde el PDF que manda el acreedor.
registrarRutasFacturaIA(router, { modo: 'gastos', authAdmin: authOperar, getDb, conReintento, filtroOrg });

function periodoDe(fecha) { const x = new Date(new Date(fecha).getTime() - 3 * 3600 * 1000); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; }
function resumenPrestamo(p, liqs) {
  const vig = liqs.filter(l => !l.anulada);
  const capitalPagado = r2(vig.reduce((s, l) => s + (l.capital || 0), 0));
  return Object.assign({}, p, {
    capitalPagado, saldoCapital: r2((p.montoTotal || 0) - capitalPagado),
    interesNeto: r2(vig.reduce((s, l) => s + (l.interesNeto || 0), 0)), iva: r2(vig.reduce((s, l) => s + (l.iva || 0), 0)),
    cuotas: vig.length, pendientePago: r2(vig.filter(l => !l.pagada).reduce((s, l) => s + (l.totalAPagar || 0), 0)),
    liquidaciones: liqs.slice().sort((a, b) => (b.periodo || '').localeCompare(a.periodo || '') || new Date(b.fecha) - new Date(a.fecha))
  });
}

router.get('/prestamos', authOperar, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const f = filtroOrg(req);
      const [prestamos, liqs] = await Promise.all([
        db.collection('prestamos').find(f).sort({ createdAt: -1 }).toArray(),
        db.collection('prestamo_liquidaciones').find(f).sort({ fecha: 1, createdAt: 1 }).toArray()
      ]);
      const lista = prestamos.map(p => resumenPrestamo(p, liqs.filter(l => String(l.prestamoId) === String(p._id))));
      const vig = lista.filter(p => p.estado !== 'cancelado');
      const total = {
        montoTotal: r2(vig.reduce((s, p) => s + p.montoTotal, 0)), capitalPagado: r2(vig.reduce((s, p) => s + p.capitalPagado, 0)),
        saldoCapital: r2(vig.reduce((s, p) => s + p.saldoCapital, 0)), interesNeto: r2(vig.reduce((s, p) => s + p.interesNeto, 0)),
        iva: r2(vig.reduce((s, p) => s + p.iva, 0)), pendientePago: r2(vig.reduce((s, p) => s + p.pendientePago, 0))
      };
      return { total, prestamos: lista, conceptoInteres: CONCEPTO_INTERES };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Proveedores para elegir el acreedor (Financiera puede no tener el módulo Gastos, por eso no se usa /api/gastos/proveedores).
router.get('/prestamos/proveedores', authOperar, async (req, res) => {
  try {
    const lista = await conReintento(async () => (await getDb()).collection('proveedores')
      .find(Object.assign({ activo: { $ne: false } }, filtroOrgClientes(req))).project({ razonSocial: 1, nombreFantasia: 1, cuit: 1 }).sort({ razonSocial: 1 }).limit(3000).toArray());
    res.json(lista.map(p => ({ _id: p._id, nombre: p.razonSocial || p.nombreFantasia || '', cuit: p.cuit || '' })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/prestamos', authOperar, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué sucursal estás trabajando.');
    const b = req.body || {};
    const nombre = txt(b.nombre);
    if (!nombre) throw err(400, 'Poné un nombre para el préstamo (por ejemplo "Crédito FONDEP").');
    const proveedorId = toObjectId(b.proveedorId);
    if (!proveedorId) throw err(400, 'Elegí el acreedor: es el proveedor que te manda la factura de intereses.');
    const montoTotal = Number(b.montoTotal);
    if (!(montoTotal > 0)) throw err(400, 'El monto total del crédito tiene que ser mayor a 0.');
    const doc = await conReintento(async () => {
      const db = await getDb();
      const prov = await db.collection('proveedores').findOne(Object.assign({ _id: proveedorId }, filtroOrgClientes(req)));
      if (!prov) throw err(400, 'El acreedor no existe (o no pertenece a esta sucursal).');
      const d = {
        orgId: req.orgId, nombre, proveedorId, proveedorNombre: prov.razonSocial || prov.nombreFantasia || '', montoTotal: r2(montoTotal),
        fechaOtorgamiento: b.fechaOtorgamiento ? fechaDe(b.fechaOtorgamiento) : null, nota: txt(b.nota), estado: 'vigente',
        usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: new Date()
      };
      d._id = (await db.collection('prestamos').insertOne(d)).insertedId;
      return d;
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/prestamos/:id', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    await conReintento(async () => {
      const db = await getDb();
      const p = await db.collection('prestamos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!p) throw err(404, 'Préstamo no encontrado');
      const liqs = await db.collection('prestamo_liquidaciones').find({ prestamoId: id, anulada: { $ne: true } }).toArray();
      const capitalPagado = r2(liqs.reduce((s, l) => s + (l.capital || 0), 0));
      const set = {};
      if (b.nombre !== undefined) { if (!txt(b.nombre)) throw err(400, 'El nombre no puede quedar vacío.'); set.nombre = txt(b.nombre); }
      if (b.montoTotal !== undefined) {
        const m = Number(b.montoTotal);
        if (!(m > 0)) throw err(400, 'El monto total tiene que ser mayor a 0.');
        if (m + 0.005 < capitalPagado) throw err(400, `El monto total no puede ser menor al capital ya pagado (${capitalPagado}).`);
        set.montoTotal = r2(m);
      }
      if (b.nota !== undefined) set.nota = txt(b.nota);
      if (b.fechaOtorgamiento !== undefined) set.fechaOtorgamiento = b.fechaOtorgamiento ? fechaDe(b.fechaOtorgamiento) : null;
      if (b.estado !== undefined) { if (!['vigente', 'cancelado'].includes(b.estado)) throw err(400, 'Estado inválido.'); set.estado = b.estado; }
      if (b.proveedorId !== undefined && String(b.proveedorId) !== String(p.proveedorId)) {
        if (liqs.length) throw err(400, 'No se puede cambiar el acreedor de un préstamo que ya tiene liquidaciones.');
        const prov = await db.collection('proveedores').findOne(Object.assign({ _id: toObjectId(b.proveedorId) }, filtroOrgClientes(req)));
        if (!prov) throw err(400, 'El acreedor no existe.');
        set.proveedorId = prov._id; set.proveedorNombre = prov.razonSocial || prov.nombreFantasia || '';
      }
      await db.collection('prestamos').updateOne({ _id: id }, { $set: Object.assign(set, { updatedAt: new Date() }) });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/prestamos/:id/eliminar', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const p = await db.collection('prestamos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!p) throw err(404, 'Préstamo no encontrado');
      if (await db.collection('prestamo_liquidaciones').findOne({ prestamoId: id, anulada: { $ne: true } })) throw err(400, 'Tiene liquidaciones cargadas: anulalas primero (o marcá el préstamo como cancelado).');
      await db.collection('prestamo_liquidaciones').deleteMany({ prestamoId: id });
      await db.collection('prestamos').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Saca de una caja/banco el total de la factura de intereses (queda como pago del gasto) y el capital. Si algo falla, deshace lo hecho.
async function pagarLiquidacion(db, req, prestamo, liq, { cuentaTipo, cuentaId, fecha, nota }) {
  const hechos = [];
  try {
    if (liq.totalFactura > 0) {
      const m = await aplicarMovimientoCuenta(db, req, { cuentaTipo, cuentaId, tipo: 'egreso', monto: liq.totalFactura, moneda: 'ARS',
        motivo: `Pago gasto Nº ${liq.gastoNumero}`, observaciones: `Préstamo "${prestamo.nombre}" · intereses ${liq.periodo}`, origen: 'gasto', fecha });
      hechos.push({ concepto: 'intereses', monto: liq.totalFactura, movimientoId: m._id });
    }
    if (liq.capital > 0) {
      const m = await aplicarMovimientoCuenta(db, req, { cuentaTipo, cuentaId, tipo: 'egreso', monto: liq.capital, moneda: 'ARS',
        motivo: `Capital préstamo "${prestamo.nombre}" (${liq.periodo})`, observaciones: txt(nota), origen: 'prestamo', fecha });
      hechos.push({ concepto: 'capital', monto: liq.capital, movimientoId: m._id });
    }
  } catch (e) {
    for (const h of hechos) { try { await aplicarMovimientoCuenta(db, req, { cuentaTipo, cuentaId, tipo: 'ingreso', monto: h.monto, moneda: 'ARS', motivo: 'Se deshizo un pago de préstamo por un error', origen: 'prestamo' }); } catch (e2) { /* nada más que hacer */ } }
    throw e;
  }
  const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
  if (liq.gastoId && liq.totalFactura > 0) {
    const g = await db.collection('gastos').findOne({ _id: liq.gastoId });
    if (g) {
      const totalPagado = r2((g.totalPagado || 0) + liq.totalFactura);
      await db.collection('gastos').updateOne({ _id: g._id }, {
        $push: { pagos: { tipoValor: cuentaTipo === 'caja' ? 'efectivo' : 'cuenta', monto: liq.totalFactura, fecha, nota: `Liquidación préstamo "${prestamo.nombre}" ${liq.periodo}`, usuarioNombre, cuentaTipo, cuentaId } },
        $set: { totalPagado, saldoPendiente: Math.max(0, r2(g.total - totalPagado)), updatedAt: new Date() }
      });
    }
  }
  await db.collection('prestamo_liquidaciones').updateOne({ _id: liq._id }, { $set: { pagada: true, pagadaEn: fecha, cuentaTipo, cuentaId, pagos: hechos.map(h => Object.assign({ cuentaTipo, cuentaId, fecha }, h)) } });
}

router.post('/prestamos/:id/liquidaciones', authOperar, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué sucursal estás trabajando.');
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const fecha = fechaDe(b.fecha);
    const periodo = /^\d{4}-\d{2}$/.test(txt(b.periodo)) ? txt(b.periodo) : periodoDe(fecha);
    const interesNeto = r2(Number(b.interesNeto) || 0), capital = r2(Number(b.capital) || 0);
    if (interesNeto < 0 || capital < 0) throw err(400, 'Los importes no pueden ser negativos.');
    if (!(interesNeto > 0) && !(capital > 0)) throw err(400, 'Cargá el capital de la cuota, los intereses, o los dos.');
    const alicuotaIva = b.alicuotaIva === undefined || b.alicuotaIva === '' ? 21 : Number(b.alicuotaIva);
    const cuentaTipo = txt(b.cuentaTipo).toLowerCase();
    const cuentaId = b.cuentaId ? toObjectId(b.cuentaId) : null;
    if (b.cuentaId && (!cuentaId || !['caja', 'banco'].includes(cuentaTipo))) throw err(400, 'Caja o banco inválido.');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const prestamo = await db.collection('prestamos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!prestamo) throw err(404, 'Préstamo no encontrado');
      const previas = await db.collection('prestamo_liquidaciones').find({ prestamoId: id, anulada: { $ne: true } }).toArray();
      const saldo = r2(prestamo.montoTotal - previas.reduce((s, l) => s + (l.capital || 0), 0));
      if (capital > saldo + 0.005) throw err(400, `El capital de la cuota (${capital}) supera el saldo que queda del crédito (${saldo}).`);
      let gasto = null;
      if (interesNeto > 0) {
        gasto = await gastosRouter.crearGastoDesdeBody(req, {
          proveedorId: prestamo.proveedorId, tipoComprobante: txt(b.tipoComprobante) || 'factura_a', puntoVenta: b.puntoVenta, comprobanteNumero: b.comprobanteNumero,
          fecha: b.fechaComprobante || b.fecha, moneda: 'ARS', observaciones: `Préstamo "${prestamo.nombre}" · intereses ${periodo}`,
          items: [{ conceptoNombre: CONCEPTO_INTERES, cantidad: 1, precioUnitario: interesNeto, alicuotaIva, observaciones: `${prestamo.nombre} · ${periodo}` }]
        });
      }
      const totalFactura = gasto ? r2(gasto.total) : 0;
      const liq = {
        orgId: req.orgId, prestamoId: id, periodo, fecha, interesNeto, alicuotaIva, iva: gasto ? r2(gasto.importeIva) : 0, totalFactura, capital, totalAPagar: r2(capital + totalFactura),
        comprobante: gasto ? { tipoComprobante: gasto.tipoComprobante, puntoVenta: gasto.puntoVenta, comprobanteNumero: gasto.comprobanteNumero } : null,
        gastoId: gasto ? gasto._id : null, gastoNumero: gasto ? gasto.numero : null, pagada: false, pagos: [], anulada: false, nota: txt(b.nota),
        usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: new Date()
      };
      try {
        liq._id = (await db.collection('prestamo_liquidaciones').insertOne(liq)).insertedId;
        if (cuentaId) await pagarLiquidacion(db, req, prestamo, liq, { cuentaTipo, cuentaId, fecha: b.fechaPago ? fechaDe(b.fechaPago) : fecha, nota: b.nota });
      } catch (e) {
        // No se pudo completar: no deja la factura de intereses cargada a medias.
        if (liq._id) await db.collection('prestamo_liquidaciones').deleteOne({ _id: liq._id });
        if (gasto) await db.collection('gastos').updateOne({ _id: gasto._id }, { $set: { estado: 'anulada', anuladaEn: new Date(), anuladaMotivo: 'No se pudo completar la liquidación del préstamo' } });
        throw e;
      }
      return db.collection('prestamo_liquidaciones').findOne({ _id: liq._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/prestamos/liquidaciones/:id/pagar', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const cuentaTipo = txt(b.cuentaTipo).toLowerCase(), cuentaId = toObjectId(b.cuentaId);
    if (!cuentaId || !['caja', 'banco'].includes(cuentaTipo)) throw err(400, 'Elegí de qué caja o banco sale el pago.');
    await conReintento(async () => {
      const db = await getDb();
      const liq = await db.collection('prestamo_liquidaciones').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!liq) throw err(404, 'Liquidación no encontrada');
      if (liq.anulada) throw err(400, 'Esta liquidación está anulada.');
      if (liq.pagada) throw err(400, 'Esta liquidación ya está pagada.');
      const prestamo = await db.collection('prestamos').findOne({ _id: liq.prestamoId });
      await pagarLiquidacion(db, req, prestamo, liq, { cuentaTipo, cuentaId, fecha: fechaDe(b.fecha), nota: b.nota });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Anula la liquidación: el capital vuelve al saldo del crédito, la factura de intereses queda anulada (sale del Libro IVA y del
// Estado de resultados) y, si estaba pagada, la plata vuelve a la caja/banco.
router.post('/prestamos/liquidaciones/:id/anular', authOperar, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const liq = await db.collection('prestamo_liquidaciones').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!liq) throw err(404, 'Liquidación no encontrada');
      if (liq.anulada) throw err(400, 'Esta liquidación ya está anulada.');
      for (const p of (liq.pagos || [])) {
        await aplicarMovimientoCuenta(db, req, { cuentaTipo: p.cuentaTipo, cuentaId: p.cuentaId, tipo: 'ingreso', monto: p.monto, moneda: 'ARS',
          motivo: `Anulación de liquidación de préstamo (${p.concepto === 'capital' ? 'capital' : 'intereses'} ${liq.periodo})`, origen: 'prestamo' });
      }
      if (liq.gastoId) await db.collection('gastos').updateOne({ _id: liq.gastoId }, { $set: { estado: 'anulada', anuladaEn: new Date(), anuladaPor: (req.usuario && req.usuario.nombre) || '', anuladaMotivo: 'Anulación de la liquidación del préstamo', updatedAt: new Date() } });
      await db.collection('prestamo_liquidaciones').updateOne({ _id: id }, { $set: { anulada: true, anuladaEn: new Date() } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
