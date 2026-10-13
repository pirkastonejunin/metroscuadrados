// ---------------------------------------------------------------------------
// Portales de proveedores (13/10/2026, pedido de Mato: "cuando cargo desde la ficha del proveedor, quiero poder
// acceder a través de un login y que se me actualicen los precios y costos").
//
// Un conector por portal. Cada uno sabe iniciar sesión y devolver la lista como filas
//   { fila, codigo, nombre, precio, stock, stockCelda, moneda }
// que después pasan por la MISMA regla de importación que una lista en Excel (descuentos, IVA, márgenes por lista de
// precios, stock, alertas). El usuario y la clave se guardan cifrados (AES-256-GCM) en la ficha del proveedor.
//
// Conectores:
//   - maxipiso: catálogo mayorista de https://www.maxipiso.com.ar (Next.js + NextAuth con usuario/clave y, si la cuenta lo
//     tiene activado, código de verificación en dos pasos). Lista completa por la API pública del propio catálogo,
//     /api/catalogo/todos, con la sesión iniciada.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function err(status, message) { return Object.assign(new Error(message), { status }); }

// ---- cifrado de las credenciales guardadas
function claveDeCifrado() {
  const base = process.env.ARCA_SECRETO || process.env.MONGODB_URI;
  if (!base) throw err(500, 'Falta ARCA_SECRETO (o MONGODB_URI) en el servidor para cifrar las credenciales.');
  return crypto.scryptSync(String(base), 'piedranegra-portales-v1', 32);
}
function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', claveDeCifrado(), iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
function descifrar(valor) {
  const p = String(valor || '').split('.');
  if (p.length !== 4 || p[0] !== 'v1') throw err(500, 'La clave guardada del portal no tiene un formato válido: volvé a cargarla.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', claveDeCifrado(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    throw err(500, 'No se pudo descifrar la clave guardada del portal (cambió el secreto del servidor): volvé a cargarla.');
  }
}

// ---- código de dos pasos (TOTP, RFC 6238) por si el portal lo exige
function base32Decode(s) {
  const alf = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const limpio = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of limpio) bits += alf.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function codigoTotp(secretoBase32, ahora) {
  const key = base32Decode(secretoBase32);
  if (!key.length) throw err(400, 'El secreto del código de dos pasos no es válido.');
  const contador = Math.floor((ahora || Date.now()) / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1000000).padStart(6, '0');
}

// ---- pequeño manejo de cookies (el portal usa cookies de sesión de NextAuth)
function nuevaJarra() {
  const m = new Map();
  return {
    guardar(res) {
      const lista = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of lista) {
        const par = c.split(';')[0]; const i = par.indexOf('=');
        if (i > 0) { const k = par.slice(0, i).trim(), v = par.slice(i + 1).trim(); if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) m.delete(k); else m.set(k, v); }
      }
    },
    cabecera() { return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    tiene(re) { return [...m.keys()].some(k => re.test(k)); }
  };
}

