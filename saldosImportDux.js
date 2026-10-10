// ---------------------------------------------------------------------------
// Importar SALDOS DE CLIENTES de Dux (Dux: "Consulta de Clientes con Saldo"): una línea por cliente con su saldo a hoy
// (positivo = el cliente debe; negativo = tiene a favor).
// Cada saldo se carga como UN movimiento de cuenta corriente "Saldo inicial Dux" (débito si debe, crédito si tiene a favor)
// y suma al saldo del cliente (cuenta_corriente_saldos). Es la base sobre la que el sistema sigue sumando/restando.
// Repetible: volver a subir el archivo REEMPLAZA el saldo inicial anterior de cada cliente (no lo duplica); un cliente que
// ya no figura en el archivo (saldo 0 en Dux) queda con saldo inicial 0 solo si se tilda "poner en 0 los que no figuran".
// El archivo no trae sucursal: cada cliente se busca por nombre en todas las sucursales accesibles; si está en varias, va a
// la que tiene más ventas importadas; si no existe, se crea en la sucursal elegida.
// Rutas: POST /api/saldos-import-dux/clientes/preview y /aplicar   body: { archivoBase64, orgId, fechaCorte?, ponerEnCero? }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');
const { crearResolverClientes } = require('./ventasImportDux');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authClientes = [authUsuario, resolverOrg, requiereModulo('clientes')];

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

function leer(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb; try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'cliente') && f.some(c => norm(c) === 'saldo'));
  if (h < 0) throw err(400, 'No encontré las columnas Cliente y Saldo. Tiene que ser "Consulta de Clientes con Saldo" de Dux.');
  const enc = filas[h].map(norm); const ci = enc.indexOf('cliente'), si = enc.indexOf('saldo');
  const clientes = [], errores = []; const vistos = new Map();
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i]; if (!f || f.every(x => x == null || x === '')) continue;
    const nombre = f[ci] != null ? String(f[ci]).trim() : ''; if (!nombre) { errores.push({ fila: i + 1, motivo: 'Falta el cliente' }); continue; }
    const saldo = round2(numero(f[si]));
    const k = norm(nombre);
    if (vistos.has(k)) { clientes[vistos.get(k)].saldo = round2(clientes[vistos.get(k)].saldo + saldo); errores.push({ fila: i + 1, motivo: 'Cliente repetido (' + nombre + '): se suman los saldos' }); continue; }
    vistos.set(k, clientes.length); clientes.push({ fila: i + 1, nombre, saldo });
  }
  return { clientes, errores };
}

