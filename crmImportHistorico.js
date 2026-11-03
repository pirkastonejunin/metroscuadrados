// ---------------------------------------------------------------------------
// Importación del HISTÓRICO comercial de Pirka al CRM (2/11/2026, pedido de Mato: el Excel "Base Comercial PIRKA").
//
// Entrada: el Excel con las hojas PRESUPUESTOS, VENTAS, BOT y COMERCIOS (la hoja CONTROL se ignora). Todas traen, a la derecha, las
// columnas de seguimiento: ESTADO, PRODUCTO, M2, ULTIMO CONTACTO, OBSERVACIONES CONTACTO, PROXIMA ACCION, FECHA PROX, REFERIDO.
//
// Decisiones (acordadas con Mato: "todo, incluidos los NO LLAMADO" y "como oportunidades del CRM"):
//   - Una oportunidad por CONTACTO: se agrupa por teléfono (últimos 10 dígitos) o, si no hay, por nombre. Un mismo contacto que aparece en
//     varias hojas / varias filas queda en una sola oportunidad, con el detalle de cada presupuesto / venta / consulta en las notas.
//   - Estado de la oportunidad: VENDIDO -> convertida (sin visita), PERDIDO -> descartada (con motivo), el resto (NO LLAMADO, INTERESADO,
//     PRESUPUESTO ENVIADO, VISITA) -> activa. Si un contacto tiene varias filas, manda la más avanzada.
//   - Re-subir el archivo no duplica: se saltean los contactos que ya están (claveImport o mismo teléfono ya cargado en el CRM).
//   - Solo CRM: no crea clientes, presupuestos ni ventas, no toca stock ni cuentas.
// Rutas: POST /preview  y  POST /aplicar   body: { archivoBase64 }   (se carga en la sucursal elegida arriba)
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const XLSX = require('xlsx');
const { authUsuario, requiereAlgunModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereAlgunModulo('crm', 'visitas')];

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
async function conReintento(fn) { try { return await fn(); } catch (e) { if (!require('./reintento').reintentable(e)) throw e; mongoClient = null; return await fn(); } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const texto = (v) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

function parsearFecha(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), 15));
  if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? new Date(Date.UTC(d.y, d.m - 1, d.d, 15)) : null; }
  const s = texto(v);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 15));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 15)) : null;
}
const fmtFecha = (d) => d ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : '';
function plata(v) {
  if (typeof v === 'number') return v;
  const s = texto(v).replace(/[$\s]/g, '');
  if (!s) return 0;
  const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  return Number.isFinite(n) ? n : 0;
}
// Las próximas acciones del Excel que ya pasaron NO se cargan como acción vencida (llenarían el CRM de alertas viejas): quedan escritas en las notas.
const hoyUTC = () => { const d = new Date(Date.now() - 3 * 3600e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0)); };
const money = (n) => '$ ' + Math.round(Number(n) || 0).toLocaleString('es-AR');

// "BALBUENA, DANTE" -> "Dante Balbuena"; todo en mayúsculas -> Título.
function nombreProlijo(s) {
  let t = texto(s);
  if (!t) return '';
  if (t.includes(',')) { const [ap, ...resto] = t.split(','); t = (resto.join(' ').trim() + ' ' + ap.trim()).trim(); }
  if (t === t.toUpperCase() || t === t.toLowerCase()) t = t.toLowerCase().replace(/(^|[\s.\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return t;
}
// En la columna Usuario del Bot a veces hay mails de las casillas (atencion@, junin@, pirka@openbot): no son vendedores.
const esPersona = (s) => !!s && !/@|\.(com|io|ar)\b/i.test(s);
const tokens = (s) => norm(s).replace(/[^a-z0-9ñ ]/g, ' ').split(' ').filter(Boolean).sort().join(' ');

function telefonoNormal(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) d = '549' + d; // área + número sin 15 ni 54: se guarda como lo guarda el bot
  return d;
}
const ultimos10 = (d) => (d && d.length >= 8 ? d.slice(-10) : '');

const PRIORIDAD = { 'VENDIDO': 6, 'VISITA': 5, 'PRESUPUESTO ENVIADO': 4, 'INTERESADO': 3, 'PERDIDO': 2, 'NO LLAMADO': 1 };
const estadoCrm = (e) => { const k = norm(e).toUpperCase(); return PRIORIDAD[k] ? k : 'NO LLAMADO'; };

// Lee una hoja con encabezado en la primera fila. Si un título se repite (BOT trae "Estado" y "ESTADO"), vale el último (el de seguimiento).
function filasDeHoja(wb, nombre) {
  const hoja = wb.Sheets[wb.SheetNames.find((n) => norm(n) === norm(nombre))];
  if (!hoja) return [];
  const todas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: null });
  if (!todas.length) return [];
  const idx = {};
  todas[0].forEach((h, i) => { const k = norm(h); if (k) idx[k] = i; });
  const get = (r, ...claves) => { for (const c of claves) { const i = idx[norm(c)]; if (i != null && r[i] != null && r[i] !== '') return r[i]; } return null; };
  return todas.slice(1).map((r, i) => ({ r, fila: i + 2, get: (...c) => get(r, ...c) })).filter((x) => x.r.some((v) => v != null && v !== ''));
}

