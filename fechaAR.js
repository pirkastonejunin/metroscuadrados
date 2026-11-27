// Fecha que viene de un <input type="date"> ("2026-11-27"): se guarda al MEDIODÍA de Argentina. Con new Date("2026-11-27") queda a medianoche UTC,
// o sea las 21:00 del día anterior en Argentina, y el cobro/gasto/movimiento cae en el día equivocado (resumen diario, filtros por día, informes).
// Si ya viene con hora (ISO completo), se respeta tal cual.
function fechaDeInput(v) {
  if (v === undefined || v === null || v === '') return new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) return new Date(String(v).trim() + 'T12:00:00-03:00');
  return new Date(v);
}
module.exports = { fechaDeInput };
