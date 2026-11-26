// Resumen diario por sucursal por mail (26/11/2026).
const assert = require('assert'); const { start } = require('./harness');
(async () => {
  const h = await start(4420); const { db, api, ORG } = h; const { ObjectId } = require('mongodb');
  const correo = require('../correo.js'); const resumen = require('../resumenDiario.js');
  const enviados = []; correo.__setEnvioOverride(async m => { enviados.push(m); return { id: 'x' }; });
  const PIRKA = new ObjectId(), FAB = ORG;
  await db.collection('organizaciones').updateOne({ _id: FAB }, { $set: { nombre: 'Pn Factory' } }, { upsert: true });
  await db.collection('organizaciones').insertOne({ _id: PIRKA, nombre: 'Pirka' });
  const hoy = new Date(); const ayer = new Date(Date.now() - 36 * 3600 * 1000);
  const prod = new ObjectId();
  await db.collection('productos_catalogo').insertOne({ _id: prod, orgId: FAB, nombre: 'Placa lisa', sku: 'PL', unidad: 'm2' });
  await db.collection('ventas').insertMany([
    { orgId: PIRKA, numero: 1, tipoComprobante: 'comprobante_x', estado: 'entregada', moneda: 'ARS', total: 100000, vendedor: 'Ana', clienteNombre: 'Siri', fecha: hoy },
    { orgId: PIRKA, numero: 2, tipoComprobante: 'fiscal', esFiscal: true, estado: 'pendiente', moneda: 'ARS', total: 50000, vendedor: 'Luis', clienteNombre: 'Perez', fecha: hoy },
    { orgId: PIRKA, numero: 3, tipoComprobante: 'nota_credito', estado: 'entregada', moneda: 'ARS', total: 10000, fecha: hoy },
    { orgId: PIRKA, numero: 4, tipoComprobante: 'comprobante_x', estado: 'anulada', moneda: 'ARS', total: 999999, fecha: hoy },
    { orgId: PIRKA, numero: 5, tipoComprobante: 'comprobante_x', estado: 'entregada', moneda: 'ARS', total: 777777, fecha: ayer }
  ]);
  await db.collection('cuenta_corriente_movimientos').insertMany([
    { orgId: PIRKA, tipo: 'credito', origen: 'cobro_venta', monto: 70000, moneda: 'ARS', tipoValor: 'efectivo', fecha: hoy },
    { orgId: PIRKA, tipo: 'credito', origen: 'cobro_cuenta', monto: 30000, moneda: 'ARS', tipoValor: 'cuenta', fecha: hoy },
    { orgId: PIRKA, tipo: 'credito', origen: 'cobro_venta', monto: 5, moneda: 'ARS', tipoValor: 'efectivo', fecha: hoy, anulado: true }
  ]);
  await db.collection('visitas').insertMany([
    { orgId: PIRKA, fechaHora: hoy, estado: 'sin_visita', vendedorNombre: 'Ana' }, { orgId: PIRKA, fechaHora: hoy, estado: 'vendido', vendedorNombre: 'Luis' }, { orgId: PIRKA, fechaHora: hoy, estado: 'cancelada' }
  ]);
  await db.collection('stock_movimientos').insertMany([
    { orgId: FAB, productoId: prod, tipo: 'ingreso', cantidad: 120, motivo: 'Producción de fábrica', fecha: hoy },
    { orgId: FAB, productoId: prod, tipo: 'ingreso', cantidad: 30, motivo: 'Producción de fábrica', fecha: hoy }
  ]);
  const a = resumen.ahoraAR(); const fecha = a.fecha;
  const r = await resumen.armar(db, fecha, new Date(Date.now() + 60000));
  const pi = r.sucursales.find(s => s.nombre === 'Pirka'), fa = r.sucursales.find(s => s.nombre === 'Pn Factory');
  assert.strictEqual(pi.ventas.cantidad, 2, JSON.stringify(pi.ventas));
  assert.strictEqual(pi.ventas.monto.ARS, 140000);   // 100000 + 50000 - 10000 de NC
  assert.strictEqual(pi.cobranzas.cantidad, 2); assert.strictEqual(pi.cobranzas.monto.ARS, 100000);
  assert.strictEqual(pi.visitas.total, 2); assert.strictEqual(pi.visitas.canceladas, 1);
  assert(!pi.produccion, 'Pirka no produce');
  assert(!fa.visitas, 'la fábrica no tiene visitas');
  assert.strictEqual(fa.produccion.productos[0].cantidad, 150);
  assert(/Pirka/.test(r.html) && /Producción/.test(r.html) && /Visitas/.test(r.html));
  // Config + envío
  let c = await api('POST', '/api/resumen-diario/config', { activo: true, hora: '00:00', destinatarios: 'mato@x.com; otro@y.com', diasSemana: [0,1,2,3,4,5,6] });
  assert.strictEqual(c.status, 200, JSON.stringify(c.data)); assert.strictEqual(c.data.destinatarios, 'mato@x.com; otro@y.com');
  c = await api('POST', '/api/resumen-diario/config', { hora: '25:99' }); assert.strictEqual(c.status, 400);
  const e = await resumen.revisarYEnviar(db); assert(e && e.ok, JSON.stringify(e));
  assert.strictEqual(enviados.length, 1); assert.deepStrictEqual(enviados[0].to, ['mato@x.com', 'otro@y.com']); assert(/Resumen del día/.test(enviados[0].subject));
  const e2 = await resumen.revisarYEnviar(db); assert.strictEqual(e2, null); assert.strictEqual(enviados.length, 1, 'no se manda dos veces el mismo día');
  const ah = await api('POST', '/api/resumen-diario/enviar-ahora', {}); assert.strictEqual(ah.status, 200, JSON.stringify(ah.data)); assert.strictEqual(enviados.length, 2);
  const vp = await api('GET', '/api/resumen-diario/vista-previa'); assert.strictEqual(vp.status, 200);
  console.log('TODO OK'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
