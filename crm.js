// ---------------------------------------------------------------------------
// CRM — seguimiento de oportunidades, ANTES de que exista una Visita.
//
// Cubre el tramo del embudo que va ANTES de visitas.js: contactos/consultas
// que todavía no se convirtieron en una visita concreta — se cargan acá con
// sus datos de contacto y una próxima acción (rellamar, recontactar, etc.)
// para no perderles el rastro. Cuando el cliente está listo, se la "asigna
// visita" desde acá mismo: arma una Visita nueva (reusando crearVisita() de
// visitas.js, sin duplicar esa lógica) y la oportunidad queda marcada
// "convertida", con el link a esa visita — de ahí en más sigue el flujo
// normal (Visita → Presupuesto → Obra) sin tocar nada de este archivo.
//
// Mismo patrón que visitas.js/obras.js: conexión Mongo propia a la MISMA
// base "calculadora_m2", mismo reintento ante "Topology is closed", se monta
// como router independiente. Colecciones nuevas:
//   - oportunidades : { numero, cliente: {nombre, telefono, email, direccion,
//                        localidad}, origen, vendedorId, vendedorNombre,
//                        notas, proximaAccion: {fecha, tipo, nota} | null,
//                        estado ('activa'|'convertida'|'descartada'),
//                        visitaId, motivoDescarte, createdAt, updatedAt }
//   - crm_counters   : correlativo del número de oportunidad
//
// Acceso: mismo módulo que Visitas ('visitas') — quien ya puede cargar
// visitas, puede cargar oportunidades (decisión tomada con Mato: no hace
// falta una clave de módulo nueva para esto). Vive como una pestaña más
// dentro de public/admin-visitas.html (Panel de Visitas), no como una
// pantalla aparte.
//
// Integración (en server.js):
//   const crmRouter = require('./crm');
//   app.use('/api/crm', crmRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo } = require('./usuarios');
const { crearVisita } = require('./visitas');

const router = express.Router();

const DB_NAME = 'calculadora_m2';

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (e) {
      mongoClient = null;
      throw e;
    }
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    mongoClient = null; // fuerza reconexión, mismo patrón que visitas.js/obras.js
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------
// Estados de una oportunidad.
//   activa      -> en seguimiento, todavía no se convirtió en visita
//   convertida  -> se le asignó una visita (ver visitaId) y sigue el flujo
//                  normal de visitas.js de ahí en más
//   descartada  -> no prosperó (no contesta, se bajó, etc.) — se conserva el
//                  registro con el motivo, no se borra
// ---------------------------------------------------------------------
const ESTADOS_VALIDOS = ['activa', 'convertida', 'descartada'];
const TIPOS_PROXIMA_ACCION_VALIDOS = ['rellamar', 'recontactar', 'enviar_info', 'otro'];

