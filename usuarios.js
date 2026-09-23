// --------------------------------------------------------------------------
// Usuarios y roles — control de acceso configurable para el personal de
// oficina/administración.
//
// Reemplaza la contraseña única compartida (OBRAS_ADMIN_PASSWORD) que hasta
// ahora usaban por igual obras.js y visitas.js, por usuarios con nombre de
// usuario y contraseña propios, cada uno con un rol asignado. Un rol es
// simplemente una lista de "módulos" habilitados (ver MODULOS acá abajo) —
// el panel de Usuarios (public/admin-usuarios.html) permite crear los roles
// que hagan falta y tildar a qué módulos entra cada uno.
//
// Vendedores y colocadores NO pasan por acá — siguen como estaban (el
// vendedor se elige de una lista, el colocador entra con su PIN), decisión
// tomada explícitamente al armar esto: son flujos rápidos desde el celular
// en obra, no personal de oficina.
//
// Colecciones nuevas:
//   - usuarios : { nombre, usuario (login, único, en minúsculas), passwordHash,
//                  rolId, activo, createdAt, updatedAt }
//   - roles    : { nombre, modulos: [String], protegido (bool), createdAt,
//                  updatedAt }
//
// MÓDULOS: registro único acá abajo (MODULOS). Agregar un módulo nuevo más
// adelante es: (1) sumar una entrada acá, (2) usar requiereModulo('esaClave')
// en las rutas de ese módulo nuevo. El rol "Administrador" (protegido) tiene
// SIEMPRE todos los módulos, incluidos los que se agreguen a futuro, sin
// tener que volver a tocarlo — así no hace falta migrar nada cada vez que
// se suma un módulo.
//
// Nota sobre "Calendario": no es un módulo propio acá — /calendario.html
// combina datos de Visitas y de Obras (llama a endpoints de los dos), así
// que un rol necesita AMBOS módulos para verlo completo. No tendría sentido
// un módulo "calendario" separado mientras no tenga sus propios endpoints.
//
// Migración: en el primer login (si todavía no existe ningún usuario), se
// crea automáticamente el rol "Administrador" (protegido) y un usuario
// "admin" con la contraseña que ya tenía OBRAS_ADMIN_PASSWORD — así nadie
// queda afuera al desplegar esto. Desde ahí ese usuario puede crear el
// resto del personal con su propio usuario y contraseña, y renombrar o
// desactivar "admin" si quiere (el sistema no deja desactivar/borrar al
// último usuario activo que administra usuarios y roles).
// --------------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const router = express.Router();

const DB_NAME = 'calculadora_m2';

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (e) {
      mongoClient = null;
      throw e;
    }
  }
  return mongoClient.db(DB_NAME);
}
async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    mongoClient = null; // fuerza reconexión, mismo patrón que el resto de la app
    return await fn();
  }
}
function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------------------------------------------------------------------
// Módulos
// ---------------------------------------------------------------------
const MODULOS = [
  { key: 'visitas', label: 'Visitas', descripcion: 'Alta de visitas, presupuestos, confirmar obra, reportes de embudo.' },
  { key: 'obras', label: 'Obras', descripcion: 'Asignar colocador, seguimiento de tareas, reportes de m² y pago.' },
  { key: 'usuarios', label: 'Usuarios y roles', descripcion: 'Crear usuarios y roles, y elegir a qué módulos entra cada uno. Dárselo con cuidado.' }
];
const MODULOS_KEYS = MODULOS.map(m => m.key);

// ---------------------------------------------------------------------
// Contraseñas — scrypt con salt propio por usuario, sin dependencias nuevas.
// ---------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verificarPassword(password, almacenado) {
  if (!almacenado || typeof almacenado !== 'string' || !almacenado.includes(':')) return false;
  const [salt, hash] = almacenado.split(':');
  let hashIntentado;
  try { hashIntentado = crypto.scryptSync(String(password), salt, 64).toString('hex'); }
  catch (e) { return false; }
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashIntentado, 'hex')); }
  catch (e) { return false; }
}

