process.env.MONGODB_URI = 'mongodb://stub';
process.env.USER_AGENT = 'stub';

const { calcularCotizacion } = require('./cotizador');
const assert = require('assert');

// Caso 1: piso con desperdicio + zocalo + nivelador de puerta + nivelacion +
// manta, con mano de obra y varias formas de pago
const r1 = calcularCotizacion({
  obra: {
    m2Pisos: 52, mlZocalos: 30, cantidadPuertas: 3,
    requiereNivelacion: true, utilizaManta: true, manoObra: true, desperdicioPctPiso: 10
  },
  productos: {
    piso: { id: 1, nombre: 'Piso Flotante Roble 8mm', tipo: 'm2', cobertura: 1.44, envase: 'caja', precio: 8500, categoria: 'Pisos Flotantes' },
    zocalo: { id: 2, nombre: 'Zócalo MDF 8cm', tipo: 'ml', cobertura: 2.4, envase: 'caja', precio: 4200, categoria: 'Zócalos' },
    puerta: { id: 'nivPta1', nombre: 'Nivelador de puerta aluminio', tipo: 'unidad', cobertura: 1, envase: 'unidad', precio: 9500, categoria: 'Niveladores de puerta' },
    nivelacion: { id: 'nivPiso1', nombre: 'Nivelante Autonivelante 25kg', tipo: 'unidad', cobertura: 5, envase: 'unidad', precio: 6000, categoria: 'Nivelantes de piso' },
    manta: { id: 'manta1', nombre: 'Manta acústica 2mm', tipo: 'unidad', cobertura: 10, envase: 'unidad', precio: 3000, categoria: 'Manta' }
  },
  tarifas: { pisos_m2: 3500, zocalos_ml: 800, puertas_unidad: 15000, nivelacion_m2: 1200 },
  formasPago: [
    { nombre: 'Efectivo/Transferencia', tipo: 'descuento', porcentaje: 10 },
    { nombre: '3 cuotas', tipo: 'recargo', porcentaje: 15 },
    { nombre: 'Lista', tipo: 'descuento', porcentaje: 0 }
  ]
});

console.log(JSON.stringify(r1, null, 2));

assert.strictEqual(r1.faltantes.length, 0);

// piso CON 10% desperdicio: 52 * 1.10 = 57.2 m2 -> /1.44 = 39.72 -> 40 cajas * 8500
const piso = r1.items.find(i => i.rubro === 'Piso');
assert.strictEqual(piso.cantidadConDesperdicio, 57.2);
assert.strictEqual(piso.paquetesNecesarios, 40);
assert.strictEqual(piso.subtotal, 40 * 8500);

// zocalo SIN desperdicio: 30/2.4 = 12.5 -> 13 cajas
const zocalo = r1.items.find(i => i.rubro === 'Zócalo');
assert.strictEqual(zocalo.desperdicioPct, 0);
assert.strictEqual(zocalo.paquetesNecesarios, 13);

// nivelador de puerta: 3 puertas / 1 = 3 unidades
const puerta = r1.items.find(i => i.rubro === 'Nivelador de puerta');
assert.strictEqual(puerta.paquetesNecesarios, 3);
assert.strictEqual(puerta.subtotal, 3 * 9500);

// nivelacion de piso (ahora por SKU, sin rubro): 52/5 = 10.4 -> 11 unidades (sin desperdicio, item aparte)
const nive = r1.items.find(i => i.rubro === 'Nivelación de piso');
assert.strictEqual(nive.paquetesNecesarios, 11);

// manta (por SKU, sin rubro, sin desperdicio): 52/10 = 5.2 -> 6 unidades
const manta = r1.items.find(i => i.rubro === 'Manta');
assert.strictEqual(manta.paquetesNecesarios, 6);
assert.strictEqual(manta.subtotal, 6 * 3000);

const totalProductosEsperado = piso.subtotal + zocalo.subtotal + puerta.subtotal + nive.subtotal + manta.subtotal;
assert.strictEqual(r1.totalProductos, totalProductosEsperado);

