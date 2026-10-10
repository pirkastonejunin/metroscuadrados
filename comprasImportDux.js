// ---------------------------------------------------------------------------
// Importación del HISTORIAL de compras de Dux (9/10/2026, pedido de Mato).
//
// Entrada: el Excel "Consulta De Gestion Compra" de Dux (.xls / .xlsx) con columnas Fecha, Comprobante,
// Proveedor, Estado Recepcion, Total, Monto Pagado, Saldo, Personal, Fecha Vencimiento, Observaciones,
// Personal Anula, Fecha Anula. No trae sucursal ni artículos: cada compra importada lleva un único renglón
// "Compra histórica Dux (sin detalle)" por el total y se carga en la sucursal activa.
//
// Decisiones:
//   - SOLO HISTORIAL: no toca stock, no mueve cajas/bancos, no entra a los libros de IVA (esFiscal=false).
//   - Se conserva el número ORIGINAL de Dux (numeroOriginal / comprobanteNumero) y se marca importado:true.
//   - Lo pagado y el saldo se toman de Dux (totalPagado / saldoPendiente): la deuda con proveedores queda
//     visible y se puede seguir pagando desde el sistema. No se pueden anular ni recibir (no hay artículos).
//   - Proveedores: se reutiliza el que coincide por nombre (único); si no existe se crea.
//   - Re-subir el archivo no duplica: claveImport = proveedor + comprobante + fecha; si ya está, se actualiza
//     lo pagado/saldo/estado (sin pisar los pagos registrados en el sistema).
// GASTOS (mismo archivo, "Listado de Comprobantes de Servicios" de Dux): mismas reglas, una línea con el concepto (columna
// Detalles) y estado 'activo'. Los conceptos que no existan se crean.
// Rutas: POST /preview y /aplicar (compras); POST /gastos/preview y /gastos/aplicar (gastos)   body: { archivoBase64 }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereModulo('compras')];
const authGastos = [authUsuario, resolverOrg, requiereModulo('gastos')];

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

function clavesNombre(nombre) {
  const n = norm(nombre);
  if (!n) return [];
  const claves = new Set([n, n.replace(/,/g, '').replace(/\s+/g, ' ').trim()]);
  if (n.includes(',')) {
    const [ap, ...resto] = n.split(',');
    claves.add(ap.trim());
    claves.add((resto.join(' ') + ' ' + ap).replace(/\s+/g, ' ').trim());
  }
  return [...claves];
}

function parsearFecha(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 15));
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d, 15)) : null; }
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 15));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 15)) : null;
}
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return 0;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Estado de recepción de Dux -> estado de la compra. Sin artículos no se puede recibir, así que PENDIENTE/PARCIAL
// se conservan como "pendiente" solo como información (Recibir está bloqueado para las importadas).
function estadoDeRecepcion(txt) { return /PENDIENTE|PARCIAL/i.test(String(txt || '')) ? 'pendiente' : 'recibida'; }

const enc0 = (fila) => fila.map(norm);
function leerArchivo(base64, gasto) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'proveedor') && f.some(c => norm(c) === 'comprobante') && f.some(c => norm(c) === 'fecha'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Fecha, Comprobante y Proveedor. Tiene que ser ' + (gasto ? '"Listado de Comprobantes de Servicios"' : '"Consulta De Gestion Compra"') + ' de Dux.');
  if (gasto && !enc0(filas[hIdx]).includes('detalles')) throw err(400, 'Este archivo no es de gastos: falta la columna Detalles. Usá "Listado de Comprobantes de Servicios".');
  if (!gasto && enc0(filas[hIdx]).includes('detalles')) throw err(400, 'Este archivo parece de gastos (tiene Detalles). Importalo desde Gastos.');
  const enc = filas[hIdx].map(norm);
  const col = (n) => enc.indexOf(n);
  const c = { fecha: col('fecha'), comp: col('comprobante'), prov: col('proveedor'), estado: col(gasto ? 'estado facturacion' : 'estado recepcion'), total: col('total'), pagado: col('monto pagado'),
    detalle: col('detalles'), saldo: col('saldo'), personal: col('personal'), venc: col('fecha vencimiento'), obs: col('observaciones'), anula: col('personal anula') };
  if (c.total < 0) throw err(400, 'Falta la columna Total.');
  const txt = (f, k) => (c[k] >= 0 && f[c[k]] != null) ? String(f[c[k]]).trim() : '';
  const compras = [], errores = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const proveedor = txt(f, 'prov'); const comprobante = txt(f, 'comp'); const fecha = parsearFecha(f[c.fecha]);
    if (!proveedor) { errores.push({ fila: i + 1, motivo: 'Sin proveedor' }); continue; }
    if (!fecha) { errores.push({ fila: i + 1, motivo: 'Fecha inválida: ' + f[c.fecha] }); continue; }
    if (gasto && !txt(f, 'detalle')) { errores.push({ fila: i + 1, motivo: 'Sin concepto (Detalles)' }); continue; }
    const total = round2(numero(f[c.total]));
    const pagado = Math.min(round2(numero(f[c.pagado])), Math.abs(total));
    compras.push({
      fila: i + 1, fecha, comprobante, proveedor, total, pagado,
      saldo: round2(c.saldo >= 0 ? numero(f[c.saldo]) : total - pagado),
      estadoRecepcionDux: txt(f, 'estado'), personal: txt(f, 'personal'), vencimiento: parsearFecha(f[c.venc]),
      observaciones: txt(f, 'obs'), anulada: !!txt(f, 'anula'), concepto: txt(f, 'detalle')
    });
  }
  return { compras, errores };
}

