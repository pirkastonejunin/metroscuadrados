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
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const PDFDocument = require('pdfkit');
const googleCalendar = require('./google-calendar');
const { authUsuario, requiereModulo } = require('./usuarios');

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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------
// Estados de una visita.
//   sin_visita    -> agendada, todavía no se hizo la visita (nombre viejo:
//                    "agendada", se conserva como alias por compatibilidad
//                    con documentos ya guardados con ese valor)
//   presupuestada -> el vendedor visitó y armó el presupuesto
//   vendido       -> el cliente confirmó (nombre viejo: "confirmada"),
//                    dispara la creación automática de la Obra
//   instalado     -> la Obra vinculada ya tiene todas sus tareas terminadas
//                    (se detecta solo, ver sincronizarInstalacion)
//   cancelada     -> se bajó; se puede reprogramar (vuelve a sin_visita)
// ---------------------------------------------------------------------
const ESTADOS_VISITA_VALIDOS = ['sin_visita', 'presupuestada', 'vendido', 'instalado', 'cancelada'];
const ALIAS_ESTADO_LEGACY = { agendada: 'sin_visita', confirmada: 'vendido' };
function normalizarEstadoVisita(estado) {
  if (!estado) return estado;
  return ALIAS_ESTADO_LEGACY[estado] || estado;
}

