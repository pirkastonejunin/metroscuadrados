// --------------------------------------------------------------------------
// Gestión de Obras — módulo adicional para la app "Calculadora m2".
//
// Se monta como router Express dentro del server.js existente, siguiendo el
// mismo patrón que normalizador.js: lee la MISMA base Mongo Atlas (db
// "calculadora_m2") que ya usa la app, con su propia conexión (mismo patrón
// de reconexión ante "Topology is closed" que ya usan server.js/cotizador.js/
// normalizador.js), y agrega sus propias colecciones:
//   - obras_colocadores   : un documento por colocador (nombre, PIN de acceso
//                           mobile, costo por m2 para cada tipo de trabajo)
//   - obras_tipos_trabajo : catálogo de tipos de trabajo (colocación de
//                           piedras, placas, pisos, etc.)
//   - obras               : una obra por documento (cliente, tareas —cada
//                           tarea con su colocador asignado, m2 presupuestados,
//                           estado (pendiente/en_curso/terminada), materiales
//                           a llevar y observaciones)
//   - obras_counters      : solo guarda el correlativo del número de obra
//
// Integración (en server.js):
//   const obrasRouter = require('./obras');
//   app.use('/api/obras', obrasRouter);
// Los archivos public/admin-obras.html y public/colocador.html ya quedan
// servidos solos por el express.static(public) que server.js ya tiene.
//
// Variables de entorno nuevas (agregar en Render):
//   OBRAS_ADMIN_PASSWORD  -> contraseña simple para el panel de oficina
//   OBRAS_TOKEN_SECRET    -> string largo y random, para firmar la sesión
//                            de los colocadores en el celular
// ---------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const googleCalendar = require('./google-calendar');

const router = express.Router();
// El body-parser ya lo agrega server.js globalmente (express.json({limit:'15mb'})),
// mismo patrón que normalizador.js — no hace falta repetirlo acá.

const DB_NAME = 'calculadora_m2';

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
    mongoClient = null; // fuerza reconexion, mismo patron que server.js/normalizador.js
    return await fn();
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function toObjectId(id) {
  try { return new ObjectId(id); } catch (e) { return null; }
}

