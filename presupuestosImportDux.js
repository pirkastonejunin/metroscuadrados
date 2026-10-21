// ---------------------------------------------------------------------------
// Importación del HISTORIAL de presupuestos de Dux (21/10/2026, pedido de Mato: "importemos todo completo").
//
// Entrada: el Excel "Consulta De Gestion Presupuesto" de Dux (.xls o .xlsx) con columnas Numero Presupuesto, Fecha Comp,
// Cliente, Total, Estado Presupuesto, Comprobante, Fecha Ultima Modificacion, Observaciones, Personal, Teléfono.
// Ese listado NO trae los artículos: cada presupuesto importado lleva un único renglón "Presupuesto histórico Dux (sin detalle)".
//
// Decisiones:
//   - SOLO HISTORIAL: no compromete stock, no toca cuenta corriente, no genera recordatorios de calendario ni seguimientos.
//   - Se conserva el número de Dux (numero + numeroOriginal) y se marca importado:true / origen:'dux'.
//   - Estados: PENDIENTE / SIN VISITA -> presupuestado; FACTURADO / VENDIDO / PEDIDO_REALIZADO -> aprobado; ANULADO -> rechazado.
//   - Los facturados se enlazan con su venta (si ya está importada) por el número de comprobante (FACTURA A-00006-… = FA-00006-…).
//   - Clientes: se reutiliza el que coincide por nombre (único); si no existe se crea con origenCliente 'Importado Dux'.
//   - Re-subir el mismo archivo no duplica (claveImport = dux:<número>); sí actualiza el estado y el total de los ya cargados.
// Rutas: POST /preview  y  POST /aplicar   body: { archivoBase64, orgId? }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');
const { crearResolverClientes } = require('./ventasImportDux');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereModulo('ventas')];

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
async function conReintento(fn) { try { return await fn(); } catch (e) { if (e.status) throw e; mongoClient = null; return await fn(); } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parsearFecha(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 15));
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d, 15)) : null; }
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 15));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 15)) : null;
}
function parsearFechaHora(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 3, +m[5], +m[6])) : null; // hora argentina (UTC-3) -> UTC
}
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[$\s]/g, '');
  if (!s) return 0;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}

const ESTADO_DUX = {
  'PENDIENTE': 'presupuestado', 'SIN VISITA': 'presupuestado',
  'FACTURADO': 'aprobado', 'VENDIDO': 'aprobado', 'PEDIDO_REALIZADO': 'aprobado',
  'ANULADO': 'rechazado'
};
function estadoDeDux(txt) { return ESTADO_DUX[String(txt || '').trim().toUpperCase().replace(/\s+/g, ' ')] || 'presupuestado'; }

// "FACTURA A-00006-00000040" -> "FA-00006-00000040"; "COMPROBANTE VENTA X-00006-00000166" -> "CX-00006-00000166"
function comprobanteAVenta(txt) {
  const m = String(txt || '').trim().toUpperCase().match(/^(FACTURA|COMPROBANTE VENTA|NOTA DE CREDITO|NOTA DE DEBITO)\s+([A-Z])-(\d{1,5})-(\d{1,8})$/);
  if (!m) return null;
  const pref = m[1] === 'FACTURA' ? 'F' + m[2] : m[1] === 'COMPROBANTE VENTA' ? 'C' + m[2] : null;
  return pref ? pref + '-' + m[3] + '-' + m[4] : null;
}

