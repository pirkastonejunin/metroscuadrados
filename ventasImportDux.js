// ---------------------------------------------------------------------------
// Importación del HISTORIAL de ventas de Dux (9/10/2026, pedido de Mato).
//
// Entrada: el Excel "consulta_ventas" de Dux (.xls o .xlsx) con columnas Fecha, Cliente, Total, Cobrado,
// Estado Remito, Comprobante (CX-00006-00000123 / FA-... / FB-...), Vendedor, Observaciones, ...
// Ese listado NO trae el detalle de artículos, así que cada venta importada lleva un único renglón
// "Venta histórica Dux (sin detalle)" por el total.
//
// Decisiones (confirmadas con Mato):
//   - SOLO HISTORIAL: no toca stock, no genera movimientos de cuenta corriente, no deja saldo pendiente
//     (los saldos de clientes se cargan aparte), no emite nada fiscal ni entra a los libros fiscales (esFiscal=false).
//   - Se conserva el número ORIGINAL de Dux (numeroOriginal) y se marca importado:true / origen:'dux'.
//   - Clientes: se reutiliza el que coincide por nombre (único); si no existe se crea con origenCliente 'Importado Dux'.
//   - Re-subir el mismo archivo no duplica: cada venta lleva una claveImport (número original, o
//     fecha+cliente+total en los pocos comprobantes que Dux exporta sin número completo).
// Rutas: POST /preview  y  POST /aplicar   body: { archivoBase64 }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

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

// Claves de comparación de un nombre: "LOPEZ, DAIANA" ~ "daiana lopez" ~ "lopez daiana".
function clavesNombre(nombre) {
  const n = norm(nombre);
  if (!n) return [];
  const claves = new Set([n, n.replace(/,/g, '').replace(/\s+/g, ' ').trim()]);
  if (n.includes(',')) {
    const [ap, ...resto] = n.split(',');
    claves.add((resto.join(' ') + ' ' + ap).replace(/\s+/g, ' ').trim());
  }
  return [...claves];
}

// El tablero y los informes cuentan las ventas por createdAt: en las importadas tiene que ser la fecha original.
async function alinearCreatedAt(db) {
  await db.collection('ventas').updateMany({ importado: true, $expr: { $ne: ['$createdAt', '$fecha'] } }, [{ $set: { createdAt: '$fecha' } }]);
}

function parsearFecha(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 15));
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d, 15)) : null; }
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 15)) : null;
}
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return 0;
  // 1.234,56 (es-AR) o 1234.56
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Lee el Excel y devuelve las filas ya normalizadas + errores de lectura.
function leerArchivo(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const hoja = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'fecha') && f.some(c => norm(c) === 'comprobante'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Fecha y Comprobante. Tiene que ser el listado "consulta_ventas" de Dux.');
  const enc = filas[hIdx].map(norm);
  const col = (n) => enc.indexOf(n);
  const c = { fecha: col('fecha'), cliente: col('cliente'), total: col('total'), cobrado: col('cobrado'), remito: col('estado remito'), comp: col('comprobante'), vendedor: col('vendedor'), obs: col('observaciones') };
  if (c.cliente < 0 || c.total < 0) throw err(400, 'Faltan las columnas Cliente y/o Total.');
  const ventas = [], errores = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const nFila = i + 1;
    const comp = String(f[c.comp] == null ? '' : f[c.comp]).trim();
    const fecha = parsearFecha(f[c.fecha]);
    const cliente = String(f[c.cliente] == null ? '' : f[c.cliente]).trim();
    if (!comp && !cliente) continue;
    if (!fecha) { errores.push({ fila: nFila, motivo: 'Fecha inválida: ' + f[c.fecha] }); continue; }
    if (!cliente) { errores.push({ fila: nFila, motivo: 'Sin cliente' }); continue; }
    const total = round2(numero(f[c.total]));
    const m = comp.match(/^([A-Z]{2})-(\d{1,5})-(\d{1,8})$/);
    const prefijo = m ? m[1] : (comp.match(/^([A-Z]{2})/) || [])[1] || 'CX';
    ventas.push({
      fila: nFila, fecha, cliente, total, cobrado: round2(numero(f[c.cobrado])),
      estadoRemitoDux: String(f[c.remito] || '').trim(),
      comprobante: comp, completo: !!m, prefijo, puntoVenta: m ? m[2] : '', nro: m ? Number(m[3]) : 0,
      vendedor: String(f[c.vendedor] || '').trim(), observaciones: String(f[c.obs] || '').trim()
    });
  }
  return { ventas, errores };
}

function claveImport(v) {
  if (v.completo) return 'dux:' + v.comprobante;
  return 'dux:s/n:' + v.prefijo + ':' + v.fecha.toISOString().slice(0, 10) + ':' + norm(v.cliente) + ':' + v.total.toFixed(2) + ':' + v.fila;
}


// --- Sucursales = organizaciones del sistema (cada una con sus propios clientes, ventas y stock) ---
const ESTADO_POR_REMITO = { 'CON REMITO': 'entregada', 'PENDIENTE': 'pendiente', 'REMITO PARCIAL': 'parcialmente_entregada' };
function estadoDeRemito(txt) { return ESTADO_POR_REMITO[String(txt || '').trim().toUpperCase()] || 'entregada'; }

async function orgsAccesibles(db, req) {
  const { ObjectId } = require('mongodb');
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return (await db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray());
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}
function sugerirOrg(nombreSucursal, orgs) {
  const n = norm(nombreSucursal); if (!n) return null;
  const ex = orgs.find(o => norm(o.nombre) === n) || orgs.find(o => norm(o.nombre).includes(n) || n.includes(norm(o.nombre)));
  return ex ? String(ex._id) : null;
}

