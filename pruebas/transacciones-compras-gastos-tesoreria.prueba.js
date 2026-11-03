const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const h = await start(4410, { replSet: true }); const { db, ids, api } = h;
  const nueva = (extra) => api('POST', '/api/ventas', Object.assign({ clienteId: String(ids.cliente), tipoEntrega: 'pendiente', tipoComprobante: 'comprobante_x', items: [{ productoId: String(ids.cem50), cantidad: 2, precioUnitario: 1000 }] }, extra || {}));
  let v1;
  await caso('venta normal con transacción: guarda venta, cuenta corriente y reserva de stock', async () => {
    const r = await nueva(); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); v1 = r.data;
    assert(await db.collection('ventas').findOne({ _id: new ObjectId(v1._id) }));
    assert.strictEqual(await db.collection('cuenta_corriente_movimientos').countDocuments({ ventaId: new ObjectId(v1._id) }), 1);
  });
  await caso('si falla un paso a mitad (cuenta corriente), no queda nada guardado ni se consume el número', async () => {
    const antes = await db.collection('ventas').countDocuments({});
    const nroAntes = v1.numero;
    // Forzar el error: índice único sobre el concepto y un movimiento que ya ocupa "Venta Nº <siguiente>".
    await db.collection('cuenta_corriente_movimientos').createIndex({ concepto: 1 }, { unique: true, partialFilterExpression: { concepto: { $type: 'string' }, prueba: true } });
    await db.collection('cuenta_corriente_movimientos').insertOne({ concepto: 'Venta Nº ' + (nroAntes + 1), prueba: true });
    // el índice parcial solo aplica a docs con prueba:true; para que choque, el movimiento real tendría que tener prueba:true → usamos otro índice
    await db.collection('cuenta_corriente_movimientos').dropIndex('concepto_1');
    await db.collection('cuenta_corriente_movimientos').deleteMany({ prueba: true });
    await db.collection('cuenta_corriente_movimientos').createIndex({ ventaId: 1, concepto: 1 }, { unique: true, name: 'forzar', partialFilterExpression: { origen: 'venta' } });
    await db.collection('cuenta_corriente_movimientos').createIndex({ origen: 1, clienteId: 1, monto: 1 }, { unique: true, name: 'forzar2', partialFilterExpression: { origen: 'venta' } });
    const r = await nueva(); // mismo cliente, mismo monto, origen venta → choca el índice forzar2 en el paso de cuenta corriente
    assert.notStrictEqual(r.status, 200, 'tenía que fallar');
    assert.strictEqual(await db.collection('ventas').countDocuments({}), antes, 'no tiene que quedar la venta');
    await db.collection('cuenta_corriente_movimientos').dropIndex('forzar2'); await db.collection('cuenta_corriente_movimientos').dropIndex('forzar');
    const r2 = await nueva({ items: [{ productoId: String(ids.cem50), cantidad: 3, precioUnitario: 1000 }] });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.data));
    assert.strictEqual(r2.data.numero, nroAntes + 1, 'el número fallido no se consumió');
  });
  await caso('cobro y anulación con transacción', async () => {
    const p = await api('POST', '/api/ventas/' + v1._id + '/pagos', { tipoValor: 'efectivo', monto: 500, cuentaTipo: 'caja', cuentaId: String(ids.caja) });
    assert.strictEqual(p.status, 200, JSON.stringify(p.data));
    const a = await api('POST', '/api/ventas/' + v1._id + '/anular', { motivo: 'prueba' });
    assert.strictEqual(a.status, 200, JSON.stringify(a.data));
    assert.strictEqual((await db.collection('ventas').findOne({ _id: new ObjectId(v1._id) })).estado, 'anulada');
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
