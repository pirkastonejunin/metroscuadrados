const assert = require('assert');
const { start } = require('./harness');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const h = await start(4412, { replSet: true }); const { db, ids, api } = h; const A = ids.org;
  const romper = (col, validator) => db.command({ collMod: col, validator, validationLevel: 'strict', validationAction: 'error' });
  const arreglar = col => db.command({ collMod: col, validator: {}, validationLevel: 'off' });
  const conRotura = async (col, validator, fn) => { await romper(col, validator); try { return await fn(); } finally { await arreglar(col); } };
  const NADA = { $expr: { $eq: [1, 0] } };
  await api('POST', '/api/tesoreria/movimientos', { cuentaTipo: 'caja', cuentaId: String(ids.caja), tipo: 'ingreso', monto: 1e6, motivo: 'Base' });
  const movs = () => db.collection('tesoreria_movimientos').countDocuments({});

  // ---- Stock: transferencia
  const dep2 = (await db.collection('depositos').insertOne({ nombre: 'Depósito 2', activo: true, orgId: A })).insertedId;
  await db.collection('stock_actual').insertOne({ productoId: ids.cem50, depositoId: ids.deposito, cantidad: 50, orgId: A });
  const tr = { productoId: String(ids.cem50), depositoOrigenId: String(ids.deposito), depositoDestinoId: String(dep2), cantidad: 3 };
  await caso('stock: transferencia normal (2 movimientos y stock en ambos depósitos)', async () => {
    const r = await api('POST', '/api/stock/transferencias', tr); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(await db.collection('stock_movimientos').countDocuments({}), 2);
    assert.strictEqual((await db.collection('stock_actual').findOne({ depositoId: dep2 })).cantidad, 3);
    assert.strictEqual((await db.collection('stock_actual').findOne({ depositoId: ids.deposito })).cantidad, 47);
  });
  await caso('stock: si falla al actualizar el stock, no queda ningún movimiento suelto', async () => {
    const antes = await db.collection('stock_movimientos').countDocuments({});
    const r = await conRotura('stock_actual', NADA, () => api('POST', '/api/stock/transferencias', tr));
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual(await db.collection('stock_movimientos').countDocuments({}), antes, 'no tiene que quedar el movimiento');
    assert.strictEqual((await db.collection('stock_actual').findOne({ depositoId: ids.deposito })).cantidad, 47);
  });
  await caso('stock: ajuste de inventario todo o nada', async () => {
    const antes = await db.collection('stock_movimientos').countDocuments({});
    const body = { productoId: String(ids.cem50), depositoId: String(ids.deposito), cantidadReal: 40 };
    const r = await conRotura('stock_actual', NADA, () => api('POST', '/api/stock/ajustar', body));
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual(await db.collection('stock_movimientos').countDocuments({}), antes);
    const r2 = await api('POST', '/api/stock/ajustar', body); assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
  });

  // ---- Sueldos: adelanto
  const emp = (await api('POST', '/api/sueldos/empleados', { nombre: 'Ana', sector: 'produccion', sueldoBasico: 1000 })).data._id;
  const ade = { empleadoId: emp, monto: 100, cuentaTipo: 'caja', cuentaId: String(ids.caja), fecha: '2031-05-10' };
  await caso('sueldos: adelanto normal (adelanto + egreso de caja)', async () => {
    const m0 = await movs();
    const r = await api('POST', '/api/sueldos/adelantos', ade); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(await db.collection('sueldos_adelantos').countDocuments({}), 1);
    assert.strictEqual(await movs(), m0 + 1);
  });
  await caso('sueldos: si falla el registro del adelanto, la plata no sale de la caja', async () => {
    const m0 = await movs(), saldo0 = (await db.collection('tesoreria_saldos').findOne({ cuentaId: ids.caja })).saldo;
    const r = await conRotura('sueldos_adelantos', NADA, () => api('POST', '/api/sueldos/adelantos', ade));
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual(await movs(), m0, 'no tiene que quedar el egreso de caja');
    assert.strictEqual((await db.collection('tesoreria_saldos').findOne({ cuentaId: ids.caja })).saldo, saldo0, 'el saldo de la caja no cambia');
  });
  await caso('sueldos: anular un adelanto devuelve la plata (todo junto)', async () => {
    if (!(await db.collection('sueldos_adelantos').countDocuments({}))) { const r0 = await api('POST', '/api/sueldos/adelantos', ade); assert.strictEqual(r0.status, 200); }
    const a = await db.collection('sueldos_adelantos').findOne({});
    const m0 = await movs();
    const r = await conRotura('tesoreria_saldos', NADA, () => api('DELETE', '/api/sueldos/adelantos/' + a._id));
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual(await movs(), m0); assert.strictEqual(await db.collection('sueldos_adelantos').countDocuments({}), 1);
    const r2 = await api('DELETE', '/api/sueldos/adelantos/' + a._id); assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
    assert.strictEqual(await db.collection('sueldos_adelantos').countDocuments({}), 0);
  });

  // ---- Financiera: pago a la financiera y operación
  await caso('financiera: pago normal y con falla (todo o nada)', async () => {
    await db.createCollection('financiera_pagos').catch(() => {});
    const m0 = await movs();
    const r1 = await conRotura('financiera_pagos', NADA, () => api('POST', '/api/financiera/pagos', { monto: 500, cuentaTipo: 'caja', cuentaId: String(ids.caja), fecha: '2026-10-15' }));
    assert.notStrictEqual(r1.status, 200); assert.strictEqual(await movs(), m0, 'la caja no se mueve si el pago no se registra');
    const r2 = await api('POST', '/api/financiera/pagos', { monto: 500, cuentaTipo: 'caja', cuentaId: String(ids.caja), fecha: '2026-10-15' }); assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
    assert.strictEqual(await movs(), m0 + 1);
  });
  await caso('financiera: operación con cheques, si falla un cheque no queda la operación a medias', async () => {
    const chs = [{ numero: '1', monto: 100000, fechaVencimiento: '2026-11-13' }, { numero: '2', monto: 50000, fechaVencimiento: '2026-12-13' }];
    const r = await conRotura('cheques', NADA, () => api('POST', '/api/financiera/operaciones', { fecha: '2026-10-14', tasaMensual: 3, cheques: chs }));
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual(await db.collection('financiera_operaciones').countDocuments({}), 0, 'no tiene que quedar la operación');
    const r2 = await api('POST', '/api/financiera/operaciones', { fecha: '2026-10-14', tasaMensual: 3, cheques: chs }); assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
    assert.strictEqual(await db.collection('cheques').countDocuments({ origenFinanciera: true }), 2);
  });

  // ---- Clientes: imputar un cobro a facturas
  const C = String(ids.cliente);
  await caso('clientes: imputar cobro, si falla la factura no queda la imputación en el cobro', async () => {
    const mk = async p => (await api('POST', '/api/ventas', { clienteId: C, tipoEntrega: 'pendiente', tipoComprobante: 'comprobante_x', items: [{ productoId: String(ids.cem50), cantidad: 1, precioUnitario: p }] })).data;
    const v1 = await mk(10000);
    let r = await api('POST', '/api/tesoreria/cobros-cuenta-cliente', { clienteId: C, tipoValor: 'efectivo', monto: 8000, cuentaTipo: 'caja', cuentaId: String(ids.caja) }); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const mov = await db.collection('cuenta_corriente_movimientos').findOne({ origen: 'cobro_cuenta', clienteId: ids.cliente });
    const body = { movimientoId: String(mov._id), imputaciones: [{ ventaId: v1._id, monto: 5000 }] };
    r = await conRotura('ventas', { imputaciones: { $exists: false } }, () => api('POST', `/api/clientes/${C}/imputar`, body));
    assert.notStrictEqual(r.status, 200, JSON.stringify(r.data));
    const m2 = await db.collection('cuenta_corriente_movimientos').findOne({ _id: mov._id });
    assert.ok(!(m2.imputaciones || []).length, 'el cobro no tiene que quedar con imputaciones'); assert.ok(!m2.imputado, 'imputado en 0');
    r = await api('POST', `/api/clientes/${C}/imputar`, body); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  });

  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
