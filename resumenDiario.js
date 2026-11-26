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

  // Para comparar: ventas netas y cobrado en pesos del mismo día de la semana pasada (mismo rango, 7 días antes).
  const SEMANA = 7 * 86400000;
  const rangoAnt = { $gte: new Date(desde.getTime() - SEMANA), $lte: new Date(hasta.getTime() - SEMANA) };
  const vAnt = await db.collection('ventas').find({ orgId, fecha: rangoAnt, estado: { $ne: 'anulada' }, importado: { $ne: true }, moneda: { $ne: 'USD' } }).project({ total: 1, tipoComprobante: 1 }).toArray();
  const cAnt = await db.collection('cuenta_corriente_movimientos').find({ orgId, tipo: 'credito', origen: { $in: ['cobro_venta', 'cobro_cuenta'] }, anulado: { $ne: true }, fecha: rangoAnt, moneda: { $ne: 'USD' } }).project({ monto: 1 }).toArray();
  out.anterior = { ventas: r2(vAnt.reduce((t, x) => t + (x.tipoComprobante === 'nota_credito' ? -1 : 1) * (x.total || 0), 0)), cobrado: r2(cAnt.reduce((t, x) => t + (x.monto || 0), 0)) };

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

// Dirección pública del sistema para los links del mail (PUBLIC_BASE_URL en Render; si no está, la de producción).
function baseDe(baseUrl) { return String(baseUrl || process.env.PUBLIC_BASE_URL || 'https://metroscuadrados.onrender.com').replace(/\/+$/, ''); }
// Link a una pantalla del sistema, ya en la sucursal y con los filtros del día (ver public/enlace-resumen.js).
function enlace(base, pantalla, orgId, params) {
  const q = new URLSearchParams(Object.assign({ org: String(orgId) }, params || {}));
  return `${base}/${pantalla}?${q.toString()}`;
}

// ---- Diseño del mail (tablas con estilos en línea: es lo único que respetan Gmail/Outlook/celular) ----
const COLOR = { naranja: '#c0562b', verde: '#15803d', rojo: '#b91c1c', ambar: '#b45309', gris: '#6b7280', fondo: '#faf5f2', borde: '#e0cfc6' };

// Tarjeta de un número grande: etiqueta arriba, valor, subtítulo y (opcional) línea de comparación.
function tarjeta({ icono, etiqueta, valor, sub, extra, color, href }) {
  const abre = href ? `<a href="${esc(href)}" style="text-decoration:none;color:inherit;display:block">` : '', cierra = href ? '</a>' : '';
  return `<td width="50%" valign="top" style="padding:5px">${abre}<div style="background:${COLOR.fondo};border:1px solid ${COLOR.borde};border-radius:10px;padding:12px 14px;border-top:4px solid ${color || COLOR.naranja}">
    <div style="font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:${COLOR.gris};font-weight:bold">${icono || ''} ${esc(etiqueta)}</div>
    <div style="font-size:26px;font-weight:bold;line-height:1.25;margin-top:3px;color:#1f2937">${valor}</div>
    ${sub ? `<div style="font-size:12px;color:#4b5563;margin-top:2px">${sub}</div>` : ''}
    ${extra ? `<div style="font-size:12px;margin-top:4px">${extra}</div>` : ''}
    ${href ? `<div style="font-size:11px;color:${COLOR.naranja};margin-top:6px;font-weight:bold">Ver detalle →</div>` : ''}
  </div>${cierra}</td>`;
}
function filaTarjetas(tarjetas) {
  const t = tarjetas.filter(Boolean);
  if (!t.length) return '';
  const filas = [];
  for (let i = 0; i < t.length; i += 2) filas.push(`<tr>${t[i]}${t[i + 1] || '<td width="50%" style="padding:5px"></td>'}</tr>`);
  return `<table width="100%" cellpadding="0" cellspacing="0">${filas.join('')}</table>`;
}
// Variación contra el mismo día de la semana pasada.
function comparacion(hoy, antes, dia) {
  const nombreDia = new Date(dia + 'T12:00:00-03:00').toLocaleDateString('es-AR', { timeZone: TZ, weekday: 'long' });
  if (!antes && !hoy) return '';
  if (!antes) return `<span style="color:${COLOR.verde}">▲ nuevo</span> <span style="color:${COLOR.gris}">(el ${nombreDia} pasado: $ 0)</span>`;
  const pct = Math.round(((hoy - antes) / Math.abs(antes)) * 100);
  const col = pct > 0 ? COLOR.verde : (pct < 0 ? COLOR.rojo : COLOR.gris);
  return `<span style="color:${col};font-weight:bold">${pct > 0 ? '▲' : (pct < 0 ? '▼' : '=')} ${Math.abs(pct)}%</span> <span style="color:${COLOR.gris}">vs. el ${nombreDia} pasado</span>`;
}
function chip(texto, color) { return `<span style="display:inline-block;background:#fff;border:1px solid ${COLOR.borde};border-radius:20px;padding:3px 10px;margin:2px 4px 2px 0;font-size:12px;color:${color || '#374151'}">${texto}</span>`; }

