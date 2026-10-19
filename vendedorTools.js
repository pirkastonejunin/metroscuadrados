// ---------------------------------------------------------------------------
// Herramientas de datos reales para el vendedor digital (Fase 1, 19/10/2026). Son de SOLO LECTURA y reutilizan lo que ya existe:
//  - productos_catalogo + lista "Consumidor Final" (precioResuelto de productos.js) + IVA según la lista / configuración fiscal.
//  - stock_actual (disponible = cantidad - comprometida, sumado entre depósitos de la sucursal).
// Reglas de negocio acordadas con Mato:
//  - Precios siempre FINALES (con IVA, consumidor final).
//  - Stock: solo "disponible" o "consultar". Nunca se le entregan cantidades al modelo, así que no puede decirlas.
//  - Si algo no se puede resolver (sin precio cargado, sin dato de rendimiento) la herramienta lo dice y el bot deriva a un asesor.
// ---------------------------------------------------------------------------
const { ObjectId } = require('mongodb');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const esM2 = (u) => /^(m2|m²|mts?2|metros?\s*cuadrados?)$/i.test(String(u || '').trim());

// ---- enlaces a la tienda online (Tiendanube) ----
// El producto del sistema se vincula con la tienda por su SKU (skuTiendanube). El link se pide a Tiendanube y se guarda en memoria un rato.
const cacheLinks = new Map();
let buscadorLinks = async (sku) => { const r = await require('./cotizador').buscarProductoTiendanubePorSku(sku); return r && r.url ? r.url : null; };
async function enlaceDe(sku) {
  if (!sku) return null;
  const k = String(sku).toUpperCase(), c = cacheLinks.get(k);
  if (c && Date.now() - c.t < (c.v ? 6 * 3600e3 : 10 * 60e3)) return c.v;
  let v = null;
  try { v = await Promise.race([buscadorLinks(sku), new Promise(r => setTimeout(() => r(null), 4000))]); } catch (e) { v = null; }
  cacheLinks.set(k, { t: Date.now(), v }); if (cacheLinks.size > 3000) cacheLinks.delete(cacheLinks.keys().next().value);
  return v;
}
const MODOS = ['precio', 'link', 'link_o_precio'];

// ---- búsqueda ----
const ACENTOS = { a: 'aáàäâ', e: 'eéèëê', i: 'iíìïî', o: 'oóòöô', u: 'uúùüû', n: 'nñ' };
function sinAcentos(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function escapar(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function patronDeToken(t) {
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/); // 60x60 -> 60 x 60, 60X60, 60×60
  if (m) return m[1].replace(',', '[.,]') + '\\s*[x×*]\\s*' + m[2].replace(',', '[.,]');
  // plural/singular: "ranurados" también encuentra "ranurado"; "paredes" encuentra "pared"
  const vars = [t]; if (t.length > 4 && t.endsWith('s')) vars.push(t.slice(0, -1)); if (t.length > 5 && t.endsWith('es')) vars.push(t.slice(0, -2));
  const conAcentos = (x) => escapar(x).replace(/[aeioun]/g, (c) => '[' + ACENTOS[c] + ']');
  return vars.length > 1 ? '(?:' + vars.map(conAcentos).join('|') + ')' : conAcentos(t);
}
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'para', 'con', 'por', 'y', 'en', 'que', 'tienen', 'tenes', 'tenés', 'hay', 'precio', 'cuanto', 'cuánto', 'sale', 'cuesta', 'quiero', 'necesito', 'busco', 'me', 'si', 'algo', 'tipo']);
function tokensDe(consulta) {
  const lim = sinAcentos(consulta).replace(/(\d)\s*(?:x|×|\*|por)\s*(\d)/g, '$1x$2').replace(/[^a-z0-9.,x×*\s]/g, ' ');
  return Array.from(new Set(lim.split(/\s+/).filter(t => t && t.length > 1 && !PALABRAS_VACIAS.has(t)))).slice(0, 6);
}

async function listaConsumidorFinal(db, orgId) {
  return (await db.collection('productos_listas_precio').findOne({ orgId, predeterminada: true }))
    || (await db.collection('productos_listas_precio').findOne({ orgId, nombre: /consumidor/i }));
}
async function ivaIncluido(db, orgId, lista) {
  if (lista && typeof lista.incluyeIva === 'boolean') return lista.incluyeIva;
  try { const cfg = await require('./fiscalEmision').getConfig(db, orgId); return cfg.preciosIncluyenIvaDefecto !== false; } catch (e) { return true; }
}
async function ivaDefecto(db, orgId) { try { const cfg = await require('./fiscalEmision').getConfig(db, orgId); return cfg.ivaDefecto === undefined ? 21 : Number(cfg.ivaDefecto); } catch (e) { return 21; } }