function leerArchivo(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'numero presupuesto') && f.some(c => norm(c) === 'estado presupuesto'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Numero Presupuesto y Estado Presupuesto. Tiene que ser "Consulta De Gestion Presupuesto" de Dux.');
  const enc = filas[hIdx].map(norm);
  const col = (n) => enc.indexOf(n);
  const c = { nro: col('numero presupuesto'), fecha: col('fecha comp'), cliente: col('cliente'), total: col('total'), estado: col('estado presupuesto'),
    comp: col('comprobante'), mod: col('fecha ultima modificacion'), obs: col('observaciones'), vendedor: col('personal'), tel: col('telefono') };
  if (c.cliente < 0 || c.total < 0 || c.fecha < 0) throw err(400, 'Faltan las columnas Fecha Comp, Cliente y/o Total.');
  const presupuestos = [], errores = [];
  const vistos = new Set();
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const nFila = i + 1;
    const nroTxt = String(f[c.nro] == null ? '' : f[c.nro]).trim();
    const nro = Number(nroTxt.replace(/\D/g, '')) || 0;
    const fecha = parsearFecha(f[c.fecha]);
    const cliente = String(f[c.cliente] == null ? '' : f[c.cliente]).trim();
    if (!nro && !cliente) continue;
    if (!nro) { errores.push({ fila: nFila, motivo: 'Sin número de presupuesto' }); continue; }
    if (!fecha) { errores.push({ fila: nFila, motivo: 'Fecha inválida: ' + f[c.fecha] }); continue; }
    if (!cliente) { errores.push({ fila: nFila, motivo: 'Sin cliente' }); continue; }
    if (vistos.has(nro)) { errores.push({ fila: nFila, motivo: 'Número repetido en el archivo: ' + nroTxt }); continue; }
    vistos.add(nro);
    presupuestos.push({
      fila: nFila, nro, nroTxt, fecha, cliente, total: round2(numero(f[c.total])),
      estadoDux: String(f[c.estado] || '').trim(), estado: estadoDeDux(f[c.estado]),
      comprobante: String(f[c.comp] || '').trim(), modificado: parsearFechaHora(f[c.mod]),
      observaciones: String(f[c.obs] || '').trim(), vendedor: String(f[c.vendedor] || '').trim(),
      telefono: String(f[c.tel] || '').trim().slice(0, 40)
    });
  }
  return { presupuestos, errores };
}

const claveImport = (p) => 'dux:' + String(p.nro).padStart(8, '0');

async function orgsAccesibles(db, req) {
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}

