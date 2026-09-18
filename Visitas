// ---------------------------------------------------------------------------
// Visitas — módulo adicional para la app "Calculadora m2".
//
// Cubre el tramo del flujo que va ANTES de obras.js: la empleada del local
// carga una visita y se la asigna a un vendedor con horario, el vendedor va
// al domicilio, saca fotos y arma un presupuesto (con el cotizador ya
// existente, o cargándolo a mano si le resulta más rápido) y, cuando el
// cliente confirma, se genera la Obra automáticamente en la colección
// "obras" que ya usa obras.js — con el colocador todavía sin asignar, listo
// para que oficina lo asigne desde el panel de obras.
//
// Mismo patrón que obras.js/normalizador.js: conexión Mongo propia a la
// MISMA base "calculadora_m2", mismo reintento ante "Topology is closed",
// se monta como router independiente. Nuevas colecciones:
//   - visitas_vendedores     : lista simple de vendedores (sin login)
//   - visitas                : una visita por documento (cliente, vendedor,
//                              horario, fotos, presupuesto, estado)
//   - visitas_mapeo_tipo_obra: qué tipo(s) de trabajo (catálogo de obras.js)
//                              le corresponden a cada tipo de obra del
//                              cotizador, para armar las tareas solas
//   - visitas_counters       : correlativo del número de visita
//
// Reutiliza el cotizador ya existente (cotizador.js) SIN modificarlo: lee
// directamente sus colecciones "cotizaciones" y "tipos_obra" (misma base),
// y la vista del vendedor simplemente abre /cotizador.html en una pestaña
// nueva con la tienda y los datos del cliente precargados por query string.
// La función de fotos es aparte del simulador de piso del cotizador, tal
// como se definió: no se integra, solo hay un botón que lleva de una a otra.
//
// Integración (en server.js):
//   const visitasRouter = require('./visitas');
//   app.use('/api/visitas', visitasRouter);
// public/admin-visitas.html y public/vendedor.html quedan servidos solos
// por el express.static(public) que server.js ya tiene.
//
// Variables de entorno (además de las que ya usa obras.js):
//   OBRAS_ADMIN_PASSWORD  -> se reutiliza la misma del panel de obras
//   TIENDA_REAL_STORE_ID  -> store_id (numérico, tal como lo devuelve
//                            /api/stores) de la tienda real de Piedra Negra
//                            en Tiendanube. Se usa para abrir el cotizador
//                            ya en esa tienda y para leer sus tipos de obra.
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const router = express.Router();
// El body-parser ya lo agrega server.js globalmente (express.json({limit:'15mb'})),
// con margen de sobra para las fotos en base64 — mismo patrón que normalizador.js.

const DB_NAME = 'calculadora_m2';
const MAX_FOTOS = 12;

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (err) {
      mongoClient = null;
      throw err;
    }
  }
  return mongoClient.db(DB_NAME);
}

