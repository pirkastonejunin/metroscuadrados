// Descripción para Tiendanube armada con los datos del catálogo del portal (7/11/2026). No usa base de datos.
const assert = require('assert'); const { filaDeProductoMaxipiso } = require('../portalesProveedores');
const f = filaDeProductoMaxipiso({ sku: 'CH-1', nombre: 'Roma', marca: 'Chiusaroli', precioM2: 10, base: '2.26 m2', baseUm: 'm2', pesoCaja: 32, formato: '60 x 60 cm', espesor: '9 mm', terminacion: 'Mate', descripcion: '<p>Porcelanato rectificado</p>', precioCaja: 22, stock: 5, imagen: 'https://x/y.jpg' }, 0);
assert(/Medidas: 60 x 60 cm/.test(f.descripcion), f.descripcion); assert(/Espesor: 9 mm/.test(f.descripcion)); assert(/Terminación: Mate/.test(f.descripcion));
assert(/Porcelanato rectificado/.test(f.descripcion)); assert(/Cobertura por caja: 2.26 m²/.test(f.descripcion)); assert(/Peso por caja: 32 kg/.test(f.descripcion)); assert(!/precio|stock/i.test(f.descripcion));
assert.equal(filaDeProductoMaxipiso({ sku: 'X', nombre: 'N', precio: 5 }, 0).descripcion, '', 'sin datos no inventa nada');
console.log('OK');
