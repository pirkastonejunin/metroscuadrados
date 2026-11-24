// Remito impreso con los datos completos del cliente (24/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4417); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const cli = (await db.collection('clientes').insertOne({ orgId: ORG, apellidoRazonSocial: 'Siri SA', cuit: '30-11111111-1', domicilio: 'Calle Falsa 123', localidad: 'Junín', provincia: 'Buenos Aires', telefono: '236-4111222', email: 'siri@x.com', activo: true })).insertedId;
  const rem = (await db.collection('remitos').insertOne({ orgId: ORG, numero: 7, ventaNumero: 3, depositoNombre: 'Junín', clienteId: cli, clienteNombre: 'Siri SA', items: [{ sku: 'A', nombre: 'A', cantidad: 2 }], fecha: new Date() })).insertedId;
  const r = await api('GET', `/api/ventas/remitos/${rem}/imprimir`);
  assert.equal(r.status, 200);
  const html = typeof r.data === 'string' ? r.data : (r.raw || JSON.stringify(r.data));
  for (const t of ['Calle Falsa 123', 'Junín', 'Buenos Aires', '236-4111222', '30-11111111-1', 'siri@x.com']) assert(html.includes(t), 'falta ' + t);
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
