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
  r = await api('GET', '/api/ventas/resumen?vendedor=Ana'); assert.strictEqual(r.data.mes.monto.ARS, 300); assert.strictEqual(r.data.mes.cantidad, 2);
  r = await api('GET', '/api/ventas/resumen'); assert.ok(r.data.mes.monto.ARS >= 1500);
  r = await api('GET', '/api/ventas/export?vendedor=Ana'); assert.strictEqual(r.status, 200);
  console.log('OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
