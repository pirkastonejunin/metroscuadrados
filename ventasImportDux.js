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

async function procesar(req, aplicar) {
  if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
  const { ventas, errores } = leerArchivo(req.body && req.body.archivoBase64);
  if (!ventas.length) throw err(400, 'El archivo no tiene ventas para importar.');
  return conReintento(async () => {
    const db = await getDb();
    const orgId = req.orgId;

    // Ya importadas
    const claves = ventas.map(claveImport);
    const existentes = new Set((await db.collection('ventas').find({ orgId, claveImport: { $in: claves } }).project({ claveImport: 1 }).toArray()).map(x => x.claveImport));

    // Clientes
    const clientes = await db.collection('clientes').find({ orgId, activo: { $ne: false } })
      .project({ apellidoRazonSocial: 1, nombre: 1, nombreFantasia: 1 }).toArray();
    const mapa = new Map(); // clave -> Set(_id)
    const agregar = (k, id) => { if (!k) return; if (!mapa.has(k)) mapa.set(k, new Set()); mapa.get(k).add(String(id)); };
    clientes.forEach(cl => {
      [cl.apellidoRazonSocial, cl.nombreFantasia, [cl.nombre, cl.apellidoRazonSocial].filter(Boolean).join(' '), [cl.apellidoRazonSocial, cl.nombre].filter(Boolean).join(' ')]
        .forEach(n => clavesNombre(n).forEach(k => agregar(k, cl._id)));
    });
    const idPorNombre = new Map(); // nombre Dux -> _id | null (ambiguo) | 'NUEVO'
    const nombresNuevos = new Set(); let ambiguos = 0, coinciden = 0;
    [...new Set(ventas.map(v => v.cliente))].forEach(nombre => {
      const cand = new Set();
      clavesNombre(nombre).forEach(k => (mapa.get(k) || new Set()).forEach(id => cand.add(id)));
      if (cand.size === 1) { idPorNombre.set(nombre, [...cand][0]); coinciden++; }
      else if (cand.size > 1) { idPorNombre.set(nombre, null); ambiguos++; }
      else { idPorNombre.set(nombre, 'NUEVO'); nombresNuevos.add(nombre); }
    });

    const nuevas = ventas.filter(v => !existentes.has(claveImport(v)));
    const resumen = {
      filasLeidas: ventas.length, aImportar: nuevas.length, yaImportadas: ventas.length - nuevas.length,
      desde: ventas.reduce((a, v) => (!a || v.fecha < a ? v.fecha : a), null), hasta: ventas.reduce((a, v) => (!a || v.fecha > a ? v.fecha : a), null),
      totalImporte: round2(nuevas.reduce((s, v) => s + v.total, 0)),
      sinNumeroCompleto: nuevas.filter(v => !v.completo).length,
      clientesExistentes: coinciden, clientesNuevos: nombresNuevos.size, clientesAmbiguos: ambiguos,
      errores
    };
    if (!aplicar) return resumen;

    const ahora = new Date();
    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    // Crear clientes nuevos
    let clientesCreados = 0;
    if (nombresNuevos.size) {
      const docs = [...nombresNuevos].map(n => ({ apellidoRazonSocial: n, categoriaFiscal: 'consumidor_final', origenCliente: 'Importado Dux', activo: true, orgId, createdAt: ahora, updatedAt: ahora }));
      const r = await db.collection('clientes').insertMany(docs, { ordered: false });
      [...nombresNuevos].forEach((n, i) => idPorNombre.set(n, String(r.insertedIds[i])));
      clientesCreados = docs.length;
    }
    const { ObjectId } = require('mongodb');
    const docs = nuevas.map(v => {
      const cid = idPorNombre.get(v.cliente);
      const esCX = v.prefijo === 'CX';
      return {
        numero: v.nro || 0,
        numeroOriginal: v.completo ? v.comprobante : (v.comprobante || v.prefijo) + ' (s/n)',
        importado: true, origen: 'dux', claveImport: claveImport(v),
        tipoComprobante: esCX ? 'comprobante_x' : 'fiscal',
        letra: esCX ? null : v.prefijo.slice(1),
        esFiscal: false, // ya se autorizó en Dux: no entra a ARCA ni a los libros fiscales de acá
        clienteId: cid ? new ObjectId(cid) : null,
        clienteNombre: v.cliente,
        vendedor: v.vendedor,
        fecha: v.fecha, moneda: 'ARS', listaPrecioId: null, cotizacionDolar: null,
        tipoEntrega: null, depositoId: null, stockComprometido: false,
        estado: 'entregada', estadoRemitoDux: v.estadoRemitoDux,
        items: [{ productoId: null, sku: null, nombre: 'Venta histórica Dux (sin detalle)', cantidad: 1, precioUnitario: v.total, subtotal: v.total, cantidadEntregada: 1 }],
        descuentoPorcentaje: 0, descuentoMonto: 0, subtotal: v.total, total: v.total,
        fiscal: null, fiscalEstado: null, fiscalMensaje: null,
        pagos: [], totalCobrado: Math.min(v.cobrado, v.total), saldoPendiente: 0, duxCobrado: v.cobrado, duxSaldo: round2(Math.max(v.total - v.cobrado, 0)),
        observaciones: v.observaciones, stockDescontado: false, stockDescontadoEn: null,
        remitoId: null, remitoNumero: null, remitosIds: [], entregadaEn: v.fecha,
        anuladaEn: null, anuladaPor: null, anuladaMotivo: null,
        usuarioNombre, orgId, createdAt: ahora, updatedAt: ahora
      };
    });
    let insertadas = 0;
    for (let i = 0; i < docs.length; i += 500) {
      const lote = docs.slice(i, i + 500);
      await db.collection('ventas').insertMany(lote, { ordered: false });
      insertadas += lote.length;
    }
    return Object.assign(resumen, { insertadas, clientesCreados });
  });
}

router.post('/preview', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/aplicar', authAdmin, async (req, res) => {
  try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
