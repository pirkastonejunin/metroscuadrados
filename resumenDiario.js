// ---------------------------------------------------------------------------
// Resumen diario por sucursal, por mail (26/11/2026, pedido de Mato): todos los días a las 16:00 (cuando cierran) le llega un mail con lo que
// se hizo en cada sucursal: ventas, cobranzas, gastos, pedidos pendientes de entrega y, según corresponda, visitas (sucursales que cargan
// visitas, ej. Pirka) y producción (sucursales que cargan producción de fábrica, ej. Pn Factory).
//
// Se manda con la misma cuenta de Gmail conectada en Configuración → Correo. Config en la colección `resumen_diario_config` (_id 'global'):
//   { activo, hora: 'HH:MM' (Argentina), destinatarios: 'a@x.com; b@y.com', diasSemana: [1..6] (0=domingo), dia: 'hoy'|'ayer', ultimoEnvio: 'YYYY-MM-DD' }
// "hoy" = desde las 00:00 hasta el momento del envío; "ayer" = el día anterior completo. Un envío por día (se reclama con un update atómico,
// así dos instancias del servidor no lo duplican).
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');
const correo = require('./correo');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereModulo('usuarios')];
const TZ = 'America/Argentina/Buenos_Aires';

let mongoClient, mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(() => { mongoClient = nuevo; mongoConectando = null; }, (e) => { mongoConectando = null; throw e; });
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) { try { return await fn(); } catch (e) { if (!require('./reintento').reintentable(e)) throw e; mongoClient = null; return await fn(); } }
function err(status, message) { const e = new Error(message); e.status = status; return e; }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n, mon) => (mon === 'USD' ? 'U$S ' : '$ ') + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const num = n => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });

// "YYYY-MM-DD" y minutos desde medianoche en horario de Argentina.
function ahoraAR(d) {
  d = d || new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute), dow };
}
function sumarDias(fechaISO, n) { const d = new Date(fechaISO + 'T12:00:00-03:00'); d.setUTCDate(d.getUTCDate() + n); return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); }
function rangoDelDia(fechaISO, hasta) { return { desde: new Date(fechaISO + 'T00:00:00-03:00'), hasta: hasta || new Date(fechaISO + 'T23:59:59.999-03:00') }; }
function fechaLarga(fechaISO) { return new Date(fechaISO + 'T12:00:00-03:00').toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }

const FORMA_LABEL = { efectivo: 'Efectivo', cuenta: 'Transferencia', transferencia: 'Transferencia', tarjeta: 'Tarjeta', cheque: 'Cheque', mixto: 'Varios medios' };
const ESTADO_VISITA = { sin_visita: 'Sin cargar', presupuestada: 'Presupuestadas', vendido: 'Vendidas', instalado: 'Instaladas' };

// Suma por moneda: { ARS: 1000, USD: 50 }
function sumaMon(o, mon, n) { mon = mon || 'ARS'; o[mon] = r2((o[mon] || 0) + (Number(n) || 0)); }
function textoMon(o) { const k = Object.keys(o || {}); return k.length ? k.map(m => fmt(o[m], m)).join(' + ') : fmt(0); }

