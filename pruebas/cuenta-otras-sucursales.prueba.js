// La cuenta corriente de un cliente muestra el saldo del mismo cliente (mismo CUIT) cargado en otra sucursal.
const assert = require('assert');
const { start } = require('./harness');
(async () => {
  const h = await start(4141); const { db, ids, api } = h;
  const C = String(ids.cliente);
  await db.collection('clientes').updateOne({ _id: ids.cliente }, { $set: { cuit: '20-12345678-9' } });
  const org2 = (await db.collection('organizaciones').insertOne({ nombre: 'Pirka' })).insertedId;
  const otro = (await db.collection('clientes').insertOne({ apellidoRazonSocial: 'Mismo Cliente', cuit: '20123456789', activo: true, orgId: org2 })).insertedId;
  const ajeno = (await db.collection('clientes').insertOne({ apellidoRazonSocial: 'Otro', cuit: '27999999990', activo: true, orgId: org2 })).insertedId;
  await db.collection('cuenta_corriente_saldos').insertOne({ clienteId: otro, saldo: 7000 });
  await db.collection('cuenta_corriente_saldos').insertOne({ clienteId: ajeno, saldo: 1 });
  let r = await api('GET', `/api/clientes/${C}/cuenta-corriente`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // el CUIT con guiones coincide con el de otra ficha escrita sin guiones solo si se normaliza igual en ambas; si no, no rompe
  assert(Array.isArray(r.data.otrasCuentas));
  await db.collection('clientes').updateOne({ _id: ids.cliente }, { $set: { cuit: '20123456789' } });
  r = await api('GET', `/api/clientes/${C}/cuenta-corriente`);
  assert.equal(r.data.otrasCuentas.length, 1, JSON.stringify(r.data.otrasCuentas));
  assert.equal(r.data.otrasCuentas[0].saldo, 7000); assert.equal(r.data.otrasCuentas[0].sucursal, 'Pirka');
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
