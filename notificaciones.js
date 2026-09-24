// ---------------------------------------------------------------------------
// Notificaciones — campanita de vencimientos en los paneles de Oficina.
//
// No tiene colección propia de "notificaciones": cada alerta se calcula al
// vuelo a partir de datos que ya existen en otras colecciones (oportunidades
// del CRM, visitas, tareas de obra). Así nunca se desincroniza de la
// realidad ni hay que mantener un estado aparte — si se resuelve el
// vencimiento (se descarta la oportunidad, se carga la visita, se marca la
// tarea terminada), la alerta desaparece sola en la próxima consulta.
//
// Vencimientos que reporta, uno por cada colección que ya tenía la noción de
// "fecha" o "vencido":
//   - CRM: oportunidades activas cuya próxima acción (ver crm.js) ya venció.
//   - Visitas: visitas agendadas cuya fecha/hora ya pasó y siguen en estado
//     'sin_visita' (nunca se les cargó nada — vendedor no fue o no cargó).
//   - Obras: tareas de una obra no cancelada/terminada, con fecha fin
//     estimada vencida y la tarea todavía no está 'terminada'.
//
// Cada tipo se puede prender/apagar globalmente (para todos los usuarios)
// desde una configuración simple — colección 'configuracion', un solo
// documento _id:'notificaciones'. Es, a propósito, el primer rincón de lo
// que Mato planteó como un futuro menú de Configuración más grande
// (activar/desactivar calendarios, accesos, etc. — ver roadmap-modulos.md
// en el proyecto de Cowork). Vive en el panel de Usuarios y roles porque ya
// es el lugar donde se administran accesos.
//
// Las alertas que ve cada usuario se filtran, además, por los módulos que
// realmente tiene habilitados: no tiene sentido mostrarle a alguien sin
// acceso a Obras un vencimiento de una tarea de obra.
//
// Endpoints:
//   GET  /api/notificaciones         -> { items: [...], config }
//   GET  /api/notificaciones/config  -> config actual (para pintar los
//                                        checkboxes en Usuarios y roles)
//   PUT  /api/notificaciones/config  -> cambia la config — requiere el
//                                        módulo 'usuarios' (no se suma un
//                                        módulo nuevo para esto)
//
// Integración (en server.js):
//   const notificacionesRouter = require('./notificaciones');
//   app.use('/api/notificaciones', notificacionesRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario, tieneModulo } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
  }
  return mongoClient.db(DB_NAME);
}

async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    try { if (mongoClient) await mongoClient.close(); } catch (_) {}
    mongoClient = null;
    return await fn();
  }
}

const CONFIG_ID = 'notificaciones';
const CONFIG_DEFAULT = { crm: true, visitas: true, obras: true };

async function leerConfig() {
  return conReintento(async () => {
    const db = await getDb();
    const doc = (await db.collection('configuracion').findOne({ _id: CONFIG_ID })) || {};
    return {
      crm: doc.crm !== undefined ? !!doc.crm : CONFIG_DEFAULT.crm,
      visitas: doc.visitas !== undefined ? !!doc.visitas : CONFIG_DEFAULT.visitas,
      obras: doc.obras !== undefined ? !!doc.obras : CONFIG_DEFAULT.obras
    };
  });
}

// Argentina no tiene horario de verano: offset fijo -03:00. Mismo criterio
// ya usado en visitas.js (parsearFechaHoraLocal) y crm.js
// (normalizarProximaAccion) para no correrse un día con fechas "solo día" —
// acá se usa para decidir "hoy a la medianoche en Argentina", el corte que
// separa "vence hoy" de "ya venció".
function inicioDeHoyArgentina() {
  const ahoraAR = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(ahoraAR.getUTCFullYear(), ahoraAR.getUTCMonth(), ahoraAR.getUTCDate(), 3, 0, 0, 0));
}

const TIPOS_PROXIMA_ACCION = { rellamar: 'Rellamar', recontactar: 'Recontactar', enviar_info: 'Enviar información', otro: 'Otro' };

router.get('/', authUsuario, async (req, res) => {
  try {
    const config = await leerConfig();
    const hoyAR = inicioDeHoyArgentina();
    const ahora = new Date();
    const puedeVisitas = tieneModulo(req.usuario, 'visitas');
    const puedeObras = tieneModulo(req.usuario, 'obras');
    const items = [];

    await conReintento(async () => {
      const db = await getDb();

      if (config.crm && puedeVisitas) {
        const oportunidades = await db.collection('oportunidades')
          .find({ estado: 'activa', 'proximaAccion.fecha': { $ne: null, $lt: hoyAR } })
          .sort({ 'proximaAccion.fecha': 1 })
          .limit(50)
          .toArray();
        for (const o of oportunidades) {
          items.push({
            tipo: 'crm',
            id: String(o._id),
            titulo: (o.cliente && o.cliente.nombre) || 'Oportunidad sin nombre',
            subtitulo: (TIPOS_PROXIMA_ACCION[o.proximaAccion.tipo] || 'Próxima acción') + (o.proximaAccion.nota ? ' — ' + o.proximaAccion.nota : ''),
            fecha: o.proximaAccion.fecha
          });
        }
      }

      if (config.visitas && puedeVisitas) {
        const visitas = await db.collection('visitas')
          .find({ estado: 'sin_visita', fechaHora: { $lt: ahora } })
          .sort({ fechaHora: 1 })
          .limit(50)
          .toArray();
        for (const v of visitas) {
          items.push({
            tipo: 'visita',
            id: String(v._id),
            titulo: (v.cliente && v.cliente.nombre) || 'Visita sin nombre',
            subtitulo: 'Visita sin confirmar' + (v.vendedorNombre ? ' — ' + v.vendedorNombre : ''),
            fecha: v.fechaHora
          });
        }
      }

      if (config.obras && puedeObras) {
        const obras = await db.collection('obras')
          .find({
            estado: { $nin: ['terminada', 'cancelada'] },
            tareas: { $elemMatch: { estado: { $ne: 'terminada' }, fechaFinEstimada: { $ne: null, $lt: hoyAR } } }
          })
          .limit(50)
          .toArray();
        for (const o of obras) {
          for (const t of (o.tareas || [])) {
            if (t.estado !== 'terminada' && t.fechaFinEstimada && t.fechaFinEstimada < hoyAR) {
              items.push({
                tipo: 'obra',
                id: String(o._id),
                titulo: `Obra #${o.numero} — ${(o.cliente && o.cliente.nombre) || ''}`,
                subtitulo: `${t.tipoTrabajo} — fin estimado vencido`,
                fecha: t.fechaFinEstimada
              });
            }
          }
        }
      }
    });

    items.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    res.json({ items, config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/config', authUsuario, async (req, res) => {
  try { res.json(await leerConfig()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/config', authUsuario, async (req, res) => {
  try {
    if (!tieneModulo(req.usuario, 'usuarios')) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso a Usuarios y roles, que es donde vive esta configuración.' });
    }
    const { crm, visitas, obras } = req.body || {};
    const set = {};
    if (crm !== undefined) set.crm = !!crm;
    if (visitas !== undefined) set.visitas = !!visitas;
    if (obras !== undefined) set.obras = !!obras;
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('configuracion').updateOne({ _id: CONFIG_ID }, { $set: set }, { upsert: true });
    });
    res.json(await leerConfig());
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