// Precio final (con IVA) por unidad de venta. null si el producto no tiene precio cargado.
function precioFinalDe(producto, lista, incluyeIva, ivaDef, cotizacion) {
  let precio;
  try { precio = require('./productos').precioResuelto(producto, lista || { predeterminada: true, _id: new ObjectId() }, cotizacion).precio; } catch (e) { precio = producto.precio != null ? producto.precio : null; }
  if (precio == null || !(Number(precio) > 0)) return null;
  const iva = (producto.porcentajeIva !== undefined && producto.porcentajeIva !== null && producto.porcentajeIva !== '') ? Number(producto.porcentajeIva) : ivaDef;
  return round2(incluyeIva ? Number(precio) : Number(precio) * (1 + (isFinite(iva) ? iva : 21) / 100));
}

// Disponibilidad sin cantidades: 'disponible' | 'consultar'
async function disponibilidades(db, orgId, ids) {
  const out = new Map(); if (!ids.length) return out;
  const filas = await db.collection('stock_actual').aggregate([
    { $match: { orgId, productoId: { $in: ids } } },
    { $group: { _id: '$productoId', disp: { $sum: { $subtract: [{ $ifNull: ['$cantidad', 0] }, { $ifNull: ['$cantidadComprometida', 0] }] } } } }
  ]).toArray();
  for (const f of filas) out.set(String(f._id), f.disp);
  return out; // número interno: nunca se le pasa al modelo
}

async function buscarProductos(db, orgId, args, modo) {
  modo = MODOS.includes(modo) ? modo : 'precio';
  const consulta = String((args && args.consulta) || '').slice(0, 200);
  const limite = Math.min(Math.max(parseInt(args && args.limite, 10) || 6, 1), 10);
  const tokens = tokensDe(consulta);
  if (!tokens.length) return { productos: [], aviso: 'Consulta vacía: pedile al cliente qué producto busca.' };
  const base = { orgId, activo: { $ne: false } };
  const campos = (re) => ({ $or: [{ nombre: re }, { sku: re }, { marca: re }, { rubro: re }, { subrubro: re }] });
  const regs = tokens.map(t => new RegExp(patronDeToken(t), 'i'));
  const proj = { sku: 1, nombre: 1, marca: 1, rubro: 1, subrubro: 1, unidad: 1, unidadesPorBulto: 1, indicaCtdBultos: 1, precio: 1, preciosPorLista: 1, porcentajeIva: 1, descripcion: 1, stockeable: 1, moneda: 1, costo: 1, skuTiendanube: 1 };
  let cand = await db.collection('productos_catalogo').find(Object.assign({ $and: regs.map(campos) }, base)).project(proj).limit(60).toArray();
  if (!cand.length && regs.length > 1) { // sin coincidencia exacta: alcanza con la mayoría de las palabras
    const flojo = await db.collection('productos_catalogo').find(Object.assign({ $or: regs.map(r => campos(r)) }, base)).project(proj).limit(300).toArray();
    const puntaje = (p) => { const txt = sinAcentos([p.nombre, p.sku, p.marca, p.rubro, p.subrubro].join(' ')); return regs.filter(r => r.test(txt) || r.test([p.nombre, p.marca, p.rubro, p.subrubro].join(' '))).length; };
    cand = flojo.map(p => ({ p, s: puntaje(p) })).filter(x => x.s >= Math.max(2, Math.ceil(regs.length / 2))).sort((a, b) => b.s - a.s).slice(0, 60).map(x => x.p);
  }
  if (!cand.length) return { productos: [], aviso: 'No encontré productos con esa búsqueda. No inventes: ofrecé derivar a un asesor o pedí más datos.' };
  const lista = await listaConsumidorFinal(db, orgId), inc = await ivaIncluido(db, orgId, lista), ivaDef = await ivaDefecto(db, orgId);
  const cotDoc = await db.collection('config_general').findOne({ orgId, clave: 'cotizacionDolar' }); const cot = cotDoc ? cotDoc.valor : null;
  // los que tienen precio primero, luego los más cortos (más específicos)
  const conPrecio = cand.map(p => ({ p, precio: precioFinalDe(p, lista, inc, ivaDef, cot) }));
  conPrecio.sort((a, b) => (b.precio != null) - (a.precio != null) || String(a.p.nombre).length - String(b.p.nombre).length);
  const top = conPrecio.slice(0, limite);
  const disp = await disponibilidades(db, orgId, top.map(x => x.p._id));
  const links = modo === 'precio' ? top.map(() => null) : await Promise.all(top.map(x => enlaceDe(x.p.skuTiendanube)));
  return {
    productos: top.map(({ p, precio }, i) => {
      const upb = Number(p.unidadesPorBulto) > 0 ? Number(p.unidadesPorBulto) : null;
      const o = {
        id: String(p._id), nombre: p.nombre, marca: p.marca || '', rubro: [p.rubro, p.subrubro].filter(Boolean).join(' / '),
        unidadDeVenta: p.unidad || 'unidad',
        disponibilidad: (p.stockeable !== false && (disp.get(String(p._id)) || 0) > 0) ? 'disponible' : 'consultar'
      };
      const enlace = links[i];
      if (enlace) o.enlaceTienda = enlace;
      const conPrecio = modo === 'precio' || (modo === 'link_o_precio' && !enlace);
      if (conPrecio) o.precioFinalConIva = precio; // por unidadDeVenta; null = sin precio cargado: derivar
      else if (!enlace) o.sinEnlace = 'No tiene link en la tienda online: el precio lo confirma un asesor.';
      if (upb && upb > 1) { o.unidadesPorBulto = upb; if (conPrecio && precio != null && esM2(p.unidad)) o.precioFinalPorCajaConIva = round2(precio * upb); }
      if (p.descripcion) o.descripcion = String(p.descripcion).slice(0, 240);
      return o;
    }),
    totalEncontrados: cand.length + (cand.length >= 60 ? '+' : ''), mostrados: top.length,
    nota: (cand.length > top.length ? 'Hay más productos que los mostrados: ofrecé acotar (formato, color, marca) o ver más. ' : '') + (modo === 'precio' ? 'Los precios ya incluyen IVA (consumidor final). ' : modo === 'link' ? 'No des precios: compartí el enlaceTienda para que el cliente vea el precio en la tienda. ' : 'Si hay enlaceTienda compartilo (sin precio); si no hay, usá el precio indicado. ') + 'Disponibilidad: "disponible" o "consultar" (nunca digas cantidades).'
  };
}

