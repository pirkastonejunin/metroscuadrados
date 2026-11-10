// Entorno de prueba: MongoDB real en memoria + los routers reales del repo
// (compras, gastos, ventas, tesorería, clientes) con la autenticación
// simulada y la API de Anthropic simulada.
const path = require('path');
const REPO = path.join(__dirname, '..');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');

async function start(port = 4010, opciones = {}) {
  const mongod = (opciones.replSet || process.env.HARNESS_REPLSET === '1') ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } }) : await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  const client = await new MongoClient(process.env.MONGODB_URI).connect();
  const db = client.db('calculadora_m2');

  const ORG = new ObjectId();
  const ids = { org: ORG };

  // ---- auth simulada
  const usuariosPath = require.resolve(path.join(REPO, 'usuarios.js'));
  const fakeRouter = express.Router();
  Object.assign(fakeRouter, {
    authUsuario: (req, res, next) => { req.usuario = global.__testUser || { _id: new ObjectId(), nombre: 'Tester', rol: { protegido: true } }; next(); },
    requiereModulo: () => (req, res, next) => next(),
    requiereAlgunModulo: () => (req, res, next) => next(),
    requiereVendedorPropio: (req, res, next) => next(),
    tieneModulo: () => true,
    MODULOS: [],
    resolverOrg: (req, res, next) => { const h = req.headers['x-org-id']; if (h === 'todas') req.vistaTodas = true; req.orgId = h === 'todas' ? null : (h ? new ObjectId(h) : ORG); { const o = req.headers['x-org-operar']; if (/^[0-9a-f]{24}$/i.test(o || '')) req.orgOperar = new ObjectId(o); if (h === 'todas' && req.method !== 'GET' && req.orgOperar) req.orgId = req.orgOperar; } next(); },
    orgDelRegistro: (colDe) => async (req, res, next) => { try { if (!req.vistaTodas || req.method === 'GET') return next(); const id = req.params && req.params.id; if (!/^[0-9a-f]{24}$/i.test(String(id || ''))) return next(); const col = typeof colDe === 'function' ? colDe(req) : colDe; if (!col) return next(); const d = await db.collection(col).findOne({ _id: new ObjectId(id) }); if (d && d.orgId) { req.orgId = d.orgId; req.orgOperar = d.orgId; } next(); } catch (e) { next(e); } },
    asegurarOrgPorDefecto: async () => ORG,
    backfillOrgId: async () => {},
    cargarClienteParaOperar: async (db, req, id) => { const col = db.collection('clientes'); let c = await col.findOne(Object.assign({ _id: id }, req.orgId ? { $or: [{ orgId: req.orgId }, { orgIdsCompartidas: req.orgId }] } : {})); if (c || !req.orgId) return c; const o = await col.findOne({ _id: id }); if (!o) return null; await col.updateOne({ _id: id }, { $addToSet: { orgIdsCompartidas: req.orgId } }); return o; },
    cargarProveedorParaOperar: async (db, req, id) => { const col = db.collection('proveedores'); let c = await col.findOne(Object.assign({ _id: id }, req.orgId ? { $or: [{ orgId: req.orgId }, { orgIdsCompartidas: req.orgId }] } : {})); if (c || !req.orgId) return c; const o = await col.findOne({ _id: id }); if (!o) return null; await col.updateOne({ _id: id }, { $addToSet: { orgIdsCompartidas: req.orgId } }); return o; },
    filtroOrg: req => (req.orgId ? { orgId: req.orgId } : {}),
    filtroOrgClientes: req => (req.orgId ? { $or: [{ orgId: req.orgId }, { orgIdsCompartidas: req.orgId }] } : {})
  });
  require.cache[usuariosPath] = { id: usuariosPath, filename: usuariosPath, loaded: true, exports: fakeRouter };

  // ---- IA simulada (la respuesta se fija desde el test)
  const fetchReal = global.fetch;
  const estadoIA = { respuesta: null, llamadas: [] };
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.anthropic.com')) {
      estadoIA.llamadas.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'tool_use', name: 'registrar_factura', input: estadoIA.respuesta }] }) };
    }
    if (String(url).includes('generativelanguage.googleapis.com')) {
      estadoIA.llamadas.push({ gemini: true, url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
      if (estadoIA.geminiStatus) return { ok: false, status: estadoIA.geminiStatus, json: async () => ({ error: { message: estadoIA.geminiStatus === 429 ? 'Resource exhausted' : 'API key not valid' } }) };
      return { ok: true, status: 200, json: async () => ({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 }, candidates: [{ content: { parts: [{ text: JSON.stringify(estadoIA.respuesta) }] } }] }) };
    }
    return fetchReal(url, opts);
  };
  process.env.ANTHROPIC_API_KEY = 'test-key';

  // ---- datos base
  const o = { orgId: ORG };
  ids.provAcme = (await db.collection('proveedores').insertOne({ razonSocial: 'Acme SA', cuit: '30-71234567-1', activo: true, condicionPago: '30 días', ...o })).insertedId;
  ids.provSur = (await db.collection('proveedores').insertOne({ razonSocial: 'Cementos del Sur', cuit: '', activo: true, ...o })).insertedId;
  ids.cem50 = (await db.collection('productos_catalogo').insertOne({ sku: 'CEM50', nombre: 'Cemento Portland 50 kg', costo: 100, moneda: 'ARS', unidad: 'unidad', activo: true, ...o })).insertedId;
  ids.cem25 = (await db.collection('productos_catalogo').insertOne({ sku: 'CEM25', nombre: 'Cemento Portland 25 kg', costo: 60, moneda: 'ARS', unidad: 'unidad', activo: true, ...o })).insertedId;
  ids.lad12 = (await db.collection('productos_catalogo').insertOne({ sku: 'LAD12', nombre: 'Ladrillo hueco 12', costo: 5, moneda: 'ARS', unidad: 'unidad', activo: true, ...o })).insertedId;
  ids.deposito = (await db.collection('depositos').insertOne({ nombre: 'Depósito Central', activo: true, ...o })).insertedId;
  ids.concepto = (await db.collection('gastos_conceptos').insertOne({ nombre: 'Energía eléctrica', activo: true, ...o })).insertedId;
  ids.caja = (await db.collection('tesoreria_cajas').insertOne({ nombre: 'Caja principal', moneda: 'ARS', activa: true, ...o })).insertedId;
  ids.banco = (await db.collection('tesoreria_bancos').insertOne({ nombre: 'Banco Test', moneda: 'ARS', activa: true, ...o })).insertedId;
  ids.cliente = (await db.collection('clientes').insertOne({ apellidoRazonSocial: 'Cliente SA', activo: true, ...o })).insertedId;
  ids.venta = (await db.collection('ventas').insertOne({ numero: 1, tipoComprobante: 'comprobante_x', clienteId: ids.cliente, clienteNombre: 'Cliente SA', moneda: 'ARS', fecha: new Date(), items: [], subtotal: 1210, total: 1210, totalCobrado: 0, saldoPendiente: 1210, estado: 'pendiente', pagos: [], ...o })).insertedId;
  ids.venta2 = (await db.collection('ventas').insertOne({ numero: 2, tipoComprobante: 'comprobante_x', clienteId: ids.cliente, clienteNombre: 'Cliente SA', moneda: 'ARS', fecha: new Date(), items: [], subtotal: 500, total: 500, totalCobrado: 0, saldoPendiente: 500, estado: 'pendiente', pagos: [], ...o })).insertedId;

  // ---- app
  const app = express();
  app.use(express.json({ limit: '30mb', verify: (req, res, buf) => { if (req.url && req.url.startsWith('/api/leads/azuite/webhook') || req.url.startsWith('/api/bot/webhook')) req.rawBody = buf; } }));
  app.use('/api/compras', require(path.join(REPO, 'compras.js')));
  app.use('/api/gastos', require(path.join(REPO, 'gastos.js')));
  try { app.use('/api/espacio-db', require(path.join(REPO, 'espacioDb.js'))); } catch (e) { console.log('espacio no montado', e.message); }
  try { app.use('/api/reinicio-datos', require(path.join(REPO, 'reinicioDatos.js'))); } catch (e) { console.log('reinicio no montado', e.message); }
  try { app.use('/api/ventas-import-dux', require(path.join(REPO, 'ventasImportDux.js'))); } catch (e) { console.log('dux no montado', e.message); }
  try { app.use('/api/presupuestos-import-dux', require(path.join(REPO, 'presupuestosImportDux.js'))); } catch (e) { console.log('pres dux no montado', e.message); }
  try { app.use('/api/unificar-vendedores', require(path.join(REPO, 'unificarVendedores.js'))); } catch (e) { console.log('unifV no montado', e.message); }
  try { app.use('/api/cheques-import-dux', require(path.join(REPO, 'chequesImportDux.js'))); } catch (e) { console.log('cheques no montado', e.message); }
  try { app.use('/api/cobros-import-dux', require(path.join(REPO, 'cobrosImportDux.js'))); } catch (e) { console.log('cobros dux no montado', e.message); }
  try { app.use('/api/saldos-import-dux', require(path.join(REPO, 'saldosImportDux.js'))); } catch (e) { console.log('saldos dux no montado', e.message); }
  try { app.use('/api/estado-migracion', require(path.join(REPO, 'estadoMigracion.js'))); } catch (e) { console.log('estado no montado', e.message); }
  try { app.use('/api/unificar-proveedores', require(path.join(REPO, 'unificarProveedores.js'))); } catch (e) { console.log('unifP no montado', e.message); }
  try { app.use('/api/fichas-import-dux', require(path.join(REPO, 'fichasImportDux.js'))); } catch (e) { console.log('fichas no montado', e.message); }
  try { app.use('/api/unificar-clientes', require(path.join(REPO, 'unificarClientes.js'))); } catch (e) { console.log('unif no montado', e.message); }
  try { app.use('/api/fichas-import-dux', require(path.join(REPO, 'fichasClientesDux.js'))); } catch (e) { console.log('fichas cli no montado', e.message); }
  try { app.use('/api/mover-visitas', require(path.join(REPO, 'moverVisitas.js'))); } catch (e) { console.log('mover no montado', e.message); }
  try { app.use('/api/compras-import-dux', require(path.join(REPO, 'comprasImportDux.js'))); } catch (e) { console.log('compras dux no montado', e.message); }
  { const vr = require(path.join(REPO, 'ventas.js')); app.use('/api/ventas', vr); app.get('/d/:token', vr.servirLinkPublico); }
  app.use('/api/tesoreria', require(path.join(REPO, 'tesoreria.js')));
  app.use('/api/financiera', require(path.join(REPO, 'financiera.js')));
  app.use('/api/correo', require(path.join(REPO, 'correo.js')));
  app.use('/api/clientes', require(path.join(REPO, 'clientes.js')));
  try { app.use('/api/presupuestos', require(path.join(REPO, 'presupuestos.js'))); } catch (e) { console.log('presupuestos no montado', e.message); }
  try { app.use('/api/notificaciones', require(path.join(REPO, 'notificaciones.js'))); } catch (e) { console.log('notif no montado', e.message); }
  try { app.use('/api/mercadopago', require(path.join(REPO, 'mercadopago.js'))); } catch (e) { console.log('mp no montado', e.message); }
  try { app.use('/api/tienda-import', require(path.join(REPO, 'tiendanubeImport.js'))); } catch (e) { console.log('tn-import no montado', e.message); }
  try { const t = require(path.join(REPO, 'tiendaOnline.js')); app.use('/api/tienda', t.publico); app.use('/api/tienda-admin', t.admin); } catch (e) { console.log('tienda no montada', e.message); }
  try { app.use('/api/stock', require(path.join(REPO, 'stock.js'))); } catch (e) { console.log('stock no montado', e.message); }
  try { app.use('/api/proveedores', require(path.join(REPO, 'proveedores.js'))); } catch (e) { console.log('prov no montado', e.message); }
  try { app.use('/api/proveedores-import', require(path.join(REPO, 'proveedoresImport.js'))); } catch (e) { console.log('prov-import no montado', e.message); }
  try { app.use('/api/visitas-real', require(path.join(REPO, 'visitas.js'))); } catch (e) { console.log('visitas real no montado', e.message); }
  try { app.use('/api/obras', require(path.join(REPO, 'obras.js'))); } catch (e) { console.log('obras no montado', e.message); }
  app.get('/api/usuarios/lite', (req, res) => res.json([{ nombre: 'Ana' }, { nombre: 'Beto' }]));
  try { app.use('/api/stock-import-dux', require(path.join(REPO, 'stockImportDux.js'))); } catch (e) { console.log('stock dux no montado', e.message); }
  app.use('/api/fiscal', require(path.join(REPO, 'fiscal.js')));
  app.use('/api/productos', require(path.join(REPO, 'productos.js')));
  app.use('/api/tablero', require(path.join(REPO, 'tablero.js')));
  app.use('/api/facturacion', require(path.join(REPO, 'facturacion.js')));
  app.use('/api/informes', require(path.join(REPO, 'informes.js')));
  app.use('/api/costos', require(path.join(REPO, 'costos.js')));
  app.use('/api/leads', require(path.join(REPO, 'leads.js')));
  app.use('/api/bot', require(path.join(REPO, 'bot.js')));
  app.use('/api/mesa', require(path.join(REPO, 'mesa.js')));
  app.use('/api/crm', require(path.join(REPO, 'crm.js')));
  app.use('/api/sueldos', require(path.join(REPO, 'sueldos.js')));
  app.use('/api/asistente', require(path.join(REPO, 'asistente.js')));
  app.get('/api/visitas/', async (req, res) => { const m = {}; if (req.query.vendedorId) m.vendedorId = new ObjectId(req.query.vendedorId); res.json(await db.collection('visitas').find(m).toArray()); });
  app.get('/api/usuarios/me', (req, res) => res.json({
    usuario: { nombre: (global.__testUser || {}).nombre || 'Tester', vendedorId: (global.__testUser || {}).vendedorId || null }, rol: (global.__testUser || {}).rol || { protegido: true, modulos: [] },
    organizaciones: [{ _id: String(ORG), nombre: 'Piedra Negra' }].concat((global.__orgsExtra || []).map(o => ({ _id: String(o._id), nombre: o.nombre }))), puedeVerTodas: false
  }));
  // PiedraSidebar real depende de muchas cosas: se reemplaza por un stub en las pruebas de UI.
  app.get('/nav-sidebar.js', (req, res) => { res.type('js').send('window.PiedraSidebar={render(){}};'); });
  app.use(express.static(path.join(REPO, 'public')));

  const server = await new Promise(r => { const s = app.listen(port, () => r(s)); });
  return {
    base: `http://localhost:${port}`, db, ids, ORG, estadoIA,
    api: async (method, url, body, orgOverride) => {
      const r = await fetchReal(`http://localhost:${port}${url}`, { method, headers: { 'Content-Type': 'application/json', 'x-org-id': String(orgOverride || ORG) }, body: body ? JSON.stringify(body) : undefined });
      const ct = r.headers.get('content-type') || '';
      const data = ct.includes('json') ? await r.json() : await r.text();
      return { status: r.status, data };
    },
    stop: async () => { server.close(); await client.close(); await mongod.stop(); }
  };
}
module.exports = { start };
