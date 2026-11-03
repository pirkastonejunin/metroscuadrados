const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
const express = require('express');
(async () => {
  const h = await start(4451); const { db } = h;
  const aud = require('../auditoria');
  const org = new ObjectId(), oid = new ObjectId();
  await db.collection('organizaciones').insertOne({ _id: org, nombre: 'Pirka' });
  const app = express(); app.use(express.json());
  app.use('/api', aud.middleware);
  const quien = (req, nombre = 'Ana') => { req.usuario = { _id: new ObjectId(), nombre, rol: { nombre: 'Vendedor' } }; req.orgId = org; };
  app.post('/api/ventas', (req, res) => { quien(req); res.json({ _id: oid, numero: 7 }); });
  app.put('/api/clientes/:id', (req, res) => { quien(req, 'Beto'); res.json({ ok: true, nombre: 'Cliente Uno' }); });
  app.post('/api/ventas/:id/anular', (req, res) => { quien(req); res.status(400).json({ error: 'no' }); });
  app.post('/api/usuarios/login', (req, res) => { quien(req); res.json({ ok: true }); });
  app.post('/api/publico/lead', (req, res) => res.json({ ok: true })); // sin usuario
  app.get('/api/ventas', (req, res) => { quien(req); res.json([]); });
  app.post('/api/rompe', (req, res) => { quien(req); res.status(200).json({ ok: true }); });
  app.use('/api/auditoria', aud);
  const srv = await new Promise(r => { const s = app.listen(4452, () => r(s)); });
  const call = async (m, u, b) => { const r = await fetch('http://localhost:4452' + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json() }; };
  const esperar = async n => { for (let i = 0; i < 40; i++) { if (await db.collection('auditoria').countDocuments({}) >= n) return; await new Promise(r => setTimeout(r, 50)); } };

  await call('POST', '/api/ventas', { clienteId: String(oid), items: [{ sku: 'A', cant: 2 }], password: 'secreta123', pin: '4321', token: 'abc', apiKey: 'zzz', foto: 'data:image/png;base64,' + 'A'.repeat(5000), obs: 'x'.repeat(500) });
  await call('PUT', '/api/clientes/' + oid, { nombre: 'Cliente Uno', claveFiscal: 'no-guardar', cuit: '20-1-1' });
  await call('POST', '/api/ventas/' + oid + '/anular', { motivo: 'error' });  // falla: no se registra
  await call('POST', '/api/usuarios/login', { usuario: 'a', password: 'b' });  // omitido
  await call('POST', '/api/publico/lead', { nombre: 'x' });                    // sin usuario
  await call('GET', '/api/ventas');                                            // lectura
  await esperar(2); await new Promise(r => setTimeout(r, 300));
  const filas = await db.collection('auditoria').find({}).sort({ fecha: 1 }).toArray();
  assert.strictEqual(filas.length, 2, 'solo se registran los cambios exitosos de usuarios identificados: ' + filas.map(f => f.ruta));
  const v = filas[0];
  assert.strictEqual(v.usuarioNombre, 'Ana'); assert.strictEqual(v.modulo, 'ventas'); assert.strictEqual(v.metodo, 'POST'); assert.strictEqual(v.numero, 7); assert.strictEqual(v.entidadId, String(oid)); assert.strictEqual(String(v.orgId), String(org));
  const s = JSON.stringify(v.datos);
  for (const prohibido of ['secreta123', '4321', 'abc', 'zzz', 'AAAAAAAAAA']) assert.ok(!s.includes(prohibido), 'no debe guardar: ' + prohibido);
  assert.strictEqual(v.datos.password, '***'); assert.strictEqual(v.datos.foto, '[archivo]'); assert.ok(v.datos.obs.length < 200); assert.strictEqual(v.datos.items[0].sku, 'A');
  assert.strictEqual(filas[1].ruta, '/api/clientes/:id'); assert.strictEqual(filas[1].usuarioNombre, 'Beto'); assert.strictEqual(filas[1].nombre, 'Cliente Uno'); assert.strictEqual(filas[1].datos.claveFiscal, '***');
  assert.ok((await db.collection('auditoria').indexes()).some(i => i.name === 'ttl_fecha' && i.expireAfterSeconds > 0), 'índice de borrado automático');

  // consulta (solo administrador, con filtros)
  global.__testUser = { nombre: 'Mato', rol: { protegido: true } };
  let r = await call('GET', '/api/auditoria'); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.total, 2); assert.strictEqual(r.data.filas[0].sucursal, 'Pirka'); assert.deepStrictEqual(r.data.usuarios, ['Ana', 'Beto']);
  r = await call('GET', '/api/auditoria?usuario=Beto'); assert.strictEqual(r.data.total, 1);
  r = await call('GET', '/api/auditoria?modulo=ventas'); assert.strictEqual(r.data.total, 1);
  r = await call('GET', '/api/auditoria?q=7'); assert.strictEqual(r.data.total, 1, 'por número');
  r = await call('GET', '/api/auditoria?q=' + oid); assert.strictEqual(r.data.total, 2, 'por id de registro');
  r = await call('GET', '/api/auditoria?q=Cliente%20Uno'); assert.strictEqual(r.data.total, 1, 'por nombre');
  const hoy = new Date().toISOString().slice(0, 10);
  r = await call('GET', `/api/auditoria?desde=${hoy}&hasta=${hoy}`); assert.strictEqual(r.data.total, 2);
  r = await call('GET', '/api/auditoria?desde=2020-01-01&hasta=2020-01-02'); assert.strictEqual(r.data.total, 0);
  global.__testUser = { nombre: 'Vendedor', rol: { protegido: false } };
  r = await call('GET', '/api/auditoria'); assert.strictEqual(r.status, 403);
  console.log('OK'); srv.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
