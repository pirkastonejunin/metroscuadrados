const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 10).join('\n      ')); } }
(async () => {
  const h = await start(4414); const { db, ids, api } = h; const F = ids.org, B = new ObjectId();
  await db.collection('organizaciones').deleteMany({}); await db.collection('organizaciones').insertMany([{ _id: F, nombre: 'Fábrica' }, { _id: B, nombre: 'Sucursal' }]);
  const lista = new ObjectId(), pP = new ObjectId(), pS = new ObjectId();
  await db.collection('productos_listas_precio').insertOne({ _id: lista, nombre: 'Mayorista', activa: true, incluyeIva: false });
  await db.collection('productos_catalogo').insertMany([
    { _id: pP, sku: 'P1', nombre: 'Panel', tipoProducto: 'produccion', costo: 400, precio: 1000, preciosPorLista: [{ listaId: lista, precio: 600 }], activo: true, orgId: F },
    { _id: pS, sku: 'P2', nombre: 'Sin precio', tipoProducto: 'produccion', precio: 900, preciosPorLista: [], activo: true, orgId: F }]);
  await db.collection('ventas').insertOne({ orgId: B, estado: 'entregada', tipoComprobante: 'comprobante_x', clienteNombre: 'Juan', numero: 1, moneda: 'ARS', fecha: new Date('2032-05-10T15:00:00Z'), total: 12000, items: [{ productoId: pP, cantidad: 10, subtotal: 10000 }, { productoId: pS, cantidad: 2, subtotal: 2000 }] });
  const inf = (org) => api('GET', '/api/informes/resultados?desde=2032-05-01&hasta=2032-05-31', null, org ? String(org) : undefined);
  await caso('sin configurar: avisa el motivo', async () => { const r = await inf(B); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.transferencia.estado, 'sin_configurar'); });
  await db.collection('config_general').insertOne({ clave: 'resultadosTransferenciaFabrica', valor: { activo: true, fabricaOrgId: String(F), listaId: String(lista) } });
  await caso('sucursal: el costo de lo producido por Fábrica es el precio mayorista', async () => { const r = (await inf(B)).data; const m = r.meses[0]; assert.strictEqual(r.transferencia.estado, 'activa'); assert.strictEqual(m.comprasInternas, 6000, JSON.stringify(m)); });
  await caso('Fábrica: ve la venta interna con su costo de producción', async () => { const r = (await inf(F)).data; const m = r.meses[0]; assert.strictEqual(m.ventasInternas, 6000, JSON.stringify(m)); assert.strictEqual(m.costo, 4000, JSON.stringify(m)); });
  await caso('detalle de ventas de Fábrica: lista las ventas internas a las sucursales y suma igual que el informe', async () => {
    await db.collection('config_general').updateOne({ clave: 'resultadosTransferenciaFabrica' }, { $set: { 'valor.activo': true } });
    const inf = (await api('GET', '/api/informes/resultados?desde=2032-05-01&hasta=2032-05-31', null, String(F))).data;
    const d = (await api('GET', '/api/informes/resultados/detalle?tipo=ventas&mes=2032-05&desde=2032-05-01&hasta=2032-05-31', null, String(F))).data;
    assert.strictEqual(d.cantidad, 1, JSON.stringify(d)); assert(/Venta interna a Sucursal/.test(d.filas[0].detalle)); assert.strictEqual(d.total, inf.meses[0].ventasNetas);
  });
  await caso('avisa los productos de producción sin precio mayorista', async () => { const r = (await inf(B)).data; assert.strictEqual(r.transferencia.cantSinPrecio, 1); assert(/Sin precio/.test(r.transferencia.sinPrecio[0])); });
  await caso('desactivada: avisa que no se aplica', async () => { await db.collection('config_general').updateOne({ clave: 'resultadosTransferenciaFabrica' }, { $set: { 'valor.activo': false } }); const r = (await inf(B)).data; assert.strictEqual(r.transferencia.estado, 'inactiva'); });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