// La manta NO tiene tarifa de mano de obra propia (va incluida en la de piso).
const manoObraEsperada = (52 * 3500) + (30 * 800) + (3 * 15000) + (52 * 1200);
assert.strictEqual(r1.totalManoObra, manoObraEsperada);
assert.strictEqual(r1.total, totalProductosEsperado + manoObraEsperada);

// Formas de pago: descuento resta, recargo suma, 0% deja el total igual
const fpEfectivo = r1.formasPago.find(f => f.nombre === 'Efectivo/Transferencia');
const fpCuotas = r1.formasPago.find(f => f.nombre === '3 cuotas');
const fpLista = r1.formasPago.find(f => f.nombre === 'Lista');
assert.strictEqual(fpEfectivo.total, Math.round(r1.total * 0.9 * 100) / 100);
assert.strictEqual(fpCuotas.total, Math.round(r1.total * 1.15 * 100) / 100);
assert.strictEqual(fpLista.total, r1.total);
assert.ok(fpEfectivo.total < r1.total);
assert.ok(fpCuotas.total > r1.total);

console.log('Caso 1 OK. Total base:', r1.total, '| Efectivo:', fpEfectivo.total, '| 3 cuotas:', fpCuotas.total);

// Caso 2: sin desperdicio (0% por defecto), sin mano de obra, sin manta,
// falta elegir zocalo
const r2 = calcularCotizacion({
  obra: { m2Pisos: 20, mlZocalos: 10, cantidadPuertas: 0, requiereNivelacion: false, utilizaManta: false, manoObra: false },
  productos: {
    piso: { id: 1, nombre: 'Piso X', tipo: 'm2', cobertura: 2, envase: 'caja', precio: 1000, categoria: 'Pisos Flotantes' }
  },
  tarifas: {},
  formasPago: []
});
assert.deepStrictEqual(r2.faltantes, ['zocalo']);
assert.strictEqual(r2.totalManoObra, 0);
assert.strictEqual(r2.items[0].desperdicioPct, 0);
assert.strictEqual(r2.formasPago.length, 0);
assert.strictEqual(r2.items.find(i => i.rubro === 'Manta'), undefined);
console.log('Caso 2 OK (sin desperdicio por defecto, sin manta, detecta producto faltante). Faltantes:', r2.faltantes);

// Caso 3: division exacta con desperdicio 0 no debe redondear de mas
const r3 = calcularCotizacion({
  obra: { m2Pisos: 10, mlZocalos: 0, cantidadPuertas: 0, requiereNivelacion: false, utilizaManta: false, manoObra: false, desperdicioPctPiso: 0 },
  productos: { piso: { id: 1, nombre: 'Piso exacto', tipo: 'm2', cobertura: 2, envase: 'caja', precio: 500, categoria: 'Pisos Flotantes' } },
  tarifas: {},
  formasPago: []
});
assert.strictEqual(r3.items[0].paquetesNecesarios, 5); // 10/2 = 5.0 exacto -> 5, no 6
console.log('Caso 3 OK (sin redondeo de mas en division exacta). Cajas:', r3.items[0].paquetesNecesarios);

// Caso 4: utiliza manta pero no se eligio producto -> debe faltar 'manta'
const r4 = calcularCotizacion({
  obra: { m2Pisos: 15, mlZocalos: 0, cantidadPuertas: 0, requiereNivelacion: false, utilizaManta: true, manoObra: false },
  productos: { piso: { id: 1, nombre: 'Piso Y', tipo: 'm2', cobertura: 2, envase: 'caja', precio: 1000, categoria: 'Pisos Flotantes' } },
  tarifas: {},
  formasPago: []
});
assert.deepStrictEqual(r4.faltantes, ['manta']);
console.log('Caso 4 OK (utiliza manta sin producto elegido detecta faltante).');

console.log('\nTODOS LOS CASOS PASARON');
