// Vínculo obra -> cliente (7/10/2026). Las obras guardan al cliente como
// texto (nombre/teléfono). Para poder mostrarlas en la ficha del cliente se
// les guarda además `clienteId`, pero SOLO cuando hay UN único cliente
// existente que coincide; nunca se crea un cliente nuevo (para no duplicar)
// y, si hay 0 o varios candidatos, queda sin vincular.
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
function digitos(s) { return String(s || '').replace(/\D/g, ''); }

function nombresDe(c) {
  return [c.apellidoRazonSocial, c.nombreFantasia,
    [c.nombre, c.apellidoRazonSocial].filter(Boolean).join(' '),
    [c.apellidoRazonSocial, c.nombre].filter(Boolean).join(' ')].map(norm).filter(Boolean);
}
function telefonosDe(c) { return [c.telefono, c.celular].map(digitos).filter(t => t.length >= 6); }

// clientes: lista [{_id, ...}] de la organización. Devuelve _id o null.
function elegirClienteUnico(clientes, { nombre, telefono }) {
  const n = norm(nombre);
  const t = digitos(telefono);
  if (n) {
    const porNombre = clientes.filter(c => nombresDe(c).includes(n));
    if (porNombre.length === 1) return porNombre[0]._id;
    if (porNombre.length > 1) return null;
  }
  if (t.length >= 6) {
    const porTel = clientes.filter(c => telefonosDe(c).includes(t));
    if (porTel.length === 1) return porTel[0]._id;
  }
  return null;
}

async function clientesActivos(db, orgId) {
  const q = { activo: { $ne: false } };
  if (orgId) q.orgId = orgId;
  return db.collection('clientes').find(q)
    .project({ apellidoRazonSocial: 1, nombre: 1, nombreFantasia: 1, telefono: 1, celular: 1 }).toArray();
}

async function buscarClienteUnico(db, orgId, datos) {
  try { return elegirClienteUnico(await clientesActivos(db, orgId), datos || {}); }
  catch (e) { return null; } // el vínculo es accesorio: nunca debe romper la creación de la obra
}

// Cliente de una VISITA para armar su presupuesto comercial (9/10/2026, pedido de Mato: "debería tomar el
// mismo cliente del nombre de la visita"). Busca por nombre (prefiere el que también coincide en teléfono);
// si no existe ninguno, crea el cliente con los datos de la visita. A diferencia de las obras, acá SÍ se crea.
async function clienteParaVisita(db, orgId, datos) {
  datos = datos || {};
  const n = norm(datos.nombre), t = digitos(datos.telefono);
  if (!n) { const e = new Error('La visita no tiene nombre de cliente.'); e.status = 400; throw e; }
  const todos = await clientesActivos(db, orgId);
  const porNombre = todos.filter(c => nombresDe(c).includes(n));
  if (porNombre.length) {
    const conTel = t.length >= 6 ? porNombre.find(c => telefonosDe(c).includes(t)) : null;
    return { clienteId: (conTel || porNombre[0])._id, creado: false, ambiguo: porNombre.length > 1 && !conTel };
  }
  if (t.length >= 6) {
    const porTel = todos.filter(c => telefonosDe(c).includes(t));
    if (porTel.length === 1) return { clienteId: porTel[0]._id, creado: false, ambiguo: false };
  }
  const ahora = new Date();
  const r = await db.collection('clientes').insertOne({
    apellidoRazonSocial: String(datos.nombre).trim(), categoriaFiscal: 'consumidor_final', telefono: String(datos.telefono || '').trim(),
    domicilio: String(datos.direccion || '').trim(), localidad: String(datos.localidad || '').trim(),
    origenCliente: 'Visita', activo: true, orgId, createdAt: ahora, updatedAt: ahora
  });
  return { clienteId: r.insertedId, creado: true, ambiguo: false };
}

module.exports = { elegirClienteUnico, clientesActivos, buscarClienteUnico, clienteParaVisita, norm, digitos };