function leerArchivo(b64) {
  if (!b64) throw err(400, 'Falta el archivo.');
  let wb;
  try { wb = XLSX.read(Buffer.from(String(b64), 'base64'), { type: 'buffer', cellDates: true }); } catch (e) { throw err(400, 'No se pudo leer el archivo: ¿es el Excel de la Base Comercial?'); }
  const eventos = [];
  const errores = [];
  const seg = (x) => ({
    estado: estadoCrm(x.get('ESTADO')), producto: texto(x.get('PRODUCTO')), m2: x.get('M2'), ultimoContacto: parsearFecha(x.get('ULTIMO CONTACTO')),
    obsContacto: texto(x.get('OBSERVACIONES CONTACTO')), proxAccion: texto(x.get('PROXIMA ACCION')), fechaProx: parsearFecha(x.get('FECHA PROX')), referido: texto(x.get('REFERIDO'))
  });
  for (const x of filasDeHoja(wb, 'PRESUPUESTOS')) {
    const nombre = nombreProlijo(x.get('Cliente'));
    if (!nombre) { errores.push({ hoja: 'PRESUPUESTOS', fila: x.fila, motivo: 'sin cliente' }); continue; }
    const f = parsearFecha(x.get('Fecha Comp'));
    eventos.push(Object.assign({ hoja: 'Presupuestos', nombre, telefono: telefonoNormal(x.get('Teléfono', 'Telefono')), vendedor: nombreProlijo(x.get('Personal')), fecha: f,
      linea: 'Presupuesto' + (x.get('Numero Presupuesto') ? ' #' + x.get('Numero Presupuesto') : '') + (f ? ' del ' + fmtFecha(f) : '') + ' por ' + money(plata(x.get('Total'))) + (x.get('Estado Presupuesto') ? ' — ' + texto(x.get('Estado Presupuesto')) : '') + (x.get('Comprobante') ? ' (' + texto(x.get('Comprobante')) + ')' : '') + (x.get('Observaciones') ? ' · ' + texto(x.get('Observaciones')) : '') }, seg(x)));
  }
  for (const x of filasDeHoja(wb, 'VENTAS')) {
    const nombre = nombreProlijo(x.get('Cliente'));
    if (!nombre) { errores.push({ hoja: 'VENTAS', fila: x.fila, motivo: 'sin cliente' }); continue; }
    const f = parsearFecha(x.r[0]);
    eventos.push(Object.assign({ hoja: 'Ventas', nombre, telefono: '', vendedor: nombreProlijo(x.get('Vendedor', 'Personal')), fecha: f,
      linea: 'Venta' + (f ? ' del ' + fmtFecha(f) : '') + ' por ' + money(plata(x.r[2])) + (x.get('Comprobante') ? ' (' + texto(x.get('Comprobante')) + ')' : '') + (x.get('Estado Remito') ? ' — ' + texto(x.get('Estado Remito')) : '') + (plata(x.get('Dias Sin Cobrar')) > 0 && plata(x.get('Cobrado')) < plata(x.r[2]) ? ' · cobrado ' + money(plata(x.get('Cobrado'))) : '') + (x.get('Observaciones') ? ' · ' + texto(x.get('Observaciones')) : '') }, seg(x)));
  }
  for (const x of filasDeHoja(wb, 'BOT')) {
    const nombre = nombreProlijo(x.get('Nombre'));
    const tel = telefonoNormal(x.get('Celular'));
    if (!nombre && !tel) { errores.push({ hoja: 'BOT', fila: x.fila, motivo: 'sin nombre ni celular' }); continue; }
    const f = parsearFecha(x.get('Fecha'));
    eventos.push(Object.assign({ hoja: 'Bot', nombre: nombre || ('+' + tel), telefono: tel, vendedor: nombreProlijo(x.get('Usuario')), fecha: f, fuente: texto(x.get('Fuente')),
      linea: 'Consulta' + (f ? ' del ' + fmtFecha(f) : '') + (x.get('Tipo') ? ' — ' + texto(x.get('Tipo')) : '') + (x.get('Fuente') && texto(x.get('Fuente')) !== '-' ? ' (' + texto(x.get('Fuente')) + ')' : '') }, seg(x)));
  }
  for (const x of filasDeHoja(wb, 'COMERCIOS')) {
    const nombre = texto(x.get('Identificación', 'Identificacion'));
    if (!nombre) { errores.push({ hoja: 'COMERCIOS', fila: x.fila, motivo: 'sin nombre' }); continue; }
    const tel = texto(x.get('tel/cel'));
    eventos.push(Object.assign({ hoja: 'Comercios', nombre, telefono: telefonoNormal(tel.split(/[\/,;]/)[0]), telOriginal: tel, email: texto(x.get('email')), vendedor: '', fecha: null,
      linea: 'Comercio' + (x.get('Actividad principal') ? ': ' + texto(x.get('Actividad principal')) : '') + (x.get('página web') ? ' · ' + texto(x.get('página web')) : '') + (tel ? ' · tel ' + tel : '') }, seg(x)));
  }
  return { eventos, errores };
}

