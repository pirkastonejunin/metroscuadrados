const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')); } }
(async () => {
  const h = await start(4416, { replSet: true }); const { db, ids, api } = h; const A = ids.org; const B = new ObjectId();
  for (const o of [A, B]) if (!(await db.collection('organizaciones').findOne({ _id: o }))) await db.collection('organizaciones').insertOne({ _id: o, nombre: 'Org ' + o });
  const pid = new ObjectId(); const dep = ids.deposito;
  await db.collection('productos_catalogo').insertOne({ _id: pid, sku: 'LB', nombre: 'Liston beige', tipoProducto: 'reventa', costo: 1, precio: 2, activo: true, orgId: A });
  await db.collection('stock_actual').insertOne({ productoId: pid, depositoId: dep, orgId: A, cantidad: 20, cantidadComprometida: 10 });
  await db.collection('stock_actual').insertOne({ productoId: pid, depositoId: dep, orgId: B, cantidad: 0, cantidadComprometida: 10 });
  const fila = (d) => (d.items || d.stock || d.filas || d).find(x => String(x.productoId) === String(pid) && String(x.depositoId) === String(dep));
  await caso('/actual suma lo comprometido por otra sucursal', async () => {
    const r = await api('GET', '/api/stock/actual', null, String(A));
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const f = fila(r.data); assert(f, JSON.stringify(r.data).slice(0, 400));
    assert.strictEqual(f.cantidadComprometida ?? f.comprometida, 20); assert.strictEqual(f.disponible, 0);
  });
  await caso('en vista Todas no se cuenta doble', async () => {
    const r = await api('GET', '/api/stock/actual', null, 'todas');
    const lista = (r.data.items || r.data.stock || r.data.filas || r.data).filter(x => String(x.productoId) === String(pid) && String(x.depositoId) === String(dep));
    const tot = lista.reduce((t, x) => t + (x.cantidadComprometida ?? x.comprometida ?? 0), 0);
    assert.strictEqual(tot, 20, JSON.stringify(lista));
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
