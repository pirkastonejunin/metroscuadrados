// ---------------------------------------------------------------------------
// Importar cobranzas de clientes de Dux (Dux: "Consulta de Cobros"). Una línea por forma de valor de cada recibo
// (RX-...): efectivo, tarjeta, cheque o cuenta (transferencia/banco).
// SOLO HISTORIAL (igual que ventas y compras importadas):
//   - Se guardan como movimientos de crédito en la cuenta corriente del cliente (cuenta_corriente_movimientos), que es
//     de donde sale la lista de Cobranza. NO tocan el saldo del cliente (el saldo y lo cobrado de cada venta ya vienen de
//     Dux con la importación de ventas), NO mueven cajas/bancos y NO generan cheques en cartera.
//   - Si el concepto nombra el comprobante de una venta importada (X-0001-00000001 ~ CX-00001-00000001, FACTURA A-...),
//     el cobro se vincula a esa venta (cobro_venta); si no, queda como cobro a cuenta (cobro_cuenta).
//   - Devoluciones (monto negativo, ej. contra una nota de crédito) quedan como débito 'devolucion'.
//   - Cada sucursal de Dux se asigna a una sucursal del sistema (mapaSucursales). Repetible sin duplicar (claveImport).
// Rutas: POST /api/cobros-import-dux/preview y /aplicar   body: { archivoBase64, mapaSucursales }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');
const { crearResolverClientes } = require('./ventasImportDux');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authCobros = [authUsuario, resolverOrg, requiereModulo('tesoreria')];

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
  const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 15)) : null;
}
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return 0;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}
async function orgsAccesibles(db, req) {
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}
function sugerirOrg(nombre, orgs) {
  const n = norm(nombre); if (!n) return null;
  const ex = orgs.find(o => norm(o.nombre) === n) || orgs.find(o => norm(o.nombre).includes(n) || n.includes(norm(o.nombre)));
  return ex ? String(ex._id) : null;
}
function orgDeCuerpo(req) { const v = req.body && req.body.orgId; return v && /^[0-9a-f]{24}$/i.test(String(v)) ? new ObjectId(String(v)) : null; }

const FORMA = { EFECTIVO: 'efectivo', TARJETA: 'tarjeta', CHEQUE: 'cheque', CUENTA: 'cuenta' };

// "X-0001-00000001" / "C-000100000004" / "FACTURA A-00005-00000012" / "F-00005-00000012" -> candidatos "CX:1:1", "FA:5:12"
function clavesVenta(concepto) {
  const m = String(concepto || '').toUpperCase().match(/(?:FACTURA\s+|NOTA_?(?:CREDITO|DEBITO)\s+)?\b([A-Z]{1,2})\s*-?\s*(\d{4,5})\s*-?\s*(\d{8})\b/);
  if (!m) return [];
  const [, p, pv, nro] = m; const k = (pref) => pref + ':' + Number(pv) + ':' + Number(nro);
  if (p === 'X' || p === 'C' || p === 'CX') return [k('CX')];
  if (p === 'A' || p === 'FA') return [k('FA')];
  if (p === 'B' || p === 'FB') return [k('FB')];
  if (p === 'F') return [k('FA'), k('FB')];
  return [];
}
function claveDeNumeroOriginal(n) { const m = String(n || '').match(/^([A-Z]{2})-(\d{1,5})-(\d{1,8})$/); return m ? m[1] + ':' + Number(m[2]) + ':' + Number(m[3]) : null; }