// ---------------------------------------------------------------------
// Sesión — mismo esquema (payload + firma HMAC, en base64) que ya usa
// obras.js para el token del colocador, con un "namespace" propio en la
// firma para que un token de usuario nunca valide como token de colocador
// ni viceversa aunque compartan el mismo OBRAS_TOKEN_SECRET.
// ---------------------------------------------------------------------
function hmac(data) {
  const secret = process.env.OBRAS_TOKEN_SECRET || 'cambiar-este-secreto';
  return crypto.createHmac('sha256', secret).update('usuario.' + data).digest('hex');
}
function crearToken(usuarioId) {
  const payload = `${usuarioId}.${Date.now()}`;
  return Buffer.from(payload).toString('base64') + '.' + hmac(payload);
}
function verificarToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payloadB64 = token.slice(0, idx);
  const firma = token.slice(idx + 1);
  let payload;
  try { payload = Buffer.from(payloadB64, 'base64').toString('utf8'); } catch (e) { return null; }
  if (hmac(payload) !== firma) return null;
  const [usuarioId, issuedAtStr] = payload.split('.');
  const issuedAt = Number(issuedAtStr);
  if (!usuarioId || !issuedAt) return null;
  const CIENTO_OCHENTA_DIAS_MS = 180 * 24 * 60 * 60 * 1000;
  if (Date.now() - issuedAt > CIENTO_OCHENTA_DIAS_MS) return null; // token vencido
  return usuarioId;
}

