const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 10).join('\n      ')); } }
(async () => {
  const h = await start(4297); const { db, ids, api } = h; const A = ids.org;
  if (!(await db.collection('organizaciones').findOne({ _id: A }))) await db.collection('organizaciones').insertOne({ _id: A, nombre: 'Test' });
  const pC = new ObjectId();
  await db.collection('productos_catalogo').insertOne({ _id: pC, sku: 'CO', nombre: 'Cola', unidad: 'unidad', tipoProducto: 'reventa', costo: 400, activo: true, orgId: A });
  await db.collection('ventas').insertMany([
    { orgId: A, estado: 'entregada', tipoComprobante: 'comprobante_x', clienteNombre: 'Juan', numero: 7, moneda: 'ARS', fecha: new Date('2031-05-10T15:00:00Z'), total: 50000, items: [{ productoId: pC, cantidad: 2, subtotal: 25000 }, { productoId: null, sku: 'ZZ', nombre: 'Libre Dux', cantidad: 1, subtotal: 25000, costoTotal: 9000 }] },
    { orgId: A, estado: 'entregada', tipoComprobante: 'comprobante_x', clienteNombre: 'Ana', numero: 8, moneda: 'ARS', fecha: new Date('2031-06-10T15:00:00Z'), total: 1000, items: [{ productoId: pC, cantidad: 1, subtotal: 1000 }] }]);
  await db.collection('gastos').insertOne({ orgId: A, estado: 'activa', tipoComprobante: 'factura', proveedorNombre: 'Luz SA', numero: 3, moneda: 'ARS', fecha: new Date('2031-05-12T15:00:00Z'), items: [{ conceptoNombre: 'Electricidad', subtotal: 5000 }, { conceptoNombre: 'Gas', subtotal: 100 }] });
  await db.collection('sueldos_liquidaciones').insertOne({ orgId: A, periodo: '2031-05', sector: 'administracion', empleadoNombre: 'Pepe', costoEmpresa: 10000 });
  const q = s => api('GET', '/api/informes/resultados/detalle?desde=2031-05-01&hasta=2031-06-30&' + s);
  await caso('ventas del mes', async () => { const d = (await q('tipo=ventas&mes=2031-05')).data; assert.strictEqual(d.cantidad, 1); assert.strictEqual(d.total, 50000); });
  await caso('ventas total período', async () => { const d = (await q('tipo=ventas&mes=total')).data; assert.strictEqual(d.cantidad, 2); assert.strictEqual(d.total, 51000); });
  await caso('costo por producto con costo de Dux', async () => { const d = (await q('tipo=costo&mes=2031-05')).data; assert.strictEqual(d.total, 9800); assert.strictEqual(d.cantidad, 2); const t = (await api('GET', '/api/informes/resultados?desde=2031-05-01&hasta=2031-05-31')).data.total; assert.strictEqual(t.costo, d.total); });
  await caso('gasto por concepto', async () => { const d = (await q('tipo=gasto&mes=2031-05&concepto=' + encodeURIComponent('Electricidad'))).data; assert.strictEqual(d.total, 5000); assert.strictEqual(d.filas[0].detalle, 'Luz SA'); });
  await caso('sueldos por sector', async () => { const d = (await q('tipo=gasto&mes=2031-05&concepto=' + encodeURIComponent('Sueldos y cargas · Administración'))).data; assert.strictEqual(d.total, 10000); assert.strictEqual(d.filas[0].detalle, 'Pepe'); });
  await caso('tipo inválido da 400', async () => { assert.strictEqual((await q('tipo=x')).status, 400); });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
