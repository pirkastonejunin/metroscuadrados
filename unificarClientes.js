// ---------------------------------------------------------------------------
// Unificar clientes duplicados (11/10/2026): detecta clientes de una sucursal que parecen ser el mismo (mismo CUIT/CUIL, o el mismo
// nombre aunque esté escrito "APELLIDO, NOMBRE" / "NOMBRE APELLIDO") y deja unificarlos en uno solo.
// Al unificar, TODO lo de los duplicados pasa al cliente que se conserva (ventas, presupuestos, obras, visitas, cobros, cheques,
// cuenta corriente y su saldo); los datos que le falten se completan con los del duplicado; los duplicados quedan inactivos
// (con la marca "unificadoEn") y no se borran. Solo se unifican clientes de la misma sucursal.
// Rutas: GET /api/unificar-clientes/grupos   POST /api/unificar-clientes/unificar  body { ganadorId, perdedorIds:[...] }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('clientes')];
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
function claves(nombre) {
  const n = norm(nombre); if (!n) return [];
  const c = new Set([n.replace(/,/g, '').replace(/\s+/g, ' ').trim()]);
  if (n.includes(',')) { const [ap, ...r] = n.split(','); c.add((r.join(' ') + ' ' + ap).replace(/\s+/g, ' ').trim()); }
  return [...c];
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nombreCompleto = (c) => [c.apellidoRazonSocial, c.nombre].filter(Boolean).join(', ');
const vacio = (v) => v == null || v === '' || (typeof v === 'number' && !isFinite(v));
const CAMPOS = ['nombreFantasia', 'categoriaFiscal', 'tipoDocumento', 'numeroDocumento', 'cuit', 'email', 'vendedor', 'provincia', 'localidad', 'barrio', 'domicilio', 'codigoPostal', 'telefono', 'celular',
  'zona', 'condicionPago', 'tipoCliente', 'personaContacto', 'lugarEntregaPorDefecto', 'tipoComprobantePorDefecto', 'listaPrecioPorDefecto', 'codigoDux', 'codigo', 'observaciones'];

router.get('/grupos', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí una sucursal arriba (no "todas"): los clientes se unifican dentro de la misma sucursal.');
    const out = await conReintento(async () => {
      const db = await getDb();
      const cl = await db.collection('clientes').find({ orgId: req.orgId, activo: { $ne: false } }).toArray();
      const padre = cl.map((_, i) => i); const raiz = (i) => { while (padre[i] !== i) { padre[i] = padre[padre[i]]; i = padre[i]; } return i; };
      const une = (a, b) => { a = raiz(a); b = raiz(b); if (a !== b) padre[b] = a; };
      const porClave = new Map(), motivo = new Map();
      cl.forEach((c, i) => {
        const ks = new Set();
        if (c.cuit) ks.add('cuit:' + String(c.cuit).replace(/\D/g, ''));
        [c.apellidoRazonSocial, [c.nombre, c.apellidoRazonSocial].filter(Boolean).join(' '), [c.apellidoRazonSocial, c.nombre].filter(Boolean).join(' ')].forEach(n => claves(n).forEach(k => ks.add('nom:' + k)));
        ks.forEach(k => { if (porClave.has(k)) { une(porClave.get(k), i); motivo.set(k.startsWith('cuit') ? 'cuit' : 'nombre', true); } else porClave.set(k, i); });
      });
      const grupos = new Map(); cl.forEach((c, i) => { const r = raiz(i); if (!grupos.has(r)) grupos.set(r, []); grupos.get(r).push(c); });
      const multi = [...grupos.values()].filter(g => g.length > 1);
      const ids = multi.flat().map(c => c._id);
      const [ventas, saldos] = ids.length ? await Promise.all([
        db.collection('ventas').aggregate([{ $match: { clienteId: { $in: ids } } }, { $group: { _id: '$clienteId', n: { $sum: 1 } } }]).toArray(),
        db.collection('cuenta_corriente_saldos').find({ clienteId: { $in: ids } }).toArray()
      ]) : [[], []];
      const nv = new Map(ventas.map(v => [String(v._id), v.n])), sd = new Map(saldos.map(s => [String(s.clienteId), s.saldo]));
      const lista = multi.map(g => {
        const cuits = new Set(g.map(c => String(c.cuit || '').replace(/\D/g, '')).filter(Boolean));
        const porCuit = g.length > 1 && cuits.size === 1 && g.filter(c => c.cuit).length > 1;
        const miembros = g.map(c => ({ _id: String(c._id), nombre: nombreCompleto(c), cuit: c.cuit || '', categoriaFiscal: c.categoriaFiscal || '', domicilio: [c.domicilio, c.localidad].filter(Boolean).join(', '), telefono: c.telefono || c.celular || '',
          email: c.email || '', ventas: nv.get(String(c._id)) || 0, saldo: round2(sd.get(String(c._id)) || 0) }))
          .sort((a, b) => b.ventas - a.ventas || (b.cuit ? 1 : 0) - (a.cuit ? 1 : 0));
        const cuitsDistintos = cuits.size > 1;
        return { motivo: porCuit ? 'Mismo CUIT' : (cuitsDistintos ? 'Mismo nombre pero CUIT distinto — revisá bien' : 'Mismo nombre'), riesgo: cuitsDistintos, miembros };
      }).sort((a, b) => (a.riesgo - b.riesgo) || b.miembros.length - a.miembros.length || a.miembros[0].nombre.localeCompare(b.miembros[0].nombre, 'es'));
      return { total: lista.length, grupos: lista.slice(0, 500) };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/unificar', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí una sucursal arriba (no "todas").');
    const oid = (v) => { try { return /^[0-9a-f]{24}$/i.test(String(v)) ? new ObjectId(String(v)) : null; } catch (e) { return null; } };
    const gan = oid(req.body && req.body.ganadorId); const per = ((req.body && req.body.perdedorIds) || []).map(oid);
    if (!gan || !per.length || per.some(x => !x)) throw err(400, 'Elegí el cliente que se conserva y al menos un duplicado.');
    if (per.some(x => x.equals(gan))) throw err(400, 'El cliente que se conserva no puede ser también un duplicado.');
    const out = await conReintento(async () => {
      const db = await getDb(); const ahora = new Date();
      const todos = await db.collection('clientes').find({ _id: { $in: [gan].concat(per) }, orgId: req.orgId }).toArray();
      if (todos.length !== per.length + 1) throw err(400, 'Los clientes tienen que ser de la sucursal elegida.');
      const ganador = todos.find(c => c._id.equals(gan)); const perdedores = todos.filter(c => !c._id.equals(gan));
      const nombreG = nombreCompleto(ganador);
      // 1) completar datos vacíos del que se conserva (sin pisar). El CUIT solo si no lo tiene otro cliente activo.
      const set = {};
      for (const p of perdedores) CAMPOS.forEach(k => { if (vacio(ganador[k]) && vacio(set[k]) && !vacio(p[k])) set[k] = p[k]; });
      if (set.cuit && await db.collection('clientes').findOne({ orgId: req.orgId, cuit: set.cuit, activo: { $ne: false }, _id: { $nin: per.concat([gan]) } })) delete set.cuit;
      if (set.codigo && await db.collection('clientes').findOne({ orgId: req.orgId, codigo: set.codigo, activo: { $ne: false }, _id: { $nin: per.concat([gan]) } })) delete set.codigo;
      // 2) pasar todo lo que apunte a los duplicados (en cualquier colección con clienteId)
      const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !['clientes', 'cuenta_corriente_saldos', 'system.indexes'].includes(n));
      const movidos = {};
      for (const nombre of cols) {
        const docs = await db.collection(nombre).find({ clienteId: { $in: per } }).project({ clienteNombre: 1 }).toArray();
        if (!docs.length) continue;
        const ops = docs.map(d => ({ updateOne: { filter: { _id: d._id }, update: { $set: Object.assign({ clienteId: gan }, d.clienteNombre != null ? { clienteNombre: nombreG } : {}) } } }));
        for (let i = 0; i < ops.length; i += 1000) await db.collection(nombre).bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        movidos[nombre] = docs.length;
      }
      // 3) un solo "Saldo inicial Dux" por cliente: se suman en el del que se conserva
      const iniciales = await db.collection('cuenta_corriente_movimientos').find({ clienteId: gan, origen: 'saldo_inicial_dux' }).sort({ createdAt: 1 }).toArray();
      if (iniciales.length > 1) {
        const neto = iniciales.reduce((a, m) => a + (m.tipo === 'debito' ? m.monto : -m.monto), 0);
        await db.collection('cuenta_corriente_movimientos').updateOne({ _id: iniciales[0]._id }, { $set: { tipo: neto >= 0 ? 'debito' : 'credito', monto: round2(Math.abs(neto)) } });
        await db.collection('cuenta_corriente_movimientos').deleteMany({ _id: { $in: iniciales.slice(1).map(m => m._id) } });
      }
      // 4) saldo: se suman los saldos
      const sal = await db.collection('cuenta_corriente_saldos').find({ clienteId: { $in: per } }).toArray();
      const sumaSaldo = sal.reduce((a, s) => a + (s.saldo || 0), 0);
      if (sal.length) {
        await db.collection('cuenta_corriente_saldos').updateOne({ clienteId: gan }, { $inc: { saldo: sumaSaldo }, $set: { actualizadoEn: ahora }, $setOnInsert: { clienteId: gan } }, { upsert: true });
        await db.collection('cuenta_corriente_saldos').deleteMany({ clienteId: { $in: per } });
      }
      // 5) datos y baja de los duplicados
      if (Object.keys(set).length) await db.collection('clientes').updateOne({ _id: gan }, { $set: Object.assign({}, set, { updatedAt: ahora }) });
      await db.collection('clientes').updateMany({ _id: { $in: per } }, { $set: { activo: false, unificadoEn: gan, unificadoFecha: ahora, updatedAt: ahora } });
      return { ok: true, conservado: nombreG, unificados: perdedores.length, movidos, saldoSumado: round2(sumaSaldo), camposCompletados: Object.keys(set).length };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
module.exports = router;
