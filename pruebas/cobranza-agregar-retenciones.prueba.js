// Agregar retenciones a una cobranza ya cargada (27/11/2026): suman al mismo cobro, bajan el saldo del cliente, quedan como retención
// sufrida y se revierten junto con la cobranza si se anula.
const assert = require('assert');
const { start } = require('./harness');
(async () => {
  const h = await start(4153, { replSet: true }); const { db, ids, api } = h;
  const C = String(ids.cliente);
  const saldo = async () => { const s = await db.collection('cuenta_corriente_saldos').findOne({ clienteId: ids.cliente }); return s ? Math.round(s.saldo * 100) / 100 : 0; };
  const sIni = await saldo();
  // ---- cobro a cuenta en efectivo 800
  let r = await api('POST', '/api/tesoreria/cobros-cuenta-cliente', { clienteId: C, tipoValor: 'efectivo', monto: 800, cuentaTipo: 'caja', cuentaId: String(ids.caja) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await saldo(), sIni - 800);
  const mov = await db.collection('cuenta_corriente_movimientos').findOne({ clienteId: ids.cliente, origen: 'cobro_cuenta' });
  const id = String(mov._id);
  r = await api('POST', `/api/tesoreria/cobranzas/${id}/retenciones`, { retenciones: [] }); assert.equal(r.status, 400);
  r = await api('POST', `/api/tesoreria/cobranzas/${id}/retenciones`, { retenciones: [{ tipo: 'ganancias', monto: 120, nota: 'Cert. 55' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await saldo(), sIni - 920, 'el saldo baja por la retención');
  const m2 = await db.collection('cuenta_corriente_movimientos').findOne({ _id: mov._id });
  assert.equal(m2.monto, 920);
  assert.equal(await db.collection('retenciones_sufridas').countDocuments({ origen: 'cobro_cuenta', reciboId: mov.reciboId, tipo: 'ganancias' }), 1);
  r = await api('GET', `/api/tesoreria/recibo-cuenta/movimiento/${mov.reciboId}`); assert.equal(r.status, 200);
  assert(/Ganancias/i.test(r.data), 'el recibo muestra la retención');
  // la caja no cambió por la retención (solo entraron los 800)
  // ---- anular revierte todo
  r = await api('POST', `/api/tesoreria/cobranzas/${id}/anular`, { motivo: 'prueba' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await saldo(), sIni, 'anular deja el saldo como estaba');
  assert.equal(await db.collection('retenciones_sufridas').countDocuments({ origen: 'cobro_cuenta', reciboId: mov.reciboId }), 0);
  r = await api('POST', `/api/tesoreria/cobranzas/${id}/retenciones`, { retenciones: [{ tipo: 'ganancias', monto: 10 }] }); assert.equal(r.status, 400, 'no se edita una anulada');
  // ---- cobro de una venta
  const V = String(ids.venta);
  r = await api('POST', `/api/ventas/${V}/pagos`, { tipoValor: 'efectivo', monto: 300, cuentaTipo: 'caja', cuentaId: String(ids.caja) }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const antes = await db.collection('ventas').findOne({ _id: ids.venta });
  const movV = await db.collection('cuenta_corriente_movimientos').findOne({ ventaId: ids.venta, origen: 'cobro_venta', anulado: { $ne: true } });
  r = await api('POST', `/api/tesoreria/cobranzas/${movV._id}/retenciones`, { retenciones: [{ tipo: 'iibb', monto: 50 }] }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const desp = await db.collection('ventas').findOne({ _id: ids.venta });
  assert.equal(Math.round((desp.totalCobrado - antes.totalCobrado) * 100) / 100, 50);
  assert.equal(Math.round((antes.saldoPendiente - desp.saldoPendiente) * 100) / 100, 50);
  assert.equal(desp.pagos[desp.pagos.length - 1].totalRetenciones, 50);
  r = await api('POST', `/api/tesoreria/cobranzas/${movV._id}/anular`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  const fin = await db.collection('ventas').findOne({ _id: ids.venta });
  assert.equal(fin.totalCobrado, antes.totalCobrado - 300, 'anular saca cobro y retención');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
