// Restaurar una venta anulada por error (5/11/2026): el camino inverso exacto de anular — stock, cuenta corriente y estado —,
// solo para el Administrador, todo o nada.
const assert = require('assert');
const { start } = require('./harness');
(async () => {
  const h = await start(4140); const { db, ids, api } = h;
  const C = String(ids.cliente), P = ids.cem50, D = ids.deposito, ORG = ids.org;
  await db.collection('stock_actual').insertOne({ productoId: P, depositoId: D, cantidad: 50, orgId: ORG });
  const stock = async (dep) => { const s = await db.collection('stock_actual').findOne({ productoId: P, depositoId: dep === undefined ? D : dep }); return s || { cantidad: 0, cantidadComprometida: 0 }; };
  const saldo = async () => ((await api('GET', `/api/clientes/${C}/cuenta-corriente`)).data).saldo;
  const s0 = await saldo();

  // 1) venta con entrega inmediata (stock físico baja) y un cobro parcial
  let r = await api('POST', '/api/ventas', { clienteId: C, tipoEntrega: 'inmediata', depositoId: String(D), tipoComprobante: 'comprobante_x', items: [{ productoId: String(P), cantidad: 5, precioUnitario: 1000 }] });
  assert.equal(r.status, 201 === r.status ? 201 : 200, JSON.stringify(r.data));
  const v = r.data; assert.equal((await stock()).cantidad, 45);
  r = await api('POST', `/api/ventas/${v._id}/pagos`, { tipoValor: 'efectivo', monto: 2000, cuentaTipo: 'caja', cuentaId: String(ids.caja) }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const sConVenta = await saldo(); assert.equal(sConVenta, s0 + 5000 - 2000);

  // 2) no se puede restaurar una venta que no está anulada
  r = await api('POST', `/api/ventas/${v._id}/restaurar`, {}); assert.equal(r.status, 400);

  // 3) anular: vuelve el stock y se devuelve la deuda pendiente
  r = await api('POST', `/api/ventas/${v._id}/anular`, { motivo: 'por error' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await stock()).cantidad, 50); assert.equal(await saldo(), s0);

  // 4) un usuario que no es Administrador no puede restaurar
  global.__testUser = { nombre: 'Vendedor', rol: { protegido: false, modulos: ['ventas'] } };
  r = await api('POST', `/api/ventas/${v._id}/restaurar`, {}); assert.equal(r.status, 403, 'solo el Administrador');
  global.__testUser = null;
  assert.equal((await db.collection('ventas').findOne({ _id: new (require('mongodb').ObjectId)(v._id) })).estado, 'anulada');

  // 5) si lo entregado ya no está en el depósito, no restaura NADA (ni stock, ni deuda, ni estado)
  await db.collection('stock_actual').updateOne({ productoId: P, depositoId: D }, { $set: { cantidad: 2 } });
  r = await api('POST', `/api/ventas/${v._id}/restaurar`, {}); assert.equal(r.status, 400, JSON.stringify(r.data));
  assert(/no hay esa cantidad|No se puede restaurar/i.test(r.data.error), r.data.error);
  assert.equal((await stock()).cantidad, 2); assert.equal(await saldo(), s0);
  await db.collection('stock_actual').updateOne({ productoId: P, depositoId: D }, { $set: { cantidad: 50 } });

  // 6) restaurar: todo vuelve a como estaba antes de anular
  r = await api('POST', `/api/ventas/${v._id}/restaurar`, { motivo: 'se anuló sin querer' }); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'entregada'); assert(!r.data.anuladaEn, 'ya no figura anulada');
  assert.equal(r.data.restauradaPor, 'Tester'); assert.equal(r.data.anulacionesPrevias.length, 1);
  assert.equal(r.data.anulacionesPrevias[0].anuladaMotivo, 'por error');
  assert.equal((await stock()).cantidad, 45, 'lo entregado vuelve a salir del físico');
  assert.equal(await saldo(), sConVenta, 'la deuda pendiente vuelve a la cuenta corriente');
  const movs = await db.collection('cuenta_corriente_movimientos').find({ ventaId: new (require('mongodb').ObjectId)(v._id) }).toArray();
  assert(movs.find(m => /^Anulación venta/.test(m.concepto) && m.anulado), 'el movimiento de la anulación queda marcado como anulado');
  assert(movs.find(m => /^Restauración venta/.test(m.concepto) && m.tipo === 'debito' && m.monto === 3000), 'y hay un débito de restauración');
  r = await api('POST', `/api/ventas/${v._id}/restaurar`, {}); assert.equal(r.status, 400, 'no se restaura dos veces');

  // 7) se puede volver a anular y a restaurar (queda el historial de las dos veces)
  r = await api('POST', `/api/ventas/${v._id}/anular`, {}); assert.equal(r.status, 200);
  assert.equal(await saldo(), s0); assert.equal((await stock()).cantidad, 50);
  r = await api('POST', `/api/ventas/${v._id}/restaurar`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.anulacionesPrevias.length, 2); assert.equal(await saldo(), sConVenta); assert.equal((await stock()).cantidad, 45);

  // 8) venta pendiente (stock comprometido): anular libera, restaurar vuelve a comprometer y queda pendiente
  r = await api('POST', '/api/ventas', { clienteId: C, tipoEntrega: 'pendiente', tipoComprobante: 'comprobante_x', items: [{ productoId: String(P), cantidad: 3, precioUnitario: 100 }] });
  const vp = r.data; const comp = async () => ((await db.collection('stock_actual').findOne({ productoId: P, depositoId: vp.depositoId || null })) || {}).cantidadComprometida || 0;
  const c0 = await comp(); assert(c0 >= 3, 'comprometido al crear');
  r = await api('POST', `/api/ventas/${vp._id}/anular`, {}); assert.equal(r.status, 200); assert.equal(await comp(), c0 - 3);
  r = await api('POST', `/api/ventas/${vp._id}/restaurar`, {}); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.estado, 'pendiente'); assert.equal(await comp(), c0);
  console.log('OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
