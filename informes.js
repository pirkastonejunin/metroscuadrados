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
        const rub = (p && p.rubro) || 'Sin rubro';
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
        g.ids.add(String(l.v._id)); g.m2 += l.m2; g.importe += l.importe; por.set(k, g);
      });
      const totalImp = [...por.values()].reduce((a, g) => a + g.importe, 0);
      filas = [...por.values()].map(g => ({
        nombre: g.nombre, ventas: g.ids.size, m2: r2(g.m2), importe: r2(g.importe),
        ticket: g.ids.size ? r2(g.importe / g.ids.size) : 0, participacion: totalImp ? r2(g.importe / totalImp * 100) : 0
      })).sort((a, b) => b.importe - a.importe);
    }
    const cant = new Set(lineas.map(l => String(l.v._id))).size;
    const totalImporte = r2(lineas.reduce((a, l) => a + l.importe, 0));
    return {
      desde: desdeS, hasta: hastaS, agrupar, filas,
      totales: { ventas: cant, m2: r2(lineas.reduce((a, l) => a + l.m2, 0)), importe: totalImporte, ticket: cant ? r2(totalImporte / cant) : 0 },
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

module.exports = router;