async function procesar(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new ObjectId(String(v)); }
  if (!req.orgId) throw err(400, 'Elegí con qué sucursal estás trabajando para los clientes que no existan.');
  const { clientes, errores } = leer(req.body && req.body.archivoBase64);
  if (!clientes.length) throw err(400, 'El archivo no tiene clientes con saldo.');
  const ponerEnCero = !!(req.body && req.body.ponerEnCero);
  const fm = String((req.body && req.body.fechaCorte) || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fechaCorte = fm ? new Date(Date.UTC(+fm[1], +fm[2] - 1, +fm[3], 15)) : new Date();
  return conReintento(async () => {
    const db = await getDb(); const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(req.orgId))) orgIds.push(req.orgId);
    const resolver = crearResolverClientes(db, ahora); // solo para buscar (nunca crea)
    const creador = crearResolverClientes(db, ahora);  // crea únicamente en la sucursal elegida
    const nombreOrg = (id) => (orgs.find(o => String(o._id) === String(id)) || {}).nombre || String(id);

    // 1) a qué sucursal/cliente va cada saldo
    const asignados = []; let ambiguos = [], enVarias = 0;
    for (const c of clientes) {
      const cand = [];
      for (const oid of orgIds) { const r = await resolver.clasificar(oid, c.nombre); if (r && r !== 'NUEVO') cand.push({ orgId: oid, clienteId: new ObjectId(r) }); }
      if (cand.length === 1) { asignados.push(Object.assign({}, c, cand[0])); continue; }
      if (cand.length > 1) {
        enVarias++;
        const cnt = await db.collection('ventas').aggregate([{ $match: { clienteId: { $in: cand.map(x => x.clienteId) } } }, { $group: { _id: '$clienteId', n: { $sum: 1 } } }]).toArray();
        const n = new Map(cnt.map(x => [String(x._id), x.n]));
        cand.sort((a, b) => (n.get(String(b.clienteId)) || 0) - (n.get(String(a.clienteId)) || 0));
        asignados.push(Object.assign({}, c, cand[0], { enVarias: true })); continue;
      }
      // ninguno: ¿ambiguo dentro de alguna sucursal, o realmente nuevo?
      let amb = false; for (const oid of orgIds) { const o = await resolver.clasificar(oid, c.nombre); if (o === null) amb = true; }
      if (amb) { ambiguos.push(c); continue; }
      asignados.push(Object.assign({}, c, { orgId: req.orgId, clienteId: null, nuevo: true }));
    }
    // clientes nuevos: se registran como NUEVO solo en la sucursal elegida
    for (const a of asignados.filter(x => x.nuevo)) await creador.clasificar(req.orgId, a.nombre);

    // 2) saldos iniciales anteriores (para reemplazar sin duplicar)
    const ids = asignados.filter(a => a.clienteId).map(a => a.clienteId);
    const previos = new Map((ids.length ? await db.collection('cuenta_corriente_movimientos').find({ clienteId: { $in: ids }, origen: 'saldo_inicial_dux' }).toArray() : []).map(m => [String(m.clienteId), m]));
    const firmado = (m) => m ? (m.tipo === 'debito' ? m.monto : -m.monto) : 0;
    const aCambiar = asignados.filter(a => !a.clienteId || Math.abs(a.saldo - firmado(previos.get(String(a.clienteId)))) >= 0.005);
    let sinFigurar = [];
    if (ponerEnCero) {
      const enArchivo = new Set(ids.map(String));
      sinFigurar = (await db.collection('cuenta_corriente_movimientos').find({ origen: 'saldo_inicial_dux', orgId: { $in: orgIds } }).toArray()).filter(m => !enArchivo.has(String(m.clienteId)) && firmado(m) !== 0);
    }
    const deben = clientes.filter(c => c.saldo > 0), aFavor = clientes.filter(c => c.saldo < 0);
    const suma = (a) => round2(a.reduce((x, c) => x + c.saldo, 0));
    const porSuc = {}; asignados.forEach(a => { const n = nombreOrg(a.orgId); porSuc[n] = porSuc[n] || { clientes: 0, saldo: 0 }; porSuc[n].clientes++; porSuc[n].saldo = round2(porSuc[n].saldo + a.saldo); });
    const resumen = {
      clientes: clientes.length, totalDeudores: suma(deben), cantDeudores: deben.length, totalAFavor: suma(aFavor), cantAFavor: aFavor.length, saldoNeto: suma(clientes),
      existentes: asignados.filter(a => a.clienteId).length, nuevos: asignados.filter(a => a.nuevo).length, enVariasSucursales: enVarias,
      ambiguos: ambiguos.length, ejemplosAmbiguos: ambiguos.slice(0, 8).map(c => c.nombre), montoAmbiguos: round2(ambiguos.reduce((x, c) => x + c.saldo, 0)), detalleAmbiguos: ambiguos.slice(0, 30).map(c => ({ nombre: c.nombre, saldo: c.saldo })), porSucursal: porSuc,
      aCargar: aCambiar.length, sinCambios: asignados.length - aCambiar.length, ponerEnCero: ponerEnCero ? sinFigurar.length : 0,
      fechaCorte, sucursalNuevos: nombreOrg(req.orgId), errores
    };
    if (!aplicar) return resumen;

    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    const creados = await creador.crearNuevos();
    asignados.filter(a => a.nuevo).forEach(a => { a.clienteId = creador.id(a.orgId, a.nombre); });
    let cargados = 0;
    const poner = async (a) => {
      const prev = previos.get(String(a.clienteId));
      const delta = round2(a.saldo - firmado(prev));
      if (Math.abs(delta) < 0.005 && (prev || a.saldo === 0)) return;
      const doc = { clienteId: a.clienteId, clienteNombre: a.nombre, tipo: a.saldo >= 0 ? 'debito' : 'credito', monto: Math.abs(a.saldo), moneda: 'ARS',
        concepto: 'Saldo inicial Dux', origen: 'saldo_inicial_dux', ventaId: null, chequeId: null, observaciones: 'Saldo de Dux al ' + fechaCorte.toISOString().slice(0, 10),
        usuarioNombre, fecha: fechaCorte, orgId: a.orgId, createdAt: ahora };
      if (prev) await db.collection('cuenta_corriente_movimientos').updateOne({ _id: prev._id }, { $set: doc });
      else if (a.saldo !== 0) await db.collection('cuenta_corriente_movimientos').insertOne(doc);
      await db.collection('cuenta_corriente_saldos').updateOne({ clienteId: a.clienteId }, { $inc: { saldo: delta }, $set: { actualizadoEn: ahora }, $setOnInsert: { clienteId: a.clienteId } }, { upsert: true });
      cargados++;
    };
    for (const a of asignados) if (a.clienteId) await poner(a);
    for (const m of sinFigurar) await poner({ clienteId: m.clienteId, nombre: m.clienteNombre, saldo: 0, orgId: m.orgId });
    return Object.assign(resumen, { cargados, clientesCreados: creados });
  });
}
router.post('/clientes/preview', authClientes, async (req, res) => { try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/clientes/aplicar', authClientes, async (req, res) => { try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

module.exports = router;
