// Venta vinculada a una obra (6/11/2026): suma m² como tarea nueva con el colocador/costo de la obra y no se vincula dos veces.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4150); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const col = (await db.collection('obras_colocadores').insertOne({ nombre: 'Juan', costos: [{ tipoTrabajo: 'Piso', costoPorM2: 1500 }] })).insertedId;
  const obraId = (await db.collection('obras').insertOne({ orgId: ORG, numero: 7, cliente: { nombre: 'Ana' }, estado: 'terminada',
    tareas: [{ _id: new ObjectId(), tipoTrabajo: 'Piso', m2Presupuestados: 30, colocadorId: col, costoPorM2Aplicado: 1500, estado: 'terminada', fechaFinReal: new Date() }] })).insertedId;
  const ventaId = (await db.collection('ventas').insertOne({ orgId: ORG, numero: 55, tipoComprobante: 'comprobante_x', estado: 'pendiente', clienteNombre: 'Ana', total: 1000, fecha: new Date(),
    items: [{ nombre: 'Porcelanato 60x60', cantidad: 12, precioUnitario: 1 }, { nombre: 'Pegamento', cantidad: 3 }] })).insertedId;
  let r = await api('GET', `/api/obras/${obraId}/ventas-candidatas?q=Ana`); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.length, 1);
  r = await api('POST', `/api/obras/${obraId}/ventas`, { ventaId: String(ventaId), lineas: [{ itemIdx: 0, tipoTrabajo: 'Piso', m2: 12 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.m2, 12); assert.equal(r.data.reabierta, true);
  const o = await db.collection('obras').findOne({ _id: obraId });
  assert.equal(o.tareas.length, 2); const t = o.tareas[1];
  assert.equal(t.m2Presupuestados, 12); assert.equal(String(t.colocadorId), String(col)); assert.equal(t.costoPorM2Aplicado, 1500); assert.equal(t.estado, 'pendiente'); assert.equal(o.estado, 'en_curso');
  assert.equal((await db.collection('ventas').findOne({ _id: ventaId })).obraNumero, 7);
  r = await api('POST', `/api/obras/${obraId}/ventas`, { ventaId: String(ventaId), lineas: [{ itemIdx: 0, tipoTrabajo: 'Piso', m2: 1 }] });
  assert.equal(r.status, 409, 'no se vincula dos veces');
  r = await api('DELETE', `/api/obras/${obraId}/ventas/${ventaId}`); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await db.collection('obras').findOne({ _id: obraId })).tareas.length, 1);
  assert.equal((await db.collection('ventas').findOne({ _id: ventaId })).obraId, null);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
