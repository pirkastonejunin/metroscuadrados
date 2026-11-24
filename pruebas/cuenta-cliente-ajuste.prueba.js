// Ajuste manual de saldo en la cuenta corriente del cliente (24/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4419, { replSet: true }); const { db, ids, api } = h;
  const cid = String(ids.cliente);
  let r = await api('POST', `/api/clientes/${cid}/ajustar-saldo`, { tipo: 'debito', monto: 1500, motivo: 'diferencia con Dux' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data)); assert.strictEqual(r.data.saldo, 1500);
  r = await api('POST', `/api/clientes/${cid}/ajustar-saldo`, { tipo: 'credito', monto: 500, motivo: 'redondeo' });
  assert.strictEqual(r.data.saldo, 1000);
  r = await api('POST', `/api/clientes/${cid}/ajustar-saldo`, { tipo: 'credito', monto: 10 });
  assert.strictEqual(r.status, 400); // falta motivo
  r = await api('POST', `/api/clientes/${cid}/ajustar-saldo`, { tipo: 'credito', monto: 0, motivo: 'x' });
  assert.strictEqual(r.status, 400);
  r = await api('GET', `/api/clientes/${cid}/cuenta-corriente`);
  assert.strictEqual(r.data.saldo, 1000);
  const aj = r.data.movimientos.filter(m => m.origen === 'ajuste');
  assert.strictEqual(aj.length, 2); assert(/diferencia con Dux/.test(aj.map(m => m.concepto).join()));
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
