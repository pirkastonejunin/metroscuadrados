// Desde la cuenta corriente del proveedor: vincular un pago a cuenta a facturas y anular un pago (aplicado o sin aplicar).
const assert = require('assert');
const { start } = require('./harness');
(async () => {
  const h = await start(4472); const { db } = h;
  const P = h.ids.provAcme, org = h.ids.org;
  const compra = (await db.collection('compras').insertOne({ numero: 1, proveedorId: P, proveedorNombre: 'Acme SA', orgId: org, estado: 'pendiente', total: 1000, totalPagado: 0, saldoPendiente: 1000, fecha: new Date(), moneda: 'ARS', pagos: [], items: [] })).insertedId;
  const pago = (await db.collection('compras_pagos').insertOne({ proveedorId: P, proveedorNombre: 'Acme SA', orgId: org, tipoValor: 'efectivo', cuentaTipo: 'caja', cuentaId: h.ids.caja, monto: 600, montoSinAplicar: 600, fecha: new Date(), aplicaciones: [], moneda: 'ARS' })).insertedId;
  const api = async (m, u, b) => { const r = await fetch('http://localhost:4472' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  let cc = (await api('GET', '/api/proveedores/' + P + '/cuenta-corriente')).data;
  const mv = cc.movimientos.find(m => m.origen === 'pago_compra'); assert(mv && mv.montoSinAplicar === 600, 'el pago sin aplicar trae montoSinAplicar');
  let r = await api('POST', '/api/compras/pagos-cuenta/' + pago + '/aplicar', { aplicaciones: [{ compraId: String(compra), monto: 400 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await db.collection('compras').findOne({ _id: compra })).saldoPendiente, 600);
  // anular el pago ya aplicado en parte: devuelve el saldo de la factura
  r = await api('POST', '/api/compras/pagos/' + pago + '/anular', {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual((await db.collection('compras').findOne({ _id: compra })).saldoPendiente, 1000, 'la factura recupera el saldo');
  assert.strictEqual((await db.collection('compras_pagos').findOne({ _id: pago })).anulado, true);
  r = await api('POST', '/api/compras/pagos/' + pago + '/anular', {}); assert.strictEqual(r.status, 400, 'ya anulado');
  // pago a cuenta sin aplicar: se anula directo
  const p2 = (await db.collection('compras_pagos').insertOne({ proveedorId: P, orgId: org, tipoValor: 'efectivo', cuentaTipo: 'caja', cuentaId: h.ids.caja, monto: 50, montoSinAplicar: 50, fecha: new Date(), aplicaciones: [] })).insertedId;
  r = await api('POST', '/api/compras/pagos/' + p2 + '/anular', {}); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