async function conReintento(fn) {
  try {
    return await fn();
  } catch (err) {
    mongoClient = null; // fuerza reconexion, mismo patron que obras.js/normalizador.js
    return await fn();
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function toObjectId(id) {
  try { return new ObjectId(id); } catch (e) { return null; }
}

function err(status, message) {
  return Object.assign(new Error(message), { status });
}

async function siguienteNumeroVisita() {
  return conReintento(async () => {
    const db = await getDb();
    const r = await db.collection('visitas_counters').findOneAndUpdate(
      { _id: 'visita_numero' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return r.value ? r.value.seq : r.seq; // compat con distintas versiones del driver
  });
}

async function siguienteNumeroObra() {
  // Duplicado a propósito: es el mismo correlativo que usa obras.js, sobre
  // el mismo contador "obra_numero" en obras_counters, para que los números
  // de obra sigan siendo consecutivos sin importar si se creó a mano desde
  // el panel de obras o automáticamente desde una visita confirmada.
  return conReintento(async () => {
    const db = await getDb();
    const r = await db.collection('obras_counters').findOneAndUpdate(
      { _id: 'obra_numero' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return r.value ? r.value.seq : r.seq;
  });
}

function authAdmin(req, res, next) {
  const pass = process.env.OBRAS_ADMIN_PASSWORD;
  const token = req.headers['x-admin-token'];
  if (!pass) return res.status(500).json({ error: 'OBRAS_ADMIN_PASSWORD no está configurada en el servidor' });
  if (token !== pass) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// Campos del objeto "obra" de una cotización (ver cotizador.js) que pueden
// traducirse a una tarea de obras.js. La cantidad de cada uno queda como
// m2Presupuestados de la tarea (aunque para zócalos sea ml, no m2 — mismo
// campo que ya usa obras.js para cualquier unidad).
const CAMPOS_OBRA_COTIZADOR = ['m2Pisos', 'mlZocalos', 'cantidadPuertas'];

// Config pública mínima que necesita la vista del vendedor (no expone nada
// sensible: solo el store_id de la tienda real, para armar el link al
// cotizador y para consultar su historial de cotizaciones).
router.get('/config', (req, res) => {
  res.json({ storeId: process.env.TIENDA_REAL_STORE_ID || null });
});

// ---------------------------------------------------------------------
// LOGIN (misma contraseña que el panel de obras)
// ---------------------------------------------------------------------

router.post('/login', (req, res) => {
  const { password } = req.body || {};
  const pass = process.env.OBRAS_ADMIN_PASSWORD;
  if (!pass) return res.status(500).json({ error: 'OBRAS_ADMIN_PASSWORD no está configurada en el servidor' });
  if (password !== pass) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({ ok: true, token: pass });
});

// ---------------------------------------------------------------------
// VENDEDORES
// ---------------------------------------------------------------------

// Lista pública (sin login): el vendedor se identifica eligiéndose acá.
router.get('/vendedores/publico', async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas_vendedores')
        .find({ activo: { $ne: false } })
        .project({ nombre: 1 })
        .sort({ nombre: 1 })
        .toArray();
    });
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/vendedores', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas_vendedores').find({}).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/vendedores', authAdmin, async (req, res) => {
  try {
    const { nombre, telefono } = req.body || {};
    if (!nombre) throw err(400, 'Nombre obligatorio');
    const doc = { nombre, telefono: telefono || '', activo: true, createdAt: new Date() };
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const r = await db.collection('visitas_vendedores').insertOne(doc);
      return { ...doc, _id: r.insertedId };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/vendedores/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { nombre, telefono, activo } = req.body || {};
    const set = {};
    if (nombre !== undefined) set.nombre = nombre;
    if (telefono !== undefined) set.telefono = telefono;
    if (activo !== undefined) set.activo = activo;
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      await db.collection('visitas_vendedores').updateOne({ _id: id }, { $set: set });
      return db.collection('visitas_vendedores').findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// CATÁLOGOS (lectura, para armar formularios en los paneles)
// ---------------------------------------------------------------------

// Tipos de obra del cotizador, de la tienda real — para elegir a qué
// tipo de obra le corresponde qué tipo(s) de trabajo (mapeo).
router.get('/catalogo/tipos-obra', authAdmin, async (req, res) => {
  try {
    const storeId = process.env.TIENDA_REAL_STORE_ID;
    if (!storeId) throw err(500, 'TIENDA_REAL_STORE_ID no está configurada en el servidor');
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('tipos_obra').find({ store_id: storeId }).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Tipos de trabajo del panel de obras (obras.js) — catálogo de destino del mapeo
// y de lo que elige el vendedor cuando presupuesta a mano.
router.get('/catalogo/tipos-trabajo', async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras_tipos_trabajo').find({ activo: { $ne: false } }).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// MAPEO: tipo de obra (cotizador) -> tipo(s) de trabajo (colocador)
// ---------------------------------------------------------------------

router.get('/mapeo', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas_mapeo_tipo_obra').find({}).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crea o reemplaza el mapeo de un tipo de obra (upsert por tipoObraId).
// reglas: [{ campoObra: 'm2Pisos'|'mlZocalos'|'cantidadPuertas', tipoTrabajo }]
router.post('/mapeo', authAdmin, async (req, res) => {
  try {
    const { tipoObraId, tipoObraNombre, reglas } = req.body || {};
    if (!tipoObraId) throw err(400, 'Falta tipoObraId');
    if (!Array.isArray(reglas) || !reglas.length) throw err(400, 'Definí al menos una regla');
    for (const r of reglas) {
      if (!CAMPOS_OBRA_COTIZADOR.includes(r.campoObra)) throw err(400, `campoObra inválido: ${r.campoObra}`);
      if (!r.tipoTrabajo) throw err(400, 'Cada regla necesita un tipo de trabajo');
    }
    const doc = {
      tipoObraId: String(tipoObraId),
      tipoObraNombre: tipoObraNombre || '',
      reglas: reglas.map(r => ({ campoObra: r.campoObra, tipoTrabajo: r.tipoTrabajo })),
      updatedAt: new Date()
    };
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const col = db.collection('visitas_mapeo_tipo_obra');
      await col.updateOne({ tipoObraId: doc.tipoObraId }, { $set: doc }, { upsert: true });
      return col.findOne({ tipoObraId: doc.tipoObraId });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/mapeo/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('visitas_mapeo_tipo_obra').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// ADMIN (empleada / oficina): VISITAS Y AGENDA
// ---------------------------------------------------------------------

function proyeccionVisitaLista() {
  return { numero: 1, cliente: 1, vendedorId: 1, vendedorNombre: 1, fechaHora: 1, estado: 1, obraId: 1 };
}

router.get('/', authAdmin, async (req, res) => {
  try {
    const { vendedorId, estado, desde, hasta, q } = req.query;
    const match = {};
    if (vendedorId) match.vendedorId = toObjectId(vendedorId);
    if (estado) match.estado = estado;
    if (q) match['cliente.nombre'] = { $regex: q, $options: 'i' };
    if (desde || hasta) {
      match.fechaHora = {};
      if (desde) match.fechaHora.$gte = new Date(desde);
      if (hasta) match.fechaHora.$lte = new Date(hasta.length <= 10 ? hasta + 'T23:59:59' : hasta);
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas').find(match).sort({ fechaHora: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agenda: visitas ya agendadas en un rango, para no pisar turnos al crear
// una nueva. Si se pasa vendedorId, solo las de ese vendedor.
router.get('/agenda', authAdmin, async (req, res) => {
  try {
    const { vendedorId, desde, hasta } = req.query;
    const match = { estado: { $ne: 'cancelada' } };
    if (vendedorId) match.vendedorId = toObjectId(vendedorId);
    if (desde || hasta) {
      match.fechaHora = {};
      if (desde) match.fechaHora.$gte = new Date(desde);
      if (hasta) match.fechaHora.$lte = new Date(hasta.length <= 10 ? hasta + 'T23:59:59' : hasta);
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas').find(match).project(proyeccionVisitaLista()).sort({ fechaHora: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const visita = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas').findOne({ _id: id });
    });
    if (!visita) throw err(404, 'Visita no encontrada');
    res.json(visita);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    const { cliente, vendedorId, fechaHora, notasEmpleada } = req.body || {};
    if (!cliente || !cliente.nombre) throw err(400, 'Falta el nombre del cliente');
    if (!cliente.direccion) throw err(400, 'Falta el domicilio de la visita');
    if (!vendedorId) throw err(400, 'Falta asignar un vendedor');
    if (!fechaHora) throw err(400, 'Falta la fecha y hora de la visita');
    const vId = toObjectId(vendedorId);
    if (!vId) throw err(400, 'vendedorId inválido');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const vendedor = await db.collection('visitas_vendedores').findOne({ _id: vId });
      if (!vendedor) throw err(400, 'Vendedor no encontrado');
      const numero = await siguienteNumeroVisita();
      const doc = {
        numero,
        cliente: {
          nombre: cliente.nombre,
          telefono: cliente.telefono || '',
          direccion: cliente.direccion,
          localidad: cliente.localidad || ''
        },
        vendedorId: vId,
        vendedorNombre: vendedor.nombre,
        fechaHora: new Date(fechaHora),
        notasEmpleada: notasEmpleada || '',
        estado: 'agendada',
        fotos: [],
        presupuesto: null,
        obraId: null,
        confirmadaPor: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const r = await db.collection('visitas').insertOne(doc);
      doc._id = r.insertedId;
      return doc;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { cliente, vendedorId, fechaHora, notasEmpleada, estado } = req.body || {};
    const set = { updatedAt: new Date() };
    if (cliente) set.cliente = cliente;
    if (fechaHora) set.fechaHora = new Date(fechaHora);
    if (notasEmpleada !== undefined) set.notasEmpleada = notasEmpleada;
    if (estado) {
      if (!['agendada', 'presupuestada', 'confirmada', 'cancelada'].includes(estado)) throw err(400, 'Estado inválido');
      set.estado = estado;
    }
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      if (vendedorId) {
        const vId = toObjectId(vendedorId);
        const vendedor = await db.collection('visitas_vendedores').findOne({ _id: vId });
        if (!vendedor) throw err(400, 'Vendedor no encontrado');
        set.vendedorId = vId;
        set.vendedorNombre = vendedor.nombre;
      }
      await db.collection('visitas').updateOne({ _id: id }, { $set: set });
      return db.collection('visitas').findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Confirmación desde oficina (cuando el cliente llama al local más tarde).
router.post('/:id/confirmar', authAdmin, async (req, res) => {
  try {
    const resultado = await confirmarVisita(req.params.id, 'oficina');
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// VENDEDOR (mobile, sin login — se identifica eligiéndose de la lista)
// ---------------------------------------------------------------------

// Valida que la visita exista y pertenezca al vendedor indicado.
async function visitaDelVendedor(db, visitaIdStr, vendedorIdStr) {
  const visitaId = toObjectId(visitaIdStr);
  const vendedorId = toObjectId(vendedorIdStr);
  if (!visitaId || !vendedorId) throw err(400, 'id inválido');
  const visita = await db.collection('visitas').findOne({ _id: visitaId });
  if (!visita) throw err(404, 'Visita no encontrada');
  if (String(visita.vendedorId) !== String(vendedorId)) throw err(403, 'Esta visita no está asignada a este vendedor');
  return visita;
}

router.get('/vendedor/:vendedorId/visitas', async (req, res) => {
  try {
    const vId = toObjectId(req.params.vendedorId);
    if (!vId) throw err(400, 'vendedorId inválido');
    const { desde, hasta } = req.query;
    const match = { vendedorId: vId, estado: { $ne: 'cancelada' } };
    match.fechaHora = {};
    match.fechaHora.$gte = desde ? new Date(desde) : new Date(new Date().setHours(0, 0, 0, 0));
    if (hasta) match.fechaHora.$lte = new Date(hasta.length <= 10 ? hasta + 'T23:59:59' : hasta);
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas').find(match).sort({ fechaHora: 1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/vendedor/:vendedorId/visitas/:id', async (req, res) => {
  try {
    const visita = await conReintento(async () => {
      const db = await getDb();
      return visitaDelVendedor(db, req.params.id, req.params.vendedorId);
    });
    res.json(visita);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Agrega fotos del lugar (base64 data URLs), función propia de la visita,
// separada del simulador de piso con IA del cotizador.
router.post('/vendedor/:vendedorId/visitas/:id/fotos', async (req, res) => {
  try {
    const { fotos } = req.body || {};
    if (!Array.isArray(fotos) || !fotos.length) throw err(400, 'No llegaron fotos');
    const nuevas = fotos
      .filter(f => typeof f === 'string' && f.indexOf('data:image/') === 0)
      .map(f => ({ data: f, fecha: new Date() }));
    if (!nuevas.length) throw err(400, 'Formato de foto inválido');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      const totales = (visita.fotos || []).concat(nuevas).slice(0, MAX_FOTOS);
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: { fotos: totales, updatedAt: new Date() } });
      return totales;
    });
    res.json({ fotos: resultado });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/vendedor/:vendedorId/visitas/:id/fotos/:index', async (req, res) => {
  try {
    const idx = Number(req.params.index);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      const fotos = (visita.fotos || []).filter((_, i) => i !== idx);
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: { fotos, updatedAt: new Date() } });
      return fotos;
    });
    res.json({ fotos: resultado });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Presupuesto cargado a mano, sin pasar por el cotizador.
// items: [{ tipoTrabajo, m2, precioCliente }]
router.post('/vendedor/:vendedorId/visitas/:id/presupuesto-manual', async (req, res) => {
  try {
    const { items, notas } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw err(400, 'Agregá al menos un tipo de trabajo');
    for (const it of items) {
      if (!it.tipoTrabajo) throw err(400, 'Falta el tipo de trabajo en un ítem');
      if (!(Number(it.m2) > 0)) throw err(400, `Ingresá los m² de "${it.tipoTrabajo}"`);
    }
    const itemsFinales = items.map(it => ({
      tipoTrabajo: it.tipoTrabajo,
      m2: Number(it.m2),
      precioCliente: Number(it.precioCliente) || 0
    }));
    const total = itemsFinales.reduce((s, it) => s + it.precioCliente, 0);
    const presupuesto = { tipo: 'manual', items: itemsFinales, total, notas: notas || '', fecha: new Date() };

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      const set = { presupuesto, updatedAt: new Date() };
      if (visita.estado === 'agendada') set.estado = 'presupuestada';
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: set });
      return db.collection('visitas').findOne({ _id: visita._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Presupuesto armado con el cotizador ya existente: el vendedor lo guarda
// ahí (con el botón "Abrir cotizador") y acá solo se engancha por id a la
// visita — no se duplica ni se recalcula nada de cotizador.js.
router.post('/vendedor/:vendedorId/visitas/:id/presupuesto-cotizador', async (req, res) => {
  try {
    const { cotizacionId, storeId } = req.body || {};
    if (!cotizacionId || !storeId) throw err(400, 'Falta cotizacionId o storeId');
    const cotId = toObjectId(cotizacionId);
    if (!cotId) throw err(400, 'cotizacionId inválido');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      const cot = await db.collection('cotizaciones').findOne({ _id: cotId, store_id: String(storeId) });
      if (!cot) throw err(404, 'No se encontró esa cotización en el cotizador');

      const presupuesto = {
        tipo: 'cotizador',
        cotizacionId: cot._id,
        storeId: String(storeId),
        tipoObraId: cot.tipoObraId,
        tipoObraNombre: cot.tipoObraNombre,
        total: cot.total,
        fecha: new Date()
      };
      const set = { presupuesto, updatedAt: new Date() };
      if (visita.estado === 'agendada') set.estado = 'presupuestada';
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: set });
      return db.collection('visitas').findOne({ _id: visita._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Confirmación en el momento, por el vendedor.
router.post('/vendedor/:vendedorId/visitas/:id/confirmar', async (req, res) => {
  try {
    await conReintento(async () => {
      const db = await getDb();
      await visitaDelVendedor(db, req.params.id, req.params.vendedorId); // valida pertenencia
    });
    const resultado = await confirmarVisita(req.params.id, 'vendedor');
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Confirmación de visita -> genera la Obra automáticamente
// ---------------------------------------------------------------------

// A partir del presupuesto.obra de una cotización, arma las tareas usando
// el mapeo tipo de obra -> tipo(s) de trabajo definido en el panel.
async function tareasDesdeMapeo(db, presupuesto) {
  const mapeo = await db.collection('visitas_mapeo_tipo_obra').findOne({ tipoObraId: String(presupuesto.tipoObraId) });
  if (!mapeo) {
    throw err(400, `Definí el mapeo de tipos de trabajo para "${presupuesto.tipoObraNombre || presupuesto.tipoObraId}" antes de confirmar (panel de Visitas → Mapeo).`);
  }
  const cot = await db.collection('cotizaciones').findOne({ _id: presupuesto.cotizacionId });
  const obraCot = (cot && cot.obra) || {};
  const tareas = mapeo.reglas
    .filter(r => Number(obraCot[r.campoObra]) > 0)
    .map(r => ({ tipoTrabajo: r.tipoTrabajo, m2Presupuestados: Number(obraCot[r.campoObra]) }));
  if (!tareas.length) {
    throw err(400, 'La cotización no tiene cantidades que coincidan con el mapeo definido para este tipo de obra.');
  }
  return tareas;
}

function tareasDesdeManual(presupuesto) {
  return presupuesto.items.map(it => ({ tipoTrabajo: it.tipoTrabajo, m2Presupuestados: it.m2 }));
}

async function confirmarVisita(visitaIdStr, confirmadaPor) {
  const visitaId = toObjectId(visitaIdStr);
  if (!visitaId) throw err(400, 'id inválido');

  return conReintento(async () => {
    const db = await getDb();
    const visita = await db.collection('visitas').findOne({ _id: visitaId });
    if (!visita) throw err(404, 'Visita no encontrada');
    if (visita.estado === 'confirmada') throw err(400, 'Esta visita ya fue confirmada');
    if (visita.estado === 'cancelada') throw err(400, 'Esta visita está cancelada');
    if (!visita.presupuesto) throw err(400, 'Todavía no se cargó el presupuesto de esta visita');

    const tareasBase = visita.presupuesto.tipo === 'cotizador'
      ? await tareasDesdeMapeo(db, visita.presupuesto)
      : tareasDesdeManual(visita.presupuesto);

    const tareas = tareasBase.map(t => ({
      _id: new ObjectId(),
      tipoTrabajo: t.tipoTrabajo,
      m2Presupuestados: Number(t.m2Presupuestados) || 0,
      colocadorId: null,
      costoPorM2Aplicado: null,
      estado: 'pendiente',
      fechaInicio: null,
      fechaFinEstimada: null,
      fechaFinReal: null,
      m2Realizados: 0,
      notas: '',
      avances: []
    }));

    const numero = await siguienteNumeroObra();
    const obraDoc = {
      numero,
      cliente: {
        nombre: visita.cliente.nombre,
        telefono: visita.cliente.telefono || '',
        direccion: visita.cliente.direccion || '',
        localidad: visita.cliente.localidad || ''
      },
      fechaVenta: new Date(),
      vendedor: visita.vendedorNombre || '',
      estado: 'pendiente',
      tareas,
      notasGenerales: visita.notasEmpleada || '',
      fotos: visita.fotos || [],
      visitaId: visita._id,
      origenPresupuesto: visita.presupuesto.tipo,
      precioVentaCliente: visita.presupuesto.total || 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const r = await db.collection('obras').insertOne(obraDoc);
    obraDoc._id = r.insertedId;

    await db.collection('visitas').updateOne(
      { _id: visita._id },
      { $set: { estado: 'confirmada', obraId: r.insertedId, confirmadaPor, updatedAt: new Date() } }
    );

    return { visita: await db.collection('visitas').findOne({ _id: visita._id }), obra: obraDoc };
  });
}

module.exports = router;