function htmlSucursal(s, dia, base) {
  const dh = { desde: dia, hasta: dia };
  const L = (pantalla, params) => enlace(base, pantalla, s.orgId, params);
  const v = s.ventas, c = s.cobranzas, ant = s.anterior || { ventas: 0, cobrado: 0 };
  const ventasARS = v.monto.ARS || 0, cobradoARS = c.monto.ARS || 0;
  const t = [];
  t.push(tarjeta({ icono: '🛒', etiqueta: 'Ventas', valor: esc(textoMon(v.monto)), sub: `<b>${v.cantidad}</b> comprobante${v.cantidad === 1 ? '' : 's'}${v.fiscales ? ` · ${v.fiscales} fiscal${v.fiscales === 1 ? '' : 'es'}` : ''}`, extra: comparacion(ventasARS, ant.ventas, dia), color: COLOR.naranja, href: L('admin-ventas.html', dh) }));
  t.push(tarjeta({ icono: '💰', etiqueta: 'Cobrado', valor: esc(textoMon(c.monto)), sub: `<b>${c.cantidad}</b> cobro${c.cantidad === 1 ? '' : 's'}`, extra: comparacion(cobradoARS, ant.cobrado, dia), color: COLOR.verde, href: L('admin-cobranza.html', dh) }));
  if (s.visitas) {
    const vi = s.visitas, sin = vi.porEstado.sin_visita || 0;
    const partes = [];
    if (vi.porEstado.vendido) partes.push(`${vi.porEstado.vendido} vendida${vi.porEstado.vendido === 1 ? '' : 's'}`);
    if (vi.porEstado.presupuestada) partes.push(`${vi.porEstado.presupuestada} presupuestada${vi.porEstado.presupuestada === 1 ? '' : 's'}`);
    if (vi.porEstado.instalado) partes.push(`${vi.porEstado.instalado} instalada${vi.porEstado.instalado === 1 ? '' : 's'}`);
    t.push(tarjeta({ icono: '📍', etiqueta: 'Visitas', valor: String(vi.total), sub: partes.join(' · ') || (vi.total ? '' : 'Sin visitas agendadas'),
      extra: sin ? `<span style="color:${COLOR.ambar};font-weight:bold">⚠ ${sin} sin cargar resultado</span>` : (vi.total ? `<span style="color:${COLOR.verde}">✓ todas cargadas</span>` : ''), color: '#2563eb', href: L('admin-visitas.html', Object.assign({}, dh, sin ? { estado: 'sin_visita' } : {})) }));
  }
  if (s.produccion) {
    const porUnidad = {};
    s.produccion.productos.forEach(x => { porUnidad[x.unidad || 'u.'] = r2((porUnidad[x.unidad || 'u.'] || 0) + x.cantidad); });
    const total = Object.entries(porUnidad).map(([u, n]) => `${num(n)} ${esc(u)}`).join(' + ') || '0';
    t.push(tarjeta({ icono: '🏭', etiqueta: 'Producción', valor: total, sub: s.produccion.lineas ? `${s.produccion.lineas} producto${s.produccion.lineas === 1 ? '' : 's'}` : 'No se cargó producción', color: '#7c3aed', href: L('admin-stock.html', Object.assign({ tab: 'movimientos', origen: 'produccion' }, dh)) }));
  }
  const pe = s.pendientes;
  t.push(tarjeta({ icono: '📦', etiqueta: 'Pendientes de entrega', valor: String(pe.cantidad), sub: pe.cantidad ? 'pedidos sin entregar' : 'Todo entregado',
    extra: pe.antiguos ? `<span style="color:${COLOR.ambar};font-weight:bold">⚠ ${pe.antiguos} con más de 7 días</span>` : '', color: pe.antiguos ? COLOR.ambar : COLOR.gris, href: L('admin-ventas.html', { estado: 'pendiente' }) }));
  if (s.gastos.cantidad) t.push(tarjeta({ icono: '🧾', etiqueta: 'Gastos', valor: esc(textoMon(s.gastos.monto)), sub: `<b>${s.gastos.cantidad}</b> cargado${s.gastos.cantidad === 1 ? '' : 's'}`, color: COLOR.rojo, href: L('admin-gastos.html', dh) }));

  // Detalles chicos, en "chips": medios de cobro, vendedores, notas de crédito, producción por producto.
  const chips = [];
  const FORMA_CLAVE = { 'Efectivo': 'efectivo', 'Transferencia': 'cuenta', 'Tarjeta': 'tarjeta', 'Cheque': 'cheque' };
  Object.entries(c.porForma).forEach(([f, m]) => { const hh = FORMA_CLAVE[f] ? L('admin-cobranza.html', Object.assign({ forma: FORMA_CLAVE[f] }, dh)) : null; const ch = chip(`${esc(f)}: <b>${esc(textoMon(m))}</b>`); chips.push(hh ? `<a href="${esc(hh)}" style="text-decoration:none;color:inherit">${ch}</a>` : ch); });
  const vends = Object.entries(v.porVendedor).sort((a, b) => b[1].cantidad - a[1].cantidad);
  if (vends.length > 1) vends.forEach(([n, x]) => chips.push(chip(`👤 ${esc(n)}: <b>${x.cantidad}</b> (${esc(textoMon(x.monto))})`)));
  if (v.notasCredito.cantidad) chips.push(chip(`↩ ${v.notasCredito.cantidad} nota${v.notasCredito.cantidad === 1 ? '' : 's'} de crédito: −${esc(textoMon(v.notasCredito.monto))}`, COLOR.rojo));
  if (v.mayor) chips.push(chip(`⭐ Mayor venta: ${esc(v.mayor.cliente)} — <b>${fmt(v.mayor.total)}</b>`));
  if (s.visitas && Object.keys(s.visitas.porVendedor).length > 1) Object.entries(s.visitas.porVendedor).forEach(([n, x]) => chips.push(chip(`📍 ${esc(n)}: ${x} visita${x === 1 ? '' : 's'}`)));
  if (s.visitas && s.visitas.canceladas) chips.push(chip(`${s.visitas.canceladas} visita${s.visitas.canceladas === 1 ? '' : 's'} cancelada${s.visitas.canceladas === 1 ? '' : 's'}`, COLOR.gris));
  if (s.produccion && s.produccion.lineas) s.produccion.productos.slice(0, 10).forEach(x => chips.push(chip(`🏭 ${esc(x.nombre)}: <b>${num(x.cantidad)} ${esc(x.unidad)}</b>`)));
  if (s.produccion && s.produccion.productos.length > 10) chips.push(chip(`…y ${s.produccion.productos.length - 10} más`, COLOR.gris));

  const sinActividad = !v.cantidad && !c.cantidad && !(s.visitas && s.visitas.total) && !(s.produccion && s.produccion.lineas);
  return `<div style="border:1px solid ${COLOR.borde};border-radius:12px;padding:14px 14px 10px;margin:0 0 18px;background:#fff">
    <div style="font-size:19px;font-weight:bold;color:#1f2937;margin:0 0 8px 5px">${esc(s.nombre)}${sinActividad ? ` <span style="font-size:12px;font-weight:normal;color:${COLOR.gris}">— sin movimientos</span>` : ''}</div>
    ${filaTarjetas(t)}
    ${chips.length ? `<div style="margin:8px 5px 2px">${chips.join('')}</div>` : ''}
  </div>`;
}

