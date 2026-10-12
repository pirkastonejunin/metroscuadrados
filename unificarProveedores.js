// ---------------------------------------------------------------------------
// Unificar proveedores duplicados (12/10/2026): detecta proveedores que parecen ser el mismo (mismo CUIT, o la misma razón social aunque
// cambie S.A./puntos/orden) y deja unificarlos en uno solo. Mismo funcionamiento que unificarClientes.js.
// Al unificar, TODO lo de los duplicados pasa al proveedor que se conserva (compras, gastos, pagos, órdenes de compra, cheques,
// saldo inicial de Dux); si el duplicado era de otra sucursal, el proveedor queda COMPARTIDO (orgIdsCompartidas): se ve y se usa en
// ambas sucursales con una sola ficha y un solo saldo; los datos que le falten se completan con los del duplicado; los duplicados quedan inactivos
// (con la marca "unificadoEn") y no se borran. Se buscan duplicados en todas las sucursales a las que tiene acceso el usuario.
// Rutas: GET /api/unificar-proveedores/grupos | /buscar   POST /unificar | /unificar-todos  body { ganadorId, perdedorIds:[...] }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('proveedores')];
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
  // Variantes de razón social: sin puntos ni signos, sin "S.A./SRL/SAS...", y sin importar el orden de las palabras
  const SUF = new Set(['sa', 'srl', 'sas', 'sh', 'sca', 'scs', 'ltda', 'sacif', 'saic', 'sacyf', 'cia', 'y', 'e', 'de', 'la', 'el', 'los', 'las', 'del']);
  const limp = n.replace(/\.\s*/g, '').replace(/[,;:&'"()\-\/]/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = limp.split(' ').filter(t => t && !SUF.has(t));
  if (toks.join('').length >= 4) { c.add(toks.join(' ')); c.add('ord ' + [...toks].sort().join(' ')); }
  return [...c];
}
async function orgsAccesibles(db, req) {
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nombreCompleto = (c) => c.razonSocial || c.nombreFantasia || '';
const vacio = (v) => v == null || v === '' || (typeof v === 'number' && !isFinite(v));
const CAMPOS = ['nombreFantasia', 'categoriaFiscal', 'tipoDocumento', 'numeroDocumento', 'cuit', 'email', 'provincia', 'localidad', 'barrio', 'domicilio', 'codigoPostal', 'telefono', 'celular',
  'condicionPago', 'diasPago', 'personaContacto', 'codigoDux', 'codigo', 'observaciones', 'tipoComprobanteDux'];

async function calcularGrupos(db, orgs) {
  const nombreOrg = new Map(orgs.map(o => [String(o._id), o.nombre]));
  const cl = await db.collection('proveedores').find({ orgId: { $in: orgs.map(o => o._id) }, activo: { $ne: false } }).toArray();
  const padre = cl.map((_, i) => i); const raiz = (i) => { while (padre[i] !== i) { padre[i] = padre[padre[i]]; i = padre[i]; } return i; };
  const une = (a, b) => { a = raiz(a); b = raiz(b); if (a !== b) padre[b] = a; };
  const porClave = new Map();
  cl.forEach((c, i) => {
    const ks = new Set();
    if (c.cuit) ks.add('cuit:' + String(c.cuit).replace(/\D/g, ''));
    [c.razonSocial, c.nombreFantasia].forEach(n => claves(n).forEach(k => ks.add('nom:' + k)));
    ks.forEach(k => { if (porClave.has(k)) une(porClave.get(k), i); else porClave.set(k, i); });
  });
  const grupos = new Map(); cl.forEach((c, i) => { const r = raiz(i); if (!grupos.has(r)) grupos.set(r, []); grupos.get(r).push(c); });
  const multi = [...grupos.values()].filter(g => g.length > 1);
  const ids = multi.flat().map(c => c._id);
  const [ventas, saldos] = ids.length ? await Promise.all([
    db.collection('compras').aggregate([{ $match: { proveedorId: { $in: ids } } }, { $group: { _id: '$proveedorId', n: { $sum: 1 } } }]).toArray(),
    db.collection('proveedores_saldos_iniciales').find({ proveedorId: { $in: ids } }).toArray()
  ]) : [[], []];
  const nv = new Map(ventas.map(v => [String(v._id), v.n])), sd = new Map(saldos.map(s => [String(s.proveedorId), s.monto]));
  const lista = multi.map(g => {
    const cuits = new Set(g.map(c => String(c.cuit || '').replace(/\D/g, '')).filter(Boolean));
    const porCuit = cuits.size === 1 && g.filter(c => c.cuit).length > 1;
    const miembros = g.map(c => ({ _id: String(c._id), nombre: nombreCompleto(c), cuit: c.cuit || '', categoriaFiscal: c.categoriaFiscal || '', domicilio: [c.domicilio, c.localidad].filter(Boolean).join(', '), telefono: c.telefono || c.celular || '',
      email: c.email || '', sucursal: (nombreOrg.get(String(c.orgId)) || '') + ((c.orgIdsCompartidas || []).length ? ' +' + c.orgIdsCompartidas.length : ''), orgId: String(c.orgId), ventas: nv.get(String(c._id)) || 0, saldo: round2(sd.get(String(c._id)) || 0) }))
      .sort((a, b) => b.ventas - a.ventas || (b.cuit ? 1 : 0) - (a.cuit ? 1 : 0));
    const cuitsDistintos = cuits.size > 1;
    return { motivo: porCuit ? 'Mismo CUIT' : (cuitsDistintos ? 'Mismo nombre pero CUIT distinto — revisá bien' : 'Mismo nombre'), riesgo: cuitsDistintos, miembros };
  }).sort((a, b) => (a.riesgo - b.riesgo) || b.miembros.length - a.miembros.length || a.miembros[0].nombre.localeCompare(b.miembros[0].nombre, 'es'));
  return lista;
}

router.get('/grupos', auth, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb(); const lista = await calcularGrupos(db, await orgsAccesibles(db, req));
      return { total: lista.length, sinRiesgo: lista.filter(g => !g.riesgo).length, grupos: lista.slice(0, 500) };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Búsqueda manual por nombre / CUIT para juntar proveedores que el sistema no detecta como iguales
router.get('/buscar', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim(); if (q.length < 2) throw err(400, 'Escribí al menos 2 letras.');
    const out = await conReintento(async () => {
      const db = await getDb(); const orgs = await orgsAccesibles(db, req); const nombreOrg = new Map(orgs.map(o => [String(o._id), o.nombre]));
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '.*'), 'i');
      const cl = await db.collection('proveedores').find({ orgId: { $in: orgs.map(o => o._id) }, activo: { $ne: false }, $or: [{ razonSocial: re }, { nombreFantasia: re }, { cuit: re }] }).limit(60).toArray();
      const ids = cl.map(c => c._id);
      const [ventas, saldos] = ids.length ? await Promise.all([
        db.collection('compras').aggregate([{ $match: { proveedorId: { $in: ids } } }, { $group: { _id: '$proveedorId', n: { $sum: 1 } } }]).toArray(),
        db.collection('proveedores_saldos_iniciales').find({ proveedorId: { $in: ids } }).toArray()]) : [[], []];
      const nv = new Map(ventas.map(v => [String(v._id), v.n])), sd = new Map(saldos.map(x => [String(x.proveedorId), x.monto]));
      const miembros = cl.map(c => ({ _id: String(c._id), nombre: nombreCompleto(c), cuit: c.cuit || '', domicilio: [c.domicilio, c.localidad].filter(Boolean).join(', '), telefono: c.telefono || c.celular || '',
        sucursal: nombreOrg.get(String(c.orgId)) || '', orgId: String(c.orgId), ventas: nv.get(String(c._id)) || 0, saldo: round2(sd.get(String(c._id)) || 0) }))
        .sort((a, b) => b.ventas - a.ventas);
      return { miembros };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unifica varios grupos [{ gan: ObjectId, per: [ObjectId] }]. Las referencias (ventas, cobros, etc.) se pasan en una sola vuelta por colección.
async function unificarGrupos(db, orgIds, items) {
  const ahora = new Date();
  const todosIds = items.flatMap(it => [it.gan].concat(it.per));
  const docs = new Map((await db.collection('proveedores').find({ _id: { $in: todosIds }, orgId: { $in: orgIds } }).toArray()).map(c => [String(c._id), c]));
  const listos = [];
  for (const it of items) {
    const ganador = docs.get(String(it.gan)); const perdedores = it.per.map(p => docs.get(String(p)));
    if (!ganador || perdedores.some(p => !p)) throw err(400, 'Los proveedores tienen que ser de sucursales a las que tenés acceso.');
    const set = {};
    for (const p of perdedores) CAMPOS.forEach(k => { if (vacio(ganador[k]) && vacio(set[k]) && !vacio(p[k])) set[k] = p[k]; });
    if (set.cuit && await db.collection('proveedores').findOne({ orgId: { $in: orgIds }, cuit: set.cuit, activo: { $ne: false }, _id: { $nin: it.per.concat([it.gan]) } })) delete set.cuit;
    if (set.codigo && await db.collection('proveedores').findOne({ orgId: ganador.orgId, codigo: set.codigo, activo: { $ne: false }, _id: { $nin: it.per.concat([it.gan]) } })) delete set.codigo;
    const comp = new Map((ganador.orgIdsCompartidas || []).map(o => [String(o), o]));
    perdedores.forEach(p => [p.orgId].concat(p.orgIdsCompartidas || []).forEach(o => { if (o && String(o) !== String(ganador.orgId)) comp.set(String(o), o); }));
    if (comp.size) set.orgIdsCompartidas = [...comp.values()];
    listos.push({ gan: it.gan, per: it.per, ganador, perdedores, set, comp, nombreG: nombreCompleto(ganador) });
  }
  // referencias: una pasada por colección
  const destino = new Map(); listos.forEach(l => l.per.forEach(p => destino.set(String(p), l)));
  const allPer = [...destino.keys()].map(k => new ObjectId(k));
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => !['proveedores', 'proveedores_saldos_iniciales', 'system.indexes'].includes(n));
  const movidos = {};
  for (const nombre of cols) {
    const dd = await db.collection(nombre).find({ proveedorId: { $in: allPer } }).project({ proveedorId: 1, proveedorNombre: 1 }).toArray();
    if (!dd.length) continue;
    const ops = dd.map(d => { const l = destino.get(String(d.proveedorId)); return { updateOne: { filter: { _id: d._id }, update: { $set: Object.assign({ proveedorId: l.gan }, d.proveedorNombre != null ? { proveedorNombre: l.nombreG } : {}) } } }; });
    for (let i = 0; i < ops.length; i += 1000) await db.collection(nombre).bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    movidos[nombre] = (movidos[nombre] || 0) + dd.length;
  }
  // saldos, saldo inicial y baja, grupo por grupo
  let saldoSumado = 0, unificados = 0;
  for (const l of listos) {
    // saldo inicial de Dux: uno solo por proveedor; los de los duplicados se suman en el del que se conserva
    const ini = await db.collection('proveedores_saldos_iniciales').find({ proveedorId: { $in: [l.gan].concat(l.per) } }).sort({ createdAt: 1 }).toArray();
    const delGan = ini.find(d => String(d.proveedorId) === String(l.gan)); const deLosDup = ini.filter(d => String(d.proveedorId) !== String(l.gan));
    const suma = deLosDup.reduce((a, d) => a + (d.monto || 0), 0); saldoSumado += suma;
    if (deLosDup.length) {
      if (delGan) await db.collection('proveedores_saldos_iniciales').updateOne({ _id: delGan._id }, { $inc: { monto: suma }, $set: { actualizadoEn: ahora } });
      else await db.collection('proveedores_saldos_iniciales').updateOne({ _id: deLosDup[0]._id }, { $set: { proveedorId: l.gan, proveedorNombre: l.nombreG, monto: round2(suma), actualizadoEn: ahora } });
      await db.collection('proveedores_saldos_iniciales').deleteMany({ _id: { $in: deLosDup.filter(d => !(!delGan && String(d._id) === String(deLosDup[0]._id))).map(d => d._id) } });
    }
    if (Object.keys(l.set).length) await db.collection('proveedores').updateOne({ _id: l.gan }, { $set: Object.assign({}, l.set, { updatedAt: ahora }) });
    await db.collection('proveedores').updateMany({ _id: { $in: l.per } }, { $set: { activo: false, unificadoEn: l.gan, unificadoFecha: ahora, updatedAt: ahora } });
    unificados += l.per.length;
  }
  return { ok: true, grupos: listos.length, unificados, movidos, saldoSumado: round2(saldoSumado), conservado: listos[0] ? listos[0].nombreG : '', sucursalesCompartidas: listos[0] ? listos[0].comp.size : 0 };
}
const oid = (v) => { try { return /^[0-9a-f]{24}$/i.test(String(v)) ? new ObjectId(String(v)) : null; } catch (e) { return null; } };

router.post('/unificar', auth, async (req, res) => {
  try {
    const gan = oid(req.body && req.body.ganadorId); const per = ((req.body && req.body.perdedorIds) || []).map(oid);
    if (!gan || !per.length || per.some(x => !x)) throw err(400, 'Elegí el proveedor que se conserva y al menos un duplicado.');
    if (per.some(x => x.equals(gan))) throw err(400, 'El proveedor que se conserva no puede ser también un duplicado.');
    const out = await conReintento(async () => { const db = await getDb(); return unificarGrupos(db, (await orgsAccesibles(db, req)).map(o => o._id), [{ gan, per }]); });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unifica TODOS los grupos de una vez (el proveedor que se conserva es el de más ventas). Por defecto deja afuera los de mismo nombre y CUIT distinto.
router.post('/unificar-todos', auth, async (req, res) => {
  try {
    const incluirDudosos = !!(req.body && req.body.incluirDudosos);
    const out = await conReintento(async () => {
      const db = await getDb(); const orgs = await orgsAccesibles(db, req);
      const lista = (await calcularGrupos(db, orgs)).filter(g => incluirDudosos || !g.riesgo);
      const items = lista.map(g => ({ gan: new ObjectId(g.miembros[0]._id), per: g.miembros.slice(1).map(m => new ObjectId(m._id)) }));
      if (!items.length) return { ok: true, grupos: 0, unificados: 0, movidos: {}, saldoSumado: 0 };
      const r = { ok: true, grupos: 0, unificados: 0, movidos: {}, saldoSumado: 0 };
      for (let i = 0; i < items.length; i += 100) {
        const x = await unificarGrupos(db, orgs.map(o => o._id), items.slice(i, i + 100));
        r.grupos += x.grupos; r.unificados += x.unificados; r.saldoSumado = round2(r.saldoSumado + x.saldoSumado);
        Object.entries(x.movidos).forEach(([k, v]) => { r.movidos[k] = (r.movidos[k] || 0) + v; });
      }
      return r;
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
module.exports = router;