const claveImport = (v, g) => (g ? 'duxg:' : 'duxc:') + norm(v.proveedor) + ':' + (v.comprobante || 's/n') + ':' + v.fecha.toISOString().slice(0, 10) + (v.comprobante ? '' : ':' + v.total.toFixed(2) + ':' + v.fila);

// Resuelve proveedores de la organización: reutiliza el que coincide por nombre (único) o lo crea.
function crearResolverProveedores(db, orgId, ahora) {
  const { ObjectId } = require('mongodb');
  let mapa = null; const memo = new Map(); const nuevos = new Set(); let existentes = 0, ambiguos = 0;
  async function cargar() {
    if (mapa) return;
    mapa = new Map();
    const provs = await db.collection('proveedores').find({ orgId, activo: { $ne: false } }).project({ razonSocial: 1, nombreFantasia: 1 }).toArray();
    const agregar = (k, id) => { if (!k) return; if (!mapa.has(k)) mapa.set(k, new Set()); mapa.get(k).add(String(id)); };
    provs.forEach(p => [p.razonSocial, p.nombreFantasia, [p.razonSocial, p.nombreFantasia].filter(Boolean).join(', ')].forEach(n => clavesNombre(n).forEach(k => agregar(k, p._id))));
  }
  return {
    async clasificar(nombre) {
      await cargar();
      if (memo.has(nombre)) return memo.get(nombre);
      const cand = new Set(); clavesNombre(nombre).forEach(k => (mapa.get(k) || new Set()).forEach(id => cand.add(id)));
      let r; if (cand.size === 1) { r = [...cand][0]; existentes++; } else if (cand.size > 1) { r = null; ambiguos++; } else { r = 'NUEVO'; nuevos.add(nombre); }
      memo.set(nombre, r); return r;
    },
    async crearNuevos() {
      if (!nuevos.size) return 0;
      const nombres = [...nuevos];
      const docs = nombres.map(n => ({ razonSocial: n, activo: true, notas: 'Importado de Dux', orgId, createdAt: ahora, updatedAt: ahora }));
      const r = await db.collection('proveedores').insertMany(docs, { ordered: false });
      nombres.forEach((n, i) => memo.set(n, String(r.insertedIds[i])));
      return docs.length;
    },
    id(nombre) { const v = memo.get(nombre); return v && v !== 'NUEVO' ? new ObjectId(v) : null; },
    totales() { return { nuevos: nuevos.size, existentes, ambiguos }; }
  };
}

