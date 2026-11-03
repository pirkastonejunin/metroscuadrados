const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const h = await start(4411, { replSet: true }); const { db, ids, api } = h; const A = ids.org;
  const nuevoGasto = async () => (await db.collection('gastos').insertOne({ numero: 7, orgId: A, proveedorId: ids.provAcme, proveedorNombre: 'Acme SA', fecha: new Date(), moneda: 'ARS', estado: 'activo', items: [], total: 1000, totalPagado: 0, saldoPendiente: 1000, pagos: [], tipoComprobante: 'factura_a' })).insertedId;
  const pago = { tipoValor: 'efectivo', monto: 300, cuentaTipo: 'caja', cuentaId: String(ids.caja) };
  let g1;
  await caso('pago de gasto normal: gasto, movimiento de caja y saldo', async () => {
    g1 = await nuevoGasto();
    const r = await api('POST', '/api/gastos/' + g1 + '/pagos', pago); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await db.collection('gastos').findOne({ _id: g1 })).pagos.length, 1);
    assert.strictEqual(await db.collection('tesoreria_movimientos').countDocuments({}), 1);
  });
  const romperSaldos = () => db.command({ collMod: 'tesoreria_saldos', validator: { $expr: { $eq: [1, 0] } }, validationLevel: 'strict', validationAction: 'error' });
  const arreglarSaldos = () => db.command({ collMod: 'tesoreria_saldos', validator: {}, validationLevel: 'off' });
  await caso('si falla la actualización del saldo de caja, el pago de gasto no queda registrado', async () => {
    const g2 = await nuevoGasto(); const movAntes = await db.collection('tesoreria_movimientos').countDocuments({});
    await romperSaldos();
    const r = await api('POST', '/api/gastos/' + g2 + '/pagos', pago);
    await arreglarSaldos();
    assert.notStrictEqual(r.status, 200);
    assert.strictEqual((await db.collection('gastos').findOne({ _id: g2 })).pagos.length, 0, 'el gasto no tiene que tener el pago');
    assert.strictEqual(await db.collection('tesoreria_movimientos').countDocuments({}), movAntes, 'no tiene que quedar el movimiento de caja');
  });
  await caso('movimiento manual de tesorería: todo o nada', async () => {
    const movAntes = await db.collection('tesoreria_movimientos').countDocuments({});
    await romperSaldos();
    const r = await api('POST', '/api/tesoreria/movimientos', { cuentaTipo: 'caja', cuentaId: String(ids.caja), tipo: 'ingreso', monto: 100, motivo: 'prueba' });
    await arreglarSaldos();
    assert.notStrictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(await db.collection('tesoreria_movimientos').countDocuments({}), movAntes);
    const r2 = await api('POST', '/api/tesoreria/movimientos', { cuentaTipo: 'caja', cuentaId: String(ids.caja), tipo: 'ingreso', monto: 100, motivo: 'prueba' });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
  });
  await caso('anular el pago de gasto con transacción', async () => {
    const r = await api('POST', '/api/gastos/' + g1 + '/pagos/0/anular', { motivo: 'x' }); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
