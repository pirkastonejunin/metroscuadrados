// ---------------------------------------------------------------------------
// Importar la FICHA de clientes de Dux (Dux: "Listado de Clientes"): nombre, categoría fiscal, CUIT/DNI, domicilio, teléfono,
// mail, vendedor, etc. Cada cliente se busca por nombre en todas las sucursales accesibles:
//   - si ya existe (por ventas/cobros/saldos importados), se le COMPLETAN los datos que tenga vacíos (nunca pisa lo ya cargado);
//   - si no existe, se crea en la sucursal elegida.
// Repetible sin duplicar. Rutas: POST /api/fichas-import-dux/clientes/preview y /aplicar   body: { archivoBase64, orgId }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');
const { crearResolverClientes } = require('./ventasImportDux');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authCli = [authUsuario, resolverOrg, requiereModulo('clientes')];
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
async function orgsAccesibles(db, req) {
  if (req.usuario && req.usuario.rol && req.usuario.rol.protegido) return db.collection('organizaciones').find({}).project({ nombre: 1 }).toArray();
  const ids = ((req.usuario && req.usuario.orgIds) || [req.orgId]).map(x => { try { return new ObjectId(String(x)); } catch (e) { return null; } }).filter(Boolean);
  return db.collection('organizaciones').find({ _id: { $in: ids } }).project({ nombre: 1 }).toArray();
}
const CAT = { 'RESPONSABLE INSCRIPTO': 'responsable_inscripto', 'MONOTRIBUTISTA': 'monotributista', 'EXENTO': 'exento', 'CONSUMIDOR FINAL': 'consumidor_final', 'EXTERIOR': 'exterior', 'IVA NO ALCANZADO': 'iva_no_alcanzado' };
const DOC = { CUIT: 'cuit', CUIL: 'cuil', DNI: 'dni', PASAPORTE: 'pasaporte' };
const TCMP = { FACTURA: 'factura', COMPROBANTE_VENTA: 'comprobante_venta' };

function leer(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb; try { wb = XLSX.read(buf, { type: 'buffer', cellDates: false }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'cliente') && f.some(c => norm(c) === 'categoria_fiscal'));
  if (h < 0) throw err(400, 'No encontré las columnas cliente y categoria_fiscal. Tiene que ser "Listado de Clientes" de Dux.');
  const enc = filas[h].map(norm); const c = (n) => enc.indexOf(n);
  const idx = {}; ['id', 'cliente', 'nombre_fantasia', 'categoria_fiscal', 'tipo_documento', 'numero_documento', 'cuit_cuilt', 'codigo', 'email', 'vendedor', 'provincia', 'localidad', 'barrio', 'domicilio', 'telefono', 'cel', 'zona',
    'condicion_pago', 'fecha_creacion', 'tipo_cliente', 'persona_contacto', 'no_editable', 'lugar_entrega_dflt', 'tipo_comp_dflt', 'lista_precio_dflt', 'habilitado'].forEach(k => { idx[k] = c(k); });
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const lista = [], errores = []; const vistos = new Set();
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i]; if (!f || f.every(x => x == null || x === '')) continue;
    const nombre = txt(f, 'cliente'); if (!nombre) { errores.push({ fila: i + 1, motivo: 'Falta el nombre del cliente' }); continue; }
    if (vistos.has(norm(nombre))) { errores.push({ fila: i + 1, motivo: 'Nombre repetido (' + nombre + ')' }); continue; } vistos.add(norm(nombre));
    const cuit = txt(f, 'cuit_cuilt').replace(/\D/g, '');
    let ndoc = f[idx.numero_documento]; ndoc = (typeof ndoc === 'number') ? (ndoc > 0 ? String(Math.round(ndoc)) : '') : txt(f, 'numero_documento').replace(/^-.*/, '');
    const dom = txt(f, 'domicilio');
    const serial = idx.fecha_creacion >= 0 ? Number(f[idx.fecha_creacion]) : NaN;
    const d = { nombreFantasia: txt(f, 'nombre_fantasia'), categoriaFiscal: CAT[txt(f, 'categoria_fiscal').toUpperCase()] || null, tipoDocumento: DOC[txt(f, 'tipo_documento').toUpperCase()] || null,
      numeroDocumento: ndoc, cuit: cuit.length === 11 ? cuit : '', codigo: txt(f, 'codigo'), email: txt(f, 'email'), vendedor: txt(f, 'vendedor'), provincia: txt(f, 'provincia'), localidad: txt(f, 'localidad'),
      barrio: txt(f, 'barrio'), domicilio: dom, telefono: txt(f, 'telefono'), celular: txt(f, 'cel'), zona: txt(f, 'zona'), condicionPago: txt(f, 'condicion_pago'), tipoCliente: txt(f, 'tipo_cliente'),
      personaContacto: txt(f, 'persona_contacto'), lugarEntregaPorDefecto: txt(f, 'lugar_entrega_dflt'), tipoComprobantePorDefecto: TCMP[txt(f, 'tipo_comp_dflt').toUpperCase()] || null,
      listaPrecioPorDefecto: txt(f, 'lista_precio_dflt'), codigoDux: idx.id >= 0 && f[idx.id] != null ? String(Math.round(Number(f[idx.id]))) : '' };
    lista.push({ fila: i + 1, nombre, datos: d, habilitado: !/^n/i.test(txt(f, 'habilitado')), creado: isFinite(serial) && serial > 20000 ? new Date(Math.round((serial - 25569) * 86400e3)) : null });
  }
  return { lista, errores };
}
const vacio = (v) => v == null || v === '' || (typeof v === 'number' && !isFinite(v));
const CAMPOS = ['nombreFantasia', 'categoriaFiscal', 'tipoDocumento', 'numeroDocumento', 'cuit', 'email', 'vendedor', 'provincia', 'localidad', 'barrio', 'domicilio', 'telefono', 'celular', 'zona', 'condicionPago',
  'tipoCliente', 'personaContacto', 'lugarEntregaPorDefecto', 'tipoComprobantePorDefecto', 'listaPrecioPorDefecto', 'codigoDux'];

