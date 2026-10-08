// ---------------------------------------------------------------------------
// Tienda online pública (8/10/2026, pedido de Mato: "armar un catálogo o
// tienda online para el público... vinculada con nuestro sistema para
// actualizar stock y precio... poder realizar pedidos y pagos").
//
// Decisiones (confirmadas con Mato):
//   - Vive dentro de este mismo servidor (páginas /tienda y /api/tienda), con
//     la misma base de datos: el stock y el precio SIEMPRE son los del sistema.
//   - Solo retiro en sucursal (sin envíos por ahora).
//   - Un pedido queda "pendiente de pago"; recién cuando Mercado Pago confirma
//     el pago se crea la VENTA (con stock comprometido en el depósito de la
//     tienda) y se registra el cobro (con comisión e impuestos).
//   - Primera etapa: catálogo + carrito + pago con Mercado Pago. El cotizador
//     público viene en una segunda etapa.
//
// Qué se publica: cada producto con `publicado: true` en productos_tienda
// (junto a sus fotos y descripción, ver tiendanubeImport.js), activo y con
// precio de venta (el de la lista Consumidor Final, campo `precio`).
//
// Colecciones nuevas:
//   tienda_config  : { orgId, activa, nombre, depositoId, direccionRetiro, mensajeRetiro, whatsapp }
//   tienda_pedidos : { orgId, numero, token, cliente, items[], total, estado:
//                      pendiente_pago|procesando|pagado|revisar|error|vencido,
//                      referencia 'tw-<id>', preferenciaId, linkPago, ventaId, ventaNumero,
//                      cobroRegistrado, paymentId, ... }
//
// Rutas públicas (/api/tienda): config, rubros, catalogo, producto/:id,
// pedidos (POST), pedidos/:id?t=token. Rutas internas (/api/tienda-admin):
// config, resumen, publicar, pedidos.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');

const DB_NAME = 'calculadora_m2';
const publico = express.Router();
const admin = express.Router();
const auth = [authUsuario, resolverOrg, requiereModulo('productos')];

let client, conectando;
async function getDb() {
  if (!client) {
    if (!conectando) conectando = new MongoClient(process.env.MONGODB_URI).connect().then(c => { client = c; return c; }).catch(e => { conectando = null; throw e; });
    await conectando;
  }
  return client.db(DB_NAME);
}
const err = (status, message) => Object.assign(new Error(message), { status });
const oid = id => { try { return new ObjectId(String(id)); } catch (e) { return null; } };
const redondear = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const txt = v => String(v == null ? '' : v).trim();
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mpMod = () => require('./mercadopago');
const ventasMod = () => require('./ventas');

// ---- configuración y organización de la tienda
async function cargarCfgTienda(db, orgId) { return db.collection('tienda_config').findOne({ orgId }); }
async function orgPublica(db) {
  if (process.env.TIENDA_ORG_ID && oid(process.env.TIENDA_ORG_ID)) {
    const c = await db.collection('tienda_config').findOne({ orgId: oid(process.env.TIENDA_ORG_ID), activa: true });
    return c;
  }
  return db.collection('tienda_config').findOne({ activa: true }, { sort: { updatedAt: 1 } });
}
async function tiendaActiva(db) {
  const cfg = await orgPublica(db);
  if (!cfg) throw err(404, 'La tienda no está disponible por ahora.');
  return cfg;
}

