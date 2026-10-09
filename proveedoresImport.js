// ---------------------------------------------------------------------------
// Importar lista de precios de un proveedor (9/10/2026, pedido de Mato:
// "en cada proveedor una pestaña para importar listas de precios, con una
// regla de importación propia — descuentos y márgenes distintos, pesos o
// dólares — y que se actualicen costos, precios y el stock de los que
// manden stock").
//
// Cada proveedor guarda su REGLA en proveedores.reglaImport:
//   {
//     matchPor: 'codigoExterno' | 'sku',   cómo se vincula la fila con el producto
//     columnas: { codigo, precio, stock, nombre },   títulos de columna del Excel del proveedor
//     hoja: 1, filaEncabezado: 1,
//     moneda: 'ARS' | 'USD',               moneda en la que viene la lista
//     descuentos: [10, 5],                 % en cascada sobre el precio de lista
//     recargoPct: 0,                       % de flete/gastos que se suma al costo
//     ivaIncluido: false,                  la lista ya trae IVA (se descuenta para el costo neto)
//     margenes: [{ listaId, margenPct, incluyeIva, redondeo }],   precio por lista de precios
//     stock: { activo, depositoId, ceroSiNoViene },
//     alertaPct: 40                        variación de costo que se marca como "revisar"
//   }
//
// Flujo: /preview calcula todo SIN tocar nada (costo/precio/stock anterior →
// nuevo); /aplicar vuelve a calcular con el mismo archivo y guarda. El
// archivo no se guarda en la base (el navegador lo vuelve a mandar), solo un
// resumen chico en proveedores_import_log — la base gratis de Atlas es chica.
//
// Escribe en productos_catalogo (costo, moneda, precio, preciosPorLista) y en
// stock_actual / stock_movimientos del depósito elegido (el depósito virtual
// del proveedor — nunca el propio; se bloquea Junín).
// ---------------------------------------------------------------------------

const express = require('express');
const XLSX = require('xlsx');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereModulo('proveedores')];

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(
        () => { mongoClient = nuevo; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try { return await fn(); } catch (e) { if (e.status) throw e; mongoClient = null; return await fn(); }
}
function err(status, message) { return Object.assign(new Error(message), { status }); }
function oid(v) { try { return v ? new ObjectId(String(v)) : null; } catch (e) { return null; } }
function redondear(n, d) { const f = Math.pow(10, d == null ? 2 : d); return Math.round(n * f) / f; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' '); }
function codigoClave(s) { return String(s == null ? '' : s).trim().toUpperCase(); }

