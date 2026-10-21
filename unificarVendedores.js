// ---------------------------------------------------------------------------
// Unificar vendedores (21/10/2026, pedido de Mato): las ventas y presupuestos importados de Dux traen el vendedor como texto
// ("VELAZQUEZ, CARLOS"), pero las comisiones (Sueldos), el tablero y los informes reconocen al vendedor por el nombre del usuario/vendedor
// del sistema ("Carlos Velázquez"). Esta herramienta lista los nombres de vendedor que hay en ventas y presupuestos, propone con cuál de
// los del sistema se corresponde cada uno (mismo nombre aunque esté escrito "APELLIDO, NOMBRE" o "NOMBRE APELLIDO") y, al confirmar, reescribe
// el campo vendedor de esas ventas y presupuestos. No toca montos, clientes ni stock.
// Rutas: GET /api/unificar-vendedores/analisis    POST /api/unificar-vendedores/aplicar  body { cambios: [{ desde, hacia }] }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('visitas')];

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

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);
const clave = (s) => tokens(s).sort().join(' ');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function orgsAccesibles(db, req) {
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return (await db.collection('organizaciones').find({}).project({ _id: 1 }).toArray()).map(o => o._id);
  return ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
}
const filtroOrgs = (orgIds) => (orgIds && orgIds.length ? { orgId: { $in: orgIds } } : {});

// ¿El nombre de Dux corresponde a este nombre del sistema? Mismas palabras en cualquier orden, o todas las de uno incluidas en el otro (mínimo 2).
function coincide(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  if (clave(a) === clave(b)) return true;
  const [chico, grande] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return chico.length >= 2 && chico.every(t => grande.includes(t));
}

router.get('/analisis', auth, async (req, res) => {
  try {
    const r = await conReintento(async () => {
      const db = await getDb();
      const orgIds = await orgsAccesibles(db, req);
      const fo = filtroOrgs(orgIds);
      const cuenta = async (col) => (await db.collection(col).aggregate([
        { $match: Object.assign({ vendedor: { $nin: [null, ''] } }, fo) },
        { $group: { _id: '$vendedor', n: { $sum: 1 } } }]).toArray());
      const [vs, ps, usuarios, vendedores] = await Promise.all([
        cuenta('ventas'), cuenta('presupuestos'),
        db.collection('usuarios').find({ activo: { $ne: false } }).project({ nombre: 1 }).toArray(),
        db.collection('visitas_vendedores').find(Object.assign({ activo: { $ne: false } }, fo)).project({ nombre: 1 }).toArray()
      ]);
      const sistema = [];
      const vistos = new Set();
      [...usuarios.map(u => u.nombre), ...vendedores.map(v => v.nombre)].forEach(n => { const k = clave(n); if (n && !vistos.has(k)) { vistos.add(k); sistema.push(n); } });
      const por = new Map();
      vs.forEach(x => { const o = por.get(x._id) || { nombre: x._id, ventas: 0, presupuestos: 0 }; o.ventas += x.n; por.set(x._id, o); });
      ps.forEach(x => { const o = por.get(x._id) || { nombre: x._id, ventas: 0, presupuestos: 0 }; o.presupuestos += x.n; por.set(x._id, o); });
      const filas = [...por.values()].map(o => {
        const exacto = sistema.find(n => n === o.nombre);
        const cand = sistema.filter(n => coincide(o.nombre, n));
        let estado, sugerido = '';
        if (exacto) { estado = 'ya'; sugerido = exacto; }
        else if (cand.length === 1) { estado = 'propuesto'; sugerido = cand[0]; }
        else if (cand.length > 1) { estado = 'ambiguo'; }
        else estado = 'sin_coincidencia';
        return Object.assign(o, { estado, sugerido, candidatos: cand });
      }).sort((a, b) => (b.ventas + b.presupuestos) - (a.ventas + a.presupuestos));
      return { filas, sistema: sistema.sort((a, b) => a.localeCompare(b, 'es')) };
    });
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/aplicar', auth, async (req, res) => {
  try {
    const cambios = Array.isArray(req.body && req.body.cambios) ? req.body.cambios : [];
    const limpios = cambios.map(c => ({ desde: String((c && c.desde) || '').trim(), hacia: String((c && c.hacia) || '').trim() }))
      .filter(c => c.desde && c.hacia && c.desde !== c.hacia);
    if (!limpios.length) throw err(400, 'No hay cambios para aplicar.');
    const r = await conReintento(async () => {
      const db = await getDb();
      const orgIds = await orgsAccesibles(db, req);
      const fo = filtroOrgs(orgIds);
      let ventas = 0, presupuestos = 0;
      for (const c of limpios) {
        const f = Object.assign({ vendedor: c.desde }, fo);
        ventas += (await db.collection('ventas').updateMany(f, { $set: { vendedor: c.hacia } })).modifiedCount;
        presupuestos += (await db.collection('presupuestos').updateMany(f, { $set: { vendedor: c.hacia } })).modifiedCount;
      }
      return { cambios: limpios.length, ventas, presupuestos };
    });
    res.json(r);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.coincide = coincide;