// Resuelve clientes por organización (cada sucursal tiene los suyos). Reutiliza el que coincide por nombre (único);
// si no existe, lo crea marcado 'Importado Dux'.
function crearResolverClientes(db, ahora) {
  const { ObjectId } = require('mongodb');
  const porOrg = new Map();
  async function cargar(orgId) {
    const k = String(orgId);
    if (porOrg.has(k)) return porOrg.get(k);
    const clientes = await db.collection('clientes').find({ orgId, activo: { $ne: false } }).project({ apellidoRazonSocial: 1, nombre: 1, nombreFantasia: 1 }).toArray();
    const mapa = new Map();
    const agregar = (kk, id) => { if (!kk) return; if (!mapa.has(kk)) mapa.set(kk, new Set()); mapa.get(kk).add(String(id)); };
    clientes.forEach(cl => [cl.apellidoRazonSocial, cl.nombreFantasia, [cl.nombre, cl.apellidoRazonSocial].filter(Boolean).join(' '), [cl.apellidoRazonSocial, cl.nombre].filter(Boolean).join(' ')].forEach(n => clavesNombre(n).forEach(c => agregar(c, cl._id))));
    const o = { mapa, memo: new Map(), nuevos: new Set(), ambiguos: 0, existentes: 0 };
    porOrg.set(k, o); return o;
  }
  return {
    // Devuelve 'NUEVO' | null (ambiguo) | id. Solo clasifica; no crea.
    async clasificar(orgId, nombre) {
      const o = await cargar(orgId);
      if (o.memo.has(nombre)) return o.memo.get(nombre);
      const cand = new Set(); clavesNombre(nombre).forEach(c => (o.mapa.get(c) || new Set()).forEach(id => cand.add(id)));
      let r; if (cand.size === 1) { r = [...cand][0]; o.existentes++; } else if (cand.size > 1) { r = null; o.ambiguos++; } else { r = 'NUEVO'; o.nuevos.add(nombre); }
      o.memo.set(nombre, r); return r;
    },
    async crearNuevos() {
      let creados = 0;
      for (const [k, o] of porOrg) {
        if (!o.nuevos.size) continue;
        const nombres = [...o.nuevos];
        const docs = nombres.map(n => ({ apellidoRazonSocial: n, categoriaFiscal: 'consumidor_final', origenCliente: 'Importado Dux', activo: true, orgId: new ObjectId(k), createdAt: ahora, updatedAt: ahora }));
        const r = await db.collection('clientes').insertMany(docs, { ordered: false });
        nombres.forEach((n, i) => o.memo.set(n, String(r.insertedIds[i])));
        creados += docs.length;
      }
      return creados;
    },
    id(orgId, nombre) { const o = porOrg.get(String(orgId)); const v = o && o.memo.get(nombre); return v && v !== 'NUEVO' ? new ObjectId(v) : null; },
    totales() { let n = 0, e = 0, a = 0; porOrg.forEach(o => { n += o.nuevos.size; e += o.existentes; a += o.ambiguos; }); return { nuevos: n, existentes: e, ambiguos: a }; }
  };
}

async function procesar(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new (require('mongodb').ObjectId)(String(v)); }
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { ventas, errores } = leerArchivo(req.body && req.body.archivoBase64);
  if (!ventas.length) throw err(400, 'El archivo no tiene ventas para importar.');
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId; const { ObjectId } = require('mongodb');
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(orgId))) orgIds.push(orgId);
    const ahora = new Date();

    // Ya cargadas (en cualquier sucursal): solo se actualiza su estado de entrega y lo cobrado.
    const claves = ventas.map(claveImport);
    const existentes = new Map((await db.collection('ventas').find({ orgId: { $in: orgIds }, claveImport: { $in: claves } }).project({ claveImport: 1, orgId: 1 }).toArray()).map(x => [x.claveImport, x]));
    const nuevas = ventas.filter(v => !existentes.has(claveImport(v)));

    const resolver = crearResolverClientes(db, ahora);
    for (const v of nuevas) await resolver.clasificar(orgId, v.cliente);
    const t = resolver.totales();
    const porEstado = {}; ventas.forEach(v => { const e = estadoDeRemito(v.estadoRemitoDux); porEstado[e] = (porEstado[e] || 0) + 1; });
    const resumen = {
      filasLeidas: ventas.length, aImportar: nuevas.length, yaImportadas: ventas.length - nuevas.length,
      desde: ventas.reduce((a, v) => (!a || v.fecha < a ? v.fecha : a), null), hasta: ventas.reduce((a, v) => (!a || v.fecha > a ? v.fecha : a), null),
      totalImporte: round2(nuevas.reduce((s, v) => s + v.total, 0)),
      sinNumeroCompleto: nuevas.filter(v => !v.completo).length,
      clientesExistentes: t.existentes, clientesNuevos: t.nuevos, clientesAmbiguos: t.ambiguos,
      estados: porEstado, sucursalDestino: (orgs.find(o => String(o._id) === String(orgId)) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const clientesCreados = await resolver.crearNuevos();
    const docs = nuevas.map(v => {
      const esCX = v.prefijo === 'CX'; const estado = estadoDeRemito(v.estadoRemitoDux);
      return {
        numero: v.nro || 0, numeroOriginal: v.completo ? v.comprobante : (v.comprobante || v.prefijo) + ' (s/n)',
        importado: true, origen: 'dux', claveImport: claveImport(v),
        tipoComprobante: esCX ? 'comprobante_x' : 'fiscal', letra: esCX ? null : v.prefijo.slice(1), esFiscal: false,
        clienteId: resolver.id(orgId, v.cliente), clienteNombre: v.cliente, vendedor: v.vendedor,
        fecha: v.fecha, moneda: 'ARS', listaPrecioId: null, cotizacionDolar: null, tipoEntrega: null, depositoId: null, stockComprometido: false,
        estado, estadoRemitoDux: v.estadoRemitoDux,
        items: [{ productoId: null, sku: null, nombre: 'Venta histórica Dux (sin detalle)', cantidad: 1, precioUnitario: v.total, subtotal: v.total, cantidadEntregada: estado === 'entregada' ? 1 : 0 }],
        descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: v.total, total: v.total, fiscal: null, fiscalEstado: null, fiscalMensaje: null,
        pagos: [], totalCobrado: Math.min(v.cobrado, v.total), saldoPendiente: 0, duxCobrado: v.cobrado, duxSaldo: round2(Math.max(v.total - v.cobrado, 0)),
        observaciones: v.observaciones, stockDescontado: false, stockDescontadoEn: null, remitoId: null, remitoNumero: null, remitosIds: [],
        entregadaEn: estado === 'entregada' ? v.fecha : null, anuladaEn: null, anuladaPor: null, anuladaMotivo: null,
        usuarioNombre, orgId, createdAt: v.fecha, updatedAt: ahora
      };
    });
    let insertadas = 0;
    for (let i = 0; i < docs.length; i += 500) { const lote = docs.slice(i, i + 500); await db.collection('ventas').insertMany(lote, { ordered: false }); insertadas += lote.length; }

    // Las que ya estaban: se alinea el estado de entrega con Dux (sin tocar la sucursal ni los artículos).
    let actualizadas = 0;
    const ops = [];
    ventas.forEach(v => {
      const ex = existentes.get(claveImport(v)); if (!ex) return;
      const estado = estadoDeRemito(v.estadoRemitoDux);
      ops.push({ updateOne: { filter: { _id: ex._id }, update: [{ $set: {
        estado, estadoRemitoDux: v.estadoRemitoDux, entregadaEn: estado === 'entregada' ? v.fecha : null,
        totalCobrado: Math.min(v.cobrado, v.total), duxCobrado: v.cobrado, duxSaldo: round2(Math.max(v.total - v.cobrado, 0)), updatedAt: ahora,
        items: { $map: { input: '$items', as: 'it', in: { $mergeObjects: ['$$it', { cantidadEntregada: estado === 'entregada' ? '$$it.cantidad' : 0 }] } } }
      } }] } });
    });
    for (let i = 0; i < ops.length; i += 500) { const r = await db.collection('ventas').bulkWrite(ops.slice(i, i + 500), { ordered: false }); actualizadas += r.modifiedCount; }
    await alinearCreatedAt(db);
    return Object.assign(resumen, { insertadas, clientesCreados, actualizadas });
  });
}