// Si una visita ya está "vendido" (generó Obra) y esa Obra ya tiene todas
// sus tareas terminadas, la pasa sola a "instalado" — así el estado de la
// visita refleja el avance real sin que nadie tenga que ir a tocarlo a mano.
// Muta los documentos de `lista` en memoria (para la respuesta) y persiste
// el cambio en Mongo para las próximas consultas/filtros/orden.
async function sincronizarInstalacion(db, lista) {
  const pendientes = lista.filter(v => v.estado === 'vendido' && v.obraId);
  if (!pendientes.length) return lista;
  const obras = await db.collection('obras')
    .find({ _id: { $in: pendientes.map(v => v.obraId) } })
    .project({ tareas: 1 })
    .toArray();
  const obraPorId = new Map(obras.map(o => [String(o._id), o]));
  const idsAActualizar = [];
  for (const v of pendientes) {
    const obra = obraPorId.get(String(v.obraId));
    const tareas = obra && obra.tareas;
    if (tareas && tareas.length && tareas.every(t => t.estado === 'terminada')) {
      v.estado = 'instalado';
      idsAActualizar.push(v._id);
    }
  }
  if (idsAActualizar.length) {
    await db.collection('visitas').updateMany(
      { _id: { $in: idsAActualizar } },
      { $set: { estado: 'instalado', updatedAt: new Date() } }
    );
  }
  return lista;
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

// Antes: función local que comparaba contra una única contraseña compartida
// (OBRAS_ADMIN_PASSWORD). Ahora: usuarios y roles configurables — ver
// usuarios.js. authUsuario valida el token de sesión y carga req.usuario
// (con su rol); requiereModulo('visitas') exige que ese rol tenga acceso al
// módulo de Visitas. Como Express aplana arrays de middlewares, ningún otro
// lugar de este archivo que usa `authAdmin` necesita cambios.
const authAdmin = [authUsuario, requiereModulo('visitas')];

// Duración por defecto de una visita en el calendario, cuando no tenemos
// otra forma de saber cuánto va a durar.
const DURACION_VISITA_MS = 60 * 60 * 1000; // 1 hora

// Los <input type="datetime-local"> del panel (nueva visita, editar,
// reprogramar) mandan un string SIN zona horaria (ej. "2025-01-15T15:00").
// new Date(...) sobre ese string lo interpreta como hora local del
// SERVIDOR, no de Argentina — si el servidor corre en UTC (lo más común en
// Render), una visita cargada para las 15:00 quedaba guardada como las
// 15:00 UTC (12:00 en Argentina), 3 horas antes de lo tipeado. Argentina no
// tiene horario de verano, así que el offset es siempre -03:00 — se lo
// agregamos acá antes de parsear (si el string ya trae zona horaria propia,
// se respeta tal cual, no se toca).
function parsearFechaHoraLocal(fechaHoraStr) {
  const s = String(fechaHoraStr || '').trim();
  const yaTieneZona = /Z$|[+-]\d{2}:\d{2}$/.test(s);
  return new Date(yaTieneZona ? s : s + '-03:00');
}

// Arma los campos del evento de Google Calendar a partir de una visita
// (o de la fusión de la visita actual con los cambios que se le van a aplicar).
function eventoDeVisita(v) {
  return {
    titulo: `Visita: ${v.cliente.nombre}`,
    descripcion: [
      `Vendedor: ${v.vendedorNombre || '-'}`,
      v.cliente.telefono ? `Teléfono: ${v.cliente.telefono}` : null,
      v.notasEmpleada ? `Notas: ${v.notasEmpleada}` : null
    ].filter(Boolean).join('\n'),
    ubicacion: v.cliente.direccion || '',
    inicio: v.fechaHora,
    fin: new Date(new Date(v.fechaHora).getTime() + DURACION_VISITA_MS)
  };
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

// El login de oficina ahora vive en /api/usuarios/login (ver usuarios.js).

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
    const { nombre, telefono, googleCalendarId } = req.body || {};
    if (!nombre) throw err(400, 'Nombre obligatorio');
    const doc = {
      nombre, telefono: telefono || '',
      // Calendario de Google propio de este vendedor, para que sus visitas
      // le lleguen ahí (ver google-calendar.js) — opcional, si lo deja
      // vacío las visitas que se le asignen caen al calendario general de
      // respaldo (si hay uno configurado).
      googleCalendarId: googleCalendarId || '',
      activo: true, createdAt: new Date()
    };
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
    const { nombre, telefono, activo, googleCalendarId } = req.body || {};
    const set = {};
    if (nombre !== undefined) set.nombre = nombre;
    if (telefono !== undefined) set.telefono = telefono;
    if (activo !== undefined) set.activo = activo;
    if (googleCalendarId !== undefined) set.googleCalendarId = googleCalendarId;
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      await db.collection('visitas_vendedores').updateOne({ _id: id }, { $set: set });
      return db.collection('visitas_vendedores').findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Da de alta el calendario de Google de este vendedor: crea un calendario
// nuevo (lo administra la cuenta de servicio) y lo comparte automáticamente
// con su mail de Google — no hace falta que el vendedor ni nadie entre a
// Google Calendar a mano. A partir de ahí sus visitas se sincronizan solas.
// Las visitas que ya existían para este vendedor ANTES de que tuviera
// calendario propio quedaron creadas con vendedorGoogleCalendarId=null (ese
// dato se toma una sola vez, al crear la visita — ver POST /) y por eso su
// evento nunca se creó, aunque después se le haya cargado el calendario. Al
// dar de alta (o volver a dar de alta) el calendario de un vendedor, se
// recorren sus visitas no canceladas y se sincroniza cada una a ESTE
// calendario — así no hace falta recrear las visitas para que aparezcan.
async function resincronizarVisitasDelVendedor(db, vendedorId, calendarId) {
  const visitas = await db.collection('visitas').find({ vendedorId, estado: { $ne: 'cancelada' } }).toArray();
  for (const v of visitas) {
    if (v.googleEventId && v.vendedorGoogleCalendarId && v.vendedorGoogleCalendarId !== calendarId) {
      // Tenía evento en otro calendario (por ejemplo uno viejo, ya dado de
      // baja, del mismo vendedor): se saca de ahí antes de recrearlo en el
      // nuevo, para no dejar duplicados sueltos.
      await googleCalendar.eliminarEvento(v.googleEventId, v.vendedorGoogleCalendarId);
      v.googleEventId = null;
    }
    const googleEventId = await googleCalendar.upsertEvento(v.googleEventId, eventoDeVisita(v), calendarId);
    await db.collection('visitas').updateOne({ _id: v._id }, { $set: { googleEventId, vendedorGoogleCalendarId: calendarId } });
  }
}

router.post('/vendedores/:id/calendario', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const email = (req.body && req.body.email || '').trim();
    if (!email) throw err(400, 'Falta el mail de la cuenta de Google del vendedor');
    if (!googleCalendar.habilitado()) throw err(400, 'Google Calendar no está configurado en el servidor (falta GOOGLE_SERVICE_ACCOUNT_KEY)');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const vendedor = await db.collection('visitas_vendedores').findOne({ _id: id });
      if (!vendedor) throw err(404, 'Vendedor no encontrado');
      const calendarId = await googleCalendar.crearCalendarioParaPersona(`Visitas — ${vendedor.nombre}`, email);
      if (!calendarId) throw err(500, 'No se pudo crear el calendario en Google (revisá los logs del servidor)');
      await db.collection('visitas_vendedores').updateOne({ _id: id }, { $set: { googleCalendarId: calendarId, googleAccountEmail: email } });
      await resincronizarVisitasDelVendedor(db, id, calendarId);
      return db.collection('visitas_vendedores').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Fuerza una resincronización del calendario YA configurado de este
// vendedor (sin crear uno nuevo): sirve para el caso de visitas que
// quedaron sin evento porque se crearon antes de que el vendedor tuviera
// calendario, o si por lo que sea algún evento quedó desincronizado.
router.post('/vendedores/:id/calendario/resincronizar', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const vendedor = await db.collection('visitas_vendedores').findOne({ _id: id });
      if (!vendedor) throw err(404, 'Vendedor no encontrado');
      if (!vendedor.googleCalendarId) throw err(400, 'Este vendedor todavía no tiene calendario propio configurado');
      await resincronizarVisitasDelVendedor(db, id, vendedor.googleCalendarId);
      return { ok: true };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Da de baja el calendario de este vendedor: deja de usarlo para sus
// próximas visitas (caen al calendario general de respaldo, si hay uno).
// No borra el calendario de Google en sí, para no perder el historial ya
// sincronizado ahí.
router.delete('/vendedores/:id/calendario', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      await db.collection('visitas_vendedores').updateOne({ _id: id }, { $set: { googleCalendarId: '', googleAccountEmail: '' } });
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
      // store_id se guarda como Number en cotizador.js (viene de
      // parseInt/JSON del user_id de Tiendanube) — hay que convertir el
      // valor de la env var (siempre string) antes de comparar, si no el
      // find nunca matchea nada.
      return db.collection('tipos_obra').find({ store_id: Number(storeId) }).sort({ nombre: 1 }).toArray();
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
    if (estado) match.estado = normalizarEstadoVisita(estado);
    if (q) {
      const rx = { $regex: escapeRegex(q), $options: 'i' };
      match.$or = [{ 'cliente.nombre': rx }, { 'cliente.telefono': rx }];
    }
    if (desde || hasta) {
      match.fechaHora = {};
      if (desde) match.fechaHora.$gte = new Date(desde);
      if (hasta) match.fechaHora.$lte = new Date(hasta.length <= 10 ? hasta + 'T23:59:59' : hasta);
    }
    const lista = await conReintento(async () => {
      const db = await getDb();
      const lista = await db.collection('visitas').find(match).sort({ fechaHora: 1 }).toArray();
      return sincronizarInstalacion(db, lista);
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
      const doc = await db.collection('visitas').findOne({ _id: id });
      if (!doc) return null;
      const [sincronizada] = await sincronizarInstalacion(db, [doc]);
      return sincronizada;
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
    const fechaHoraParsed = parsearFechaHoraLocal(fechaHora);
    if (isNaN(fechaHoraParsed.getTime())) throw err(400, 'La fecha y hora no son válidas.');
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
        // Calendario propio del vendedor al momento de crear la visita —
        // se guarda junto con el evento (no solo en la ficha del vendedor)
        // para saber de qué calendario borrar/mover si el vendedor cambia
        // de calendario o la visita se reasigna a otro vendedor más tarde.
        vendedorGoogleCalendarId: vendedor.googleCalendarId || null,
        fechaHora: fechaHoraParsed,
        notasEmpleada: notasEmpleada || '',
        estado: 'sin_visita',
        fotos: [],
        presupuesto: null,
        obraId: null,
        confirmadaPor: null,
        googleEventId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      doc.googleEventId = await googleCalendar.upsertEvento(null, eventoDeVisita(doc), doc.vendedorGoogleCalendarId);
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
    if (fechaHora) {
      // Antes, una fecha mal formada acá (ej. el campo llegaba vacío o en un
      // formato que new Date() no puede interpretar) generaba un "Invalid
      // Date" que Mongo terminaba guardando igual — el cambio "se guardaba"
      // pero la visita quedaba con una fecha rota (o, según cómo la haya
      // leído la pantalla después, parecía que directamente no había
      // cambiado nada). Ahora se valida explícitamente y se avisa.
      const fecha = parsearFechaHoraLocal(fechaHora);
      if (isNaN(fecha.getTime())) throw err(400, 'La fecha y hora no son válidas.');
      set.fechaHora = fecha;
    }
    if (notasEmpleada !== undefined) set.notasEmpleada = notasEmpleada;
    let estadoNorm = null;
    if (estado) {
      estadoNorm = normalizarEstadoVisita(estado);
      if (!ESTADOS_VISITA_VALIDOS.includes(estadoNorm)) throw err(400, 'Estado inválido');
      set.estado = estadoNorm;
    }
    const actualizado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('visitas').findOne({ _id: id });
      if (!actual) throw err(404, 'Visita no encontrada');

      // "Vendido" es el estado que dispara la creación de la Obra — si
      // todavía no existe esa Obra para esta visita, este PUT genérico no
      // alcanza (faltaría armar las tareas a partir del presupuesto), así
      // que se pide usar la acción de "Confirmar obra" en su lugar. Si la
      // Obra ya existe (por ej. se está volviendo de "instalado" a
      // "vendido" a mano), se deja pasar como un cambio de estado normal.
      if (estadoNorm === 'vendido' && !actual.obraId) {
        throw err(400, 'Para pasar a "Vendido" primero hay que confirmar la obra (botón "Confirmar obra"), que necesita el presupuesto ya cargado.');
      }

      // Una vez que la visita cambió de estado (ya se presupuestó, se
      // vendió o se instaló) se entiende que la visita ya se realizó, así
      // que no tiene sentido cancelarla — solo se puede cancelar mientras
      // sigue "sin_visita" (agendada, todavía no pasó).
      if (estadoNorm === 'cancelada' && actual.estado !== 'sin_visita') {
        throw err(400, 'Esta visita ya se realizó (cambió de estado), así que no se puede cancelar.');
      }

      if (vendedorId) {
        const vId = toObjectId(vendedorId);
        const vendedor = await db.collection('visitas_vendedores').findOne({ _id: vId });
        if (!vendedor) throw err(400, 'Vendedor no encontrado');
        set.vendedorId = vId;
        set.vendedorNombre = vendedor.nombre;
        set.vendedorGoogleCalendarId = vendedor.googleCalendarId || null;
      }

      // Sincroniza el evento de Google Calendar con los datos que va a
      // tener la visita después de este cambio.
      if (set.estado === 'cancelada') {
        await googleCalendar.eliminarEvento(actual.googleEventId, actual.vendedorGoogleCalendarId);
        set.googleEventId = null;
      } else {
        const fusion = { ...actual, ...set };
        // Si se reasignó a un vendedor con otro calendario, no alcanza con
        // "actualizar" el evento (google-calendar.js no mueve eventos entre
        // calendarios) — se borra del calendario viejo y se crea de nuevo
        // en el nuevo.
        let googleEventIdBase = actual.googleEventId;
        if (googleEventIdBase && actual.vendedorGoogleCalendarId !== fusion.vendedorGoogleCalendarId) {
          await googleCalendar.eliminarEvento(actual.googleEventId, actual.vendedorGoogleCalendarId);
          googleEventIdBase = null;
        }
        set.googleEventId = await googleCalendar.upsertEvento(googleEventIdBase, eventoDeVisita(fusion), fusion.vendedorGoogleCalendarId);
      }

      await db.collection('visitas').updateOne({ _id: id }, { $set: set });
      return db.collection('visitas').findOne({ _id: id });
    });
    res.json(actualizado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Borrado definitivo del registro (no un cambio de estado): pensado para
// sacar de encima visitas de prueba o cargadas mal, no para el uso diario
// (para eso está "Cancelar visita", que conserva el historial). Si la
// visita ya generó una Obra (obraId), esa Obra se borra en cascada junto
// con la visita — no tendría sentido dejarla huérfana apuntando a un
// registro que ya no existe. El frontend avisa de esto antes de confirmar.
// Si había eventos de Google Calendar (de la visita y/o de la obra), se
// borran también de ahí.
router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await db.collection('visitas').findOne({ _id: id });
      if (!visita) throw err(404, 'Visita no encontrada');
      let obraBorrada = null;
      if (visita.obraId) {
        const obra = await db.collection('obras').findOne({ _id: visita.obraId });
        if (obra) {
          if (obra.googleEventId) {
            await googleCalendar.eliminarEvento(obra.googleEventId, obra.googleCalendarId);
          }
          await db.collection('obras').deleteOne({ _id: obra._id });
          obraBorrada = obra.numero;
        }
      }
      if (visita.googleEventId) {
        await googleCalendar.eliminarEvento(visita.googleEventId, visita.vendedorGoogleCalendarId);
      }
      await db.collection('visitas').deleteOne({ _id: id });
      return { obraBorrada };
    });
    res.json({ ok: true, obraBorrada: resultado.obraBorrada });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Confirmación desde oficina (cuando el cliente llama al local más tarde).
// cotizacionesIds (opcional): si el presupuesto tiene más de una cotización
// vinculada, el cliente puede aceptar solo algunas — ver confirmarVisita.
router.post('/:id/confirmar', authAdmin, async (req, res) => {
  try {
    const { cotizacionesIds } = req.body || {};
    const resultado = await confirmarVisita(req.params.id, 'oficina', cotizacionesIds);
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
      .map(f => ({ data: f, fecha: new Date(), origen: 'vendedor' }));
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
// items: [{ tipoTrabajo (= "producto", del catálogo de tipos de trabajo),
//           descripcion, cantidad, valor }]
// "cantidad" reemplaza a los m² de antes (sigue siendo lo que se usa para
// armar la tarea de la Obra y calcular el costo del colocador), "valor" es
// el precio unitario que carga el vendedor, y "total" (cantidad × valor) se
// calcula acá, nunca se toma del cliente.
// formasPagoSeleccionadas: [{ nombre, tipo: 'descuento'|'recargo', porcentaje }]
// — las trae el vendedor desde /api/cotizador/formas-pago (mismo catálogo
// que ya carga Mato para el cotizador) y acá se recalcula el total de cada
// una, mismo cálculo que cotizador.js usa en /guardar, para que quede
// consistente con lo que ya conoce del cotizador.
router.post('/vendedor/:vendedorId/visitas/:id/presupuesto-manual', async (req, res) => {
  try {
    const { items, notas, formasPagoSeleccionadas } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw err(400, 'Agregá al menos un producto');
    for (const it of items) {
      if (!it.tipoTrabajo) throw err(400, 'Falta el producto en un ítem');
      if (!(Number(it.cantidad) > 0)) throw err(400, `Ingresá la cantidad de "${it.tipoTrabajo}"`);
    }
    const itemsFinales = items.map(it => {
      const cantidad = Number(it.cantidad);
      const valor = Number(it.valor) || 0;
      return {
        tipoTrabajo: it.tipoTrabajo,
        descripcion: it.descripcion || '',
        cantidad,
        valor,
        total: Math.round(cantidad * valor * 100) / 100
      };
    });
    const total = itemsFinales.reduce((s, it) => s + it.total, 0);
    const formasPago = Array.isArray(formasPagoSeleccionadas)
      ? formasPagoSeleccionadas.map(fp => {
        const pct = Number(fp.porcentaje) || 0;
        const tipo = fp.tipo === 'recargo' ? 'recargo' : 'descuento';
        const factor = tipo === 'recargo' ? (1 + pct / 100) : (1 - pct / 100);
        return { nombre: String(fp.nombre || ''), tipo, porcentaje: pct, total: Math.round(total * factor * 100) / 100 };
      })
      : [];
    const presupuesto = { tipo: 'manual', items: itemsFinales, total, formasPago, notas: notas || '', fecha: new Date() };

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      const set = { presupuesto, updatedAt: new Date() };
      if (visita.estado === 'sin_visita') set.estado = 'presupuestada';
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: set });
      return db.collection('visitas').findOne({ _id: visita._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Un presupuesto tipo "cotizador" puede tener MÁS DE UNA cotización
// vinculada (ej. una para el piso y otra aparte para una columna o un
// zócalo revestido en piedra) — se guardan todas en `presupuesto.cotizaciones`
// y el total es la suma de todas más los ítems agregados a mano. Docs
// viejos (de antes de este cambio) tienen los datos de la única cotización
// sueltos en el nivel de arriba (`presupuesto.cotizacionId`, etc.) en vez
// de en el array — este helper normaliza los dos formatos a uno solo, así
// el resto del código no tiene que preocuparse por cuál es cuál.
function cotizacionesDePresupuesto(presupuesto) {
  if (!presupuesto || presupuesto.tipo !== 'cotizador') return [];
  if (Array.isArray(presupuesto.cotizaciones)) return presupuesto.cotizaciones;
  if (presupuesto.cotizacionId) {
    return [{
      cotizacionId: presupuesto.cotizacionId,
      storeId: presupuesto.storeId,
      tipoObraId: presupuesto.tipoObraId,
      tipoObraNombre: presupuesto.tipoObraNombre,
      baseTotal: presupuesto.baseTotal,
      fecha: presupuesto.fecha
    }];
  }
  return [];
}

// Presupuesto armado con el cotizador ya existente: el vendedor lo guarda
// ahí (con el botón "Abrir cotizador") y acá solo se engancha por id a la
// visita — no se duplica ni se recalcula nada de cotizador.js. Se puede
// llamar varias veces con cotizaciones distintas para ir sumando más de un
// presupuesto a la misma visita (columnas, zócalos, etc. cotizados aparte);
// si se llama de nuevo con una cotización ya vinculada (ej. el botón
// "Actualizar total"), esa entrada se refresca en el lugar en vez de
// duplicarse.
router.post('/vendedor/:vendedorId/visitas/:id/presupuesto-cotizador', async (req, res) => {
  try {
    const { cotizacionId, storeId } = req.body || {};
    if (!cotizacionId || !storeId) throw err(400, 'Falta cotizacionId o storeId');
    const cotId = toObjectId(cotizacionId);
    if (!cotId) throw err(400, 'cotizacionId inválido');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      // Igual que en /catalogo/tipos-obra: store_id en 'cotizaciones' es
      // Number, así que hay que convertir storeId (viene como string desde
      // el body/env var) antes de comparar. Antes acá se forzaba a
      // String(storeId), que nunca matcheaba y por eso vincular una
      // cotización siempre tiraba "no existe" aunque la cotización sí
      // estuviera guardada (el historial sí la mostraba bien, porque esa
      // consulta usa store.store_id ya con el tipo correcto).
      const cot = await db.collection('cotizaciones').findOne({ _id: cotId, store_id: Number(storeId) });
      if (!cot) throw err(404, 'No se encontró esa cotización en el cotizador');

      // Si esta visita ya tenía otras cotizaciones vinculadas y/o ítems
      // agregados a mano por encima (ver /presupuesto-cotizador/items-extra),
      // se conservan al vincular una cotización más — así no se pierden por
      // volver a abrir el cotizador o por tocar "Actualizar total".
      const existentes = cotizacionesDePresupuesto(visita.presupuesto);
      const itemsExtra = Array.isArray(visita.presupuesto && visita.presupuesto.itemsExtra)
        ? visita.presupuesto.itemsExtra : [];

      const entrada = {
        cotizacionId: cot._id,
        storeId: Number(storeId),
        tipoObraId: cot.tipoObraId,
        tipoObraNombre: cot.tipoObraNombre,
        baseTotal: cot.total,
        fecha: new Date()
      };
      const idxExistente = existentes.findIndex(c => String(c.cotizacionId) === String(cot._id));
      const cotizaciones = idxExistente >= 0
        ? existentes.map((c, i) => (i === idxExistente ? entrada : c))
        : existentes.concat([entrada]);

      const baseTotal = cotizaciones.reduce((s, c) => s + (Number(c.baseTotal) || 0), 0);
      const extraTotal = itemsExtra.reduce((s, it) => s + (Number(it.total) || 0), 0);

      const presupuesto = {
        tipo: 'cotizador',
        cotizaciones,
        itemsExtra,
        total: Math.round((baseTotal + extraTotal) * 100) / 100,
        fecha: new Date()
      };
      const set = { presupuesto, updatedAt: new Date() };
      if (visita.estado === 'sin_visita') set.estado = 'presupuestada';
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: set });
      return db.collection('visitas').findOne({ _id: visita._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Quita una cotización puntual de las vinculadas a esta visita (ej. se
// marcó por error, o se decidió no cotizarla más). Si después de quitarla
// no queda ninguna otra cotización ni ítem agregado a mano, la visita
// vuelve a quedar sin presupuesto (mismo estado que si nunca se hubiera
// cargado nada).
router.delete('/vendedor/:vendedorId/visitas/:id/presupuesto-cotizador/:cotizacionId', async (req, res) => {
  try {
    const cotId = toObjectId(req.params.cotizacionId);
    if (!cotId) throw err(400, 'cotizacionId inválido');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      if (!visita.presupuesto || visita.presupuesto.tipo !== 'cotizador') {
        throw err(400, 'Esta visita no tiene presupuestos del cotizador vinculados');
      }
      const cotizaciones = cotizacionesDePresupuesto(visita.presupuesto)
        .filter(c => String(c.cotizacionId) !== String(cotId));
      const itemsExtra = Array.isArray(visita.presupuesto.itemsExtra) ? visita.presupuesto.itemsExtra : [];

      let set;
      if (!cotizaciones.length && !itemsExtra.length) {
        set = { presupuesto: null, updatedAt: new Date() };
      } else {
        const baseTotal = cotizaciones.reduce((s, c) => s + (Number(c.baseTotal) || 0), 0);
        const extraTotal = itemsExtra.reduce((s, it) => s + (Number(it.total) || 0), 0);
        set = {
          presupuesto: {
            tipo: 'cotizador',
            cotizaciones,
            itemsExtra,
            total: Math.round((baseTotal + extraTotal) * 100) / 100,
            fecha: visita.presupuesto.fecha || new Date()
          },
          updatedAt: new Date()
        };
      }
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: set });
      return db.collection('visitas').findOne({ _id: visita._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Agrega/edita/quita ítems cargados a mano POR ENCIMA de un presupuesto
// armado con el cotizador (las dos formas conviven: lo que ya calculó el
// cotizador queda igual, y esto se suma aparte). Reemplaza la lista
// completa de "itemsExtra" cada vez (igual que el form de presupuesto
// manual reemplaza toda la lista de items) — mandar un array vacío los
// quita a todos.
router.post('/vendedor/:vendedorId/visitas/:id/presupuesto-cotizador/items-extra', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items)) throw err(400, 'Formato inválido');
    for (const it of items) {
      if (!it.tipoTrabajo) throw err(400, 'Falta el producto en un ítem');
      if (!(Number(it.cantidad) > 0)) throw err(400, `Ingresá la cantidad de "${it.tipoTrabajo}"`);
    }
    const itemsExtra = items.map(it => {
      const cantidad = Number(it.cantidad);
      const valor = Number(it.valor) || 0;
      return {
        tipoTrabajo: it.tipoTrabajo,
        descripcion: it.descripcion || '',
        cantidad,
        valor,
        total: Math.round(cantidad * valor * 100) / 100
      };
    });
    const extraTotal = itemsExtra.reduce((s, it) => s + it.total, 0);

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visita = await visitaDelVendedor(db, req.params.id, req.params.vendedorId);
      if (!visita.presupuesto || visita.presupuesto.tipo !== 'cotizador') {
        throw err(400, 'Esta visita no tiene un presupuesto armado con el cotizador');
      }
      // "baseTotal" de cada cotización es el subtotal que calculó el
      // cotizador — se guarda desde que se vincula (ver
      // /presupuesto-cotizador). Si alguna quedó sin ese campo (vinculada de
      // antes de que existiera, o del formato viejo de una sola cotización),
      // en vez de asumir 0 se lo recupera de la cotización original, una
      // por una.
      const cotizacionesOriginales = cotizacionesDePresupuesto(visita.presupuesto);
      const cotizaciones = await Promise.all(cotizacionesOriginales.map(async c => {
        if (Number(c.baseTotal) > 0) return c;
        const cot = await db.collection('cotizaciones').findOne({ _id: c.cotizacionId, store_id: Number(c.storeId) });
        return Object.assign({}, c, { baseTotal: cot ? Number(cot.total) || 0 : 0 });
      }));
      const baseTotal = cotizaciones.reduce((s, c) => s + (Number(c.baseTotal) || 0), 0);
      const set = {
        'presupuesto.cotizaciones': cotizaciones,
        'presupuesto.itemsExtra': itemsExtra,
        'presupuesto.total': Math.round((baseTotal + extraTotal) * 100) / 100,
        updatedAt: new Date()
      };
      await db.collection('visitas').updateOne({ _id: visita._id }, { $set: set });
      return db.collection('visitas').findOne({ _id: visita._id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// PDF del presupuesto manual ("llave en mano" para pasarle al cliente):
// a diferencia del PDF del cotizador, acá NUNCA se muestran cantidades ni
// precios unitarios — solo qué trabajo se va a hacer, con qué producto, y
// el total con las formas de pago (mismo bloque que ya usa cotizador.js).
// Para un presupuesto tipo "cotizador" no hace falta esto: ya tiene su
// propio PDF armado en /api/cotizador/pdf/:id?vista=simple.
// ---------------------------------------------------------------------

const PDF_ANCHO_DISPONIBLE = 495; // 595pt (A4) - 50pt de margen a cada lado

// Mismo logo que ya usa cotizador.js para sus PDFs (public/assets/logo-piedra-negra.png,
// que ese módulo se encarga de escribir a disco si hace falta la primera vez
// que corre el server). No se importa cotizador.js para no tocarlo ni
// acoplarse a su código — solo se apunta al mismo archivo en disco, con el
// mismo respaldo en texto si por algún motivo no está disponible.
const LOGO_PNG_PATH = path.join(__dirname, 'public', 'assets', 'logo-piedra-negra.png');

function dibujarMarca(pdf) {
  const y0 = pdf.y;
  let dibujoLogo = false;
  try {
    pdf.image(LOGO_PNG_PATH, 50, y0, { height: 30 });
    pdf.y = y0 + 34;
    dibujoLogo = true;
  } catch (e) { dibujoLogo = false; }
  if (!dibujoLogo) {
    pdf.fontSize(15).fillColor('#000').font('Helvetica-Bold').text('PIEDRA NEGRA', 50, y0, { characterSpacing: 1.2 });
    pdf.font('Helvetica');
    pdf.y = y0 + 20;
  }
  pdf.moveDown(0.3);
  pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#1f2937').lineWidth(1.4).stroke();
  pdf.strokeColor('#ddd').lineWidth(1);
  pdf.moveDown(0.6);
  pdf.fillColor('#000');
}

function dibujarEncabezadoPresupuestoManual(pdf, visita, vistaDetalle) {
  const p = visita.presupuesto;
  dibujarMarca(pdf);
  pdf.fontSize(16).text(vistaDetalle ? 'Presupuesto de obra' : 'Presupuesto de obra — Llave en mano');
  pdf.moveDown(0.3);
  pdf.fontSize(10).fillColor('#555').text('Fecha: ' + new Date(p.fecha).toLocaleDateString('es-AR'));
  pdf.fillColor('#000');
  pdf.moveDown(0.8);
  if (visita.cliente && visita.cliente.nombre) pdf.fontSize(11).text('Cliente: ' + visita.cliente.nombre);
  if (visita.cliente && visita.cliente.direccion) pdf.fontSize(11).text('Dirección: ' + visita.cliente.direccion);
  pdf.moveDown(0.8);
}

function dibujarFormasPagoManual(pdf, p) {
  if (p.formasPago && p.formasPago.length) {
    pdf.moveDown(0.8);
    pdf.fontSize(10).fillColor('#555').text('Formas de pago', { align: 'right' });
    pdf.fillColor('#000');
    p.formasPago.forEach(fp => {
      const signo = fp.tipo === 'recargo' ? '+' : '-';
      pdf.fontSize(10).text(
        fp.nombre + (fp.porcentaje ? ' (' + signo + fp.porcentaje + '%)' : '') + ': $ ' + Number(fp.total).toFixed(2),
        { align: 'right' }
      );
    });
  }
}

// Aclaraciones que carga el vendedor al armar el presupuesto (p.ej.
// "el precio no incluye flete", "colocación a partir del lunes").
function dibujarObservacionesManual(pdf, p) {
  if (!p.notas) return;
  pdf.moveDown(0.8);
  pdf.fontSize(10).font('Helvetica-Bold').fillColor('#555').text('Observaciones');
  pdf.font('Helvetica').fontSize(10).fillColor('#000').text(p.notas, { width: PDF_ANCHO_DISPONIBLE });
}

// Fotos que sacó el vendedor (visita.fotos), en una grilla — vienen ya como
// data URLs base64 (no hay que descargarlas de ningún lado, a diferencia de
// las fotos de producto de cotizador.js).
const PDF_FOTOS_COLS = 3;
const PDF_FOTOS_GAP = 12;

function bufferDesdeDataUrl(dataUrl) {
  try {
    const idx = String(dataUrl).indexOf(',');
    if (idx === -1) return null;
    return Buffer.from(dataUrl.slice(idx + 1), 'base64');
  } catch (e) { return null; }
}

function dibujarFotosVisita(pdf, fotos) {
  if (!fotos || !fotos.length) return;
  pdf.moveDown(0.6);
  pdf.fontSize(12).font('Helvetica-Bold').text('Fotos del lugar');
  pdf.font('Helvetica');
  pdf.moveDown(0.4);

  const cellW = (PDF_ANCHO_DISPONIBLE - PDF_FOTOS_GAP * (PDF_FOTOS_COLS - 1)) / PDF_FOTOS_COLS;
  const pageBottom = pdf.page.height - pdf.page.margins.bottom;
  let rowY = pdf.y;
  fotos.forEach((f, i) => {
    const col = i % PDF_FOTOS_COLS;
    if (col === 0 && rowY + cellW > pageBottom) { pdf.addPage(); rowY = pdf.y; }
    const x = 50 + col * (cellW + PDF_FOTOS_GAP);
    const buf = bufferDesdeDataUrl(f.data);
    if (buf) {
      try { pdf.image(buf, x, rowY, { cover: [cellW, cellW], align: 'center', valign: 'center' }); }
      catch (e) { pdf.rect(x, rowY, cellW, cellW).strokeColor('#e2e0db').stroke(); }
    } else {
      pdf.rect(x, rowY, cellW, cellW).strokeColor('#e2e0db').stroke();
    }
    if (col === PDF_FOTOS_COLS - 1 || i === fotos.length - 1) {
      rowY = rowY + cellW + 10;
      pdf.y = rowY;
    }
  });
  pdf.moveDown(0.4);
}

// Vista "llave en mano" para el cliente: nunca cantidades ni precios
// unitarios — solo qué trabajo se va a hacer, con qué producto, el total
// con las formas de pago, y las fotos del lugar.
function dibujarPdfPresupuestoManualSimple(pdf, visita) {
  const p = visita.presupuesto;
  dibujarEncabezadoPresupuestoManual(pdf, visita, false);

  pdf.fontSize(10).fillColor('#555').text(
    'Provisión de materiales y mano de obra necesarios para la ejecución de la obra detallada, llave en mano.',
    { width: PDF_ANCHO_DISPONIBLE }
  );
  pdf.fillColor('#000');
  pdf.moveDown(1);

  itemsParaPdf(p).forEach(it => {
    pdf.fontSize(12).font('Helvetica-Bold').text(it.tipoTrabajo, { width: PDF_ANCHO_DISPONIBLE });
    pdf.font('Helvetica');
    if (it.descripcion) {
      pdf.fontSize(10).fillColor('#555').text(it.descripcion, { width: PDF_ANCHO_DISPONIBLE });
      pdf.fillColor('#000');
    }
    pdf.moveDown(0.6);
  });

  pdf.moveDown(0.2);
  pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#ddd').stroke();
  pdf.moveDown(0.5);
  pdf.fontSize(16).text('Total: $ ' + Number(p.total || 0).toFixed(2), { align: 'right' });

  dibujarFormasPagoManual(pdf, p);
  dibujarObservacionesManual(pdf, p);
  dibujarFotosVisita(pdf, visita.fotos);
}

// Vista completa, con cantidad, precio unitario y subtotal de cada ítem —
// para uso interno o cuando el cliente pide ver el detalle.
function dibujarPdfPresupuestoManualDetalle(pdf, visita) {
  const p = visita.presupuesto;
  dibujarEncabezadoPresupuestoManual(pdf, visita, true);

  const col = { producto: { x: 50, w: 235 }, cantidad: { x: 295, w: 65 }, precio: { x: 365, w: 85 }, subtotal: { x: 455, w: 90 } };

  function encabezadoTabla() {
    const y0 = pdf.y;
    pdf.fontSize(9).fillColor('#555');
    pdf.text('Trabajo / producto', col.producto.x, y0, { width: col.producto.w });
    pdf.text('Cantidad', col.cantidad.x, y0, { width: col.cantidad.w });
    pdf.text('Precio unit.', col.precio.x, y0, { width: col.precio.w });
    pdf.text('Subtotal', col.subtotal.x, y0, { width: col.subtotal.w, align: 'right' });
    pdf.fillColor('#000');
    pdf.y = y0 + 14;
    pdf.moveDown(0.3);
    pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#ddd').stroke();
    pdf.moveDown(0.3);
  }

  encabezadoTabla();
  const pageBottom = pdf.page.height - pdf.page.margins.bottom;
  itemsParaPdf(p).forEach(it => {
    const etiqueta = it.tipoTrabajo + (it.descripcion ? ' (' + it.descripcion + ')' : '');
    pdf.fontSize(10);
    const alturaFila = Math.max(pdf.heightOfString(etiqueta, { width: col.producto.w }), 14);
    if (pdf.y + alturaFila > pageBottom) { pdf.addPage(); encabezadoTabla(); }
    const y0 = pdf.y;
    pdf.fillColor('#000').text(etiqueta, col.producto.x, y0, { width: col.producto.w });
    pdf.text(String(it.cantidad), col.cantidad.x, y0, { width: col.cantidad.w });
    pdf.text('$ ' + Number(it.valor || 0).toFixed(2), col.precio.x, y0, { width: col.precio.w });
    pdf.text('$ ' + Number(it.total || 0).toFixed(2), col.subtotal.x, y0, { width: col.subtotal.w, align: 'right' });
    pdf.y = y0 + alturaFila + 8;
  });

  pdf.moveDown(0.3);
  pdf.moveTo(50, pdf.y).lineTo(545, pdf.y).strokeColor('#ddd').stroke();
  pdf.moveDown(0.5);
  pdf.fontSize(16).text('Total: $ ' + Number(p.total || 0).toFixed(2), { align: 'right' });

  dibujarFormasPagoManual(pdf, p);
  dibujarObservacionesManual(pdf, p);
  dibujarFotosVisita(pdf, visita.fotos);
}

// El PDF combinado (armado acá, no el propio del cotizador) hace falta
// cuando hay más de una fuente que combinar: varias cotizaciones vinculadas,
// y/o ítems agregados a mano por encima. Con una sola cotización y sin
// agregados, alcanza con mandar al PDF propio del cotizador (tiene el
// detalle línea por línea que este no reconstruye).
function necesitaPdfCombinado(p) {
  if (p.tipo === 'manual') return true;
  const tieneExtra = Array.isArray(p.itemsExtra) && p.itemsExtra.length > 0;
  return tieneExtra || cotizacionesDePresupuesto(p).length > 1;
}

function validarPresupuestoManualParaPdf(visita) {
  if (!visita.presupuesto) throw err(400, 'Esta visita todavía no tiene presupuesto cargado.');
  if (!necesitaPdfCombinado(visita.presupuesto)) {
    throw err(400, 'Este presupuesto se armó con el cotizador: generá el PDF desde ahí (vista llave en mano).');
  }
}

// Ítems a listar en el PDF: si el presupuesto es manual, los suyos tal
// cual; si es del cotizador (una o varias cotizaciones vinculadas, con o
// sin ítems agregados a mano por encima), un renglón resumen por cada
// cotización con su subtotal (el detalle línea por línea de CADA UNA sigue
// estando en su propio PDF del cotizador) más esos ítems extra — así el PDF
// de acá muestra el presupuesto completo, no solo lo agregado a mano.
function itemsParaPdf(p) {
  if (p.tipo === 'manual') return p.items || [];
  const base = cotizacionesDePresupuesto(p).map(c => ({
    tipoTrabajo: c.tipoObraNombre || 'Presupuesto (cotizador)',
    descripcion: 'Detalle completo en el PDF del cotizador',
    cantidad: 1,
    valor: Number(c.baseTotal) || 0,
    total: Number(c.baseTotal) || 0
  }));
  return [...base, ...(p.itemsExtra || [])];
}

function enviarPdfPresupuestoManual(res, visita, vistaDetalle) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="presupuesto-' + visita._id + (vistaDetalle ? '-detalle' : '') + '.pdf"');
  const pdf = new PDFDocument({ margin: 50 });
  pdf.pipe(res);
  if (vistaDetalle) dibujarPdfPresupuestoManualDetalle(pdf, visita);
  else dibujarPdfPresupuestoManualSimple(pdf, visita);
  pdf.end();
}

router.get('/vendedor/:vendedorId/visitas/:id/presupuesto-pdf', async (req, res) => {
  try {
    const visita = await conReintento(async () => {
      const db = await getDb();
      return visitaDelVendedor(db, req.params.id, req.params.vendedorId);
    });
    validarPresupuestoManualParaPdf(visita);
    enviarPdfPresupuestoManual(res, visita, req.query.vista === 'detalle');
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id/presupuesto-pdf', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const visita = await conReintento(async () => {
      const db = await getDb();
      return db.collection('visitas').findOne({ _id: id });
    });
    if (!visita) throw err(404, 'Visita no encontrada');
    validarPresupuestoManualParaPdf(visita);
    enviarPdfPresupuestoManual(res, visita, req.query.vista === 'detalle');
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Confirmación en el momento, por el vendedor. cotizacionesIds (opcional):
// ver confirmarVisita.
router.post('/vendedor/:vendedorId/visitas/:id/confirmar', async (req, res) => {
  try {
    await conReintento(async () => {
      const db = await getDb();
      await visitaDelVendedor(db, req.params.id, req.params.vendedorId); // valida pertenencia
    });
    const { cotizacionesIds } = req.body || {};
    const resultado = await confirmarVisita(req.params.id, 'vendedor', cotizacionesIds);
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// Confirmación de visita -> genera la Obra automáticamente
// ---------------------------------------------------------------------

// A partir del presupuesto.obra de cada cotización vinculada, arma las
// tareas usando el mapeo tipo de obra -> tipo(s) de trabajo definido en el
// panel. Si hay más de una cotización (ver cotizacionesDePresupuesto) se
// procesan todas y se suman: dos cotizaciones que mapean al mismo tipo de
// trabajo (ej. dos presupuestos de Piso por separado) terminan en una sola
// tarea con los m² de las dos juntos, en vez de dos tareas duplicadas.
async function tareasDesdeMapeo(db, presupuesto) {
  const cotizaciones = cotizacionesDePresupuesto(presupuesto);
  if (!cotizaciones.length) throw err(400, 'Este presupuesto no tiene ninguna cotización vinculada.');

  const m2PorTipoTrabajo = new Map();
  for (const c of cotizaciones) {
    const mapeo = await db.collection('visitas_mapeo_tipo_obra').findOne({ tipoObraId: String(c.tipoObraId) });
    if (!mapeo) {
      throw err(400, `Definí el mapeo de tipos de trabajo para "${c.tipoObraNombre || c.tipoObraId}" antes de confirmar (panel de Visitas → Mapeo).`);
    }
    const cot = await db.collection('cotizaciones').findOne({ _id: c.cotizacionId });
    const obraCot = (cot && cot.obra) || {};
    mapeo.reglas
      .filter(r => Number(obraCot[r.campoObra]) > 0)
      .forEach(r => {
        const previo = m2PorTipoTrabajo.get(r.tipoTrabajo) || 0;
        m2PorTipoTrabajo.set(r.tipoTrabajo, previo + Number(obraCot[r.campoObra]));
      });
  }
  const tareas = [...m2PorTipoTrabajo.entries()].map(([tipoTrabajo, m2Presupuestados]) => ({ tipoTrabajo, m2Presupuestados }));
  if (!tareas.length) {
    throw err(400, 'Las cotizaciones vinculadas no tienen cantidades que coincidan con el mapeo definido para su tipo de obra.');
  }
  return tareas;
}

// Prefill de materiales de la tarea a partir del propio ítem del
// presupuesto manual (el "producto a utilizar" que ya cargó el vendedor),
// para que en el panel de obra no haya que volver a escribirlo — queda
// como punto de partida editable, con la posibilidad de agregar más a
// mano (ver admin-obras.html).
function tareasDesdeItems(items) {
  return (items || []).map(it => ({
    tipoTrabajo: it.tipoTrabajo,
    m2Presupuestados: it.cantidad,
    materialesIniciales: it.descripcion ? [{ tipo: it.descripcion, cantidad: String(it.cantidad) }] : []
  }));
}
function tareasDesdeManual(presupuesto) {
  return tareasDesdeItems(presupuesto.items);
}

// cotizacionesIdsSeleccionadas (opcional, solo aplica cuando el presupuesto
// es tipo 'cotizador'): el cliente puede aceptar solo una parte del trabajo
// cuando la visita tiene más de una cotización vinculada (ej. el piso sí,
// la columna en piedra no por ahora) — si se manda, solo esas cotizaciones
// entran a la Obra; si se omite, se confirman todas (comportamiento de
// siempre, y lo único posible cuando hay una sola cotización). Los ítems
// agregados a mano (itemsExtra) no tienen selección propia: siempre se
// suman completos, sean cuales sean las cotizaciones elegidas. Las
// cotizaciones NO elegidas no se pierden — siguen en visita.presupuesto tal
// cual, por si el cliente decide después sumar esa parte a otra obra.
async function confirmarVisita(visitaIdStr, confirmadaPor, cotizacionesIdsSeleccionadas) {
  const visitaId = toObjectId(visitaIdStr);
  if (!visitaId) throw err(400, 'id inválido');

  return conReintento(async () => {
    const db = await getDb();
    const visita = await db.collection('visitas').findOne({ _id: visitaId });
    if (!visita) throw err(404, 'Visita no encontrada');
    if (visita.estado === 'vendido' || visita.estado === 'instalado') throw err(400, 'Esta visita ya fue confirmada');
    if (visita.estado === 'cancelada') throw err(400, 'Esta visita está cancelada');
    if (!visita.presupuesto) throw err(400, 'Todavía no se cargó el presupuesto de esta visita');

    // Si el presupuesto es del cotizador PERO además tiene ítems cargados a
    // mano por encima (ver /presupuesto-cotizador/items-extra), las tareas
    // de la obra se arman con las dos fuentes: las de las cotizaciones
    // elegidas (mapeo) y las de esos ítems extra, una lista sola.
    let tareasBase;
    let precioVentaCliente;
    let cotizacionesConfirmadas = null; // se guarda en la Obra para trazabilidad — null si el presupuesto es manual
    let cotizacionesDeclinadas = null;

    if (visita.presupuesto.tipo === 'cotizador') {
      const todas = cotizacionesDePresupuesto(visita.presupuesto);
      let seleccionadas = todas;
      if (Array.isArray(cotizacionesIdsSeleccionadas)) {
        const idsValidos = new Set(todas.map(c => String(c.cotizacionId)));
        const idsInvalidos = cotizacionesIdsSeleccionadas.filter(id => !idsValidos.has(String(id)));
        if (idsInvalidos.length) throw err(400, 'Alguno de los presupuestos elegidos no está vinculado a esta visita.');
        const idsSeleccionados = new Set(cotizacionesIdsSeleccionadas.map(String));
        seleccionadas = todas.filter(c => idsSeleccionados.has(String(c.cotizacionId)));
      }
      const itemsExtra = Array.isArray(visita.presupuesto.itemsExtra) ? visita.presupuesto.itemsExtra : [];
      if (!seleccionadas.length && !itemsExtra.length) {
        throw err(400, 'Elegí al menos un presupuesto para confirmar.');
      }

      tareasBase = seleccionadas.length ? await tareasDesdeMapeo(db, { tipo: 'cotizador', cotizaciones: seleccionadas }) : [];
      if (itemsExtra.length) {
        tareasBase = tareasBase.concat(tareasDesdeItems(itemsExtra));
      }

      const baseTotal = seleccionadas.reduce((s, c) => s + (Number(c.baseTotal) || 0), 0);
      const extraTotal = itemsExtra.reduce((s, it) => s + (Number(it.total) || 0), 0);
      precioVentaCliente = Math.round((baseTotal + extraTotal) * 100) / 100;

      cotizacionesConfirmadas = seleccionadas.map(c => ({ cotizacionId: c.cotizacionId, tipoObraNombre: c.tipoObraNombre, baseTotal: c.baseTotal }));
      cotizacionesDeclinadas = todas
        .filter(c => !seleccionadas.some(s => String(s.cotizacionId) === String(c.cotizacionId)))
        .map(c => ({ cotizacionId: c.cotizacionId, tipoObraNombre: c.tipoObraNombre, baseTotal: c.baseTotal }));
    } else {
      tareasBase = tareasDesdeManual(visita.presupuesto);
      precioVentaCliente = visita.presupuesto.total || 0;
    }

    const tareas = tareasBase.map(t => ({
      _id: new ObjectId(),
      tipoTrabajo: t.tipoTrabajo,
      m2Presupuestados: Number(t.m2Presupuestados) || 0,
      colocadorId: null,
      costoPorM2Aplicado: null,
      estado: 'pendiente', // pendiente -> en_curso -> terminada (se sincroniza solo con el estado general de la obra, ver obras.js)
      fechaInicio: null,
      fechaFinEstimada: null,
      fechaFinReal: null,
      materiales: t.materialesIniciales || []
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
      fechaInicio: null, // fecha de inicio de la obra completa (una sola, no por producto — ver obras.js)
      notasColocador: '', // aclaraciones de oficina para el colocador (una sola, para toda la obra)
      notasAsesor: '', // notas/observaciones para el asesor — una sola, para toda la obra
      tareas,
      notasGenerales: visita.notasEmpleada || '',
      fotos: visita.fotos || [],
      visitaId: visita._id,
      origenPresupuesto: visita.presupuesto.tipo,
      precioVentaCliente,
      // Si el presupuesto era del cotizador y tenía más de una cotización
      // vinculada, acá queda registro de cuáles aceptó el cliente y cuáles
      // no (para seguimiento comercial — ej. volver a ofrecer más adelante
      // lo que declinó). null cuando el presupuesto era manual, o cuando
      // era del cotizador con una sola cotización (no hubo nada que elegir).
      cotizacionesConfirmadas,
      cotizacionesDeclinadas,
      // Evento de Google Calendar de la obra (uno solo, no por producto —
      // ver sincronizarCalendarDeObra en obras.js) y el calendario donde
      // vive. Arranca vacío: recién se crea cuando oficina le asigna
      // colocador y fecha de inicio desde el panel de Obras.
      googleEventId: null,
      googleCalendarId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const r = await db.collection('obras').insertOne(obraDoc);
    obraDoc._id = r.insertedId;

    // La visita ya se convirtió en Obra: se borra su evento de Calendar acá
    // (la Obra tiene su propio evento — uno solo para toda la obra, en el
    // calendario del colocador — que se sincroniza aparte, desde obras.js,
    // recién cuando se le asigna colocador y fecha de inicio).
    await googleCalendar.eliminarEvento(visita.googleEventId, visita.vendedorGoogleCalendarId);

    const setVisita = { estado: 'vendido', obraId: r.insertedId, confirmadaPor, googleEventId: null, updatedAt: new Date() };
    // Registro de qué se confirmó y qué no, sin tocar ni borrar las
    // cotizaciones originales del presupuesto (siguen ahí completas).
    if (cotizacionesConfirmadas) setVisita['presupuesto.cotizacionesConfirmadas'] = cotizacionesConfirmadas;
    if (cotizacionesDeclinadas) setVisita['presupuesto.cotizacionesDeclinadas'] = cotizacionesDeclinadas;

    await db.collection('visitas').updateOne({ _id: visita._id }, { $set: setVisita });

    return { visita: await db.collection('visitas').findOne({ _id: visita._id }), obra: obraDoc };
  });
}

// ---------------------------------------------------------------------
// REPORTES: embudo de ventas
// ---------------------------------------------------------------------
// Cuántas visitas se cargaron, cuántas llegaron a tener presupuesto
// (estado 'presupuestada' en adelante) y cuántas se vendieron (estado
// 'vendido'/'instalado'), con desglose por tipo de producto — mismo
// catálogo de "tipo de trabajo" que ya usa el panel de Obras (Piso,
// Piedra, Placa, etc.), para no inventar una clasificación nueva.
//
// La clasificación por tipo de producto reutiliza la MISMA lógica que ya
// arma las tareas de la Obra al confirmar una visita (ver
// tareasDesdeMapeo/tareasDesdeManual más arriba), pero en versión
// tolerante: si falta el mapeo configurado o la cotización ya no existe,
// esa visita queda "sin clasificar" en vez de hacer fallar todo el
// reporte (a diferencia de confirmarVisita, acá no hay nada que bloquear).
async function tiposTrabajoDePresupuesto(db, presupuesto) {
  try {
    if (!presupuesto) return [];
    if (presupuesto.tipo === 'manual') {
      return [...new Set((presupuesto.items || []).map(it => it.tipoTrabajo).filter(Boolean))];
    }
    if (presupuesto.tipo === 'cotizador') {
      const tiposDelMapeo = [];
      for (const c of cotizacionesDePresupuesto(presupuesto)) {
        const mapeo = await db.collection('visitas_mapeo_tipo_obra').findOne({ tipoObraId: String(c.tipoObraId) });
        if (!mapeo || !Array.isArray(mapeo.reglas)) continue;
        const cot = await db.collection('cotizaciones').findOne({ _id: c.cotizacionId });
        const obraCot = (cot && cot.obra) || {};
        mapeo.reglas
          .filter(r => Number(obraCot[r.campoObra]) > 0)
          .forEach(r => tiposDelMapeo.push(r.tipoTrabajo));
      }
      const tiposExtra = (presupuesto.itemsExtra || []).map(it => it.tipoTrabajo).filter(Boolean);
      return [...new Set([...tiposDelMapeo, ...tiposExtra])];
    }
  } catch (e) { /* cotización borrada, mapeo mal formado, etc. — queda sin clasificar */ }
  return [];
}

// desde/hasta filtran por fecha de la visita (fechaHora), igual que /agenda.
// Se excluyen las visitas canceladas (no cuentan para el embudo).
router.get('/reportes/embudo', authAdmin, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const match = { estado: { $ne: 'cancelada' } };
    if (desde || hasta) {
      match.fechaHora = {};
      if (desde) match.fechaHora.$gte = new Date(desde);
      if (hasta) match.fechaHora.$lte = new Date(hasta.length <= 10 ? hasta + 'T23:59:59' : hasta);
    }

    const resultado = await conReintento(async () => {
      const db = await getDb();
      const visitas = await db.collection('visitas').find(match).toArray();

      const general = { visitas: visitas.length, presupuestadas: 0, vendidas: 0 };
      const porTipo = {}; // tipoTrabajo -> { tipoTrabajo, presupuestadas, vendidas }
      let sinClasificar = 0;

      for (const v of visitas) {
        const tienePresupuesto = v.estado === 'presupuestada' || v.estado === 'vendido' || v.estado === 'instalado';
        const vendida = v.estado === 'vendido' || v.estado === 'instalado';
        if (tienePresupuesto) general.presupuestadas++;
        if (vendida) general.vendidas++;
        if (!tienePresupuesto) continue;

        const tipos = await tiposTrabajoDePresupuesto(db, v.presupuesto);
        if (!tipos.length) { sinClasificar++; continue; }
        for (const tipo of tipos) {
          if (!porTipo[tipo]) porTipo[tipo] = { tipoTrabajo: tipo, presupuestadas: 0, vendidas: 0 };
          porTipo[tipo].presupuestadas++;
          if (vendida) porTipo[tipo].vendidas++;
        }
      }

      return {
        general,
        porTipo: Object.values(porTipo).sort((a, b) => b.presupuestadas - a.presupuestadas),
        sinClasificar
      };
    });

    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