async function pedirJson(url, opts, jarra, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const headers = Object.assign({ 'User-Agent': 'Mozilla/5.0 (compatible; MetrosCuadrados/1.0)', Accept: 'application/json' }, (opts && opts.headers) || {});
    const c = jarra.cabecera(); if (c) headers.Cookie = c;
    const res = await fetch(url, Object.assign({}, opts, { headers, signal: ctl.signal, redirect: 'manual' }));
    jarra.guardar(res);
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw err(504, 'El portal del proveedor tardó demasiado en responder.');
    throw err(502, 'No se pudo conectar con el portal del proveedor: ' + (e.cause && e.cause.code ? e.cause.code : e.message));
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- Maxipiso
const MAXIPISO_BASE = process.env.MAXIPISO_URL || 'https://www.maxipiso.com.ar';

async function loginMaxipiso(cred) {
  const jarra = nuevaJarra();
  const intentar = async (totp) => {
    const r1 = await pedirJson(MAXIPISO_BASE + '/api/auth/csrf', {}, jarra);
    if (!r1.ok) throw err(502, 'El portal de Maxipiso no respondió al iniciar sesión (' + r1.status + ').');
    const { csrfToken } = await r1.json();
    const body = new URLSearchParams({ csrfToken, email: cred.usuario, password: cred.clave, totp: totp || '', json: 'true', callbackUrl: MAXIPISO_BASE + '/catalogo' });
    const r2 = await pedirJson(MAXIPISO_BASE + '/api/auth/callback/credentials', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, jarra);
    let url = r2.headers.get('location') || '';
    if (!url) { try { const j = await r2.clone().json(); url = (j && j.url) || ''; } catch (e) { /* sin cuerpo */ } }
    const m = /[?&]error=([^&]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  };
  let error = await intentar('');
  if (error === 'TOTP_REQUIRED') {
    if (!cred.totpSecreto) throw err(400, 'Maxipiso pide el código de verificación en dos pasos y no hay un secreto de dos pasos cargado para este proveedor. Cargalo en la ficha (o pedile a Maxipiso un usuario sin dos pasos para el sistema).');
    error = await intentar(codigoTotp(cred.totpSecreto));
  }
  if (error) {
    if (/TOTP|CredentialsSignin|Invalid/i.test(error)) throw err(400, 'Maxipiso rechazó el usuario o la clave guardados. Revisalos en la ficha del proveedor.');
    throw err(400, 'Maxipiso no dejó iniciar sesión (' + error + ').');
  }
  const rs = await pedirJson(MAXIPISO_BASE + '/api/auth/session', {}, jarra);
  const ses = rs.ok ? await rs.json().catch(() => null) : null;
  if (!ses || !ses.user) throw err(400, 'Maxipiso no dejó iniciar sesión: revisá el usuario y la clave guardados.');
  return jarra;
}

function monedaDe(texto) {
  const t = String(texto == null ? '' : texto).trim().toLowerCase().replace(/\s/g, '');
  if (!t) return null;
  if (/^(u\$?s|us\$|uss|usd|u\$d|dolar|dólar)/.test(t)) return 'USD';
  if (t === '$' || t === 'ars' || t === 'arg$' || t === 'pesos') return 'ARS';
  return null;
}
function numero(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

// Una fila por producto: pisos / porcelanatos / revestimientos / decks se cotizan por m² (precioM2), maderas y accesorios por su precio.
// Fotos del producto: el catálogo las trae en algún campo de imagen (nombre exacto no garantizado): se buscan todos los campos
// cuyo nombre sugiera imagen y se toman las direcciones http(s) o relativas; las relativas se completan con el dominio del portal.
function imagenesDeProducto(p, base) {
  const urls = [];
  const agregar = (v) => {
    if (!v) return;
    if (typeof v === 'string' && v.includes('|')) { v.split('|').forEach(agregar); return; } // Maxipiso: varias fotos separadas por " | "
    if (typeof v === 'string') { const s = v.trim(); if (/^https?:\/\//i.test(s)) urls.push(s); else if (/^\/[^\s]+\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(s)) urls.push((base || '') + s); return; }
    if (Array.isArray(v)) { v.forEach(agregar); return; }
    if (typeof v === 'object') { agregar(v.url || v.src || v.secure_url || v.path || v.imagen || v.image); }
  };
  for (const k of Object.keys(p || {})) { if (/(imagen|image|foto|img|thumb|galeria|gallery|picture)/i.test(k)) agregar(p[k]); }
  return [...new Set(urls)].slice(0, 8);
}
function camposImagen(p) { return Object.keys(p || {}).filter(k => /(imagen|image|foto|img|thumb|galeria|gallery|picture)/i.test(k)); }

// m² por caja (unidades por bulto): se busca un campo numérico cuyo nombre hable de m² y de caja/bulto/pack, o de cobertura. Si no hay uno
// reconocible devuelve null (nunca se inventa); GET /portal/muestra muestra los campos reales para ajustar.
const RE_M2_CAJA = /(m2|m²|metros?|mts?).{0,12}(caja|bulto|pack|paquete|pallet)|(caja|bulto|pack|paquete).{0,12}(m2|m²|metros?|mts?)|cobertura|rendimiento/i;
function bultoDeProducto(p) {
  // Maxipiso: "base" = m² que cubre una caja (viene como "2.26 m2" con baseUm "m2"); además precioCaja = precioM2 × m² por caja, que sirve de control.
  const base = parseFloat(String(p.base == null ? '' : p.base).replace(',', '.'));
  const baseEsM2 = /m2|m²/i.test(String(p.baseUm || p.base || ''));
  if (baseEsM2 && base > 0 && base < 1000) return { campo: 'base', valor: Math.round(base * 1000) / 1000 };
  const pc = numero(p.precioCaja), pm = numero(p.precioM2);
  if (pc && pm) { const r = Math.round(pc / pm * 1000) / 1000; if (r > 0 && r < 1000) return { campo: 'precioCaja / precioM2', valor: r }; }
  const cand = Object.keys(p || {}).filter(k => RE_M2_CAJA.test(k) && !/precio|costo|stock|total|pallet/i.test(k));
  for (const k of cand) { const n = numero(p[k]); if (n > 0 && n < 1000) return { campo: k, valor: n }; }
  return null;
}
function filaDeProductoMaxipiso(p, i) {
  const precio = numero(p.precioM2) || numero(p.precio);
  const unidad = numero(p.precioM2) ? 'm²' : (p.unidadMedida || 'unidad');
  const nombre = [p.tipoProducto || p._tablaLabel, p.nombre, p.codigo, p.marca].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const stock = Number(p.stock);
  const b = bultoDeProducto(p);
  return { fila: i + 1, pesoCaja: numero(p.pesoCaja), porM2: !!numero(p.precioM2), bulto: b ? b.valor : null, imagenes: imagenesDeProducto(p, MAXIPISO_BASE), codigo: String(p.sku == null ? '' : p.sku).trim(), nombre: nombre + ' (' + unidad + ')', precio, moneda: monedaDe(p.moneda), stock: Number.isFinite(stock) ? stock : null, stockCelda: p.stock, categoria: p._tabla };
}

async function filasMaxipiso(cred, opciones) {
  const jarra = await loginMaxipiso(cred);
  const productos = [];
  const lote = 100;
  for (let skip = 0; skip < 5000; skip += lote) {
    const r = await pedirJson(`${MAXIPISO_BASE}/api/catalogo/todos?take=${lote}&skip=${skip}&sortBy=relevancia`, {}, jarra, 45000);
    if (r.status === 401 || r.status === 403) throw err(400, 'Maxipiso cerró la sesión mientras se leía el catálogo. Probá de nuevo.');
    if (!r.ok) throw err(502, 'El catálogo de Maxipiso respondió con un error (' + r.status + ').');
    const j = await r.json().catch(() => null);
    const lista = j && j.success && j.data && Array.isArray(j.data.productos) ? j.data.productos : null;
    if (!lista) throw err(502, 'El catálogo de Maxipiso devolvió un formato inesperado: puede haber cambiado el sitio.');
    productos.push(...lista);
    if (lista.length < lote) break;
  }
  if (!productos.length) throw err(502, 'El catálogo de Maxipiso vino vacío.');
  const monedaRegla = (opciones && opciones.moneda) || 'USD';
  return productos.map(filaDeProductoMaxipiso).filter(f => f.codigo).map(f => {
    // La regla del proveedor tiene UNA moneda: las filas en otra moneda no se pueden calcular y quedan "sin precio".
    const m = f.moneda || monedaRegla;
    return Object.assign(f, m === monedaRegla ? {} : { precio: null, nombre: f.nombre + ' — en ' + m + ', la lista está configurada en ' + monedaRegla });
  });
}

// Diagnóstico: qué campos trae el catálogo y cuáles se reconocen como fotos (para verificar el conector sin adivinar).
async function muestraMaxipiso(cred) {
  const jarra = await loginMaxipiso(cred);
  const r = await pedirJson(`${MAXIPISO_BASE}/api/catalogo/todos?take=3&skip=0&sortBy=relevancia`, {}, jarra, 45000);
  const j = await r.json().catch(() => null);
  const lista = j && j.data && Array.isArray(j.data.productos) ? j.data.productos : [];
  const corto = v => (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 200) : (typeof v === 'string' ? v.slice(0, 200) : v);
  return lista.map(p => ({ sku: p.sku, nombre: p.nombre, campos: Object.keys(p), valores: Object.fromEntries(Object.keys(p).map(k => [k, corto(p[k])])), camposImagen: camposImagen(p), imagenes: imagenesDeProducto(p, MAXIPISO_BASE), m2PorCaja: bultoDeProducto(p) }));
}

const CONECTORES = {
  maxipiso: { nombre: 'Maxipiso (catálogo mayorista)', url: MAXIPISO_BASE, filas: filasMaxipiso, muestra: muestraMaxipiso }
};

async function filasDePortal(portal, regla) {
  const con = portal && CONECTORES[portal.tipo];
  if (!con) throw err(400, 'Este proveedor no tiene un portal configurado.');
  if (!portal.usuario || !portal.claveCifrada) throw err(400, 'Faltan el usuario y la clave del portal en la ficha del proveedor.');
  return con.filas({ usuario: portal.usuario, clave: descifrar(portal.claveCifrada), totpSecreto: portal.totpCifrado ? descifrar(portal.totpCifrado) : '' }, { moneda: regla && regla.moneda });
}

async function muestraDePortal(portal) {
  const con = portal && CONECTORES[portal.tipo];
  if (!con || !con.muestra) throw err(400, 'Este proveedor no tiene un portal configurado.');
  if (!portal.usuario || !portal.claveCifrada) throw err(400, 'Faltan el usuario y la clave del portal en la ficha del proveedor.');
  return con.muestra({ usuario: portal.usuario, clave: descifrar(portal.claveCifrada), totpSecreto: portal.totpCifrado ? descifrar(portal.totpCifrado) : '' });
}
module.exports = { bultoDeProducto, muestraDePortal, imagenesDeProducto, camposImagen, CONECTORES, filasDePortal, cifrar, descifrar, codigoTotp, monedaDe, filaDeProductoMaxipiso };
