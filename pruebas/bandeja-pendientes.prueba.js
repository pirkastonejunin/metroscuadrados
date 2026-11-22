// Bandeja de pendientes (22/11/2026): urgencia, descartar/posponer/restaurar por usuario y seguimiento con enlace.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4165); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  global.__testUser = { _id: new ObjectId(), nombre: 'Tester', rol: { protegido: true } };
  // Un recordatorio propio que ya llegó a su hora + una visita sin confirmar de hace 3 días.
  let r = await api('POST', '/api/notificaciones/recordatorios', { titulo: 'Seguimiento: Venta 12', fechaHora: '2020-01-01T09:00', nota: 'n', link: '/admin-ventas.html?abrir=abc' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rid = r.data.id;
  r = await api('POST', '/api/notificaciones/recordatorios', { titulo: 'x', fechaHora: '2020-01-01T09:00', link: 'https://malo.com' }); assert.equal(r.status, 200);
  await db.collection('visitas').insertOne({ orgId: ORG, estado: 'sin_visita', fechaHora: new Date(Date.now() - 3 * 864e5), cliente: { nombre: 'Cliente V' }, vendedorNombre: 'Pepe' });
  r = await api('GET', '/api/notificaciones'); assert.equal(r.status, 200, JSON.stringify(r.data));
  const rec = r.data.items.find(x => x.id === rid); assert(rec, JSON.stringify(r.data.items));
  assert.equal(rec.urgencia, 'alta'); assert.equal(rec.link, '/admin-ventas.html?abrir=abc');
  assert.equal(r.data.items.find(x => x.titulo === 'x').link, '', 'solo se aceptan enlaces internos');
  const vis = r.data.items.find(x => x.tipo === 'visita'); if (vis) assert.equal(vis.urgencia, 'alta');
  assert(r.data.items.every(x => ['alta', 'media', 'baja'].includes(x.urgencia)));
  const n0 = r.data.items.length;
  // posponer
  r = await api('POST', '/api/notificaciones/ocultar', { tipo: 'recordatorio', id: rid, dias: 3 }); assert.equal(r.data.estado, 'pospuesta');
  r = await api('GET', '/api/notificaciones'); assert.equal(r.data.items.length, n0 - 1); assert.equal(r.data.ocultos, 1);
  r = await api('GET', '/api/notificaciones?ocultos=1'); assert.equal(r.data.items[0].oculto, 'pospuesta');
  // restaurar
  await api('POST', '/api/notificaciones/restaurar', { tipo: 'recordatorio', id: rid });
  r = await api('GET', '/api/notificaciones'); assert.equal(r.data.items.length, n0);
  // descartar para siempre
  if (vis) { await api('POST', '/api/notificaciones/ocultar', { tipo: 'visita', id: vis.id }); r = await api('GET', '/api/notificaciones'); assert(!r.data.items.some(x => x.id === vis.id)); }
  // pospuesto vencido vuelve solo
  await db.collection('notificaciones_estados').updateMany({}, { $set: { estado: 'pospuesta', hasta: new Date(Date.now() - 1000) } });
  r = await api('GET', '/api/notificaciones'); assert.equal(r.data.items.length, n0, 'la posposición vencida ya no oculta');
  // ordenadas: alta primero
  const orden = r.data.items.map(x => ({ alta: 3, media: 2, baja: 1 }[x.urgencia])); assert.deepEqual(orden, orden.slice().sort((a, b) => b - a));
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
