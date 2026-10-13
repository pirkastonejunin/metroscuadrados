// ---------------------------------------------------------------------------
// Importar STOCK de Dux (Dux: "Consulta de Stock", un Excel por depósito) al depósito que se elija.
// El "Stock Real" de Dux pasa a ser el stock de ese depósito: por cada producto se registra UN movimiento de ajuste
// ("Stock inicial Dux") por la diferencia contra lo que ya hay. Es repetible: volver a subir el archivo no duplica,
// solo ajusta la diferencia. "Stock Reservado" se ignora (el sistema calcula el comprometido con sus propias ventas).
// Stock negativo en Dux (se vendió sin tener) se carga como 0 y se informa aparte.
// Los productos se buscan por Código Producto = SKU (y, si no, por nombre exacto entre los que no tienen SKU). Los que no existen en el catálogo y
// tienen stock se pueden crear (opción "crearFaltantes", activa por defecto).
// Rutas: POST /api/stock-import-dux/preview y /aplicar   body: { archivoBase64, depositoId, crearFaltantes? }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const auth = [authUsuario, resolverOrg, requiereModulo('stock')];

let mongoClient, mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(() => { mongoClient = nuevo; mongoConectando = null; }, (e) => { mongoConectando = null; throw e; });
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) { try { return await fn(); } catch (e) { if (e.status) throw e; mongoClient = null; return await fn(); } }
function err(status, message) { return Object.assign(new Error(message), { status }); }
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
function numero(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).trim().replace(/\s/g, '');
  if (!s) return 0;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}

function leer(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb; try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'codigo producto') && f.some(c => norm(c) === 'stock real'));
  if (h < 0) throw err(400, 'No encontré las columnas Código Producto y Stock Real. Tiene que ser "Consulta de Stock" de Dux.');
  const enc = filas[h].map(norm);
  const col = (n) => enc.indexOf(n);
  const ic = col('codigo producto'), inom = col('producto'), ir = col('stock real'), iu = col('unidad'), ico = col('costo'), im = col('marca'), iru = col('rubro');
  const productos = [], vistos = new Map();
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i]; if (!f) continue;
    const codigo = String(f[ic] == null ? '' : f[ic]).trim();
    const nombre = String(f[inom] == null ? '' : f[inom]).trim();
    if (!codigo && !nombre) continue;
    const real = numero(f[ir]);
    const p = { codigo, nombre, real, unidad: norm(f[iu]) === 'm2' ? 'm2' : 'unidad', costo: numero(f[ico]), marca: f[im] || '', rubro: f[iru] || '' };
    const clave = codigo.toUpperCase();
    if (clave && vistos.has(clave)) { const prev = vistos.get(clave); prev.real = round3(prev.real + real); continue; } // código repetido: se suma
    if (clave) vistos.set(clave, p);
    productos.push(p);
  }
  return productos;
}

