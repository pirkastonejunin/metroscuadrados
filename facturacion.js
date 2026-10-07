// ---------------------------------------------------------------------------
// Facturación por sucursal (7/10/2026, pedido de Mato) — tablero comparativo
// entre las sucursales (organizaciones) a las que el usuario tiene acceso:
//   1. Facturación del período (ventas netas de notas de crédito).
//   2. Cobros vs pagos del período.
//   3. Posición fiscal: IVA ventas (débito) - IVA compras (crédito).
//   4. Saldos de deuda a hoy: cuentas por cobrar - cuentas por pagar.
//
// Criterios (para que los números se puedan auditar):
//   - Facturación: ventas no anuladas con fecha en el período, total con IVA;
//     las notas de crédito restan. Las ventas en dólares van en pesos con la
//     cotización guardada en la venta.
//   - Cobros: créditos de la cuenta corriente de clientes por cobros de
//     ventas y cobros a cuenta (incluye las retenciones que cancelan deuda),
//     por fecha del cobro.
//   - Pagos: pagos a proveedores (compras_pagos) más pagos de gastos, por
//     fecha del pago. No se convierte moneda en los pagos (se suman como ARS).
//   - IVA ventas: el mismo criterio que el Libro IVA Ventas (comprobantes con
//     CAE, por fecha fiscal; en producción no cuenta lo emitido en
//     homologación). IVA compras: el del Libro IVA Compras (compras y gastos
//     fiscales, por fecha). Posición > 0 = IVA a pagar; < 0 = saldo a favor.
//     No incluye percepciones ni retenciones.
//   - Saldos: saldo pendiente de ventas (sin notas de crédito) menos el de
//     compras y gastos activos, a la fecha de hoy (no depende del período).
//
// Acceso: módulo 'tablero_facturacion' (el administrador lo ve siempre). Cada
// usuario ve solo las sucursales que tiene asignadas; el administrador, todas.
// No depende de la sucursal elegida arriba: compara todas.
//
// Integración (server.js):  app.use('/api/facturacion', require('./facturacion'));
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario } = require('./usuarios');
const emision = require('./fiscalEmision');

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
  catch (e) { mongoClient = null; return await fn(); }
}
function toObjectId(id) { try { return id ? new ObjectId(String(id)) : null; } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function responder(res, e) { res.status(e.status || 500).json({ error: e.message || 'Error' }); }
function r2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

const authFacturacion = [authUsuario, (req, res, next) => {
  const r = req.usuario.rol;
  if (!(r.protegido || (r.modulos || []).includes('tablero_facturacion'))) {
    return res.status(403).json({ error: 'Tu usuario no tiene acceso al tablero de facturación. Pedile a un administrador que te lo habilite.' });
  }
  next();
}];

function inicioDia(s) { return new Date(s + 'T00:00:00.000-03:00'); }
function finDia(s) { return new Date(s + 'T23:59:59.999-03:00'); }
function fechaAR(d) {
  const x = new Date(d.getTime() - 3 * 3600e3);
  return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
}
function validarFecha(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(inicioDia(s).getTime()); }

// Factor a pesos de una venta/compra en dólares.
const FACTOR_USD = { $cond: [{ $eq: ['$moneda', 'USD'] }, { $ifNull: ['$cotizacionDolar', 1] }, 1] };
const SIGNO_NC = { $cond: [{ $eq: ['$tipoComprobante', 'nota_credito'] }, -1, 1] };

async function orgsAccesibles(db, usuario) {
  if (usuario.rol.protegido) return db.collection('organizaciones').find({}).sort({ nombre: 1 }).toArray();
  const ids = (usuario.orgIds || []).map(toObjectId).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).sort({ nombre: 1 }).toArray();
}

async function sumar(col, pipeline) {
  const r = await col.aggregate(pipeline).toArray();
  return r[0] ? r[0].total : 0;
}

// IVA de un comprobante de compra/gasto (mismo cálculo que el Libro IVA Compras).
function ivaDeCompra(d) {
  const signo = /^nota_credito/.test(d.tipoComprobante) ? -1 : 1;
  const sub = (d.items || []).reduce((a, it) => a + Number(it.subtotal || 0), 0);
  let conDesc = sub;
  if (d.descuentoPorcentaje) conDesc -= conDesc * (d.descuentoPorcentaje / 100);
  if (d.descuentoMonto) conDesc -= d.descuentoMonto;
  const factor = sub > 0 ? Math.max(0, conDesc) / sub : 1;
  const iva = (d.items || []).reduce((a, it) => a + Number(it.importeIva || 0) * factor, 0);
  const usd = d.moneda === 'USD' && Number(d.cotizacionDolar) > 0 ? Number(d.cotizacionDolar) : 1;
  return signo * iva * usd;
}

