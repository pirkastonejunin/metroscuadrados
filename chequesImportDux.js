// ---------------------------------------------------------------------------
// Importar el HISTORIAL DE CHEQUES DE TERCEROS de Dux (Dux: "Cartera de Cheques"): una fila por cheque con
// Fecha, Fecha Vencimiento, Titular, Nro. Cheque, Banco, Monto, Estado, Cliente, Personal Registra.
//
// Se carga como historial: NO mueve cajas ni bancos (lo cobrado/depositado ya pasó en Dux). El estado de Dux se traduce:
//   DISPONIBLE -> en cartera (el único estado "vivo": se puede depositar o endosar desde Tesorería, o pagar a un proveedor)
//   DEPOSITADO -> depositado   COBRADO -> cobrado   ENDOSADO -> endosado   ANULADO -> anulado   RECHAZADO -> rechazado
// El archivo no trae sucursal: se elige a cuál van. Titular = librador del cheque; Cliente = quien lo entregó.
//
// Repetible: cada fila lleva una clave (número + banco + monto + fechas + orden entre idénticos); volver a subir el archivo no
// duplica. Si en Dux cambió el estado de un cheque que acá no se tocó, se actualiza; si ya se operó en este sistema, se respeta.
// Un cheque que ya estaba cargado a mano (mismo número y monto en la sucursal) se saltea.
// Rutas: POST /api/cheques-import-dux/preview y /aplicar   body: { archivoBase64, orgId }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('tesoreria')];

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
const sinCeros = (s) => String(s || '').trim().replace(/^0+/, '') || '0';

// Importe: acepta "760,928.00" (miles con coma, decimales con punto), "760.928,00" (formato argentino) o un número.
function parseMonto(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().replace(/[^\d.,-]/g, '');
  if (!s) return NaN;
  const i = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (i < 0) return Number(s);
  const decimales = s.length - i - 1;
  if (decimales >= 1 && decimales <= 2) return Number(s.slice(0, i).replace(/[.,]/g, '') + '.' + s.slice(i + 1));
  return Number(s.replace(/[.,]/g, ''));
}
// Fecha dd/mm/aaaa (o Date de Excel) -> mediodía de Argentina, para que no se corra de día.
function parseFecha(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 15));
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 15));
  return isNaN(d) ? null : d;
}
const ESTADOS = { disponible: 'en_cartera', 'en cartera': 'en_cartera', depositado: 'depositado', cobrado: 'cobrado', endosado: 'endosado', anulado: 'anulado', rechazado: 'rechazado' };

async function orgsAccesibles(db, req) {
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}

function leer(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb; try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'nro. cheque') && f.some(c => norm(c) === 'estado'));
  if (h < 0) throw err(400, 'No encontré las columnas "Nro. Cheque" y "Estado". Tiene que ser la "Cartera de Cheques" de Dux.');
  const enc = filas[h].map(norm);
  const col = (n) => enc.indexOf(n);
  const ix = { fecha: col('fecha'), venc: col('fecha vencimiento'), titular: col('titular'), nro: col('nro. cheque'), banco: col('banco'), monto: col('monto'), estado: col('estado'), cliente: col('cliente'), personal: col('personal registra') };
  const items = [], errores = [], ordinal = new Map();
  filas.slice(h + 1).forEach((f, k) => {
    if (!f || !f.some(c => String(c).trim())) return;
    const fila = h + 2 + k;
    const nro = String(f[ix.nro] || '').trim(), banco = String(f[ix.banco] || '').trim();
    const monto = round2(parseMonto(f[ix.monto])), fecha = parseFecha(f[ix.fecha]), venc = parseFecha(f[ix.venc]);
    const estadoDux = String(f[ix.estado] || '').trim(), estado = ESTADOS[norm(estadoDux)];
    if (!nro) return errores.push({ fila, motivo: 'Sin número de cheque' });
    if (!(monto > 0)) return errores.push({ fila, motivo: 'Monto inválido (' + f[ix.monto] + ')' });
    if (!venc) return errores.push({ fila, motivo: 'Fecha de vencimiento inválida (' + f[ix.venc] + ')' });
    if (!estado) return errores.push({ fila, motivo: 'Estado desconocido: ' + estadoDux });
    const base = [sinCeros(nro), norm(banco), monto, fecha ? fecha.toISOString().slice(0, 10) : '', venc.toISOString().slice(0, 10)].join('|');
    const n = ordinal.get(base) || 0; ordinal.set(base, n + 1);
    items.push({ fila, nro, banco, monto, fecha: fecha || venc, venc, estado, estadoDux: estadoDux.toUpperCase(), titular: String(f[ix.titular] || '').trim(), cliente: String(f[ix.cliente] || '').trim(), personal: String(f[ix.personal] || '').trim(), clave: base + '|' + n });
  });
  return { items, errores };
}

