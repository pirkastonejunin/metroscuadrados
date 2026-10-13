// ---------------------------------------------------------------------------
// Catálogo compartido entre sucursales (13/10/2026, pedido de Mato: Pirka, Piedra Negra y Factory trabajan con la misma base de
// productos, los mismos depósitos (Junín y Colomé) y las mismas listas de precios; todos ven todo).
//
// Cómo funciona: las colecciones "compartidas" guardan todo bajo UNA sucursal matriz (Piedra Negra). Cuando está activado, cada
// consulta/escritura a esas colecciones cambia el `orgId` de la sucursal que opera por el de la matriz, así productos, listas,
// depósitos, stock y cotización del dólar son los mismos para todas. El resto (ventas, compras, caja, clientes...) sigue por sucursal.
// Se prende y apaga con el documento config_general { clave: 'catalogoCompartido', activo, matrizOrgId } (ver unificarCatalogo.js).
// Hay que cargarlo ANTES que el resto de los módulos (parchea la clase Collection del driver de MongoDB).
// ---------------------------------------------------------------------------
const mongodb = require('mongodb');
const { ObjectId, MongoClient } = mongodb;

const COLECCIONES = new Set(['productos_catalogo', 'productos_listas_precio', 'depositos', 'stock_actual', 'stock_movimientos', 'productos_rubros_base', 'productos_subrubros_base']);
const CLAVES_CONFIG = new Set(['cotizacionDolar']); // config_general: solo estas claves son compartidas

const estado = { activo: false, matriz: null };
let listoResolve; const listo = new Promise(r => { listoResolve = r; });

const plano = v => v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Array.isArray(v));
function reescribir(v) {
  if (Array.isArray(v)) return v.map(reescribir);
  if (!plano(v)) return v;
  const out = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (k === 'orgId') {
      if (x instanceof ObjectId) { out[k] = estado.matriz; continue; }
      if (x && typeof x === 'object' && Array.isArray(x.$in) && x.$in.some(i => i instanceof ObjectId)) { out[k] = estado.matriz; continue; }
    }
    out[k] = reescribir(x);
  }
  return out;
}
function esConfigCompartida(filtroODoc) {
  return !!filtroODoc && typeof filtroODoc === 'object' && CLAVES_CONFIG.has(filtroODoc.clave);
}
function aplica(nombre, primero) {
  if (!estado.activo || !estado.matriz) return false;
  if (COLECCIONES.has(nombre)) return true;
  return nombre === 'config_general' && esConfigCompartida(primero);
}

const ARG_FILTRO = { find: [0], findOne: [0], countDocuments: [0], distinct: [1], deleteOne: [0], deleteMany: [0], findOneAndDelete: [0],
  updateOne: [0, 1], updateMany: [0, 1], replaceOne: [0, 1], findOneAndUpdate: [0, 1], findOneAndReplace: [0, 1], insertOne: [0] };
for (const [metodo, idxs] of Object.entries(ARG_FILTRO)) {
  const original = mongodb.Collection.prototype[metodo];
  mongodb.Collection.prototype[metodo] = function (...args) {
    const primero = metodo === 'distinct' ? args[1] : args[0];
    if (aplica(this.collectionName, primero)) for (const i of idxs) if (args[i] !== undefined) args[i] = reescribir(args[i]);
    return original.apply(this, args);
  };
}
{
  const original = mongodb.Collection.prototype.insertMany;
  mongodb.Collection.prototype.insertMany = function (docs, ...resto) {
    if (aplica(this.collectionName, Array.isArray(docs) ? docs[0] : null)) docs = docs.map(reescribir);
    return original.call(this, docs, ...resto);
  };
}
{
  const original = mongodb.Collection.prototype.bulkWrite;
  mongodb.Collection.prototype.bulkWrite = function (ops, ...resto) {
    if (aplica(this.collectionName, null)) ops = ops.map(reescribir);
    return original.call(this, ops, ...resto);
  };
}
{
  const original = mongodb.Collection.prototype.aggregate;
  mongodb.Collection.prototype.aggregate = function (pipeline, ...resto) {
    if (aplica(this.collectionName, null) && Array.isArray(pipeline)) pipeline = pipeline.map(st => (st && st.$match ? { $match: reescribir(st.$match) } : st));
    return original.call(this, pipeline, ...resto);
  };
}

async function cargar() {
  let c;
  try {
    if (!process.env.MONGODB_URI) return;
    c = await new MongoClient(process.env.MONGODB_URI).connect();
    const d = await c.db('calculadora_m2').collection('config_general').findOne({ clave: 'catalogoCompartido' });
    if (d && d.activo && d.matrizOrgId) { estado.activo = true; estado.matriz = new ObjectId(String(d.matrizOrgId)); }
    else { estado.activo = false; estado.matriz = null; }
  } catch (e) { console.error('Catálogo compartido: no se pudo leer la configuración:', e.message); }
  finally { if (c) await c.close().catch(() => {}); listoResolve(); }
}
function recargar() { return cargar(); }
// Si hay otras instancias del servidor, tomar los cambios de configuración cada minuto
setInterval(() => { cargar().catch(() => {}); }, 60000).unref();
cargar();

module.exports = { estado, listo, recargar, reescribir, COLECCIONES };