router.post('/preview', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});


// ---------------------------------------------------------------------------
// DETALLE por artículo ("consulta_de_ventas_detallada"): una fila por renglón de cada comprobante.
// - Si el comprobante ya está importado desde el listado → se reemplaza su renglón "sin detalle" por los artículos reales.
// - Si no existe (ej. Notas de Crédito/Débito, que el listado no trae) → se crea la venta completa.
// - Los artículos se vinculan al catálogo por Código Producto = SKU / código externo; si no hay match, queda el
//   nombre/rubro/marca que vino de Dux (los informes por rubro usan ese dato).
// - Idempotente: volver a subir el mismo archivo deja lo mismo. Se pueden subir varios archivos (de a 60 días).
// ---------------------------------------------------------------------------
function leerDetalle(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo.'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'comprobante') && f.some(c => norm(c) === 'codigo producto'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Comprobante y Código Producto. Tiene que ser "consulta_de_ventas_detallada" de Dux.');
  const enc = filas[hIdx].map(norm);
  const c = (n) => enc.indexOf(n);
  const idx = {
    sucursal: c('sucursal'), cliente: c('cliente'), comp: c('comprobante'), fecha: c('fecha comp'), codigo: c('codigo producto'), producto: c('producto'),
    rubro: c('rubro'), marca: c('marca'), proveedor: c('proveedor'), obs: c('observaciones'), forma: c('forma pago'), vendedor: c('vendedor'),
    cantidad: c('cantidad'), precio: c('precio uni'), desc: c('% desc.'), sinIva: c('total sin iva'), pIva: c('porc. iva'), iva: c('iva'),
    conIva: c('total con iva'), total: c('total'), efvo: c('cobro efectivo'), tarj: c('cobro tarjeta'), chq: c('cobro cheque'), cta: c('cobro cuenta'),
    costoU: c('costo unitario producto'), costoT: c('costo total producto')
  };
  if (idx.cliente < 0 || idx.total < 0 || idx.cantidad < 0) throw err(400, 'Faltan columnas (Cliente, Cantidad o Total).');
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const num = (f, k) => idx[k] >= 0 ? numero(f[idx[k]]) : 0;
  const grupos = new Map(), errores = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    let comp = txt(f, 'comp');
    const cliente = txt(f, 'cliente');
    let fecha = parsearFecha(f[idx.fecha]);
    if (!fecha) { const m = String(f[idx.fecha] || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) fecha = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 15)); }
    // Dux exporta algunos comprobantes sin número: se agrupan por cliente + fecha y se enlazan con la venta "s/n" del listado.
    if (!comp && cliente && fecha) comp = 'SN|' + cliente + '|' + fecha.toISOString().slice(0, 10);
    if (!comp || !cliente || !fecha) { errores.push({ fila: i + 1, motivo: 'Falta comprobante, cliente o fecha' }); continue; }
    if (!grupos.has(comp)) grupos.set(comp, { comprobante: comp, fecha, cliente, sucursal: txt(f, 'sucursal'), vendedor: txt(f, 'vendedor'), formaPago: txt(f, 'forma'), observaciones: txt(f, 'obs'), items: [], cobros: { efectivo: 0, tarjeta: 0, cheque: 0, cuenta: 0 }, total: 0 });
    const g = grupos.get(comp);
    const nota = /^N[CD]/.test(comp); // en las notas de crédito Dux manda cantidades e importes en negativo
    const k = (v) => round2(nota ? Math.abs(v) : v);
    const cantidad = Math.abs(num(f, 'cantidad')) || 0;
    g.items.push({
      codigo: txt(f, 'codigo'), nombre: txt(f, 'producto'), rubro: txt(f, 'rubro'), marca: txt(f, 'marca'), proveedor: txt(f, 'proveedor'),
      cantidad, precioUnitario: round2(Math.abs(num(f, 'precio'))), descuentoPorcentaje: num(f, 'desc'),
      subtotal: k(num(f, 'sinIva')), porcentajeIva: num(f, 'pIva'), iva: k(num(f, 'iva')), totalConIva: k(num(f, 'conIva')),
      costoUnitario: round2(Math.abs(num(f, 'costoU'))), costoTotal: k(num(f, 'costoT'))
    });
    g.total = round2(g.total + k(num(f, 'total')));
    g.cobros.efectivo += num(f, 'efvo'); g.cobros.tarjeta += num(f, 'tarj'); g.cobros.cheque += num(f, 'chq'); g.cobros.cuenta += num(f, 'cta');
  }
  return { grupos: [...grupos.values()], errores };
}