async function siguienteNumeroOportunidad() {
  return conReintento(async () => {
    const db = await getDb();
    const r = await db.collection('crm_counters').findOneAndUpdate(
      { _id: 'oportunidad_numero' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return r.value ? r.value.seq : r.seq; // compat con distintas versiones del driver
  });
}

// Se reusa el módulo 'visitas' existente en vez de sumar una clave de
// módulo nueva — decisión tomada con Mato: el CRM lo ve el mismo equipo
// que ya carga visitas.
const authAdmin = [authUsuario, requiereModulo('visitas')];

function normalizarProximaAccion(pa) {
  if (!pa || !pa.fecha) return null;
  // El <input type="date"> del panel manda "YYYY-MM-DD", sin hora ni zona.
  // Igual que parsearFechaHoraLocal en visitas.js: si se interpreta tal
  // cual, new Date(...) la toma como medianoche UTC, que en Argentina
  // (UTC-3) ya es el día anterior a las 21hs — la fecha se mostraría
  // corrida un día para atrás. Se fuerza medianoche en Argentina en vez de
  // UTC (el país no tiene horario de verano, el offset es siempre -03:00).
  const s = String(pa.fecha).trim();
  const yaTieneZona = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  const fecha = new Date(yaTieneZona ? s : s + 'T00:00:00-03:00');
  if (isNaN(fecha.getTime())) throw err(400, 'La fecha de próxima acción no es válida.');
  const tipo = TIPOS_PROXIMA_ACCION_VALIDOS.includes(pa.tipo) ? pa.tipo : 'otro';
  return { fecha, tipo, nota: pa.nota || '' };
}

function normalizarCliente(cliente, { requerirContacto } = {}) {
  if (!cliente || !cliente.nombre) throw err(400, 'Falta el nombre del cliente');
  if (requerirContacto && !cliente.telefono && !cliente.email) {
    throw err(400, 'Cargá al menos un teléfono o un email de contacto.');
  }
  return {
    nombre: cliente.nombre,
    telefono: cliente.telefono || '',
    email: cliente.email || '',
    direccion: cliente.direccion || '',
    localidad: cliente.localidad || ''
  };
}

// ---------------------------------------------------------------------
// Listado / detalle
// ---------------------------------------------------------------------

router.get('/', authAdmin, async (req, res) => {
  try {
    const { vendedorId, estado, q } = req.query;
    const match = {};
    if (vendedorId) match.vendedorId = toObjectId(vendedorId);
    if (estado) {
      if (!ESTADOS_VALIDOS.includes(estado)) throw err(400, 'Estado inválido');
      match.estado = estado;
    }
    if (q) {
      const rx = { $regex: escapeRegex(q), $options: 'i' };
      match.$or = [{ 'cliente.nombre': rx }, { 'cliente.telefono': rx }, { 'cliente.email': rx }];
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('oportunidades').find(match).sort({ createdAt: -1 }).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('oportunidades').findOne({ _id: id });
    });
    if (!doc) throw err(404, 'Oportunidad no encontrada');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Alta / edición
// ---------------------------------------------------------------------

router.post('/', authAdmin, async (req, res) => {
  try {
    const { cliente, vendedorId, notas, proximaAccion, origen } = req.body || {};
    const clienteNorm = normalizarCliente(cliente, { requerirContacto: true });
    const vId = vendedorId ? toObjectId(vendedorId) : null;
    if (vendedorId && !vId) throw err(400, 'vendedorId inválido');
    const proximaAccionNorm = normalizarProximaAccion(proximaAccion);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      let vendedorNombre = '';
      if (vId) {
        const vendedor = await db.collection('visitas_vendedores').findOne({ _id: vId });
        if (!vendedor) throw err(400, 'Vendedor no encontrado');
        vendedorNombre = vendedor.nombre;
      }
      const numero = await siguienteNumeroOportunidad();
      const doc = {
        numero,
        cliente: clienteNorm,
        origen: (origen || '').trim(),
        vendedorId: vId,
        vendedorNombre,
        notas: notas || '',
        proximaAccion: proximaAccionNorm,
        estado: 'activa',
        visitaId: null,
        motivoDescarte: '',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const r = await db.collection('oportunidades').insertOne(doc);
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
    const { cliente, vendedorId, notas, proximaAccion, origen } = req.body || {};

    const set = { updatedAt: new Date() };
    if (cliente) set.cliente = normalizarCliente(cliente, { requerirContacto: false });
    if (origen !== undefined) set.origen = String(origen || '').trim();
    if (notas !== undefined) set.notas = notas || '';
    if (proximaAccion !== undefined) set.proximaAccion = normalizarProximaAccion(proximaAccion);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('oportunidades').findOne({ _id: id });
      if (!actual) throw err(404, 'Oportunidad no encontrada');

      if (vendedorId !== undefined) {
        if (vendedorId) {
          const vId = toObjectId(vendedorId);
          if (!vId) throw err(400, 'vendedorId inválido');
          const vendedor = await db.collection('visitas_vendedores').findOne({ _id: vId });
          if (!vendedor) throw err(400, 'Vendedor no encontrado');
          set.vendedorId = vId;
          set.vendedorNombre = vendedor.nombre;
        } else {
          set.vendedorId = null;
          set.vendedorNombre = '';
        }
      }

      await db.collection('oportunidades').updateOne({ _id: id }, { $set: set });
      return db.collection('oportunidades').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/:id/descartar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const motivo = (req.body && req.body.motivo) || '';
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('oportunidades').findOne({ _id: id });
      if (!actual) throw err(404, 'Oportunidad no encontrada');
      if (actual.estado === 'convertida') throw err(400, 'Esta oportunidad ya se convirtió en visita, no se puede descartar.');
      await db.collection('oportunidades').updateOne(
        { _id: id },
        { $set: { estado: 'descartada', motivoDescarte: motivo, updatedAt: new Date() } }
      );
      return db.collection('oportunidades').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/:id/reactivar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('oportunidades').findOne({ _id: id });
      if (!actual) throw err(404, 'Oportunidad no encontrada');
      if (actual.estado !== 'descartada') throw err(400, 'Esta oportunidad no está descartada.');
      await db.collection('oportunidades').updateOne(
        { _id: id },
        { $set: { estado: 'activa', motivoDescarte: '', updatedAt: new Date() } }
      );
      return db.collection('oportunidades').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Conversión a Visita
// ---------------------------------------------------------------------

// Reusa crearVisita() de visitas.js (misma validación, mismo alta en
// Google Calendar) en vez de duplicar esa lógica acá. Precarga el cliente
// desde la oportunidad; pide vendedor y fecha/hora porque una Visita
// siempre los necesita, y domicilio si todavía no se había cargado en esta
// etapa (a esta altura del embudo puede que solo hubiera teléfono/email).
router.post('/:id/asignar-visita', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { vendedorId, fechaHora, notasEmpleada, direccion, localidad } = req.body || {};

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const oportunidad = await db.collection('oportunidades').findOne({ _id: id });
      if (!oportunidad) throw err(404, 'Oportunidad no encontrada');
      if (oportunidad.estado === 'convertida') throw err(400, 'Esta oportunidad ya se convirtió en visita.');

      const direccionFinal = String(direccion || oportunidad.cliente.direccion || '').trim();
      if (!direccionFinal) throw err(400, 'Falta el domicilio para poder agendar la visita.');
      const localidadFinal = (localidad !== undefined ? localidad : oportunidad.cliente.localidad) || '';

      const clienteParaVisita = Object.assign({}, oportunidad.cliente, {
        direccion: direccionFinal,
        localidad: localidadFinal
      });
      const vendedorIdFinal = vendedorId || (oportunidad.vendedorId ? String(oportunidad.vendedorId) : '');

      // crearVisita() valida cliente/vendedor/fecha y tira su propio error
      // (con .status) si algo falta — se deja propagar tal cual.
      const visita = await crearVisita({
        cliente: clienteParaVisita,
        vendedorId: vendedorIdFinal,
        fechaHora,
        notasEmpleada: notasEmpleada || oportunidad.notas || ''
      });

      await db.collection('oportunidades').updateOne(
        { _id: id },
        {
          $set: {
            estado: 'convertida',
            visitaId: visita._id,
            'cliente.direccion': direccionFinal,
            'cliente.localidad': localidadFinal,
            updatedAt: new Date()
          }
        }
      );
      return visita;
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
