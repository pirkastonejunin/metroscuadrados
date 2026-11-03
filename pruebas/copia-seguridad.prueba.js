const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { start } = require('./harness');
const { ObjectId, MongoClient, BSON } = require('mongodb');
const express = require('express');
let ok = 0, fallos = 0;
async function caso(n, f) { try { await f(); ok++; console.log('  ✔', n); } catch (e) { fallos++; console.log('  ✘', n, '\n     ', String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')); } }
(async () => {
  const h = await start(4421); const { db } = h;
  process.env.CLOUDINARY_CLOUD_NAME = 'nube'; process.env.CLOUDINARY_API_KEY = 'k123'; process.env.CLOUDINARY_API_SECRET = 'secreto-de-prueba';
  process.env.BACKUP_PARTE_BYTES = '30000';
  const backup = require(path.join(__dirname, '..', 'backup.js'));

  // ---- Cloudinary simulado: valida la firma como lo haría Cloudinary, guarda las partes y anota los borrados
  const nube = { archivos: new Map(), borrados: [], fallarEnSubida: 0, subidas: 0 };
  const fetchPrev = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.cloudinary.com/v1_1/nube/raw/upload')) {
      nube.subidas++;
      if (nube.fallarEnSubida && nube.subidas === nube.fallarEnSubida) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      const fd = opts.body; const get = k => fd.get(k);
      const esperada = crypto.createHash('sha1').update(`folder=${get('folder')}&public_id=${get('public_id')}&timestamp=${get('timestamp')}${process.env.CLOUDINARY_API_SECRET}`).digest('hex');
      if (esperada !== get('signature') || get('api_key') !== 'k123') return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid Signature' } }) };
      const buf = Buffer.from(await get('file').arrayBuffer()); if (buf.length > 10 * 1024 * 1024) return { ok: false, status: 400, json: async () => ({ error: { message: 'File size too large' } }) };
      const pid = get('folder') + '/' + get('public_id'); nube.archivos.set(pid, buf);
      return { ok: true, status: 200, json: async () => ({ public_id: pid, secure_url: 'https://res.cloudinary.com/nube/raw/upload/' + pid, bytes: buf.length }) };
    }
    if (u.startsWith('https://api.cloudinary.com/v1_1/nube/resources/raw/upload') && opts.method === 'DELETE') {
      new URL(u).searchParams.getAll('public_ids[]').forEach(p => { nube.borrados.push(p); nube.archivos.delete(p); });
      return { ok: true, status: 200, json: async () => ({ deleted: {} }) };
    }
    return fetchPrev(url, opts);
  };

  // ---- datos de prueba variados
  const org = new ObjectId(), cli = new ObjectId();
  await db.collection('clientes_t').createIndex({ nombre: 1 }, { unique: true, name: 'nombre_unico' });
  const docs = [];
  for (let i = 0; i < 60; i++) docs.push({ _id: new ObjectId(), nombre: 'Cliente ñandú ' + i, orgId: org, fecha: new Date(2026, 9, 1 + (i % 28)), saldo: 1234.56 * i, anidado: { a: [1, 2, { b: 'x' }], c: null }, foto: 'data:image/png;base64,' + 'A'.repeat(2500), activo: i % 2 === 0 });
  await db.collection('clientes_t').insertMany(docs);
  await db.collection('ventas_t').insertMany([{ clienteId: cli, total: 100, items: [{ sku: 'A', cant: 2 }] }, { clienteId: cli, total: 250.5, items: [] }]);
  const CLAVE = 'una-clave-de-prueba-bien-larga';

  await caso('sin clave o sin Cloudinary no hace nada y avisa', async () => {
    delete process.env.BACKUP_CLAVE;
    await assert.rejects(() => backup.ejecutarCopia(), /BACKUP_CLAVE/);
    process.env.BACKUP_CLAVE = 'corta'; await assert.rejects(() => backup.ejecutarCopia(), /BACKUP_CLAVE/);
    process.env.BACKUP_CLAVE = CLAVE;
  });
  let copia1;
  await caso('copia completa: varias partes, firmadas, cifradas (no se lee el contenido) y registradas', async () => {
    const r = await backup.ejecutarCopia({ origen: 'manual', usuario: 'Mato' });
    assert.ok(r.partes > 2, 'varias partes: ' + r.partes);
    copia1 = await db.collection('backups_copias').findOne({ estado: 'ok' });
    assert.strictEqual(copia1.partes.length, r.partes); assert.strictEqual(copia1.colecciones.clientes_t, 60); assert.strictEqual(copia1.origen, 'manual');
    for (const [pid, buf] of nube.archivos) { assert.ok(!buf.toString('latin1').includes('Cliente'), 'la parte no debe ser legible'); assert.ok(pid.startsWith('backups-sistema/copia-')); }
    for (const p of copia1.partes) assert.strictEqual(crypto.createHash('sha256').update(nube.archivos.get(p.publicId)).digest('hex'), p.sha256);
  });
  const partesEnOrden = () => copia1.partes.slice().sort((a, b) => a.n - b.n).map(p => nube.archivos.get(p.publicId));
  await caso('restaurar en una base nueva: mismos documentos, mismos tipos (ObjectId, fechas) e índices', async () => {
    const dest = h.db.client.db('restaurada_test');
    const cont = await backup.restaurar(partesEnOrden(), dest, CLAVE);
    assert.strictEqual(cont.clientes_t, 60); assert.strictEqual(cont.ventas_t, 2);
    for (const col of ['clientes_t', 'ventas_t']) {
      const a = await db.collection(col).find({}).sort({ _id: 1 }).toArray(), b = await dest.collection(col).find({}).sort({ _id: 1 }).toArray();
      assert.strictEqual(BSON.EJSON.stringify(b, { relaxed: false }), BSON.EJSON.stringify(a, { relaxed: false }), 'igual en ' + col);
    }
    assert.ok((await dest.collection('clientes_t').indexes()).some(i => i.name === 'nombre_unico' && i.unique), 'índice único recreado');
  });
  await caso('con otra clave o con una parte alterada no restaura', async () => {
    await assert.rejects(() => backup.restaurar(partesEnOrden(), h.db.client.db('restaurada_x'), 'otra-clave-distinta-1234'), /descifrar/);
    const malas = partesEnOrden().map(b => Buffer.from(b)); malas[0][malas[0].length - 5] ^= 0xff;
    await assert.rejects(() => backup.restaurar(malas, h.db.client.db('restaurada_y'), CLAVE), /descifrar/);
  });
  await caso('si falla una subida a mitad: la copia queda como error y se borra lo ya subido', async () => {
    const antes = nube.archivos.size; nube.subidas = 0; nube.fallarEnSubida = 2;
    await assert.rejects(() => backup.ejecutarCopia(), /boom|rechaz/);
    nube.fallarEnSubida = 0;
    assert.strictEqual(nube.archivos.size, antes, 'no tiene que quedar nada de la copia fallida en Cloudinary');
    assert.strictEqual(await db.collection('backups_copias').countDocuments({ estado: 'error' }), 1);
    assert.strictEqual(await db.collection('backups_copias').countDocuments({ estado: 'ok' }), 1);
  });
  await caso('no corren dos copias a la vez', async () => {
    const { insertedId } = await db.collection('backups_copias').insertOne({ estado: 'en_curso', inicio: new Date(), partes: [] });
    await assert.rejects(() => backup.ejecutarCopia(), /en curso/);
    await db.collection('backups_copias').deleteOne({ _id: insertedId });
  });
  await caso('se conservan solo las últimas 14 copias y se borran las partes de las viejas', async () => {
    process.env.BACKUP_PARTE_BYTES = '5000000';
    for (let i = 0; i < 16; i++) await backup.ejecutarCopia();
    const buenas = await db.collection('backups_copias').find({ estado: 'ok' }).toArray();
    assert.strictEqual(buenas.length, 14);
    const vivas = new Set(buenas.flatMap(c => c.partes.map(p => p.publicId)));
    assert.deepStrictEqual([...nube.archivos.keys()].filter(k => !vivas.has(k)), [], 'solo quedan partes de copias vigentes');
    assert.ok(nube.borrados.length > 0);
  });
  await caso('API: solo el administrador ve y lanza copias', async () => {
    const app = express(); app.use('/api/backups', backup); // el harness simula authUsuario con global.__testUser
    const srv = await new Promise(r => { const s = app.listen(4422, () => r(s)); });
    const get = async (m, u) => { const r = await fetch('http://localhost:4422' + u, { method: m }); return { status: r.status, data: await r.json() }; };
    global.__testUser = { nombre: 'Vendedor', rol: { protegido: false } };
    assert.strictEqual((await get('GET', '/api/backups')).status, 403); assert.strictEqual((await get('POST', '/api/backups/ejecutar')).status, 403);
    global.__testUser = { nombre: 'Mato', rol: { protegido: true } };
    const l = await get('GET', '/api/backups'); assert.strictEqual(l.status, 200); assert.strictEqual(l.data.configurado.clave, true); assert.ok(l.data.copias.length >= 14);
    srv.close();
  });
  console.log(`\n${fallos ? fallos + ' FALLO(S)' : 'TODO OK'} (${ok}/${ok + fallos})`);
  process.exit(fallos ? 1 : 0);
})().catch(e => { console.error('ERROR DE ENTORNO', e); process.exit(2); });
