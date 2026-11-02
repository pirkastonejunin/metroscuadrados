// Prueba de asesores.js sin Google ni Mongo reales: Drive falso + base falsa en memoria.
// Uso: node test-asesores.js
process.env.MONGODB_URI = 'mongodb://stub';
process.env.NODE_ENV = 'test';
process.env.ASESORES_MAX_MB = '1';
const assert = require('assert');
const XLSX = require('xlsx');
const A = require('./asesores')._interno;

// ---- 1. Fragmentado ----
const parrafo = (n) => ('Oración de prueba número ' + n + ' sobre pegamento cementicio para porcelanato. ').repeat(8);
const largo = Array.from({ length: 12 }, (_, i) => parrafo(i)).join('\n\n');
const frs = A.partirEnFragmentos(largo);
assert(frs.length > 3, 'debería partirse en varios fragmentos');
assert(frs.every(f => f.length <= 1500), 'ningún fragmento debería pasar mucho de 1200 caracteres');
assert.deepStrictEqual(A.partirEnFragmentos('   \n\n  '), []);
assert.strictEqual(A.partirEnFragmentos('Hola.').length, 1);
const gigante = 'x'.repeat(5000);
const partesGigante = A.partirEnFragmentos(gigante);
assert(partesGigante.length >= 4 && partesGigante.every(f => f.length <= 1360), 'un párrafo sin cortes igual se parte (1200 + hasta 150 de solape)');

// ---- 2. Planilla a texto ----
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Producto', 'Rinde'], ['Pegamento X', '5 m2']]), 'Rendimientos');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Zona', 'Nota'], ['Costa', 'Usar flexible']]), 'Notas');
const bufXlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const t = A.planillaATexto(bufXlsx);
assert(t.includes('## Hoja: Rendimientos') && t.includes('Pegamento X | 5 m2') && t.includes('## Hoja: Notas'));

// ---- 3. Drive falso ----
const MIME_CARPETA = 'application/vnd.google-apps.folder';
const arbol = {
  RAIZ: [{ id: 'cV', name: 'Ventas', mimeType: MIME_CARPETA }, { id: 'cVL', name: 'VL', mimeType: MIME_CARPETA }, { id: 'cA', name: 'Administrador', mimeType: MIME_CARPETA }, { id: 'cC', name: 'Compartido', mimeType: MIME_CARPETA }],
  cV: [
    { id: 'f1', name: 'curso-pegamentos.txt', mimeType: 'text/plain', modifiedTime: 'T1', size: '100' },
    { id: 'f2', name: 'rendimientos.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: 'T1', size: '100' },
    { id: 'sub', name: 'Cursos', mimeType: MIME_CARPETA }
  ],
  sub: [{ id: 'f3', name: 'video.mp4', mimeType: 'video/mp4', modifiedTime: 'T1', size: '100' }, { id: 'f4', name: 'guia', mimeType: 'application/vnd.google-apps.document', modifiedTime: 'T1' }],
  cVL: [], cA: [],
  cC: [{ id: 'f5', name: 'normas.md', mimeType: 'text/markdown', modifiedTime: 'T1', size: '100' }]
};
const contenidos = { f1: Buffer.from('El pegamento cementicio flexible se usa para porcelanato de gran formato.\n\nSiempre doble encolado en exteriores.'), f2: bufXlsx, f5: Buffer.from('Norma interna: presupuestos vencen a los 7 días.'), f4: Buffer.from('Guía de colocación: respetar juntas de dilatación.') };
let llamadasDescarga = 0;
const driveFalso = {
  files: {
    list: async ({ q }) => {
      const m = q.match(/'([^']+)' in parents/);
      if (m) return { data: { files: arbol[m[1]] || [] } };
      if (/name='Asesores IA'/.test(q)) return { data: { files: [{ id: 'RAIZ', name: 'Asesores IA' }] } };
      return { data: { files: [] } };
    },
    get: async ({ fileId }) => { llamadasDescarga++; return { data: contenidos[fileId] }; },
    export: async ({ fileId }) => { llamadasDescarga++; return { data: contenidos[fileId] }; }
  }
};
A._setDriveParaTests(driveFalso);

