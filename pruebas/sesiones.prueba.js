// Etapa 4.2: sesiones de 30 días con cierre remoto. Arranca el server.js REAL (auth real).
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri(); process.env.PORT = '4403'; process.env.OBRAS_TOKEN_SECRET = 'test-secret'; process.env.OBRAS_ADMIN_PASSWORD = 'clave-admin';
  const db = (await new MongoClient(process.env.MONGODB_URI).connect()).db('calculadora_m2');
  process.chdir(REPO);
  require(path.join(REPO, 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const B = 'http://localhost:4403';
  const req = (m, u, b, h) => fetch(B + u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
  const T = t => ({ 'x-admin-token': t });
  const login = async (ua) => { const r = await req('POST', '/api/usuarios/login', { usuario: 'admin', password: 'clave-admin' }, { 'user-agent': ua || 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120 Safari/537' }); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); return r.data.token; };
  let t1, t2;
  await caso('login crea una sesión y el token funciona', async () => {
    t1 = await login(); t2 = await login('Mozilla/5.0 (iPhone; CPU iPhone OS 17) Safari/604');
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t1))).status, 200);
    assert.strictEqual(await db.collection('sesiones').countDocuments({}), 2);
  });
  await caso('la lista muestra las 2 sesiones con dispositivo y marca la actual', async () => {
    const r = await req('GET', '/api/usuarios/sesiones', null, T(t1)); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.sesiones.length, 2);
    assert.strictEqual(r.data.sesiones.filter(s => s.actual).length, 1);
    assert.ok(r.data.sesiones.some(s => /iPhone/.test(s.dispositivo)), JSON.stringify(r.data.sesiones));
  });
  await caso('cerrar una sesión ajena (el celular) la deja sin acceso y la otra sigue', async () => {
    const lista = (await req('GET', '/api/usuarios/sesiones', null, T(t1))).data.sesiones;
    const cel = lista.find(s => !s.actual);
    assert.strictEqual((await req('POST', `/api/usuarios/sesiones/${cel._id}/cerrar`, {}, T(t1))).status, 200);
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t2))).status, 401);
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t1))).status, 200);
  });
  await caso('token falsificado o sesión inexistente da 401', async () => {
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t1.slice(0, -3) + 'abc'))).status, 401);
    const uid = (await db.collection('usuarios').findOne({})) ._id;
    const payload = `${uid}.${Date.now()}.${'0'.repeat(24)}`;
    const falso = Buffer.from(payload).toString('base64') + '.' + crypto.createHmac('sha256', 'test-secret').update('usuario.' + payload).digest('hex');
    const r = await req('GET', '/api/usuarios/me', null, T(falso)); assert.strictEqual(r.status, 401);
  });
  await caso('cerrar todas conservando la actual', async () => {
    const t3 = await login();
    const r = await req('POST', '/api/usuarios/sesiones/cerrar-todas', { conservarActual: true }, T(t3)); assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t1))).status, 401);
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t3))).status, 200);
    t1 = t3;
  });
  await caso('logout anula la sesión en el servidor', async () => {
    assert.strictEqual((await req('POST', '/api/usuarios/logout', {}, T(t1))).status, 200);
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t1))).status, 401);
  });
  await caso('sesión vencida da 401 y el uso renueva el vencimiento', async () => {
    const t = await login();
    await db.collection('sesiones').updateMany({ revocada: false }, { $set: { ultimoUso: new Date(Date.now() - 3600e3), expira: new Date(Date.now() + 864e5) } });
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t))).status, 200);
    await new Promise(r => setTimeout(r, 400));
    const s = await db.collection('sesiones').findOne({ revocada: false });
    assert.ok(new Date(s.expira).getTime() > Date.now() + 29 * 864e5, 'no renovó');
    await db.collection('sesiones').updateMany({ revocada: false }, { $set: { expira: new Date(Date.now() - 1000) } });
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t))).status, 401);
  });
  await caso('3 horas sin usar el sistema cierra la sesión; con 2 h sigue valiendo', async () => {
    const t = await login();
    await db.collection('sesiones').updateMany({ revocada: false }, { $set: { ultimoUso: new Date(Date.now() - 2 * 3600e3) } });
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t))).status, 200);
    await db.collection('sesiones').updateMany({ revocada: false }, { $set: { ultimoUso: new Date(Date.now() - 3.2 * 3600e3) } });
    const r = await req('GET', '/api/usuarios/me', null, T(t));
    assert.strictEqual(r.status, 401);
    assert.ok(/inactividad/.test(JSON.stringify(r.body || r.data || r)), 'sin mensaje de inactividad');
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t))).status, 401);
  });
  await caso('token viejo (sin sesión) sigue valiendo hasta el corte, y "cerrar todas" lo anula', async () => {
    const uid = (await db.collection('usuarios').findOne({}))._id;
    const mk = (ts) => { const p = `${uid}.${ts}`; return Buffer.from(p).toString('base64') + '.' + crypto.createHmac('sha256', 'test-secret').update('usuario.' + p).digest('hex'); };
    const viejo = mk(Date.now() - 5 * 864e5);
    await db.collection('usuarios').updateMany({}, { $unset: { sesionesDesde: '' } }); // empieza limpio
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(viejo))).status, 200);
    const t = await login();
    await req('POST', '/api/usuarios/sesiones/cerrar-todas', { conservarActual: true }, T(t));
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(viejo))).status, 401);
    assert.strictEqual((await req('GET', '/api/usuarios/me', null, T(t))).status, 200);
  });
  await caso('sin token no se puede ver ni cerrar nada', async () => {
    assert.strictEqual((await req('GET', '/api/usuarios/sesiones')).status, 401);
    assert.strictEqual((await req('POST', '/api/usuarios/logout', {})).status, 401);
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
