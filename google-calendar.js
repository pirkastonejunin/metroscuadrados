// ---------------------------------------------------------------------------
// Sincronización con Google Calendar — módulo compartido por obras.js y
// visitas.js.
//
// Usa una Service Account de Google (sin pantalla de login ni consentimiento
// por usuario): se crea UNA vez en Google Cloud Console, y esa cuenta de
// servicio necesita permiso de "Hacer cambios en los eventos" sobre CADA
// calendario de Google al que se le vayan a escribir eventos — ver el
// instructivo de configuración (GOOGLE_CALENDAR_SETUP.md) para los pasos
// completos.
//
// A diferencia de la versión original (un solo calendario compartido para
// toda la empresa), cada llamada a upsertEvento/eliminarEvento recibe el id
// del calendario destino: las visitas van al calendario del vendedor
// (visitas_vendedores.googleCalendarId) y las obras al del colocador
// (obras_colocadores.googleCalendarId) — cada uno configurable en su ficha
// del panel. Si esa persona todavía no tiene calendario propio cargado, se
// usa GOOGLE_CALENDAR_ID como calendario general de respaldo (para que el
// evento no se pierda mientras se va completando la carga persona por
// persona); si tampoco hay uno general configurado, esa sincronización en
// particular se salta sin romper nada.
//
// Si las variables de entorno no están cargadas, la sincronización queda
// desactivada SIN romper nada del resto de la app: obras.js y visitas.js
// siguen funcionando igual, simplemente no se crean eventos. Lo mismo si
// Google Calendar devuelve un error en algún momento: se loguea en la
// consola del servidor y se sigue — nunca se corta la creación/edición de
// una obra o visita por un problema del lado de Calendar.
//
// Variables de entorno (Render → Environment):
//   GOOGLE_SERVICE_ACCOUNT_KEY -> el contenido COMPLETO del archivo .json
//                                 de credenciales de la cuenta de servicio,
//                                 tal cual lo descarga Google Cloud Console
//                                 (pegarlo entero como valor de la variable)
//   GOOGLE_CALENDAR_ID         -> (opcional) id de un calendario general de
//                                 respaldo, para vendedores/colocadores que
//                                 todavía no tengan su propio calendario
//                                 cargado en su ficha del panel
// ---------------------------------------------------------------------------

let calendarClientOverride = null; // solo lo usan los tests
let calendarClientCache = null;
let googleApisLoadFallo = false;

// "Habilitado" acá significa que la cuenta de servicio está configurada
// (precondición para poder sincronizar con CUALQUIER calendario) — ya no
// depende de GOOGLE_CALENDAR_ID, que ahora es opcional (solo el calendario
// de respaldo).
function habilitado() {
  return !!(calendarClientOverride || process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
}

// Los tests inyectan acá un cliente falso con .events.insert/update/delete,
// para no depender de la librería googleapis ni de credenciales reales.
function _setClienteParaTests(clienteFalso) {
  calendarClientOverride = clienteFalso;
  googleApisLoadFallo = false;
}

function getCalendarClient() {
  if (calendarClientOverride) return calendarClientOverride;
  if (calendarClientCache) return calendarClientCache;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;
  if (googleApisLoadFallo) return null;
  try {
    const { google } = require('googleapis');
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/calendar']
    });
    calendarClientCache = google.calendar({ version: 'v3', auth });
    return calendarClientCache;
  } catch (e) {
    console.error('Google Calendar: no se pudo inicializar (revisá GOOGLE_SERVICE_ACCOUNT_KEY):', e.message);
    googleApisLoadFallo = true;
    return null;
  }
}

function armarRequestBody(eventoBase) {
  return {
    summary: eventoBase.titulo,
    description: eventoBase.descripcion || '',
    location: eventoBase.ubicacion || '',
    start: { dateTime: new Date(eventoBase.inicio).toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
    end: { dateTime: new Date(eventoBase.fin).toISOString(), timeZone: 'America/Argentina/Buenos_Aires' }
  };
}

// Crea el evento si googleEventId es null/undefined, o lo actualiza si ya
// existe, en el calendario "calendarId" indicado (el del vendedor o
// colocador correspondiente — ver arriba). Si no se pasa uno, cae al
// calendario general de respaldo (GOOGLE_CALENDAR_ID); si tampoco hay uno
// configurado, no hace nada. Devuelve el googleEventId a guardar (nuevo o
// el mismo), o el googleEventId original (puede ser null) si la
// integración no está configurada o algo falló — nunca tira una excepción
// hacia quien la llama, para no romper el flujo principal de
// obras.js/visitas.js.
async function upsertEvento(googleEventId, eventoBase, calendarId) {
  const cal = getCalendarClient();
  if (!cal) return googleEventId || null;
  const calId = calendarId || process.env.GOOGLE_CALENDAR_ID;
  if (!calId) return googleEventId || null; // sin calendario propio ni general: no hay dónde sincronizar
  try {
    // armarRequestBody va DENTRO del try: si eventoBase trae una fecha
    // inválida o vacía (puede pasar con tareas viejas que ya tenían una
    // fechaFinEstimada rota, de antes de que el panel dejara de pedirla),
    // new Date(...).toISOString() tira una excepción — y como esta función
    // no debe romper nunca el flujo de obras.js/visitas.js (ver comentario
    // de arriba), tiene que quedar atrapada acá adentro.
    const requestBody = armarRequestBody(eventoBase);
    if (googleEventId) {
      const r = await cal.events.update({ calendarId: calId, eventId: googleEventId, requestBody });
      return r.data.id;
    }
    const r = await cal.events.insert({ calendarId: calId, requestBody });
    return r.data.id;
  } catch (e) {
    // Si el evento fue borrado a mano en Google Calendar, se recrea en vez
    // de fallar para siempre.
    if (googleEventId && (e.code === 404 || e.code === 410)) {
      try {
        const r = await cal.events.insert({ calendarId: calId, requestBody });
        return r.data.id;
      } catch (e2) {
        console.error('Google Calendar: error recreando evento:', e2.message);
        return googleEventId;
      }
    }
    console.error('Google Calendar: error sincronizando evento:', e.message);
    return googleEventId || null;
  }
}

async function eliminarEvento(googleEventId, calendarId) {
  const cal = getCalendarClient();
  if (!cal || !googleEventId) return;
  const calId = calendarId || process.env.GOOGLE_CALENDAR_ID;
  if (!calId) return;
  try {
    await cal.events.delete({ calendarId: calId, eventId: googleEventId });
  } catch (e) {
    // 404/410: ya no existe (por ejemplo, lo borraron a mano, o ya se había
    // borrado de este mismo calendario antes) — no es un error real.
    if (e.code !== 404 && e.code !== 410) {
      console.error('Google Calendar: error borrando evento:', e.message);
    }
  }
}

module.exports = { upsertEvento, eliminarEvento, habilitado, _setClienteParaTests };
