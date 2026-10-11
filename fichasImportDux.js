// ---------------------------------------------------------------------------
// Importar la FICHA de proveedores de Dux (Dux: "Listado de Proveedores"): razón social, fantasía, categoría fiscal, CUIT,
// domicilio, contacto, etc. Cada proveedor se busca por nombre en todas las sucursales accesibles:
//   - si ya existe (por compras/gastos/pagos importados), se le COMPLETAN los datos que tenga vacíos (nunca pisa lo ya cargado);
//   - si no existe, se crea en la sucursal elegida.
// Repetible sin duplicar. Rutas: POST /api/fichas-import-dux/proveedores/preview y /aplicar   body: { archivoBase64, orgId }
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');
const comprasDux = require('./comprasImportDux');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authProv = [authUsuario, resolverOrg, requiereModulo('proveedores')];
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

function leer(base64) {
  if (!base64) throw err(400, 'Falta el archivo');
  const buf = Buffer.from(String(base64).replace(/^data:[^,]*,/, ''), 'base64');
  let wb; try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de Dux (.xls / .xlsx)?'); }
  const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const h = filas.findIndex(f => f && f.some(c => norm(c) === 'proveedor') && f.some(c => norm(c) === 'categoria fiscal'));
  if (h < 0) throw err(400, 'No encontré las columnas Proveedor y Categoria Fiscal. Tiene que ser "Listado de Proveedores" de Dux.');
  const enc = filas[h].map(norm); const c = (n) => enc.indexOf(n);
  const idx = { id: c('id'), prov: c('proveedor'), fant: c('nombre de fantasia'), cat: c('categoria fiscal'), tdoc: c('tipo documento'), ndoc: c('numero documento'), cuit: c('cuit/cuil'), cod: c('codigo'), mail: c('correo electronico'),
    prv: c('provincia'), loc: c('localidad'), bar: c('barrio'), dom: c('domicilio'), tel: c('telefono'), pago: c('condicion pago'), cont: c('persona contacto'), tcmp: c('tipo comprobante por defecto'), hab: c('habilitado') };
  const txt = (f, k) => (idx[k] >= 0 && f[idx[k]] != null) ? String(f[idx[k]]).trim() : '';
  const lista = [], errores = []; const vistos = new Set();
  for (let i = h + 1; i < filas.length; i++) {
    const f = filas[i]; if (!f || f.every(x => x == null || x === '')) continue;
    const nombre = txt(f, 'prov'); if (!nombre) { errores.push({ fila: i + 1, motivo: 'Falta el nombre del proveedor' }); continue; }
    if (vistos.has(norm(nombre))) { errores.push({ fila: i + 1, motivo: 'Proveedor repetido (' + nombre + ')' }); continue; } vistos.add(norm(nombre));
    const cuit = txt(f, 'cuit').replace(/\D/g, '');
    const dom = [txt(f, 'dom'), txt(f, 'bar')].filter(Boolean).join(' — ');
    const d = { razonSocial: nombre, nombreFantasia: txt(f, 'fant'), categoriaFiscal: CAT[txt(f, 'cat').toUpperCase()] || null, tipoDocumento: DOC[txt(f, 'tdoc').toUpperCase()] || null,
      numeroDocumento: txt(f, 'ndoc'), cuit: cuit.length === 11 ? cuit : '', codigo: txt(f, 'cod'), email: txt(f, 'mail'), provincia: txt(f, 'prv'), localidad: txt(f, 'loc'), domicilio: dom, telefono: txt(f, 'tel'),
      condicionPago: txt(f, 'pago'), personaContacto: txt(f, 'cont'), codigoDux: idx.id >= 0 && f[idx.id] != null ? String(f[idx.id]) : '', tipoComprobanteDux: txt(f, 'tcmp') };
    lista.push({ fila: i + 1, nombre, datos: d, habilitado: !/^n/i.test(txt(f, 'hab')) });
  }
  return { lista, errores };
}
const vacio = (v) => v == null || v === '' || (typeof v === 'number' && !isFinite(v));

