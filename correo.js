// ---------------------------------------------------------------------------
// Correo automático a clientes (15/10/2026, pedido de Mato): cuando se emite una venta/nota de crédito/nota de débito, se registra
// un cobro o una cobranza a cuenta, el sistema le manda un mail al cliente que tenga email cargado — con el link para ver/descargar
// el comprobante o el recibo.
//
// Se envía por la API de Gmail (HTTPS) con la cuenta de la empresa: Render gratis bloquea el SMTP clásico. La cuenta se conecta UNA vez
// desde la pantalla "Correo" (Configuración) con el botón "Conectar Gmail" (OAuth); el refresh token queda guardado en la base
// (colección `correo_config`, documento `global`) y nunca se devuelve al navegador.
//
// Variables de entorno (Render → Environment):
//   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   — credenciales "ID de cliente de OAuth" (aplicación web) de Google Cloud.
//   PUBLIC_BASE_URL (opcional)                             — URL pública, p. ej. https://metroscuadrados.onrender.com.
//
// Nunca frena la operación: todo error al mandar un mail se registra (`correos_enviados`) y se sigue.
// Un cliente se puede excluir con la marca `noEnviarMails` en su ficha.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
const authAdmin = [authUsuario, resolverOrg, requiereModulo('usuarios')];
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'];

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
async function conReintento(fn) { try { return await fn(); } catch (e) { if (e && e.status) throw e; mongoClient = null; return await fn(); } }
function err(status, message) { const e = new Error(message); e.status = status; return e; }
function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, moneda) => (moneda === 'USD' ? 'U$S ' : '$ ') + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Para pruebas: reemplaza el envío real. Recibe { raw, to, subject, html }.
let envioOverride = null;
router.__setEnvioOverride = fn => { envioOverride = fn; };

function baseUrlDe(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/+$/, '');
  const host = (req && req.get && req.get('host')) || '';
  const proto = (req && req.headers && req.headers['x-forwarded-proto']) || (/^localhost|^127\./.test(host) ? 'http' : 'https');
  return host ? `${String(proto).split(',')[0]}://${host}` : '';
}
router.baseUrlDe = baseUrlDe;

async function getConfig(db) { return (await db.collection('correo_config').findOne({ _id: 'global' })) || { _id: 'global' }; }

function oauthClient(redirectUri) {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
}
function redirectUriDe(req) { return baseUrlDe(req) + '/api/correo/google/callback'; }
const oauthListo = () => !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);

// ---- Mails válidos de un campo libre ("a@x.com; b@y.com") ----
function mailsValidos(campo) {
  return String(campo || '').split(/[;, \n]+/).map(s => s.trim()).filter(s => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s));
}
router.mailsValidos = mailsValidos;

function encabezadoMime(texto) { return /^[\x20-\x7e]*$/.test(texto) ? texto : '=?UTF-8?B?' + Buffer.from(texto, 'utf8').toString('base64') + '?='; }
function armarMime({ desde, nombreDesde, para, asunto, html }) {
  const from = nombreDesde ? `${encabezadoMime(nombreDesde)} <${desde}>` : desde;
  const cuerpo = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    `From: ${from}`, `To: ${para.join(', ')}`, `Subject: ${encabezadoMime(asunto)}`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', cuerpo
  ].join('\r\n');
}

// Envía un mail con la cuenta conectada. Lanza error si no está conectada o falla.
async function enviarMail(db, { para, asunto, html }) {
  const cfg = await getConfig(db);
  if (!cfg.refreshToken && !envioOverride) throw new Error('Gmail no está conectado (Configuración → Correo).');
  const raw = armarMime({ desde: cfg.email || 'me', nombreDesde: cfg.nombreRemitente || '', para, asunto, html });
  if (envioOverride) return envioOverride({ raw, to: para, subject: asunto, html });
  const { google } = require('googleapis');
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: cfg.refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const codificado = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: codificado } });
  return r && r.data;
}

