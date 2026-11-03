const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 10).join('\n      ')); } }
(async () => {
  const h = await start(4298); const { db, ids, api } = h; const A = ids.org;
  if (!(await db.collection('organizaciones').findOne({ _id: A }))) await db.collection('organizaciones').insertOne({ _id: A, nombre: 'Test' });
  const c1 = new ObjectId(), c2 = new ObjectId(), c3 = new ObjectId();
  await db.collection('gastos_conceptos').insertMany([{ _id: c1, nombre: 'Energía Activa', activo: true, compartido: true, orgId: null }, { _id: c2, nombre: 'Cargo fijo', activo: true, compartido: true, orgId: null }, { _id: c3, nombre: 'Luz', activo: true, compartido: true, orgId: null }]);
  const g = (conc, id, monto) => ({ orgId: A, estado: 'activa', proveedorNombre: 'EDEN', fecha: new Date('2031-05-12T15:00:00Z'), moneda: 'ARS', items: [{ conceptoId: id, conceptoNombre: conc, subtotal: monto }] });
  await db.collection('gastos').insertMany([g('Energía Activa', c1, 1000), g('Cargo fijo', c2, 200), g('ALQUILER', null, 500), g('Alquiler', null, 700)]);
  const det = async c => (await api('GET', '/api/informes/resultados?desde=2031-05-01&hasta=2031-05-31')).data.meses[0].gastos[c];
  await caso('alquiler en mayúsculas y minúsculas sale en un solo renglón', async () => { const d = (await api('GET', '/api/informes/resultados?desde=2031-05-01&hasta=2031-05-31')).data; const k = d.conceptos.filter(x => /alquiler/i.test(x)); assert.strictEqual(k.length, 1, JSON.stringify(k)); assert.strictEqual(d.meses[0].gastos[k[0]], 1200); });
  await caso('uso por concepto', async () => { const u = (await api('GET', '/api/gastos/config/conceptos/uso')).data; assert.strictEqual(u.porId[String(c1)].items, 1); });
  await caso('unificar pasa los renglones al destino y da de baja los de origen', async () => {
    const r = await api('POST', '/api/gastos/config/conceptos/unificar', { origenIds: [String(c1), String(c2)], destinoId: String(c3) }); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.renglones, 2);
    assert.strictEqual(await det('Luz'), 1200); assert.strictEqual(await det('Energía Activa'), undefined);
    assert.strictEqual((await db.collection('gastos_conceptos').findOne({ _id: c1 })).activo, false);
  });
  await caso('unificar con nombre nuevo, y por nombre sin id', async () => {
    const c4 = new ObjectId(); await db.collection('gastos_conceptos').insertOne({ _id: c4, nombre: 'Leads', activo: true, compartido: true, orgId: null });
    await db.collection('gastos').insertOne(g('leads', null, 300));
    const r = await api('POST', '/api/gastos/config/conceptos/unificar', { origenIds: [String(c4)], nuevoNombre: 'Publicidad' }); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(await det('Publicidad'), 300);
  });
  await caso('sin origen da 400', async () => { assert.strictEqual((await api('POST', '/api/gastos/config/conceptos/unificar', { destinoId: String(c3) })).status, 400); });
  await caso('todas las sucursales: la opción de sueldos de producción rige igual para todas', async () => {
    const B = new ObjectId(); await db.collection('organizaciones').insertOne({ _id: B, nombre: 'Otra' });
    await db.collection('config_general').insertOne({ orgId: A, clave: 'resultadosSueldosProduccionGasto', valor: true });
    await db.collection('sueldos_liquidaciones').insertMany([{ orgId: A, periodo: '2031-05', sector: 'produccion', costoEmpresa: 1000 }, { orgId: B, periodo: '2031-05', sector: 'produccion', costoEmpresa: 500 }]);
    const r = await api('GET', '/api/informes/resultados?desde=2031-05-01&hasta=2031-05-31&alcance=todas');
    console.log('sucursales', r.data.sucursales);
    if (r.data.sucursales > 1) { assert.strictEqual(r.data.meses[0].gastos['Sueldos y cargas · Producción'], 1500, JSON.stringify(r.data.meses[0])); assert.strictEqual(r.data.total.enCosto, 0); }
  });
  await caso('depurar borra solo los conceptos sin movimientos', async () => {
    let r = await api('POST', '/api/gastos/config/conceptos/depurar', { simular: true }); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert(r.data.nombres.includes('Energía Activa') && r.data.nombres.includes('Cargo fijo') && r.data.nombres.includes('Leads') && !r.data.nombres.includes('Luz') && !r.data.nombres.includes('Publicidad'), JSON.stringify(r.data));
    assert(await db.collection('gastos_conceptos').findOne({ _id: c1 }));
    r = await api('POST', '/api/gastos/config/conceptos/depurar', {}); assert(r.data.cantidad >= 3 && r.data.nombres.includes('Leads'), JSON.stringify(r.data));
    assert(!(await db.collection('gastos_conceptos').findOne({ _id: c1 }))); assert(await db.collection('gastos_conceptos').findOne({ _id: c3 }));
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
