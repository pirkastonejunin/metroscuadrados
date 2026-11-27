// Una fecha elegida en un <input type="date"> tiene que caer en ESE día en Argentina (si no, el cobro de hoy no sale en el resumen diario de hoy).
const assert = require('assert');
const { fechaDeInput } = require('../fechaAR');
const dia = f => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(f);
assert.strictEqual(dia(fechaDeInput('2026-11-27')), '2026-11-27', 'el día elegido es el día guardado');
assert.strictEqual(dia(new Date('2026-11-27')), '2026-11-26', 'new Date("AAAA-MM-DD") caía el día anterior (el bug)');
assert.ok(fechaDeInput('2026-11-27') >= new Date('2026-11-27T00:00:00-03:00') && fechaDeInput('2026-11-27') <= new Date('2026-11-27T23:59:59-03:00'));
assert.strictEqual(fechaDeInput('2026-11-27T18:30:00-03:00').toISOString(), '2026-11-27T21:30:00.000Z', 'con hora se respeta');
assert.ok(Math.abs(fechaDeInput('') - Date.now()) < 2000 && Math.abs(fechaDeInput(undefined) - Date.now()) < 2000, 'vacío = ahora');
console.log('fecha AR: OK');
