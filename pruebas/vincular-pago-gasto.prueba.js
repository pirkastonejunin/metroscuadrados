const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const h = await start(4413, { replSet: true }); const { db, ids, api } = h; const A = ids.org;
  const gasto = async (total) => (await db.collection('gastos').insertOne({ numero: Math.floor(Math.random() * 1e6), orgId: A, proveedorId: ids.provAcme, proveedorNombre: 'Acme SA', fecha: new Date(), moneda: 'ARS', estado: 'activo', tipoComprobante: 'factura_a', puntoVenta: '1', comprobanteNumero: String(Math.floor(Math.random() * 1e6)), items: [], total, totalPagado: 0, saldoPendiente: total, pagos: [] })).insertedId;
  const compra = async (total) => (await db.collection('compras').insertOne({ numero: Math.floor(Math.random() * 1e6), orgId: A, proveedorId: ids.provAcme, fecha: new Date(), estado: 'recibida', tipoComprobante: 'factura_a', items: [], total, totalPagado: 0, saldoPendiente: total, pagos: [] })).insertedId;
  const saldoCC = async () => (await api('GET', '/api/proveedores/' + ids.provAcme + '/cuenta-corriente')).data;
  let pid, g, c;
  await caso('pago a cuenta, vinculado a un gasto: baja el saldo del gasto y la cuenta corriente no cuenta el pago dos veces', async () => {
    g = await gasto(1000);
    const r = await api('POST', '/api/compras/pagos-cuenta', { proveedorId: String(ids.provAcme), monto: 600, tipoValor: 'efectivo', cuentaTipo: 'caja', cuentaId: String(ids.caja) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); pid = r.data._id;
    const antes = (await saldoCC()).saldo;
    const a = await api('POST', '/api/compras/pagos-cuenta/' + pid + '/aplicar', { aplicaciones: [{ gastoId: String(g), monto: 600 }] });
    assert.strictEqual(a.status, 200, JSON.stringify(a.data));
    const gd = await db.collection('gastos').findOne({ _id: g }); assert.strictEqual(gd.saldoPendiente, 400); assert.strictEqual(gd.totalPagado, 600);
    assert.strictEqual((await saldoCC()).saldo, antes, 'el saldo del proveedor no cambia al vincular');
    const mov = (await saldoCC()).movimientos.find(m => m.origen === 'pago_compra' && String(m.docId) === String(pid));
    assert.strictEqual(mov.aplicaciones[0].gastoId, String(g)); assert.strictEqual(mov.montoSinAplicar, 0);
  });
  await caso('no se puede anular el pago de gasto desde el gasto ni el pago entero mientras está vinculado', async () => {
    assert.strictEqual((await api('POST', '/api/gastos/' + g + '/pagos/0/anular', {})).status, 400);
    assert.strictEqual((await api('POST', '/api/compras/pagos/' + pid + '/anular', {})).status, 400);
  });
  await caso('desvincular devuelve el saldo al gasto y el pago queda a cuenta; se re-vincula a una compra', async () => {
    const d = await api('POST', '/api/compras/pagos-cuenta/' + pid + '/desvincular', { gastoId: String(g) });
    assert.strictEqual(d.status, 200, JSON.stringify(d.data)); assert.strictEqual(d.data.montoSinAplicar, 600); assert.strictEqual(d.data.aplicaciones.length, 0);
    const gd = await db.collection('gastos').findOne({ _id: g }); assert.strictEqual(gd.saldoPendiente, 1000); assert.strictEqual(gd.pagos.length, 0);
    c = await compra(800);
    const a = await api('POST', '/api/compras/pagos-cuenta/' + pid + '/aplicar', { aplicaciones: [{ compraId: String(c), monto: 600 }] });
    assert.strictEqual(a.status, 200, JSON.stringify(a.data));
    assert.strictEqual((await db.collection('compras').findOne({ _id: c })).saldoPendiente, 200);
    const d2 = await api('POST', '/api/compras/pagos-cuenta/' + pid + '/desvincular', { compraId: String(c) });
    assert.strictEqual(d2.status, 200, JSON.stringify(d2.data)); assert.strictEqual((await db.collection('compras').findOne({ _id: c })).saldoPendiente, 800);
  });
  await caso('no aplica más que el saldo de la factura ni a un gasto anulado', async () => {
    const g2 = await gasto(100);
    assert.strictEqual((await api('POST', '/api/compras/pagos-cuenta/' + pid + '/aplicar', { aplicaciones: [{ gastoId: String(g2), monto: 500 }] })).status, 400);
    await db.collection('gastos').updateOne({ _id: g2 }, { $set: { estado: 'anulada' } });
    assert.strictEqual((await api('POST', '/api/compras/pagos-cuenta/' + pid + '/aplicar', { aplicaciones: [{ gastoId: String(g2), monto: 50 }] })).status, 400);
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