function htmlResumen(fechaISO, sucursales, titulo, baseUrl) {
  const base = baseDe(baseUrl);
  const total = {}, cob = {};
  sucursales.forEach(s => { Object.entries(s.ventas.monto).forEach(([m, n]) => sumaMon(total, m, n)); Object.entries(s.cobranzas.monto).forEach(([m, n]) => sumaMon(cob, m, n)); });
  const cant = sucursales.reduce((t, s) => t + s.ventas.cantidad, 0);
  const visitas = sucursales.reduce((t, s) => t + (s.visitas ? s.visitas.total : 0), 0);
  const alertas = [];
  sucursales.forEach(s => {
    if (s.visitas && s.visitas.porEstado.sin_visita) alertas.push(`<a href="${esc(enlace(base, 'admin-visitas.html', s.orgId, { desde: fechaISO, hasta: fechaISO, estado: 'sin_visita' }))}" style="color:${COLOR.ambar};text-decoration:underline"><b>${esc(s.nombre)}:</b> ${s.visitas.porEstado.sin_visita} visita${s.visitas.porEstado.sin_visita === 1 ? '' : 's'} sin cargar el resultado →</a>`);
    if (s.pendientes.antiguos) alertas.push(`<a href="${esc(enlace(base, 'admin-ventas.html', s.orgId, { estado: 'pendiente' }))}" style="color:${COLOR.ambar};text-decoration:underline"><b>${esc(s.nombre)}:</b> ${s.pendientes.antiguos} pedido${s.pendientes.antiguos === 1 ? '' : 's'} sin entregar hace más de 7 días →</a>`);
  });
  const mini = (etq, val, col) => `<td align="center" style="padding:6px 4px"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.85">${etq}</div><div style="font-size:20px;font-weight:bold;margin-top:2px;color:${col || '#fff'}">${val}</div></td>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#222">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:16px 8px"><tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
<tr><td style="background:${COLOR.naranja};color:#fff;padding:18px 22px 10px;border-radius:12px 12px 0 0">
  <div style="font-size:21px;font-weight:bold">${esc(titulo || 'Resumen del día')}</div>
  <div style="font-size:13px;opacity:.92;margin-top:2px">${esc(fechaLarga(fechaISO).replace(/^./, c => c.toUpperCase()))}</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;color:#fff"><tr>${mini('Vendido', esc(textoMon(total)))}${mini('Cobrado', esc(textoMon(cob)))}${mini('Ventas', String(cant))}${visitas ? mini('Visitas', String(visitas)) : ''}</tr></table>
  <div style="font-size:11px;opacity:.8;text-align:center;padding:2px 0 4px">Suma de las sucursales (incluye ventas internas entre ellas)</div>
</td></tr>
${alertas.length ? `<tr><td style="background:#fffbeb;border:1px solid #fcd34d;border-top:none;padding:10px 18px;font-size:13px;color:${COLOR.ambar}"><div style="font-weight:bold;margin-bottom:3px">⚠ Para revisar</div>${alertas.map(a => `<div>• ${a}</div>`).join('')}</td></tr>` : ''}
<tr><td style="padding:16px 0 0">${sucursales.map(x => htmlSucursal(x, fechaISO, base)).join('')}</td></tr>
<tr><td style="font-size:11px;color:#888;text-align:center;padding:2px 12px 16px">Resumen automático del sistema. Sin ventas históricas de Dux ni comprobantes anulados. Tocá cualquier tarjeta para ver el detalle en el sistema. Las comparaciones son contra el mismo día de la semana pasada, en pesos.</td></tr>
</table></td></tr></table></body></html>`;
}