async function procesar(req, aplicar, gasto) {
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { compras, errores } = leerArchivo(req.body && req.body.archivoBase64, gasto);
  if (!compras.length) throw err(400, 'El archivo no tiene ' + (gasto ? 'gastos' : 'compras') + ' para importar.');
  const col = gasto ? 'gastos' : 'compras';
  const ck = (v) => claveImport(v, gasto);
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId; const ahora = new Date();
    const claves = compras.map(ck);
    const existentes = new Map((await db.collection(col).find({ orgId, claveImport: { $in: claves } }).project({ claveImport: 1 }).toArray()).map(x => [x.claveImport, x]));
    const nuevas = compras.filter(v => !existentes.has(ck(v)));

    const resolver = crearResolverProveedores(db, orgId, ahora);
    for (const v of nuevas) await resolver.clasificar(v.proveedor);
    const t = resolver.totales();
    // Conceptos de gasto (Detalles): se reutilizan por nombre, los que faltan se crean.
    let conceptos = null, conceptosNuevos = new Set();
    if (gasto) {
      const ya = await db.collection('gastos_conceptos').find({ orgId }).project({ nombre: 1 }).toArray();
      conceptos = new Map(ya.map(c => [norm(c.nombre), c._id]));
      nuevas.forEach(v => { const k = norm(v.concepto); if (k && !conceptos.has(k)) conceptosNuevos.add(v.concepto); });
    }
    const estadoDe = (v) => v.anulada ? 'anulada' : (gasto ? 'activo' : estadoDeRecepcion(v.estadoRecepcionDux));
    const porEstado = {}; compras.forEach(v => { const e = estadoDe(v); porEstado[e] = (porEstado[e] || 0) + 1; });
    const resumen = {
      filasLeidas: compras.length, aImportar: nuevas.length, yaImportadas: compras.length - nuevas.length,
      desde: compras.reduce((a, v) => (!a || v.fecha < a ? v.fecha : a), null), hasta: compras.reduce((a, v) => (!a || v.fecha > a ? v.fecha : a), null),
      totalImporte: round2(nuevas.reduce((s, v) => s + v.total, 0)), totalSaldo: round2(nuevas.reduce((s, v) => s + (v.anulada ? 0 : v.saldo), 0)),
      conSaldo: nuevas.filter(v => !v.anulada && v.saldo >= 1).length, anuladas: nuevas.filter(v => v.anulada).length,
      proveedoresExistentes: t.existentes, proveedoresNuevos: t.nuevos, proveedoresAmbiguos: t.ambiguos, conceptosNuevos: conceptosNuevos.size,
      estados: porEstado, sucursalDestino: ((await db.collection('organizaciones').findOne({ _id: orgId }, { projection: { nombre: 1 } })) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const proveedoresCreados = await resolver.crearNuevos();
    if (gasto && conceptosNuevos.size) {
      const nombres = [...conceptosNuevos];
      const r = await db.collection('gastos_conceptos').insertMany(nombres.map(n => ({ nombre: n, activo: true, orgId, createdAt: ahora, updatedAt: ahora })), { ordered: false });
      nombres.forEach((n, i) => conceptos.set(norm(n), r.insertedIds[i]));
    }
    const docs = nuevas.map(v => {
      const estado = estadoDe(v);
      const base = {
        numero: 0, numeroOriginal: v.comprobante || 'S/N', importado: true, origen: 'dux', claveImport: ck(v),
        tipoComprobante: 'otro', puntoVenta: '', comprobanteNumero: v.comprobante || '', esFiscal: false,
        importeNeto: 0, importeIva: 0, importeExento: 0, importeTotalComprobante: v.total,
        percepciones: [], retenciones: [], impuestoCredito: 0, impuestoDebito: 0, otrosImpuestos: 0, totalPercepciones: 0, totalRetenciones: 0,
        proveedorId: resolver.id(v.proveedor), proveedorNombre: v.proveedor, fecha: v.fecha, moneda: 'ARS', cotizacionDolar: null, condicionPago: '',
        estado,
        descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: v.total, total: v.total,
        pagos: [], totalPagado: v.pagado, saldoPendiente: (v.anulada || v.total - v.pagado < 1) ? 0 : round2(v.total - v.pagado), duxPagado: v.pagado, duxSaldo: v.saldo,
        fechaVencimiento: v.vencimiento || null, personalDux: v.personal,
        observaciones: v.observaciones,
        anuladaEn: v.anulada ? v.fecha : null, anuladaPor: v.anulada ? 'Dux' : null, anuladaMotivo: v.anulada ? 'Anulada en Dux' : null,
        usuarioNombre, orgId, createdAt: v.fecha, updatedAt: ahora
      };
      if (gasto) {
        return Object.assign(base, { estadoFacturacionDux: v.estadoRecepcionDux,
          items: [{ conceptoId: conceptos.get(norm(v.concepto)) || null, conceptoNombre: v.concepto, cantidad: 1, precioUnitario: v.total, subtotal: v.total, observaciones: '', alicuotaIva: 0, importeIva: 0 }] });
      }
      return Object.assign(base, { tipoRecepcion: 'inmediata', depositoId: null, estadoRecepcionDux: v.estadoRecepcionDux,
        items: [{ productoId: null, sku: null, nombre: 'Compra histórica Dux (sin detalle)', cantidad: 1, precioUnitario: v.total, subtotal: v.total }],
        stockIngresado: false, stockIngresadoEn: null, recibidaEn: null });
    });
    let insertadas = 0;
    for (let i = 0; i < docs.length; i += 500) { const lote = docs.slice(i, i + 500); await db.collection(col).insertMany(lote, { ordered: false }); insertadas += lote.length; }

    // Las que ya estaban: solo el estado (no se pisan pagos registrados en el sistema).
    let actualizadas = 0;
    const ops = [];
    compras.forEach(v => {
      const ex = existentes.get(ck(v)); if (!ex) return;
      ops.push({ updateOne: { filter: { _id: ex._id }, update: { $set: Object.assign(gasto ? {} : { estadoRecepcionDux: v.estadoRecepcionDux }, { estado: estadoDe(v), updatedAt: ahora }) } } });
    });
    for (let i = 0; i < ops.length; i += 500) { const r = await db.collection(col).bulkWrite(ops.slice(i, i + 500), { ordered: false }); actualizadas += r.modifiedCount; }
    return Object.assign(resumen, { insertadas, proveedoresCreados, actualizadas });
  });
}

router.post('/preview', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, false, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, true, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/gastos/preview', authGastos, async (req, res) => {
  try { res.json(await procesar(req, false, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/gastos/aplicar', authGastos, async (req, res) => {
  try { res.json(await procesar(req, true, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
