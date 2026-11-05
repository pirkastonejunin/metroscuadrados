// Recibos detallados (5/11/2026): datos del cliente, detalle de cada cheque, importe en letras, saldo, y link público del recibo de un
// cobro a cuenta (antes "Copiar link" no reconocía esa dirección y no hacía nada).
const assert = require('assert');
const { start } = require('./harness');
const { importeEnLetras } = require('../recibos');
(async () => {
  // ---- importe en letras
  const L = (n, m) => importeEnLetras(n, m);
  assert.equal(L(0), 'SON PESOS: CERO CON 00/100');
  assert.equal(L(1), 'SON PESOS: UNO CON 00/100');
  assert.equal(L(21.5), 'SON PESOS: VEINTIUNO CON 50/100');
  assert.equal(L(100), 'SON PESOS: CIEN CON 00/100');
  assert.equal(L(101), 'SON PESOS: CIENTO UNO CON 00/100');
  assert.equal(L(1000), 'SON PESOS: MIL CON 00/100');
  assert.equal(L(21000), 'SON PESOS: VEINTIUN MIL CON 00/100');
  assert.equal(L(125350.75), 'SON PESOS: CIENTO VEINTICINCO MIL TRESCIENTOS CINCUENTA CON 75/100');
  assert.equal(L(1000000), 'SON PESOS: UN MILLON DE CON 00/100'.replace('DE CON', 'DE CON'));
  assert.equal(L(2500000), 'SON PESOS: DOS MILLONES QUINIENTOS MIL CON 00/100');
  assert.equal(L(1234567), 'SON PESOS: UN MILLON DOSCIENTOS TREINTA Y CUATRO MIL QUINIENTOS SESENTA Y SIETE CON 00/100');
  assert(/DOLARES/.test(L(5, 'USD')));

  const h = await start(4141); const { db, ids, api } = h;
  const C = String(ids.cliente);
  await db.collection('clientes').updateOne({ _id: ids.cliente }, { $set: { cuit: '30-11111111-1', domicilio: 'Mitre 123', localidad: 'Junín', provincia: 'Buenos Aires', categoriaFiscal: 'responsable_inscripto', email: 'c@x.com' } });

  // ---- recibo de un cobro de venta con DOS medios: cheque + efectivo
  const V = String(ids.venta);
  let r = await api('POST', `/api/ventas/${V}/pagos`, { valores: [
    { tipoValor: 'cheque', monto: 500, chequeNumero: '00012345', chequeBanco: 'Banco Nación', chequeLibrador: 'Pérez Juan', chequeCuitLibrador: '20-22222222-2', chequeFechaVencimiento: '2026-12-15' },
    { tipoValor: 'efectivo', monto: 210.5, cuentaTipo: 'caja', cuentaId: String(ids.caja) }
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await api('GET', `/api/ventas/${V}/pagos/0/recibo`); assert.equal(r.status, 200);
  const html = r.data;
  for (const t of ['RECIBO', 'Cliente SA', '30-11111111-1', 'Mitre 123', 'Junín', 'Responsable Inscripto', '00012345', 'Banco Nación', 'Pérez Juan', '20-22222222-2', 'Vencimiento', 'Caja principal', 'SON PESOS: SETECIENTOS DIEZ CON 50/100', 'Saldo luego de este recibo', 'Firma y aclaración'])
    assert(html.includes(t), 'falta en el recibo: ' + t);
  assert(/Cobrado hasta este recibo[\s\S]*710,50/.test(html), 'cobrado hasta este recibo');
  assert(/Saldo luego de este recibo[\s\S]*499,50/.test(html), 'saldo: 1210 - 710,50');

  // ---- recibo de un cobro a cuenta con un cheque
  r = await api('POST', '/api/tesoreria/cobros-cuenta-cliente', { clienteId: C, tipoValor: 'cheque', monto: 3000, chequeNumero: '777', chequeBanco: 'Galicia', chequeLibrador: 'Gómez SA', chequeFechaVencimiento: '2026-12-30' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.reciboTipo, 'cheque');
  r = await api('GET', `/api/tesoreria/recibo-cuenta/cheque/${r.data.reciboId}`); assert.equal(r.status, 200);
  for (const t of ['RECIBO', '777', 'Galicia', 'Gómez SA', 'TRES MIL', 'cobro a cuenta corriente', 'cuenta corriente']) assert(r.data.includes(t), 'falta en el recibo a cuenta: ' + t);

  // ---- cobro a cuenta en efectivo + link público del recibo
  r = await api('POST', '/api/tesoreria/cobros-cuenta-cliente', { clienteId: C, tipoValor: 'efectivo', monto: 800, cuentaTipo: 'caja', cuentaId: String(ids.caja) });
  assert.equal(r.status, 200); assert.equal(r.data.reciboTipo, 'movimiento');
  const rid = r.data.reciboId;
  r = await api('GET', `/api/tesoreria/recibo-cuenta/movimiento/${rid}`); assert.equal(r.status, 200);
  assert(r.data.includes('Efectivo') && r.data.includes('Caja principal') && r.data.includes('OCHOCIENTOS CON 00/100'), 'recibo en efectivo');
  r = await api('POST', '/api/ventas/link-publico', { tipo: 'recibo_cuenta', subtipo: 'movimiento', id: String(rid) }); assert.equal(r.status, 200, JSON.stringify(r.data));
  const tok = r.data.token; assert(/^[0-9a-f]{48}$/.test(tok));
  const r2 = await api('POST', '/api/ventas/link-publico', { tipo: 'recibo_cuenta', subtipo: 'movimiento', id: String(rid) }); assert.equal(r2.data.token, tok, 'mismo link siempre');
  r = await api('GET', `/d/${tok}`); assert.equal(r.status, 200, String(r.data).slice(0, 200));
  assert(r.data.includes('OCHOCIENTOS') && !r.data.includes('<div class="no-imprimir">'), 'el link público muestra el recibo sin botones internos');
  r = await api('POST', '/api/ventas/link-publico', { tipo: 'recibo_cuenta', subtipo: 'otro', id: String(rid) }); assert.equal(r.status, 400);

  console.log('OK'); await h.stop(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
