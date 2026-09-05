process.env.MONGODB_URI = 'mongodb://stub';
process.env.USER_AGENT = 'stub';

const { calcularCotizacion } = require('./cotizador');
const assert = require('assert');

// Caso 1: piso + zocalo + puertas + nivelacion, con mano de obra
const r1 = calcularCotizacion({
  obra: { m2Pisos: 52, mlZocalos: 30, cantidadPuertas: 3, requiereNivelacion: true, manoObra: true },
  productos: {
    piso: { id: 1, nombre: 'Porcelanato Gris 60x60', tipo: 'm2', cobertura: 1.44, envase: 'caja', precio: 8500 },
    zocalo: { id: 2, nombre: 'Zócalo MDF 8cm', tipo: 'ml', cobertura: 2.4, envase: 'caja', precio: 4200 },
    puerta: { id: 3, nombre: 'Puerta Placa 70', tipo: 'unidad', cobertura: 1, envase: 'unidad', precio: 32000 },
    nivelacion: { id: 4, nombre: 'Nivelante Autonivelante 25kg', tipo: 'm2', cobertura: 5, envase: 'bolsa', precio: 6000 }
  },
  tarifas: { pisos_m2: 3500, zocalos_ml: 800, puertas_unidad: 15000, nivelacion_m2: 1200 }
});

console.log(JSON.stringify(r1, null, 2));

assert.strictEqual(r1.faltantes.length, 0);
// piso: 52/1.44 = 36.11 -> 37 cajas * 8500 = 314500
const piso = r1.items.find(i => i.rubro === 'Piso');
assert.strictEqual(piso.paquetesNecesarios, 37);
assert.strictEqual(piso.subtotal, 37 * 8500);

// zocalo: 30/2.4 = 12.5 -> 13 cajas * 4200 = 54600
const zocalo = r1.items.find(i => i.rubro === 'Zócalo');
assert.strictEqual(zocalo.paquetesNecesarios, 13);

// puertas: 3/1 = 3 * 32000 = 96000
const puerta = r1.items.find(i => i.rubro === 'Puerta');
assert.strictEqual(puerta.paquetesNecesarios, 3);
assert.strictEqual(puerta.subtotal, 96000);

// nivelacion: 52/5 = 10.4 -> 11 bolsas * 6000 = 66000
const nive = r1.items.find(i => i.rubro === 'Nivelación');
assert.strictEqual(nive.paquetesNecesarios, 11);

const totalProductosEsperado = piso.subtotal + zocalo.subtotal + puerta.subtotal + nive.subtotal;
assert.strictEqual(r1.totalProductos, totalProductosEsperado);

const manoObraEsperada = (52 * 3500) + (30 * 800) + (3 * 15000) + (52 * 1200);
assert.strictEqual(r1.totalManoObra, manoObraEsperada);
assert.strictEqual(r1.total, totalProductosEsperado + manoObraEsperada);

console.log('Caso 1 OK. Total:', r1.total);

// Caso 2: sin mano de obra, sin nivelacion, falta elegir producto de zocalo
const r2 = calcularCotizacion({
  obra: { m2Pisos: 20, mlZocalos: 10, cantidadPuertas: 0, requiereNivelacion: false, manoObra: false },
  productos: {
    piso: { id: 1, nombre: 'Piso X', tipo: 'm2', cobertura: 2, envase: 'caja', precio: 1000 }
    // zocalo no elegido -> debe aparecer en faltantes
  },
  tarifas: {}
});
assert.deepStrictEqual(r2.faltantes, ['zocalo']);
assert.strictEqual(r2.totalManoObra, 0);
console.log('Caso 2 OK (detecta producto faltante). Faltantes:', r2.faltantes);

// Caso 3: cobertura exacta no debe redondear de mas (tolerancia tsp)
const r3 = calcularCotizacion({
  obra: { m2Pisos: 10, mlZocalos: 0, cantidadPuertas: 0, requiereNivelacion: false, manoObra: false },
  productos: { piso: { id: 1, nombre: 'Piso exacto', tipo: 'm2', cobertura: 2, envase: 'caja', precio: 500 } },
  tarifas: {}
});
assert.strictEqual(r3.items[0].paquetesNecesarios, 5); // 10/2 = 5.0 exacto -> 5, no 6
console.log('Caso 3 OK (sin redondeo de mas en division exacta). Cajas:', r3.items[0].paquetesNecesarios);

console.log('\nTODOS LOS CASOS PASARON');