async function procesar(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new ObjectId(String(v)); }
  if (!req.orgId) throw err(400, 'Elegí en qué sucursal se crean los clientes que no existan.');
  const { lista, errores } = leer(req.body && req.body.archivoBase64);
  if (!lista.length) throw err(400, 'El archivo no tiene clientes.');
  return conReintento(async () => {
    const db = await getDb(); const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(req.orgId))) orgIds.push(req.orgId);
    const resolver = crearResolverClientes(db, ahora);
    const existentes = [], nuevos = [], ambiguos = [];
    for (const p of lista) {
      const hallados = []; let amb = false;
      for (const o of orgIds) { const r = await resolver.clasificar(o, p.nombre); if (r && r !== 'NUEVO') hallados.push({ orgId: o, id: new ObjectId(r) }); else if (r === null) amb = true; }
      if (hallados.length) existentes.push({ p, hallados }); else if (amb) ambiguos.push(p); else nuevos.push(p);
    }
    // CUIT ya usados por otros clientes activos (el sistema no admite dos clientes con el mismo CUIT en una sucursal)
    const usados = new Map(); // orgId|cuit -> clienteId
    (await db.collection('clientes').find({ orgId: { $in: orgIds }, activo: { $ne: false }, cuit: { $nin: [null, ''] } }).project({ cuit: 1, orgId: 1 }).toArray()).forEach(c => usados.set(String(c.orgId) + '|' + c.cuit, String(c._id)));
    let cuitRepetidos = 0;
    const ids = existentes.flatMap(e => e.hallados.map(h => h.id));
    const docs = new Map((ids.length ? await db.collection('clientes').find({ _id: { $in: ids } }).toArray() : []).map(d => [String(d._id), d]));
    const cambios = [];
    existentes.forEach(e => e.hallados.forEach(h => { const d = docs.get(String(h.id)); if (!d) return; const set = {};
      CAMPOS.forEach(k => { if (vacio(d[k]) && !vacio(e.p.datos[k])) set[k] = e.p.datos[k]; });
      if (set.cuit) { const clave = String(h.orgId) + '|' + set.cuit; if (usados.has(clave) && usados.get(clave) !== String(h.id)) { delete set.cuit; cuitRepetidos++; } else usados.set(clave, String(h.id)); }
      if (Object.keys(set).length) cambios.push({ id: h.id, set }); }));
    nuevos.forEach(p => { if (p.datos.cuit) { const clave = String(req.orgId) + '|' + p.datos.cuit; if (usados.has(clave)) { p.datos = Object.assign({}, p.datos, { cuit: '' }); cuitRepetidos++; } else usados.set(clave, 'nuevo:' + p.nombre); } });
    const resumen = {
      clientes: lista.length, existentes: existentes.length, aCrear: nuevos.length, ambiguos: ambiguos.length, ejemplosAmbiguos: ambiguos.slice(0, 10).map(p => p.nombre),
      aCompletar: cambios.length, camposACompletar: cambios.reduce((a, c) => a + Object.keys(c.set).length, 0), conCuit: lista.filter(p => p.datos.cuit).length, cuitRepetidos,
      resp_inscriptos: lista.filter(p => p.datos.categoriaFiscal === 'responsable_inscripto').length, sucursalNuevos: (orgs.find(o => String(o._id) === String(req.orgId)) || {}).nombre || '',
      errores: errores.length, ejemplosErrores: errores.slice(0, 5).map(e => e.motivo)
    };
    if (!aplicar) return resumen;
    const ops = cambios.map(c => ({ updateOne: { filter: { _id: c.id }, update: { $set: Object.assign({}, c.set, { updatedAt: ahora }) } } }));
    let completados = 0; for (let i = 0; i < ops.length; i += 500) { const r = await db.collection('clientes').bulkWrite(ops.slice(i, i + 500), { ordered: false }); completados += r.modifiedCount; }
    let creados = 0;
    for (let i = 0; i < nuevos.length; i += 500) {
      const docsN = nuevos.slice(i, i + 500).map(p => { const d = Object.assign({}, p.datos); delete d.codigo; Object.keys(d).forEach(k => { if (vacio(d[k])) delete d[k]; });
        return Object.assign({ categoriaFiscal: 'consumidor_final', origenCliente: 'Importado Dux', apellidoRazonSocial: p.nombre, activo: p.habilitado, orgId: req.orgId, createdAt: p.creado || ahora, updatedAt: ahora }, d); });
      const r = await db.collection('clientes').insertMany(docsN, { ordered: false }); creados += r.insertedCount;
    }
    return Object.assign(resumen, { creados, completados });
  });
}
router.post('/clientes/preview', authCli, async (req, res) => { try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/clientes/aplicar', authCli, async (req, res) => { try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
module.exports = router;
