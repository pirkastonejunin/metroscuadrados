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

// ---- búsqueda ----
const ACENTOS = { a: 'aáàäâ', e: 'eéèëê', i: 'iíìïî', o: 'oóòöô', u: 'uúùüû', n: 'nñ' };
function sinAcentos(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function escapar(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function patronDeToken(t) {
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)$/); // 60x60 -> 60 x 60, 60X60, 60×60
  if (m) return m[1].replace(',', '[.,]') + '\\s*[x×*]\\s*' + m[2].replace(',', '[.,]');
  return escapar(t).replace(/[aeioun]/g, (c) => '[' + ACENTOS[c] + ']');
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

async function buscarProductos(db, orgId, args) {
  const consulta = String((args && args.consulta) || '').slice(0, 200);
  const limite = Math.min(Math.max(parseInt(args && args.limite, 10) || 5, 1), 8);
  const tokens = tokensDe(consulta);
  if (!tokens.length) return { productos: [], aviso: 'Consulta vacía: pedile al cliente qué producto busca.' };
  const base = { orgId, activo: { $ne: false } };
  const campos = (re) => ({ $or: [{ nombre: re }, { sku: re }, { marca: re }, { rubro: re }, { subrubro: re }] });
  const regs = tokens.map(t => new RegExp(patronDeToken(t), 'i'));
  const proj = { sku: 1, nombre: 1, marca: 1, rubro: 1, subrubro: 1, unidad: 1, unidadesPorBulto: 1, indicaCtdBultos: 1, precio: 1, preciosPorLista: 1, porcentajeIva: 1, descripcion: 1, stockeable: 1, moneda: 1, costo: 1 };
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
  return {
    productos: top.map(({ p, precio }) => {
      const upb = Number(p.unidadesPorBulto) > 0 ? Number(p.unidadesPorBulto) : null;
      const o = {
        id: String(p._id), nombre: p.nombre, marca: p.marca || '', rubro: [p.rubro, p.subrubro].filter(Boolean).join(' / '),
        unidadDeVenta: p.unidad || 'unidad',
        precioFinalConIva: precio, // por unidadDeVenta; null = sin precio cargado: derivar
        disponibilidad: (p.stockeable !== false && (disp.get(String(p._id)) || 0) > 0) ? 'disponible' : 'consultar'
      };
      if (upb && upb > 1) { o.unidadesPorBulto = upb; if (precio != null && esM2(p.unidad)) o.precioFinalPorCajaConIva = round2(precio * upb); }
      if (p.descripcion) o.descripcion = String(p.descripcion).slice(0, 240);
      return o;
    }),
    nota: 'Los precios ya incluyen IVA (consumidor final). Disponibilidad: "disponible" o "consultar" (nunca digas cantidades).'
  };
}

async function calcularMaterial(db, orgId, args) {
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
  return {
    producto: p.nombre, m2Pedidos: round2(m2), desperdicioPct: desp, m2ConDesperdicio: necesarios,
    cajas, m2PorCaja: upb, m2QueSeCompran: m2Comprados,
    precioFinalPorM2ConIva: precio, totalFinalConIva: precio != null ? round2(m2Comprados * precio) : null,
    disponibilidad: p.stockeable !== false && d >= m2Comprados ? 'disponible' : 'consultar',
    nota: 'Totales con IVA incluido. Es una estimación: el asesor confirma medidas, flete y disponibilidad.'
  };
}

// Declaración para el modelo + ejecución. orgId: sucursal de la conversación.
function herramientas(db, orgId) {
  return [
    {
      name: 'buscar_productos',
      description: 'Busca productos reales del catálogo de la sucursal y devuelve precio final con IVA y disponibilidad (disponible/consultar). Usala SIEMPRE antes de nombrar un producto, precio o disponibilidad.',
      parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'Palabras clave: tipo de producto, formato, color, marca. Ej: "porcelanato 60x60 gris"' }, limite: { type: 'integer', description: 'Cantidad de resultados (1 a 8, por defecto 5)' } }, required: ['consulta'] },
      ejecutar: (a) => buscarProductos(db, orgId, a)
    },
    {
      name: 'calcular_material',
      description: 'Calcula cuántas cajas y cuánto cuesta (con IVA) cubrir una superficie con un producto que se vende por m2. Usá el id devuelto por buscar_productos.',
      parameters: { type: 'object', properties: { productoId: { type: 'string' }, m2: { type: 'number', description: 'Superficie a cubrir en m2' }, desperdicioPct: { type: 'number', description: 'Desperdicio en % (por defecto 10)' } }, required: ['productoId', 'm2'] },
      ejecutar: (a) => calcularMaterial(db, orgId, a)
    }
  ];
}

const REGLAS_PROMPT = `

## Datos reales del sistema (herramientas)
Tenés herramientas para consultar el catálogo real de la sucursal. Estas reglas REEMPLAZAN cualquier indicación anterior que diga que no des precios o que no menciones disponibilidad. Reglas obligatorias:
- Para nombrar productos, precios o disponibilidad usá SIEMPRE "buscar_productos". Nunca inventes un producto, precio ni stock; si la herramienta no devuelve nada, decilo y ofrecé derivar a un asesor.
- Podés dar precios: son siempre precios FINALES con IVA incluido (consumidor final), tal como los devuelve la herramienta. Indicá la unidad (por m2, por caja, por bolsa...).
- Stock: solo podés decir "disponible" o "te lo confirma un asesor". Nunca des cantidades.
- Para cubrir una superficie usá "calcular_material" y explicá cajas y total; aclará que es una estimación a confirmar por un asesor.
- Si el cliente pide descuentos, financiación, envíos u otra cosa que no figura en tu base de conocimiento, no prometas: derivá a un asesor.
- No des datos de otros clientes ni saldos o cuentas.
- Si hay varias opciones, mostrá hasta 3, breves, y preguntá cuál le interesa.`;

module.exports = { herramientas, buscarProductos, calcularMaterial, REGLAS_PROMPT, _interno: { tokensDe, patronDeToken, precioFinalDe, esM2 } };