async function procesar(req, aplicar) {
  if (!req.orgId) { const v = req.body && req.body.orgId; if (v && /^[0-9a-f]{24}$/i.test(String(v))) req.orgId = new ObjectId(String(v)); }
  if (!req.orgId) throw err(400, 'Elegí en qué sucursal se crean los proveedores que no existan.');
  const { lista, errores } = leer(req.body && req.body.archivoBase64);
  if (!lista.length) throw err(400, 'El archivo no tiene proveedores.');
  return conReintento(async () => {
    const db = await getDb(); const ahora = new Date();
    const orgs = await orgsAccesibles(db, req); const orgIds = orgs.map(o => o._id);
    if (!orgIds.some(x => String(x) === String(req.orgId))) orgIds.push(req.orgId);
    const resolvers = new Map(orgIds.map(o => [String(o), comprasDux.crearResolverProveedores(db, o, ahora)]));
    const creador = comprasDux.crearResolverProveedores(db, req.orgId, ahora);
    const existentes = []; const nuevos = []; const ambiguos = [];
    for (const p of lista) {
      const hallados = []; let amb = false;
      for (const o of orgIds) { const r = await resolvers.get(String(o)).clasificar(p.nombre); if (r && r !== 'NUEVO') hallados.push({ orgId: o, id: new ObjectId(r) }); else if (r === null) amb = true; }
      if (hallados.length) existentes.push({ p, hallados }); else if (amb) ambiguos.push(p); else nuevos.push(p);
    }
    // qué se completaría en los existentes
    const ids = existentes.flatMap(e => e.hallados.map(h => h.id));
    const docs = new Map((ids.length ? await db.collection('proveedores').find({ _id: { $in: ids } }).toArray() : []).map(d => [String(d._id), d]));
    const CAMPOS = ['nombreFantasia', 'categoriaFiscal', 'tipoDocumento', 'numeroDocumento', 'cuit', 'codigo', 'email', 'provincia', 'localidad', 'domicilio', 'telefono', 'condicionPago', 'personaContacto', 'codigoDux', 'tipoComprobanteDux'];
    const cambios = [];
    existentes.forEach(e => e.hallados.forEach(h => { const d = docs.get(String(h.id)); if (!d) return; const set = {};
      CAMPOS.forEach(k => { if (vacio(d[k]) && !vacio(e.p.datos[k])) set[k] = e.p.datos[k]; });
      if (Object.keys(set).length) cambios.push({ id: h.id, set }); }));
    const resumen = {
      proveedores: lista.length, existentes: existentes.length, aCrear: nuevos.length, ambiguos: ambiguos.length, ejemplosAmbiguos: ambiguos.slice(0, 10).map(p => p.nombre),
      aCompletar: cambios.length, camposACompletar: cambios.reduce((a, c) => a + Object.keys(c.set).length, 0), conCuit: lista.filter(p => p.datos.cuit).length,
      deshabilitados: lista.filter(p => !p.habilitado).length, sucursalNuevos: (orgs.find(o => String(o._id) === String(req.orgId)) || {}).nombre || '', errores
    };
    if (!aplicar) return resumen;

    for (const p of nuevos) await creador.clasificar(p.nombre);
    const ops = cambios.map(c => ({ updateOne: { filter: { _id: c.id }, update: { $set: Object.assign({}, c.set, { updatedAt: ahora }) } } }));
    let completados = 0; for (let i = 0; i < ops.length; i += 500) { const r = await db.collection('proveedores').bulkWrite(ops.slice(i, i + 500), { ordered: false }); completados += r.modifiedCount; }
    let creados = 0;
    if (nuevos.length) {
      const docsN = nuevos.map(p => { const d = Object.assign({}, p.datos); Object.keys(d).forEach(k => { if (vacio(d[k])) delete d[k]; });
        return Object.assign({ activo: p.habilitado, notas: 'Importado de Dux', orgId: req.orgId, createdAt: ahora, updatedAt: ahora }, d); });
      const r = await db.collection('proveedores').insertMany(docsN, { ordered: false }); creados = r.insertedCount;
    }
    return Object.assign(resumen, { creados, completados });
  });
}
router.post('/proveedores/preview', authProv, async (req, res) => { try { res.json(await procesar(req, false)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
router.post('/proveedores/aplicar', authProv, async (req, res) => { try { res.json(await procesar(req, true)); } catch (e) { res.status(e.status || 500).json({ error: e.message }); } });
module.exports = router;