async function calcularMaterial(db, orgId, args, modo) {
  modo = MODOS.includes(modo) ? modo : 'precio';
  let id; try { id = new ObjectId(String(args && args.productoId)); } catch (e) { return { error: 'productoId inválido: usá el id que devolvió buscar_productos.' }; }
  const m2 = Number(args && args.m2);
  if (!(m2 > 0) || m2 > 5000) return { error: 'Falta la superficie en m2 (número mayor que 0).' };
  const desp = args && args.desperdicioPct != null ? Number(args.desperdicioPct) : 10;
  if (!(desp >= 0 && desp <= 40)) return { error: 'El desperdicio debe estar entre 0 y 40 %.' };
  const p = await db.collection('productos_catalogo').findOne({ _id: id, orgId, activo: { $ne: false } });
  if (!p) return { error: 'No existe ese producto en esta sucursal.' };
  const upb = Number(p.unidadesPorBulto) > 0 ? Number(p.unidadesPorBulto) : null;
  if (!esM2(p.unidad) && !(upb && /m2|m²|metro/i.test(String(p.tipoUnidad || '') + ' ' + String(p.unidad || '')))) {
    return { error: 'Este producto no se vende por m2, no tengo su rendimiento cargado. Derivá a un asesor para el cálculo.' };
  }
  const lista = await listaConsumidorFinal(db, orgId), inc = await ivaIncluido(db, orgId, lista), ivaDef = await ivaDefecto(db, orgId);
  const cotDoc = await db.collection('config_general').findOne({ orgId, clave: 'cotizacionDolar' });
  const precio = precioFinalDe(p, lista, inc, ivaDef, cotDoc ? cotDoc.valor : null);
  const necesarios = round2(m2 * (1 + desp / 100));
  const cajas = upb ? Math.ceil(necesarios / upb - 1e-9) : null;
  const m2Comprados = upb ? round2(cajas * upb) : Math.ceil(necesarios);
  const disp = await disponibilidades(db, orgId, [p._id]); const d = disp.get(String(p._id)) || 0;
  const enlace = modo === 'precio' ? null : await enlaceDe(p.skuTiendanube);
  const conPrecio = modo === 'precio' || (modo === 'link_o_precio' && !enlace);
  const o = {
    producto: p.nombre, m2Pedidos: round2(m2), desperdicioPct: desp, m2ConDesperdicio: necesarios,
    cajas, m2PorCaja: upb, m2QueSeCompran: m2Comprados,
    disponibilidad: p.stockeable !== false && d >= m2Comprados ? 'disponible' : 'consultar'
  };
  if (enlace) o.enlaceTienda = enlace;
  if (conPrecio) { o.precioFinalPorM2ConIva = precio; o.totalFinalConIva = precio != null ? round2(m2Comprados * precio) : null; }
  o.nota = (conPrecio ? 'Totales con IVA incluido. ' : 'No des precios ni totales: compartí el enlaceTienda (si no hay, el asesor confirma el precio). ') + 'Es una estimación: el asesor confirma medidas, flete y disponibilidad.';
  return o;
}

