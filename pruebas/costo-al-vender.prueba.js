const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')); } }
(async () => {
  const h = await start(4415, { replSet: true }); const { db, ids, api } = h; const A = ids.org;
  if (!(await db.collection('organizaciones').findOne({ _id: A }))) await db.collection('organizaciones').insertOne({ _id: A, nombre: 'Test' });
  const pid = new ObjectId();
  await db.collection('productos_catalogo').insertOne({ _id: pid, sku: 'PL', nombre: 'Placa', tipoProducto: 'reventa', costo: 100, precio: 300, activo: true, orgId: A });
  const hoy = new Date(); const mes = hoy.toISOString().slice(0, 7);
  let ventaId;
  await caso('la venta guarda el costo del producto del momento', async () => {
    const r = await api('POST', '/api/ventas', { clienteId: String(ids.cliente), tipoEntrega: 'pendiente', tipoComprobante: 'comprobante_x', items: [{ productoId: String(pid), cantidad: 10, precioUnitario: 300 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); ventaId = r.data._id;
    assert.strictEqual(r.data.items[0].costoSnap, 100);
  });
  await caso('si después cambia el costo del producto, el informe de esa venta no cambia', async () => {
    await db.collection('productos_catalogo').updateOne({ _id: pid }, { $set: { costo: 500 } });
    const r = (await api('GET', '/api/informes/resultados?desde=' + mes + '-01&hasta=' + hoy.toISOString().slice(0, 10))).data;
    assert.strictEqual(r.meses[0].costo, 1000, JSON.stringify(r.meses[0]));
    const d = (await api('GET', '/api/informes/resultados/detalle?tipo=costo&mes=total&desde=' + mes + '-01&hasta=' + hoy.toISOString().slice(0, 10))).data;
    assert.strictEqual(d.filas[0].costoUnit, 100); assert(/momento de la venta/.test(d.filas[0].fuente));
  });
  await caso('una venta anterior sin costo guardado usa el costo actual', async () => {
    await db.collection('ventas').insertOne({ orgId: A, estado: 'entregada', tipoComprobante: 'comprobante_x', numero: 99, moneda: 'ARS', fecha: new Date(), total: 600, items: [{ productoId: pid, cantidad: 2, subtotal: 600 }] });
    const r = (await api('GET', '/api/informes/resultados?desde=' + mes + '-01&hasta=' + hoy.toISOString().slice(0, 10))).data;
    assert.strictEqual(r.meses[0].costo, 2000, JSON.stringify(r.meses[0]));
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
