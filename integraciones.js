// ---------------------------------------------------------------------------
// Panel de Integraciones (16/10/2026, pedido de Mato): un solo lugar (Configuración → Integraciones) que muestra todas las conexiones
// externas del sistema — cuáles están activas, cuáles faltan y qué variable o pantalla hay que tocar para conectarlas.
//
// Para AGREGAR una integración futura: sumar un objeto a INTEGRACIONES (abajo) con { clave, nombre, descripcion, vars, estado(db) , enlace }.
// `vars` son los NOMBRES de las variables de entorno de Render que usa (nunca se devuelve el valor, solo si está cargada o no).
// `estado(db)` devuelve { estado: 'ok' | 'falta' | 'parcial', detalle, items? } — `items` es el detalle por sucursal, si aplica.
// Solo lectura y solo para administradores.
// ---------------------------------------------------------------------------
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';
let mongoClient, mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    if (!mongoConectando) {
      const nuevo = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevo.connect().then(() => { mongoClient = nuevo; mongoConectando = null; }, e => { mongoConectando = null; throw e; });
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}
const hay = n => !!process.env[n];

async function porSucursal(db, coleccion, listo) {
  const orgs = await db.collection('organizaciones').find({}).project({ nombre: 1 }).sort({ nombre: 1 }).toArray();
  const cfgs = await db.collection(coleccion).find({}).toArray();
  const items = orgs.map(o => {
    const c = cfgs.find(x => String(x.orgId) === String(o._id));
    const r = listo(c);
    return { nombre: o.nombre, ok: r === null, detalle: r || 'Conectada' };
  });
  const oks = items.filter(i => i.ok).length;
  return { estado: oks === items.length && items.length ? 'ok' : (oks ? 'parcial' : 'falta'), detalle: `${oks} de ${items.length} sucursales conectadas`, items };
}

const INTEGRACIONES = [
  {
    clave: 'gmail', nombre: 'Gmail (mails a clientes)', descripcion: 'Envía por mail los comprobantes y recibos a los clientes.',
    vars: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'], enlace: '/admin-correo.html', enlaceTexto: 'Abrir configuración de correo',
    estado: async db => {
      if (!(hay('GOOGLE_OAUTH_CLIENT_ID') && hay('GOOGLE_OAUTH_CLIENT_SECRET'))) return { estado: 'falta', detalle: 'Faltan las credenciales de Google en Render.' };
      const c = await db.collection('correo_config').findOne({ _id: 'global' });
      if (!c || !c.refreshToken) return { estado: 'parcial', detalle: 'Credenciales cargadas, falta conectar la cuenta de Gmail.' };
      return { estado: c.activo === false ? 'parcial' : 'ok', detalle: c.activo === false ? 'Conectado pero el envío automático está desactivado.' : 'Conectado como ' + (c.email || 'cuenta de Gmail') + '.' };
    }
  },
  {
    clave: 'cloudinary', nombre: 'Cloudinary (fotos de obras)', descripcion: 'Guarda las fotos fuera de la base de datos para no ocupar espacio.',
    vars: ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'],
    estado: async () => {
      const n = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].filter(hay).length;
      return n === 3 ? { estado: 'ok', detalle: 'Las fotos nuevas se suben a Cloudinary.' } : { estado: n ? 'parcial' : 'falta', detalle: n ? 'Faltan variables en Render.' : 'Sin configurar: las fotos se guardan dentro de la base.' };
    }
  },
  {
    clave: 'arca', nombre: 'ARCA (facturación electrónica)', descripcion: 'Certificado y punto de venta de cada sucursal para emitir facturas con CAE.',
    vars: ['ARCA_SECRETO'], enlace: '/admin-fiscal.html', enlaceTexto: 'Abrir Puntos de venta y ARCA',
    estado: db => porSucursal(db, 'arca_config', c => !c ? 'Sin configurar' : (!(c.certPem && c.keyEnc) && !c.certOrigenOrgId) ? 'Falta el certificado' : !c.puntoVenta ? 'Falta el punto de venta' : null)
  },
  {
    clave: 'mercadopago', nombre: 'Mercado Pago (links de pago y Point)', descripcion: 'Cobros con link y con terminal Point, por sucursal.',
    vars: [], enlace: '/admin-mercadopago.html', enlaceTexto: 'Abrir Mercado Pago',
    estado: db => porSucursal(db, 'mp_config', c => !c || !c.accessToken ? 'Falta el access token' : !c.bancoId ? 'Falta elegir el banco de Tesorería' : null)
  },
  {
    clave: 'calendar', nombre: 'Google Calendar', descripcion: 'Eventos de obras, visitas y recordatorios en el calendario.',
    vars: ['GOOGLE_SERVICE_ACCOUNT_KEY'],
    estado: async () => hay('GOOGLE_SERVICE_ACCOUNT_KEY') ? { estado: 'ok', detalle: 'Cuenta de servicio configurada.' } : { estado: 'falta', detalle: 'Falta la cuenta de servicio de Google.' }
  },
  {
    clave: 'tiendanube', nombre: 'Tiendanube', descripcion: 'Vinculación de productos con la tienda online para precios y stock.',
    vars: ['TIENDA_REAL_STORE_ID'], enlace: '/admin-tiendanube.html', enlaceTexto: 'Abrir Tiendanube',
    estado: async () => hay('TIENDA_REAL_STORE_ID') ? { estado: 'ok', detalle: 'Tienda configurada.' } : { estado: 'falta', detalle: 'Falta TIENDA_REAL_STORE_ID.' }
  },
  {
    clave: 'ia', nombre: 'Inteligencia artificial (lectura de documentos)', descripcion: 'Lee facturas y cotizaciones con IA.',
    vars: ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY'],
    estado: async () => (hay('GEMINI_API_KEY') || hay('ANTHROPIC_API_KEY')) ? { estado: 'ok', detalle: 'Hay una clave de IA cargada.' } : { estado: 'falta', detalle: 'Falta cargar GEMINI_API_KEY o ANTHROPIC_API_KEY.' }
  }
];

router.get('/estado', authUsuario, async (req, res) => {
  try {
    if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) return res.status(403).json({ error: 'Solo un administrador puede ver las integraciones.' });
    const db = await getDb();
    const out = [];
    for (const i of INTEGRACIONES) {
      let e;
      try { e = await i.estado(db); } catch (err) { e = { estado: 'falta', detalle: 'No se pudo verificar: ' + err.message }; }
      out.push(Object.assign({ clave: i.clave, nombre: i.nombre, descripcion: i.descripcion, enlace: i.enlace || '', enlaceTexto: i.enlaceTexto || '',
        vars: (i.vars || []).map(v => ({ nombre: v, cargada: hay(v) })) }, e));
    }
    res.json({ integraciones: out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
