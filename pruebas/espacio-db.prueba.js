// Informe de espacio de la base (6/11/2026): total y colecciones más pesadas.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4146); const { api } = h;
  let r = await api('GET', '/api/espacio-db'); assert.equal(r.status, 200, JSON.stringify(r.data)); assert(r.data.limiteMB > 0 && 'nivel' in r.data);
  r = await api('GET', '/api/espacio-db?detalle=1'); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert(Array.isArray(r.data.colecciones) && r.data.colecciones.length > 0, 'lista de colecciones');
  const t = r.data.colecciones.map(c => c.totalMB); assert.deepEqual(t, [...t].sort((a, b) => b - a), 'ordenadas de mayor a menor');
  assert(r.data.colecciones[0].coleccion && 'docs' in r.data.colecciones[0] && 'indicesMB' in r.data.colecciones[0]);
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