async function getConfig(db) {
  const c = (await db.collection('resumen_diario_config').findOne({ _id: 'global' })) || {};
  return { activo: c.activo === true, hora: /^\d{1,2}:\d{2}$/.test(c.hora || '') ? c.hora : '16:00', destinatarios: c.destinatarios || '', diasSemana: Array.isArray(c.diasSemana) ? c.diasSemana : [1, 2, 3, 4, 5, 6], dia: c.dia === 'ayer' ? 'ayer' : 'hoy', ultimoEnvio: c.ultimoEnvio || null, ultimoError: c.ultimoError || null };
}

// Arma el resumen. fechaISO = día a resumir; hasta = límite superior (para "hoy" es el momento actual).
async function armar(db, fechaISO, hastaMomento, baseUrl) {
  const orgs = await db.collection('organizaciones').find({ activa: { $ne: false } }).sort({ nombre: 1 }).toArray();
  const { desde, hasta } = rangoDelDia(fechaISO, hastaMomento);
  const sucursales = [];
  for (const o of orgs) sucursales.push(await resumenDeOrg(db, o, desde, hasta));
  return { fechaISO, sucursales, html: htmlResumen(fechaISO, sucursales, null, baseUrl) };
}

async function destinatariosDe(db, cfg) {
  let para = correo.mailsValidos(cfg.destinatarios);
  if (!para.length) { const c = await db.collection('correo_config').findOne({ _id: 'global' }); para = correo.mailsValidos(c && c.email); }
  return para;
}