// ---- catálogo publicado (en memoria 60 s por organización)
const cache = new Map();
function invalidar(orgId) { cache.delete(String(orgId)); }
async function publicados(db, orgId) {
  const k = String(orgId);
  const c = cache.get(k);
  if (c && Date.now() - c.t < 60000) return c.filas;
  const tiendas = await db.collection('productos_tienda').find({ orgId, publicado: true }).project({ productoId: 1, imagenes: 1 }).toArray();
  const porId = new Map(tiendas.map(t => [String(t.productoId), t]));
  const prods = await db.collection('productos_catalogo').find({ orgId, activo: { $ne: false }, _id: { $in: tiendas.map(t => t.productoId) }, precio: { $gt: 0 } })
    .project({ sku: 1, nombre: 1, marca: 1, rubro: 1, subrubro: 1, precio: 1, unidad: 1, unidadesPorBulto: 1, embalaje: 1 }).toArray();
  const filas = prods.map(p => {
    const t = porId.get(String(p._id));
    return {
      id: String(p._id), sku: p.sku || '', nombre: p.nombre, marca: p.marca || '', rubro: p.rubro || '', subrubro: p.subrubro || '',
      precio: p.precio, unidad: p.unidad || 'unidad', upb: p.unidadesPorBulto > 0 ? p.unidadesPorBulto : 0, embalaje: p.embalaje || '',
      imagenes: ((t && t.imagenes) || []).map(i => String(i.imagenId)),
      _q: norm([p.nombre, p.sku, p.marca, p.rubro, p.subrubro].join(' '))
    };
  });
  cache.set(k, { t: Date.now(), filas });
  return filas;
}
// Depósitos de los que sale el stock de la tienda (se suman). Compatible con la config vieja (depositoId).
function depositosDe(cfg) {
  if (!cfg) return [];
  if (Array.isArray(cfg.depositosIds) && cfg.depositosIds.length) return cfg.depositosIds;
  return cfg.depositoId ? [cfg.depositoId] : [];
}
async function disponibles(db, orgId, depositos, ids) {
  const out = new Map();
  const deps = (Array.isArray(depositos) ? depositos : [depositos]).filter(Boolean);
  if (!deps.length || !ids.length) return out;
  const rows = await db.collection('stock_actual').find({ orgId, depositoId: { $in: deps }, productoId: { $in: ids.map(oid).filter(Boolean) } }).toArray();
  const acum = new Map();
  for (const r of rows) acum.set(String(r.productoId), (acum.get(String(r.productoId)) || 0) + Math.max(0, (r.cantidad || 0) - (r.cantidadComprometida || 0)));
  for (const [k, v] of acum) out.set(k, Math.max(0, redondear(v)));
  return out;
}
// Depósito donde se compromete la venta: el primero que cubre todo el pedido; si ninguno, el que más cubre.
async function depositoParaPedido(db, orgId, depositos, items) {
  if (!depositos.length) return null;
  if (depositos.length === 1) return depositos[0];
  let mejor = depositos[0], mejorPuntaje = -1;
  for (const d of depositos) {
    const m = await disponibles(db, orgId, [d], items.map(i => String(i.productoId)));
    let cubre = true, puntaje = 0;
    for (const i of items) { const dsp = m.get(String(i.productoId)) || 0; if (dsp < i.cantidad) cubre = false; puntaje += Math.min(dsp, i.cantidad); }
    if (cubre) return d;
    if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = d; }
  }
  return mejor;
}
function vista(f, disp) {
  return { id: f.id, sku: f.sku, nombre: f.nombre, marca: f.marca, rubro: f.rubro, subrubro: f.subrubro, precio: f.precio, unidad: f.unidad,
    bulto: f.upb ? { unidades: f.upb, nombre: f.embalaje || 'caja', precio: redondear(f.precio * f.upb) } : null,
    imagen: f.imagenes[0] || null, disponible: disp };
}