// Junta los números de UNA sucursal para el rango dado.
async function resumenDeOrg(db, org, desde, hasta) {
  const orgId = org._id;
  const rangoFecha = { $gte: desde, $lte: hasta };
  const out = { orgId, nombre: org.nombre || org.razonSocial || 'Sucursal' };

  // Ventas (sin anuladas ni históricas de Dux). Las notas de crédito restan; las de débito suman.
  const ventas = await db.collection('ventas').find({ orgId, fecha: rangoFecha, estado: { $ne: 'anulada' }, importado: { $ne: true } })
    .project({ total: 1, moneda: 1, tipoComprobante: 1, vendedor: 1, clienteNombre: 1, totalCobrado: 1, esFiscal: 1, cae: 1 }).toArray();
  const v = { cantidad: 0, monto: {}, notasCredito: { cantidad: 0, monto: {} }, fiscales: 0, porVendedor: {}, mayor: null };
  for (const x of ventas) {
    const mon = x.moneda || 'ARS';
    if (x.tipoComprobante === 'nota_credito') { v.notasCredito.cantidad++; sumaMon(v.notasCredito.monto, mon, x.total); sumaMon(v.monto, mon, -(x.total || 0)); continue; }
    sumaMon(v.monto, mon, x.total);
    if (x.tipoComprobante === 'nota_debito') continue;
    v.cantidad++;
    if (x.esFiscal || x.cae) v.fiscales++;
    const vend = x.vendedor || 'Sin vendedor';
    const pv = v.porVendedor[vend] || (v.porVendedor[vend] = { cantidad: 0, monto: {} });
    pv.cantidad++; sumaMon(pv.monto, mon, x.total);
    if (mon === 'ARS' && (!v.mayor || x.total > v.mayor.total)) v.mayor = { cliente: x.clienteNombre || '', total: x.total };
  }
  out.ventas = v;

  // Cobranzas (cobros de ventas y cobros a cuenta, sin anulados), por forma de pago.
  const cobros = await db.collection('cuenta_corriente_movimientos').find({ orgId, tipo: 'credito', origen: { $in: ['cobro_venta', 'cobro_cuenta'] }, anulado: { $ne: true }, fecha: rangoFecha })
    .project({ monto: 1, moneda: 1, tipoValor: 1 }).toArray();
  const c = { cantidad: cobros.length, monto: {}, porForma: {} };
  for (const x of cobros) {
    sumaMon(c.monto, x.moneda, x.monto);
    const f = FORMA_LABEL[x.tipoValor] || 'Otros';
    const pf = c.porForma[f] || (c.porForma[f] = {});
    sumaMon(pf, x.moneda, x.monto);
  }
  out.cobranzas = c;

  // Gastos cargados en el día.
  const gastos = await db.collection('gastos').find({ orgId, fecha: rangoFecha, estado: { $ne: 'anulada' } }).project({ total: 1, moneda: 1 }).toArray();
  const g = { cantidad: gastos.length, monto: {} };
  gastos.forEach(x => sumaMon(g.monto, x.moneda, x.total));
  out.gastos = g;

  // Pedidos pendientes de entrega (ventas vivas con mercadería sin entregar), al momento del resumen.
  const pend = await db.collection('ventas').find({ orgId, estado: { $in: ['pendiente', 'parcialmente_entregada'] }, tipoComprobante: { $in: ['fiscal', 'comprobante_x'] }, importado: { $ne: true } })
    .project({ fecha: 1 }).toArray();
  const hace7 = new Date(hasta.getTime() - 7 * 86400000);
  out.pendientes = { cantidad: pend.length, antiguos: pend.filter(p => new Date(p.fecha) < hace7).length };

  // Visitas: solo si la sucursal carga visitas. Se cuentan las agendadas para el día, por estado.
  const usaVisitas = await db.collection('visitas').findOne({ orgId }, { projection: { _id: 1 } });
  if (usaVisitas) {
    const vis = await db.collection('visitas').find({ orgId, fechaHora: rangoFecha, estado: { $ne: 'cancelada' } }).project({ estado: 1, vendedorNombre: 1 }).toArray();
    const porEstado = {}, porVend = {};
    vis.forEach(x => { porEstado[x.estado] = (porEstado[x.estado] || 0) + 1; const n = x.vendedorNombre || 'Sin asignar'; porVend[n] = (porVend[n] || 0) + 1; });
    const canceladas = await db.collection('visitas').countDocuments({ orgId, fechaHora: rangoFecha, estado: 'cancelada' });
    out.visitas = { total: vis.length, porEstado, porVendedor: porVend, canceladas };
  }

  // Producción: solo si la sucursal carga producción de fábrica.
  const usaProd = await db.collection('stock_movimientos').findOne({ orgId, motivo: 'Producción de fábrica' }, { projection: { _id: 1 } });
  if (usaProd) {
    const movs = await db.collection('stock_movimientos').find({ orgId, motivo: 'Producción de fábrica', tipo: 'ingreso', fecha: rangoFecha }).project({ productoId: 1, cantidad: 1 }).toArray();
    const porProd = new Map();
    movs.forEach(m => porProd.set(String(m.productoId), (porProd.get(String(m.productoId)) || 0) + (Number(m.cantidad) || 0)));
    const ids = [...porProd.keys()].map(i => { try { return new (require('mongodb').ObjectId)(i); } catch (e) { return null; } }).filter(Boolean);
    const prods = ids.length ? await db.collection('productos_catalogo').find({ _id: { $in: ids } }).project({ nombre: 1, unidad: 1 }).toArray() : [];
    const nombre = new Map(prods.map(p => [String(p._id), p]));
    const lista = [...porProd.entries()].map(([id, cant]) => ({ nombre: (nombre.get(id) || {}).nombre || 'Producto', unidad: (nombre.get(id) || {}).unidad || '', cantidad: r2(cant) })).sort((a, b) => b.cantidad - a.cantidad);
    out.produccion = { lineas: lista.length, productos: lista };
  }
  return out;
}