// Junta los eventos en contactos (clave: teléfono o nombre).
function agrupar(eventos) {
  const grupos = new Map();
  for (const e of eventos) {
    const t10 = ultimos10(e.telefono);
    const clave = t10 ? 'tel:' + t10 : 'nom:' + tokens(e.nombre);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(e);
  }
  const out = [];
  for (const [clave, evs] of grupos) {
    const mejor = evs.slice().sort((a, b) => PRIORIDAD[b.estado] - PRIORIDAD[a.estado])[0];
    const fechas = evs.map((e) => e.fecha).filter(Boolean).sort((a, b) => a - b);
    const contactos = evs.map((e) => e.ultimoContacto).filter(Boolean).sort((a, b) => b - a);
    const conProx = evs.filter((e) => e.fechaProx).sort((a, b) => b.fechaProx - a.fechaProx)[0];
    const hojas = [...new Set(evs.map((e) => e.hoja))];
    const fuentes = [...new Set(evs.map((e) => e.fuente).filter((f) => f && f !== '-'))];
    const productos = [...new Set(evs.map((e) => e.producto).filter(Boolean))];
    const nombreEv = evs.find((e) => e.hoja !== 'Bot' || !/^\+\d+$/.test(e.nombre)) || evs[0];
    const tel = (evs.find((e) => e.telefono) || {}).telefono || '';
    const lineas = [];
    lineas.push('Histórico Pirka (importado del Excel "Base Comercial") · ' + hojas.join(', '));
    if (productos.length) lineas.push('Producto: ' + productos.join(', ') + (evs.find((e) => e.m2) ? ' · M2: ' + evs.find((e) => e.m2).m2 : ''));
    const vistas = new Set();
    evs.filter((e) => e.obsContacto || e.ultimoContacto).forEach((e) => { const l = 'Contacto' + (e.ultimoContacto ? ' ' + fmtFecha(e.ultimoContacto) : '') + (e.obsContacto ? ': ' + e.obsContacto : ''); if (!vistas.has(l)) { vistas.add(l); lineas.push(l); } });
    const accion = evs.map((e) => e.proxAccion).filter(Boolean)[0];
    if (accion) lineas.push('Próxima acción: ' + accion);
    const ref = evs.map((e) => e.referido).filter(Boolean)[0];
    if (ref) lineas.push('Referido: ' + ref);
    [...new Set(evs.map((e) => e.linea))].slice(0, 25).forEach((l) => lineas.push(l));
    if (evs.length > 25) lineas.push('… y ' + (evs.length - 25) + ' movimientos más.');
    out.push({
      clave, nombre: nombreEv.nombre, telefono: tel, email: (evs.find((e) => e.email) || {}).email || '', estado: mejor.estado,
      vendedor: (evs.find((e) => esPersona(e.vendedor)) || {}).vendedor || '', fechaAlta: fechas[0] || null, ultimoContacto: contactos[0] || null,
      fechaProx: conProx ? conProx.fechaProx : null, notaProx: accion || '', producto: productos.join(', '), hojas, fuentes,
      motivo: mejor.obsContacto || '', notas: lineas.join('\n')
    });
  }
  return out;
}

