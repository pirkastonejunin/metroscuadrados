// Rubros unificados con Tiendanube (7/11/2026). Lógica pura, sin base de datos.
const assert = require('assert'); const R = require('../rubrosTn'); const { filaDeProductoMaxipiso } = require('../portalesProveedores');
const rub = [{ _id: 'r1', nombre: 'Porcelanatos', tnCategoriaId: 10 }, { _id: 'r2', nombre: 'Pisos Cerámicos', tnCategoriaId: 20 }, { _id: 'r3', nombre: 'Adhesivos' }];
const sub = [{ nombre: 'Esmaltados', rubroId: 'r1', rubroNombre: 'Porcelanatos', tnCategoriaId: 11 }];
const base = { rubros: rub, subs: sub };
assert.deepEqual(R.resolver(base, 'Porcelanato'), { rubro: 'Porcelanatos', subrubro: '' }, 'singular/plural');
assert.deepEqual(R.resolver(base, 'PORCELANATOS'), { rubro: 'Porcelanatos', subrubro: '' });
assert.deepEqual(R.resolver(base, 'esmaltado'), { rubro: 'Porcelanatos', subrubro: 'Esmaltados' }, 'subrubro');
assert.deepEqual(R.resolver(base, 'Cerámicos'), { rubro: 'Pisos Cerámicos', subrubro: '' }, 'parecido');
assert.deepEqual(R.resolver(base, 'Sanitarios'), { rubro: '', subrubro: '' }, 'sin coincidencia');
assert.deepEqual(R.resolver(base, ''), { rubro: '', subrubro: '' });
const m = R.mapaCategorias(base);
assert.equal(R.categoriaDe(m, 'Porcelanatos', 'Esmaltados'), 11); assert.equal(R.categoriaDe(m, 'Porcelanatos', ''), 10);
assert.equal(R.categoriaDe(m, 'Porcelanatos', 'Otro'), 10); assert.equal(R.categoriaDe(m, 'Adhesivos', ''), null);
const f = filaDeProductoMaxipiso({ sku: 'A', nombre: 'N', marca: 'Chiusaroli', _tablaLabel: 'Porcelanatos', precioM2: 5 }, 0);
assert.equal(f.rubroPortal, 'Porcelanatos'); assert.equal(f.marca, 'Chiusaroli');
console.log('OK');