publico.get('/config', async (req, res) => {
  try {
    const db = await getDb();
    const c = await orgPublica(db);
    if (!c) return res.json({ activa: false });
    res.json({ activa: true, nombre: c.nombre || 'Tienda', direccionRetiro: c.direccionRetiro || '', mensajeRetiro: c.mensajeRetiro || '', whatsapp: c.whatsapp || '' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

publico.get('/rubros', async (req, res) => {
  try {
    const db = await getDb(); const cfg = await tiendaActiva(db);
    const filas = await publicados(db, cfg.orgId);
    const m = new Map();
    for (const f of filas) {
      const r = f.rubro || 'Otros';
      if (!m.has(r)) m.set(r, { nombre: r, cantidad: 0, sub: new Map() });
      const x = m.get(r); x.cantidad++;
      if (f.subrubro) x.sub.set(f.subrubro, (x.sub.get(f.subrubro) || 0) + 1);
    }
    res.json([...m.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map(x => ({ nombre: x.nombre, cantidad: x.cantidad, subrubros: [...x.sub].map(([nombre, cantidad]) => ({ nombre, cantidad })).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')) })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

publico.get('/catalogo', async (req, res) => {
  try {
    const db = await getDb(); const cfg = await tiendaActiva(db);
    let filas = await publicados(db, cfg.orgId);
    const q = norm(req.query.q).trim();
    if (q) { const ts = q.split(/\s+/); filas = filas.filter(f => ts.every(t => f._q.includes(t))); }
    if (req.query.rubro) filas = filas.filter(f => (f.rubro || 'Otros') === req.query.rubro);
    if (req.query.subrubro) filas = filas.filter(f => f.subrubro === req.query.subrubro);
    if (req.query.marca) filas = filas.filter(f => f.marca === req.query.marca);
    const orden = String(req.query.orden || 'nombre');
    filas = filas.slice().sort(orden === 'precio_asc' ? (a, b) => a.precio - b.precio : orden === 'precio_desc' ? (a, b) => b.precio - a.precio : (a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    const total = filas.length;
    const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const porPagina = Math.min(60, Math.max(1, parseInt(req.query.porPagina, 10) || 24));
    const pag = filas.slice((pagina - 1) * porPagina, pagina * porPagina);
    const disp = await disponibles(db, cfg.orgId, depositosDe(cfg), pag.map(f => f.id));
    res.json({ total, pagina, porPagina, productos: pag.map(f => vista(f, disp.get(f.id) || 0)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

publico.get('/producto/:id', async (req, res) => {
  try {
    const db = await getDb(); const cfg = await tiendaActiva(db);
    const filas = await publicados(db, cfg.orgId);
    const f = filas.find(x => x.id === req.params.id);
    if (!f) throw err(404, 'Producto no disponible.');
    const t = await db.collection('productos_tienda').findOne({ orgId: cfg.orgId, productoId: oid(f.id) });
    const disp = await disponibles(db, cfg.orgId, depositosDe(cfg), [f.id]);
    res.json(Object.assign(vista(f, disp.get(f.id) || 0), {
      imagenes: f.imagenes, descripcionHtml: (t && t.descripcionHtml) || '',
      seoTitulo: (t && t.tienda && t.tienda.seoTitulo) || '', seoDescripcion: (t && t.tienda && t.tienda.seoDescripcion) || ''
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- pedidos
const intentos = new Map(); // ip -> [timestamps]; freno simple contra abuso del alta de pedidos
function limitar(ip) {
  const ahora = Date.now();
  const l = (intentos.get(ip) || []).filter(t => ahora - t < 3600 * 1000);
  if (l.length >= 20) return false;
  l.push(ahora); intentos.set(ip, l);
  return true;
}
async function proximoNumeroPedido(db, orgId) {
  const r = await db.collection('tienda_contadores').findOneAndUpdate({ orgId }, { $inc: { ultimo: 1 } }, { upsert: true, returnDocument: 'after' });
  const d = r && r.value !== undefined ? r.value : r;
  return d.ultimo;
}
function cantidadEfectiva(f, cantidad) {
  // bultos enteros: la cantidad llega en unidades base y se redondea hacia arriba al bulto
  if (f.upb > 0) return redondear(Math.ceil(cantidad / f.upb - 1e-9) * f.upb);
  return redondear(cantidad);
}

publico.post('/pedidos', async (req, res) => {
  try {
    if (!limitar(req.ip || 'x')) throw err(429, 'Hiciste muchos pedidos seguidos. Probá de nuevo en un rato.');
    const db = await getDb(); const cfg = await tiendaActiva(db);
    const b = req.body || {};
    const c = b.cliente || {};
    const nombre = txt(c.nombre).slice(0, 120), email = txt(c.email).slice(0, 120), telefono = txt(c.telefono).slice(0, 40), dni = txt(c.dni).slice(0, 20);
    if (!nombre) throw err(400, 'Escribí tu nombre y apellido.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err(400, 'Escribí un email válido.');
    if (telefono.replace(/\D/g, '').length < 6) throw err(400, 'Escribí un teléfono de contacto.');
    if (!Array.isArray(b.items) || !b.items.length) throw err(400, 'El carrito está vacío.');
    if (b.items.length > 50) throw err(400, 'Máximo 50 productos distintos por pedido.');
    const mpm = mpMod();
    const mpCfg = await mpm.cargarConfig(db, cfg.orgId);
    if (!mpCfg || !mpCfg.accessToken || !mpCfg.bancoId) throw err(503, 'Los pagos online no están disponibles por ahora.');
    if (!depositosDe(cfg).length) throw err(503, 'La tienda todavía no tiene depósito configurado.');
    const filas = await publicados(db, cfg.orgId);
    const porId = new Map(filas.map(f => [f.id, f]));
    const disp = await disponibles(db, cfg.orgId, depositosDe(cfg), b.items.map(i => String(i.productoId)));
    const vistos = new Set(); const items = []; const faltan = [];
    for (const it of b.items) {
      const f = porId.get(String(it.productoId));
      if (!f) throw err(400, 'Uno de los productos ya no está disponible. Actualizá el carrito.');
      if (vistos.has(f.id)) throw err(400, 'Producto repetido en el carrito.');
      vistos.add(f.id);
      const cant = Number(it.cantidad);
      if (!(cant > 0) || cant > 100000) throw err(400, `Cantidad inválida para "${f.nombre}".`);
      const efectiva = cantidadEfectiva(f, cant);
      const hay = disp.get(f.id) || 0;
      if (efectiva > hay + 1e-9) faltan.push({ productoId: f.id, nombre: f.nombre, disponible: hay });
      items.push({ productoId: oid(f.id), sku: f.sku, nombre: f.nombre, cantidad: efectiva, precioUnitario: f.precio, subtotal: redondear(efectiva * f.precio) });
    }
    if (faltan.length) { const e = err(409, 'No hay stock suficiente de: ' + faltan.map(x => `${x.nombre} (quedan ${x.disponible})`).join(', ')); e.faltan = faltan; throw e; }
    const total = redondear(items.reduce((a, i) => a + i.subtotal, 0));
    if (!(total > 0)) throw err(400, 'El pedido no tiene importe.');
    const _id = new ObjectId();
    const referencia = 'tw-' + String(_id);
    const token = crypto.randomBytes(18).toString('hex');
    const numero = await proximoNumeroPedido(db, cfg.orgId);
    const base = mpm.baseUrl(req);
    const volver = `${base}/tienda#/pedido/${_id}/${token}`;
    const pref = await mpm.mpLlamar(mpCfg, 'POST', '/checkout/preferences', {
      items: items.map(i => ({ id: String(i.productoId), title: String(i.nombre).slice(0, 120), quantity: 1, unit_price: i.subtotal, currency_id: 'ARS' })),
      payer: { name: nombre, email },
      external_reference: referencia,
      notification_url: mpm.urlWebhook(req, mpCfg),
      back_urls: { success: volver, pending: volver, failure: volver },
      auto_return: 'approved',
      expires: true, expiration_date_to: new Date(Date.now() + 48 * 3600 * 1000).toISOString()
    });
    const link = pref.init_point;
    if (!link) throw err(502, 'No se pudo generar el link de pago.');
    await db.collection('tienda_pedidos').insertOne({
      _id, orgId: cfg.orgId, numero, token, cliente: { nombre, email, telefono, dni }, items, total, estado: 'pendiente_pago',
      referencia, preferenciaId: pref.id, linkPago: link, ventaId: null, cobroRegistrado: false, createdAt: new Date(), updatedAt: new Date()
    });
    res.json({ pedidoId: String(_id), token, numero, total, linkPago: link });
  } catch (e) { res.status(e.status || 500).json(Object.assign({ error: e.message }, e.faltan ? { faltan: e.faltan } : {})); }
});

function vistaPedido(p, cfgT) {
  return { id: String(p._id), numero: p.numero, estado: p.estado, total: p.total, cliente: { nombre: p.cliente.nombre }, items: p.items.map(i => ({ nombre: i.nombre, cantidad: i.cantidad, precioUnitario: i.precioUnitario, subtotal: i.subtotal })),
    ventaNumero: p.ventaNumero || null, linkPago: p.estado === 'pendiente_pago' ? p.linkPago : null,
    retiro: cfgT ? { direccion: cfgT.direccionRetiro || '', mensaje: cfgT.mensajeRetiro || '', whatsapp: cfgT.whatsapp || '' } : null };
}
publico.get('/pedidos/:id', async (req, res) => {
  try {
    const db = await getDb();
    const id = oid(req.params.id);
    let p = id && await db.collection('tienda_pedidos').findOne({ _id: id });
    const tk = String(req.query.t || '');
    if (!p || !tk || tk.length !== p.token.length || !crypto.timingSafeEqual(Buffer.from(tk), Buffer.from(p.token))) throw err(404, 'Pedido no encontrado.');
    if (p.estado === 'pendiente_pago' || p.estado === 'error') {
      try { p = await conciliarPedido(db, p); } catch (e) { /* si Mercado Pago no responde, se muestra el estado guardado */ }
    }
    res.json(vistaPedido(p, await cargarCfgTienda(db, p.orgId)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- conciliación del pago -> venta + cobro
async function buscarOCrearCliente(db, orgId, c) {
  const { elegirClienteUnico, clientesActivos } = require('./clienteVinculo');
  const email = txt(c.email).toLowerCase();
  const conMail = email ? await db.collection('clientes').find({ orgId, activo: { $ne: false }, email: new RegExp('^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).project({ _id: 1 }).limit(2).toArray() : [];
  if (conMail.length === 1) return conMail[0]._id;
  const unico = conMail.length === 0 ? elegirClienteUnico(await clientesActivos(db, orgId), { nombre: c.nombre, telefono: c.telefono }) : null;
  if (unico) return unico;
  const ahora = new Date();
  const r = await db.collection('clientes').insertOne({
    apellidoRazonSocial: c.nombre, categoriaFiscal: 'consumidor_final', email: c.email, telefono: c.telefono,
    numeroDocumento: c.dni || '', origenCliente: 'Tienda online', activo: true, orgId, createdAt: ahora, updatedAt: ahora
  });
  return r.insertedId;
}

async function conciliarPedido(db, pedido) {
  if (pedido.estado === 'pagado') return pedido;
  const mpm = mpMod();
  const cfg = await mpm.cargarConfig(db, pedido.orgId);
  if (!cfg || !cfg.accessToken) return pedido;
  const r = await mpm.mpLlamar(cfg, 'GET', '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(pedido.referencia));
  const pagos = (r.results || []).map(p => mpm.interpretarPago(p, false));
  const ok = pagos.find(p => p.estado === 'aprobado');
  if (!ok) return db.collection('tienda_pedidos').findOne({ _id: pedido._id });
  const reclamado = await db.collection('tienda_pedidos').findOneAndUpdate(
    { _id: pedido._id, estado: { $in: ['pendiente_pago', 'error'] } }, { $set: { estado: 'procesando', error: '', updatedAt: new Date() } }, { returnDocument: 'after' });
  const p = reclamado && (reclamado.value !== undefined ? reclamado.value : reclamado);
  if (!p) return db.collection('tienda_pedidos').findOne({ _id: pedido._id }); // otro camino ya lo está procesando
  try {
    if (ok.monto + 0.01 < p.total) {
      await db.collection('tienda_pedidos').updateOne({ _id: p._id }, { $set: { estado: 'revisar', error: `El pago aprobado (${ok.monto}) es menor que el total del pedido (${p.total}). Revisalo a mano.`, paymentId: ok.paymentId, updatedAt: new Date() } });
      return db.collection('tienda_pedidos').findOne({ _id: p._id });
    }
    const cfgT = await cargarCfgTienda(db, p.orgId);
    let ventaId = p.ventaId, ventaNumero = p.ventaNumero;
    if (!ventaId) {
      const clienteId = await buscarOCrearCliente(db, p.orgId, p.cliente);
      const venta = await ventasMod().crearVentaInterna({
        orgId: p.orgId, usuario: { nombre: 'Tienda online' },
        body: {
          clienteId: String(clienteId), tipoEntrega: 'pendiente', tipoComprobante: 'comprobante_x', moneda: 'ARS',
          depositoId: (dep => dep ? String(dep) : undefined)(await depositoParaPedido(db, p.orgId, depositosDe(cfgT), p.items)), vendedor: 'Tienda online',
          observaciones: `Pedido web #${p.numero} — RETIRO EN SUCURSAL. ${p.cliente.nombre} · ${p.cliente.telefono} · ${p.cliente.email}`,
          items: p.items.map(i => ({ productoId: String(i.productoId), cantidad: i.cantidad, precioUnitario: i.precioUnitario }))
        }
      });
      ventaId = venta._id; ventaNumero = venta.numero;
      await db.collection('tienda_pedidos').updateOne({ _id: p._id }, { $set: { ventaId, ventaNumero, clienteId, updatedAt: new Date() } });
    }
    if (!p.cobroRegistrado) {
      const info = await mpm.completarDescuentos(cfg, Object.assign({}, ok));
      const cobro = { _id: new ObjectId(), orgId: p.orgId, ventaId, tipo: 'link', origen: 'tienda', pedidoId: p._id, externalReference: p.referencia, monto: p.total,
        estado: 'acreditado', paymentId: info.paymentId, montoAcreditado: info.monto, comision: info.comision || 0, impuestos: info.impuestos || 0, neto: info.neto != null ? info.neto : null,
        createdAt: new Date(), updatedAt: new Date(), acreditadoEn: new Date() };
      await mpm.registrarCobroEnVenta(db, cfg, cobro, info);
      await db.collection('mp_cobros').insertOne(cobro);
      await db.collection('tienda_pedidos').updateOne({ _id: p._id }, { $set: { cobroRegistrado: true, paymentId: info.paymentId, updatedAt: new Date() } });
    }
    await db.collection('tienda_pedidos').updateOne({ _id: p._id }, { $set: { estado: 'pagado', pagadoEn: new Date(), updatedAt: new Date() } });
  } catch (e) {
    await db.collection('tienda_pedidos').updateOne({ _id: p._id }, { $set: { estado: 'error', error: e.message, updatedAt: new Date() } });
  }
  return db.collection('tienda_pedidos').findOne({ _id: p._id });
}
async function conciliarPedidoPorReferencia(db, ref) {
  const id = oid(String(ref).replace(/^tw-/, ''));
  const p = id && await db.collection('tienda_pedidos').findOne({ _id: id });
  if (p) await conciliarPedido(db, p);
}

// ---- administración
admin.get('/config', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const c = (await cargarCfgTienda(db, req.orgId)) || {};
    const depositos = await db.collection('depositos').find(Object.assign({ activo: { $ne: false } }, filtroOrg(req))).project({ nombre: 1 }).sort({ nombre: 1 }).toArray();
    const mp = await mpMod().cargarConfig(db, req.orgId);
    res.json({ activa: !!c.activa, nombre: c.nombre || '', depositoId: c.depositoId ? String(c.depositoId) : '', depositosIds: depositosDe(c).map(String), direccionRetiro: c.direccionRetiro || '', mensajeRetiro: c.mensajeRetiro || '', whatsapp: c.whatsapp || '',
      depositos, mercadoPagoListo: !!(mp && mp.accessToken && mp.bancoId), url: mpMod().baseUrl(req) + '/tienda' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
admin.put('/config', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const b = req.body || {};
    const db = await getDb();
    const set = { updatedAt: new Date() };
    if (b.nombre !== undefined) set.nombre = txt(b.nombre).slice(0, 80);
    if (b.direccionRetiro !== undefined) set.direccionRetiro = txt(b.direccionRetiro).slice(0, 300);
    if (b.mensajeRetiro !== undefined) set.mensajeRetiro = txt(b.mensajeRetiro).slice(0, 600);
    if (b.whatsapp !== undefined) set.whatsapp = txt(b.whatsapp).replace(/[^\d+]/g, '').slice(0, 20);
    if (b.depositosIds !== undefined || b.depositoId !== undefined) {
      const crudos = Array.isArray(b.depositosIds) ? b.depositosIds : (b.depositoId ? [b.depositoId] : []);
      const ids = [];
      for (const x of crudos) {
        const id = oid(x);
        if (!id) continue;
        if (!(await db.collection('depositos').findOne(Object.assign({ _id: id }, filtroOrg(req))))) throw err(400, 'Ese depósito no existe.');
        if (!ids.some(y => String(y) === String(id))) ids.push(id);
      }
      set.depositosIds = ids;
      set.depositoId = ids[0] || null;
    }
    if (b.activa !== undefined) {
      if (b.activa) {
        const actual = Object.assign({}, await cargarCfgTienda(db, req.orgId), set);
        if (!depositosDe(actual).length) throw err(400, 'Elegí de qué depósitos sale el stock antes de activar la tienda.');
        const mp = await mpMod().cargarConfig(db, req.orgId);
        if (!(mp && mp.accessToken && mp.bancoId)) throw err(400, 'Primero configurá Mercado Pago (token y banco) para poder cobrar.');
      }
      set.activa = !!b.activa;
    }
    await db.collection('tienda_config').updateOne({ orgId: req.orgId }, { $set: set, $setOnInsert: { orgId: req.orgId, createdAt: new Date() } }, { upsert: true });
    invalidar(req.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

admin.get('/resumen', auth, async (req, res) => {
  try {
    const db = await getDb();
    const publicadosN = await db.collection('productos_tienda').countDocuments({ orgId: req.orgId, publicado: true });
    const conFotos = await db.collection('productos_tienda').countDocuments({ orgId: req.orgId, 'imagenes.0': { $exists: true } });
    const visibles = (await publicados(db, req.orgId)).length;
    const pedidos = await db.collection('tienda_pedidos').aggregate([{ $match: { orgId: req.orgId } }, { $group: { _id: '$estado', n: { $sum: 1 }, monto: { $sum: '$total' } } }]).toArray();
    res.json({ publicados: publicadosN, visibles, conFotos, pedidos: Object.fromEntries(pedidos.map(x => [x._id, { cantidad: x.n, monto: x.monto }])) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Publica/despublica en bloque. criterio 'con_fotos': todos los activos con fotos y precio. 'todos_con_fotos' = igual; 'ninguno' despublica todo.
admin.post('/publicar-masivo', auth, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando.');
    const db = await getDb();
    const accion = (req.body || {}).accion;
    if (accion === 'despublicar_todo') {
      const r = await db.collection('productos_tienda').updateMany({ orgId: req.orgId, publicado: true }, { $set: { publicado: false, updatedAt: new Date() } });
      invalidar(req.orgId); return res.json({ ok: true, cambiados: r.modifiedCount });
    }
    if (accion !== 'publicar_con_fotos') throw err(400, 'Acción inválida.');
    const conFotos = await db.collection('productos_tienda').find({ orgId: req.orgId, 'imagenes.0': { $exists: true }, publicado: { $ne: true } }).project({ productoId: 1 }).toArray();
    const ids = conFotos.map(x => x.productoId);
    const aptos = ids.length ? await db.collection('productos_catalogo').find({ orgId: req.orgId, activo: { $ne: false }, precio: { $gt: 0 }, _id: { $in: ids } }).project({ _id: 1 }).toArray() : [];
    if (aptos.length) await db.collection('productos_tienda').updateMany({ orgId: req.orgId, productoId: { $in: aptos.map(a => a._id) } }, { $set: { publicado: true, updatedAt: new Date() } });
    invalidar(req.orgId);
    res.json({ ok: true, cambiados: aptos.length, sinPrecioOInactivos: ids.length - aptos.length });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
admin.put('/producto/:id/publicar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const id = oid(req.params.id);
    const p = id && await db.collection('productos_catalogo').findOne(Object.assign({ _id: id }, filtroOrg(req)), { projection: { _id: 1, orgId: 1 } });
    if (!p) throw err(404, 'Producto no encontrado');
    await db.collection('productos_tienda').updateOne({ orgId: p.orgId, productoId: p._id },
      { $set: { publicado: !!(req.body || {}).publicado, updatedAt: new Date() }, $setOnInsert: { orgId: p.orgId, productoId: p._id, imagenes: [], descripcionHtml: '' } }, { upsert: true });
    invalidar(p.orgId);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

admin.get('/pedidos', auth, async (req, res) => {
  try {
    const db = await getDb();
    const q = Object.assign({}, filtroOrg(req));
    if (req.query.estado) q.estado = String(req.query.estado);
    const lista = await db.collection('tienda_pedidos').find(q).sort({ createdAt: -1 }).limit(200).toArray();
    const limite = Date.now() - 48 * 3600 * 1000;
    res.json(lista.map(p => ({ id: String(p._id), numero: p.numero, fecha: p.createdAt, cliente: p.cliente, total: p.total, items: p.items.length,
      estado: (p.estado === 'pendiente_pago' && new Date(p.createdAt).getTime() < limite) ? 'vencido' : p.estado, ventaId: p.ventaId ? String(p.ventaId) : null, ventaNumero: p.ventaNumero || null, error: p.error || '' })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
admin.post('/pedidos/:id/verificar', auth, async (req, res) => {
  try {
    const db = await getDb();
    const id = oid(req.params.id);
    const p = id && await db.collection('tienda_pedidos').findOne(Object.assign({ _id: id }, filtroOrg(req)));
    if (!p) throw err(404, 'Pedido no encontrado');
    const r = await conciliarPedido(db, p);
    res.json({ estado: r.estado, error: r.error || '', ventaNumero: r.ventaNumero || null });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = { publico, admin, conciliarPedidoPorReferencia, conciliarPedido };