// "1.234,56" / "1,234.56" / "$ 1234,5" / 12.5 → número (null si no es un número)
function parseNumero(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d,.\-]/g, '');
  if (!s || s === '-' || s === ',' || s === '.') return null;
  const ultimaComa = s.lastIndexOf(','), ultimoPunto = s.lastIndexOf('.');
  if (ultimaComa >= 0 && ultimoPunto >= 0) {
    if (ultimaComa > ultimoPunto) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (ultimaComa >= 0) {
    s = s.replace(',', '.');
  } else if (ultimoPunto >= 0) {
    const partes = s.split('.');
    if (partes.length > 2 || (partes.length === 2 && partes[1].length === 3 && partes[0].length <= 3 && !/^0/.test(partes[0]))) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---- lectura del archivo
function leerLibro(base64) {
  if (!base64) throw err(400, 'Falta el archivo.');
  const buffer = Buffer.from(String(base64).replace(/^data:.*;base64,/, ''), 'base64');
  if (!buffer.length) throw err(400, 'El archivo está vacío.');
  try { return XLSX.read(buffer, { type: 'buffer', cellDates: true }); }
  catch (e) { throw err(400, 'No se pudo leer el archivo. Tiene que ser Excel (.xlsx, .xls) o CSV.'); }
}
function matriz(wb, hoja) {
  const nombre = wb.SheetNames[Math.max(0, (Number(hoja) || 1) - 1)];
  if (!nombre) throw err(400, 'El archivo no tiene esa hoja.');
  return XLSX.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, defval: '' });
}
function filasDeArchivo(base64, regla) {
  const wb = leerLibro(base64);
  const m = matriz(wb, regla.hoja);
  const fe = Math.max(1, Number(regla.filaEncabezado) || 1) - 1;
  const enc = (m[fe] || []).map(h => String(h == null ? '' : h).trim());
  const idx = {};
  for (const k of ['codigo', 'precio', 'stock', 'nombre']) {
    const t = regla.columnas && regla.columnas[k];
    if (!t) continue;
    const i = enc.findIndex(h => norm(h) === norm(t));
    if (i < 0 && (k === 'codigo' || k === 'precio')) throw err(400, `No encuentro la columna "${t}" en la fila ${fe + 1} del archivo. Revisá la regla de importación.`);
    if (i < 0 && k === 'stock' && regla.stock && regla.stock.activo) throw err(400, `No encuentro la columna de stock "${t}" en el archivo.`);
    if (i >= 0) idx[k] = i;
  }
  if (idx.codigo == null) throw err(400, 'Falta indicar la columna del código en la regla.');
  if (idx.precio == null) throw err(400, 'Falta indicar la columna del precio en la regla.');
  const filas = [];
  for (let r = fe + 1; r < m.length; r++) {
    const f = m[r];
    const codigo = String(f[idx.codigo] == null ? '' : f[idx.codigo]).trim();
    if (!codigo) continue;
    filas.push({
      fila: r + 1, codigo,
      nombre: idx.nombre != null ? String(f[idx.nombre] == null ? '' : f[idx.nombre]).trim() : '',
      precio: parseNumero(f[idx.precio]),
      stock: idx.stock != null ? parseNumero(f[idx.stock]) : null,
      stockCelda: idx.stock != null ? f[idx.stock] : null
    });
  }
  return filas;
}

// ---- regla
function limpiarRegla(b) {
  b = b || {};
  const cols = b.columnas || {};
  const porcentaje = (v, etiqueta) => { const n = parseNumero(v); if (n == null || n < 0 || n > 100) throw err(400, `${etiqueta} tiene que estar entre 0 y 100.`); return n; };
  const descuentos = (Array.isArray(b.descuentos) ? b.descuentos : []).filter(x => x !== '' && x != null).map(x => porcentaje(x, 'Cada descuento'));
  const margenes = [];
  for (const m of (Array.isArray(b.margenes) ? b.margenes : [])) {
    const listaId = oid(m.listaId);
    if (!listaId) continue;
    const n = parseNumero(m.margenPct);
    if (n == null || n < -50 || n > 1000) throw err(400, 'El margen de cada lista tiene que ser un número razonable.');
    const red = [0, 1, 5, 10, 50, 100].includes(Number(m.redondeo)) ? Number(m.redondeo) : 0;
    if (margenes.some(x => String(x.listaId) === String(listaId))) throw err(400, 'Hay una lista de precios repetida en los márgenes.');
    margenes.push({ listaId, margenPct: n, incluyeIva: !!m.incluyeIva, redondeo: red });
  }
  const st = b.stock || {};
  return {
    matchPor: b.matchPor === 'sku' ? 'sku' : 'codigoExterno',
    columnas: { codigo: String(cols.codigo || '').trim(), precio: String(cols.precio || '').trim(), stock: String(cols.stock || '').trim(), nombre: String(cols.nombre || '').trim() },
    hoja: Math.max(1, parseInt(b.hoja, 10) || 1),
    filaEncabezado: Math.max(1, parseInt(b.filaEncabezado, 10) || 1),
    moneda: b.moneda === 'USD' ? 'USD' : 'ARS',
    descuentos,
    recargoPct: b.recargoPct === '' || b.recargoPct == null ? 0 : porcentaje(b.recargoPct, 'El recargo'),
    ivaIncluido: !!b.ivaIncluido,
    margenes,
    stock: { activo: !!st.activo, depositoId: oid(st.depositoId), ceroSiNoViene: !!st.ceroSiNoViene },
    alertaPct: b.alertaPct === '' || b.alertaPct == null ? 40 : porcentaje(b.alertaPct, 'El umbral de alerta')
  };
}
function reglaParaCliente(r) {
  if (!r) return null;
  return Object.assign({}, r, {
    margenes: (r.margenes || []).map(m => Object.assign({}, m, { listaId: String(m.listaId) })),
    stock: Object.assign({}, r.stock, { depositoId: r.stock && r.stock.depositoId ? String(r.stock.depositoId) : '' })
  });
}
async function proveedorDeOrg(db, req) {
  const id = oid(req.params.id);
  if (!id) throw err(400, 'id inválido');
  const p = await db.collection('proveedores').findOne(Object.assign({ _id: id }, filtroOrg(req)));
  if (!p) throw err(404, 'Proveedor no encontrado');
  return p;
}