async function procesar(req, aplicar) {
  let orgDeBody = false;
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) { req.orgId = new ObjectId(String(v)); orgDeBody = true; } }
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { presupuestos, errores } = leerArchivo(req.body && req.body.archivoBase64);
  if (!presupuestos.length) throw err(400, 'El archivo no tiene presupuestos para importar.');
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId;
    const orgs = await orgsAccesibles(db, req);
    if (orgDeBody && !orgs.some(o => String(o._id) === String(orgId))) throw err(403, 'No tenés acceso a esa sucursal.');
    const ahora = new Date();

    const claves = presupuestos.map(claveImport);
    const existentes = new Map((await db.collection('presupuestos').find({ orgId, claveImport: { $in: claves } }).project({ claveImport: 1 }).toArray()).map(x => [x.claveImport, x]));
    const nuevos = presupuestos.filter(p => !existentes.has(claveImport(p)));

    // números de Dux que chocarían con presupuestos propios del sistema (solo informativo)
    const nrosNuevos = nuevos.map(p => p.nro);
    const choques = nrosNuevos.length ? await db.collection('presupuestos').countDocuments({ orgId, importado: { $ne: true }, numero: { $in: nrosNuevos } }) : 0;

    // enlace de los facturados con sus ventas ya importadas
    const compVenta = new Map(); // numeroOriginal de la venta -> presupuesto
    presupuestos.forEach(p => { const k = comprobanteAVenta(p.comprobante); if (k) compVenta.set(k, p); });
    const ventasPorComp = new Map();
    if (compVenta.size) {
      const vs = await db.collection('ventas').find({ orgId, numeroOriginal: { $in: [...compVenta.keys()] } }).project({ numeroOriginal: 1, numero: 1 }).toArray();
      vs.forEach(v => ventasPorComp.set(v.numeroOriginal, v));
    }

    const resolver = crearResolverClientes(db, ahora);
    for (const p of nuevos) await resolver.clasificar(orgId, p.cliente);
    const t = resolver.totales();
    const porEstado = {}; const montoPorEstado = {};
    presupuestos.forEach(p => { porEstado[p.estadoDux || '—'] = (porEstado[p.estadoDux || '—'] || 0) + 1; montoPorEstado[p.estadoDux || '—'] = round2((montoPorEstado[p.estadoDux || '—'] || 0) + p.total); });
    const resumen = {
      filasLeidas: presupuestos.length, aImportar: nuevos.length, yaImportados: presupuestos.length - nuevos.length,
      desde: presupuestos.reduce((a, p) => (!a || p.fecha < a ? p.fecha : a), null), hasta: presupuestos.reduce((a, p) => (!a || p.fecha > a ? p.fecha : a), null),
      totalImporte: round2(nuevos.reduce((s, p) => s + p.total, 0)),
      estados: porEstado, montoPorEstado,
      conVentaEnlazable: presupuestos.filter(p => ventasPorComp.has(comprobanteAVenta(p.comprobante))).length,
      conComprobante: presupuestos.filter(p => p.comprobante).length,
      clientesExistentes: t.existentes, clientesNuevos: t.nuevos, clientesAmbiguos: t.ambiguos,
      numerosQueChocanConPropios: choques,
      sucursalDestino: (orgs.find(o => String(o._id) === String(orgId)) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const clientesCreados = await resolver.crearNuevos();
    // teléfono de los clientes recién creados (el resolver los crea solo con el nombre)
    const telPorCliente = new Map();
    nuevos.forEach(p => { const id = resolver.id(orgId, p.cliente); if (id && p.telefono && !telPorCliente.has(String(id))) telPorCliente.set(String(id), p.telefono); });
    if (telPorCliente.size) {
      const ops = [...telPorCliente].map(([id, tel]) => ({ updateOne: { filter: { _id: new ObjectId(id), origenCliente: 'Importado Dux', $or: [{ telefono: { $exists: false } }, { telefono: '' }, { telefono: null }] }, update: { $set: { telefono: tel } } } }));
      for (let i = 0; i < ops.length; i += 500) await db.collection('clientes').bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }

    const docs = nuevos.map(p => {
      const venta = ventasPorComp.get(comprobanteAVenta(p.comprobante));
      return {
        numero: p.nro, numeroOriginal: 'DUX-' + String(p.nro).padStart(8, '0'),
        importado: true, origen: 'dux', claveImport: claveImport(p),
        clienteId: resolver.id(orgId, p.cliente), clienteNombre: p.cliente, vendedor: p.vendedor,
        fecha: p.fecha, moneda: 'ARS', cotizacionDolar: null,
        items: [{ productoId: null, sku: null, nombre: 'Presupuesto histórico Dux (sin detalle)', cantidad: 1, precioUnitario: p.total, subtotal: p.total }],
        descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: p.total, total: p.total,
        planesTarjetaIds: [], planesTarjeta: [], listaPrecioId: null, listaPrecioNombre: '',
        observaciones: p.observaciones, estado: p.estado, estadoDux: p.estadoDux, comprobanteDux: p.comprobante,
        seguimiento: [{ fecha: p.modificado || p.fecha, estado: p.estado, nota: 'Importado de Dux (' + (p.estadoDux || 'sin estado') + ')', usuarioNombre }],
        proximoContactoFecha: null, googleEventId: null, googleCalendarId: null,
        origenCotizador: null, origenVisita: null, origenBot: null,
        convertidoEnVentaId: venta ? venta._id : null, convertidoEnVentaNumero: venta ? (venta.numero || null) : null,
        telefonoDux: p.telefono,
        usuarioId: null, usuarioNombre, orgId, createdAt: p.fecha, updatedAt: p.modificado || ahora
      };
    });
    let insertados = 0;
    for (let i = 0; i < docs.length; i += 500) { const lote = docs.slice(i, i + 500); await db.collection('presupuestos').insertMany(lote, { ordered: false }); insertados += lote.length; }

    // Los que ya estaban: se alinean fecha, estado y total con Dux (sin tocar nada más). Re-subir el archivo repara cualquier fecha cambiada.
    const ops = [];
    presupuestos.forEach(p => {
      if (!existentes.has(claveImport(p))) return;
      ops.push({ updateOne: { filter: { orgId, claveImport: claveImport(p) }, update: { $set: { fecha: p.fecha, createdAt: p.fecha, estado: p.estado, estadoDux: p.estadoDux, comprobanteDux: p.comprobante, total: p.total, subtotal: p.total, 'items.0.precioUnitario': p.total, 'items.0.subtotal': p.total, updatedAt: p.modificado || ahora } } } });
    });
    let actualizados = 0;
    for (let i = 0; i < ops.length; i += 500) { const r = await db.collection('presupuestos').bulkWrite(ops.slice(i, i + 500), { ordered: false }); actualizados += r.modifiedCount; }

    // El contador de presupuestos propios sigue después del último número de Dux.
    const maxNro = presupuestos.reduce((m, p) => Math.max(m, p.nro), 0);
    await db.collection('presupuestos_contadores').updateOne({ orgId }, { $max: { ultimo: maxNro } }, { upsert: true });
    return Object.assign(resumen, { insertados, clientesCreados, actualizados });
  });
}

router.post('/preview', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