function plantilla({ orgNombre, titulo, saludo, lineas, boton, url, pie }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#222">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:10px;overflow:hidden">
<tr><td style="background:#1f2937;color:#fff;padding:16px 24px;font-size:18px;font-weight:bold">${esc(orgNombre)}</td></tr>
<tr><td style="padding:24px">
<h2 style="margin:0 0 12px;font-size:20px">${esc(titulo)}</h2>
<p style="margin:0 0 12px;font-size:15px">${esc(saludo)}</p>
${lineas.map(l => `<p style="margin:0 0 8px;font-size:15px">${l}</p>`).join('')}
${url ? `<p style="margin:20px 0"><a href="${esc(url)}" style="background:#e8590c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(boton || 'Ver documento')}</a></p>
<p style="margin:0 0 8px;font-size:12px;color:#666">Si el botón no funciona, copiá este link en tu navegador:<br>${esc(url)}</p>` : ''}
<p style="margin:20px 0 0;font-size:12px;color:#888">${esc(pie || 'Este mensaje se envió automáticamente. Si tenés alguna consulta, respondé este mail o comunicate con nosotros.')}</p>
</td></tr></table></td></tr></table></body></html>`;
}

async function crearLink(db, tipo, docId, index, orgId) {
  const filtro = { tipo, docId, index: index == null ? null : index, orgId };
  let link = await db.collection('links_publicos').findOne(filtro);
  if (!link) {
    link = Object.assign({ token: crypto.randomBytes(24).toString('hex'), createdAt: new Date(), creadoPor: 'envío automático' }, filtro);
    await db.collection('links_publicos').insertOne(link);
  }
  return link.token;
}

async function datosDestino(db, clienteId) {
  if (!clienteId) return null;
  const cli = await db.collection('clientes').findOne({ _id: clienteId });
  if (!cli || cli.noEnviarMails) return null;
  const para = mailsValidos(cli.email);
  if (!para.length) return null;
  return { cli, para };
}
async function nombreOrg(db, orgId) {
  const org = orgId ? await db.collection('organizaciones').findOne({ _id: orgId }) : null;
  return (org && (org.razonSocial || org.nombre)) || 'Piedra Negra';
}
async function registrar(db, datos) {
  try { await db.collection('correos_enviados').insertOne(Object.assign({ createdAt: new Date() }, datos)); } catch (e) { /* el registro es secundario */ }
}
async function activo(db) { const c = await getConfig(db); return !!(c.activo !== false && (c.refreshToken || envioOverride)); }

const TITULO = { fiscal: 'Factura', comprobante_x: 'Comprobante', nota_credito: 'Nota de crédito', nota_debito: 'Nota de débito' };

// Mail con el comprobante de una venta / nota de crédito / nota de débito. Una factura fiscal solo sale una vez que tiene CAE.
async function notificarVenta(db, ventaId, baseUrl) {
  try {
    if (!(await activo(db))) return null;
    const v = await db.collection('ventas').findOne({ _id: ventaId });
    if (!v || v.estado === 'anulada' || v.importado) return null;
    if (v.mailEnviadoEn) return null; // ya salió (por ejemplo, antes del reintento de ARCA)
    if (v.esFiscal && !v.cae) return null;
    const dest = await datosDestino(db, v.clienteId);
    if (!dest) return null;
    const orgNombre = await nombreOrg(db, v.orgId);
    const tipo = TITULO[v.tipoComprobante] || 'Comprobante';
    const numero = v.esFiscal && v.numeroFiscal ? `${String(v.puntoVenta || '').padStart(4, '0')}-${String(v.numeroFiscal).padStart(8, '0')}` : `${v.letra && v.tipoComprobante !== 'comprobante_x' ? v.letra + '-' : ''}${String(v.numero).padStart(5, '0')}`;
    const token = await crearLink(db, 'comprobante', v._id, null, v.orgId);
    const url = baseUrl + '/d/' + token;
    const esNC = v.tipoComprobante === 'nota_credito';
    const html = plantilla({
      orgNombre, titulo: `${tipo} ${numero}`, saludo: `Hola ${dest.cli.nombre || dest.cli.apellidoRazonSocial || ''},`.replace(' ,', ','),
      lineas: [
        esNC ? `Emitimos a tu favor la ${tipo.toLowerCase()} <b>${esc(numero)}</b> por <b>${esc(money(v.total, v.moneda))}</b>.` : `Te enviamos el ${tipo.toLowerCase()} <b>${esc(numero)}</b> por <b>${esc(money(v.total, v.moneda))}</b>.`
      ],
      boton: 'Ver comprobante', url
    });
    const asunto = `${tipo} ${numero} — ${orgNombre}`;
    try {
      await enviarMail(db, { para: dest.para, asunto, html });
      await db.collection('ventas').updateOne({ _id: v._id }, { $set: { mailEnviadoA: dest.para.join(', '), mailEnviadoEn: new Date() }, $unset: { mailError: '' } });
      await registrar(db, { orgId: v.orgId, clienteId: v.clienteId, para: dest.para, asunto, tipo: 'comprobante', docId: v._id, estado: 'enviado' });
    } catch (e) {
      await db.collection('ventas').updateOne({ _id: v._id }, { $set: { mailError: String(e.message || e).slice(0, 300) } });
      await registrar(db, { orgId: v.orgId, clienteId: v.clienteId, para: dest.para, asunto, tipo: 'comprobante', docId: v._id, estado: 'error', error: String(e.message || e).slice(0, 300) });
    }
  } catch (e) { console.error('Correo (comprobante):', e.message); }
  return null;
}

// Mail con el recibo de un cobro registrado sobre una venta (index = posición del pago en venta.pagos; si es un recibo con varios medios, el primero).
async function notificarRecibo(db, ventaId, index, baseUrl) {
  try {
    if (!(await activo(db))) return null;
    const v = await db.collection('ventas').findOne({ _id: ventaId });
    if (!v || !v.pagos || !v.pagos[index]) return null;
    const dest = await datosDestino(db, v.clienteId);
    if (!dest) return null;
    const pago = v.pagos[index];
    const grupo = pago.reciboGrupo ? v.pagos.filter(p => p.reciboGrupo === pago.reciboGrupo && !p.anulado) : [pago];
    const monto = grupo.reduce((s, p) => s + (Number(p.monto) || 0) + (Number(p.totalRetenciones) || 0), 0);
    const orgNombre = await nombreOrg(db, v.orgId);
    const token = await crearLink(db, 'recibo', v._id, index, v.orgId);
    const url = baseUrl + '/d/' + token;
    const comp = `${TITULO[v.tipoComprobante] || 'Comprobante'} ${v.numeroOriginal || ((v.letra && v.tipoComprobante !== 'comprobante_x' ? v.letra + '-' : '') + String(v.numero).padStart(5, '0'))}`;
    const html = plantilla({
      orgNombre, titulo: 'Recibo de pago', saludo: `Hola ${dest.cli.nombre || dest.cli.apellidoRazonSocial || ''},`.replace(' ,', ','),
      lineas: [`Registramos tu pago de <b>${esc(money(monto, v.moneda))}</b> correspondiente al ${esc(comp)}.`, (v.saldoPendiente > 0.005) ? `Saldo pendiente de este comprobante: <b>${esc(money(v.saldoPendiente, v.moneda))}</b>.` : '¡Quedó cancelado! Muchas gracias.'],
      boton: 'Ver recibo', url
    });
    const asunto = `Recibo de pago — ${orgNombre}`;
    try {
      await enviarMail(db, { para: dest.para, asunto, html });
      await registrar(db, { orgId: v.orgId, clienteId: v.clienteId, para: dest.para, asunto, tipo: 'recibo', docId: v._id, estado: 'enviado' });
    } catch (e) {
      await registrar(db, { orgId: v.orgId, clienteId: v.clienteId, para: dest.para, asunto, tipo: 'recibo', docId: v._id, estado: 'error', error: String(e.message || e).slice(0, 300) });
    }
  } catch (e) { console.error('Correo (recibo):', e.message); }
  return null;
}

// Mail por una cobranza a cuenta (sin comprobante puntual): confirma el pago recibido, sin link.
async function notificarCobroCuenta(db, { orgId, clienteId, monto, moneda, fecha }) {
  try {
    if (!(await activo(db))) return null;
    const dest = await datosDestino(db, clienteId);
    if (!dest) return null;
    const orgNombre = await nombreOrg(db, orgId);
    const f = fecha ? new Date(fecha) : new Date();
    const html = plantilla({
      orgNombre, titulo: 'Pago recibido', saludo: `Hola ${dest.cli.nombre || dest.cli.apellidoRazonSocial || ''},`.replace(' ,', ','),
      lineas: [`Registramos tu pago a cuenta de <b>${esc(money(monto, moneda))}</b> (${esc(f.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }))}). ¡Gracias!`]
    });
    const asunto = `Pago recibido — ${orgNombre}`;
    try {
      await enviarMail(db, { para: dest.para, asunto, html });
      await registrar(db, { orgId, clienteId, para: dest.para, asunto, tipo: 'cobro_cuenta', estado: 'enviado' });
    } catch (e) {
      await registrar(db, { orgId, clienteId, para: dest.para, asunto, tipo: 'cobro_cuenta', estado: 'error', error: String(e.message || e).slice(0, 300) });
    }
  } catch (e) { console.error('Correo (cobro a cuenta):', e.message); }
  return null;
}

// Atajos "dispará y seguí": no esperan ni propagan errores.
router.enviarComprobante = (ventaId, baseUrl) => { getDb().then(db => notificarVenta(db, ventaId, baseUrl)).catch(e => console.error('Correo:', e.message)); };
router.enviarRecibo = (ventaId, index, baseUrl) => { getDb().then(db => notificarRecibo(db, ventaId, index, baseUrl)).catch(e => console.error('Correo:', e.message)); };
router.enviarCobroCuenta = datos => { getDb().then(db => notificarCobroCuenta(db, datos)).catch(e => console.error('Correo:', e.message)); };
router.notificarVenta = notificarVenta;
router.notificarRecibo = notificarRecibo;

// ----------------------------- Rutas de configuración ------------------------------------
function soloAdmin(req) { if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) throw err(403, 'Solo un administrador puede configurar el correo.'); }

router.get('/estado', authAdmin, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb(); const c = await getConfig(db);
      const [enviados, errores] = await Promise.all([
        db.collection('correos_enviados').countDocuments({ estado: 'enviado' }),
        db.collection('correos_enviados').find({ estado: 'error' }).sort({ createdAt: -1 }).limit(5).toArray()
      ]);
      return { oauthConfigurado: oauthListo(), conectado: !!c.refreshToken, email: c.email || '', nombreRemitente: c.nombreRemitente || '', activo: c.activo !== false, redirectUri: redirectUriDe(req), enviados, ultimosErrores: errores.map(e => ({ fecha: e.createdAt, para: e.para, asunto: e.asunto, error: e.error })) };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/google/url', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    if (!oauthListo()) throw err(400, 'Faltan GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET en Render → Environment.');
    const state = crypto.randomBytes(16).toString('hex');
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('correo_config').updateOne({ _id: 'global' }, { $set: { oauthState: state, oauthStateExp: new Date(Date.now() + 10 * 60000) } }, { upsert: true });
    });
    const url = oauthClient(redirectUriDe(req)).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
    res.json({ url });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Sin sesión: Google vuelve acá. La validez del pedido la da el `state` guardado al iniciar.
router.get('/google/callback', async (req, res) => {
  const volver = msg => res.redirect('/admin-correo.html' + msg);
  try {
    const { code, state, error } = req.query;
    if (error) return volver('?error=' + encodeURIComponent(String(error)));
    const db = await getDb();
    const c = await getConfig(db);
    if (!state || !c.oauthState || state !== c.oauthState || !c.oauthStateExp || new Date(c.oauthStateExp) < new Date()) return volver('?error=' + encodeURIComponent('El pedido venció. Probá conectar de nuevo.'));
    const cli = oauthClient(redirectUriDe(req));
    const { tokens } = await cli.getToken(String(code));
    if (!tokens.refresh_token) return volver('?error=' + encodeURIComponent('Google no devolvió el permiso permanente. Revocá el acceso de la app en tu cuenta de Google y probá de nuevo.'));
    cli.setCredentials(tokens);
    const { google } = require('googleapis');
    const info = await google.oauth2({ version: 'v2', auth: cli }).userinfo.get();
    await db.collection('correo_config').updateOne({ _id: 'global' }, {
      $set: { refreshToken: tokens.refresh_token, email: (info.data && info.data.email) || '', activo: true, conectadoEn: new Date() },
      $unset: { oauthState: '', oauthStateExp: '' }
    }, { upsert: true });
    volver('?conectado=1');
  } catch (e) { volver('?error=' + encodeURIComponent(String(e.message || e).slice(0, 200))); }
});

router.post('/configurar', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    const b = req.body || {};
    const set = {};
    if (b.activo !== undefined) set.activo = !!b.activo;
    if (b.nombreRemitente !== undefined) set.nombreRemitente = String(b.nombreRemitente).trim().slice(0, 80);
    await conReintento(async () => { const db = await getDb(); await db.collection('correo_config').updateOne({ _id: 'global' }, { $set: set }, { upsert: true }); });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/desconectar', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    await conReintento(async () => { const db = await getDb(); await db.collection('correo_config').updateOne({ _id: 'global' }, { $unset: { refreshToken: '', email: '', conectadoEn: '' }, $set: { activo: false } }, { upsert: true }); });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/prueba', authAdmin, async (req, res) => {
  try {
    soloAdmin(req);
    const db = await getDb(); const c = await getConfig(db);
    const para = mailsValidos(req.body && req.body.para).length ? mailsValidos(req.body.para) : mailsValidos(c.email);
    if (!para.length) throw err(400, 'Indicá un mail de destino.');
    const orgNombre = await nombreOrg(db, req.orgId);
    await enviarMail(db, { para, asunto: 'Prueba de correo — ' + orgNombre, html: plantilla({ orgNombre, titulo: 'Prueba de correo', saludo: 'Hola,', lineas: ['Este es un mail de prueba del sistema. Si lo recibiste, el envío automático a clientes está funcionando.'] }) });
    res.json({ ok: true, para });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
