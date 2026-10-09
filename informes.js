// ---------------------------------------------------------------------------
// Informes detallados (7/10/2026, pedido de Mato) — menú "Reportes".
//
// Informe de ventas:  GET /api/informes/ventas
//   Filtros: desde, hasta (fecha de la venta), vendedor, clienteId, productoId,
//   rubro, estado (por defecto no se cuentan las anuladas), incluirAnuladas=1.
//   agrupar = cliente | vendedor | producto | rubro | comprobante (detalle,
//   una fila por comprobante). formato=xlsx descarga el mismo informe en Excel.
//
// Criterios (para poder auditar los números):
//   - Importe = total del comprobante (con IVA y descuentos) en pesos: las
//     ventas en USD se pasan con la cotización guardada en la venta; las notas
//     de crédito restan.
//   - Si se filtra o se agrupa por producto/rubro, el total del comprobante se
//     reparte entre sus ítems en proporción al subtotal de cada ítem.
//   - Cantidad de ventas: las notas de crédito (anulación o devolución) restan
//     importe y m2 pero NO cuentan como una venta; el ticket (venta promedio)
//     es el importe neto sobre esa cantidad.
//   - m2 = cantidad de ítems cuyo producto se vende en m2.
//   - Datos de la sucursal elegida arriba (igual que Ventas).
//
// Acceso: módulo 'informe_ventas' (el administrador lo ve siempre).
// Integración (server.js):  app.use('/api/informes', require('./informes'));
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx } = require('./importExport');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

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
  try { return await fn(); }
  catch (e) { mongoClient = null; return await fn(); }
}
function toObjectId(id) { try { return id ? new ObjectId(String(id)) : null; } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
function responder(res, e) { res.status(e.status || 500).json({ error: e.message || 'Error' }); }
function r2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

function inicioDia(s) { return new Date(s + 'T00:00:00.000-03:00'); }
function finDia(s) { return new Date(s + 'T23:59:59.999-03:00'); }
function fechaAR(d) {
  const x = new Date(new Date(d).getTime() - 3 * 3600e3);
  return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
}
function validarFecha(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(inicioDia(s).getTime()); }

const authInforme = (modulo) => [authUsuario, resolverOrg, (req, res, next) => {
  const r = req.usuario.rol;
  if (!(r.protegido || (r.modulos || []).includes(modulo))) {
    return res.status(403).json({ error: 'Tu usuario no tiene acceso a este informe. Pedile a un administrador que te lo habilite.' });
  }
  next();
}];

const TIPOS = { comprobante_x: 'X', nota_credito: 'NC', nota_debito: 'ND', factura: 'Factura', presupuesto: 'Pres.' };
function etiquetaComprobante(v) {
  const t = TIPOS[v.tipoComprobante] || String(v.tipoComprobante || 'Venta').replace(/_/g, ' ');
  return [t, v.letra || '', v.numero != null ? String(v.numero) : ''].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Opciones para los filtros
// ---------------------------------------------------------------------------
router.get('/ventas/opciones', authInforme('informe_ventas'), async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const org = filtroOrg(req);
      const [vendedores, clientes, productos, rubros] = await Promise.all([
        db.collection('ventas').distinct('vendedor', Object.assign({ vendedor: { $nin: [null, ''] } }, org)),
        db.collection('ventas').aggregate([{ $match: Object.assign({ clienteId: { $ne: null } }, org) }, { $group: { _id: '$clienteId', nombre: { $last: '$clienteNombre' } } }, { $sort: { nombre: 1 } }]).toArray(),
        db.collection('productos_catalogo').find(Object.assign({ activo: { $ne: false } }, org)).project({ nombre: 1, sku: 1 }).sort({ nombre: 1 }).toArray(),
        db.collection('productos_catalogo').distinct('rubro', Object.assign({ rubro: { $nin: [null, ''] } }, org))
      ]);
      return {
        vendedores: vendedores.sort((a, b) => a.localeCompare(b, 'es')),
        clientes: clientes.map(c => ({ _id: String(c._id), nombre: c.nombre || '(sin nombre)' })),
        productos: productos.map(p => ({ _id: String(p._id), nombre: p.nombre || '', sku: p.sku || '' })),
        rubros: rubros.sort((a, b) => a.localeCompare(b, 'es'))
      };
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Informe de ventas
// ---------------------------------------------------------------------------
const AGRUPACIONES = ['cliente', 'vendedor', 'producto', 'rubro', 'comprobante'];

async function armarInformeVentas(req) {
  const hoy = fechaAR(new Date());
  const desdeS = req.query.desde || hoy.slice(0, 8) + '01';
  const hastaS = req.query.hasta || hoy;
  if (!validarFecha(desdeS) || !validarFecha(hastaS)) throw err(400, 'Las fechas tienen que tener el formato AAAA-MM-DD.');
  if (desdeS > hastaS) throw err(400, 'La fecha "desde" no puede ser posterior a "hasta".');
  const agrupar = req.query.agrupar || 'cliente';
  if (!AGRUPACIONES.includes(agrupar)) throw err(400, 'Agrupación inválida.');
  const clienteId = req.query.clienteId ? toObjectId(req.query.clienteId) : null;
  if (req.query.clienteId && !clienteId) throw err(400, 'clienteId inválido');
  const productoId = req.query.productoId ? toObjectId(req.query.productoId) : null;
  if (req.query.productoId && !productoId) throw err(400, 'productoId inválido');
  const vendedor = String(req.query.vendedor || '').trim();
  const rubro = String(req.query.rubro || '').trim();
  const incluirAnuladas = req.query.incluirAnuladas === '1';

  return conReintento(async () => {
    const db = await getDb();
    const match = Object.assign({}, filtroOrg(req), { fecha: { $gte: inicioDia(desdeS), $lte: finDia(hastaS) } });
    if (!incluirAnuladas) match.estado = { $ne: 'anulada' };
    if (clienteId) match.clienteId = clienteId;
    if (vendedor) match.vendedor = vendedor;
    if (productoId) match['items.productoId'] = productoId;
    const ventas = await db.collection('ventas').find(match).sort({ fecha: 1, numero: 1 }).limit(20000).toArray();

    const ids = new Set();
    ventas.forEach(v => (v.items || []).forEach(it => { if (it.productoId) ids.add(String(it.productoId)); }));
    const prods = ids.size ? await db.collection('productos_catalogo').find({ _id: { $in: [...ids].map(toObjectId) } }).project({ rubro: 1, unidad: 1, nombre: 1 }).toArray() : [];
    const pm = new Map(prods.map(p => [String(p._id), p]));

    // Una "línea" = parte del total del comprobante que corresponde a un ítem.
    const lineas = [];
    ventas.forEach(v => {
      const signo = (v.tipoComprobante === 'nota_credito' ? -1 : 1) * (v.moneda === 'USD' ? (Number(v.cotizacionDolar) || 1) : 1);
      const items = v.items || [];
      const sub = items.reduce((a, it) => a + Number(it.subtotal || 0), 0);
      items.forEach(it => {
        const p = it.productoId ? pm.get(String(it.productoId)) : null;
        const rub = (p && p.rubro) || it.rubro || 'Sin rubro';
        if (productoId && String(it.productoId) !== String(productoId)) return;
        if (rubro && rub !== rubro) return;
        const parte = sub > 0 ? Number(it.subtotal || 0) / sub : (items.length ? 1 / items.length : 0);
        lineas.push({
          v, producto: it.nombre || (p && p.nombre) || 'Sin nombre', rubro: rub,
          importe: Number(v.total || 0) * parte * signo,
          m2: p && p.unidad === 'm2' ? Number(it.cantidad || 0) * (v.tipoComprobante === 'nota_credito' ? -1 : 1) : 0
        });
      });
    });

    let filas;
    if (agrupar === 'comprobante') {
      const por = new Map();
      lineas.forEach(l => {
        const k = String(l.v._id);
        const f = por.get(k) || { fecha: fechaAR(l.v.fecha), comprobante: etiquetaComprobante(l.v), cliente: l.v.clienteNombre || '', vendedor: l.v.vendedor || '', estado: l.v.estado || '', moneda: l.v.moneda || 'ARS', m2: 0, importe: 0 };
        f.m2 += l.m2; f.importe += l.importe; por.set(k, f);
      });
      filas = [...por.values()].map(f => Object.assign(f, { m2: r2(f.m2), importe: r2(f.importe) }));
    } else {
      const clave = { cliente: l => l.v.clienteNombre || '(sin cliente)', vendedor: l => l.v.vendedor || '(sin vendedor)', producto: l => l.producto, rubro: l => l.rubro }[agrupar];
      const por = new Map();
      lineas.forEach(l => {
        const k = clave(l);
        const g = por.get(k) || { nombre: k, ids: new Set(), m2: 0, importe: 0 };
        if (l.v.tipoComprobante !== 'nota_credito') g.ids.add(String(l.v._id));
        g.m2 += l.m2; g.importe += l.importe; por.set(k, g);
      });
      const totalImp = [...por.values()].reduce((a, g) => a + g.importe, 0);
      filas = [...por.values()].map(g => ({
        nombre: g.nombre, ventas: g.ids.size, m2: r2(g.m2), importe: r2(g.importe),
        ticket: g.ids.size ? r2(g.importe / g.ids.size) : 0, participacion: totalImp ? r2(g.importe / totalImp * 100) : 0
      })).sort((a, b) => b.importe - a.importe);
    }
    // Las notas de crédito (anulación o devolución) restan importe y m2, pero no cuentan como una venta más.
    const cant = new Set(lineas.filter(l => l.v.tipoComprobante !== 'nota_credito').map(l => String(l.v._id))).size;
    const cantNC = new Set(lineas.filter(l => l.v.tipoComprobante === 'nota_credito').map(l => String(l.v._id))).size;
    const totalImporte = r2(lineas.reduce((a, l) => a + l.importe, 0));
    return {
      desde: desdeS, hasta: hastaS, agrupar, filas,
      totales: { ventas: cant, notasCredito: cantNC, m2: r2(lineas.reduce((a, l) => a + l.m2, 0)), importe: totalImporte, ticket: cant ? r2(totalImporte / cant) : 0 },
      truncado: ventas.length >= 20000
    };
  });
}

router.get('/ventas', authInforme('informe_ventas'), async (req, res) => {
  try {
    const d = await armarInformeVentas(req);
    if (req.query.formato !== 'xlsx') return res.json(d);
    const det = d.agrupar === 'comprobante';
    const titulo = { cliente: 'Cliente', vendedor: 'Vendedor', producto: 'Producto', rubro: 'Rubro' }[d.agrupar];
    const columnas = det ? [
      { clave: 'fecha', titulo: 'Fecha' }, { clave: 'comprobante', titulo: 'Comprobante' }, { clave: 'cliente', titulo: 'Cliente' },
      { clave: 'vendedor', titulo: 'Vendedor' }, { clave: 'estado', titulo: 'Estado' }, { clave: 'm2', titulo: 'm2', tipo: 'numero' }, { clave: 'importe', titulo: 'Importe ($)', tipo: 'numero' }
    ] : [
      { clave: 'nombre', titulo }, { clave: 'ventas', titulo: 'Ventas', tipo: 'numero' }, { clave: 'm2', titulo: 'm2', tipo: 'numero' },
      { clave: 'importe', titulo: 'Importe ($)', tipo: 'numero' }, { clave: 'ticket', titulo: 'Ticket promedio ($)', tipo: 'numero' }, { clave: 'participacion', titulo: '% del total', tipo: 'numero' }
    ];
    const filas = d.filas.slice();
    filas.push(det ? { fecha: 'TOTAL', m2: d.totales.m2, importe: d.totales.importe } : { nombre: 'TOTAL', ventas: d.totales.ventas, m2: d.totales.m2, importe: d.totales.importe, ticket: d.totales.ticket, participacion: 100 });
    exportarXlsx(res, 'informe-ventas-' + d.agrupar + '-' + d.desde + '_' + d.hasta + '.xlsx', columnas, filas);
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Estado de resultados:  GET /api/informes/resultados  (módulo 'informe_resultados')
//   Filtros: desde, hasta, alcance = actual (sucursal elegida arriba) | todas
//   (suma las sucursales que el usuario tiene asignadas). formato=xlsx descarga.
//   Columnas = meses del período.
//
// Criterios (para poder auditar los números):
//   - Ventas netas: ventas no anuladas por fecha, SIN IVA (se descuenta el IVA
//     de los comprobantes fiscales), en pesos (USD con la cotización de la venta);
//     las notas de crédito restan.
//   - Costo de mercadería vendida: cantidad de cada ítem x costo ACTUAL del
//     producto en la ficha (USD con la cotización vigente de la sucursal; si
//     no hay, la de la venta); las notas de crédito restan. Es una aproximación:
//     si el costo cambió desde la venta, usa el de hoy. Lo vendido sin costo
//     cargado se informa aparte ("sin costo") y no entra en el costo.
//   - Gastos: gastos activos por fecha, sin IVA, por concepto (descuentos
//     aplicados; USD con la cotización del gasto). Las compras de mercadería
//     NO son gasto: ya están representadas por el costo de mercadería vendida.
//   - Doble conteo: los productos de producción ya llevan adentro mano de obra
//     (y los insumos entran por las compras, que no son gasto). Los conceptos de
//     gasto que el administrador marca como "incluidos en el costo de producción"
//     (p. ej. sueldos de operarios) NO se restan de nuevo: se muestran aparte,
//     como dato informativo. Se configura por sucursal (config_general).
//   - Sueldos: si se usa el módulo Sueldos, el costo de empresa de cada
//     liquidación entra por período (mes completo): sector Producción como "ya
//     incluido en el costo" y los demás sectores como gasto "Sueldos y cargas".
//     Los conceptos de Gastos con sueldos/cargas hay que marcarlos como "ya
//     contados" para no duplicar.
//   - Resultado = ventas netas - costo de mercadería - gastos. Es un resultado
//     operativo de gestión: no incluye impuestos a las ganancias ni intereses.
// ---------------------------------------------------------------------------
function mesDe(d) { return fechaAR(d).slice(0, 7); }
function mesesEntre(desdeS, hastaS) {
  const out = []; let [y, m] = desdeS.slice(0, 7).split('-').map(Number); const fin = hastaS.slice(0, 7);
  for (;;) { const k = y + '-' + String(m).padStart(2, '0'); out.push(k); if (k >= fin) break; m++; if (m > 12) { m = 1; y++; } if (out.length > 60) break; }
  return out;
}

async function conceptosEnCosto(db, orgId) {
  const d = await db.collection('config_general').findOne({ orgId, clave: 'resultadosConceptosEnCosto' });
  return (d && Array.isArray(d.valor)) ? d.valor : [];
}

async function sueldosProduccionGasto(db, orgId) {
  const d = await db.collection('config_general').findOne({ orgId, clave: 'resultadosSueldosProduccionGasto' });
  return !!(d && d.valor === true);
}

// Colocación de obras (Gestión de Obras): lo que se les paga a los colocadores, por tarea terminada
// (100 % de los m² x el costo por m² que quedó aplicado a esa tarea), en el mes en que se terminó.
// Es el mismo criterio del reporte de m² de Obras. Se muestra como gasto si se activa en la configuración.
async function colocacionComoGasto(db, orgId) {
  const d = await db.collection('config_general').findOne({ orgId, clave: 'resultadosColocacionGasto' });
  return d ? d.valor === true : true; // por defecto se muestra: los colocadores se liquidan desde Sueldos
}

async function resultadosOrg(db, orgId, d0, d1) {
  const meses = {};
  const mes = k => meses[k] || (meses[k] = { ventas: 0, costo: 0, sinCosto: 0, enCosto: 0, manoObra: 0, sinReceta: 0, gastos: {} });
  const sueldosGasto = await sueldosProduccionGasto(db, orgId);
  const colocacionGasto = await colocacionComoGasto(db, orgId);
  const cotDoc = await db.collection('config_general').findOne({ orgId, clave: 'cotizacionDolar' });
  const cotVigente = cotDoc && Number(cotDoc.valor) > 0 ? Number(cotDoc.valor) : null;

  const ventas = await db.collection('ventas').find({ orgId, estado: { $ne: 'anulada' }, fecha: { $gte: d0, $lte: d1 } }).limit(50000).toArray();
  const ids = new Set();
  ventas.forEach(v => (v.items || []).forEach(it => { if (it.productoId) ids.add(String(it.productoId)); }));
  const prods = ids.size ? await db.collection('productos_catalogo').find({ _id: { $in: [...ids].map(toObjectId) } }).project({ costo: 1, moneda: 1, tipoProducto: 1, costoProductoId: 1 }).toArray() : [];
  const pm = new Map(prods.map(p => [String(p._id), p]));
  // Mano de obra por unidad de cada producto con receta (jornales x costo del jornal), solo si los sueldos de
  // producción se muestran como gasto: hay que sacarla del costo de la mercadería para no contarla dos veces.
  const manoObraPorReceta = new Map();
  if (sueldosGasto) {
    const links = [...new Set(prods.map(p => p.costoProductoId).filter(Boolean).map(String))];
    if (links.length) {
      const recetas = await db.collection('costos_productos').find({ orgId, _id: { $in: links.map(toObjectId) } }).project({ receta: 1 }).toArray();
      const insIds = [...new Set(recetas.flatMap(r => (r.receta || []).map(f => String(f.insumoId))))];
      const ins = insIds.length ? await db.collection('costos_insumos').find({ orgId, _id: { $in: insIds.map(toObjectId) } }).project({ unidad: 1, costoActual: 1 }).toArray() : [];
      const im = new Map(ins.map(i => [String(i._id), i]));
      recetas.forEach(r => manoObraPorReceta.set(String(r._id), (r.receta || []).reduce((a, f) => { const i = im.get(String(f.insumoId)); return a + (i && i.unidad === 'jornal' ? Number(f.cantidad || 0) * Number(i.costoActual || 0) : 0); }, 0)));
    }
  }
  ventas.forEach(v => {
    const nc = v.tipoComprobante === 'nota_credito' ? -1 : 1;
    const usd = v.moneda === 'USD' ? (Number(v.cotizacionDolar) || 1) : 1;
    // IVA en pesos de los comprobantes fiscales (mismo criterio que el Libro IVA Ventas).
    const iva = (v.esFiscal && v.cae && v.fiscal) ? Number(v.fiscal.iva || 0) * ((v.fiscalMoneda === 'DOL' && Number(v.fiscalCotiz) > 0) ? Number(v.fiscalCotiz) : 1) : 0;
    const neto = (Number(v.total || 0) * usd - iva) * nc;
    const m = mes(mesDe(v.fecha));
    m.ventas += neto;
    const items = v.items || [], sub = items.reduce((a, it) => a + Number(it.subtotal || 0), 0);
    items.forEach(it => {
      const p = it.productoId ? pm.get(String(it.productoId)) : null;
      let costoU = null;
      if (p && p.costo != null) costoU = p.moneda === 'USD' ? ((cotVigente || (v.moneda === 'USD' ? Number(v.cotizacionDolar) : 0)) ? p.costo * (cotVigente || Number(v.cotizacionDolar)) : null) : Number(p.costo);
      if (costoU == null) { m.sinCosto += neto * (sub > 0 ? Number(it.subtotal || 0) / sub : (items.length ? 1 / items.length : 0)); return; }
      let costoEf = costoU;
      const cant = Number(it.cantidad || 0);
      if (sueldosGasto && p) {
        const mo = p.costoProductoId ? (manoObraPorReceta.get(String(p.costoProductoId)) || 0) : 0;
        if (mo > 0) { costoEf = Math.max(0, costoU - mo); m.manoObra += cant * (costoU - costoEf) * nc; }
        else if (p.tipoProducto === 'produccion' && !p.costoProductoId) m.sinReceta += cant * costoU * nc;
      }
      m.costo += cant * costoEf * nc;
    });
  });

  const excl = new Set(await conceptosEnCosto(db, orgId));
  const gastos = await db.collection('gastos').find({ orgId, estado: { $ne: 'anulada' }, fecha: { $gte: d0, $lte: d1 } }).limit(50000).toArray();
  gastos.forEach(g => {
    const signo = /^nota_credito/.test(g.tipoComprobante) ? -1 : 1;
    const items = g.items || [], sub = items.reduce((a, it) => a + Number(it.subtotal || 0), 0);
    let conDesc = sub;
    if (g.descuentoPorcentaje) conDesc -= conDesc * (g.descuentoPorcentaje / 100);
    if (g.descuentoMonto) conDesc -= g.descuentoMonto;
    const factor = sub > 0 ? Math.max(0, conDesc) / sub : 1;
    const usd = g.moneda === 'USD' && Number(g.cotizacionDolar) > 0 ? Number(g.cotizacionDolar) : 1;
    const m = mes(mesDe(g.fecha));
    items.forEach(it => {
      const c = it.conceptoNombre || 'Sin concepto', monto = signo * Number(it.subtotal || 0) * factor * usd;
      if (excl.has(c)) m.enCosto += monto; else m.gastos[c] = (m.gastos[c] || 0) + monto;
    });
  });

  // Sueldos (módulo Sueldos): el costo de empresa de cada liquidación entra en su período.
  // Producción: ya está dentro del costo de los productos (solo informativo); el resto es gasto.
  const SECTORES = { obra: 'Obra', produccion: 'Producción', administracion: 'Administración', ventas: 'Ventas', logistica: 'Logística', otro: 'Otros' };
  const periodos = mesesEntre(fechaAR(d0), fechaAR(d1));
  const liqs = await db.collection('sueldos_liquidaciones').find({ orgId, periodo: { $in: periodos } }).project({ periodo: 1, sector: 1, costoEmpresa: 1 }).toArray();
  liqs.forEach(l => {
    const m = mes(l.periodo);
    if (l.sector === 'produccion' && !sueldosGasto) m.enCosto += Number(l.costoEmpresa || 0);
    else { const c = 'Sueldos y cargas · ' + (SECTORES[l.sector] || 'Otros'); m.gastos[c] = (m.gastos[c] || 0) + Number(l.costoEmpresa || 0); }
  });
  if (colocacionGasto) {
    const obras = await db.collection('obras').aggregate([
      { $match: { orgId, 'tareas.estado': 'terminada' } }, { $unwind: '$tareas' },
      { $match: { 'tareas.estado': 'terminada', 'tareas.colocadorId': { $ne: null }, 'tareas.fechaFinReal': { $gte: d0, $lte: d1 } } },
      { $project: { fin: '$tareas.fechaFinReal', monto: { $multiply: [{ $ifNull: ['$tareas.m2Presupuestados', 0] }, { $ifNull: ['$tareas.costoPorM2Aplicado', 0] }] } } }
    ]).toArray();
    obras.forEach(o => { const m = mes(mesDe(o.fin)); const c = 'Sueldos y cargas · Obra (colocadores)'; m.gastos[c] = (m.gastos[c] || 0) + Number(o.monto || 0); });
  }
  return meses;
}

// Los gastos de sueldos se agrupan bajo "Sueldos y cargas", abiertos por sector.
const PREF_SUELDOS = 'Sueldos y cargas · ';
const ORDEN_SUELDOS = ['Obra', 'Producción', 'Ventas', 'Administración', 'Logística', 'Otros'];
function agruparGastos(conceptos) {
  const pos = c => { const i = ORDEN_SUELDOS.findIndex(x => c.slice(PREF_SUELDOS.length).startsWith(x)); return i < 0 ? 99 : i; };
  return { otros: conceptos.filter(c => !c.startsWith(PREF_SUELDOS)), sueldos: conceptos.filter(c => c.startsWith(PREF_SUELDOS)).sort((a, b) => pos(a) - pos(b)) };
}

async function armarResultados(req) {
  const hoy = fechaAR(new Date());
  const desdeS = req.query.desde || hoy.slice(0, 4) + '-01-01';
  const hastaS = req.query.hasta || hoy;
  if (!validarFecha(desdeS) || !validarFecha(hastaS)) throw err(400, 'Las fechas tienen que tener el formato AAAA-MM-DD.');
  if (desdeS > hastaS) throw err(400, 'La fecha "desde" no puede ser posterior a "hasta".');
  const todas = req.query.alcance === 'todas';
  return conReintento(async () => {
    const db = await getDb();
    let orgIds;
    if (todas) {
      const u = req.usuario;
      const orgs = u.rol.protegido ? await db.collection('organizaciones').find({}).project({ _id: 1 }).toArray()
        : (u.orgIds || []).map(toObjectId).filter(Boolean).map(_id => ({ _id }));
      orgIds = orgs.map(o => o._id);
    } else {
      if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
      orgIds = [req.orgId];
    }
    const partes = await Promise.all(orgIds.map(id => resultadosOrg(db, id, inicioDia(desdeS), finDia(hastaS))));
    const claves = mesesEntre(desdeS, hastaS);
    const conceptos = new Set();
    const cols = claves.map(k => {
      const c = { mes: k, ventas: 0, costo: 0, sinCosto: 0, enCosto: 0, manoObra: 0, sinReceta: 0, gastos: {} };
      partes.forEach(p => { const m = p[k]; if (!m) return; c.ventas += m.ventas; c.costo += m.costo; c.sinCosto += m.sinCosto; c.enCosto += m.enCosto; c.manoObra += m.manoObra; c.sinReceta += m.sinReceta; Object.keys(m.gastos).forEach(g => { conceptos.add(g); c.gastos[g] = (c.gastos[g] || 0) + m.gastos[g]; }); });
      return c;
    });
    const listaConceptos = [...conceptos].sort((a, b) => a.localeCompare(b, 'es'));
    const fin = c => {
      const gastosTotal = Object.values(c.gastos).reduce((a, x) => a + x, 0);
      const margen = c.ventas - c.costo;
      return { mes: c.mes, ventasNetas: r2(c.ventas), costo: r2(c.costo), margenBruto: r2(margen), margenPct: c.ventas ? r2(margen / c.ventas * 100) : null,
        gastos: Object.fromEntries(listaConceptos.map(g => [g, r2(c.gastos[g] || 0)])), gastosTotal: r2(gastosTotal),
        resultado: r2(margen - gastosTotal), resultadoPct: c.ventas ? r2((margen - gastosTotal) / c.ventas * 100) : null, sinCosto: r2(c.sinCosto), enCosto: r2(c.enCosto), manoObraDescontada: r2(c.manoObra), sinReceta: r2(c.sinReceta) };
    };
    const total = fin(cols.reduce((a, c) => {
      a.ventas += c.ventas; a.costo += c.costo; a.sinCosto += c.sinCosto; a.enCosto += c.enCosto; a.manoObra += c.manoObra; a.sinReceta += c.sinReceta;
      Object.keys(c.gastos).forEach(g => { a.gastos[g] = (a.gastos[g] || 0) + c.gastos[g]; }); return a;
    }, { mes: 'total', ventas: 0, costo: 0, sinCosto: 0, enCosto: 0, manoObra: 0, sinReceta: 0, gastos: {} }));
    return { desde: desdeS, hasta: hastaS, alcance: todas ? 'todas' : 'actual', sucursales: orgIds.length, conceptos: listaConceptos, conceptosOtros: agruparGastos(listaConceptos).otros, conceptosSueldos: agruparGastos(listaConceptos).sueldos, meses: cols.map(fin), total };
  });
}

router.get('/resultados/config', authInforme('informe_resultados'), async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const out = await conReintento(async () => {
      const db = await getDb();
      const [catalogo, usados, excluidos, spg, cog] = await Promise.all([
        db.collection('gastos_conceptos').find({ orgId: req.orgId }).project({ nombre: 1 }).toArray(),
        db.collection('gastos').distinct('items.conceptoNombre', { orgId: req.orgId }),
        conceptosEnCosto(db, req.orgId),
        sueldosProduccionGasto(db, req.orgId),
        colocacionComoGasto(db, req.orgId)
      ]);
      const set = new Set([...catalogo.map(c => c.nombre), ...usados, ...excluidos].filter(Boolean));
      return { conceptos: [...set].sort((a, b) => a.localeCompare(b, 'es')), enCosto: excluidos, sueldosProduccionGasto: spg, colocacionGasto: cog };
    });
    res.json(Object.assign(out, { puedeEditar: !!req.usuario.rol.protegido }));
  } catch (e) { responder(res, e); }
});
router.put('/resultados/config', authInforme('informe_resultados'), async (req, res) => {
  try {
    if (!req.usuario.rol.protegido) throw err(403, 'Solo un administrador puede elegir qué gastos ya están incluidos en el costo.');
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const lista = Array.isArray(req.body && req.body.enCosto) ? req.body.enCosto : null;
    const spg = req.body && typeof req.body.sueldosProduccionGasto === 'boolean' ? req.body.sueldosProduccionGasto : null;
    const cog = req.body && typeof req.body.colocacionGasto === 'boolean' ? req.body.colocacionGasto : null;
    if (!lista && spg === null && cog === null) throw err(400, 'Falta la lista de conceptos.');
    const valor = lista ? [...new Set(lista.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 100) : null;
    await conReintento(async () => {
      const db = await getDb(); const ahora = new Date();
      const guardar = (clave, v) => db.collection('config_general').updateOne({ orgId: req.orgId, clave },
        { $set: { valor: v, updatedAt: ahora }, $setOnInsert: { orgId: req.orgId, clave, createdAt: ahora } }, { upsert: true });
      if (valor) await guardar('resultadosConceptosEnCosto', valor);
      if (spg !== null) await guardar('resultadosSueldosProduccionGasto', spg);
      if (cog !== null) await guardar('resultadosColocacionGasto', cog);
    });
    res.json({ enCosto: valor, sueldosProduccionGasto: spg, colocacionGasto: cog });
  } catch (e) { responder(res, e); }
});

const NOMBRES_MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
router.get('/resultados', authInforme('informe_resultados'), async (req, res) => {
  try {
    const d = await armarResultados(req);
    if (req.query.formato !== 'xlsx') return res.json(d);
    const XLSX = require('xlsx');
    const enc = ['Concepto'].concat(d.meses.map(m => NOMBRES_MES[+m.mes.slice(5) - 1] + ' ' + m.mes.slice(0, 4)), ['Total']);
    const fila = (n, f) => [n].concat(d.meses.map(f), [f(d.total)]);
    const aoa = [enc,
      fila('Ventas netas (sin IVA)', m => m.ventasNetas), fila('Costo de mercadería vendida', m => -m.costo), fila('Margen bruto', m => m.margenBruto),
      fila('Margen bruto %', m => m.margenPct == null ? '' : m.margenPct), [], ['Gastos']
    ].concat(d.conceptosOtros.map(c => fila('  ' + c, m => -m.gastos[c])), d.conceptosSueldos.length ? [fila('  Sueldos y cargas', m => -d.conceptosSueldos.reduce((a, c) => a + (m.gastos[c] || 0), 0))].concat(d.conceptosSueldos.map(c => fila('      ' + c.slice(PREF_SUELDOS.length), m => -m.gastos[c]))) : [], [fila('Total gastos', m => -m.gastosTotal), [], fila('RESULTADO', m => m.resultado), fila('Resultado %', m => m.resultadoPct == null ? '' : m.resultadoPct), [], fila('Informativo: gastos ya contados de producción (no se restan de nuevo)', m => -m.enCosto), fila('Informativo: ventas sin costo cargado', m => m.sinCosto)], (d.total.manoObraDescontada || d.total.sinReceta) ? [fila('Informativo: mano de obra de receta descontada del costo de lo vendido', m => -m.manoObraDescontada), fila('Informativo: costo de productos de producción sin receta vinculada (no se les descontó mano de obra)', m => m.sinReceta)] : []);
    const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [{ wch: 38 }].concat(enc.slice(1).map(() => ({ wch: 15 })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Estado de resultados');
    res.setHeader('Content-Disposition', 'attachment; filename="estado-de-resultados-' + d.desde + '_' + d.hasta + '.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  } catch (e) { responder(res, e); }
});

// ---------------------------------------------------------------------------
// Deudores y Proveedores (7/10/2026, pedido de Mato) — saldos al día de hoy.
//
// Deudores:    GET /api/informes/deudores   (módulo 'informe_deudores')
//   Qué te deben los clientes: saldo pendiente de cobro de cada comprobante de
//   venta (sin anuladas, sin notas de crédito), en pesos (las ventas en USD van
//   con la cotización guardada en la venta). Es el mismo criterio de "por
//   cobrar" del tablero de facturación.
// Proveedores: GET /api/informes/proveedores (módulo 'informe_proveedores')
//   Qué les debés a los proveedores: saldo pendiente de pago de Compras y de
//   Gastos (sin anuladas), en pesos. Mismo criterio de "por pagar" del tablero.
//
// Antigüedad = días desde la fecha del comprobante hasta hoy (no hay fecha de
// vencimiento cargada): 0-30, 31-60, 61-90 y más de 90 días.
//   agrupar = cliente|proveedor (una fila por cuenta) | comprobante (detalle).
//   formato=xlsx descarga lo mismo en Excel. Datos de la sucursal elegida arriba.
// ---------------------------------------------------------------------------
const TRAMOS = [{ k: 't0', t: '0-30 días', max: 30 }, { k: 't1', t: '31-60 días', max: 60 }, { k: 't2', t: '61-90 días', max: 90 }, { k: 't3', t: 'Más de 90 días', max: Infinity }];
function diasDesde(fecha) {
  const a = inicioDia(fechaAR(new Date())).getTime(), b = inicioDia(fechaAR(fecha)).getTime();
  return Math.max(0, Math.round((a - b) / 86400e3));
}
function tramoDe(dias) { return TRAMOS.find(t => dias <= t.max).k; }
function formaFechaCorta(s) { const [y, m, d] = s.split('-'); return d + '/' + m + '/' + y; }

// Junta comprobantes ({cuenta, cuentaId, fecha, comprobante, tipo, saldo, ...}) en filas por cuenta o por comprobante.
function armarSaldos(comps, agrupar, minDias) {
  comps.forEach(c => { c.dias = diasDesde(c.fecha); c.tramo = tramoDe(c.dias); c.fechaS = fechaAR(c.fecha); });
  const lista = comps.filter(c => c.dias >= minDias && c.saldo > 0.005);
  const tot = { saldo: 0, comprobantes: lista.length, cuentas: new Set(), t0: 0, t1: 0, t2: 0, t3: 0 };
  lista.forEach(c => { tot.saldo += c.saldo; tot[c.tramo] += c.saldo; tot.cuentas.add(c.cuenta); });
  let filas;
  if (agrupar === 'comprobante') {
    filas = lista.sort((a, b) => b.dias - a.dias || b.saldo - a.saldo).map(c => ({
      fecha: c.fechaS, comprobante: c.comprobante, cuenta: c.cuenta, tipo: c.tipo || '', vendedor: c.vendedor || '', dias: c.dias, saldo: r2(c.saldo)
    }));
  } else {
    const por = new Map();
    lista.forEach(c => {
      const g = por.get(c.cuenta) || { nombre: c.cuenta, cuentaId: c.cuentaId ? String(c.cuentaId) : '', comprobantes: 0, saldo: 0, t0: 0, t1: 0, t2: 0, t3: 0, masAntiguo: 0, saldoCompras: 0, saldoGastos: 0 };
      g.comprobantes++; g.saldo += c.saldo; g[c.tramo] += c.saldo; g.masAntiguo = Math.max(g.masAntiguo, c.dias);
      if (c.tipo === 'Compra') g.saldoCompras += c.saldo; else if (c.tipo === 'Gasto') g.saldoGastos += c.saldo;
      por.set(c.cuenta, g);
    });
    filas = [...por.values()].sort((a, b) => b.saldo - a.saldo).map(g => ({
      nombre: g.nombre, cuentaId: g.cuentaId, comprobantes: g.comprobantes, saldo: r2(g.saldo), t0: r2(g.t0), t1: r2(g.t1), t2: r2(g.t2), t3: r2(g.t3),
      masAntiguo: g.masAntiguo, saldoCompras: r2(g.saldoCompras), saldoGastos: r2(g.saldoGastos), participacion: tot.saldo ? r2(g.saldo / tot.saldo * 100) : 0
    }));
  }
  return { agrupar, filas, totales: { saldo: r2(tot.saldo), comprobantes: tot.comprobantes, cuentas: tot.cuentas.size, t0: r2(tot.t0), t1: r2(tot.t1), t2: r2(tot.t2), t3: r2(tot.t3) } };
}
function minDiasQuery(req) {
  const n = Number(req.query.minDias || 0);
  if (!Number.isFinite(n) || n < 0) throw err(400, 'Los días mínimos tienen que ser un número positivo.');
  return n;
}
function agruparQuery(req) {
  const a = req.query.agrupar === 'comprobante' ? 'comprobante' : 'cuenta';
  if (req.query.agrupar && !['cliente', 'proveedor', 'cuenta', 'comprobante'].includes(req.query.agrupar)) throw err(400, 'Agrupación inválida.');
  return a;
}
function columnasSaldos(det, tituloCuenta, esProv) {
  const tr = TRAMOS.map(t => ({ clave: t.k, titulo: t.t + ' ($)', tipo: 'numero' }));
  return det
    ? [{ clave: 'fecha', titulo: 'Fecha' }, { clave: 'comprobante', titulo: 'Comprobante' }, { clave: 'cuenta', titulo: tituloCuenta }].concat(esProv ? [{ clave: 'tipo', titulo: 'Tipo' }] : [{ clave: 'vendedor', titulo: 'Vendedor' }], [{ clave: 'dias', titulo: 'Días de antigüedad', tipo: 'numero' }, { clave: 'saldo', titulo: 'Saldo ($)', tipo: 'numero' }])
    : [{ clave: 'nombre', titulo: tituloCuenta }, { clave: 'comprobantes', titulo: 'Comprobantes', tipo: 'numero' }].concat(esProv ? [{ clave: 'saldoCompras', titulo: 'Compras ($)', tipo: 'numero' }, { clave: 'saldoGastos', titulo: 'Gastos ($)', tipo: 'numero' }] : [], tr, [{ clave: 'masAntiguo', titulo: 'Más antiguo (días)', tipo: 'numero' }, { clave: 'saldo', titulo: 'Saldo total ($)', tipo: 'numero' }, { clave: 'participacion', titulo: '% del total', tipo: 'numero' }]);
}
function totalXlsx(d, det, esProv) {
  const T = d.totales;
  return det ? { fecha: 'TOTAL', saldo: T.saldo } : Object.assign({ nombre: 'TOTAL', comprobantes: T.comprobantes, t0: T.t0, t1: T.t1, t2: T.t2, t3: T.t3, saldo: T.saldo, participacion: 100 });
}

router.get('/deudores/opciones', authInforme('informe_deudores'), async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const base = Object.assign({ estado: { $ne: 'anulada' }, tipoComprobante: { $ne: 'nota_credito' }, saldoPendiente: { $gt: 0 } }, filtroOrg(req));
      const [vendedores, clientes] = await Promise.all([
        db.collection('ventas').distinct('vendedor', Object.assign({ vendedor: { $nin: [null, ''] } }, base)),
        db.collection('ventas').aggregate([{ $match: Object.assign({ clienteId: { $ne: null } }, base) }, { $group: { _id: '$clienteId', nombre: { $last: '$clienteNombre' } } }, { $sort: { nombre: 1 } }]).toArray()
      ]);
      return { vendedores: vendedores.sort((a, b) => a.localeCompare(b, 'es')), clientes: clientes.map(c => ({ _id: String(c._id), nombre: c.nombre || '(sin nombre)' })) };
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

async function armarDeudores(req) {
  const agrupar = agruparQuery(req), minDias = minDiasQuery(req);
  const clienteId = req.query.clienteId ? toObjectId(req.query.clienteId) : null;
  if (req.query.clienteId && !clienteId) throw err(400, 'clienteId inválido');
  const vendedor = String(req.query.vendedor || '').trim();
  return conReintento(async () => {
    const db = await getDb();
    const match = Object.assign({ estado: { $ne: 'anulada' }, tipoComprobante: { $ne: 'nota_credito' }, saldoPendiente: { $gt: 0 } }, filtroOrg(req));
    if (clienteId) match.clienteId = clienteId;
    if (vendedor) match.vendedor = vendedor;
    const ventas = await db.collection('ventas').find(match).project({ fecha: 1, numero: 1, tipoComprobante: 1, letra: 1, clienteId: 1, clienteNombre: 1, vendedor: 1, moneda: 1, cotizacionDolar: 1, saldoPendiente: 1 }).limit(20000).toArray();
    const comps = ventas.map(v => ({
      cuenta: v.clienteNombre || '(sin cliente)', cuentaId: v.clienteId, fecha: v.fecha, comprobante: etiquetaComprobante(v), vendedor: v.vendedor || '',
      saldo: Number(v.saldoPendiente || 0) * (v.moneda === 'USD' ? (Number(v.cotizacionDolar) || 1) : 1)
    }));
    return Object.assign(armarSaldos(comps, agrupar, minDias), { hoy: fechaAR(new Date()), truncado: ventas.length >= 20000 });
  });
}
router.get('/deudores', authInforme('informe_deudores'), async (req, res) => {
  try {
    const d = await armarDeudores(req);
    if (req.query.formato !== 'xlsx') return res.json(d);
    const det = d.agrupar === 'comprobante';
    const filas = d.filas.map(f => det ? Object.assign({}, f, { fecha: formaFechaCorta(f.fecha) }) : f).concat([totalXlsx(d, det, false)]);
    exportarXlsx(res, 'deudores-' + (det ? 'comprobantes-' : 'clientes-') + d.hoy + '.xlsx', columnasSaldos(det, 'Cliente', false), filas);
  } catch (e) { responder(res, e); }
});

router.get('/proveedores/opciones', authInforme('informe_proveedores'), async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const base = Object.assign({ estado: { $ne: 'anulada' }, saldoPendiente: { $gt: 0 } }, filtroOrg(req));
      const grp = [{ $match: Object.assign({ proveedorId: { $ne: null } }, base) }, { $group: { _id: '$proveedorId', nombre: { $last: '$proveedorNombre' } } }];
      const [a, b] = await Promise.all([db.collection('compras').aggregate(grp).toArray(), db.collection('gastos').aggregate(grp).toArray()]);
      const m = new Map(); a.concat(b).forEach(p => m.set(String(p._id), p.nombre || '(sin nombre)'));
      return { proveedores: [...m.entries()].map(([_id, nombre]) => ({ _id, nombre })).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')) };
    });
    res.json(out);
  } catch (e) { responder(res, e); }
});

async function armarProveedores(req) {
  const agrupar = agruparQuery(req), minDias = minDiasQuery(req);
  const proveedorId = req.query.proveedorId ? toObjectId(req.query.proveedorId) : null;
  if (req.query.proveedorId && !proveedorId) throw err(400, 'proveedorId inválido');
  const tipo = ['compras', 'gastos'].includes(req.query.tipo) ? req.query.tipo : 'todos';
  return conReintento(async () => {
    const db = await getDb();
    const match = Object.assign({ estado: { $ne: 'anulada' }, saldoPendiente: { $gt: 0 } }, filtroOrg(req));
    if (proveedorId) match.proveedorId = proveedorId;
    const proj = { fecha: 1, numero: 1, comprobanteNumero: 1, proveedorId: 1, proveedorNombre: 1, moneda: 1, cotizacionDolar: 1, saldoPendiente: 1 };
    const [compras, gastos] = await Promise.all([
      tipo === 'gastos' ? [] : db.collection('compras').find(match).project(proj).limit(20000).toArray(),
      tipo === 'compras' ? [] : db.collection('gastos').find(match).project(proj).limit(20000).toArray()
    ]);
    const conv = (x, t) => ({
      cuenta: x.proveedorNombre || '(sin proveedor)', cuentaId: x.proveedorId, fecha: x.fecha, tipo: t,
      comprobante: (t === 'Compra' ? 'Compra #' : 'Gasto #') + (x.numero != null ? x.numero : '') + (x.comprobanteNumero ? ' · ' + x.comprobanteNumero : ''),
      saldo: Number(x.saldoPendiente || 0) * (x.moneda === 'USD' ? (Number(x.cotizacionDolar) || 1) : 1)
    });
    const comps = compras.map(c => conv(c, 'Compra')).concat(gastos.map(g => conv(g, 'Gasto')));
    return Object.assign(armarSaldos(comps, agrupar, minDias), { hoy: fechaAR(new Date()), tipo, truncado: compras.length >= 20000 || gastos.length >= 20000 });
  });
}
router.get('/proveedores', authInforme('informe_proveedores'), async (req, res) => {
  try {
    const d = await armarProveedores(req);
    if (req.query.formato !== 'xlsx') return res.json(d);
    const det = d.agrupar === 'comprobante';
    const T = d.totales;
    const filas = d.filas.map(f => det ? Object.assign({}, f, { fecha: formaFechaCorta(f.fecha) }) : f);
    filas.push(det ? { fecha: 'TOTAL', saldo: T.saldo } : { nombre: 'TOTAL', comprobantes: T.comprobantes, saldoCompras: r2(d.filas.reduce((a, f) => a + f.saldoCompras, 0)), saldoGastos: r2(d.filas.reduce((a, f) => a + f.saldoGastos, 0)), t0: T.t0, t1: T.t1, t2: T.t2, t3: T.t3, saldo: T.saldo, participacion: 100 });
    exportarXlsx(res, 'deuda-proveedores-' + (det ? 'comprobantes-' : 'proveedores-') + d.hoy + '.xlsx', columnasSaldos(det, 'Proveedor', true), filas);
  } catch (e) { responder(res, e); }
});

module.exports = router;