router.get('/:id/regla', authAdmin, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const prov = await proveedorDeOrg(db, req);
      const depositos = await db.collection('depositos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ nombre: 1 }).sort({ nombre: 1 }).toArray();
      const listas = await db.collection('productos_listas_precio').find(Object.assign({ activa: { $ne: false } }, filtroOrg(req))).project({ nombre: 1, predeterminada: 1, formula: 1, alcance: 1, incluyeIva: 1, porcentaje: 1 }).sort({ orden: 1, nombre: 1 }).toArray();
      const cot = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' });
      return { regla: reglaParaCliente(prov.reglaImport), depositos, listas, cotizacionDolar: cot ? cot.valor : null, proveedor: prov.razonSocial };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id/regla', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const regla = limpiarRegla(req.body);
    await conReintento(async () => {
      const db = await getDb();
      const prov = await proveedorDeOrg(db, req);
      for (const m of regla.margenes) {
        if (!(await db.collection('productos_listas_precio').findOne(Object.assign({ _id: m.listaId }, filtroOrg(req))))) throw err(400, 'Una de las listas de precios no existe.');
      }
      if (regla.stock.activo) {
        if (!regla.stock.depositoId) throw err(400, 'Elegí el depósito donde se carga el stock del proveedor.');
        await validarDeposito(db, req, regla.stock.depositoId);
      }
      await db.collection('proveedores').updateOne({ _id: prov._id }, { $set: { reglaImport: regla, updatedAt: new Date() } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

async function validarDeposito(db, req, depositoId) {
  const d = await db.collection('depositos').findOne(Object.assign({ _id: depositoId }, filtroOrg(req)));
  if (!d) throw err(400, 'El depósito elegido no existe.');
  if (/jun[ií]n/i.test(d.nombre || '')) throw err(400, `"${d.nombre}" es tu depósito propio: una lista de proveedor no puede pisar su stock. Elegí el depósito virtual del proveedor.`);
  return d;
}

// Encabezados del archivo (para elegir columnas) + una sugerencia automática
router.post('/:id/encabezados', authAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const wb = leerLibro(b.archivoBase64);
    const m = matriz(wb, b.hoja);
    // si no se indica la fila, se busca la primera con 3+ celdas de texto
    let fe = parseInt(b.filaEncabezado, 10);
    if (!fe) {
      fe = 1;
      for (let i = 0; i < Math.min(m.length, 25); i++) {
        if ((m[i] || []).filter(c => typeof c === 'string' && c.trim()).length >= 3) { fe = i + 1; break; }
      }
    }
    const enc = (m[fe - 1] || []).map(h => String(h == null ? '' : h).trim()).filter(Boolean);
    const buscar = (...pat) => enc.find(h => pat.some(p => norm(h).includes(p))) || '';
    res.json({
      hojas: wb.SheetNames, filaEncabezado: fe, encabezados: enc,
      sugeridas: {
        codigo: buscar('codigo', 'cod.', 'cod ', 'sku', 'articulo', 'item'),
        precio: buscar('precio lista', 'precio', 'lista', 'costo', 'importe'),
        stock: buscar('stock', 'existencia', 'disponible', 'cantidad'),
        nombre: buscar('descripcion', 'producto', 'nombre', 'detalle')
      },
      muestra: m.slice(fe, fe + 3).map(f => (f || []).slice(0, 12).map(c => String(c == null ? '' : c)))
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- cálculo (usado por preview y aplicar)
function aplicarMargen(costoPesos, m, iva, ivaDefecto) {
  let p = costoPesos * (1 + m.margenPct / 100);
  if (m.incluyeIva) p *= 1 + (iva != null ? iva : ivaDefecto) / 100;
  if (m.redondeo > 0) p = Math.round(p / m.redondeo) * m.redondeo;
  return redondear(p, 2);
}
function precioActual(prod, lista, cotizacion) {
  const ov = (prod.preciosPorLista || []).find(x => String(x.listaId) === String(lista._id));
  if (ov) return ov.precio;
  if (lista.predeterminada) return prod.precio != null ? prod.precio : null;
  return null;
}

async function calcular(db, req, prov, regla, filas) {
  if (!regla.margenes.length && !(regla.stock && regla.stock.activo)) throw err(400, 'La regla no tiene márgenes ni stock: no hay nada para actualizar además del costo. Agregá al menos una lista de precios o activá el stock.');
  const cotizacion = await db.collection('config_general').findOne({ orgId: req.orgId, clave: 'cotizacionDolar' }).then(d => d && d.valor);
  if (regla.moneda === 'USD' && !cotizacion) throw err(400, 'La lista está en dólares y no hay cotización del dólar cargada (Productos → Listas de precio).');
  const listas = new Map();
  for (const m of regla.margenes) {
    const l = await db.collection('productos_listas_precio').findOne(Object.assign({ _id: m.listaId }, filtroOrg(req)));
    if (!l) throw err(400, 'Una de las listas de precios de la regla ya no existe. Revisá la regla.');
    if (l.formula === 'cf_x_bulto') throw err(400, `La lista "${l.nombre}" se calcula sola (precio × bultos); sacala de los márgenes.`);
    listas.set(String(l._id), l);
  }
  let deposito = null;
  if (regla.stock.activo) {
    if (!regla.stock.depositoId) throw err(400, 'Elegí el depósito del stock en la regla.');
    deposito = await validarDeposito(db, req, regla.stock.depositoId);
  }

  // vincular filas con productos
  const claves = [...new Set(filas.map(f => f.codigo))];
  const campo = regla.matchPor === 'sku' ? 'sku' : 'codigoExterno';
  const productos = [];
  for (let i = 0; i < claves.length; i += 1000) {
    const lote = claves.slice(i, i + 1000);
    const q = Object.assign({ activo: { $ne: false }, [campo]: { $in: lote.concat(lote.map(codigoClave)) } }, filtroOrg(req));
    if (campo === 'codigoExterno') q.$and = [{ $or: [{ proveedorId: prov._id }, { proveedorId: { $exists: false } }, { proveedorId: null }] }];
    productos.push(...await db.collection('productos_catalogo').find(q).toArray());
  }
  const porCodigo = new Map();
  for (const p of productos) {
    const k = codigoClave(p[campo]);
    if (!porCodigo.has(k)) porCodigo.set(k, []);
    porCodigo.get(k).push(p);
  }
  const ids = productos.map(p => p._id);
  const stockPrev = new Map();
  if (deposito && ids.length) {
    for (let i = 0; i < ids.length; i += 2000) {
      const rows = await db.collection('stock_actual').find(Object.assign({ depositoId: deposito._id, productoId: { $in: ids.slice(i, i + 2000) } }, filtroOrg(req))).toArray();
      rows.forEach(r => stockPrev.set(String(r.productoId), r.cantidad || 0));
    }
  }

  const cambios = [], sinMatch = [], duplicados = [], sinPrecio = [];
  const vistos = new Set();
  const factorDesc = regla.descuentos.reduce((a, d) => a * (1 - d / 100), 1);
  const decimales = regla.moneda === 'USD' ? 4 : 2;
  for (const f of filas) {
    const k = codigoClave(f.codigo);
    const cands = porCodigo.get(k) || [];
    if (!cands.length) { sinMatch.push({ fila: f.fila, codigo: f.codigo, nombre: f.nombre }); continue; }
    if (cands.length > 1) { duplicados.push({ fila: f.fila, codigo: f.codigo, productos: cands.map(c => c.sku + ' – ' + c.nombre).slice(0, 4) }); continue; }
    if (vistos.has(k)) { duplicados.push({ fila: f.fila, codigo: f.codigo, productos: ['Código repetido en el archivo (se usó la primera fila)'] }); continue; }
    vistos.add(k);
    const p = cands[0];
    const c = { productoId: p._id, sku: p.sku, nombre: p.nombre, fila: f.fila, codigo: f.codigo, moneda: regla.moneda };

    if (f.precio != null && f.precio > 0) {
      const iva = p.porcentajeIva != null ? p.porcentajeIva : 21;
      let costo = f.precio * factorDesc * (1 + regla.recargoPct / 100);
      if (regla.ivaIncluido) costo = costo / (1 + iva / 100);
      costo = redondear(costo, decimales);
      const costoPesos = regla.moneda === 'USD' ? costo * cotizacion : costo;
      c.precioLista = f.precio;
      c.costoAnterior = p.costo != null ? p.costo : null;
      c.monedaAnterior = p.moneda || 'ARS';
      c.costoNuevo = costo;
      const comparable = c.monedaAnterior === regla.moneda ? c.costoAnterior : null;
      c.variacionPct = comparable ? redondear((costo / comparable - 1) * 100, 1) : null;
      c.alerta = c.variacionPct != null && Math.abs(c.variacionPct) >= regla.alertaPct;
      c.cambiaCosto = c.costoAnterior == null || comparable !== costo;
      c.precios = [];
      for (const m of regla.margenes) {
        const l = listas.get(String(m.listaId));
        if (l.alcance === 'seleccion' && !(l.productosIds || []).some(x => String(x) === String(p._id))) continue;
        const nuevo = aplicarMargen(costoPesos, m, p.porcentajeIva, 21);
        const ant = precioActual(p, l, cotizacion);
        c.precios.push({ listaId: String(l._id), lista: l.nombre, predeterminada: !!l.predeterminada, anterior: ant, nuevo, cambia: ant == null || Math.abs(ant - nuevo) >= 0.005 });
      }
    } else if (!(regla.stock.activo && f.stock != null)) {
      sinPrecio.push({ fila: f.fila, codigo: f.codigo, nombre: f.nombre || p.nombre });
      continue;
    }

    if (deposito && f.stock != null) {
      const nuevo = Math.max(0, redondear(f.stock, 3));
      const ant = stockPrev.has(String(p._id)) ? stockPrev.get(String(p._id)) : 0;
      c.stock = { anterior: ant, nuevo, cambia: Math.abs(ant - nuevo) > 0.0005 };
    }
    c.hayCambio = !!(c.cambiaCosto || (c.precios || []).some(x => x.cambia) || (c.stock && c.stock.cambia));
    cambios.push(c);
  }

  // stock en 0 de lo que el proveedor ya no manda
  let aCero = [];
  if (deposito && regla.stock.ceroSiNoViene) {
    const enLista = new Set(cambios.map(c => String(c.productoId)));
    const delProv = await db.collection('productos_catalogo').find(Object.assign({ proveedorId: prov._id, activo: { $ne: false } }, filtroOrg(req))).project({ sku: 1, nombre: 1 }).toArray();
    const delIds = delProv.filter(p => !enLista.has(String(p._id)));
    if (delIds.length) {
      const rows = await db.collection('stock_actual').find(Object.assign({ depositoId: deposito._id, cantidad: { $gt: 0 }, productoId: { $in: delIds.map(p => p._id) } }, filtroOrg(req))).toArray();
      const nom = new Map(delProv.map(p => [String(p._id), p]));
      aCero = rows.map(r => ({ productoId: r.productoId, sku: nom.get(String(r.productoId)).sku, nombre: nom.get(String(r.productoId)).nombre, anterior: r.cantidad }));
    }
  }

  const resumen = {
    filasArchivo: filas.length, vinculados: cambios.length, sinMatch: sinMatch.length, duplicados: duplicados.length, sinPrecio: sinPrecio.length,
    costosCambian: cambios.filter(c => c.cambiaCosto).length,
    preciosCambian: cambios.reduce((n, c) => n + (c.precios || []).filter(x => x.cambia).length, 0),
    stockCambia: cambios.filter(c => c.stock && c.stock.cambia).length + aCero.length,
    stockACero: aCero.length, alertas: cambios.filter(c => c.alerta).length,
    deposito: deposito ? deposito.nombre : null, moneda: regla.moneda, cotizacionDolar: regla.moneda === 'USD' ? cotizacion : null
  };
  return { cambios, sinMatch, duplicados, sinPrecio, aCero, resumen, deposito, listas, cotizacion };
}

async function prepararCalculo(req) {
  const db = await getDb();
  const prov = await proveedorDeOrg(db, req);
  if (!prov.reglaImport) throw err(400, 'Primero guardá la regla de importación de este proveedor.');
  const regla = prov.reglaImport;
  const filas = filasDeArchivo((req.body || {}).archivoBase64, regla);
  if (!filas.length) throw err(400, 'No encontré filas con código en el archivo. Revisá la fila de encabezado y la columna de código.');
  const calc = await calcular(db, req, prov, regla, filas);
  return { db, prov, regla, calc };
}

router.post('/:id/preview', authAdmin, async (req, res) => {
  try {
    const { calc } = await conReintento(() => prepararCalculo(req));
    // se muestran primero las alertas y las que más cambian
    const ordenadas = calc.cambios.filter(c => c.hayCambio).sort((a, b) => (b.alerta ? 1 : 0) - (a.alerta ? 1 : 0) || Math.abs(b.variacionPct || 0) - Math.abs(a.variacionPct || 0));
    res.json({
      resumen: calc.resumen,
      muestra: ordenadas.slice(0, 300).map(c => ({ sku: c.sku, nombre: c.nombre, fila: c.fila, precioLista: c.precioLista, costoAnterior: c.costoAnterior, monedaAnterior: c.monedaAnterior, costoNuevo: c.costoNuevo, moneda: c.moneda, variacionPct: c.variacionPct, alerta: c.alerta, precios: c.precios, stock: c.stock })),
      hayMas: ordenadas.length > 300,
      sinMatch: calc.sinMatch.slice(0, 200), duplicados: calc.duplicados.slice(0, 50), sinPrecio: calc.sinPrecio.slice(0, 50),
      aCero: calc.aCero.slice(0, 100).map(a => ({ sku: a.sku, nombre: a.nombre, anterior: a.anterior }))
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

const TANDA = 500;
router.post('/:id/aplicar', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const omitirAlertas = !!(req.body || {}).omitirAlertas;
    const out = await conReintento(async () => {
      const { db, prov, regla, calc } = await prepararCalculo(req);
      const ahora = new Date();
      const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
      const aplicables = calc.cambios.filter(c => c.hayCambio && !(omitirAlertas && c.alerta));
      const omitidos = calc.cambios.filter(c => c.hayCambio && omitirAlertas && c.alerta).length;
      let costos = 0, precios = 0, stocks = 0;

      for (let i = 0; i < aplicables.length; i += TANDA) {
        const lote = aplicables.slice(i, i + TANDA);
        const opsProd = [], opsStock = [], movs = [];
        for (const c of lote) {
          const set = { updatedAt: ahora };
          if (c.costoNuevo != null) { set.costo = c.costoNuevo; set.moneda = c.moneda; set.costoActualizadoEn = ahora; set.costoProveedorId = prov._id; costos++; }
          for (const pr of (c.precios || [])) if (pr.predeterminada) set.precio = pr.nuevo;
          opsProd.push({ updateOne: { filter: { _id: c.productoId }, update: { $set: set } } });
          if ((c.precios || []).length) opsProd.push({ updateOne: { filter: { _id: c.productoId, preciosPorLista: { $not: { $type: 'array' } } }, update: { $set: { preciosPorLista: [] } } } });
          for (const pr of (c.precios || [])) {
            const lid = new ObjectId(pr.listaId);
            opsProd.push({ updateOne: { filter: { _id: c.productoId }, update: { $set: { 'preciosPorLista.$[e].precio': pr.nuevo } }, arrayFilters: [{ 'e.listaId': lid }] } });
            opsProd.push({ updateOne: { filter: { _id: c.productoId, 'preciosPorLista.listaId': { $ne: lid } }, update: { $push: { preciosPorLista: { listaId: lid, precio: pr.nuevo } } } } });
            if (pr.cambia) precios++;
          }
          if (c.stock && c.stock.cambia) { agregarStock(c.productoId, c.stock.anterior, c.stock.nuevo); }
        }
        function agregarStock(productoId, ant, nuevo) {
          const dif = nuevo - ant;
          opsStock.push({ updateOne: { filter: Object.assign({ productoId, depositoId: calc.deposito._id }, filtroOrg(req)), update: { $set: { cantidad: nuevo, actualizadoEn: ahora }, $setOnInsert: Object.assign({ productoId, depositoId: calc.deposito._id }, filtroOrg(req)) }, upsert: true } });
          movs.push({ productoId, depositoId: calc.deposito._id, tipo: dif > 0 ? 'ingreso' : 'egreso', cantidad: Math.abs(dif), motivo: `Lista de ${prov.razonSocial} (${ant} → ${nuevo})`, sucursal: '', codigoExterno: '', observaciones: '', usuarioNombre, fecha: ahora, orgId: req.orgId, createdAt: ahora });
          stocks++;
        }
        if (opsProd.length) await db.collection('productos_catalogo').bulkWrite(opsProd, { ordered: true });
        if (opsStock.length) { await db.collection('stock_actual').bulkWrite(opsStock, { ordered: false }); await db.collection('stock_movimientos').insertMany(movs, { ordered: false }); }
      }
      // productos que el proveedor dejó de mandar → stock 0
      if (calc.aCero.length) {
        const opsStock = [], movs = [];
        for (const a of calc.aCero) {
          opsStock.push({ updateOne: { filter: Object.assign({ productoId: a.productoId, depositoId: calc.deposito._id }, filtroOrg(req)), update: { $set: { cantidad: 0, actualizadoEn: ahora } } } });
          movs.push({ productoId: a.productoId, depositoId: calc.deposito._id, tipo: 'egreso', cantidad: a.anterior, motivo: `Lista de ${prov.razonSocial}: ya no figura (${a.anterior} → 0)`, sucursal: '', codigoExterno: '', observaciones: '', usuarioNombre, fecha: ahora, orgId: req.orgId, createdAt: ahora });
          stocks++;
        }
        for (let i = 0; i < opsStock.length; i += TANDA) {
          await db.collection('stock_actual').bulkWrite(opsStock.slice(i, i + TANDA), { ordered: false });
          await db.collection('stock_movimientos').insertMany(movs.slice(i, i + TANDA), { ordered: false });
        }
      }
      const resumen = Object.assign({}, calc.resumen, { costosActualizados: costos, preciosActualizados: precios, stocksActualizados: stocks, omitidosPorAlerta: omitidos });
      await db.collection('proveedores_import_log').insertOne({ orgId: req.orgId, proveedorId: prov._id, fecha: ahora, archivo: String((req.body || {}).nombreArchivo || '').slice(0, 200), usuario: usuarioNombre, resumen });
      return resumen;
    });
    res.json({ ok: true, resumen: out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id/historial', authAdmin, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const prov = await proveedorDeOrg(db, req);
      return db.collection('proveedores_import_log').find(Object.assign({ proveedorId: prov._id }, filtroOrg(req))).sort({ fecha: -1 }).limit(15).toArray();
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports._interno = { parseNumero, aplicarMargen };