async function siguienteNumeroObra() {
  return conReintento(async () => {
    const db = await getDb();
    const r = await db.collection('obras_counters').findOneAndUpdate(
      { _id: 'obra_numero' },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return r.value ? r.value.seq : r.seq; // compat con distintas versiones del driver
  });
}

function hmac(data) {
  const secret = process.env.OBRAS_TOKEN_SECRET || 'cambiar-este-secreto';
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function crearTokenColocador(colocadorId) {
  const payload = `${colocadorId}.${Date.now()}`;
  const firma = hmac(payload);
  return Buffer.from(payload).toString('base64') + '.' + firma;
}

function verificarTokenColocador(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, idx);
  const firma = token.slice(idx + 1);
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64').toString('utf8'); } catch (e) { return null; }
  if (hmac(payload) !== firma) return null;
  const [colocadorId, issuedAtStr] = payload.split('.');
  const issuedAt = Number(issuedAtStr);
  if (!colocadorId || !issuedAt) return null;
  const CIENTO_OCHENTA_DIAS_MS = 180 * 24 * 60 * 60 * 1000;
  if (Date.now() - issuedAt > CIENTO_OCHENTA_DIAS_MS) return null; // token vencido
  return colocadorId;
}

function authAdmin(req, res, next) {
  const pass = process.env.OBRAS_ADMIN_PASSWORD;
  const token = req.headers['x-admin-token'];
  if (!pass) return res.status(500).json({ error: 'OBRAS_ADMIN_PASSWORD no está configurada en el servidor' });
  if (token !== pass) return res.status(401).json({ error: 'No autorizado' });
  next();
}

async function authColocador(req, res, next) {
  const token = req.headers['x-colocador-token'];
  const colocadorId = verificarTokenColocador(token);
  if (!colocadorId) return res.status(401).json({ error: 'Sesión inválida o vencida, iniciá sesión de nuevo' });
  const colocador = await conReintento(async () => {
    const db = await getDb();
    return db.collection('obras_colocadores').findOne({ _id: toObjectId(colocadorId), activo: { $ne: false } });
  });
  if (!colocador) return res.status(401).json({ error: 'Colocador no encontrado o inactivo' });
  req.colocador = colocador;
  next();
}

const ESTADOS_TAREA_VALIDOS = ['pendiente', 'en_curso', 'terminada'];
// Estado general de la obra (distinto del estado por tarea, de arriba).
// "asignado" se agrega para poder marcar que ya se le asignó colocador
// aunque todavía no arrancó ninguna tarea.
const ESTADOS_OBRA_VALIDOS = ['pendiente', 'asignado', 'en_curso', 'terminada', 'cancelada'];
// Estados de obra que cuentan como "en curso" para el panel del colocador y
// para el listado principal de Obras (todo lo que no sea terminada/cancelada).
const ESTADOS_OBRA_NO_EN_CURSO = ['terminada', 'cancelada'];
const MAX_FOTOS_OBRA = 20; // combinadas: fotos "antes" (vendedor) + "después" (colocador)

// Busca el costo por m2 vigente de un colocador para un tipo de trabajo dado
function costoVigente(colocador, tipoTrabajo) {
  const c = (colocador.costos || []).find(x => x.tipoTrabajo === tipoTrabajo);
  return c ? c.costoPorM2 : null;
}

// Lista de productos que el colocador debe llevar a la obra: [{tipo, cantidad}].
// "cantidad" queda como texto libre (no todos los materiales se miden igual:
// "10 cajas", "2 bolsas de 25kg", "8", etc.) — se descartan las filas sin tipo.
function normalizarMateriales(materiales) {
  if (!Array.isArray(materiales)) return [];
  return materiales
    .map(m => ({ tipo: String((m && m.tipo) || '').trim(), cantidad: String((m && m.cantidad) || '').trim() }))
    .filter(m => m.tipo);
}

// Sincroniza (o borra) el evento de Google Calendar de la OBRA — uno solo
// para toda la obra, no uno por producto: la obra se maneja como una sola
// aunque tenga varios productos adentro, y desde el panel el colocador se
// asigna igual para todos los productos a la vez, así que en la práctica
// todas las tareas de una obra comparten colocador (se toma el de la
// primera tarea que tenga uno asignado). El evento va al calendario propio
// del colocador (obras_colocadores.googleCalendarId) si lo tiene cargado;
// si no, cae al calendario general de respaldo (GOOGLE_CALENDAR_ID) — ver
// google-calendar.js. Solo tiene sentido armar el evento cuando hay
// colocador asignado Y fecha de inicio de obra (los dos datos mínimos para
// que sirva para planificar) y la obra no está cancelada; si falta algo de
// eso, se elimina el evento si existía. Modifica `obra` in place (le
// actualiza `googleEventId`/`googleCalendarId`); quien llama es
// responsable de persistir esos dos campos.
async function sincronizarCalendarDeObra(db, obra) {
  const tareaConColocador = (obra.tareas || []).find(t => t.colocadorId);
  const colocadorId = tareaConColocador ? tareaConColocador.colocadorId : null;

  if (!colocadorId || !obra.fechaInicio || obra.estado === 'cancelada') {
    if (obra.googleEventId) {
      await googleCalendar.eliminarEvento(obra.googleEventId, obra.googleCalendarId);
    }
    obra.googleEventId = null;
    obra.googleCalendarId = null;
    return;
  }

  let colocador = null;
  try {
    colocador = await db.collection('obras_colocadores').findOne({ _id: colocadorId });
  } catch (e) { /* si falla la búsqueda, seguimos con nombre vacío y sin calendario propio */ }
  const colocadorNombre = colocador ? colocador.nombre : '';
  const calendarIdDestino = (colocador && colocador.googleCalendarId) || process.env.GOOGLE_CALENDAR_ID || null;
  if (!calendarIdDestino) return; // ni el colocador ni el general están configurados: no hay dónde sincronizar

  // Si el colocador (y por lo tanto el calendario destino) cambió respecto
  // al evento que ya existía, no alcanza con "actualizar" — google-calendar.js
  // no mueve eventos entre calendarios, así que se borra del viejo y se
  // crea de nuevo en el nuevo.
  if (obra.googleEventId && obra.googleCalendarId && obra.googleCalendarId !== calendarIdDestino) {
    await googleCalendar.eliminarEvento(obra.googleEventId, obra.googleCalendarId);
    obra.googleEventId = null;
  }

  const productos = (obra.tareas || []).map(t => `${t.tipoTrabajo} (${t.m2Presupuestados} m²)`).join(', ');
  const inicio = obra.fechaInicio;
  const fin = new Date(new Date(obra.fechaInicio).getTime() + 24 * 60 * 60 * 1000); // día completo

  obra.googleEventId = await googleCalendar.upsertEvento(obra.googleEventId, {
    titulo: `Obra #${obra.numero} — ${colocadorNombre || 'sin colocador'}`,
    descripcion: [
      `Cliente: ${obra.cliente.nombre}`,
      `Colocador: ${colocadorNombre || '-'}`,
      `Productos: ${productos}`,
      obra.notasColocador ? `Notas: ${obra.notasColocador}` : null
    ].filter(Boolean).join('\n'),
    ubicacion: obra.cliente.direccion || '',
    inicio,
    fin
  }, calendarIdDestino);
  obra.googleCalendarId = calendarIdDestino;
}

// El estado de una obra se maneja como uno solo, aunque tenga varios
// productos/tareas adentro (pedido de Mato) — pero por dentro se sigue
// guardando el estado de cada tarea, porque el reporte de m²/comisiones
// (más abajo) se calcula sobre tarea.estado === 'terminada'. Esta función
// traduce el estado general de la obra al estado que le corresponde a cada
// tarea, para no tener que tocarlas una por una nunca más.
function estadoTareaParaObra(estadoObra) {
  if (estadoObra === 'en_curso') return 'en_curso';
  if (estadoObra === 'terminada') return 'terminada';
  if (estadoObra === 'pendiente' || estadoObra === 'asignado') return 'pendiente';
  return null; // "cancelada": no se toca el progreso ya cargado de las tareas
}

// Aplica esa traducción a TODAS las tareas de la obra (muta `obra.tareas` in
// place). Quien llama es responsable de persistir `obra.tareas` actualizado
// (y de llamar a sincronizarCalendarDeObra aparte si corresponde — el
// calendario ya no es por tarea, ver más arriba).
async function sincronizarTareasConEstadoObra(db, obra) {
  const estadoTarea = estadoTareaParaObra(obra.estado);
  if (!estadoTarea) return;
  const ahora = new Date();
  for (const tarea of (obra.tareas || [])) {
    tarea.estado = estadoTarea;
    if (estadoTarea === 'en_curso' && !tarea.fechaInicio) tarea.fechaInicio = ahora;
    if (estadoTarea === 'terminada') {
      if (!tarea.fechaInicio) tarea.fechaInicio = ahora;
      if (!tarea.fechaFinReal) tarea.fechaFinReal = ahora;
    }
  }
}

// ---------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------

// Login admin (oficina)
router.post('/login', (req, res) => {
  const { password } = req.body || {};
  const pass = process.env.OBRAS_ADMIN_PASSWORD;
  if (!pass) return res.status(500).json({ error: 'OBRAS_ADMIN_PASSWORD no está configurada en el servidor' });
  if (password !== pass) return res.status(401).json({ error: 'Contraseña incorrecta' });
  res.json({ ok: true, token: pass });
});

// Login colocador (PIN de 4-6 dígitos)
router.post('/colocador/login', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ error: 'Ingresá tu PIN' });
    const colocador = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras_colocadores').findOne({ pin: String(pin), activo: { $ne: false } });
    });
    if (!colocador) return res.status(401).json({ error: 'PIN incorrecto' });
    const token = crearTokenColocador(colocador._id.toString());
    res.json({ ok: true, token, colocador: { id: colocador._id, nombre: colocador.nombre } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// ADMIN: COLOCADORES
// ---------------------------------------------------------------------

router.get('/colocadores', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras_colocadores').find({}).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/colocadores', authAdmin, async (req, res) => {
  try {
    const { nombre, telefono, pin, costos, googleCalendarId } = req.body || {};
    if (!nombre || !pin) return res.status(400).json({ error: 'Nombre y PIN son obligatorios' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const col = db.collection('obras_colocadores');
      const existePin = await col.findOne({ pin: String(pin) });
      if (existePin) throw Object.assign(new Error('Ese PIN ya está en uso por otro colocador'), { status: 400 });
      const doc = {
        nombre, telefono: telefono || '', pin: String(pin),
        costos: Array.isArray(costos) ? costos : [],
        // Calendario de Google propio de este colocador, para que sus obras
        // le lleguen ahí (ver google-calendar.js) — opcional, si lo deja
        // vacío las obras que se le asignen caen al calendario general de
        // respaldo (si hay uno configurado).
        googleCalendarId: googleCalendarId || '',
        activo: true,
        createdAt: new Date(), updatedAt: new Date()
      };
      const r = await col.insertOne(doc);
      return { ...doc, _id: r.insertedId };
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/colocadores/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const { nombre, telefono, pin, costos, activo, googleCalendarId } = req.body || {};
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      const col = db.collection('obras_colocadores');
      if (pin) {
        const existePin = await col.findOne({ pin: String(pin), _id: { $ne: id } });
        if (existePin) throw Object.assign(new Error('Ese PIN ya está en uso por otro colocador'), { status: 400 });
      }
      const set = { updatedAt: new Date() };
      if (nombre !== undefined) set.nombre = nombre;
      if (telefono !== undefined) set.telefono = telefono;
      if (pin !== undefined) set.pin = String(pin);
      if (Array.isArray(costos)) set.costos = costos;
      if (activo !== undefined) set.activo = activo;
      if (googleCalendarId !== undefined) set.googleCalendarId = googleCalendarId;
      await col.updateOne({ _id: id }, { $set: set });
      return col.findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Da de alta el calendario de Google de este colocador: crea un calendario
// nuevo (lo administra la cuenta de servicio) y lo comparte automáticamente
// con su mail de Google — no hace falta entrar a Google Calendar a mano.
// A partir de ahí sus obras se sincronizan solas.
router.post('/colocadores/:id/calendario', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const email = (req.body && req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Falta el mail de la cuenta de Google del colocador' });
    if (!googleCalendar.habilitado()) return res.status(400).json({ error: 'Google Calendar no está configurado en el servidor (falta GOOGLE_SERVICE_ACCOUNT_KEY)' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const colocador = await db.collection('obras_colocadores').findOne({ _id: id });
      if (!colocador) throw Object.assign(new Error('Colocador no encontrado'), { status: 404 });
      const calendarId = await googleCalendar.crearCalendarioParaPersona(`Obras — ${colocador.nombre}`, email);
      if (!calendarId) throw Object.assign(new Error('No se pudo crear el calendario en Google (revisá los logs del servidor)'), { status: 500 });
      await db.collection('obras_colocadores').updateOne({ _id: id }, { $set: { googleCalendarId: calendarId, googleAccountEmail: email } });
      return db.collection('obras_colocadores').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Da de baja el calendario de este colocador: deja de usarlo para sus
// próximas obras (caen al calendario general de respaldo, si hay uno). No
// borra el calendario de Google en sí, para no perder el historial ya
// sincronizado ahí.
router.delete('/colocadores/:id/calendario', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      await db.collection('obras_colocadores').updateOne({ _id: id }, { $set: { googleCalendarId: '', googleAccountEmail: '' } });
      return db.collection('obras_colocadores').findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.delete('/colocadores/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    // No se borra físicamente (hay historial de obras con este id): se desactiva.
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('obras_colocadores').updateOne({ _id: id }, { $set: { activo: false, updatedAt: new Date() } });
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------
// ADMIN: TIPOS DE TRABAJO
// ---------------------------------------------------------------------

router.get('/tipos-trabajo', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras_tipos_trabajo').find({}).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tipos-trabajo', authAdmin, async (req, res) => {
  try {
    const { nombre } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'Nombre obligatorio' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const col = db.collection('obras_tipos_trabajo');
      const existe = await col.findOne({ nombre });
      if (existe) throw Object.assign(new Error('Ese tipo de trabajo ya existe'), { status: 400 });
      const doc = { nombre, activo: true, createdAt: new Date() };
      const r = await col.insertOne(doc);
      return { ...doc, _id: r.insertedId };
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/tipos-trabajo/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const { nombre, activo } = req.body || {};
    const set = {};
    if (nombre !== undefined) set.nombre = nombre;
    if (activo !== undefined) set.activo = activo;
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('obras_tipos_trabajo').updateOne({ _id: id }, { $set: set });
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tipos-trabajo/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('obras_tipos_trabajo').updateOne({ _id: id }, { $set: { activo: false } });
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------
// ADMIN: OBRAS
// ---------------------------------------------------------------------

// Listado con filtros: estado, colocadorId, texto de búsqueda (cliente).
// excluirEstado=X excluye ese estado (sin filtrar por uno específico) — lo
// usa el panel principal de Obras para no listar las obras terminadas, que
// pasaron a mostrarse aparte en el panel de Historial.
router.get('/', authAdmin, async (req, res) => {
  try {
    const { estado, excluirEstado, colocadorId, q } = req.query;
    const match = {};
    if (estado) match.estado = estado;
    else if (excluirEstado) match.estado = { $ne: excluirEstado };
    if (colocadorId) match['tareas.colocadorId'] = toObjectId(colocadorId);
    if (q) match['cliente.nombre'] = { $regex: q, $options: 'i' };
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras').find(match).sort({ numero: -1 }).toArray();
    });
    res.json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const obra = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras').findOne({ _id: id });
    });
    if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });
    res.json(obra);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear obra (al vender). tareas: [{tipoTrabajo, m2Presupuestados}]
router.post('/', authAdmin, async (req, res) => {
  try {
    const { cliente, fechaVenta, vendedor, tareas, notasGenerales } = req.body || {};
    if (!cliente || !cliente.nombre) return res.status(400).json({ error: 'Falta el nombre del cliente' });
    const numero = await siguienteNumeroObra();
    const tareasDoc = (Array.isArray(tareas) ? tareas : []).map(t => ({
      _id: new ObjectId(),
      tipoTrabajo: t.tipoTrabajo,
      m2Presupuestados: Number(t.m2Presupuestados) || 0,
      colocadorId: null,
      costoPorM2Aplicado: null,
      estado: 'pendiente', // pendiente -> en_curso -> terminada (se sincroniza solo con el estado general de la obra)
      fechaInicio: null,
      fechaFinEstimada: t.fechaFinEstimada ? new Date(t.fechaFinEstimada) : null,
      fechaFinReal: null,
      materiales: normalizarMateriales(t.materiales) // productos que el colocador debe llevar: [{tipo, cantidad}]
    }));
    const doc = {
      numero,
      cliente: {
        nombre: cliente.nombre,
        telefono: cliente.telefono || '',
        direccion: cliente.direccion || '',
        localidad: cliente.localidad || ''
      },
      fechaVenta: fechaVenta ? new Date(fechaVenta) : new Date(),
      vendedor: vendedor || '',
      estado: 'pendiente',
      fechaInicio: null, // fecha de inicio de la obra completa (una sola, no por producto)
      notasColocador: '', // aclaraciones de oficina para el colocador (una sola, para toda la obra)
      notasAsesor: '', // notas/observaciones para el asesor (ej: algo que quedó pendiente) — una sola, para toda la obra
      tareas: tareasDoc,
      notasGenerales: notasGenerales || '',
      // Evento de Google Calendar de la obra (uno solo, no por producto — ver
      // sincronizarCalendarDeObra) y el calendario donde vive.
      googleEventId: null,
      googleCalendarId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await conReintento(async () => {
      const db = await getDb();
      const r = await db.collection('obras').insertOne(doc);
      doc._id = r.insertedId;
    });
    res.json(doc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const { cliente, fechaVenta, vendedor, notasGenerales, estado, fechaInicio, notasColocador, notasAsesor } = req.body || {};
    if (estado && !ESTADOS_OBRA_VALIDOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    const actualizado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne({ _id: id });
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });

      const set = { updatedAt: new Date() };
      if (cliente) set.cliente = cliente;
      if (fechaVenta) set.fechaVenta = new Date(fechaVenta);
      if (vendedor !== undefined) set.vendedor = vendedor;
      if (notasGenerales !== undefined) set.notasGenerales = notasGenerales;
      if (notasColocador !== undefined) set.notasColocador = notasColocador;
      if (notasAsesor !== undefined) set.notasAsesor = notasAsesor;
      if (fechaInicio !== undefined) set.fechaInicio = fechaInicio ? new Date(fechaInicio) : null;

      if (estado) {
        set.estado = estado;
        // Si entra en curso y todavía no tiene fecha de inicio (y no vino una
        // fecha explícita en este mismo pedido), se la asigna sola.
        if (estado === 'en_curso' && fechaInicio === undefined && !obra.fechaInicio) set.fechaInicio = new Date();
        // La obra se maneja como una sola aunque tenga varios productos
        // adentro: al cambiar su estado general, se sincroniza el de todas
        // sus tareas para que los reportes de m²/comisiones sigan andando.
        const obraConNuevoEstado = { ...obra, estado, fechaInicio: set.fechaInicio !== undefined ? set.fechaInicio : obra.fechaInicio };
        await sincronizarTareasConEstadoObra(db, obraConNuevoEstado);
        set.tareas = obraConNuevoEstado.tareas;
      }

      // El evento de Calendar de la obra depende de estado/fechaInicio/
      // notasColocador (título, fecha y descripción) — se resincroniza si
      // se tocó alguno de los tres.
      if (estado !== undefined || fechaInicio !== undefined || notasColocador !== undefined) {
        const obraEfectiva = { ...obra, ...set };
        await sincronizarCalendarDeObra(db, obraEfectiva);
        set.googleEventId = obraEfectiva.googleEventId;
        set.googleCalendarId = obraEfectiva.googleCalendarId;
      }

      await db.collection('obras').updateOne({ _id: id }, { $set: set });
      return db.collection('obras').findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Agregar tarea a una obra existente. Arranca con el estado que le
// corresponda según el estado general de la obra (si la obra ya está en
// curso o terminada, el producto nuevo entra directo en ese mismo estado,
// para no dejarlo desincronizado).
router.post('/:id/tareas', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const { tipoTrabajo, m2Presupuestados, fechaFinEstimada, materiales } = req.body || {};
    if (!tipoTrabajo) return res.status(400).json({ error: 'Falta el tipo de trabajo' });

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne({ _id: id });
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      const estadoInicial = estadoTareaParaObra(obra.estado) || 'pendiente';
      const ahora = new Date();
      const nuevaTarea = {
        _id: new ObjectId(),
        tipoTrabajo,
        m2Presupuestados: Number(m2Presupuestados) || 0,
        colocadorId: null,
        costoPorM2Aplicado: null,
        estado: estadoInicial,
        fechaInicio: (estadoInicial === 'en_curso' || estadoInicial === 'terminada') ? ahora : null,
        fechaFinEstimada: fechaFinEstimada ? new Date(fechaFinEstimada) : null,
        fechaFinReal: estadoInicial === 'terminada' ? ahora : null,
        materiales: normalizarMateriales(materiales)
      };

      // El producto nuevo entra en la lista que arma la descripción del
      // evento de la obra (si ya tenía uno) — se resincroniza.
      const obraConNuevaTarea = { ...obra, tareas: [...(obra.tareas || []), nuevaTarea] };
      await sincronizarCalendarDeObra(db, obraConNuevaTarea);

      await db.collection('obras').updateOne({ _id: id }, {
        $push: { tareas: nuevaTarea },
        $set: {
          updatedAt: new Date(),
          googleEventId: obraConNuevaTarea.googleEventId,
          googleCalendarId: obraConNuevaTarea.googleCalendarId
        }
      });
      return nuevaTarea;
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Editar una tarea: cambiar m2 presupuestados, fecha fin estimada, materiales
// o el colocador asignado (aunque en la práctica el colocador se asigna a
// toda la obra de una vez, ver asignarColocadorObra en admin-obras.html).
router.put('/:obraId/tareas/:tareaId', authAdmin, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    const tareaId = toObjectId(req.params.tareaId);
    if (!obraId || !tareaId) return res.status(400).json({ error: 'id inválido' });

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne({ _id: obraId });
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      const tarea = (obra.tareas || []).find(t => String(t._id) === String(tareaId));
      if (!tarea) throw Object.assign(new Error('Tarea no encontrada'), { status: 404 });

      const { colocadorId, m2Presupuestados, fechaFinEstimada, estado, materiales } = req.body || {};

      if (colocadorId !== undefined) {
        if (colocadorId === null) {
          tarea.colocadorId = null;
          tarea.costoPorM2Aplicado = null;
        } else {
          const cId = toObjectId(colocadorId);
          const colocador = await db.collection('obras_colocadores').findOne({ _id: cId });
          if (!colocador) throw Object.assign(new Error('Colocador no encontrado'), { status: 400 });
          const costo = costoVigente(colocador, tarea.tipoTrabajo);
          if (costo === null) {
            throw Object.assign(new Error(`${colocador.nombre} no tiene definido un costo por m² para "${tarea.tipoTrabajo}". Cargalo primero en la ficha del colocador.`), { status: 400 });
          }
          tarea.colocadorId = cId;
          tarea.costoPorM2Aplicado = costo;
        }
      }
      if (m2Presupuestados !== undefined) tarea.m2Presupuestados = Number(m2Presupuestados) || 0;
      if (fechaFinEstimada !== undefined) tarea.fechaFinEstimada = fechaFinEstimada ? new Date(fechaFinEstimada) : null;
      if (materiales !== undefined) tarea.materiales = normalizarMateriales(materiales);
      if (estado !== undefined) {
        if (!ESTADOS_TAREA_VALIDOS.includes(estado)) throw Object.assign(new Error('Estado inválido'), { status: 400 });
        tarea.estado = estado;
        if (estado === 'en_curso' && !tarea.fechaInicio) tarea.fechaInicio = new Date();
        if (estado === 'terminada' && !tarea.fechaFinReal) tarea.fechaFinReal = new Date();
      }

      // El colocador (y por lo tanto el destino del evento de la obra) puede
      // haber cambiado acá — `tarea` es la misma referencia que ya está
      // adentro de obra.tareas, así que obra ya refleja el cambio.
      await sincronizarCalendarDeObra(db, obra);

      await db.collection('obras').updateOne(
        { _id: obraId, 'tareas._id': tareaId },
        {
          $set: {
            'tareas.$': tarea,
            updatedAt: new Date(),
            googleEventId: obra.googleEventId,
            googleCalendarId: obra.googleCalendarId
          }
        }
      );
      return tarea;
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.delete('/:obraId/tareas/:tareaId', authAdmin, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    const tareaId = toObjectId(req.params.tareaId);
    if (!obraId || !tareaId) return res.status(400).json({ error: 'id inválido' });
    await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne({ _id: obraId });
      if (!obra) return;
      // Se saca el producto ANTES de resincronizar: si era el único con
      // colocador asignado, el evento de la obra tiene que borrarse; si no,
      // al menos hay que sacarlo de la lista de productos de la descripción.
      obra.tareas = (obra.tareas || []).filter(t => String(t._id) !== String(tareaId));
      await sincronizarCalendarDeObra(db, obra);
      await db.collection('obras').updateOne({ _id: obraId }, {
        $pull: { tareas: { _id: tareaId } },
        $set: { updatedAt: new Date(), googleEventId: obra.googleEventId, googleCalendarId: obra.googleCalendarId }
      });
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------
// COLOCADOR (acceso mobile con PIN)
// ---------------------------------------------------------------------

// ?historial=1 trae las obras YA TERMINADAS de este colocador (para el
// panel "Historial" de colocador.html); sin ese parámetro trae solo las que
// todavía tiene en curso (ni terminadas ni canceladas), que es la pantalla
// principal — así no se le acumulan para siempre las obras ya cerradas.
router.get('/colocador/mis-obras', authColocador, async (req, res) => {
  try {
    const colocadorId = req.colocador._id;
    const historial = req.query.historial === '1' || req.query.historial === 'true';
    const obras = await conReintento(async () => {
      const db = await getDb();
      const match = { 'tareas.colocadorId': colocadorId };
      match.estado = historial ? 'terminada' : { $nin: ESTADOS_OBRA_NO_EN_CURSO };
      return db.collection('obras').find(match).sort({ numero: -1 }).toArray();
    });
    // Devolvemos solo las tareas de este colocador, junto con los datos de la obra/cliente
    const resultado = obras.map(o => ({
      obraId: o._id,
      numero: o.numero,
      cliente: o.cliente,
      estado: o.estado,
      notasColocador: o.notasColocador || '', // aclaraciones de oficina, para toda la obra
      fotos: o.fotos || [], // heredadas de la visita ("antes") + las que suba este colocador ("después")
      tareas: (o.tareas || []).filter(t => t.colocadorId && String(t.colocadorId) === String(colocadorId))
    })).filter(o => o.tareas.length > 0);
    res.json(resultado);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Marca la OBRA ENTERA (no un producto suelto) como en curso o terminada —
// se maneja como una sola obra aunque tenga varios productos adentro. Al
// terminar, puede mandar una observación (ej: "quedó pendiente colocar el
// zócalo del pasillo, faltó material") que queda como notas para el asesor.
router.post('/colocador/obras/:obraId/estado', authColocador, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    if (!obraId) return res.status(400).json({ error: 'id inválido' });
    const { estado, observaciones } = req.body || {};
    if (!['en_curso', 'terminada'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne({ _id: obraId });
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      const tieneTarea = (obra.tareas || []).some(t => String(t.colocadorId) === String(req.colocador._id));
      if (!tieneTarea) throw Object.assign(new Error('Esta obra no está asignada a tu usuario'), { status: 403 });

      const set = { estado, updatedAt: new Date() };
      if (estado === 'en_curso' && !obra.fechaInicio) set.fechaInicio = new Date();
      if (observaciones !== undefined) set.notasAsesor = observaciones;

      const obraConNuevoEstado = { ...obra, estado, fechaInicio: set.fechaInicio !== undefined ? set.fechaInicio : obra.fechaInicio };
      await sincronizarTareasConEstadoObra(db, obraConNuevoEstado);
      set.tareas = obraConNuevoEstado.tareas;

      await sincronizarCalendarDeObra(db, obraConNuevoEstado);
      set.googleEventId = obraConNuevoEstado.googleEventId;
      set.googleCalendarId = obraConNuevoEstado.googleCalendarId;

      await db.collection('obras').updateOne({ _id: obraId }, { $set: set });
      return db.collection('obras').findOne({ _id: obraId });
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Fotos del trabajo terminado, sacadas por el colocador — quedan en el mismo
// arreglo obra.fotos que las "antes" heredadas de la visita (sacadas por el
// vendedor), etiquetadas con origen para poder separarlas en el panel.
router.post('/colocador/obras/:obraId/fotos', authColocador, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    if (!obraId) return res.status(400).json({ error: 'id inválido' });
    const { fotos } = req.body || {};
    if (!Array.isArray(fotos) || !fotos.length) return res.status(400).json({ error: 'No llegaron fotos' });
    const nuevas = fotos
      .filter(f => typeof f === 'string' && f.indexOf('data:image/') === 0)
      .map(f => ({ data: f, fecha: new Date(), origen: 'colocador', colocadorNombre: req.colocador.nombre }));
    if (!nuevas.length) return res.status(400).json({ error: 'Formato de foto inválido' });

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne({ _id: obraId });
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      const tienenTarea = (obra.tareas || []).some(t => String(t.colocadorId) === String(req.colocador._id));
      if (!tienenTarea) throw Object.assign(new Error('Esta obra no está asignada a tu usuario'), { status: 403 });
      const totales = (obra.fotos || []).concat(nuevas).slice(0, MAX_FOTOS_OBRA);
      await db.collection('obras').updateOne({ _id: obraId }, { $set: { fotos: totales, updatedAt: new Date() } });
      return totales;
    });
    res.json({ fotos: resultado });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------
// REPORTES
// ---------------------------------------------------------------------

// Metros presupuestados y monto a pagar, agrupado por colocador + tipo de
// trabajo, filtrable por rango de fechas y por colocador/tipo específico.
// La comisión se paga sobre el 100% de los m² presupuestados de cada tarea
// una vez que queda "Terminada" (ya no hay carga de avances parciales).
router.get('/reportes/m2', authAdmin, async (req, res) => {
  try {
    const { desde, hasta, colocadorId, tipoTrabajo } = req.query;

    const match = { 'tareas.colocadorId': { $ne: null }, 'tareas.estado': 'terminada' };
    if (desde || hasta) {
      match['tareas.fechaFinReal'] = {};
      if (desde) match['tareas.fechaFinReal'].$gte = new Date(desde);
      if (hasta) match['tareas.fechaFinReal'].$lte = new Date(hasta + 'T23:59:59');
    }
    if (colocadorId) match['tareas.colocadorId'] = toObjectId(colocadorId);
    if (tipoTrabajo) match['tareas.tipoTrabajo'] = tipoTrabajo;

    const pipeline = [
      { $unwind: '$tareas' },
      { $match: match },
      {
        $group: {
          _id: { colocadorId: '$tareas.colocadorId', tipoTrabajo: '$tareas.tipoTrabajo' },
          m2Total: { $sum: '$tareas.m2Presupuestados' },
          montoTotal: { $sum: { $multiply: ['$tareas.m2Presupuestados', { $ifNull: ['$tareas.costoPorM2Aplicado', 0] }] } }
        }
      }
    ];

    const { filas, nombrePorId } = await conReintento(async () => {
      const db = await getDb();
      const filas = await db.collection('obras').aggregate(pipeline).toArray();
      const colocadorIds = [...new Set(filas.map(f => String(f._id.colocadorId)))].map(toObjectId);
      const colocadores = await db.collection('obras_colocadores').find({ _id: { $in: colocadorIds } }).toArray();
      const nombrePorId = Object.fromEntries(colocadores.map(c => [String(c._id), c.nombre]));
      return { filas, nombrePorId };
    });

    const resultado = filas.map(f => ({
      colocadorId: f._id.colocadorId,
      colocador: nombrePorId[String(f._id.colocadorId)] || '(desconocido)',
      tipoTrabajo: f._id.tipoTrabajo,
      m2Total: Math.round(f.m2Total * 100) / 100,
      montoTotal: Math.round(f.montoTotal * 100) / 100
    })).sort((a, b) => a.colocador.localeCompare(b.colocador) || a.tipoTrabajo.localeCompare(b.tipoTrabajo));

    res.json(resultado);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// La exportación a CSV se arma en el navegador (panel de administración) a partir
// del JSON de /reportes/m2, para no duplicar la lógica de agregación acá.

module.exports = router;