// Borrador de presupuesto (Fase 2): el modelo propone productos y cantidades (en la unidad de venta); acá se validan contra el catálogo y,
// si hay una conversación real (ctx.convId), se guardan en ella para que, al derivar, se cree la oportunidad y el presupuesto en borrador.
async function armarBorrador(db, orgId, args, modo, ctx) {
  const crudos = Array.isArray(args && args.items) ? args.items.slice(0, 15) : [];
  if (!crudos.length) return { error: 'Indicá al menos un producto con su cantidad.' };
  const lista = await listaConsumidorFinal(db, orgId), inc = await ivaIncluido(db, orgId, lista), ivaDef = await ivaDefecto(db, orgId);
  const cotDoc = await db.collection('config_general').findOne({ orgId, clave: 'cotizacionDolar' }); const cot = cotDoc ? cotDoc.valor : null;
  const items = [], problemas = []; let total = 0, completo = true;
  for (const it of crudos) {
    let id; try { id = new ObjectId(String(it && it.productoId)); } catch (e) { problemas.push('productoId inválido (usá el id de buscar_productos)'); continue; }
    const cant = Number(it.cantidad);
    if (!(cant > 0) || cant > 100000) { problemas.push('cantidad inválida'); continue; }
    const p = await db.collection('productos_catalogo').findOne({ _id: id, orgId, activo: { $ne: false } });
    if (!p) { problemas.push('producto inexistente en esta sucursal'); continue; }
    const precio = precioFinalDe(p, lista, inc, ivaDef, cot);
    if (precio == null) completo = false; else total += precio * cant;
    items.push({ productoId: p._id, nombre: p.nombre, unidad: p.unidad || 'unidad', cantidad: round2(cant), precioFinal: precio });
  }
  if (!items.length) return { error: 'No se pudo armar el borrador: ' + problemas.join('; ') };
  const borrador = { items, totalFinal: completo ? round2(total) : null, at: new Date() };
  if (ctx && ctx.convId) {
    const previa = await db.collection('wa_conversaciones').findOne({ _id: ctx.convId }, { projection: { borrador: 1 } });
    if (previa && previa.borrador && previa.borrador.presupuestoId) { borrador.presupuestoId = previa.borrador.presupuestoId; borrador.presupuestoNumero = previa.borrador.presupuestoNumero; borrador.cambiado = true; }
    await db.collection('wa_conversaciones').updateOne({ _id: ctx.convId }, { $set: { borrador } });
  }
  const conPrecio = modo === 'precio';
  return {
    ok: true, guardado: !!(ctx && ctx.convId), problemas: problemas.length ? problemas : undefined,
    items: items.map(i => Object.assign({ producto: i.nombre, cantidad: i.cantidad, unidad: i.unidad }, conPrecio && i.precioFinal != null ? { precioFinalConIva: i.precioFinal, subtotalConIva: round2(i.precioFinal * i.cantidad) } : {})),
    totalFinalConIva: conPrecio && completo ? round2(total) : undefined,
    nota: 'Es un borrador interno: un asesor lo revisa y se lo envía. Decile al cliente que un asesor le confirma el presupuesto' + (conPrecio ? ' y podés mencionar el total estimado con IVA.' : ' (no menciones totales en dinero).')
  };
}

