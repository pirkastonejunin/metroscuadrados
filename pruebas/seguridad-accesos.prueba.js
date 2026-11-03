const assert = require('assert');
const path = require('path');
const REPO = require('path').join(__dirname, '..');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const mongod = await MongoMemoryServer.create();
  Object.assign(process.env, { MONGODB_URI: mongod.getUri(), PORT: '4403', OBRAS_TOKEN_SECRET: 's', TIENDA_REAL_STORE_ID: '1234', OBRAS_ADMIN_PASSWORD: 'clave' });
  const db = (await new MongoClient(process.env.MONGODB_URI).connect()).db('calculadora_m2');
  const A = new ObjectId(), Bo = new ObjectId();
  await db.collection('organizaciones').insertMany([{ _id: A, nombre: 'Piedra Negra' }, { _id: Bo, nombre: 'Pirka' }]);
  process.chdir(REPO); require(path.join(REPO, 'server.js')); await new Promise(r => setTimeout(r, 2500));
  const B = 'http://localhost:4403';
  const req = (m, u, b, h) => fetch(B + u, { method: m, headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: b ? JSON.stringify(b) : undefined }).then(async r => ({ status: r.status, data: await r.json().catch(() => null), rep: r.headers.get('x-envio-repetido') }));
  const tk = (await req('POST', '/api/usuarios/login', { usuario: 'admin', password: 'clave' })).data.token;
  const H = { 'x-admin-token': tk, 'x-org-id': String(A) };
  await caso('doble envío simultáneo del mismo alta: se guarda una sola vez', async () => {
    const body = { nombre: 'Cliente Doble', apellidoRazonSocial: 'Test', categoriaFiscal: 'consumidor_final' };
    const [r1, r2] = await Promise.all([req('POST', '/api/clientes', body, H), req('POST', '/api/clientes', body, H)]);
    assert.strictEqual(r1.status, r2.status, JSON.stringify([r1.data, r2.data]));
    assert(r1.status < 300, JSON.stringify(r1.data));
    assert.strictEqual(await db.collection('clientes').countDocuments({ nombre: /Cliente Doble/i }), 1);
    assert(r1.rep === '1' || r2.rep === '1');
  });
  await caso('pasados 3 segundos, el mismo pedido vuelve a ejecutarse', async () => {
    await new Promise(r => setTimeout(r, 3300));
    const r = await req('POST', '/api/clientes', { nombre: 'Cliente Doble', apellidoRazonSocial: 'Test', categoriaFiscal: 'consumidor_final' }, H);
    assert.strictEqual(r.rep, null);
  });
  await caso('vista Todas: anular un gasto de otra sucursal funciona', async () => {
    const g = (await db.collection('gastos').insertOne({ orgId: Bo, estado: 'activo', numero: 1, fecha: new Date(), items: [{ conceptoNombre: 'Luz', subtotal: 100 }], total: 100 })).insertedId;
    const r = await req('POST', '/api/gastos/' + g + '/anular', { motivo: 'prueba' }, { 'x-admin-token': tk, 'x-org-id': 'todas', 'x-org-operar': String(A) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual((await db.collection('gastos').findOne({ _id: g })).estado, 'anulada');
    assert.strictEqual(String((await db.collection('gastos').findOne({ _id: g })).orgId), String(Bo));
  });
  await caso('revisión de consistencia: detecta número repetido y venta sin cuenta corriente', async () => {
    const base = { orgId: A, estado: 'pendiente', tipoComprobante: 'comprobante_x', letra: 'X', numero: 77, total: 500, clienteId: new ObjectId(), clienteNombre: 'Ana', fecha: new Date(), createdAt: new Date() };
    await db.collection('ventas').insertMany([Object.assign({}, base), Object.assign({}, base, { createdAt: new Date(Date.now() + 1000) })]);
    const r = await req('GET', '/api/consistencia?dias=30', null, { 'x-admin-token': tk });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const by = k => r.data.revisiones.find(x => x.clave === k).cantidad;
    assert.strictEqual(by('ventas_numero_repetido'), 1); assert.strictEqual(by('ventas_sin_cuenta_corriente'), 2); assert.strictEqual(by('ventas_posible_duplicado'), 1);
  });
  await caso('revisión de consistencia: solo administrador / con sesión', async () => { assert.strictEqual((await req('GET', '/api/consistencia')).status, 401); });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