function bloque(titulo, filas, extra) {
  return `<div style="margin:0 0 14px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#c0562b;font-weight:bold;margin-bottom:4px">${esc(titulo)}</div>${filas}${extra || ''}</div>`;
}
function fila(etq, valor, fuerte) { return `<div style="display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px solid #f0e8e3;font-size:14px"><span style="color:#555">${etq}</span><span style="${fuerte ? 'font-weight:bold;font-size:15px' : ''}">${valor}</span></div>`; }

function htmlSucursal(s) {
  const partes = [];
  const v = s.ventas;
  let ventasHtml = fila('Ventas', `<b>${v.cantidad}</b> comprobante${v.cantidad === 1 ? '' : 's'}`) + fila('Monto vendido', textoMon(v.monto), true);
  if (v.fiscales) ventasHtml += fila('Facturas fiscales', String(v.fiscales));
  if (v.notasCredito.cantidad) ventasHtml += fila('Notas de crédito', `${v.notasCredito.cantidad} (−${textoMon(v.notasCredito.monto)})`);
  const vends = Object.entries(v.porVendedor).sort((a, b) => b[1].cantidad - a[1].cantidad);
  if (vends.length > 1) ventasHtml += fila('Por vendedor', vends.map(([n, x]) => `${esc(n)}: ${x.cantidad} (${textoMon(x.monto)})`).join('<br>'));
  if (v.mayor) ventasHtml += fila('Venta más grande', `${esc(v.mayor.cliente)} — ${fmt(v.mayor.total)}`);
  partes.push(bloque('Ventas', ventasHtml));

  const c = s.cobranzas;
  let cobHtml = fila('Cobranzas', `<b>${c.cantidad}</b> cobro${c.cantidad === 1 ? '' : 's'}`) + fila('Total cobrado', textoMon(c.monto), true);
  Object.entries(c.porForma).forEach(([f, m]) => { cobHtml += fila('&nbsp;&nbsp;' + esc(f), textoMon(m)); });
  partes.push(bloque('Cobranzas', cobHtml));

  if (s.visitas) {
    const vi = s.visitas;
    let h = fila('Visitas del día', `<b>${vi.total}</b>`, true);
    Object.keys(ESTADO_VISITA).forEach(k => { if (vi.porEstado[k]) h += fila('&nbsp;&nbsp;' + ESTADO_VISITA[k], String(vi.porEstado[k])); });
    if (vi.canceladas) h += fila('Canceladas', String(vi.canceladas));
    const pv = Object.entries(vi.porVendedor);
    if (pv.length > 1) h += fila('Por vendedor', pv.map(([n, x]) => `${esc(n)}: ${x}`).join('<br>'));
    if (vi.porEstado.sin_visita) h += `<div style="font-size:12px;color:#b45309;margin-top:3px">⚠ ${vi.porEstado.sin_visita} visita${vi.porEstado.sin_visita === 1 ? '' : 's'} todavía sin cargar el resultado.</div>`;
    partes.push(bloque('Visitas', h));
  }
  if (s.produccion) {
    const p = s.produccion;
    let h = p.lineas ? p.productos.slice(0, 12).map(x => fila(esc(x.nombre), `${num(x.cantidad)} ${esc(x.unidad)}`)).join('') + (p.productos.length > 12 ? `<div style="font-size:12px;color:#777">…y ${p.productos.length - 12} producto(s) más</div>` : '') : '<div style="font-size:14px;color:#777">Hoy no se cargó producción.</div>';
    partes.push(bloque('Producción', h));
  }
  let otros = fila('Gastos cargados', s.gastos.cantidad ? `${s.gastos.cantidad} (${textoMon(s.gastos.monto)})` : 'Ninguno');
  otros += fila('Pedidos pendientes de entrega', s.pendientes.cantidad ? `<b>${s.pendientes.cantidad}</b>${s.pendientes.antiguos ? ` <span style="color:#b45309">(${s.pendientes.antiguos} con más de 7 días)</span>` : ''}` : 'Ninguno');
  partes.push(bloque('Otros datos', otros));
  return `<div style="border:1px solid #e0cfc6;border-radius:10px;padding:14px 16px;margin:0 0 16px;background:#fff"><div style="font-size:18px;font-weight:bold;margin-bottom:10px;color:#222">${esc(s.nombre)}</div>${partes.join('')}</div>`;
}