// Envía el resumen. forzar=true ignora el "ya se mandó hoy" (botón "Enviar ahora").
async function enviar(db, { forzar, fechaISO, para, baseUrl } = {}) {
  const cfg = await getConfig(db);
  const ahora = ahoraAR();
  const dia = fechaISO || (cfg.dia === 'ayer' ? sumarDias(ahora.fecha, -1) : ahora.fecha);
  const hasta = (!fechaISO && cfg.dia !== 'ayer') ? new Date() : undefined;
  const destino = para && para.length ? para : await destinatariosDe(db, cfg);
  if (!destino.length) throw err(400, 'Falta indicar a qué mail se envía el resumen.');
  const r = await armar(db, dia, hasta, baseUrl);
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
    const r = await conReintento(async () => { const db = await getDb(); const cfg = await getConfig(db); const a = ahoraAR(); const dia = f || (cfg.dia === 'ayer' ? sumarDias(a.fecha, -1) : a.fecha); return armar(db, dia, (!f && cfg.dia !== 'ayer') ? new Date() : undefined, correo.baseUrlDe(req)); });
    res.set('Content-Type', 'text/html; charset=utf-8'); res.send(r.html);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Enviar ahora (botón de prueba): manda el resumen ya, aunque no sea la hora. Body: { para?, fecha? }.
router.post('/enviar-ahora', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    const b = req.body || {};
    const out = await conReintento(async () => enviar(await getDb(), { forzar: true, fechaISO: /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? b.fecha : null, para: correo.mailsValidos(b.para), baseUrl: correo.baseUrlDe(req) }));
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.armar = armar; router.enviar = enviar; router.revisarYEnviar = revisarYEnviar; router.ahoraAR = ahoraAR; router.getConfig = getConfig;
module.exports = router;