// ---- 4. Base falsa mínima (solo lo que usa sincronizar) ----
function coincide(doc, filtro) {
  return Object.entries(filtro).every(([k, v]) => {
    if (v && typeof v === 'object' && '$nin' in v) return !v.$nin.includes(doc[k]);
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(doc[k]);
    return doc[k] === v;
  });
}
function coleccion() {
  const docs = [];
  return {
    docs,
    createIndex: async () => 'ok',
    findOne: async (f) => docs.find(d => coincide(d, f)) || null,
    find: (f) => ({ project: () => ({ toArray: async () => docs.filter(d => coincide(d, f)) }) }),
    insertMany: async (arr) => { docs.push(...arr.map(x => Object.assign({}, x))); },
    deleteMany: async (f) => { for (let i = docs.length - 1; i >= 0; i--) if (coincide(docs[i], f)) docs.splice(i, 1); },
    updateOne: async (f, u) => { let d = docs.find(x => coincide(x, f)); if (!d) { d = Object.assign({}, f); docs.push(d); } Object.assign(d, u.$set || {}); },
    aggregate: (pipe) => ({ toArray: async () => {
      const match = (pipe[0] && pipe[0].$match) || {}; const sel = docs.filter(d => coincide(d, match));
      return sel.length ? [{ _id: null, b: sel.reduce((s, d) => s + (d.bytes || 0), 0) }] : [];
    } })
  };
}
const cols = {}; const db = { collection: (n) => cols[n] || (cols[n] = coleccion()) };

(async () => {
  // Primera sincronización
  let r = await A.sincronizar(db, {});
  assert.strictEqual(r.archivos, 5, 've 5 archivos (incluye subcarpeta)');
  assert.strictEqual(r.leidos, 4, 'lee txt, xlsx, doc de Google y md');
  assert.strictEqual(r.errores, 1, 'el video queda como no soportado');
  const arch = cols.asesores_archivos.docs;
  assert.strictEqual(arch.find(a => a.fileId === 'f3').estado, 'no_soportado');
  assert.strictEqual(arch.find(a => a.fileId === 'f1').ambito, 'ventas');
  assert.strictEqual(arch.find(a => a.fileId === 'f5').ambito, 'compartido');
  assert(cols.asesores_fragmentos.docs.some(f => f.archivo === 'rendimientos.xlsx' && /Pegamento X/.test(f.texto)));
  assert(cols.asesores_fragmentos.docs.every(f => f.bytes > 0 && f.ambito));

  // Segunda: sin cambios no vuelve a descargar
  const antes = llamadasDescarga;
  r = await A.sincronizar(db, {});
  assert.strictEqual(r.sinCambios, 5, 'los 5 archivos no cambiaron (el video no soportado tampoco se reintenta cada noche)');
  assert.strictEqual(llamadasDescarga, antes, 'no se descargó nada de nuevo');

  // Cambia un archivo → se relee y reemplaza sus fragmentos
  arbol.cV[0].modifiedTime = 'T2'; contenidos.f1 = Buffer.from('Texto nuevo sobre impermeabilizantes.');
  r = await A.sincronizar(db, {});
  assert.strictEqual(r.leidos, 1);
  assert(cols.asesores_fragmentos.docs.filter(f => f.fileId === 'f1').every(f => /impermeabilizantes/.test(f.texto)), 'los fragmentos viejos se reemplazaron');

  // Se borra un archivo de Drive → se olvida
  arbol.cC.length = 0;
  r = await A.sincronizar(db, {});
  assert.strictEqual(r.borrados, 1);
  assert(!cols.asesores_fragmentos.docs.some(f => f.fileId === 'f5') && !cols.asesores_archivos.docs.some(a => a.fileId === 'f5'));

  // Carpeta que no existe en Drive: no borra nada de esa carpeta
  const quedaban = cols.asesores_archivos.docs.filter(a => a.ambito === 'ventas').length;
  arbol.RAIZ = arbol.RAIZ.filter(c => c.name !== 'Ventas');
  r = await A.sincronizar(db, {});
  assert.strictEqual(r.porAmbito.ventas.carpeta, false);
  assert.strictEqual(cols.asesores_archivos.docs.filter(a => a.ambito === 'ventas').length, quedaban, 'carpeta ausente no borra el conocimiento');
  arbol.RAIZ.unshift({ id: 'cV', name: 'Ventas', mimeType: MIME_CARPETA });

  // Tope de espacio: un archivo enorme queda "sin_espacio" y no rompe lo demás
  arbol.cA.push({ id: 'big', name: 'enorme.txt', mimeType: 'text/plain', modifiedTime: 'T1', size: '100' });
  contenidos.big = Buffer.from(('Texto de relleno para llenar el espacio. ').repeat(40000));
  r = await A.sincronizar(db, {});
  assert.strictEqual(r.omitidosPorEspacio, 1);
  assert.strictEqual(cols.asesores_archivos.docs.find(a => a.fileId === 'big').estado, 'sin_espacio');
  assert(!cols.asesores_fragmentos.docs.some(f => f.fileId === 'big'));

  // Mensajes de error de Drive entendibles
  assert(/Drive API no está habilitada/.test(A.mensajeDrive({ code: 403, message: 'Google Drive API has not been used in project 123 before or it is disabled' })));
  assert(/cuenta de servicio/.test(A.mensajeDrive({ code: 401, message: 'x' })));

  console.log('asesores: todas las pruebas OK');
})().catch(e => { console.error('FALLÓ:', e); process.exit(1); });
