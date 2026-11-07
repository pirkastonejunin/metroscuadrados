// ---------------------------------------------------------------------------
// Rubros unificados con las categorías de Tiendanube (7/11/2026, pedido de Mato: "que el sistema respete los rubros que figuran en
// Tiendanube" y que al importar productos se asignen a uno de esos rubros, para que al enviarlos a Tiendanube caigan en su categoría).
//   - Cada categoría de primer nivel de Tiendanube = un rubro del sistema (productos_rubros_base, con tnCategoriaId).
//   - Cada categoría de segundo nivel o más = un subrubro de su rubro (productos_subrubros_base, con tnCategoriaId).
//   - resolver(): a partir del texto de categoría que trae el catálogo del proveedor devuelve { rubro, subrubro } de esa base, o vacío.
// ---------------------------------------------------------------------------
const clave = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const singular = s => s.split(' ').map(w => w.length > 3 ? w.replace(/(es|s)$/, '') : w).join(' ');

async function cargar(db, filtro) {
  const rubros = await db.collection('productos_rubros_base').find(Object.assign({ activo: { $ne: false } }, filtro)).toArray();
  const subs = await db.collection('productos_subrubros_base').find(Object.assign({ activo: { $ne: false } }, filtro)).toArray();
  return { rubros, subs };
}
// Devuelve { rubro, subrubro } (nombres de la base) o { rubro: '', subrubro: '' } si no hay coincidencia clara.
function resolver(base, texto) {
  const t = clave(texto); if (!t) return { rubro: '', subrubro: '' };
  const ts = singular(t);
  const igual = n => { const c = clave(n); return c === t || singular(c) === ts; };
  const parecido = n => { const c = clave(n); if (c.length < 4 || t.length < 4) return false; const cs = singular(c); return t.includes(c) || c.includes(t) || ts.includes(cs) || cs.includes(ts); };
  let s = base.subs.find(x => igual(x.nombre)); if (s) return { rubro: s.rubroNombre || '', subrubro: s.nombre };
  let r = base.rubros.find(x => igual(x.nombre)); if (r) return { rubro: r.nombre, subrubro: '' };
  const rs = base.rubros.filter(x => parecido(x.nombre)); if (rs.length === 1) return { rubro: rs[0].nombre, subrubro: '' };
  const ss = base.subs.filter(x => parecido(x.nombre)); if (ss.length === 1) return { rubro: ss[0].rubroNombre || '', subrubro: ss[0].nombre };
  return { rubro: '', subrubro: '' };
}
// Mapa rubro/subrubro → id de categoría de Tiendanube (el subrubro manda sobre el rubro).
function mapaCategorias(base) {
  const m = new Map(); const porId = new Map(base.rubros.map(r => [String(r._id), r]));
  base.rubros.forEach(r => { if (r.tnCategoriaId) m.set(clave(r.nombre), Number(r.tnCategoriaId)); });
  base.subs.forEach(s => { const r = porId.get(String(s.rubroId)); if (s.tnCategoriaId && r) m.set(clave(r.nombre) + '|' + clave(s.nombre), Number(s.tnCategoriaId)); });
  return m;
}
function categoriaDe(m, rubro, subrubro) {
  if (subrubro && m.has(clave(rubro) + '|' + clave(subrubro))) return m.get(clave(rubro) + '|' + clave(subrubro));
  return m.get(clave(rubro)) || null;
}
// Crea/actualiza rubros y subrubros a partir de las categorías de Tiendanube [{id, nombre, padre}]. No borra nada.
async function sincronizar(db, orgId, categorias) {
  const porId = new Map(categorias.map(c => [c.id, c])); const ahora = new Date();
  const nivel1De = c => { let x = c, g = 0; while (x && x.padre && porId.get(x.padre) && g++ < 10) x = porId.get(x.padre); return x; };
  const base = await cargar(db, { orgId });
  const rubroPorClave = new Map(base.rubros.map(r => [clave(r.nombre), r]));
  let rubrosNuevos = 0, subsNuevos = 0, vinculados = 0;
  for (const c of categorias.filter(c => !c.padre || !porId.get(c.padre))) {
    let r = rubroPorClave.get(clave(c.nombre));
    if (!r) { const doc = { nombre: c.nombre, activo: true, orgId, tnCategoriaId: c.id, createdAt: ahora, updatedAt: ahora }; doc._id = (await db.collection('productos_rubros_base').insertOne(doc)).insertedId; r = doc; rubroPorClave.set(clave(c.nombre), r); rubrosNuevos++; }
    else if (Number(r.tnCategoriaId) !== c.id) { await db.collection('productos_rubros_base').updateOne({ _id: r._id }, { $set: { tnCategoriaId: c.id, activo: true, updatedAt: ahora } }); r.tnCategoriaId = c.id; vinculados++; }
  }
  const subs = await db.collection('productos_subrubros_base').find({ orgId }).toArray();
  for (const c of categorias.filter(c => c.padre && porId.get(c.padre))) {
    const top = nivel1De(c); const r = top && rubroPorClave.get(clave(top.nombre)); if (!r) continue;
    const s = subs.find(x => String(x.rubroId) === String(r._id) && clave(x.nombre) === clave(c.nombre));
    if (!s) { await db.collection('productos_subrubros_base').insertOne({ nombre: c.nombre, rubroId: r._id, rubroNombre: r.nombre, activo: true, orgId, tnCategoriaId: c.id, createdAt: ahora, updatedAt: ahora }); subsNuevos++; }
    else if (Number(s.tnCategoriaId) !== c.id) { await db.collection('productos_subrubros_base').updateOne({ _id: s._id }, { $set: { tnCategoriaId: c.id, activo: true, updatedAt: ahora } }); vinculados++; }
  }
  return { rubrosNuevos, subrubrosNuevos: subsNuevos, vinculados, categorias: categorias.length };
}
// Devuelve el id de categoría de TN para rubro/subrubro; si el sistema lo tiene y Tiendanube no, lo crea en Tiendanube y lo vincula.
// crearFn(nombre, padreId|null) → id nuevo. El sistema manda: lo que está en el sistema se refleja en la tienda.
async function asegurarCategoria(db, orgId, base, rubro, subrubro, crearFn) {
  const r = base.rubros.find(x => clave(x.nombre) === clave(rubro)); if (!r) return null;
  const ahora = new Date();
  if (!r.tnCategoriaId) { const id = await crearFn(r.nombre, null); if (!id) return null; r.tnCategoriaId = id; await db.collection('productos_rubros_base').updateOne({ _id: r._id }, { $set: { tnCategoriaId: id, updatedAt: ahora } }); }
  const s = subrubro && base.subs.find(x => String(x.rubroId) === String(r._id) && clave(x.nombre) === clave(subrubro));
  if (!s) return Number(r.tnCategoriaId);
  if (!s.tnCategoriaId) { const id = await crearFn(s.nombre, Number(r.tnCategoriaId)); if (!id) return Number(r.tnCategoriaId); s.tnCategoriaId = id; await db.collection('productos_subrubros_base').updateOne({ _id: s._id }, { $set: { tnCategoriaId: id, updatedAt: ahora } }); }
  return Number(s.tnCategoriaId);
}
module.exports = { asegurarCategoria, clave, cargar, resolver, mapaCategorias, categoriaDe, sincronizar };