async function procesar(req, aplicar) {
  const body = req.body || {};
  const { items, errores } = leer(body.archivoBase64);
  return conReintento(async () => {
    const db = await getDb();
    const orgs = await orgsAccesibles(db, req);
    const orgId = String(body.orgId || (req.orgId || ''));
    const org = orgs.find(o => String(o._id) === orgId);
    if (!org) throw err(400, 'Elegí la sucursal donde se cargan los cheques.');
    const existentes = await db.collection('cheques').find({ orgId: org._id, tipo: 'tercero' }).project({ numero: 1, monto: 1, claveDux: 1, estado: 1, estadoDux: 1, importado: 1 }).toArray();
    const porClave = new Map(existentes.filter(c => c.claveDux).map(c => [c.claveDux, c]));
    const manuales = new Set(existentes.filter(c => !c.claveDux).map(c => sinCeros(c.numero) + '|' + round2(c.monto)));
    const nuevos = [], actualizar = []; let yaImportados = 0, yaManual = 0;
    for (const it of items) {
      const ex = porClave.get(it.clave);
      if (ex) {
        yaImportados++;
        // Cambió en Dux y acá no se tocó desde la importación: se pone al día.
        if (ex.estadoDux && ex.estado === ESTADOS[norm(ex.estadoDux)] && it.estado !== ex.estado) actualizar.push({ id: ex._id, it });
        continue;
      }
      if (manuales.has(sinCeros(it.nro) + '|' + it.monto)) { yaManual++; continue; }
      nuevos.push(it);
    }
    const porEstado = {};
    nuevos.forEach(it => { const e = porEstado[it.estado] || (porEstado[it.estado] = { cantidad: 0, total: 0 }); e.cantidad++; e.total = round2(e.total + it.monto); });
    const fechas = nuevos.map(i => i.fecha).sort((a, b) => a - b);
    const resumen = {
      filasLeidas: items.length + errores.length, aImportar: nuevos.length, yaImportados, yaCargadosAMano: yaManual, aActualizar: actualizar.length,
      porEstado, totalImporte: round2(nuevos.reduce((a, i) => a + i.monto, 0)), desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null,
      sucursalDestino: org.nombre, errores,
      enCartera: nuevos.filter(i => i.estado === 'en_cartera').map(i => ({ numero: i.nro, banco: i.banco, monto: i.monto, vencimiento: i.venc, cliente: i.cliente }))
    };
    if (!aplicar) return resumen;
    const ahora = new Date();
    const docs = nuevos.map(it => ({
      tipo: 'tercero', numero: it.nro, banco: it.banco, cuentaId: null, clienteId: null, clienteNombre: it.cliente, proveedorId: null, proveedorNombre: '',
      ventaId: null, compraId: null, librador: it.titular, cuitLibrador: '', fechaEmision: it.fecha, fechaVencimiento: it.venc, moneda: 'ARS', monto: it.monto,
      estado: it.estado, depositadoEnCuentaId: null, endosadoA: it.estado === 'endosado' ? 'Sin dato (historial Dux)' : '',
      observaciones: 'Importado de Dux (' + it.estadoDux + ')', usuarioNombre: it.personal, fecha: it.fecha,
      importado: true, estadoDux: it.estadoDux, claveDux: it.clave, orgId: org._id, createdAt: ahora, updatedAt: ahora
    }));
    for (let i = 0; i < docs.length; i += 500) await db.collection('cheques').insertMany(docs.slice(i, i + 500), { ordered: false });
    if (actualizar.length) await db.collection('cheques').bulkWrite(actualizar.map(a => ({ updateOne: { filter: { _id: a.id }, update: { $set: {
      estado: a.it.estado, estadoDux: a.it.estadoDux, endosadoA: a.it.estado === 'endosado' ? 'Sin dato (historial Dux)' : '', updatedAt: ahora } } } })));
    return Object.assign(resumen, { insertados: docs.length, actualizados: actualizar.length });
  });
}

router.post('/preview', auth, async (req, res) => { try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/aplicar', auth, async (req, res) => { try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
module.exports = router;
