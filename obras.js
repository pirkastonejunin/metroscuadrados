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
const { buscarClienteUnico } = require('./clienteVinculo');
const { authUsuario, requiereModulo, tieneModulo, resolverOrg, filtroOrg, filtroOrgClientes, backfillOrgId } = require('./usuarios');

const router = express.Router();
// El body-parser ya lo agrega server.js globalmente (express.json({limit:'15mb'})),
// mismo patrón que normalizador.js — no hace falta repetirlo acá.

const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    // Carrera de conexión (4/10/2026, ver compras.js): se guarda la
    // conexión EN CURSO para que los requests simultáneos de un proceso
    // recién arrancado esperen la misma, en vez de usar un cliente que
    // todavía no terminó de conectar.
    if (!mongoConectando) {
      const nuevoCliente = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevoCliente.connect().then(
        () => { mongoClient = nuevoCliente; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
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

// Antes: función local que comparaba contra una única contraseña compartida
// (OBRAS_ADMIN_PASSWORD). Ahora: usuarios y roles configurables — ver
// usuarios.js. authUsuario valida el token de sesión y carga req.usuario
// (con su rol); requiereModulo('obras') exige que ese rol tenga acceso al
// módulo de Obras. Como Express aplana arrays de middlewares, ningún otro
// lugar de este archivo que usa `authAdmin` necesita cambios.
const authAdmin = [authUsuario, resolverOrg, requiereModulo('obras')];

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

// Deja pasar a un colocador real (token PIN, como siempre) o a una cuenta de
// oficina/admin con acceso al módulo Obras — así el rol protegido
// (Administrador) puede entrar a "Mis obras" (colocador.html) y operar
// exactamente igual que un colocador, pero viendo/marcando TODAS las obras
// de todos los colocadores en vez de solo las propias. req.esAdminObras
// marca cuál de los dos casos es, para que las rutas de abajo sepan si
// tienen que filtrar por un colocador puntual o no.
async function authColocadorOAdmin(req, res, next) {
  if (req.headers['x-colocador-token']) return authColocador(req, res, next);
  return authUsuario(req, res, () => {
    if (!tieneModulo(req.usuario, 'obras')) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso al módulo de Obras.' });
    }
    req.esAdminObras = true;
    resolverOrg(req, res, next);
  });
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
// El login de oficina ahora vive en /api/usuarios/login (ver usuarios.js).

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
      await backfillOrgId(db, 'obras_colocadores');
      return db.collection('obras_colocadores').find(filtroOrg(req)).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/colocadores', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Elegí con qué organización estás trabajando antes de crear un colocador.' });
    const { nombre, telefono, pin, costos, googleCalendarId } = req.body || {};
    if (!nombre || !pin) return res.status(400).json({ error: 'Nombre y PIN son obligatorios' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const col = db.collection('obras_colocadores');
      // El PIN es único en TODO el sistema, no solo dentro de la
      // organización — así el login por PIN (sin elegir organización) no
      // tiene ambigüedad posible entre franquicias.
      const existePin = await col.findOne({ pin: String(pin) });
      if (existePin) throw Object.assign(new Error('Ese PIN ya está en uso por otro colocador'), { status: 400 });
      const doc = {
        nombre, telefono: telefono || '', pin: String(pin),
        orgId: req.orgId,
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
// Las obras que ya tenían colocador y fecha de inicio asignados ANTES de
// que ese colocador tuviera calendario propio se quedaron sin evento
// (sincronizarCalendarDeObra solo se dispara cuando algo de la obra
// cambia — ver PUT /:id, agregar/editar/borrar tarea, cambio de estado —
// no cuando lo que cambia es el calendario del colocador). Al dar de alta
// su calendario, se recorren sus obras activas y se sincroniza cada una.
async function resincronizarObrasDelColocador(db, colocadorId) {
  const obras = await db.collection('obras').find({
    'tareas.colocadorId': colocadorId,
    estado: { $ne: 'cancelada' }
  }).toArray();
  for (const obra of obras) {
    await sincronizarCalendarDeObra(db, obra);
    await db.collection('obras').updateOne({ _id: obra._id }, { $set: { googleEventId: obra.googleEventId, googleCalendarId: obra.googleCalendarId, updatedAt: new Date() } });
  }
}

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
      await resincronizarObrasDelColocador(db, id);
      return db.collection('obras_colocadores').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Fuerza una resincronización del calendario YA configurado de este
// colocador (sin crear uno nuevo): sirve para obras que quedaron sin
// evento porque ya tenían colocador y fecha de inicio asignados antes de
// que ese colocador tuviera calendario propio.
router.post('/colocadores/:id/calendario/resincronizar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const colocador = await db.collection('obras_colocadores').findOne({ _id: id });
      if (!colocador) throw Object.assign(new Error('Colocador no encontrado'), { status: 404 });
      if (!colocador.googleCalendarId) throw Object.assign(new Error('Este colocador todavía no tiene calendario propio configurado'), { status: 400 });
      await resincronizarObrasDelColocador(db, id);
      return { ok: true };
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
    const match = Object.assign({}, filtroOrg(req));
    if (estado) match.estado = estado;
    else if (excluirEstado) match.estado = { $ne: excluirEstado };
    if (colocadorId) match['tareas.colocadorId'] = toObjectId(colocadorId);
    if (q) match['cliente.nombre'] = { $regex: q, $options: 'i' };
    const lista = await conReintento(async () => {
      const db = await getDb();
      await backfillOrgId(db, 'obras');
      return db.collection('obras').find(match).sort({ numero: -1 }).toArray();
    });
    res.json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Búsqueda de productos del catálogo para armar el presupuesto de materiales de una obra.
router.get('/materiales/buscar', authAdmin, async (req, res) => {
  try {
    const palabras = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!palabras.length) return res.json([]);
    const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req), {
      $and: palabras.map(p => { const re = new RegExp(esc(p), 'i'); return { $or: [{ sku: re }, { nombre: re }] }; })
    });
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('productos_catalogo').find(match, { projection: { sku: 1, nombre: 1, costo: 1, moneda: 1, unidad: 1 } }).sort({ nombre: 1 }).limit(15).toArray();
    });
    res.json(lista);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Presupuesto de mano de obra de la obra: un solo total (se compara contra lo cargado en Sueldos → trabajos especiales
// y la colocación por m²). monto 0 / vacío = sin presupuesto.
router.put('/:id/presupuesto-mano-obra', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const monto = Number((req.body || {}).monto) || 0;
    if (monto < 0) return res.status(400).json({ error: 'El monto no puede ser negativo' });
    const r = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras').updateOne(Object.assign({ _id: id }, filtroOrg(req)), { $set: { presupuestoManoObra: Math.round(monto * 100) / 100, updatedAt: new Date() } });
    });
    if (!r.matchedCount) return res.status(404).json({ error: 'Obra no encontrada' });
    res.json({ ok: true, monto });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Presupuesto de materiales de la obra (lista de productos con cantidad y costo unitario estimado), para compararlo
// después contra las facturas de compra imputadas a la obra (ver /:id/rentabilidad).
router.put('/:id/presupuesto-materiales', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const crudo = Array.isArray((req.body || {}).items) ? req.body.items : null;
    if (!crudo) return res.status(400).json({ error: 'Falta la lista de materiales' });
    if (crudo.length > 500) return res.status(400).json({ error: 'Máximo 500 líneas' });
    const items = [];
    for (const it of crudo) {
      const nombre = String(it.nombre || '').trim().slice(0, 200);
      const cantidad = Number(it.cantidad), costoUnitario = Number(it.costoUnitario) || 0;
      if (!nombre) return res.status(400).json({ error: 'Hay una línea sin nombre de producto' });
      if (!(cantidad > 0)) return res.status(400).json({ error: `La cantidad de "${nombre}" tiene que ser mayor a 0` });
      if (costoUnitario < 0) return res.status(400).json({ error: `El costo de "${nombre}" no puede ser negativo` });
      items.push({ productoId: it.productoId ? toObjectId(it.productoId) : null, sku: String(it.sku || '').trim().slice(0, 60) || null, nombre, cantidad, costoUnitario });
    }
    const r = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras').updateOne(Object.assign({ _id: id }, filtroOrg(req)), { $set: { presupuestoMateriales: items, updatedAt: new Date() } });
    });
    if (!r.matchedCount) return res.status(404).json({ error: 'Obra no encontrada' });
    res.json({ ok: true, items: items.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const obra = await conReintento(async () => {
      const db = await getDb();
      return db.collection('obras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    });
    if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });
    res.json(obra);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rentabilidad de la obra: lo presupuestado/vendido menos lo que costó (facturas de compra imputadas a la obra
// + mano de obra de colocadores). Las facturas cuentan por su total con IVA, en pesos; la tabla de materiales por producto va sin IVA.
router.get('/:id/rentabilidad', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id inválido' });
    const out = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!obra) return null;
      const compras = await db.collection('compras').find(Object.assign({ obraId: id, estado: { $ne: 'anulada' } }, filtroOrg(req)))
        .sort({ fecha: -1 }).toArray();
      const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
      const facturas = compras.map(c => {
        const cot = c.moneda === 'USD' ? (Number(c.cotizacionDolar) || 0) : 1;
        const total = Number(c.total) || 0, iva = Number(c.importeIva) || 0;
        return {
          _id: c._id, numero: c.numero, fecha: c.fecha, proveedor: c.proveedorNombre || '',
          comprobante: c.comprobanteNumero ? `${c.puntoVenta || ''}-${c.comprobanteNumero}` : '',
          moneda: c.moneda || 'ARS', totalOriginal: r2(total),
          conIva: r2(total * cot), sinIva: r2((total - iva) * cot), sinCotizacion: c.moneda === 'USD' && !cot
        };
      });
      const materiales = r2(facturas.reduce((a, f) => a + f.conIva, 0)); // total de las facturas, IVA incluido
      const materialesSinIva = r2(facturas.reduce((a, f) => a + f.sinIva, 0));
      // Presupuesto de materiales vs lo realmente comprado (ítems de las facturas imputadas, sin IVA, en pesos).
      const normN = t => String(t || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
      const pres = (obra.presupuestoMateriales || []).map(b => ({ b, cantReal: 0, totalReal: 0 }));
      const idxPorClave = new Map();
      pres.forEach((p, i) => {
        [p.b.productoId && 'id:' + p.b.productoId, p.b.sku && 'sku:' + normN(p.b.sku), 'n:' + normN(p.b.nombre)].filter(Boolean).forEach(k => { if (!idxPorClave.has(k)) idxPorClave.set(k, i); });
      });
      const fuera = new Map();
      for (const c of compras) {
        const cot = c.moneda === 'USD' ? (Number(c.cotizacionDolar) || 0) : 1;
        const sub = Number(c.subtotal) || 0;
        const factorDesc = sub > 0 ? Math.max(0, (sub * (1 - (Number(c.descuentoPorcentaje) || 0) / 100) - (Number(c.descuentoMonto) || 0)) / sub) : 1;
        for (const it of (c.items || [])) {
          const neto = (Number(it.subtotal) || 0) * cot * factorDesc, cant = Number(it.cantidad) || 0;
          const k = [it.productoId && 'id:' + it.productoId, it.sku && 'sku:' + normN(it.sku), 'n:' + normN(it.nombre)].filter(Boolean).find(x => idxPorClave.has(x));
          if (k !== undefined) { const p = pres[idxPorClave.get(k)]; p.cantReal += cant; p.totalReal += neto; }
          else {
            const kf = it.productoId ? 'id:' + it.productoId : 'n:' + normN(it.nombre);
            const f = fuera.get(kf) || { nombre: it.nombre, sku: it.sku || '', cantReal: 0, totalReal: 0 };
            f.cantReal += cant; f.totalReal += neto; fuera.set(kf, f);
          }
        }
      }
      const filasMat = pres.map(p => {
        const totalPres = r2(p.b.cantidad * p.b.costoUnitario), totalReal = r2(p.totalReal);
        return { nombre: p.b.nombre, sku: p.b.sku || '', cantPres: p.b.cantidad, costoUnitPres: p.b.costoUnitario, totalPres,
          cantReal: Math.round(p.cantReal * 1000) / 1000, totalReal, difTotal: r2(totalReal - totalPres),
          difPct: totalPres > 0 ? r2((totalReal - totalPres) / totalPres * 100) : null, estado: p.cantReal > 0 ? 'comprado' : 'sinComprar' };
      });
      const filasFuera = [...fuera.values()].map(f => ({ nombre: f.nombre, sku: f.sku, cantPres: 0, costoUnitPres: 0, totalPres: 0, cantReal: Math.round(f.cantReal * 1000) / 1000,
        totalReal: r2(f.totalReal), difTotal: r2(f.totalReal), difPct: null, estado: 'fueraPresupuesto' }));
      const matPresupuestado = r2(filasMat.reduce((a, f) => a + f.totalPres, 0));
      const matItemsReal = r2(filasMat.concat(filasFuera).reduce((a, f) => a + f.totalReal, 0));
      const manoObraDet = (obra.tareas || []).filter(t => t.colocadorId && t.costoPorM2Aplicado != null).map(t => ({
        tipoTrabajo: t.tipoTrabajo, m2: Number(t.m2Presupuestados) || 0, costoPorM2: Number(t.costoPorM2Aplicado) || 0,
        subtotal: r2((Number(t.m2Presupuestados) || 0) * (Number(t.costoPorM2Aplicado) || 0))
      }));
      const manoObraM2 = r2(manoObraDet.reduce((a, t) => a + t.subtotal, 0));
      // Trabajos especiales cargados en Sueldos e imputados a esta obra (monto acordado; se muestra además lo ya pagado).
      const especiales = await db.collection('sueldos_tareas_especiales').find({ obraId: id }).sort({ createdAt: 1 }).toArray();
      const especialesDet = especiales.map(e => ({ _id: e._id, descripcion: e.descripcion, colocador: e.colocadorNombre || '', monto: r2(e.monto), pagado: r2(e.totalPagado), estado: e.estado }));
      const manoObraEspeciales = r2(especialesDet.reduce((a, e) => a + e.monto, 0));
      const manoObra = r2(manoObraM2 + manoObraEspeciales);
      const presupuestoManoObra = r2(obra.presupuestoManoObra);
      const ingreso = r2(obra.precioVentaCliente);
      const costo = r2(materiales + manoObra);
      const resultado = r2(ingreso - costo);
      return {
        obra: { _id: obra._id, numero: obra.numero, cliente: (obra.cliente && obra.cliente.nombre) || '', estado: obra.estado },
        ingreso, materiales, materialesSinIva, manoObra, costo, resultado,
        margenPct: ingreso > 0 ? r2(resultado / ingreso * 100) : null,
        facturas, manoObraDetalle: manoObraDet,
        materialesDetalle: filasMat.concat(filasFuera),
        materialesPresupuestado: matPresupuestado, materialesItemsReales: matItemsReal,
        desvioMateriales: filasMat.length ? r2(matItemsReal - matPresupuestado) : null,
        desvioMaterialesPct: matPresupuestado > 0 ? r2((matItemsReal - matPresupuestado) / matPresupuestado * 100) : null,
        manoObraM2, manoObraEspeciales, especialesDetalle: especialesDet, presupuestoManoObra,
        desvioManoObra: presupuestoManoObra > 0 ? r2(manoObra - presupuestoManoObra) : null,
        desvioManoObraPct: presupuestoManoObra > 0 ? r2((manoObra - presupuestoManoObra) / presupuestoManoObra * 100) : null,
        resultadoEsperado: (filasMat.length || presupuestoManoObra > 0) && ingreso > 0 ? r2(ingreso - (filasMat.length ? matPresupuestado : materiales) - (presupuestoManoObra > 0 ? presupuestoManoObra : manoObra)) : null,
        sinPresupuesto: !(ingreso > 0), tareasSinColocador: (obra.tareas || []).filter(t => !t.colocadorId).length
      };
    });
    if (!out) return res.status(404).json({ error: 'Obra no encontrada' });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Crear obra (al vender). tareas: [{tipoTrabajo, m2Presupuestados}]
router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) return res.status(400).json({ error: 'Elegí con qué organización estás trabajando antes de crear una obra.' });
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
      orgId: req.orgId,
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
      // Vínculo con el cliente (sin crear clientes nuevos): el elegido a mano, o el único que coincida.
      let cid = req.body.clienteId ? toObjectId(req.body.clienteId) : null;
      if (cid && !(await db.collection('clientes').findOne(Object.assign({ _id: cid }, filtroOrgClientes(req)), { projection: { _id: 1 } }))) cid = null;
      if (!cid) cid = await buscarClienteUnico(db, req.orgId, doc.cliente);
      if (cid) doc.clienteId = cid;
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
      const obra = await db.collection('obras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
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
      if (estado !== undefined || fechaInicio !== undefined || notasColocador !== undefined || cliente !== undefined) {
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
      const obra = await db.collection('obras').findOne(Object.assign({ _id: id }, filtroOrg(req)));
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
      const obra = await db.collection('obras').findOne(Object.assign({ _id: obraId }, filtroOrg(req)));
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
      const obra = await db.collection('obras').findOne(Object.assign({ _id: obraId }, filtroOrg(req)));
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
router.get('/colocador/mis-obras', authColocadorOAdmin, async (req, res) => {
  try {
    const historial = req.query.historial === '1' || req.query.historial === 'true';

    // Vista de admin (rol protegido, sin token de colocador): todas las
    // obras de todos los colocadores juntas, no filtradas a una sola
    // persona — mismo formato que ve un colocador normal, con el nombre de
    // colocador agregado a cada tarea para que se entienda de quién es cada
    // una, así el resto de esta pantalla (marcar en curso/terminada, subir
    // fotos) se reutiliza sin cambios.
    if (req.esAdminObras) {
      const { obras, nombrePorId } = await conReintento(async () => {
        const db = await getDb();
        const match = Object.assign({}, filtroOrg(req));
        match.estado = historial ? 'terminada' : { $nin: ESTADOS_OBRA_NO_EN_CURSO };
        const obras = await db.collection('obras').find(match).sort({ numero: -1 }).toArray();
        const colocadorIds = [...new Set(
          obras.flatMap(o => (o.tareas || []).map(t => t.colocadorId).filter(Boolean).map(String))
        )].map(toObjectId);
        const colocadores = await db.collection('obras_colocadores').find({ _id: { $in: colocadorIds } }).toArray();
        const nombrePorId = Object.fromEntries(colocadores.map(c => [String(c._id), c.nombre]));
        return { obras, nombrePorId };
      });
      const resultado = obras.map(o => ({
        obraId: o._id,
        numero: o.numero,
        cliente: o.cliente,
        estado: o.estado,
        notasColocador: o.notasColocador || '',
        fotos: o.fotos || [],
        tareas: (o.tareas || []).map(t => ({
          ...t,
          colocadorNombre: t.colocadorId ? (nombrePorId[String(t.colocadorId)] || '(desconocido)') : '(sin asignar)'
        }))
      }));
      return res.json(resultado);
    }

    const colocadorId = req.colocador._id;
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
router.post('/colocador/obras/:obraId/estado', authColocadorOAdmin, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    if (!obraId) return res.status(400).json({ error: 'id inválido' });
    const { estado, observaciones } = req.body || {};
    if (!['en_curso', 'terminada'].includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne(Object.assign({ _id: obraId }, req.esAdminObras ? filtroOrg(req) : {}));
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      // propias — mismo criterio que ya usa requiereVendedorPropio del lado
      // de Visitas.
      if (!req.esAdminObras) {
        const tieneTarea = (obra.tareas || []).some(t => String(t.colocadorId) === String(req.colocador._id));
        if (!tieneTarea) throw Object.assign(new Error('Esta obra no está asignada a tu usuario'), { status: 403 });
      }

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

// Fotos en Cloudinary (16/10/2026): en vez de guardar la imagen dentro de la base, el navegador la sube directo a Cloudinary con
// una firma de este servidor y acá solo se guarda el link (en el mismo campo `data`, así el resto de las pantallas no cambia).
// Variables de entorno: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.
function cloudinaryConfig() {
  const c = { cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, apiSecret: process.env.CLOUDINARY_API_SECRET };
  return (c.cloudName && c.apiKey && c.apiSecret) ? c : null;
}
router.get('/colocador/fotos/firma', authColocadorOAdmin, (req, res) => {
  const c = cloudinaryConfig();
  if (!c) return res.json({ habilitado: false });
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'piedranegra/obras';
  const signature = crypto.createHash('sha1').update('folder=' + folder + '&timestamp=' + timestamp + c.apiSecret).digest('hex');
  res.json({ habilitado: true, cloudName: c.cloudName, apiKey: c.apiKey, timestamp, folder, signature });
});

// Fotos del trabajo terminado, sacadas por el colocador — quedan en el mismo
// arreglo obra.fotos que las "antes" heredadas de la visita (sacadas por el
// vendedor), etiquetadas con origen para poder separarlas en el panel.
router.post('/colocador/obras/:obraId/fotos', authColocadorOAdmin, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    if (!obraId) return res.status(400).json({ error: 'id inválido' });
    const { fotos } = req.body || {};
    if (!Array.isArray(fotos) || !fotos.length) return res.status(400).json({ error: 'No llegaron fotos' });
    const cl = cloudinaryConfig();
    const prefijoCl = cl ? 'https://res.cloudinary.com/' + cl.cloudName + '/' : null;
    const nuevas = fotos
      .filter(f => typeof f === 'string' && (f.indexOf('data:image/') === 0 || (prefijoCl && f.indexOf(prefijoCl) === 0)))
      .map(f => ({ data: f, fecha: new Date(), origen: 'colocador', colocadorNombre: req.esAdminObras ? 'Oficina' : req.colocador.nombre }));
    if (!nuevas.length) return res.status(400).json({ error: 'Formato de foto inválido' });

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne(Object.assign({ _id: obraId }, req.esAdminObras ? filtroOrg(req) : {}));
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      if (!req.esAdminObras) {
        const tienenTarea = (obra.tareas || []).some(t => String(t.colocadorId) === String(req.colocador._id));
        if (!tienenTarea) throw Object.assign(new Error('Esta obra no está asignada a tu usuario'), { status: 403 });
      }
      const totales = (obra.fotos || []).concat(nuevas).slice(0, MAX_FOTOS_OBRA);
      await db.collection('obras').updateOne({ _id: obraId }, { $set: { fotos: totales, updatedAt: new Date() } });
      return totales;
    });
    res.json({ fotos: resultado });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Borrar una foto de la obra (por posición en obra.fotos). La oficina puede borrar cualquiera; un colocador, solo las que subió él (origen colocador).
router.delete('/colocador/obras/:obraId/fotos/:index', authColocadorOAdmin, async (req, res) => {
  try {
    const obraId = toObjectId(req.params.obraId);
    const idx = Number(req.params.index);
    if (!obraId || !Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'id inválido' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const obra = await db.collection('obras').findOne(Object.assign({ _id: obraId }, req.esAdminObras ? filtroOrg(req) : {}));
      if (!obra) throw Object.assign(new Error('Obra no encontrada'), { status: 404 });
      const f = (obra.fotos || [])[idx];
      if (!f) throw Object.assign(new Error('La foto no existe'), { status: 404 });
      if (!req.esAdminObras) {
        const tienenTarea = (obra.tareas || []).some(t => String(t.colocadorId) === String(req.colocador._id));
        if (!tienenTarea) throw Object.assign(new Error('Esta obra no está asignada a tu usuario'), { status: 403 });
        if (f.origen !== 'colocador') throw Object.assign(new Error('Solo podés borrar las fotos que subiste vos'), { status: 403 });
      }
      const fotos = (obra.fotos || []).filter((_, i) => i !== idx);
      await db.collection('obras').updateOne({ _id: obraId }, { $set: { fotos, updatedAt: new Date() } });
      return fotos;
    });
    res.json({ fotos: resultado });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
