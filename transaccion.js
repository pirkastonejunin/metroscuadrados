// Transacciones de MongoDB (auditoría 3/11/2026): una venta (o su anulación, entrega o cobro) se guarda COMPLETA o no se
// guarda nada. Antes cada paso (venta, cuenta corriente, stock, remito, caja) se escribía por separado y un error a mitad
// de camino dejaba, por ejemplo, la venta sin su deuda en la cuenta corriente.
// `correr(client, db, fn)` ejecuta fn(dbTx) dentro de una transacción; dbTx es el mismo db, pero cada operación de sus
// colecciones lleva la sesión de la transacción, así las funciones auxiliares que reciben `db` quedan adentro sin cambios.
// Si la base no admite transacciones (un Mongo suelto, sin réplicas: solo en pruebas locales) se ejecuta como antes.
// Posición del argumento de opciones de cada método de colección.
const POS_OPCIONES = { insertOne: 1, insertMany: 1, updateOne: 2, updateMany: 2, replaceOne: 2, deleteOne: 1, deleteMany: 1,
  findOne: 1, find: 1, findOneAndUpdate: 2, findOneAndDelete: 1, findOneAndReplace: 2, countDocuments: 1, aggregate: 1, distinct: 2, bulkWrite: 1 };

function colConSesion(col, session) {
  return new Proxy(col, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      if (!(p in POS_OPCIONES)) return v.bind(t);
      const pos = POS_OPCIONES[p];
      return (...args) => {
        while (args.length < pos) args.push({}); // filtro vacío si no vino (find(), countDocuments())
        args[pos] = Object.assign({}, args[pos] || {}, { session });
        return v.apply(t, args);
      };
    }
  });
}
function dbConSesion(db, session) {
  return new Proxy(db, {
    get(t, p) {
      if (p === 'collection') return (nombre, o) => colConSesion(t.collection(nombre, o), session);
      const v = t[p];
      return typeof v === 'function' ? v.bind(t) : v;
    }
  });
}
const sinSoporte = e => /Transaction numbers are only allowed on a replica set|transactions are not supported|IllegalOperation.*transaction/i.test(String(e && e.message));
let soportaTransacciones = null; // se descubre la primera vez

async function correr(client, db, fn) {
  if (soportaTransacciones === false || process.env.SIN_TRANSACCIONES === '1') return fn(db);
  const session = client.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(dbConSesion(db, session)); }, { readPreference: 'primary', readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    soportaTransacciones = true;
    return out;
  } catch (e) {
    if (soportaTransacciones !== true && sinSoporte(e)) { soportaTransacciones = false; return fn(db); }
    throw e;
  } finally { await session.endSession().catch(() => {}); }
}
module.exports = { correr, dbConSesion };
