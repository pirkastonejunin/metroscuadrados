// La cuenta corriente del proveedor avisa de los comprobantes con su mismo nombre que no entraron (otro registro / otra sucursal / anulados no).
const assert = require('assert');
const { start } = require('./harness');
const { ObjectId } = require('mongodb');
(async () => {
  const h = await start(4471); const { db } = h;
  const otraOrg = new ObjectId(); await db.collection('organizaciones').insertOne({ _id: otraOrg, nombre: 'Pirka' });
  const dup = (await db.collection('proveedores').insertOne({ razonSocial: 'Misiones Deco Solutions S.R.L.', activo: true, orgId: h.ids.org })).insertedId;
  const base = { proveedorNombre: 'MISIONES DECO SOLUTIONS S.R.L.', estado: 'pendiente', total: 100, fecha: new Date(), moneda: 'ARS' };
  await db.collection('compras').insertMany([
    Object.assign({}, base, { numero: 1, proveedorId: h.ids.provAcme, orgId: h.ids.org, proveedorNombre: 'Acme SA' }),
    Object.assign({}, base, { numero: 2, proveedorId: h.ids.provAcme, orgId: h.ids.org, proveedorNombre: 'misiones deco solutions s.r.l.' }), // mismo registro, incluida
  ]);
  await db.collection('proveedores').updateOne({ _id: h.ids.provAcme }, { $set: { razonSocial: 'Misiones Deco Solutions S.R.L.' } });
  await db.collection('compras').insertMany([
    Object.assign({}, base, { numero: 3, proveedorId: dup, orgId: h.ids.org }),                       // otro registro del proveedor
    Object.assign({}, base, { numero: 4, proveedorId: h.ids.provAcme, orgId: otraOrg }),              // otra sucursal
    Object.assign({}, base, { numero: 5, proveedorId: dup, orgId: h.ids.org, estado: 'anulada' }),    // anulada: no cuenta
  ]);
  await db.collection('proveedores').updateOne({ _id: dup }, { $set: { activo: false, unificadoEn: h.ids.provAcme } });
  const call = async (org) => (await fetch('http://localhost:4471/api/proveedores/' + h.ids.provAcme + '/cuenta-corriente', { headers: org ? { 'x-org-id': String(org) } : {} })).json();
  const d = await call(h.ids.org);
  assert.deepStrictEqual(d.movimientos.map(m => m.docNumero).sort(), [1, 2, 4], 'la cuenta es única: entran las de este registro, de todas las sucursales (no las de otro registro)');
  const por = Object.fromEntries(d.noIncluidos.map(n => [n.numero, n.motivo]));
  assert.deepStrictEqual(por, { 3: 'otro_proveedor' }, JSON.stringify(d.noIncluidos));
  const o3 = d.noIncluidos.find(n => n.numero === 3).otroRegistro; assert.strictEqual(o3.activo, false); assert.strictEqual(o3.unificadoEn, String(h.ids.provAcme));
  const t = await call('todas'); assert.deepStrictEqual(t.movimientos.map(m => m.docNumero).sort(), [1, 2, 4]); assert.deepStrictEqual(t.noIncluidos.map(n => n.numero), [3]);
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
