// Al unificar proveedores no se pierde la regla de importación: se copia al unificar y se recupera si ya quedó en un registro dado de baja.
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4155); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const regla = { matchPor: 'codigoExterno', columnas: { codigo: 'Código', precio: 'Precio', stock: '', nombre: 'Producto' }, hoja: 1, filaEncabezado: 1, moneda: 'ARS', descuentos: [], recargoPct: 0, ivaIncluido: false, margenes: [], stock: { activo: false }, alertaPct: 40 };
  const viejo = new ObjectId(), nuevo = new ObjectId();
  await db.collection('proveedores').insertMany([
    { _id: viejo, orgId: ORG, razonSocial: 'MISIONES', activo: false, unificadoEn: nuevo, reglaImport: regla, updatedAt: new Date() },
    { _id: nuevo, orgId: ORG, razonSocial: 'MISIONES DECO SOLUTIONS S.R.L.', activo: true }
  ]);
  let r = await api('GET', `/api/proveedores-import/${nuevo}/regla`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.regla && r.data.regla.columnas.precio, 'Precio', 'la regla se recuperó del registro unificado');
  const p = await db.collection('proveedores').findOne({ _id: nuevo }); assert(p.reglaImport, 'quedó guardada en el proveedor vigente');
  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