function leer(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'tipo de valor') && f.some(c => norm(c) === 'comprobante'));
  if (h < 0) throw err(400, 'No encontré las columnas Comprobante y Tipo de Valor. Tiene que ser "Consulta de Cobros" de Dux.');
  const enc = filas[h].map(norm); const c = (n) => enc.indexOf(n);
  const idx = { suc: c('sucursal empresa'), cli: c('cliente'), comp: c('comprobante'), fecha: c('fecha comp'), tipo: c('tipo de valor'), conc: c('concepto'), monto: c('monto'),
    cuenta: c('cuenta'), tarj: c('tarjeta'), plan: c('plan tarjeta'), lote: c('nro lote'), cupon: c('nro. cupon'), nroCh: c('nro. cheque'), vto: c('fecha vto') };
  if (idx.cli < 0 || idx.monto < 0 || idx.fecha < 0) throw err(400, 'Faltan columnas (Cliente, Fecha Comp o Monto).');
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const lineas = [], errores = [], ord = new Map();
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i];
    if (!f || f.every(x => x == null || x === '')) continue;
    const cliente = txt(f, 'cli'), recibo = txt(f, 'comp'), fecha = parsearFecha(f[idx.fecha]), monto = round2(numero(f[idx.monto]));
    if (!cliente || !fecha || !monto) { errores.push({ fila: i + 1, motivo: !monto ? 'Sin monto' : 'Falta cliente o fecha' }); continue; }
    const tipo = FORMA[txt(f, 'tipo').toUpperCase()] || 'cuenta';
    const kOrd = recibo + '|' + tipo + '|' + monto.toFixed(2); const n = (ord.get(kOrd) || 0) + 1; ord.set(kOrd, n);
    lineas.push({ fila: i + 1, sucursal: txt(f, 'suc'), cliente, recibo, fecha, tipo, concepto: txt(f, 'conc'), monto,
      cuenta: txt(f, 'cuenta'), tarjeta: txt(f, 'tarj'), plan: txt(f, 'plan'), lote: txt(f, 'lote'), cupon: txt(f, 'cupon'),
      nroCheque: txt(f, 'nroCh'), vto: idx.vto >= 0 ? parsearFecha(f[idx.vto]) : null,
      clave: 'duxcob:' + (recibo || 's/r') + ':' + tipo + ':' + monto.toFixed(2) + ':' + n + (recibo ? '' : ':' + norm(cliente) + ':' + fecha.toISOString().slice(0, 10)) });
  }
  return { lineas, errores };
}