async function resumenSucursal(db, org, d0, d1, desdeS, hastaS) {
  const orgId = org._id;
  const ventas = db.collection('ventas'), compras = db.collection('compras'), gastos = db.collection('gastos');
  const enRango = { $gte: d0, $lte: d1 };
  const sinAnular = { orgId, estado: { $ne: 'anulada' } };

  const [facturado, cobros, pagosCompras, pagosGastos, porCobrar, porPagarCompras, porPagarGastos, cfg, fiscales, comprasFiscales, gastosFiscales] = await Promise.all([
    sumar(ventas, [
      { $match: Object.assign({}, sinAnular, { fecha: enRango }) },
      { $group: { _id: null, total: { $sum: { $multiply: [{ $ifNull: ['$total', 0] }, SIGNO_NC, FACTOR_USD] } } } }
    ]),
    sumar(db.collection('cuenta_corriente_movimientos'), [
      { $match: { orgId, tipo: 'credito', origen: { $in: ['cobro_venta', 'cobro_cuenta'] }, fecha: enRango } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$monto', 0] } } } }
    ]),
    sumar(db.collection('compras_pagos'), [
      { $match: { orgId, fecha: enRango } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$monto', 0] } } } }
    ]),
    sumar(gastos, [
      { $match: sinAnular }, { $unwind: '$pagos' }, { $match: { 'pagos.fecha': enRango } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$pagos.monto', 0] } } } }
    ]),
    sumar(ventas, [
      { $match: Object.assign({}, sinAnular, { saldoPendiente: { $gt: 0 }, tipoComprobante: { $ne: 'nota_credito' } }) },
      { $group: { _id: null, total: { $sum: { $multiply: ['$saldoPendiente', FACTOR_USD] } } } }
    ]),
    sumar(compras, [
      { $match: Object.assign({}, sinAnular, { saldoPendiente: { $gt: 0 } }) },
      { $group: { _id: null, total: { $sum: { $multiply: ['$saldoPendiente', FACTOR_USD] } } } }
    ]),
    sumar(gastos, [
      { $match: Object.assign({}, sinAnular, { saldoPendiente: { $gt: 0 } }) },
      { $group: { _id: null, total: { $sum: '$saldoPendiente' } } }
    ]),
    emision.getConfig(db, orgId),
    ventas.find({ orgId, esFiscal: true, cae: { $exists: true }, estado: { $ne: 'anulada' }, fiscalFecha: { $gte: desdeS.replace(/-/g, ''), $lte: hastaS.replace(/-/g, '') } })
      .project({ tipoComprobante: 1, fiscal: 1, fiscalMoneda: 1, fiscalCotiz: 1, fiscalEntorno: 1 }).toArray(),
    compras.find({ orgId, esFiscal: true, estado: { $ne: 'anulada' }, fecha: enRango }).project({ items: 1, descuentoPorcentaje: 1, descuentoMonto: 1, tipoComprobante: 1, moneda: 1, cotizacionDolar: 1 }).toArray(),
    gastos.find({ orgId, esFiscal: true, estado: { $ne: 'anulada' }, fecha: enRango }).project({ items: 1, descuentoPorcentaje: 1, descuentoMonto: 1, tipoComprobante: 1, moneda: 1, cotizacionDolar: 1 }).toArray()
  ]);

  // IVA ventas: en producción no cuenta lo emitido en homologación.
  const ivaVentas = fiscales
    .filter(v => cfg.entorno !== 'produccion' || v.fiscalEntorno === 'produccion')
    .reduce((a, v) => {
      const signo = (v.tipoComprobante === 'nota_credito' ? -1 : 1) * ((v.fiscalMoneda === 'DOL' && Number(v.fiscalCotiz) > 0) ? Number(v.fiscalCotiz) : 1);
      return a + signo * Number((v.fiscal && v.fiscal.iva) || 0);
    }, 0);
  const ivaCompras = comprasFiscales.concat(gastosFiscales).reduce((a, d) => a + ivaDeCompra(d), 0);
  const pagos = pagosCompras + pagosGastos, porPagar = porPagarCompras + porPagarGastos;

  return {
    orgId: String(orgId), nombre: org.nombre || '',
    facturado: r2(facturado), cobros: r2(cobros), pagos: r2(pagos), flujoNeto: r2(cobros - pagos),
    ivaVentas: r2(ivaVentas), ivaCompras: r2(ivaCompras), posicionFiscal: r2(ivaVentas - ivaCompras),
    porCobrar: r2(porCobrar), porPagar: r2(porPagar), saldoNeto: r2(porCobrar - porPagar)
  };
}

router.get('/resumen', authFacturacion, async (req, res) => {
  try {
    const hoy = fechaAR(new Date());
    const desdeS = req.query.desde || hoy.slice(0, 8) + '01';
    const hastaS = req.query.hasta || hoy;
    if (!validarFecha(desdeS) || !validarFecha(hastaS)) throw err(400, 'Las fechas tienen que tener el formato AAAA-MM-DD.');
    if (desdeS > hastaS) throw err(400, 'La fecha "desde" no puede ser posterior a "hasta".');
    const d0 = inicioDia(desdeS), d1 = finDia(hastaS);
    const out = await conReintento(async () => {
      const db = await getDb();
      const orgs = await orgsAccesibles(db, req.usuario);
      return Promise.all(orgs.map(o => resumenSucursal(db, o, d0, d1, desdeS, hastaS)));
    });
    const claves = ['facturado', 'cobros', 'pagos', 'flujoNeto', 'ivaVentas', 'ivaCompras', 'posicionFiscal', 'porCobrar', 'porPagar', 'saldoNeto'];
    const total = {};
    claves.forEach(k => { total[k] = r2(out.reduce((a, s) => a + s[k], 0)); });
    res.json({ desde: desdeS, hasta: hastaS, sucursales: out, total });
  } catch (e) { responder(res, e); }
});

module.exports = router;