// ---------------------------------------------------------------------
// Bootstrap perezoso: si no hay ningún usuario cargado todavía, crea el rol
// Administrador y (si OBRAS_ADMIN_PASSWORD está configurada) un usuario
// "admin" con esa misma contraseña, para no dejar a nadie afuera la
// primera vez que corre este código.
// ---------------------------------------------------------------------
async function asegurarBootstrap(db) {
  const hayUsuarios = await db.collection('usuarios').countDocuments({}, { limit: 1 });
  if (hayUsuarios) return;

  let rolAdmin = await db.collection('roles').findOne({ protegido: true });
  if (!rolAdmin) {
    const r = await db.collection('roles').insertOne({
      nombre: 'Administrador',
      modulos: MODULOS_KEYS, // informativo nomás — protegido ya implica TODOS, incluidos los futuros
      protegido: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    rolAdmin = { _id: r.insertedId };
  }

  const passInicial = process.env.OBRAS_ADMIN_PASSWORD;
  if (!passInicial) return; // sin contraseña vieja que migrar, no hay con qué crear el usuario inicial
  await db.collection('usuarios').insertOne({
    nombre: 'Administrador',
    usuario: 'admin',
    passwordHash: hashPassword(passInicial),
    rolId: rolAdmin._id,
    activo: true,
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

async function usuarioConRol(db, usuarioId) {
  const usuario = await db.collection('usuarios').findOne({ _id: toObjectId(usuarioId) });
  if (!usuario) return null;
  const rol = await db.collection('roles').findOne({ _id: usuario.rolId });
  return { usuario, rol };
}

// req.usuario = { _id, nombre, usuario, rol: { _id, nombre, modulos, protegido } }
async function authUsuario(req, res, next) {
  try {
    const token = req.headers['x-admin-token'];
    const usuarioId = verificarToken(token);
    if (!usuarioId) return res.status(401).json({ error: 'Sesión inválida o vencida, iniciá sesión de nuevo' });
    const db = await getDb();
    const datos = await conReintento(() => usuarioConRol(db, usuarioId));
    if (!datos || !datos.usuario.activo) return res.status(401).json({ error: 'Usuario inactivo o inexistente' });
    if (!datos.rol) return res.status(401).json({ error: 'Este usuario no tiene un rol asignado — pedile a un administrador que le asigne uno' });
    req.usuario = {
      _id: datos.usuario._id,
      nombre: datos.usuario.nombre,
      usuario: datos.usuario.usuario,
      rol: { _id: datos.rol._id, nombre: datos.rol.nombre, modulos: datos.rol.modulos || [], protegido: !!datos.rol.protegido }
    };
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function tieneModulo(usuario, moduloKey) {
  return !!(usuario && usuario.rol && (usuario.rol.protegido || (usuario.rol.modulos || []).includes(moduloKey)));
}

function requiereModulo(moduloKey) {
  return (req, res, next) => {
    if (!tieneModulo(req.usuario, moduloKey)) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso a este módulo. Pedile a un administrador que te lo habilite.' });
    }
    next();
  };
}

// Cuántos usuarios ACTIVOS (además de excluirId, si se pasa) tienen acceso
// al módulo "usuarios" — para no dejar la app sin nadie que pueda
// administrar usuarios y roles.
async function usuariosConAccesoAUsuarios(db, excluirUsuarioId) {
  const rolesConAcceso = await db.collection('roles')
    .find({ $or: [{ protegido: true }, { modulos: 'usuarios' }] }, { projection: { _id: 1 } })
    .toArray();
  const idsRoles = rolesConAcceso.map(r => r._id);
  const filtro = { activo: true, rolId: { $in: idsRoles } };
  if (excluirUsuarioId) filtro._id = { $ne: excluirUsuarioId };
  return db.collection('usuarios').countDocuments(filtro);
}

// ---------------------------------------------------------------------
// LOGIN — reemplaza a los /login de obras.js y visitas.js (que quedaban
// duplicados y compartían la misma contraseña única para cualquiera). El
// token que devuelve sirve para /api/obras, /api/visitas y acá mismo —
// mismo header x-admin-token y misma clave de localStorage
// ("obras_admin_token") que ya usaban los tres paneles, así no hace falta
// tocar esa parte del resto del frontend.
// ---------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { usuario, password } = req.body || {};
    if (!usuario || !password) throw err(400, 'Ingresá usuario y contraseña');
    const db = await getDb();
    await conReintento(() => asegurarBootstrap(db));
    const doc = await conReintento(() => db.collection('usuarios').findOne({ usuario: String(usuario).trim().toLowerCase() }));
    if (!doc || !doc.activo || !verificarPassword(password, doc.passwordHash)) {
      throw err(401, 'Usuario o contraseña incorrectos');
    }
    res.json({ ok: true, token: crearToken(doc._id.toString()) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Quién soy — para que cada panel sepa de entrada (sin tener que adivinar
// por un código de error) si el usuario logueado tiene el módulo que ese
// panel necesita, y para pintar su nombre.
router.get('/me', authUsuario, (req, res) => {
  res.json({ usuario: { nombre: req.usuario.nombre, usuario: req.usuario.usuario }, rol: req.usuario.rol, modulos: MODULOS });
});

const authAdmin = [authUsuario, requiereModulo('usuarios')];

// ---------------------------------------------------------------------
// ROLES
// ---------------------------------------------------------------------
router.get('/roles', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => (await getDb()).collection('roles').find({}).sort({ nombre: 1 }).toArray());
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/roles', authAdmin, async (req, res) => {
  try {
    const { nombre, modulos } = req.body || {};
    if (!nombre || !String(nombre).trim()) throw err(400, 'El rol necesita un nombre');
    const modulosValidos = Array.isArray(modulos) ? modulos.filter(m => MODULOS_KEYS.includes(m)) : [];
    const doc = { nombre: String(nombre).trim(), modulos: modulosValidos, protegido: false, createdAt: new Date(), updatedAt: new Date() };
    const r = await conReintento(async () => (await getDb()).collection('roles').insertOne(doc));
    doc._id = r.insertedId;
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/roles/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { nombre, modulos } = req.body || {};
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('roles').findOne({ _id: id });
      if (!actual) throw err(404, 'Rol no encontrado');
      if (actual.protegido) throw err(400, 'El rol Administrador no se puede editar — siempre tiene acceso a todos los módulos.');

      const set = { updatedAt: new Date() };
      if (nombre !== undefined) {
        if (!String(nombre).trim()) throw err(400, 'El rol necesita un nombre');
        set.nombre = String(nombre).trim();
      }
      if (modulos !== undefined) {
        const modulosNuevos = Array.isArray(modulos) ? modulos.filter(m => MODULOS_KEYS.includes(m)) : [];
        // Salvaguarda: si este rol le daba acceso a "usuarios" y se lo van
        // a sacar, verificar que quede al menos otro usuario activo (de
        // otro rol) que lo tenga — si no, nadie va a poder volver a entrar
        // acá para arreglarlo.
        if ((actual.modulos || []).includes('usuarios') && !modulosNuevos.includes('usuarios')) {
          const rolesConAcceso = await db.collection('roles')
            .find({ _id: { $ne: id }, $or: [{ protegido: true }, { modulos: 'usuarios' }] }, { projection: { _id: 1 } })
            .toArray();
          const idsRoles = rolesConAcceso.map(r => r._id);
          const otrosConAcceso = await db.collection('usuarios').countDocuments({ activo: true, rolId: { $in: idsRoles } });
          if (!otrosConAcceso) {
            throw err(400, 'No se le puede sacar "Usuarios y roles" a este rol: ningún otro usuario activo lo tendría. Asignaselo a otro rol o usuario antes de sacárselo a este.');
          }
        }
        set.modulos = modulosNuevos;
      }
      await db.collection('roles').updateOne({ _id: id }, { $set: set });
      return db.collection('roles').findOne({ _id: id });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/roles/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const rol = await db.collection('roles').findOne({ _id: id });
      if (!rol) throw err(404, 'Rol no encontrado');
      if (rol.protegido) throw err(400, 'El rol Administrador no se puede borrar.');
      const enUso = await db.collection('usuarios').countDocuments({ rolId: id });
      if (enUso) throw err(400, `Hay ${enUso} usuario(s) con este rol — reasignalos a otro rol antes de borrarlo.`);
      await db.collection('roles').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------
// USUARIOS
// ---------------------------------------------------------------------
router.get('/', authAdmin, async (req, res) => {
  try {
    const [usuarios, roles] = await conReintento(async () => {
      const db = await getDb();
      return Promise.all([
        db.collection('usuarios').find({}).sort({ nombre: 1 }).project({ passwordHash: 0 }).toArray(),
        db.collection('roles').find({}).toArray()
      ]);
    });
    const rolesPorId = {};
    roles.forEach(r => { rolesPorId[r._id.toString()] = r; });
    const listaConRol = usuarios.map(u => Object.assign({}, u, {
      rolNombre: (rolesPorId[u.rolId && u.rolId.toString()] || {}).nombre || '(sin rol)'
    }));
    res.json(listaConRol);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    const { nombre, usuario, password, rolId } = req.body || {};
    if (!nombre || !usuario || !password || !rolId) throw err(400, 'Nombre, usuario, contraseña y rol son obligatorios');
    if (String(password).length < 6) throw err(400, 'La contraseña tiene que tener al menos 6 caracteres');
    const rId = toObjectId(rolId);
    if (!rId) throw err(400, 'Rol inválido');
    const usuarioNorm = String(usuario).trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(usuarioNorm)) {
      throw err(400, 'El usuario solo puede tener letras, números, puntos, guiones y guiones bajos (mínimo 3 caracteres)');
    }

    const doc = await conReintento(async () => {
      const db = await getDb();
      const rol = await db.collection('roles').findOne({ _id: rId });
      if (!rol) throw err(400, 'Rol no encontrado');
      const existente = await db.collection('usuarios').findOne({ usuario: usuarioNorm });
      if (existente) throw err(400, 'Ya existe un usuario con ese nombre de usuario');
      const nuevo = {
        nombre: String(nombre).trim(),
        usuario: usuarioNorm,
        passwordHash: hashPassword(password),
        rolId: rId,
        activo: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      const r = await db.collection('usuarios').insertOne(nuevo);
      nuevo._id = r.insertedId;
      delete nuevo.passwordHash;
      return nuevo;
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const { nombre, rolId, activo, password } = req.body || {};
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const actual = await db.collection('usuarios').findOne({ _id: id });
      if (!actual) throw err(404, 'Usuario no encontrado');

      const set = { updatedAt: new Date() };
      if (nombre !== undefined) {
        if (!String(nombre).trim()) throw err(400, 'El nombre no puede quedar vacío');
        set.nombre = String(nombre).trim();
      }

      let nuevoRolId = actual.rolId;
      if (rolId !== undefined) {
        nuevoRolId = toObjectId(rolId);
        if (!nuevoRolId) throw err(400, 'Rol inválido');
        const rol = await db.collection('roles').findOne({ _id: nuevoRolId });
        if (!rol) throw err(400, 'Rol no encontrado');
        set.rolId = nuevoRolId;
      }

      const nuevoActivo = activo !== undefined ? !!activo : actual.activo;
      if (activo !== undefined) set.activo = nuevoActivo;

      if (password !== undefined && password !== '') {
        if (String(password).length < 6) throw err(400, 'La contraseña tiene que tener al menos 6 caracteres');
        set.passwordHash = hashPassword(password);
      }

      // Salvaguarda: no dejar la app sin nadie activo que pueda administrar
      // usuarios y roles (ej. desactivar o cambiarle el rol al último
      // usuario con el módulo "usuarios" habilitado).
      if (activo !== undefined || rolId !== undefined) {
        const rolFinal = await db.collection('roles').findOne({ _id: nuevoRolId });
        const tendriaAcceso = nuevoActivo && rolFinal && (rolFinal.protegido || (rolFinal.modulos || []).includes('usuarios'));
        if (!tendriaAcceso) {
          const quedanOtros = await usuariosConAccesoAUsuarios(db, id);
          if (!quedanOtros) throw err(400, 'No se puede dejar la app sin ningún usuario activo que administre usuarios y roles.');
        }
      }

      await db.collection('usuarios').updateOne({ _id: id }, { $set: set });
      return db.collection('usuarios').findOne({ _id: id }, { projection: { passwordHash: 0 } });
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const usuario = await db.collection('usuarios').findOne({ _id: id });
      if (!usuario) throw err(404, 'Usuario no encontrado');
      const rol = await db.collection('roles').findOne({ _id: usuario.rolId });
      const teniaAcceso = usuario.activo && rol && (rol.protegido || (rol.modulos || []).includes('usuarios'));
      if (teniaAcceso) {
        const quedanOtros = await usuariosConAccesoAUsuarios(db, id);
        if (!quedanOtros) throw err(400, 'No se puede borrar: es el único usuario activo que administra usuarios y roles.');
      }
      await db.collection('usuarios').deleteOne({ _id: id });
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.authUsuario = authUsuario;
module.exports.requiereModulo = requiereModulo;
module.exports.MODULOS = MODULOS;
