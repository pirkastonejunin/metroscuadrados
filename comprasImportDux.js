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
// Sueldos y cargas: en Dux se cargaban como gastos de un proveedor. Acá cuentan como "Sueldos y cargas · <sector>" en el
// Estado de resultados (el informe agrupa por ese prefijo), así los meses anteriores al módulo Sueldos quedan bien
// clasificados. El concepto original de Dux queda en las observaciones del renglón.
const PREF_SUELDOS = 'Sueldos y cargas · ';
function conceptoDeGasto(detalle) {
  const n = norm(detalle);
  if (/^sueldos? obra$/.test(n)) return PREF_SUELDOS + 'Obra';
  if (/^sueldos? fabrica$|^sueldos? produccion$/.test(n)) return PREF_SUELDOS + 'Producción';
  if (/^sueldos? comercial$|^comision(es)? venta$/.test(n)) return PREF_SUELDOS + 'Ventas';
  if (/^sueldos?$|^sueldos?, aportes/.test(n)) return PREF_SUELDOS + 'Otros';
  if (/^aportes leyes sociales/.test(n)) return PREF_SUELDOS + 'Cargas sociales y aportes';
  return detalle;
}
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
      observaciones: txt(f, 'obs'), anulada: !!txt(f, 'anula'), conceptoDux: txt(f, 'detalle'), concepto: gasto ? conceptoDeGasto(txt(f, 'detalle')) : ''
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

// La sucursal destino puede venir también en el cuerpo (orgId), por si el encabezado no llega.
function orgDeCuerpo(req) {
  const { ObjectId } = require('mongodb');
  const raw = req.body && req.body.orgId; if (!raw || !ObjectId.isValid(String(raw))) return null;
  const u = req.usuario || {};
  if (u.rol && u.rol.protegido) return new ObjectId(String(raw));
  return (u.orgIds || []).map(String).includes(String(raw)) ? new ObjectId(String(raw)) : null;
}
async function procesar(req, aplicar, gasto) {
  if (!req.orgId) req.orgId = orgDeCuerpo(req);
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
      proveedoresExistentes: t.existentes, proveedoresNuevos: t.nuevos, proveedoresAmbiguos: t.ambiguos, conceptosNuevos: conceptosNuevos.size, sueldosReclasificados: gasto ? compras.filter(v => v.concepto.startsWith(PREF_SUELDOS)).length : 0, sueldosImporte: gasto ? round2(nuevas.filter(v => v.concepto.startsWith(PREF_SUELDOS)).reduce((a, v) => a + v.total, 0)) : 0,
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
          items: [{ conceptoId: conceptos.get(norm(v.concepto)) || null, conceptoNombre: v.concepto, cantidad: 1, precioUnitario: v.total, subtotal: v.total, observaciones: v.conceptoDux !== v.concepto ? 'Concepto en Dux: ' + v.conceptoDux : '', alicuotaIva: 0, importeIva: 0 }] });
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

// ---------------------------------------------------------------------------
// PAGOS A PROVEEDORES (Dux: "Consulta De Gestion Pago"). Columnas: Numero Pago, Fecha, Tipo Comprobante, Comprobante,
// Concepto, Proveedor, Gasto, Personal, Total, Retenciones, Monto Aplicado, Total Pendiente Aplicar, Personal Anula, Fecha Anula.
// Se guardan como historial en `compras_pagos` (pestaña Pagos de Compras): no mueven caja/banco ni tocan los pagos de las
// compras. Dux no informa la forma de pago. "Total Pendiente Aplicar" = pagos a cuenta que todavía no se imputaron a una
// factura: se guarda como `montoSinAplicar` y se descuenta del saldo con cada proveedor (saldos-proveedores).
// ---------------------------------------------------------------------------
function monto(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/[^0-9,.\-]/g, '');
  if (!s) return 0;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}
