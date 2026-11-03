// Corre todas las pruebas automáticas (pruebas/*.prueba.js) una por una, cada una con su propia base de datos en memoria.
// Uso: npm test           (todas)      |   npm test -- seguridad     (solo las que tengan "seguridad" en el nombre)
// Regla de trabajo (auditoría 3/11/2026): no se publica (git push) si esto no da todo verde.
// Requiere las dependencias de desarrollo (mongodb-memory-server) y, para la prueba de encabezados, playwright.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const filtro = process.argv[2] || '';
const archivos = fs.readdirSync(__dirname).filter(f => f.endsWith('.prueba.js') && f.includes(filtro)).sort();
const limpiarBases = () => { try { for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('mongo')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch (e) { /* nada */ } };
const esFalloDeEntorno = salida => /failed to start within|ERROR DE ENTORNO|ECONNREFUSED 127\.0\.0\.1:\d+.*mongo|spawn .* ENOENT/i.test(salida);
let fallaron = [];
const t0 = Date.now();
for (const f of archivos) {
  let ok = false, salida = '';
  for (let intento = 1; intento <= 3 && !ok; intento++) {
    limpiarBases();
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 240000, env: process.env });
    salida = (r.stdout || '') + (r.stderr || '');
    ok = r.status === 0;
    // Si no arrancó la base de prueba (problema del entorno, no del código) se reintenta; un fallo real no se reintenta.
    if (!ok && !esFalloDeEntorno(salida)) break;
  }
  console.log((ok ? '✔ ' : '✘ ') + f.replace('.prueba.js', ''));
  if (!ok) { fallaron.push(f); console.log(salida.split('\n').slice(-25).join('\n')); }
}
limpiarBases();
console.log(`\n${fallaron.length ? fallaron.length + ' PRUEBA(S) FALLARON: ' + fallaron.join(', ') : 'TODAS LAS PRUEBAS PASARON'} (${archivos.length - fallaron.length}/${archivos.length}, ${Math.round((Date.now() - t0) / 1000)} s)`);
process.exit(fallaron.length ? 1 : 0);
