const assert = require('assert');
const { start } = require('./harness');
(async () => {
  const h = await start(4431); const { db, ids, api } = h; const A = ids.org;
  const base = { orgId: A, clienteId: ids.cliente, clienteNombre: 'Cliente SA', tipoComprobante: 'comprobante_x', moneda: 'ARS', fecha: new Date(), items: [], estado: 'pendiente', pagos: [], totalCobrado: 0 };
  let n = 10;
  await db.collection('ventas').insertMany([
    { ...base, numero: n++, vendedor: 'Ana', total: 100, saldoPendiente: 100 }, { ...base, numero: n++, vendedor: 'Ana', total: 200, saldoPendiente: 200 },
    { ...base, numero: n++, vendedor: 'Beto', total: 400, saldoPendiente: 400 }, { ...base, numero: n++, vendedor: '', total: 800, saldoPendiente: 800 },
    { ...base, orgId: new (require('mongodb').ObjectId)(), numero: n++, vendedor: 'Otra Sucursal', total: 1, saldoPendiente: 1 }
  ]);
  let r = await api('GET', '/api/ventas?vendedor=Ana'); assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.map(v => v.vendedor), ['Ana', 'Ana'], 'solo las de Ana');
  r = await api('GET', '/api/ventas?vendedor=Beto'); assert.strictEqual(r.data.length, 1);
  r = await api('GET', '/api/ventas'); assert.ok(r.data.length >= 5 - 1, 'sin filtro vienen todas las de la sucursal');
  r = await api('GET', '/api/ventas?vendedor=Nadie'); assert.strictEqual(r.data.length, 0);
  r = await api('GET', '/api/ventas/vendedores'); assert.deepStrictEqual(r.data, ['Ana', 'Beto'], 'solo vendedores de esta sucursal, sin vacíos');
  r = await api('GET', '/api/ventas/resumen?vendedor=Ana'); assert.strictEqual(r.data.vendido.ARS, 300); assert.strictEqual(r.data.cantidad, 2); assert.strictEqual(r.data.porCobrar.ARS, 300); assert.strictEqual(r.data.porDefecto, true);
  r = await api('GET', '/api/ventas/resumen'); assert.ok(r.data.vendido.ARS >= 1500);
  await db.collection('ventas').insertOne({ ...base, numero: 99, vendedor: 'Ana', total: 1000, totalCobrado: 600, saldoPendiente: 400, fecha: new Date('2026-08-10T15:00:00Z') });
  r = await api('GET', '/api/ventas/resumen?vendedor=Ana&desde=2026-08-01&hasta=2026-08-31'); assert.strictEqual(r.data.vendido.ARS, 1000); assert.strictEqual(r.data.cobrado.ARS, 600); assert.strictEqual(r.data.porCobrar.ARS, 400); assert.strictEqual(r.data.porDefecto, false);
  await db.collection('ventas').insertOne({ ...base, numero: 100, vendedor: 'Ana', total: 50, estado: 'anulada', fecha: new Date('2026-08-11T15:00:00Z') });
  r = await api('GET', '/api/ventas/resumen?vendedor=Ana&desde=2026-08-01&hasta=2026-08-31'); assert.strictEqual(r.data.vendido.ARS, 1000, 'las anuladas no suman');
  r = await api('GET', '/api/ventas/resumen?vendedor=Ana&desde=2026-08-01&hasta=2026-08-31&estado=anulada'); assert.strictEqual(r.data.vendido.ARS, 50);
  await db.collection('ventas').insertOne({ ...base, numero: 101, vendedor: 'Ana', tipoComprobante: 'nota_credito', total: 200, fecha: new Date('2026-08-12T15:00:00Z') });
  r = await api('GET', '/api/ventas/resumen?vendedor=Ana&desde=2026-08-01&hasta=2026-08-31'); assert.strictEqual(r.data.vendido.ARS, 800, 'la nota de crédito resta'); assert.strictEqual(r.data.cantidad, 1);
  r = await api('GET', '/api/ventas/export?vendedor=Ana'); assert.strictEqual(r.status, 200);
  console.log('OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
