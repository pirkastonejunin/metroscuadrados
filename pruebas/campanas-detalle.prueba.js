// Detalle de la tabla de campañas: quiénes son los leads / clientes / compradores de una campaña.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4156); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const c1 = new ObjectId(); const d = new Date(Date.now() - 5 * 864e5);
  await db.collection('leads_whatsapp').insertMany([
    { orgId: ORG, nombre: 'Ana', telefono: '5492364111111', campana: 'Camp A', creadoOrigen: d, clienteId: c1, estado: 'Nuevo' },
    { orgId: ORG, nombre: 'Beto', telefono: '5492364222222', campana: 'Camp A', creadoOrigen: d, clienteId: null, estado: 'Nuevo' },
    { orgId: ORG, nombre: 'Cami', telefono: '5492364333333', campana: '', creadoOrigen: d, clienteId: null, estado: 'Nuevo' }
  ]);
  await db.collection('ventas').insertOne({ orgId: ORG, clienteId: c1, fecha: new Date(), total: 5000, moneda: 'ARS', numero: 1, estado: 'entregada' });
  let r = await api('GET', '/api/leads/campanas/detalle?campana=Camp%20A&tipo=leads'); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.items.length, 2);
  r = await api('GET', '/api/leads/campanas/detalle?campana=Camp%20A&tipo=clientes'); assert.equal(r.data.items.length, 1); assert.equal(r.data.items[0].nombre, 'Ana');
  r = await api('GET', '/api/leads/campanas/detalle?campana=Camp%20A&tipo=compraron'); assert.equal(r.data.items.length, 1); assert.equal(r.data.items[0].montoARS, 5000);
  r = await api('GET', '/api/leads/campanas/detalle?campana=' + encodeURIComponent('(sin campaña)') + '&tipo=leads'); assert.equal(r.data.items.length, 1); assert.equal(r.data.items[0].nombre, 'Cami');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