async function analizar(db, req, b64) {
  const { eventos, errores } = leerArchivo(b64);
  const contactos = agrupar(eventos);
  const org = req.orgId;
  const existentes = await db.collection('oportunidades').find({ orgId: org }).project({ claveImport: 1, 'cliente.telefono': 1 }).toArray();
  const yaClave = new Set(existentes.map((o) => o.claveImport).filter(Boolean));
  const yaTel = new Set(existentes.map((o) => ultimos10(String((o.cliente || {}).telefono || '').replace(/\D/g, ''))).filter(Boolean));
  const vendedores = await db.collection('visitas_vendedores').find({ orgId: org }).project({ nombre: 1 }).toArray();
  const vendPorTokens = new Map(vendedores.map((v) => [tokens(v.nombre), v]));
  const nuevos = [], yaCargados = [];
  for (const c of contactos) {
    const t10 = ultimos10(c.telefono);
    if (yaClave.has('pirka:' + c.clave) || (t10 && yaTel.has(t10))) yaCargados.push(c); else nuevos.push(c);
  }
  const porEstado = {}; nuevos.forEach((c) => { porEstado[c.estado] = (porEstado[c.estado] || 0) + 1; });
  const nombresVend = {}; nuevos.forEach((c) => { if (c.vendedor) nombresVend[c.vendedor] = (nombresVend[c.vendedor] || 0) + 1; });
  const vendedoresInfo = Object.keys(nombresVend).sort().map((n) => ({ nombre: n, contactos: nombresVend[n], vinculado: vendPorTokens.has(tokens(n)) ? vendPorTokens.get(tokens(n)).nombre : '' }));
  return { eventos, errores, contactos, nuevos, yaCargados, porEstado, vendPorTokens, vendedoresInfo };
}

async function sucursalNombre(db, orgId) {
  const o = await db.collection('organizaciones').findOne({ _id: orgId }, { projection: { nombre: 1 } });
  return o ? o.nombre : '';
}

router.post('/preview', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí arriba la sucursal donde querés cargar el histórico (no "todas").');
    const out = await conReintento(async () => {
      const db = await getDb();
      const a = await analizar(db, req, req.body && req.body.archivoBase64);
      const porHoja = {}; a.eventos.forEach((e) => { porHoja[e.hoja] = (porHoja[e.hoja] || 0) + 1; });
      return {
        sucursalDestino: await sucursalNombre(db, req.orgId), filasLeidas: a.eventos.length, porHoja, contactos: a.contactos.length,
        aImportar: a.nuevos.length, yaCargados: a.yaCargados.length, porEstado: a.porEstado,
        sinTelefono: a.nuevos.filter((c) => !c.telefono).length, conProximaAccion: a.nuevos.filter((c) => c.fechaProx && c.fechaProx >= hoyUTC()).length,
        vendedores: a.vendedoresInfo, errores: a.errores.slice(0, 20), cantErrores: a.errores.length
      };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/aplicar', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí arriba la sucursal donde querés cargar el histórico (no "todas").');
    const out = await conReintento(async () => {
      const db = await getDb();
      const a = await analizar(db, req, req.body && req.body.archivoBase64);
      if (!a.nuevos.length) return { insertados: 0, yaCargados: a.yaCargados.length };
      // Se reserva de una vez el bloque de números de oportunidad.
      const r = await db.collection('crm_counters').findOneAndUpdate({ _id: 'oportunidad_numero' }, { $inc: { seq: a.nuevos.length } }, { upsert: true, returnDocument: 'after' });
      const ultimo = (r && r.value ? r.value.seq : r.seq);
      let n = ultimo - a.nuevos.length;
      const ahora = new Date();
      const docs = a.nuevos.map((c) => {
        const vend = c.vendedor ? a.vendPorTokens.get(tokens(c.vendedor)) : null;
        const estado = c.estado === 'VENDIDO' ? 'convertida' : c.estado === 'PERDIDO' ? 'descartada' : 'activa';
        const activa = estado === 'activa';
        return {
          numero: ++n, orgId: req.orgId,
          cliente: { nombre: c.nombre, telefono: c.telefono, email: c.email || '', direccion: '', localidad: '' },
          origen: 'Histórico Pirka' + (c.hojas.length ? ' · ' + c.hojas.join(', ') : '') + (c.fuentes.length ? ' · ' + c.fuentes.join(', ') : ''),
          vendedorId: vend ? vend._id : null, vendedorNombre: vend ? vend.nombre : c.vendedor,
          notas: c.notas,
          proximaAccion: activa && c.fechaProx && c.fechaProx >= hoyUTC() ? { fecha: c.fechaProx, tipo: 'otro', nota: c.notaProx } : null,
          estado, visitaId: null,
          motivoDescarte: estado === 'descartada' ? (c.motivo || 'Perdido (histórico Pirka)') : (estado === 'convertida' ? 'Vendido (histórico Pirka)' : ''),
          leadId: null, importado: true, claveImport: 'pirka:' + c.clave, estadoHistorico: c.estado, producto: c.producto, ultimoContacto: c.ultimoContacto,
          createdAt: c.fechaAlta || ahora, updatedAt: c.ultimoContacto || ahora
        };
      });
      for (let i = 0; i < docs.length; i += 500) await db.collection('oportunidades').insertMany(docs.slice(i, i + 500));
      return { insertados: docs.length, yaCargados: a.yaCargados.length };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports._interno = { leerArchivo, agrupar, nombreProlijo, telefonoNormal };
