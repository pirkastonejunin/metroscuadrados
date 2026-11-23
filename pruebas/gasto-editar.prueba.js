const assert = require('assert');
const { start } = require('./harness');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const h = await start(4412, { replSet: true }); const { db, ids, api } = h; const A = ids.org;
  const c1 = (await db.collection('gastos_conceptos').insertOne({ nombre: 'Fletes', activo: true, compartido: true, orgId: null })).insertedId;
  const c2 = (await db.collection('gastos_conceptos').insertOne({ nombre: 'Combustible', activo: true, compartido: true, orgId: null })).insertedId;
  const mk = (extra) => db.collection('gastos').insertOne(Object.assign({ numero: 1, orgId: A, proveedorId: ids.provAcme, proveedorNombre: 'Acme SA', fecha: new Date(), moneda: 'ARS', estado: 'activo', tipoComprobante: 'factura_a', puntoVenta: '1', comprobanteNumero: '100',
    items: [{ conceptoId: c1, conceptoNombre: 'Fletes', cantidad: 1, precioUnitario: 1000, subtotal: 1000, observaciones: '', alicuotaIva: 21, importeIva: 210 }], subtotal: 1000, total: 1210, totalPagado: 0, saldoPendiente: 1210, pagos: [] }, extra || {})).then(r => String(r.insertedId));
  await caso('corrige concepto, monto y fecha; recalcula total y saldo', async () => {
    const id = await mk();
    const r = await api('PUT', '/api/gastos/' + id, { fecha: '2026-10-05', items: [{ conceptoId: String(c2), cantidad: 2, precioUnitario: 500, alicuotaIva: 10.5 }] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.items[0].conceptoNombre, 'Combustible');
    assert.strictEqual(r.data.subtotal, 1000); assert.strictEqual(r.data.total, 1105); assert.strictEqual(r.data.saldoPendiente, 1105);
    assert.strictEqual(String(r.data.fecha).slice(0, 10), '2026-10-05');
  });
  await caso('con pagos: el saldo descuenta lo pagado y no deja total menor a lo pagado', async () => {
    const id = await mk({ totalPagado: 1000, saldoPendiente: 210 });
    const ok1 = await api('PUT', '/api/gastos/' + id, { items: [{ conceptoId: String(c1), cantidad: 1, precioUnitario: 2000, alicuotaIva: 21 }] });
    assert.strictEqual(ok1.status, 200, JSON.stringify(ok1.data)); assert.strictEqual(ok1.data.total, 2420); assert.strictEqual(ok1.data.saldoPendiente, 1420);
    const mal = await api('PUT', '/api/gastos/' + id, { items: [{ conceptoId: String(c1), cantidad: 1, precioUnitario: 100, alicuotaIva: 0 }] });
    assert.strictEqual(mal.status, 400);
  });
  await caso('no edita anulados ni permite duplicar comprobante de otro gasto', async () => {
    const an = await mk({ estado: 'anulada', comprobanteNumero: '300' });
    assert.strictEqual((await api('PUT', '/api/gastos/' + an, { observaciones: 'x' })).status, 400);
    const a = await mk({ comprobanteNumero: '400' }); const b = await mk({ comprobanteNumero: '500' });
    assert.strictEqual((await api('PUT', '/api/gastos/' + b, { comprobanteNumero: '400' })).status, 400);
    assert.strictEqual((await api('PUT', '/api/gastos/' + a, { comprobanteNumero: '400', observaciones: 'ok' })).status, 200);
  });
  await caso('el detalle del Estado de resultados trae el gastoId', async () => {
    const id = await mk({ comprobanteNumero: '600', fecha: new Date() });
    const mes = new Date().toISOString().slice(0, 7);
    const r = await api('GET', '/api/informes/resultados/detalle?tipo=gasto&concepto=Fletes&mes=' + mes);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert(r.data.filas.some(f => f.gastoId === id), 'falta gastoId: ' + JSON.stringify(r.data.filas));
  });
  await caso('cambiar concepto en lote: solo las líneas con el concepto actual, y respeta el resto del gasto', async () => {
    const lead = (await db.collection('gastos_conceptos').insertOne({ nombre: 'Lead', activo: false, compartido: true, orgId: null })).insertedId;
    const g1 = await mk({ comprobanteNumero: '701', items: [{ conceptoId: c1, conceptoNombre: 'Fletes', cantidad: 1, precioUnitario: 10, subtotal: 10, alicuotaIva: 21, importeIva: 2.1 }, { conceptoId: c2, conceptoNombre: 'Combustible', cantidad: 1, precioUnitario: 5, subtotal: 5, alicuotaIva: 21, importeIva: 1 }] });
    const g2 = await mk({ comprobanteNumero: '702' });
    const r = await api('POST', '/api/gastos/cambiar-concepto', { gastoIds: [g1, g2], desde: 'fletes', conceptoId: String(lead) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.gastos, 2); assert.strictEqual(r.data.renglones, 2);
    const d1 = await db.collection('gastos').findOne({ _id: new (require('mongodb').ObjectId)(g1) });
    assert.strictEqual(d1.items[0].conceptoNombre, 'Lead'); assert.strictEqual(d1.items[1].conceptoNombre, 'Combustible');
    assert.strictEqual((await db.collection('gastos_conceptos').findOne({ _id: lead })).activo, true);
    assert.strictEqual((await api('POST', '/api/gastos/cambiar-concepto', { gastoIds: [], desde: 'x', conceptoId: String(lead) })).status, 400);
  });
  await caso('cambiar concepto de todo un proveedor (todos los años) con simulación', async () => {
    const c3 = (await db.collection('gastos_conceptos').insertOne({ nombre: 'Peajes', activo: true, compartido: true, orgId: null })).insertedId;
    const { ObjectId } = require('mongodb');
    const viejo = await mk({ comprobanteNumero: '801', fecha: new Date('2023-03-10') }), nuevo = await mk({ comprobanteNumero: '802', fecha: new Date('2026-03-10') });
    const sim = await api('POST', '/api/gastos/cambiar-concepto', { gastoIds: [nuevo], desde: 'Fletes', conceptoId: String(c3), porProveedor: true, simular: true });
    assert.strictEqual(sim.status, 200, JSON.stringify(sim.data)); assert(sim.data.simulado && sim.data.gastos >= 2);
    assert.strictEqual((await db.collection('gastos').findOne({ _id: new ObjectId(viejo) })).items[0].conceptoNombre, 'Fletes', 'la simulación no cambia nada');
    const r = await api('POST', '/api/gastos/cambiar-concepto', { gastoIds: [nuevo], desde: 'Fletes', conceptoId: String(c3), porProveedor: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await db.collection('gastos').findOne({ _id: new ObjectId(viejo) })).items[0].conceptoNombre, 'Peajes');
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