async function procesar(req, aplicar) {
  if (!req.orgId) req.orgId = orgDeCuerpo(req);
  if (!req.orgId) throw err(400, 'Elegí con qué organización (sucursal) estás trabajando antes de importar.');
  const { lineas, errores } = leer(req.body && req.body.archivoBase64);
  if (!lineas.length) throw err(400, 'El archivo no tiene cobros para importar.');
  return conReintento(async () => {
    const db = await getDb(); const activa = req.orgId; const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(activa))) orgIds.push(activa);
    const mapaIn = (req.body && req.body.mapaSucursales) || {};
    const sucursales = [...new Set(lineas.map(l => l.sucursal))];
    const destinoDe = (s) => { const e = mapaIn[s]; return (e && orgIds.some(x => String(x) === String(e))) ? new ObjectId(String(e)) : activa; };
    const nombreOrg = (id) => (orgs.find(o => String(o._id) === String(id)) || {}).nombre || String(id);

    const ya = new Set((await db.collection('cuenta_corriente_movimientos').find({ claveImport: { $in: lineas.map(l => l.clave) } }).project({ claveImport: 1 }).toArray()).map(x => x.claveImport));
    const nuevas = lineas.filter(l => !ya.has(l.clave));

    // ventas importadas, por comprobante
    const ventas = await db.collection('ventas').find({ orgId: { $in: orgIds }, importado: true }).project({ numeroOriginal: 1, orgId: 1, clienteId: 1 }).toArray();
    const porClave = new Map(); ventas.forEach(v => { const k = claveDeNumeroOriginal(v.numeroOriginal); if (k) { if (!porClave.has(k)) porClave.set(k, []); porClave.get(k).push(v); } });
    const ventaDe = (l, dest) => {
      for (const k of clavesVenta(l.concepto)) { const c = porClave.get(k); if (c && c.length) return c.find(v => String(v.orgId) === String(dest)) || c[0]; }
      return null;
    };

    const resolver = crearResolverClientes(db, ahora);
    for (const l of nuevas) await resolver.clasificar(destinoDe(l.sucursal), l.cliente);
    const t = resolver.totales();

    const porTipo = {}, porAnio = {}; let vinculadas = 0, devoluciones = 0, montoTotal = 0;
    nuevas.forEach(l => {
      l.venta = ventaDe(l, destinoDe(l.sucursal)); if (l.venta) vinculadas++;
      if (l.monto < 0) { devoluciones++; return; }
      montoTotal += l.monto; porTipo[l.tipo] = round2((porTipo[l.tipo] || 0) + l.monto);
      const y = l.fecha.getUTCFullYear(); porAnio[y] = round2((porAnio[y] || 0) + l.monto);
    });
    const resumen = {
      lineas: lineas.length, aImportar: nuevas.length, yaImportadas: lineas.length - nuevas.length,
      recibos: new Set(lineas.map(l => l.recibo)).size,
      desde: lineas.reduce((a, l) => (!a || l.fecha < a ? l.fecha : a), null), hasta: lineas.reduce((a, l) => (!a || l.fecha > a ? l.fecha : a), null),
      montoTotal: round2(montoTotal), porTipo, porAnio, vinculadasAVenta: vinculadas, aCuenta: nuevas.length - vinculadas - devoluciones, devoluciones,
      clientesExistentes: t.existentes, clientesNuevos: t.nuevos, clientesAmbiguos: t.ambiguos,
      sucursales: sucursales.map(s => ({ sucursal: s, lineas: lineas.filter(l => l.sucursal === s).length, sugerida: sugerirOrg(s, orgs), destino: String(destinoDe(s)), destinoNombre: nombreOrg(destinoDe(s)) })),
      organizaciones: orgs.map(o => ({ _id: String(o._id), nombre: o.nombre })), errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const clientesCreados = await resolver.crearNuevos();
    const docs = nuevas.map(l => {
      const dest = destinoDe(l.sucursal); const dev = l.monto < 0;
      const det = [l.recibo, l.cuenta && 'Cuenta: ' + l.cuenta, l.tarjeta && 'Tarjeta: ' + l.tarjeta + (l.plan ? ' (' + l.plan + ')' : ''), l.nroCheque && 'Cheque ' + l.nroCheque + (l.vto ? ' vto ' + l.vto.toISOString().slice(0, 10) : '')].filter(Boolean).join(' · ');
      return {
        clienteId: resolver.id(dest, l.cliente), clienteNombre: l.cliente, tipo: dev ? 'debito' : 'credito', monto: Math.abs(l.monto), moneda: 'ARS',
        concepto: l.concepto || 'Cobro importado de Dux', origen: dev ? 'devolucion' : (l.venta ? 'cobro_venta' : 'cobro_cuenta'),
        ventaId: l.venta ? l.venta._id : null, chequeId: null, observaciones: det, usuarioNombre, fecha: l.fecha, orgId: dest, createdAt: l.fecha,
        tipoValor: l.tipo, importado: true, origenImport: 'dux', numeroOriginal: l.recibo, claveImport: l.clave,
        detalleDux: { cuenta: l.cuenta, tarjeta: l.tarjeta, planTarjeta: l.plan, lote: l.lote, cupon: l.cupon, nroCheque: l.nroCheque, vencimientoCheque: l.vto }
      };
    });
    let insertados = 0;
    for (let i = 0; i < docs.length; i += 500) { const r = await db.collection('cuenta_corriente_movimientos').insertMany(docs.slice(i, i + 500), { ordered: false }); insertados += r.insertedCount; }
    return Object.assign(resumen, { insertados, clientesCreados });
  });
}
router.post('/preview', authCobros, async (req, res) => { try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/aplicar', authCobros, async (req, res) => { try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

module.exports = router;
