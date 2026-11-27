// Pruebas de los pagos sobre órdenes de compra: se imputan solos a la factura al convertir la orden. Base falsa en memoria.
process.env.OBRAS_TOKEN_SECRET = process.env.OBRAS_TOKEN_SECRET || 'test';
const assert = require('assert');
const { ObjectId } = require('mongodb');
const { aplicarPagosDeOrden, aplicarPagoPendiente, adjuntarPagosOrdenes } = require('./compras')._interno;

function coincide(doc, filtro) {
  return Object.entries(filtro).every(([k, v]) => {
    const x = doc[k];
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, val]) => {
        if (op === '$ne') return String(x) !== String(val);
        if (op === '$gt') return x > val;
        if (op === '$gte') return x >= val;
        if (op === '$in') return val.some(y => String(y) === String(x));
        throw new Error('op no soportado ' + op);
      });
    }
    return String(x) === String(v);
  });
}
function fakeDb(datos) {
  const cols = Object.assign({}, datos);
  const col = (n) => cols[n] || (cols[n] = []);
  return {
    _cols: cols,
    collection(n) {
      return {
        find(f) { let r = col(n).filter(d => coincide(d, f || {})); const c = { sort() { return c; }, limit() { return c; }, toArray: async () => r.slice() }; return c; },
        findOne: async (f) => col(n).find(d => coincide(d, f)) || null,
        async updateOne(f, u) {
          const d = col(n).find(x => coincide(x, f)); if (!d) return { modifiedCount: 0 };
          if (u.$set) Object.assign(d, u.$set);
          if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) d[k] = (d[k] || 0) + v;
          if (u.$push) for (const [k, v] of Object.entries(u.$push)) { if (v && v.$each) (d[k] = d[k] || []).push(...v.$each); else (d[k] = d[k] || []).push(v); }
          return { modifiedCount: 1 };
        }
      };
    }
  };
}

(async () => {
  const req = { usuario: { nombre: 'Mato' }, orgId: 'org1' };
  const ordenId = new ObjectId(), provId = new ObjectId(), compraId = new ObjectId(), pago1 = new ObjectId(), pago2 = new ObjectId(), pagoOtra = new ObjectId();
  const orden = { _id: ordenId, numero: 7, moneda: 'ARS', proveedorId: provId };
  const nuevoDb = (totalCompra, moneda) => fakeDb({
    compras: [{ _id: compraId, numero: 50, proveedorId: provId, total: totalCompra, totalPagado: 0, saldoPendiente: totalCompra, moneda: moneda || 'ARS', pagos: [], estado: 'pendiente' }],
    compras_pagos: [
      { _id: pago1, proveedorId: provId, ordenId, monto: 600, montoSinAplicar: 600, tipoValor: 'efectivo', fecha: new Date('2026-11-01'), aplicaciones: [], moneda: 'ARS', cuentaTipo: 'caja', cuentaId: new ObjectId() },
      { _id: pago2, proveedorId: provId, ordenId, monto: 700, montoSinAplicar: 700, tipoValor: 'cuenta', fecha: new Date('2026-11-02'), aplicaciones: [], moneda: 'ARS' },
      { _id: pagoOtra, proveedorId: provId, ordenId: new ObjectId(), monto: 999, montoSinAplicar: 999, tipoValor: 'efectivo', fecha: new Date('2026-11-03'), aplicaciones: [] }
    ]
  });

  // 1) La factura es mayor que lo pagado: todo se imputa y la factura queda con el saldo que falta
  let db = nuevoDb(2000);
  let imp = await aplicarPagosDeOrden(db, req, orden, compraId);
  assert.strictEqual(imp.length, 2);
  let c = db._cols.compras[0];
  assert.strictEqual(c.totalPagado, 1300); assert.strictEqual(c.saldoPendiente, 700);
  assert.strictEqual(c.pagos.length, 2);
  assert.ok(c.pagos.every(p => p.pagoCuentaId && p.aplicadoDespues), 'cada línea apunta a su pago');
  assert.strictEqual(db._cols.compras_pagos.find(p => String(p._id) === String(pago1)).montoSinAplicar, 0);
  assert.strictEqual(db._cols.compras_pagos.find(p => String(p._id) === String(pago1)).aplicaciones[0].compraNumero, 50);
  assert.strictEqual(db._cols.compras_pagos.find(p => String(p._id) === String(pagoOtra)).montoSinAplicar, 999, 'el pago de OTRA orden no se toca');

  // 2) La factura es menor que lo pagado: se imputa hasta su saldo y el resto queda a cuenta de la orden
  db = nuevoDb(1000);
  imp = await aplicarPagosDeOrden(db, req, orden, compraId);
  c = db._cols.compras[0];
  assert.strictEqual(c.totalPagado, 1000); assert.strictEqual(c.saldoPendiente, 0);
  const p2 = db._cols.compras_pagos.find(p => String(p._id) === String(pago2));
  assert.strictEqual(p2.montoSinAplicar, 300, 'sobrante: 1300 pagado - 1000 de factura');
  // ...y se usa en la próxima factura de la misma orden
  const compra2 = new ObjectId();
  db._cols.compras.push({ _id: compra2, numero: 51, proveedorId: provId, total: 500, totalPagado: 0, saldoPendiente: 500, moneda: 'ARS', pagos: [], estado: 'pendiente' });
  imp = await aplicarPagosDeOrden(db, req, orden, compra2);
  assert.strictEqual(db._cols.compras[1].totalPagado, 300); assert.strictEqual(db._cols.compras[1].saldoPendiente, 200);

  // 3) Otra moneda: no se mezcla
  db = nuevoDb(2000, 'USD');
  imp = await aplicarPagosDeOrden(db, req, orden, compraId);
  assert.strictEqual(imp.length, 0); assert.strictEqual(db._cols.compras[0].totalPagado, 0);

  // 4) Pago anulado no se imputa
  db = nuevoDb(2000);
  db._cols.compras_pagos.find(p => String(p._id) === String(pago1)).anulado = true;
  imp = await aplicarPagosDeOrden(db, req, orden, compraId);
  assert.strictEqual(imp.length, 1); assert.strictEqual(db._cols.compras[0].totalPagado, 700);

  // 5) Sin pagos sobre la orden: no hace nada
  db = nuevoDb(2000); db._cols.compras_pagos = [];
  assert.strictEqual((await aplicarPagosDeOrden(db, req, orden, compraId)).length, 0);

  // 6) La orden muestra sus pagos y totales
  db = nuevoDb(2000);
  const ordenes = [{ _id: ordenId, moneda: 'ARS' }];
  await adjuntarPagosOrdenes(db, ordenes);
  assert.strictEqual(ordenes[0].pagos.length, 2); assert.strictEqual(ordenes[0].totalPagado, 1300); assert.strictEqual(ordenes[0].pagadoSinAplicar, 1300);
  await aplicarPagosDeOrden(db, req, orden, compraId);
  await adjuntarPagosOrdenes(db, ordenes);
  assert.strictEqual(ordenes[0].totalPagado, 1300); assert.strictEqual(ordenes[0].pagadoSinAplicar, 0);

  console.log('pagos sobre órdenes: todas las pruebas OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