async function procesar(req, aplicar) {
  const body = req.body || {};
  let depositoId; try { depositoId = new ObjectId(String(body.depositoId)); } catch (e) { throw err(400, 'Elegí el depósito al que va este stock.'); }
  const crearFaltantes = body.crearFaltantes !== false;
  const productos = leer(body.archivoBase64);

  return conReintento(async () => {
    const db = await getDb();
    // La sucursal es la del depósito elegido (el stock siempre se guarda en la sucursal dueña del depósito).
    const deposito = await db.collection('depositos').findOne({ _id: depositoId });
    if (!deposito) throw err(404, 'Depósito no encontrado.');
    const orgId = deposito.orgId;
    if (req.orgId && String(req.orgId) !== String(orgId)) throw err(400, 'Ese depósito es de otra sucursal: cambiá a esa sucursal (o a "Todas") para importar.');
    const u = req.usuario || {};
    if (!(u.rol && u.rol.protegido) && Array.isArray(u.orgIds) && u.orgIds.length && !u.orgIds.map(String).includes(String(orgId))) throw err(403, 'No tenés acceso a la sucursal de ese depósito.');
    const catalogo = await db.collection('productos_catalogo').find({ orgId }, { projection: { sku: 1, nombre: 1, activo: 1 } }).toArray();
    const porSku = new Map(), porNombre = new Map();
    catalogo.forEach(c => { if (c.sku) porSku.set(String(c.sku).toUpperCase(), c); const n = norm(c.nombre); if (n && !c.sku && !porNombre.has(n)) porNombre.set(n, c); });
    const actual = new Map((await db.collection('stock_actual').find({ orgId, depositoId }).toArray()).map(s => [String(s.productoId), s.cantidad || 0]));

    const items = [], faltantes = [], negativos = [];
    for (const p of productos) {
      const objetivo = p.real < 0 ? 0 : p.real;
      if (p.real < 0) negativos.push({ codigo: p.codigo, nombre: p.nombre, real: p.real });
      let prod = p.codigo ? porSku.get(p.codigo.toUpperCase()) : null;
      if (!prod) prod = porNombre.get(norm(p.nombre));
      if (prod) {
        const hoy = actual.get(String(prod._id)) || 0;
        const dif = round3(objetivo - hoy);
        if (Math.abs(dif) >= 0.0005) items.push({ productoId: prod._id, codigo: p.codigo, nombre: prod.nombre, hoy, objetivo, dif });
      } else if (objetivo !== 0) {
        faltantes.push(Object.assign({}, p, { objetivo }));
      }
    }
    // Productos con stock cargado antes en este depósito que ya no figuran con stock en el archivo → quedarían en 0 solo si el archivo los trae; no se tocan.
    const resumen = {
      deposito: deposito.nombre, filasArchivo: productos.length, conStock: productos.filter(p => p.real > 0).length,
      totalUnidades: round3(productos.reduce((s, p) => s + (p.real > 0 ? p.real : 0), 0)),
      aAjustar: items.length, sinCambios: productos.filter(p => p.real !== 0).length - items.length - faltantes.length,
      noExisten: faltantes.length, ejemplosNoExisten: faltantes.slice(0, 15).map(f => `${f.codigo} — ${f.nombre} (${f.objetivo})`),
      crearFaltantes, negativos: negativos.length, ejemplosNegativos: negativos.slice(0, 15).map(n => `${n.codigo} — ${n.nombre} (${n.real})`)
    };
    if (!aplicar) return resumen;

    const ahora = new Date();
    const usuarioNombre = (req.usuario && req.usuario.nombre) || '';
    let creados = 0;
    if (crearFaltantes) {
      for (const f of faltantes) {
        const esM2 = f.unidad === 'm2';
        const doc = {
          sku: f.codigo ? f.codigo.toUpperCase() : '', nombre: f.nombre, unidad: esM2 ? 'm2' : 'unidad', tipoUnidad: esM2 ? 'superficie' : 'unidad',
          disponiblePara: 'todos', moneda: 'ARS', tipoProducto: 'comprado', rubro: f.rubro || '', subrubro: '', marca: f.marca || '', codigoBarra: '', codigoExterno: '',
          proveedor: '', proveedorId: null, embalaje: '', descripcion: '', notas: 'Creado al importar el stock de Dux',
          precio: null, costo: f.costo || null, porcentajeIva: null, impuestoInterno: null, unidadesPorBulto: null, fechaVencimiento: null,
          stockeable: true, aceptaStockNegativo: false, trazable: false, utilizaVariantes: false, indicaCtdBultos: false,
          cantidadMinima: null, stockIdeal: null, activo: true, orgId, createdAt: ahora, updatedAt: ahora
        };
        const r = await db.collection('productos_catalogo').insertOne(doc);
        items.push({ productoId: r.insertedId, codigo: f.codigo, nombre: f.nombre, hoy: 0, objetivo: f.objetivo, dif: f.objetivo });
        creados++;
      }
    }
    let ajustados = 0;
    for (const it of items) {
      const tipo = it.dif > 0 ? 'ingreso' : 'egreso';
      const cantidad = Math.abs(it.dif);
      await db.collection('stock_movimientos').insertOne({
        productoId: it.productoId, depositoId, tipo, cantidad, motivo: `Stock inicial Dux (${it.hoy} → ${it.objetivo})`,
        sucursal: '', codigoExterno: '', observaciones: 'Importado de la Consulta de Stock de Dux', usuarioNombre, fecha: ahora, orgId, createdAt: ahora
      });
      await db.collection('stock_actual').updateOne(
        { productoId: it.productoId, depositoId, orgId },
        { $inc: { cantidad: it.dif }, $set: { actualizadoEn: ahora }, $setOnInsert: { productoId: it.productoId, depositoId, orgId } },
        { upsert: true }
      );
      ajustados++;
    }
    return Object.assign(resumen, { ajustados, productosCreados: creados });
  });
}

router.post('/preview', auth, async (req, res) => { try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/aplicar', auth, async (req, res) => { try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });

module.exports = router;
