// ---------------------------------------------------------------------------
// Tablero comercial (7/10/2026, pedido de Mato) — pantalla de inicio por rol.
//
// Muestra el embudo completo con % de efectividad entre etapas:
//   CRM (oportunidades cargadas) -> Visitas generadas -> Presupuestos
//   cargados -> Ventas realizadas.
// Cada etapa cuenta lo que se CARGÓ dentro del período elegido (fecha de
// alta), no una cohorte: es lo que cada persona ve que hizo en el rango.
//   - CRM:          oportunidades (cualquier estado), por createdAt.
//   - Visitas:      visitas no canceladas, por createdAt.
//   - Presupuestos: todos los presupuestos (también rechazados), por createdAt.
//   - Ventas:       ventas no anuladas, por createdAt.
//
// Quién ve qué:
//   - Administrador y cualquier rol con el módulo 'tablero': TODO el equipo
//     de la sucursal (organización) activa, con la opción de filtrar por
//     vendedor (CRM y visitas por el vendedor; presupuestos y ventas por el
//     usuario vinculado a ese vendedor).
//
// Integración (server.js):  app.use('/api/tablero', require('./tablero'));
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, resolverOrg, filtroOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(
        () => { mongoClient = nuevo; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try { return await fn(); }
  catch (e) { mongoClient = null; return await fn(); }
}

function toObjectId(id) { try { return id ? new ObjectId(String(id)) : null; } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function responder(res, e) { res.status(e.status || 500).json({ error: e.message || 'Error' }); }

const authTablero = [authUsuario, resolverOrg, (req, res, next) => {
  const r = req.usuario.rol;
  if (!(r.protegido || (r.modulos || []).includes('tablero'))) {
    return res.status(403).json({ error: 'Tu usuario no tiene acceso al tablero. Pedile a un administrador que te lo habilite.' });
  }
  next();
}];

// "YYYY-MM-DD" -> inicio/fin de ese día en Argentina (UTC-3, sin horario de verano).
function inicioDia(s) { return new Date(s + 'T00:00:00.000-03:00'); }
function finDia(s) { return new Date(s + 'T23:59:59.999-03:00'); }
function fechaAR(d) {
  const x = new Date(d.getTime() - 3 * 3600e3);
  return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
}
function validarFecha(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(inicioDia(s).getTime()); }

function pct(parte, total) {
  if (!total) return null;
  return Math.round((parte / total) * 1000) / 10; // un decimal
}

// A quién se atribuye lo que se cuenta, según el filtro de vendedor.
async function resolverAlcance(db, req) {
  const avisos = [];
  let vendedorId = null;      // ObjectId del vendedor (CRM y visitas)
  let usuarios = null;        // [{_id, nombre}] que cargaron presupuestos y ventas
  let alcance = 'todo';
  const vf = req.query.vendedorId ? toObjectId(req.query.vendedorId) : null;
  if (req.query.vendedorId && !vf) throw err(400, 'vendedorId inválido');
  if (vf) {
    alcance = 'vendedor';
    vendedorId = vf;
    usuarios = await db.collection('usuarios').find({ vendedorId: vf }).project({ nombre: 1 }).toArray();
    if (!usuarios.length) avisos.push('Ese vendedor no tiene un usuario vinculado: presupuestos y ventas figuran en 0.');
  }
  const filtroVend = vendedorId ? { vendedorId } : {};
  const filtroUsr = alcance === 'todo' ? {}
    : { $or: [{ usuarioId: { $in: (usuarios || []).map(u => u._id) } }, { usuarioId: { $exists: false }, usuarioNombre: { $in: (usuarios || []).map(u => u.nombre) } }] };
  if (alcance !== 'todo' && !(usuarios || []).length) filtroUsr.$or = [{ _id: null }];
  return { alcance, vendedorId, usuarios, filtroVend, filtroUsr, avisos };
}

function rangoDe(req) {
  const hoy = fechaAR(new Date());
  const desdeS = req.query.desde || hoy.slice(0, 8) + '01';
  const hastaS = req.query.hasta || hoy;
  if (!validarFecha(desdeS) || !validarFecha(hastaS)) throw err(400, 'Las fechas tienen que tener el formato AAAA-MM-DD.');
  if (desdeS > hastaS) throw err(400, 'La fecha "desde" no puede ser posterior a "hasta".');
  return { desdeS, hastaS, rango: { $gte: inicioDia(desdeS), $lte: finDia(hastaS) } };
}

router.get('/embudo', authTablero, async (req, res) => {
  try {
    const { desdeS, hastaS, rango } = rangoDe(req);
    const avisos = [];

    const out = await conReintento(async () => {
      const db = await getDb();
      const org = filtroOrg(req);
      const { alcance, vendedorId, usuarios, filtroVend, filtroUsr, avisos: av } = await resolverAlcance(db, req);
      avisos.push(...av);
      const sinVinculo = false;

      const [crm, visitas, presupuestos, ventas] = await Promise.all([
        sinVinculo ? 0 : db.collection('oportunidades').countDocuments(Object.assign({}, org, filtroVend, { createdAt: rango })),
        sinVinculo ? 0 : db.collection('visitas').countDocuments(Object.assign({}, org, filtroVend, { estado: { $ne: 'cancelada' }, createdAt: rango })),
        db.collection('presupuestos').countDocuments(Object.assign({}, org, filtroUsr, { createdAt: rango })),
        db.collection('ventas').countDocuments(Object.assign({}, org, filtroUsr, { estado: { $ne: 'anulada' }, createdAt: rango }))
      ]);
      return { crm, visitas, presupuestos, ventas, alcance, vendedorId: vendedorId ? String(vendedorId) : null };
    });

    const etapas = [
      { clave: 'crm', titulo: 'Datos en el CRM', cantidad: out.crm, pctAnterior: null },
      { clave: 'visitas', titulo: 'Visitas generadas', cantidad: out.visitas, pctAnterior: pct(out.visitas, out.crm) },
      { clave: 'presupuestos', titulo: 'Presupuestos cargados', cantidad: out.presupuestos, pctAnterior: pct(out.presupuestos, out.visitas) },
      { clave: 'ventas', titulo: 'Ventas realizadas', cantidad: out.ventas, pctAnterior: pct(out.ventas, out.presupuestos) }
    ];
    res.json({
      desde: desdeS, hasta: hastaS, alcance: out.alcance, vendedorId: out.vendedorId, avisos,
      etapas, efectividadTotal: pct(out.ventas, out.presupuestos)
    });
  } catch (e) { responder(res, e); }
});

// Vendedores de la sucursal activa, para el filtro.
router.get('/vendedores', authTablero, async (req, res) => {
  try {
    const lista = await conReintento(async () => (await getDb()).collection('visitas_vendedores').find(filtroOrg(req)).project({ nombre: 1 }).sort({ nombre: 1 }).toArray());
    res.json(lista.map(v => ({ _id: String(v._id), nombre: v.nombre })));
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Unidades vendidas por rubro (7/10/2026, pedido de Mato): el tablero muestra
// SOLO los rubros que el administrador dejó preseteados para la sucursal
// (colección tablero_config, clave 'rubros'). Suma la cantidad de los ítems de
// ventas no anuladas del período (cantidad en la unidad de cada producto: m2,
// unidades, etc.), con el mismo filtro de vendedor que el embudo.
// ---------------------------------------------------------------------------
async function rubrosConfigurados(db, req) {
  const doc = await db.collection('tablero_config').findOne(Object.assign({ clave: 'rubros' }, filtroOrg(req)));
  return (doc && Array.isArray(doc.rubros)) ? doc.rubros : [];
}

router.get('/rubros', authTablero, async (req, res) => {
  try {
    const { desdeS, hastaS, rango } = rangoDe(req);
    const out = await conReintento(async () => {
      const db = await getDb();
      const elegidos = await rubrosConfigurados(db, req);
      if (!elegidos.length) return [];
      const { filtroUsr } = await resolverAlcance(db, req);
      const filas = await db.collection('ventas').aggregate([
        { $match: Object.assign({}, filtroOrg(req), filtroUsr, { estado: { $ne: 'anulada' }, createdAt: rango }) },
        { $unwind: '$items' },
        { $lookup: { from: 'productos_catalogo', localField: 'items.productoId', foreignField: '_id', as: 'prod' } },
        { $addFields: { rubro: { $ifNull: [{ $arrayElemAt: ['$prod.rubro', 0] }, ''] } } },
        { $match: { rubro: { $in: elegidos } } },
        { $group: { _id: '$rubro', unidades: { $sum: '$items.cantidad' } } }
      ]).toArray();
      const mapa = {}; filas.forEach(f => { mapa[f._id] = Math.round(f.unidades * 100) / 100; });
      return elegidos.map(r => ({ rubro: r, unidades: mapa[r] || 0 }));
    });
    res.json({ desde: desdeS, hasta: hastaS, rubros: out });
  } catch (e) { responder(res, e); }
});

// Rubros disponibles + los elegidos. Editar: solo administrador (rol protegido).
router.get('/rubros-config', authTablero, async (req, res) => {
  try {
    const r = await conReintento(async () => {
      const db = await getDb();
      const org = filtroOrg(req);
      const [base, usados, elegidos] = await Promise.all([
        db.collection('productos_rubros_base').find(org).project({ nombre: 1 }).toArray(),
        db.collection('productos_catalogo').distinct('rubro', Object.assign({ activo: { $ne: false }, rubro: { $nin: [null, ''] } }, org)),
        rubrosConfigurados(db, req)
      ]);
      const set = new Set([...base.map(b => b.nombre), ...usados, ...elegidos].filter(Boolean));
      return { elegidos, disponibles: [...set].sort((a, b) => a.localeCompare(b, 'es')) };
    });
    res.json(Object.assign(r, { puedeEditar: !!req.usuario.rol.protegido }));
  } catch (e) { responder(res, e); }
});

router.put('/rubros-config', authTablero, async (req, res) => {
  try {
    if (!req.usuario.rol.protegido) throw err(403, 'Solo un administrador puede elegir los rubros del tablero.');
    const lista = Array.isArray(req.body && req.body.rubros) ? req.body.rubros : null;
    if (!lista) throw err(400, 'Falta la lista de rubros.');
    const rubros = [...new Set(lista.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 30);
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('tablero_config').updateOne(
        Object.assign({ clave: 'rubros' }, filtroOrg(req)),
        { $set: { rubros, updatedAt: new Date(), updatedBy: req.usuario._id } },
        { upsert: true }
      );
    });
    res.json({ elegidos: rubros });
  } catch (e) { responder(res, e); }
});

module.exports = router;