// Declaración para el modelo + ejecución. orgId: sucursal de la conversación.
function herramientas(db, orgId, modo, ctx) {
  const lista = [
    {
      name: 'buscar_productos',
      description: 'Busca productos reales del catálogo de la sucursal y devuelve precio final con IVA y disponibilidad (disponible/consultar). Usala SIEMPRE antes de nombrar un producto, precio o disponibilidad.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras clave: tipo de producto, formato, color, marca. Ej: "porcelanato 60x60 gris"' }, limite: { type: 'integer', description: 'Cantidad de resultados (1 a 10, por defecto 6)' } }, required: ['consulta'] },
      ejecutar: (a) => buscarProductos(db, orgId, a, modo)
    },
    {
      name: 'calcular_material',
      description: 'Calcula cuántas cajas y cuánto cuesta (con IVA) cubrir una superficie con un producto que se vende por m2. Usá el id devuelto por buscar_productos.',
      parameters: { type: 'object', properties: { productoId: { type: 'string' }, m2: { type: 'number', description: 'Superficie a cubrir en m2' }, desperdicioPct: { type: 'number', description: 'Desperdicio en % (por defecto 10)' } }, required: ['productoId', 'm2'] },
      ejecutar: (a) => calcularMaterial(db, orgId, a, modo)
    }
  ];
  if (ctx && ctx.borrador) lista.push({
    name: 'armar_borrador_presupuesto',
    description: 'Guarda un borrador de presupuesto con los productos y cantidades que el cliente quiere (cantidad en la unidad de venta del producto: m2 para pisos/revestimientos usando m2QueSeCompran de calcular_material, bolsas, unidades). Usala cuando el cliente pida un presupuesto o confirme qué quiere llevar. Un asesor lo revisa antes de enviarlo.',
    parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { productoId: { type: 'string' }, cantidad: { type: 'number' } }, required: ['productoId', 'cantidad'] } } }, required: ['items'] },
    ejecutar: (a) => armarBorrador(db, orgId, a, modo, ctx)
  });
  return lista;
}

const REGLAS_BASE = `

## Datos reales del sistema (herramientas)
Tenés herramientas para consultar el catálogo real de la sucursal. Estas reglas REEMPLAZAN cualquier indicación anterior que diga que no des precios o que no menciones disponibilidad. Reglas obligatorias:
- Para nombrar productos, precios, enlaces o disponibilidad usá SIEMPRE "buscar_productos". Nunca inventes un producto, precio, enlace ni stock; si la herramienta no devuelve nada, decilo y ofrecé derivar a un asesor.
- Stock: solo podés decir "disponible" o "te lo confirma un asesor". Nunca des cantidades.
- Para cubrir una superficie usá "calcular_material" y explicá cajas y metros; aclará que es una estimación a confirmar por un asesor.
- Si el cliente pide descuentos, financiación, envíos u otra cosa que no figura en tu base de conocimiento, no prometas: derivá a un asesor.
- No des datos de otros clientes ni saldos o cuentas.
- Si hay varias opciones, mostrá las que devolvió la herramienta (hasta 4 por mensaje), breves, y preguntá cuál le interesa. Si totalEncontrados es mayor que los mostrados, avisá que hay más y ofrecé acotar o ver otras.`;
const REGLAS_MODO = {
  precio: '\n- Podés dar precios: son siempre precios FINALES con IVA incluido (consumidor final), tal como los devuelve la herramienta. Indicá la unidad (por m2, por caja, por bolsa...).',
  link: '\n- NO des precios ni totales en dinero. Para cada producto compartí su "enlaceTienda" (link a la tienda online) para que el cliente vea ahí el precio y pueda comprar. Si un producto no tiene enlace, decile que un asesor le confirma el precio. Copiá los enlaces tal cual, sin modificarlos.',
  link_o_precio: '\n- Preferí compartir el "enlaceTienda" (link a la tienda online) en vez de dar el precio. Solo si un producto NO tiene enlace, dá su precio final con IVA tal como lo devuelve la herramienta. Copiá los enlaces tal cual, sin modificarlos.'
};
const REGLAS_BORRADOR = '\n- Si el cliente pide un presupuesto o decide qué llevar, usá "armar_borrador_presupuesto" con los productos y cantidades acordados (después de calcular_material si es por m2) y avisale que un asesor lo revisa y se lo envía. Nunca lo presentes como definitivo ni prometas descuentos. Cuando el cliente ya quiere avanzar o pidió presupuesto, poné "derivar": true para que un asesor lo tome.';
const reglasPrompt = (modo, conBorrador) => REGLAS_BASE + (REGLAS_MODO[modo] || REGLAS_MODO.precio) + (conBorrador ? REGLAS_BORRADOR : '');

module.exports = { herramientas, buscarProductos, calcularMaterial, armarBorrador, reglasPrompt, MODOS, _interno: { tokensDe, patronDeToken, precioFinalDe, esM2, usarBuscadorLinks: (f) => { buscadorLinks = f; cacheLinks.clear(); } } };
