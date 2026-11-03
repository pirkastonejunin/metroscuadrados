// Reparar unificaciones incompletas: lo que quedó a nombre de un proveedor ya unificado pasa al proveedor activo (siguiendo la cadena).
const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
(async () => {
  const h = await start(4481); const { db } = h;
  const factory = new ObjectId(); await db.collection('organizaciones').insertMany([{ _id: factory, nombre: 'Pn Factory' }, { _id: h.ids.org, nombre: 'Piedra Negra' }]);
  const A = (await db.collection('proveedores').insertOne({ razonSocial: 'Misiones Deco S.R.L.', activo: true, orgId: h.ids.org })).insertedId;
  const B = (await db.collection('proveedores').insertOne({ razonSocial: 'Misiones Deco SRL', activo: false, unificadoEn: A, orgId: factory })).insertedId;
  const C = (await db.collection('proveedores').insertOne({ razonSocial: 'MISIONES DECO', activo: false, unificadoEn: B, orgId: factory })).insertedId; // cadena C → B → A
  const Z = (await db.collection('proveedores').insertOne({ razonSocial: 'Huérfano', activo: false, unificadoEn: new ObjectId(), orgId: factory })).insertedId; // sin destino
  await db.collection('compras').insertMany([
    { numero: 1, proveedorId: B, proveedorNombre: 'Misiones Deco SRL', orgId: factory, total: 10, estado: 'pendiente', fecha: new Date() },
    { numero: 2, proveedorId: C, proveedorNombre: 'MISIONES DECO', orgId: factory, total: 20, estado: 'pendiente', fecha: new Date() },
    { numero: 3, proveedorId: A, proveedorNombre: 'Misiones Deco S.R.L.', orgId: h.ids.org, total: 30, estado: 'pendiente', fecha: new Date() },
    { numero: 4, proveedorId: Z, proveedorNombre: 'Huérfano', orgId: factory, total: 40, estado: 'pendiente', fecha: new Date() }]);
  await db.collection('compras_pagos').insertOne({ proveedorId: B, orgId: factory, monto: 5, fecha: new Date() });
  const J = async (m, u) => { const r = await fetch('http://localhost:4481/api/unificar-proveedores' + u, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined }); return { status: r.status, data: await r.json() }; };
  const pv = (await J('GET', '/reparar/preview')).data.items;
  assert.strictEqual(pv.length, 3, JSON.stringify(pv)); assert.ok(pv.find(x => x.nombre === 'Huérfano').sinDestino);
  assert.strictEqual(pv.find(x => x.nombre === 'MISIONES DECO').ganadorNombre, 'Misiones Deco S.R.L.', 'sigue la cadena hasta el activo');
  const r = await J('POST', '/reparar'); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  const compras = await db.collection('compras').find({}).sort({ numero: 1 }).toArray();
  assert.deepStrictEqual(compras.map(c => String(c.proveedorId)), [A, A, A, Z].map(String));
  assert.strictEqual(compras[0].proveedorNombre, 'Misiones Deco S.R.L.');
  assert.strictEqual(String((await db.collection('compras_pagos').findOne({})).proveedorId), String(A));
  const a = await db.collection('proveedores').findOne({ _id: A }); assert.ok((a.orgIdsCompartidas || []).map(String).includes(String(factory)), 'el principal queda compartido con la sucursal de origen');
  assert.strictEqual((await db.collection('proveedores').findOne({ _id: B })).activo, false);
  // la cuenta corriente del principal ahora los incluye
  const cc = (await (await fetch('http://localhost:4481/api/proveedores/' + A + '/cuenta-corriente', { headers: { 'x-org-id': 'todas' } })).json());
  assert.deepStrictEqual(cc.movimientos.filter(m => m.origen === 'compra').map(m => m.docNumero).sort(), [1, 2, 3]); assert.strictEqual(cc.saldo, 10 + 20 + 30 - 5);
  assert.strictEqual((await J('GET', '/reparar/preview')).data.items.filter(x => !x.sinDestino).length, 0, 'idempotente');
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
