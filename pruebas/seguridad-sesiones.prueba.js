// Etapa 1 de seguridad: arranca el server.js REAL (auth real) contra Mongo en memoria.
const assert = require('assert');
const path = require('path');
const REPO = require('path').join(__dirname, '..');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri(); process.env.PORT = '4402'; process.env.OBRAS_TOKEN_SECRET = 'test-secret'; process.env.TIENDA_REAL_STORE_ID = '1234';
  process.env.OBRAS_ADMIN_PASSWORD = 'clave-admin';
  const db = (await new MongoClient(process.env.MONGODB_URI).connect()).db('calculadora_m2');
  await db.collection('stores').insertOne({ _id: 1234, store_id: 1234, domain: 'real.test', access_token: 'tk' });
  await db.collection('stores').insertOne({ _id: 999, store_id: 999, domain: 'demo.test', access_token: 'tk2' });
  await db.collection('cotizaciones').insertOne({ store_id: 1234, cliente: 'Juan', total: 100, fecha: new Date() });
  process.chdir(REPO);
  require(path.join(REPO, 'server.js'));
  await new Promise(r => setTimeout(r, 2500));
  const B = 'http://localhost:4402';
  const req = (m, u, b, h) => fetch(B + u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }).then(async r => ({ status: r.status, data: await r.json().catch(() => null) }));
  await caso('cotizador: tienda real sin login da 401', async () => { assert.strictEqual((await req('GET', '/api/cotizador/historial?store_id=1234')).status, 401); });
  await caso('cotizador: truco "1234x" y "01234" también da 401', async () => {
    for (const s of ['1234x', '01234', '1234.0', '1234%20']) assert.strictEqual((await req('GET', '/api/cotizador/historial?store_id=' + s)).status, 401, s);
  });
  await caso('cotizador: otra tienda sigue abierta como antes', async () => { assert.strictEqual((await req('GET', '/api/cotizador/historial?store_id=999')).status, 200); });
  await caso('rutas viejas de Tiendanube piden login', async () => {
    for (const [m, u] of [['GET', '/api/stores'], ['GET', '/api/products?store_id=1234'], ['POST', '/api/bulto/1?store_id=1234'], ['POST', '/api/bulto-cache/1?store_id=1234'], ['GET', '/admin/sincronizar-campos?store_id=1234'], ['GET', '/admin/crear-campo?store_id=1234'], ['GET', '/admin/activar-script?store_id=1234'], ['POST', '/admin/set-domain']])
      assert.strictEqual((await req(m, u, m === 'GET' ? null : {})).status, 401, m + ' ' + u);
  });
  await caso('normalizador pide login', async () => { assert.strictEqual((await req('GET', '/api/normalizador/config')).status, 401); assert.strictEqual((await req('PUT', '/api/normalizador/config', { margenes: {} })).status, 401); });
  let token;
  await caso('login correcto funciona y con sesión se accede', async () => {
    const r = await req('POST', '/api/usuarios/login', { usuario: 'admin', password: 'clave-admin' }); assert.strictEqual(r.status, 200, JSON.stringify(r.data)); token = r.data.token;
    assert.strictEqual((await req('GET', '/api/stores', null, { 'x-admin-token': token })).status, 200);
    assert.strictEqual((await req('GET', '/api/normalizador/config', null, { 'x-admin-token': token })).status, 200);
    assert.strictEqual((await req('GET', '/api/cotizador/historial?store_id=1234', null, { 'x-admin-token': token })).status, 200);
  });
  await caso('públicas siguen abiertas', async () => { const r = await fetch(B + '/public/catalogo-precios?store_id=1234'); assert.notStrictEqual(r.status, 401); });
  await caso('10 intentos fallidos bloquean el login, también con la clave correcta', async () => {
    for (let i = 0; i < 10; i++) assert.strictEqual((await req('POST', '/api/usuarios/login', { usuario: 'admin', password: 'mal' + i })).status, 401);
    const r = await req('POST', '/api/usuarios/login', { usuario: 'admin', password: 'clave-admin' }); assert.strictEqual(r.status, 429, JSON.stringify(r.data));
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