function leerPagos(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'numero pago') && f.some(c => norm(c) === 'proveedor'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Numero Pago y Proveedor. Tiene que ser "Consulta De Gestion Pago" de Dux.');
  const enc = filas[hIdx].map(norm); const col = (n) => enc.indexOf(n);
  const c = { nro: col('numero pago'), fecha: col('fecha'), comp: col('comprobante'), concepto: col('concepto'), prov: col('proveedor'), personal: col('personal'),
    total: col('total'), ret: col('retenciones'), aplicado: col('monto aplicado'), pend: col('total pendiente aplicar'), anula: col('personal anula') };
  const txt = (f, k) => (c[k] >= 0 && f[c[k]] != null) ? String(f[c[k]]).trim() : '';
  const pagos = [], errores = []; let anuladas = 0;
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const proveedor = txt(f, 'prov'); const fecha = parsearFecha(f[c.fecha]); const nro = txt(f, 'nro');
    if (!proveedor) { errores.push({ fila: i + 1, motivo: 'Sin proveedor' }); continue; }
    if (!fecha) { errores.push({ fila: i + 1, motivo: 'Fecha inválida: ' + f[c.fecha] }); continue; }
    if (!nro) { errores.push({ fila: i + 1, motivo: 'Sin número de pago' }); continue; }
    if (txt(f, 'anula')) { anuladas++; continue; }
    pagos.push({ fila: i + 1, nro, fecha, proveedor, comprobante: txt(f, 'comp'), concepto: txt(f, 'concepto'), personal: txt(f, 'personal'),
      total: round2(monto(f[c.total])), retenciones: round2(monto(f[c.ret])), aplicado: round2(monto(f[c.aplicado])), sinAplicar: round2(monto(f[c.pend])) });
  }
  return { pagos, errores, anuladas };
}
async function procesarPagos(req, aplicar) {
  if (!req.orgId) req.orgId = orgDeCuerpo(req);
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { pagos, errores, anuladas } = leerPagos(req.body && req.body.archivoBase64);
  if (!pagos.length) throw err(400, 'El archivo no tiene pagos para importar.');
  const clave = (p) => 'duxp:' + p.nro;
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId; const ahora = new Date();
    const existentes = new Set((await db.collection('compras_pagos').find({ orgId, claveImport: { $in: pagos.map(clave) } }).project({ claveImport: 1 }).toArray()).map(x => x.claveImport));
    const nuevos = pagos.filter(p => !existentes.has(clave(p)));
    const resolver = crearResolverProveedores(db, orgId, ahora);
    for (const p of nuevos) await resolver.clasificar(p.proveedor);
    const t = resolver.totales();
    const resumen = {
      filasLeidas: pagos.length, aImportar: nuevos.length, yaImportados: pagos.length - nuevos.length, anuladasOmitidas: anuladas,
      desde: pagos.reduce((a, p) => (!a || p.fecha < a ? p.fecha : a), null), hasta: pagos.reduce((a, p) => (!a || p.fecha > a ? p.fecha : a), null),
      totalImporte: round2(nuevos.reduce((s, p) => s + p.total, 0)), totalAplicado: round2(nuevos.reduce((s, p) => s + p.aplicado, 0)),
      totalSinAplicar: round2(nuevos.reduce((s, p) => s + p.sinAplicar, 0)), conSinAplicar: nuevos.filter(p => p.sinAplicar >= 1).length,
      proveedoresExistentes: t.existentes, proveedoresNuevos: t.nuevos, proveedoresAmbiguos: t.ambiguos,
      sucursalDestino: ((await db.collection('organizaciones').findOne({ _id: orgId }, { projection: { nombre: 1 } })) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;
    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const proveedoresCreados = await resolver.crearNuevos();
    const docs = nuevos.map(p => ({
      proveedorId: resolver.id(p.proveedor), proveedorNombre: p.proveedor, fecha: p.fecha, tipoValor: 'historial_dux', monto: p.total,
      nota: p.concepto, usuarioNombre: p.personal || usuarioNombre, aplicaciones: [],
      importado: true, origen: 'dux', claveImport: clave(p), numeroOriginal: p.nro, comprobanteDux: p.comprobante,
      montoAplicado: p.aplicado, montoSinAplicar: p.sinAplicar >= 1 ? p.sinAplicar : 0, retenciones: p.retenciones,
      orgId, createdAt: p.fecha, updatedAt: ahora
    }));
    let insertados = 0;
    for (let i = 0; i < docs.length; i += 500) { const lote = docs.slice(i, i + 500); await db.collection('compras_pagos').insertMany(lote, { ordered: false }); insertados += lote.length; }
    return Object.assign(resumen, { insertados, proveedoresCreados });
  });
}
router.post('/pagos/preview', authAdmin, async (req, res) => {
  try { res.json(await procesarPagos(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/pagos/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesarPagos(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// DETALLE POR ARTÍCULO (Dux: "Consulta de Compras Detallada", máx. 60 días por archivo). Trae compras Y gastos
// (columna Tipo), con Sucursal Empresa, artículo/concepto por renglón, IVA, percepciones, recepción y pagos por forma.
// Completa las compras/gastos ya cargadas con el listado (por proveedor + comprobante + fecha), las pasa a la sucursal
// que corresponda y crea las que falten. Sigue siendo SOLO historial (sin stock ni caja). Repetible sin duplicar.
// Rutas: POST /detalle/preview y /detalle/aplicar   body: { archivoBase64, mapaSucursales: { 'PIRKA JUNIN': orgId } }
// ---------------------------------------------------------------------------
async function orgsAccesibles(db, req) {
  const { ObjectId } = require('mongodb');
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}
function sugerirOrg(nombre, orgs) {
  const n = norm(nombre); if (!n) return null;
  const ex = orgs.find(o => norm(o.nombre) === n) || orgs.find(o => norm(o.nombre).includes(n) || n.includes(norm(o.nombre)));
  return ex ? String(ex._id) : null;
}
function leerDetalleCompras(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const hIdx = filas.findIndex(f => f && f.some(c => norm(c) === 'producto/gasto') && f.some(c => norm(c) === 'comprobante'));
  if (hIdx < 0) throw err(400, 'No encontré las columnas Comprobante y Producto/Gasto. Tiene que ser "Consulta de Compras Detallada" de Dux.');
  const enc = filas[hIdx].map(norm); const c = (n) => enc.indexOf(n);
  const idx = { suc: c('sucursal empresa'), tipo: c('tipo'), prov: c('proveedor'), comp: c('comprobante'), fecha: c('fecha'), codigo: c('codigo producto'), prod: c('producto/gasto'),
    cant: c('cantidad'), rec: c('ctd recepcionada'), precio: c('precio uni'), desc: c('descuento'), sinIva: c('total sin iva'), pIva: c('porc. iva'), iva: c('iva'),
    conIva: c('total con iva'), perc: c('total percepcion'), total: c('total'), efvo: c('pago efectivo'), chq: c('pago cheque'), cta: c('pago cuenta'),
    rubro: c('rubro'), marca: c('marca'), personal: c('personal registra'), obs: c('observaciones comprobante'), venc: c('fecha vencimiento') };
  if (idx.prov < 0 || idx.total < 0 || idx.fecha < 0) throw err(400, 'Faltan columnas (Proveedor, Fecha o Total).');
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const num = (f, k) => idx[k] >= 0 ? numero(f[idx[k]]) : 0;
  const grupos = new Map(), errores = [];
  for (let i = hIdx + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const proveedor = txt(f, 'prov'); const fecha = parsearFecha(f[idx.fecha]); const comp = txt(f, 'comp');
    const gasto = /GASTO/i.test(txt(f, 'tipo'));
    if (!proveedor || !fecha) { errores.push({ fila: i + 1, motivo: 'Falta proveedor o fecha' }); continue; }
    const key = (gasto ? 'G' : 'C') + '|' + norm(proveedor) + '|' + (comp || 'sn') + '|' + fecha.toISOString().slice(0, 10) + (comp ? '' : '|' + i);
    if (!grupos.has(key)) grupos.set(key, { key, gasto, proveedor, comprobante: comp, fecha, sucursal: txt(f, 'suc'), personal: txt(f, 'personal'), observaciones: txt(f, 'obs'),
      vencimiento: idx.venc >= 0 ? parsearFecha(f[idx.venc]) : null, items: [], total: 0, percepciones: 0, pagos: { efectivo: 0, cheque: 0, cuenta: 0 } });
    const g = grupos.get(key);
    g.items.push({ codigo: txt(f, 'codigo'), nombre: txt(f, 'prod'), cantidad: num(f, 'cant') || 1, recibida: num(f, 'rec'), precio: num(f, 'precio'), descuento: num(f, 'desc'),
      subtotal: round2(num(f, 'sinIva')), porcIva: num(f, 'pIva'), iva: round2(num(f, 'iva')), conIva: round2(num(f, 'conIva')), rubro: txt(f, 'rubro'), marca: txt(f, 'marca') });
    g.total = round2(g.total + num(f, 'total')); g.percepciones = round2(g.percepciones + num(f, 'perc'));
    g.pagos.efectivo += num(f, 'efvo'); g.pagos.cheque += num(f, 'chq'); g.pagos.cuenta += num(f, 'cta');
  }
  return { grupos: [...grupos.values()], errores };
}
async function procesarDetalleCompras(req, aplicar) {
  if (!req.orgId) req.orgId = orgDeCuerpo(req);
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { grupos, errores } = leerDetalleCompras(req.body && req.body.archivoBase64);
  if (!grupos.length) throw err(400, 'El archivo no tiene compras ni gastos.');
  return conReintento(async () => {
    const db = await getDb(); const activa = req.orgId; const { ObjectId } = require('mongodb'); const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(activa))) orgIds.push(activa);
    const mapaIn = (req.body && req.body.mapaSucursales) || {};
    const sucursales = [...new Set(grupos.map(g => g.sucursal))];
    const destinoDe = (suc) => { const e = mapaIn[suc]; return (e && orgIds.some(x => String(x) === String(e))) ? new ObjectId(String(e)) : activa; };
    const nombreOrg = (id) => (orgs.find(o => String(o._id) === String(id)) || {}).nombre || String(id);
    const claveDe = (g) => (g.gasto ? 'duxg:' : 'duxc:') + norm(g.proveedor) + ':' + (g.comprobante || 's/n') + ':' + g.fecha.toISOString().slice(0, 10);

    // existentes (en cualquier sucursal accesible)
    const claves = grupos.filter(g => g.comprobante).map(claveDe);
    const colDe = (g) => g.gasto ? 'gastos' : 'compras';
    const exC = new Map((await db.collection('compras').find({ orgId: { $in: orgIds }, claveImport: { $in: claves } }).project({ claveImport: 1, total: 1, orgId: 1, estado: 1 }).toArray()).map(x => [x.claveImport, x]));
    const exG = new Map((await db.collection('gastos').find({ orgId: { $in: orgIds }, claveImport: { $in: claves } }).project({ claveImport: 1, total: 1, orgId: 1, estado: 1 }).toArray()).map(x => [x.claveImport, x]));
    const existente = (g) => g.comprobante ? (g.gasto ? exG : exC).get(claveDe(g)) : null;

    // catálogo por sucursal destino (solo compras)
    const codigos = [...new Set(grupos.filter(g => !g.gasto).flatMap(g => g.items.map(i => i.codigo)).filter(Boolean))];
    const catalogoPorOrg = new Map();
    for (const oid of new Set(sucursales.map(s => String(destinoDe(s))))) {
      const prods = codigos.length ? await db.collection('productos_catalogo').find({ orgId: new ObjectId(oid), $or: [{ sku: { $in: codigos } }, { codigoExterno: { $in: codigos } }] }).project({ sku: 1, codigoExterno: 1, nombre: 1 }).toArray() : [];
      const m = new Map(); prods.forEach(p => [p.sku, p.codigoExterno].filter(Boolean).forEach(cd => { if (!m.has(cd)) m.set(cd, p); }));
      catalogoPorOrg.set(oid, m);
    }
    // proveedores y conceptos por sucursal destino
    const resolvers = new Map();
    const provDe = (oid) => { const k = String(oid); if (!resolvers.has(k)) resolvers.set(k, crearResolverProveedores(db, new ObjectId(k), ahora)); return resolvers.get(k); };
    const conceptos = new Map(); // orgId -> { map, nuevos:Set }
    const conceptosDe = async (oid) => { const k = String(oid); if (!conceptos.has(k)) { const ya = await db.collection('gastos_conceptos').find({ orgId: new ObjectId(k) }).project({ nombre: 1 }).toArray(); conceptos.set(k, { map: new Map(ya.map(x => [norm(x.nombre), x._id])), nuevos: new Set() }); } return conceptos.get(k); };

    let aMover = 0, itemsVinc = 0, itemsTot = 0; const sinMatch = new Set(); const diferencias = [];
    for (const g of grupos) {
      const dest = destinoDe(g.sucursal); const ex = existente(g);
      if (ex && String(ex.orgId) !== String(dest)) aMover++;
      if (!ex || String(ex.orgId) !== String(dest)) await provDe(dest).clasificar(g.proveedor);
      if (g.gasto) { const cs = await conceptosDe(dest); g.items.forEach(i => { const nm = conceptoDeGasto(i.nombre); if (!cs.map.has(norm(nm))) cs.nuevos.add(nm); }); }
      else { const cat = catalogoPorOrg.get(String(dest)); g.items.forEach(i => { itemsTot++; if (cat.has(i.codigo)) itemsVinc++; else sinMatch.add(i.codigo); }); }
      if (ex && Math.abs(ex.total - g.total) > 1) diferencias.push(g.comprobante);
    }
    const nuevos = grupos.filter(g => !existente(g));
    const porSucursal = sucursales.map(sn => ({ sucursal: sn, comprobantes: grupos.filter(g => g.sucursal === sn).length, sugerida: sugerirOrg(sn, orgs), destino: String(destinoDe(sn)), destinoNombre: nombreOrg(destinoDe(sn)) }));
    let provNuevos = 0, provAmb = 0; resolvers.forEach(r => { const t = r.totales(); provNuevos += t.nuevos; provAmb += t.ambiguos; });
    const resumen = {
      comprobantes: grupos.length, compras: grupos.filter(g => !g.gasto).length, gastos: grupos.filter(g => g.gasto).length,
      renglones: grupos.reduce((a, g) => a + g.items.length, 0), conExistente: grupos.length - nuevos.length, aCrear: nuevos.length, aMover,
      desde: grupos.reduce((a, g) => (!a || g.fecha < a ? g.fecha : a), null), hasta: grupos.reduce((a, g) => (!a || g.fecha > a ? g.fecha : a), null),
      articulosVinculados: itemsVinc, articulosSinCatalogo: sinMatch.size, ejemplosSinCatalogo: [...sinMatch].slice(0, 8),
      proveedoresNuevos: provNuevos, proveedoresAmbiguos: provAmb, diferencias: diferencias.length, ejemplosDiferencias: diferencias.slice(0, 5),
      sucursales: porSucursal, organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })), errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    let proveedoresCreados = 0; for (const r of resolvers.values()) proveedoresCreados += await r.crearNuevos();
    for (const [k, cs] of conceptos) {
      if (!cs.nuevos.size) continue;
      const nombres = [...cs.nuevos];
      const r = await db.collection('gastos_conceptos').insertMany(nombres.map(n => ({ nombre: n, activo: true, orgId: new ObjectId(k), createdAt: ahora, updatedAt: ahora })), { ordered: false });
      nombres.forEach((n, i) => cs.map.set(norm(n), r.insertedIds[i]));
    }
    let actualizados = 0, creados = 0, movidos = 0;
    for (const g of grupos) {
      const dest = destinoDe(g.sucursal); const ex = existente(g); const col = colDe(g);
      const pagado = round2(g.pagos.efectivo + g.pagos.cheque + g.pagos.cuenta);
      const base = { sucursalDux: g.sucursal, duxPagos: { efectivo: round2(g.pagos.efectivo), cheque: round2(g.pagos.cheque), cuenta: round2(g.pagos.cuenta) }, totalPercepciones: g.percepciones, detalleDux: true, updatedAt: ahora };
      let items;
      if (g.gasto) {
        const cs = conceptos.get(String(dest));
        items = g.items.map(i => { const nm = conceptoDeGasto(i.nombre); return { conceptoId: cs.map.get(norm(nm)) || null, conceptoNombre: nm, cantidad: i.cantidad, precioUnitario: i.precio, descuentoPorcentaje: i.descuento, subtotal: i.subtotal,
          observaciones: nm !== i.nombre ? 'Concepto en Dux: ' + i.nombre : '', alicuotaIva: i.porcIva, importeIva: i.iva, codigoDux: i.codigo }; });
      } else {
        const cat = catalogoPorOrg.get(String(dest));
        items = g.items.map(i => { const p = cat.get(i.codigo); return { productoId: p ? p._id : null, sku: i.codigo || null, nombre: p ? p.nombre : i.nombre, nombreDux: i.nombre, cantidad: i.cantidad, cantidadRecibida: i.recibida,
          precioUnitario: i.precio, descuentoPorcentaje: i.descuento, subtotal: i.subtotal, alicuotaIva: i.porcIva, importeIva: i.iva, totalConIva: i.conIva, rubro: i.rubro || null, marca: i.marca || null }; });
      }
      if (ex) {
        const set = Object.assign({}, base, { items });
        if (String(ex.orgId) !== String(dest)) { set.orgId = dest; set.proveedorId = provDe(dest).id(g.proveedor); movidos++; }
        await db.collection(col).updateOne({ _id: ex._id }, { $set: set });
        actualizados++; continue;
      }
      // comprobante sin número: intenta enlazar con el "(s/n)" cargado por el listado (mismo proveedor, fecha y total)
      if (!g.comprobante) {
        const dia0 = new Date(g.fecha.getTime() - 12 * 3600e3), dia1 = new Date(g.fecha.getTime() + 12 * 3600e3);
        const sn = await db.collection(col).findOne({ orgId: { $in: orgIds }, importado: true, comprobanteNumero: '', proveedorNombre: g.proveedor, fecha: { $gte: dia0, $lte: dia1 }, total: { $gte: g.total - 1, $lte: g.total + 1 }, detalleDux: { $ne: true } });
        if (sn) { await db.collection(col).updateOne({ _id: sn._id }, { $set: Object.assign({}, base, { items }) }); actualizados++; continue; }
      }
      const todoRecibido = !g.gasto && g.items.every(i => i.recibida >= i.cantidad - 0.0001);
      const doc = {
        numero: 0, numeroOriginal: g.comprobante || 'S/N', importado: true, origen: 'dux', claveImport: g.comprobante ? claveDe(g) : claveDe(g) + ':' + g.key,
        tipoComprobante: 'otro', puntoVenta: '', comprobanteNumero: g.comprobante, esFiscal: false,
        importeNeto: 0, importeIva: 0, importeExento: 0, importeTotalComprobante: g.total,
        percepciones: [], retenciones: [], impuestoCredito: 0, impuestoDebito: 0, otrosImpuestos: 0, totalPercepciones: g.percepciones, totalRetenciones: 0,
        proveedorId: provDe(dest).id(g.proveedor), proveedorNombre: g.proveedor, fecha: g.fecha, moneda: 'ARS', cotizacionDolar: null, condicionPago: '',
        estado: g.gasto ? 'activo' : (todoRecibido ? 'recibida' : 'pendiente'),
        items, descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: round2(items.reduce((a, i) => a + i.subtotal, 0)), total: g.total,
        pagos: [], totalPagado: Math.min(pagado, g.total), saldoPendiente: Math.max(round2(g.total - pagado), 0) < 1 ? 0 : round2(g.total - pagado), duxPagado: pagado,
        fechaVencimiento: g.vencimiento || null, personalDux: g.personal, observaciones: g.observaciones,
        anuladaEn: null, anuladaPor: null, anuladaMotivo: null, usuarioNombre, orgId: dest, createdAt: g.fecha
      };
      if (!g.gasto) Object.assign(doc, { tipoRecepcion: 'inmediata', depositoId: null, stockIngresado: false, stockIngresadoEn: null, recibidaEn: null });
      await db.collection(col).insertOne(Object.assign(doc, base));
      creados++;
    }
    return Object.assign(resumen, { actualizados, creados, movidos, proveedoresCreados });
  });
}
router.post('/detalle/preview', authAdmin, async (req, res) => {
  try { res.json(await procesarDetalleCompras(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/detalle/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesarDetalleCompras(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// NOTAS DE CRÉDITO Y DÉBITO de compras y de gastos ("Listado de Nota Crédito Débito de Compra / de Gasto"). Una línea por nota.
// Se guardan en `compras` / `gastos` con tipoComprobante nota_credito_x / nota_debito_x (la nota de crédito resta en los
// informes y en la cuenta del proveedor), sin stock, caja ni saldo. Repetible sin duplicar.
// Rutas: POST /notas/preview|aplicar (compras) y /gastos/notas/preview|aplicar (gastos)   body: { archivoBase64, orgId }
// ---------------------------------------------------------------------------
function leerNotasCompra(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb; try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'tipo comprobante') && f.some(c => norm(c) === 'comprobante') && f.some(c => norm(c) === 'proveedor'));
  if (h < 0) throw err(400, 'No encontré las columnas Tipo Comprobante, Comprobante y Proveedor. Tiene que ser "Listado de Nota Crédito Débito de Compra" (o de Gasto) de Dux.');
  const enc = filas[h].map(norm); const c = (n) => enc.indexOf(n);
  const idx = { tipo: c('tipo comprobante'), comp: c('comprobante'), fecha: c('fecha'), prov: c('proveedor'), pers: c('personal'), total: c('total'), anula: c('fecha anula') };
  const notas = [], errores = [];
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i]; if (!f || f.every(x => x == null || x === '')) continue;
    const t = (k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
    const fecha = parsearFecha(f[idx.fecha]); const proveedor = t('prov');
    if (!fecha || !proveedor) { errores.push({ fila: i + 1, motivo: 'Falta fecha o proveedor' }); continue; }
    const esNC = /CREDITO/i.test(t('tipo')); const comp = t('comp'); const m = comp.match(/^([A-Z])-(\d{1,5})-(\d{1,8})$/);
    notas.push({ fila: i + 1, esNC, comprobante: comp, letra: m ? m[1].toLowerCase() : 'x', fecha, proveedor, personal: t('pers'), total: Math.abs(round2(numero(f[idx.total]))), anulada: !!t('anula') });
  }
  return { notas, errores };
}
const claveNotaCompra = (n, gasto) => 'dux' + (gasto ? 'g' : 'c') + 'n:' + (n.esNC ? 'NC' : 'ND') + ':' + norm(n.proveedor) + ':' + (n.comprobante || 's/n') + ':' + n.fecha.toISOString().slice(0, 10) + ':' + n.total.toFixed(2);
async function procesarNotasCompra(req, aplicar, gasto) {
  if (!req.orgId) req.orgId = orgDeCuerpo(req);
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { notas, errores } = leerNotasCompra(req.body && req.body.archivoBase64);
  if (!notas.length) throw err(400, 'El archivo no tiene notas.');
  const col = gasto ? 'gastos' : 'compras';
  return conReintento(async () => {
    const db = await getDb(); const orgId = req.orgId; const ahora = new Date();
    const claves = notas.map(n => claveNotaCompra(n, gasto));
    const existentes = new Set((await db.collection(col).find({ orgId, claveImport: { $in: claves } }).project({ claveImport: 1 }).toArray()).map(x => x.claveImport));
    const nuevas = notas.filter(n => !existentes.has(claveNotaCompra(n, gasto)));
    const resolver = crearResolverProveedores(db, orgId, ahora);
    for (const n of nuevas) await resolver.clasificar(n.proveedor);
    const t = resolver.totales(); const suma = (a) => round2(a.reduce((x, n) => x + n.total, 0));
    const porAnio = {}; notas.forEach(n => { const y = n.fecha.getUTCFullYear(); porAnio[y] = porAnio[y] || { nc: 0, nd: 0 }; porAnio[y][n.esNC ? 'nc' : 'nd']++; });
    const resumen = {
      filas: notas.length, creditos: notas.filter(n => n.esNC).length, debitos: notas.filter(n => !n.esNC).length,
      totalCreditos: suma(notas.filter(n => n.esNC)), totalDebitos: suma(notas.filter(n => !n.esNC)), porAnio,
      desde: notas.reduce((a, n) => (!a || n.fecha < a ? n.fecha : a), null), hasta: notas.reduce((a, n) => (!a || n.fecha > a ? n.fecha : a), null),
      aImportar: nuevas.length, yaCargadas: notas.length - nuevas.length, anuladas: notas.filter(n => n.anulada).length,
      proveedoresNuevos: t.nuevos, proveedoresExistentes: t.existentes, proveedoresAmbiguos: t.ambiguos,
      sucursalDestino: ((await db.collection('organizaciones').findOne({ _id: orgId }, { projection: { nombre: 1 } })) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;
    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const proveedoresCreados = await resolver.crearNuevos();
    const docs = nuevas.map(n => {
      const nombre = (n.esNC ? 'Nota de crédito' : 'Nota de débito') + ' histórica Dux (sin detalle)';
      const doc = {
        numero: 0, numeroOriginal: n.comprobante || 'S/N', importado: true, origen: 'dux', claveImport: claveNotaCompra(n, gasto),
        tipoComprobante: (n.esNC ? 'nota_credito_' : 'nota_debito_') + n.letra, puntoVenta: '', comprobanteNumero: n.comprobante, esFiscal: false,
        importeNeto: 0, importeIva: 0, importeExento: 0, importeTotalComprobante: n.total, percepciones: [], retenciones: [], impuestoCredito: 0, impuestoDebito: 0, otrosImpuestos: 0, totalPercepciones: 0, totalRetenciones: 0,
        proveedorId: resolver.id(n.proveedor), proveedorNombre: n.proveedor, fecha: n.fecha, moneda: 'ARS', cotizacionDolar: null, condicionPago: '',
        estado: n.anulada ? 'anulada' : (gasto ? 'activo' : 'recibida'), descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: n.total, total: n.total,
        pagos: [], totalPagado: 0, saldoPendiente: 0, duxPagado: 0, duxSaldo: 0, fechaVencimiento: null, personalDux: n.personal, observaciones: '',
        anuladaEn: n.anulada ? n.fecha : null, anuladaPor: n.anulada ? 'Dux' : null, anuladaMotivo: n.anulada ? 'Anulada en Dux' : null,
        usuarioNombre, orgId, createdAt: n.fecha, updatedAt: ahora
      };
      if (gasto) doc.items = [{ conceptoId: null, conceptoNombre: nombre, cantidad: 1, precioUnitario: n.total, subtotal: n.total, alicuotaIva: 0, importeIva: 0 }];
      else Object.assign(doc, { items: [{ productoId: null, sku: null, nombre, cantidad: 1, precioUnitario: n.total, subtotal: n.total }], tipoRecepcion: 'inmediata', depositoId: null, stockIngresado: false, stockIngresadoEn: null, recibidaEn: null, estadoRecepcionDux: '' });
      return doc;
    });
    let insertadas = 0;
    for (let i = 0; i < docs.length; i += 500) { await db.collection(col).insertMany(docs.slice(i, i + 500), { ordered: false }); insertadas += Math.min(500, docs.length - i); }
    return Object.assign(resumen, { insertadas, proveedoresCreados });
  });
}
router.post('/notas/preview', authAdmin, async (req, res) => { try { res.json(await procesarNotasCompra(req, false, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/notas/aplicar', authAdmin, async (req, res) => { try { res.json(await procesarNotasCompra(req, true, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/gastos/notas/preview', authGastos, async (req, res) => { try { res.json(await procesarNotasCompra(req, false, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/gastos/notas/aplicar', authGastos, async (req, res) => { try { res.json(await procesarNotasCompra(req, true, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

// Cobertura: por año/mes, cuántas compras y gastos importados ya tienen el detalle por artículo.
router.get('/detalle/cobertura', authAdmin, async (req, res) => {
  try {
    const db = await getDb(); const orgs = await orgsAccesibles(db, req);
    const orgIds = orgs.map(o => o._id);
    if (req.orgId && !orgIds.some(x => String(x) === String(req.orgId))) orgIds.push(req.orgId);
    const out = {};
    for (const col of ['compras', 'gastos']) {
      const filas = await db.collection(col).aggregate([
        { $match: { orgId: { $in: orgIds }, importado: true, estado: { $ne: 'anulada' } } },
        { $group: { _id: { y: { $year: { date: '$fecha', timezone: 'America/Argentina/Buenos_Aires' } }, m: { $month: { date: '$fecha', timezone: 'America/Argentina/Buenos_Aires' } } },
          total: { $sum: 1 }, conDetalle: { $sum: { $cond: [{ $eq: ['$detalleDux', true] }, 1, 0] } }, monto: { $sum: '$total' },
          montoSin: { $sum: { $cond: [{ $eq: ['$detalleDux', true] }, 0, '$total'] } } } },
        { $sort: { '_id.y': 1, '_id.m': 1 } }
      ]).toArray();
      out[col] = filas.map(f => ({ anio: f._id.y, mes: f._id.m, total: f.total, conDetalle: f.conDetalle, sinDetalle: f.total - f.conDetalle, monto: round2(f.monto), montoSinDetalle: round2(f.montoSin) }));
    }
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
