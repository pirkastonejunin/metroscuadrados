// Cuándo se puede repetir una operación de base de datos sin riesgo de duplicar (auditoría 3/11/2026).
// Antes, conReintento repetía TODA la operación ante cualquier error inesperado: si se cortaba la conexión después de
// guardar una venta, el segundo intento guardaba otra con otro número. Ahora solo se repite cuando el error indica que el
// cliente de Mongo estaba caído o no pudo elegir servidor (la operación no llegó a la base). Los cortes de red en medio de
// una escritura los reintenta el propio driver de MongoDB de forma segura (retryable writes).
const NOMBRES = new Set(['MongoServerSelectionError', 'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoPoolClosedError', 'MongoClientClosedError']);
function reintentable(e) {
  if (!e || e.status) return false; // rechazo de negocio (400/404…)
  if (NOMBRES.has(e.name)) return true;
  const m = String(e.message || '');
  return /Topology is closed|client must be connected|Client must be connected|MongoClient must be connected|connection pool .*closed|Server selection timed out/i.test(m);
}
module.exports = { reintentable };
