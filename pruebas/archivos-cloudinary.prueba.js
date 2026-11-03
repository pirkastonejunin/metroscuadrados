// Fotos y archivos de WhatsApp: se pasan a Cloudinary y en la base queda solo el link; el CRM los sigue viendo igual.
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
(async () => {
  const h = await start(4461); const { db } = h;
  process.env.CLOUDINARY_CLOUD_NAME = 'nube'; process.env.CLOUDINARY_API_KEY = 'k123'; process.env.CLOUDINARY_API_SECRET = 'secreto';
  // Cloudinary simulado: valida la firma, guarda el archivo y lo devuelve por su link.
  const nube = new Map(); const fetchPrev = global.fetch; let caer = false;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://api.cloudinary.com/v1_1/nube/')) {
      if (caer) return new Response(JSON.stringify({ error: { message: 'caído' } }), { status: 500 });
      const fd = opts.body; const get = k => fd.get(k);
      const esperada = crypto.createHash('sha1').update(`public_id=${get('public_id')}&timestamp=${get('timestamp')}secreto`).digest('hex');
      if (esperada !== get('signature')) return new Response(JSON.stringify({ error: { message: 'firma mala' } }), { status: 401 });
      const tipo = u.split('/v1_1/nube/')[1].split('/')[0];
      const f = fd.get('file'); const buf = typeof f === 'string' ? Buffer.from(f.split(',')[1], 'base64') : Buffer.from(await f.arrayBuffer());
      const link = `https://res.cloudinary.com/nube/${tipo}/upload/v1/${get('public_id')}`; nube.set(link, buf);
      return new Response(JSON.stringify({ secure_url: link }), { status: 200 });
    }
    if (u.startsWith('https://res.cloudinary.com/nube/')) return nube.has(u) ? new Response(nube.get(u), { status: 200 }) : new Response('x', { status: 404 });
    return fetchPrev(url, opts);
  };
  const png = 'data:image/png;base64,' + Buffer.from('FOTO-DE-PRUEBA-1').toString('base64');
  await db.collection('visitas').insertOne({ fotos: [{ data: png }, { data: 'https://res.cloudinary.com/nube/ya/subida' }] });
  const pdf = Buffer.from('%PDF-1.4 contenido del cliente'), jpg = Buffer.from('JPG-DEL-CLIENTE');
  await db.collection('wa_media').insertMany([
    { _id: 'arch-1', orgId: h.ids.org, mime: 'application/pdf', data: pdf, bytes: pdf.length, at: new Date() },
    { _id: 'arch-2', orgId: h.ids.org, mime: 'image/jpeg', data: jpg, bytes: jpg.length, at: new Date() }]);
  const conv = new ObjectId();
  await db.collection('wa_mensajes').insertMany([{ orgId: h.ids.org, convId: conv, archivo: { id: 'arch-1', mime: 'application/pdf' } }, { orgId: h.ids.org, convId: conv, archivo: { id: 'arch-2', mime: 'image/jpeg' } }]);
  const app = express(); app.use(express.json());
  app.use('/api/migrar-fotos', require('../migrarFotos')); app.use('/api/bot', require('../bot'));
  const srv = await new Promise(r => { const s = app.listen(4462, () => r(s)); });
  const B = 'http://localhost:4462';
  const J = async (m, u) => { const r = await fetchPrev(B + u, { method: m }); return { status: r.status, data: await r.json().catch(() => null) }; };

  let e = (await J('GET', '/api/migrar-fotos/estado')).data;
  assert.strictEqual(e.fotos, 3, 'una foto + 2 archivos de WhatsApp: ' + JSON.stringify(e));
  // si Cloudinary se cae no se pierde nada
  caer = true; let r = (await J('POST', '/api/migrar-fotos/lote')).data;
  assert.strictEqual(r.migradas, 0); assert.ok(r.errores.length >= 1);
  assert.strictEqual(await db.collection('wa_media').countDocuments({ data: { $exists: true } }), 2, 'nada se borra si falla la subida');
  caer = false;
  let tot = 0; for (let i = 0; i < 5; i++) { r = (await J('POST', '/api/migrar-fotos/lote')).data; tot += r.migradas; if (!r.migradas) break; }
  assert.strictEqual(tot, 3); assert.strictEqual(r.fotos, 0, 'no queda nada en la base');
  const a1 = await db.collection('wa_media').findOne({ _id: 'arch-1' });
  assert.ok(a1.url.startsWith('https://res.cloudinary.com/nube/raw/'), 'el PDF va como raw: ' + a1.url); assert.ok(!a1.data); assert.ok(!a1.at, 'sin vencimiento automático');
  assert.ok((await db.collection('wa_media').findOne({ _id: 'arch-2' })).url.includes('/image/'));
  const v = await db.collection('visitas').findOne({}); assert.ok(v.fotos[0].data.startsWith('https://res.cloudinary.com/nube/image/')); assert.ok(nube.get(v.fotos[0].data).equals(Buffer.from('FOTO-DE-PRUEBA-1')));
  // el CRM sigue viendo el archivo igual (el servidor lo trae de Cloudinary)
  let res = await fetchPrev(B + '/api/bot/media/arch-1'); assert.strictEqual(res.status, 200); assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(pdf));
  res = await fetchPrev(B + '/api/bot/media/arch-2'); assert.ok(Buffer.from(await res.arrayBuffer()).equals(jpg));
  // el link de Cloudinary nunca se le muestra al navegador
  assert.ok(!(res.headers.get('location')));
  srv.close(); global.fetch = fetchPrev; console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