function htmlResumen(fechaISO, sucursales, titulo) {
  const total = {}, cob = {};
  sucursales.forEach(s => { Object.entries(s.ventas.monto).forEach(([m, n]) => sumaMon(total, m, n)); Object.entries(s.cobranzas.monto).forEach(([m, n]) => sumaMon(cob, m, n)); });
  const cant = sucursales.reduce((t, s) => t + s.ventas.cantidad, 0);
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#222">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:20px 0"><tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
<tr><td style="background:#c0562b;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0"><div style="font-size:20px;font-weight:bold">${esc(titulo || 'Resumen del día')}</div><div style="font-size:13px;opacity:.9;margin-top:2px">${esc(fechaLarga(fechaISO).replace(/^./, c => c.toUpperCase()))}</div></td></tr>
<tr><td style="background:#faf5f2;padding:16px 22px;border:1px solid #e0cfc6;border-top:none;font-size:14px">
<b>Suma de las sucursales</b> (incluye ventas internas entre ellas): ${cant} venta${cant === 1 ? '' : 's'} por <b>${esc(textoMon(total))}</b> · cobrado <b>${esc(textoMon(cob))}</b></td></tr>
<tr><td style="padding:16px 0 0">${sucursales.map(htmlSucursal).join('')}</td></tr>
<tr><td style="font-size:11px;color:#888;text-align:center;padding:4px 0 16px">Resumen automático del sistema. Los montos son del día, sin ventas históricas de Dux ni comprobantes anulados.</td></tr>
</table></td></tr></table></body></html>`;
}

async function getConfig(db) {
  const c = (await db.collection('resumen_diario_config').findOne({ _id: 'global' })) || {};
  return { activo: c.activo === true, hora: /^\d{1,2}:\d{2}$/.test(c.hora || '') ? c.hora : '16:00', destinatarios: c.destinatarios || '', diasSemana: Array.isArray(c.diasSemana) ? c.diasSemana : [1, 2, 3, 4, 5, 6], dia: c.dia === 'ayer' ? 'ayer' : 'hoy', ultimoEnvio: c.ultimoEnvio || null, ultimoError: c.ultimoError || null };
}

// Arma el resumen. fechaISO = día a resumir; hasta = límite superior (para "hoy" es el momento actual).
async function armar(db, fechaISO, hastaMomento) {
  const orgs = await db.collection('organizaciones').find({ activa: { $ne: false } }).sort({ nombre: 1 }).toArray();
  const { desde, hasta } = rangoDelDia(fechaISO, hastaMomento);
  const sucursales = [];
  for (const o of orgs) sucursales.push(await resumenDeOrg(db, o, desde, hasta));
  return { fechaISO, sucursales, html: htmlResumen(fechaISO, sucursales) };
}

async function destinatariosDe(db, cfg) {
  let para = correo.mailsValidos(cfg.destinatarios);
  if (!para.length) { const c = await db.collection('correo_config').findOne({ _id: 'global' }); para = correo.mailsValidos(c && c.email); }
  return para;
}

// Envía el resumen. forzar=true ignora el "ya se mandó hoy" (botón "Enviar ahora").
async function enviar(db, { forzar, fechaISO, para } = {}) {
  const cfg = await getConfig(db);
  const ahora = ahoraAR();
  const dia = fechaISO || (cfg.dia === 'ayer' ? sumarDias(ahora.fecha, -1) : ahora.fecha);
  const hasta = (!fechaISO && cfg.dia !== 'ayer') ? new Date() : undefined;
  const destino = para && para.length ? para : await destinatariosDe(db, cfg);
  if (!destino.length) throw err(400, 'Falta indicar a qué mail se envía el resumen.');
  const r = await armar(db, dia, hasta);
  await correo.enviarMail(db, { para: destino, asunto: `Resumen del día — ${fechaLarga(dia)}`, html: r.html });
  return { ok: true, para: destino, fecha: dia, sucursales: r.sucursales.length };
}

// Corre cada pocos minutos: si ya pasó la hora configurada, es un día de envío y todavía no se mandó hoy, lo manda (un solo envío por día).
async function revisarYEnviar(db) {
  const cfg = await getConfig(db);
  if (!cfg.activo) return null;
  const ahora = ahoraAR();
  const [hh, mm] = cfg.hora.split(':').map(Number);
  if (ahora.minutos < hh * 60 + mm) return null;
  if (!cfg.diasSemana.includes(ahora.dow)) return null;
  if (cfg.ultimoEnvio === ahora.fecha) return null;
  const claim = await db.collection('resumen_diario_config').updateOne({ _id: 'global', ultimoEnvio: { $ne: ahora.fecha } }, { $set: { ultimoEnvio: ahora.fecha, ultimoIntento: new Date() } });
  if (!claim.matchedCount) return null;
  try {
    const r = await enviar(db, {});
    await db.collection('resumen_diario_config').updateOne({ _id: 'global' }, { $set: { ultimoError: null, ultimoOk: new Date() } });
    return r;
  } catch (e) {
    // Si falló, se libera el día para reintentar en la próxima vuelta.
    await db.collection('resumen_diario_config').updateOne({ _id: 'global' }, { $set: { ultimoEnvio: null, ultimoError: String(e.message || e).slice(0, 300) } });
    console.error('[resumen diario]', e.message);
    return null;
  }
}

let temporizador = null;
function programar() {
  if (temporizador || !process.env.MONGODB_URI || process.env.NODE_ENV === 'test') return;
  temporizador = setInterval(async () => { try { await revisarYEnviar(await getDb()); } catch (e) { /* sin base: se reintenta */ } }, 5 * 60 * 1000);
  temporizador.unref();
}
programar();

function soloAdmin(req) { if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) throw err(403, 'Solo un administrador puede configurar el resumen diario.'); }

router.get('/config', authAdmin, async (req, res) => {
  try { res.json(await conReintento(async () => getConfig(await getDb()))); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/config', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    const b = req.body || {};
    const set = { updatedAt: new Date() };
    if (b.activo !== undefined) set.activo = !!b.activo;
    if (b.hora !== undefined) { if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(b.hora))) throw err(400, 'La hora tiene que ser HH:MM (ej. 16:00).'); set.hora = String(b.hora).padStart(5, '0'); }
    if (b.destinatarios !== undefined) {
      const crudo = String(b.destinatarios || '').trim();
      if (crudo && !correo.mailsValidos(crudo).length) throw err(400, 'No encuentro ningún mail válido en los destinatarios.');
      set.destinatarios = correo.mailsValidos(crudo).join('; ');
    }
    if (b.diasSemana !== undefined) set.diasSemana = (Array.isArray(b.diasSemana) ? b.diasSemana : []).map(Number).filter(n => n >= 0 && n <= 6);
    if (b.dia !== undefined) set.dia = b.dia === 'ayer' ? 'ayer' : 'hoy';
    const cfg = await conReintento(async () => { const db = await getDb(); await db.collection('resumen_diario_config').updateOne({ _id: 'global' }, { $set: set }, { upsert: true }); return getConfig(db); });
    res.json(cfg);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Vista previa en el navegador (no manda nada): ?fecha=YYYY-MM-DD opcional.
router.get('/vista-previa', authAdmin, async (req, res) => {
  try {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '')) ? req.query.fecha : null;
    const r = await conReintento(async () => { const db = await getDb(); const cfg = await getConfig(db); const a = ahoraAR(); const dia = f || (cfg.dia === 'ayer' ? sumarDias(a.fecha, -1) : a.fecha); return armar(db, dia, (!f && cfg.dia !== 'ayer') ? new Date() : undefined); });
    res.set('Content-Type', 'text/html; charset=utf-8'); res.send(r.html);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Enviar ahora (botón de prueba): manda el resumen ya, aunque no sea la hora. Body: { para?, fecha? }.
router.post('/enviar-ahora', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    const b = req.body || {};
    const out = await conReintento(async () => enviar(await getDb(), { forzar: true, fechaISO: /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : null, para: correo.mailsValidos(b.para) }));
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.armar = armar; router.enviar = enviar; router.revisarYEnviar = revisarYEnviar; router.ahoraAR = ahoraAR; router.getConfig = getConfig;
module.exports = router;