function tipoDeComprobante(comp) {
  if (String(comp).startsWith('SN|')) return { pref: 'SN', base: 'fiscal', letra: null, nro: 0, completo: false };
  const m = String(comp).match(/^([A-Z]{2,3})-(\d+)-(\d+)$/);
  const pref = m ? m[1] : (String(comp).match(/^[A-Z]+/) || ['CX'])[0];
  const letra = pref.length === 3 ? pref[2] : pref[1];
  const base = pref.startsWith('NC') ? 'nota_credito' : pref.startsWith('ND') ? 'nota_debito' : pref === 'CX' ? 'comprobante_x' : 'fiscal';
  return { pref, base, letra: letra === 'X' ? null : letra, nro: m ? Number(m[3]) : 0, completo: !!m };
}


async function procesarDetalle(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new (require('mongodb').ObjectId)(String(v)); }
  const { grupos, errores } = leerDetalle(req.body && req.body.archivoBase64);
  if (!grupos.length) throw err(400, 'El archivo no tiene ventas.');
  return conReintento(async () => {
    const db = await getDb(); const { ObjectId } = require('mongodb');
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    // con "Todas" activo no hay sucursal de trabajo: cada venta va a la sucursal que se mapea abajo; la primera accesible es solo el valor por defecto
    const activa = req.orgId || (orgs[0] && orgs[0]._id); if (!activa) throw err(400, 'No tenés ninguna sucursal habilitada para importar.');
    if (!orgIds.some(x => String(x) === String(activa))) orgIds.push(activa);
    const ahora = new Date();

    // Sucursal de Dux → organización del sistema. Viene del front (mapaSucursales); lo que no se mapea cae en la activa.
    const mapaIn = (req.body && req.body.mapaSucursales) || {};
    const sucursales = [...new Set(grupos.map(g => g.sucursal))];
    const destinoDe = (suc) => {
      const elegido = mapaIn[suc];
      if (elegido && orgIds.some(x => String(x) === String(elegido))) return new ObjectId(String(elegido));
      return activa;
    };
    const nombreOrg = (id) => (orgs.find(o => String(o._id) === String(id)) || {}).nombre || String(id);

    // Catálogo por organización destino
    const codigos = [...new Set(grupos.flatMap(g => g.items.map(i => i.codigo)).filter(Boolean))];
    const catalogoPorOrg = new Map();
    for (const oid of new Set(sucursales.map(s => String(destinoDe(s))))) {
      const prods = codigos.length ? await db.collection('productos_catalogo').find({ orgId: new ObjectId(oid), $or: [{ sku: { $in: codigos } }, { codigoExterno: { $in: codigos } }] }).project({ sku: 1, codigoExterno: 1, nombre: 1 }).toArray() : [];
      const m = new Map(); prods.forEach(p => [p.sku, p.codigoExterno].filter(Boolean).forEach(cd => { if (!m.has(cd)) m.set(cd, p); }));
      catalogoPorOrg.set(oid, m);
    }
    const existentes = new Map((await db.collection('ventas').find({ orgId: { $in: orgIds }, claveImport: { $in: grupos.map(g => 'dux:' + g.comprobante) } }).project({ claveImport: 1, total: 1, orgId: 1 }).toArray()).map(v => [v.claveImport, v]));

    const resolver = crearResolverClientes(db, ahora);
    let aMover = 0;
    for (const g of grupos) {
      const dest = destinoDe(g.sucursal); const ex = existentes.get('dux:' + g.comprobante);
      if (ex && String(ex.orgId) !== String(dest)) aMover++;
      if (!ex || String(ex.orgId) !== String(dest)) await resolver.clasificar(dest, g.cliente);
    }
    let itemsVinculados = 0, itemsTotal = 0; const sinMatch = new Set();
    grupos.forEach(g => { const cat = catalogoPorOrg.get(String(destinoDe(g.sucursal))); g.items.forEach(i => { itemsTotal++; if (cat.has(i.codigo)) itemsVinculados++; else sinMatch.add(i.codigo); }); });
    const diferencias = grupos.filter(g => { const e = existentes.get('dux:' + g.comprobante); return e && Math.abs(e.total - Math.abs(g.total)) > 1; });
    const nuevasVentas = grupos.filter(g => !existentes.has('dux:' + g.comprobante));
    const porSucursal = sucursales.map(s => ({ sucursal: s, comprobantes: grupos.filter(g => g.sucursal === s).length, sugerida: sugerirOrg(s, orgs), destino: String(destinoDe(s)), destinoNombre: nombreOrg(destinoDe(s)) }));
    const t = resolver.totales();
    const resumen = {
      comprobantes: grupos.length, renglones: itemsTotal, conVentaExistente: grupos.length - nuevasVentas.length, aCrear: nuevasVentas.length, aMover,
      notas: grupos.filter(g => /^N[CD]/.test(g.comprobante)).length,
      desde: grupos.reduce((a, g) => (!a || g.fecha < a ? g.fecha : a), null), hasta: grupos.reduce((a, g) => (!a || g.fecha > a ? g.fecha : a), null),
      articulosVinculados: itemsVinculados, articulosSinCatalogo: sinMatch.size, ejemplosSinCatalogo: [...sinMatch].slice(0, 8),
      clientesNuevos: t.nuevos, diferencias: diferencias.length, ejemplosDiferencias: diferencias.slice(0, 5).map(g => ({ comprobante: g.comprobante })),
      sucursales: porSucursal, organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })), errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const clientesCreados = await resolver.crearNuevos();
    let actualizadas = 0, creadas = 0, convertidasSN = 0, movidas = 0;
    for (const g of grupos) {
      const dest = destinoDe(g.sucursal); const cat = catalogoPorOrg.get(String(dest));
      const clave = 'dux:' + g.comprobante;
      const items = g.items.map(i => {
        const p = cat.get(i.codigo);
        return { productoId: p ? p._id : null, sku: i.codigo || null, nombre: p ? p.nombre : i.nombre, nombreDux: i.nombre, rubro: i.rubro || null, marca: i.marca || null, proveedor: i.proveedor || null,
          cantidad: i.cantidad, precioUnitario: i.precioUnitario, descuentoPorcentaje: i.descuentoPorcentaje, subtotal: i.subtotal,
          porcentajeIva: i.porcentajeIva, iva: i.iva, totalConIva: i.totalConIva, costoUnitario: i.costoUnitario, costoTotal: i.costoTotal };
      });
      const base = { sucursalDux: g.sucursal, formaPagoDux: g.formaPago, duxCobros: { efectivo: round2(g.cobros.efectivo), tarjeta: round2(g.cobros.tarjeta), cheque: round2(g.cobros.cheque), cuenta: round2(g.cobros.cuenta) }, detalleDux: true, updatedAt: ahora };
      // cantidadEntregada de cada renglón según el estado de la venta (si ya se conoce el del listado)
      const aplicarEntrega = (estado) => items.map(it => Object.assign({}, it, { cantidadEntregada: estado === 'entregada' ? it.cantidad : 0 }));
      const ex = existentes.get(clave);
      if (ex) {
        const actual = await db.collection('ventas').findOne({ _id: ex._id }, { projection: { estado: 1 } });
        const set = Object.assign({}, base, { items: aplicarEntrega((actual && actual.estado) || 'entregada') });
        if (String(ex.orgId) !== String(dest)) {
          set.orgId = dest; set.clienteId = resolver.id(dest, g.cliente); set.clienteNombre = g.cliente; movidas++;
        }
        await db.collection('ventas').updateOne({ _id: ex._id }, { $set: set });
        actualizadas++; continue;
      }
      const t2 = tipoDeComprobante(g.comprobante); const total = Math.abs(g.total);
      const dia0 = new Date(g.fecha.getTime() - 12 * 3600e3), dia1 = new Date(g.fecha.getTime() + 12 * 3600e3);
      const sn = await db.collection('ventas').findOne({ orgId: { $in: orgIds }, importado: true, numeroOriginal: /\(s\/n\)$/, clienteNombre: g.cliente, fecha: { $gte: dia0, $lte: dia1 }, total: { $gte: total - 1, $lte: total + 1 } });
      if (sn) {
        const set = Object.assign({}, base, { items: aplicarEntrega(sn.estado || 'entregada'), numeroOriginal: g.comprobante, claveImport: clave, numero: t2.nro });
        if (String(sn.orgId) !== String(dest)) { set.orgId = dest; set.clienteId = resolver.id(dest, g.cliente); }
        await db.collection('ventas').updateOne({ _id: sn._id }, { $set: set });
        convertidasSN++; continue;
      }
      await db.collection('ventas').insertOne(Object.assign({
        numero: t2.nro, numeroOriginal: t2.completo ? g.comprobante : 'S/N (s/n)', importado: true, origen: 'dux', claveImport: clave,
        tipoComprobante: t2.base, letra: t2.letra, esFiscal: false,
        clienteId: resolver.id(dest, g.cliente), clienteNombre: g.cliente, vendedor: g.vendedor, fecha: g.fecha, moneda: 'ARS',
        listaPrecioId: null, cotizacionDolar: null, tipoEntrega: null, depositoId: null, stockComprometido: false,
        estado: 'entregada', estadoRemitoDux: '', descuentoPorcentaje: 0, descuentoMonto: 0,
        subtotal: round2(items.reduce((a, i) => a + i.subtotal, 0)), total, fiscal: null, fiscalEstado: null, fiscalMensaje: null,
        pagos: [], totalCobrado: total, saldoPendiente: 0, duxCobrado: total, duxSaldo: 0, observaciones: g.observaciones,
        stockDescontado: false, stockDescontadoEn: null, remitoId: null, remitoNumero: null, remitosIds: [], entregadaEn: g.fecha,
        anuladaEn: null, anuladaPor: null, anuladaMotivo: null, usuarioNombre, orgId: dest, createdAt: g.fecha
      }, base, { items: aplicarEntrega('entregada') }));
      creadas++;
    }
    await alinearCreatedAt(db);
    return Object.assign(resumen, { actualizadas, creadas, convertidasSN, movidas, clientesCreados });
  });
}
router.post('/detalle/preview', authAdmin, async (req, res) => {
  try { res.json(await procesarDetalle(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/detalle/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesarDetalle(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// REMITOS (Dux: "Remitos Por Producto"). Una línea por artículo de cada remito (Comprobante = número del REMITO, serie X,
// no el de la venta) con cliente, fecha, cantidad y lo que quedó PENDIENTE de entregar.
// Se cargan como historial en la colección `remitos` (pantalla Remitos): sin mover stock. Cada remito se vincula a su venta
// por cliente + artículos (la última venta del cliente, anterior o del mismo día, que tenga esos códigos; si la venta no
// tiene detalle, por cliente y fecha cercana). Al vincular, se acumula lo entregado en cada renglón de la venta y se
// recalcula su estado de entrega (entregada / pendiente / parcialmente entregada).
// Cada sucursal de Dux se asigna a una sucursal del sistema (mapaSucursales). Repetible sin duplicar.
// Rutas: POST /remitos/preview y /remitos/aplicar   body: { archivoBase64, mapaSucursales }
// ---------------------------------------------------------------------------
function leerRemitosPorProducto(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'ctd pendiente entrega') && f.some(c => norm(c) === 'comprobante'));
  if (h < 0) throw err(400, 'No encontré las columnas Comprobante y Ctd Pendiente Entrega. Tiene que ser "Remitos Por Producto" de Dux.');
  const enc = filas[h].map(norm); const c = (n) => enc.indexOf(n);
  const idx = { suc: c('sucursal empresa'), cli: c('cliente'), comp: c('comprobante'), cod: c('codigo producto'), prod: c('producto'), cant: c('cantidad'), pend: c('ctd pendiente entrega'), fecha: c('fecha'), pers: c('personal registra') };
  if (idx.cant < 0 || idx.cli < 0) throw err(400, 'Faltan columnas (Cliente o Cantidad).');
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const remitos = new Map(), errores = []; let lineas = 0;
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const comp = txt(f, 'comp'), cliente = txt(f, 'cli'), fecha = parsearFecha(f[idx.fecha]), suc = txt(f, 'suc');
    if (!comp || !cliente || !fecha) { errores.push({ fila: i + 1, motivo: 'Falta comprobante, cliente o fecha' }); continue; }
    const key = suc + '|' + comp;
    if (!remitos.has(key)) remitos.set(key, { clave: 'duxrem:' + suc + ':' + comp, sucursal: suc, comprobante: comp, cliente, fecha, personal: txt(f, 'pers'), items: [] });
    remitos.get(key).items.push({ sku: txt(f, 'cod'), nombre: txt(f, 'prod'), cantidad: Math.abs(numero(f[idx.cant])), pendiente: Math.abs(numero(f[idx.pend])) });
    lineas++;
  }
  return { remitos: [...remitos.values()], lineas, errores };
}
async function procesarRemitosDux(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new (require('mongodb').ObjectId)(String(v)); }
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { remitos, lineas, errores } = leerRemitosPorProducto(req.body && req.body.archivoBase64);
  if (!remitos.length) throw err(400, 'El archivo no tiene remitos.');
  return conReintento(async () => {
    const { ObjectId } = require('mongodb');
    const db = await getDb(); const activa = req.orgId; const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(activa))) orgIds.push(activa);
    const mapaIn = (req.body && req.body.mapaSucursales) || {};
    const sucursales = [...new Set(remitos.map(r => r.sucursal))];
    const destinoDe = (sn) => { const e = mapaIn[sn]; return (e && orgIds.some(x => String(x) === String(e))) ? new ObjectId(String(e)) : activa; };
    const nombreOrg = (id) => (orgs.find(o => String(o._id) === String(id)) || {}).nombre || String(id);

    const ya = new Set((await db.collection('remitos').find({ claveImport: { $in: remitos.map(r => r.clave) } }).project({ claveImport: 1 }).toArray()).map(x => x.claveImport));
    const nuevos = remitos.filter(r => !ya.has(r.clave));

    const resolver = crearResolverClientes(db, ahora);
    for (const r of nuevos) await resolver.clasificar(destinoDe(r.sucursal), r.cliente);
    const t = resolver.totales();

    // ventas candidatas de los clientes que ya existen
    const idsCli = new Set(); nuevos.forEach(r => { const id = resolver.id(destinoDe(r.sucursal), r.cliente); if (id) idsCli.add(String(id)); });
    const ventas = idsCli.size ? await db.collection('ventas').find({ orgId: { $in: orgIds }, importado: true, clienteId: { $in: [...idsCli].map(x => new ObjectId(x)) }, estado: { $ne: 'anulada' } }).project({ clienteId: 1, items: 1, fecha: 1, estado: 1, orgId: 1 }).toArray() : [];
    const porCliente = new Map(); ventas.forEach(v => { const k = String(v.clienteId); if (!porCliente.has(k)) porCliente.set(k, []); porCliente.get(k).push(v); });
    const DIA = 864e5;
    const buscarVenta = (r, dest) => {
      const cid = resolver.id(dest, r.cliente); if (!cid) return null;
      const cand = (porCliente.get(String(cid)) || []).filter(v => String(v.orgId) === String(dest) || true).filter(v => v.fecha.getTime() <= r.fecha.getTime() + DIA * 0.6);
      const conDetalle = cand.filter(v => (v.items || []).some(i => i.sku));
      const skus = r.items.map(i => i.sku).filter(Boolean);
      const cubre = conDetalle.filter(v => skus.length && skus.every(sk => v.items.some(i => i.sku === sk)));
      if (cubre.length) return { venta: cubre.sort((a, b) => b.fecha - a.fecha)[0], porItems: true };
      const cerca = cand.filter(v => !(v.items || []).some(i => i.sku) && Math.abs(v.fecha.getTime() - r.fecha.getTime()) <= DIA * 3);
      if (cerca.length === 1) return { venta: cerca[0], porItems: false };
      return null;
    };
    let vinculados = 0, sinVinculo = 0; const entregaPorVenta = new Map(); let pendientes = 0;
    for (const r of nuevos) {
      const dest = destinoDe(r.sucursal); const m = buscarVenta(r, dest);
      if (r.items.some(i => i.pendiente > 0)) pendientes++;
      if (!m) { sinVinculo++; continue; }
      r.venta = m.venta; vinculados++;
      if (m.porItems) {
        let e = entregaPorVenta.get(String(m.venta._id)); if (!e) { e = { venta: m.venta, porSku: new Map() }; entregaPorVenta.set(String(m.venta._id), e); }
        r.items.forEach(i => e.porSku.set(i.sku, (e.porSku.get(i.sku) || 0) + Math.max(0, i.cantidad - i.pendiente)));
      }
    }
    const resumen = {
      lineas, remitosEnArchivo: remitos.length, aImportar: nuevos.length, yaImportados: remitos.length - nuevos.length,
      desde: remitos.reduce((a, r) => (!a || r.fecha < a ? r.fecha : a), null), hasta: remitos.reduce((a, r) => (!a || r.fecha > a ? r.fecha : a), null),
      vinculadosAVenta: vinculados, sinVenta: sinVinculo, conPendiente: pendientes, ventasConEntregaActualizada: entregaPorVenta.size,
      clientesExistentes: t.existentes, clientesNuevos: t.nuevos, clientesAmbiguos: t.ambiguos,
      sucursales: sucursales.map(sn => ({ sucursal: sn, remitos: remitos.filter(r => r.sucursal === sn).length, sugerida: sugerirOrg(sn, orgs), destino: String(destinoDe(sn)), destinoNombre: nombreOrg(destinoDe(sn)) })),
      organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })), errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const clientesCreados = await resolver.crearNuevos();
    // los clientes recién creados no tenían ventas: no hay vínculo posible, solo se cargan los remitos
    const docs = nuevos.map(r => {
      const dest = destinoDe(r.sucursal); const mm = r.comprobante.match(/-(\d{1,8})$/);
      return {
        numero: mm ? Number(mm[1]) : 0, numeroOriginal: r.comprobante, importado: true, origen: 'dux', claveImport: r.clave,
        ventaId: r.venta ? r.venta._id : null, ventaNumero: r.venta ? (r.venta.numero || null) : null, tipoComprobante: 'comprobante_x',
        clienteId: resolver.id(dest, r.cliente), clienteNombre: r.cliente, depositoId: null, depositoNombre: '',
        items: r.items.map(i => ({ productoId: null, sku: i.sku || null, nombre: i.nombre, cantidad: i.cantidad, cantidadPendiente: i.pendiente })),
        fecha: r.fecha, usuarioNombre: r.personal || usuarioNombre, orgId: dest, createdAt: r.fecha, sucursalDux: r.sucursal
      };
    });
    let insertados = 0;
    for (let i = 0; i < docs.length; i += 500) { const x = await db.collection('remitos').insertMany(docs.slice(i, i + 500), { ordered: false }); insertados += x.insertedCount; }
    // lo entregado en cada renglón de la venta y su estado
    let ventasActualizadas = 0;
    for (const e of entregaPorVenta.values()) {
      const actual = await db.collection('ventas').findOne({ _id: e.venta._id }, { projection: { items: 1, estado: 1 } }); if (!actual) continue;
      const usados = new Map();
      const items = (actual.items || []).map(it => {
        if (!it.sku || !e.porSku.has(it.sku)) return it;
        const disp = e.porSku.get(it.sku) - (usados.get(it.sku) || 0);
        const ent = Math.max(0, Math.min(it.cantidad, disp)); usados.set(it.sku, (usados.get(it.sku) || 0) + ent);
        return Object.assign({}, it, { cantidadEntregada: round2(ent) });
      });
      const entregado = items.reduce((a, i) => a + (i.cantidadEntregada || 0), 0), total = items.reduce((a, i) => a + (i.cantidad || 0), 0);
      const estado = entregado <= 0 ? 'pendiente' : (entregado >= total - 1e-6 ? 'entregada' : 'parcialmente_entregada');
      await db.collection('ventas').updateOne({ _id: e.venta._id }, { $set: { items, estado, entregaDux: true, updatedAt: ahora } }); ventasActualizadas++;
    }
    return Object.assign(resumen, { insertados, clientesCreados, ventasActualizadas });
  });
}
router.post('/remitos/preview', authAdmin, async (req, res) => {
  try { res.json(await procesarRemitosDux(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/remitos/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesarRemitosDux(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// NOTAS DE CRÉDITO Y DÉBITO (Dux: "Listado de Nota Crédito Débito de Venta"). Una línea por nota, con total, lo aplicado y el
// comprobante relacionado (la venta que corrigen). Se guardan en `ventas` (tipoComprobante nota_credito / nota_debito) como
// historial: sin stock ni caja ni cuenta corriente. Si el detalle por artículo ya las cargó (NCX-/NDX-/NCA-…), solo se
// completan (aplicado, venta relacionada, observaciones); las que faltan se crean sin artículos en la sucursal elegida
// (el detalle por artículo después las completa y las pasa a su sucursal). Repetible sin duplicar.
// Rutas: POST /notas/preview y /notas/aplicar   body: { archivoBase64, orgId }
// ---------------------------------------------------------------------------
function leerNotas(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'tipo de comprobante') && f.some(c => norm(c) === 'comprobante'));
  if (h < 0) throw err(400, 'No encontré las columnas Tipo de Comprobante y Comprobante. Tiene que ser "Listado de Nota Crédito Débito de Venta" de Dux.');
  const enc = filas[h].map(norm); const c = (n) => enc.indexOf(n);
  const idx = { tipo: c('tipo de comprobante'), comp: c('comprobante'), fecha: c('fecha'), cli: c('cliente'), total: c('total'), pesos: c('total pesos'), aplic: c('aplicado / cobrado'), vend: c('vendedor'), rel: c('comprobantes relacionados'), obs: c('observaciones'), anula: c('fecha anula') };
  if (idx.cli < 0 || idx.tipo < 0) throw err(400, 'Faltan columnas (Tipo de Comprobante o Cliente).');
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const notas = [], errores = [];
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const esNC = /CREDITO/i.test(txt(f, 'tipo')); const fecha = parsearFecha(f[idx.fecha]); const cliente = txt(f, 'cli');
    if (!fecha || !cliente) { errores.push({ fila: i + 1, motivo: 'Falta fecha o cliente' }); continue; }
    const comp = txt(f, 'comp'); const m = comp.match(/^([A-Z])-(\d{1,5})-(\d{1,8})$/);
    const pref = (esNC ? 'NC' : 'ND') + (m ? m[1] : (comp.match(/^([A-Z])/) || ['X'])[1]);
    const total = round2(Math.abs(numero(f[idx.pesos >= 0 ? idx.pesos : idx.total]) || numero(f[idx.total])));
    const rm = txt(f, 'rel').match(/^([A-Z])-(\d{1,5})-(\d{1,8})$/);
    notas.push({ fila: i + 1, esNC, pref, comprobante: m ? pref + '-' + m[2] + '-' + m[3] : (comp || pref) + ' (s/n)', completo: !!m, nro: m ? Number(m[3]) : 0, letra: m && m[1] !== 'X' ? m[1] : null,
      fecha, cliente, total, aplicado: round2(Math.abs(numero(f[idx.aplic]))), vendedor: txt(f, 'vend'), observaciones: txt(f, 'obs'),
      relacionada: rm ? (rm[1] === 'X' ? 'CX' : 'F' + rm[1]) + '-' + rm[2] + '-' + rm[3] : '', relacionadaOriginal: txt(f, 'rel'), anulada: !!txt(f, 'anula') });
  }
  return { notas, errores };
}
const claveNota = (n) => n.completo ? 'dux:' + n.comprobante : 'dux:nota-sn:' + n.pref + ':' + n.fecha.toISOString().slice(0, 10) + ':' + norm(n.cliente) + ':' + n.total.toFixed(2) + ':' + n.fila;
async function procesarNotas(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new (require('mongodb').ObjectId)(String(v)); }
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { notas, errores } = leerNotas(req.body && req.body.archivoBase64);
  if (!notas.length) throw err(400, 'El archivo no tiene notas.');
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId; const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(orgId))) orgIds.push(orgId);
    const claves = notas.map(claveNota);
    const existentes = new Map((await db.collection('ventas').find({ orgId: { $in: orgIds }, claveImport: { $in: claves } }).project({ claveImport: 1 }).toArray()).map(x => [x.claveImport, x]));
    const nuevas = notas.filter(n => !existentes.has(claveNota(n)));
    const rels = [...new Set(notas.map(n => n.relacionada).filter(Boolean).map(r => 'dux:' + r))];
    const ventasRel = new Map((rels.length ? await db.collection('ventas').find({ orgId: { $in: orgIds }, claveImport: { $in: rels } }).project({ claveImport: 1 }).toArray() : []).map(x => [x.claveImport, x._id]));
    const resolver = crearResolverClientes(db, ahora);
    for (const n of nuevas) await resolver.clasificar(orgId, n.cliente);
    const t = resolver.totales();
    const suma = (arr) => round2(arr.reduce((a, n) => a + n.total, 0)); const porAnio = {};
    notas.forEach(n => { const y = n.fecha.getUTCFullYear(); porAnio[y] = porAnio[y] || { nc: 0, nd: 0 }; porAnio[y][n.esNC ? 'nc' : 'nd']++; });
    const resumen = {
      filas: notas.length, creditos: notas.filter(n => n.esNC).length, debitos: notas.filter(n => !n.esNC).length,
      totalCreditos: suma(notas.filter(n => n.esNC)), totalDebitos: suma(notas.filter(n => !n.esNC)), porAnio,
      desde: notas.reduce((a, n) => (!a || n.fecha < a ? n.fecha : a), null), hasta: notas.reduce((a, n) => (!a || n.fecha > a ? n.fecha : a), null),
      aImportar: nuevas.length, yaCargadas: notas.length - nuevas.length, conVentaRelacionada: notas.filter(n => n.relacionada && ventasRel.has('dux:' + n.relacionada)).length, sinVentaRelacionada: notas.filter(n => !n.relacionada).length,
      sinNumeroCompleto: notas.filter(n => !n.completo).length, anuladas: notas.filter(n => n.anulada).length,
      clientesExistentes: t.existentes, clientesNuevos: t.nuevos, clientesAmbiguos: t.ambiguos,
      sucursalDestino: (orgs.find(o => String(o._id) === String(orgId)) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;
    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const clientesCreados = await resolver.crearNuevos();
    const docs = nuevas.map(n => ({
      numero: n.nro, numeroOriginal: n.completo ? n.comprobante : n.comprobante, importado: true, origen: 'dux', claveImport: claveNota(n),
      tipoComprobante: n.esNC ? 'nota_credito' : 'nota_debito', letra: n.letra, esFiscal: false,
      clienteId: resolver.id(orgId, n.cliente), clienteNombre: n.cliente, vendedor: n.vendedor, fecha: n.fecha, moneda: 'ARS',
      listaPrecioId: null, cotizacionDolar: null, tipoEntrega: null, depositoId: null, stockComprometido: false, estado: n.anulada ? 'anulada' : 'entregada', estadoRemitoDux: '',
      items: [{ productoId: null, sku: null, nombre: (n.esNC ? 'Nota de crédito' : 'Nota de débito') + ' histórica Dux (sin detalle)', cantidad: 1, precioUnitario: n.total, subtotal: n.total, cantidadEntregada: 1 }],
      descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: n.total, total: n.total, fiscal: null, fiscalEstado: null, fiscalMensaje: null,
      pagos: [], totalCobrado: n.total, saldoPendiente: 0, duxCobrado: n.aplicado, duxSaldo: 0, observaciones: n.observaciones,
      ventaRelacionadaId: n.relacionada ? (ventasRel.get('dux:' + n.relacionada) || null) : null, comprobanteRelacionado: n.relacionadaOriginal || '',
      stockDescontado: false, stockDescontadoEn: null, remitoId: null, remitoNumero: null, remitosIds: [], entregadaEn: n.fecha,
      anuladaEn: n.anulada ? n.fecha : null, anuladaPor: null, anuladaMotivo: null, usuarioNombre, orgId, createdAt: n.fecha, updatedAt: ahora
    }));
    let insertadas = 0;
    for (let i = 0; i < docs.length; i += 500) { await db.collection('ventas').insertMany(docs.slice(i, i + 500), { ordered: false }); insertadas += Math.min(500, docs.length - i); }
    const ops = [];
    notas.forEach(n => { const ex = existentes.get(claveNota(n)); if (!ex) return;
      ops.push({ updateOne: { filter: { _id: ex._id }, update: { $set: { duxCobrado: n.aplicado, ventaRelacionadaId: n.relacionada ? (ventasRel.get('dux:' + n.relacionada) || null) : null, comprobanteRelacionado: n.relacionadaOriginal || '', updatedAt: ahora } } } }); });
    let actualizadas = 0;
    for (let i = 0; i < ops.length; i += 500) { const r = await db.collection('ventas').bulkWrite(ops.slice(i, i + 500), { ordered: false }); actualizadas += r.modifiedCount; }
    return Object.assign(resumen, { insertadas, actualizadas, clientesCreados });
  });
}
router.post('/notas/preview', authAdmin, async (req, res) => {
  try { res.json(await procesarNotas(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/notas/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesarNotas(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Al arrancar corrige las ventas ya importadas (fecha de creación = fecha original).
setTimeout(() => { getDb().then(alinearCreatedAt).catch(() => {}); }, 20000).unref();

module.exports = router;
module.exports.alinearCreatedAt = alinearCreatedAt;
module.exports.crearResolverClientes = crearResolverClientes;
