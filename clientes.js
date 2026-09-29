// ---------------------------------------------------------------------------
// Clientes — registro maestro de clientes (siguiente paso de migrar todo lo
// que hoy se lleva en Dux a este sistema, decisión con Mato, 28/9/2026).
//
// Mismo criterio que Productos: los campos se alinean a propósito con los
// mismos que usa Dux al crear un cliente (relevado de "Crea y gestiona tus
// clientes" en su ayuda oficial), para que cargar lo que ya existe en Dux
// sea directo — de ahí en más se sacan o agregan campos según haga falta.
//
// Campo obligatorio, igual que en Dux: `apellidoRazonSocial` y
// `categoriaFiscal`. Todo lo demás es opcional, también igual que en Dux
// (a diferencia de Productos, donde el SKU/Código si es obligatorio acá
// porque así lo pidió Mato).
//
// PENDIENTE DE DECISIÓN (ver roadmap-modulos.md, "Entidades compartidas"):
// Visitas y CRM (oportunidades) siguen teniendo su propio bloque de texto
// suelto de cliente — todavía no se migraron a apuntar acá con un
// `clienteId`. Este módulo es el punto de partida para esa entidad
// compartida, pero la migración de Visitas/CRM es un paso aparte, a
// propósito no incluido en esta primera versión.
//
// Colección nueva (en la misma base `calculadora_m2`):
//   clientes : { codigo, apellidoRazonSocial, nombre, nombreFantasia, sexo,
//     tipoCliente, origenCliente, fechaNacimiento, noEditable,
//     limiteCtaCteFacturacion, limiteCtaCtePedido, categoriaFiscal,
//     tipoDocumento, numeroDocumento, cuit, listaPrecioPorDefecto,
//     condicionPago, porcentajeDescuento, vendedor,
//     tipoComprobantePorDefecto, transporteEntregaPorDefecto,
//     lugarEntregaPorDefecto, provincia, localidad, domicilio, barrio,
//     codigoPostal, zona, telefono, fax, companiaCelular, celular,
//     personaContacto, email, paginaWeb, observaciones, descripcion,
//     notas, activo, orgId, createdAt, updatedAt }
//
// Módulo con clave propia ('clientes'), datos separados por organización
// (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto de la app).
//
// Integración (en server.js):
//   const clientesRouter = require('./clientes');
//   app.use('/api/clientes', clientesRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');

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
    mongoClient = null;
    return await fn();
  }
}

function toObjectId(id) { try { return new ObjectId(id); } catch (e) { return null; } }
function err(status, message) { return Object.assign(new Error(message), { status }); }

const authAdmin = [authUsuario, resolverOrg, requiereModulo('clientes')];

const CATEGORIAS_FISCALES_VALIDAS = ['consumidor_final', 'exento', 'monotributista', 'responsable_inscripto', 'exterior', 'iva_no_alcanzado'];
const TIPOS_DOCUMENTO_VALIDOS = ['cuil', 'cuit', 'dni', 'pasaporte'];
const SEXOS_VALIDOS = ['femenino', 'masculino'];
const TIPOS_COMPROBANTE_VALIDOS = ['comprobante_venta', 'factura'];

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }
function normalizarBooleano(v) { return !!v; }

function normalizarOpcional(v) {
  const s = normalizarTexto(v);
  return s ? s : null;
}

function normalizarNumeroOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, `${etiqueta} tiene que ser un número mayor o igual a 0`);
  return n;
}

function normalizarEnumOpcional(v, opciones, etiqueta) {
  const s = normalizarTexto(v).toLowerCase();
  if (!s) return null;
  if (!opciones.includes(s)) throw err(400, `${etiqueta} inválido (opciones: ${opciones.join(', ')})`);
  return s;
}

function normalizarFechaOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw err(400, `${etiqueta} inválida`);
  return d;
}

async function validarCodigoUnico(db, req, codigo, idExcluir) {
  if (!codigo) return;
  const match = Object.assign({ codigo, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('clientes').findOne(match);
  if (existente) throw err(400, `Ya hay otro cliente activo con el código "${codigo}" (${existente.apellidoRazonSocial}).`);
}

async function validarCuitUnico(db, req, cuit, idExcluir) {
  if (!cuit) return;
  const match = Object.assign({ cuit, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('clientes').findOne(match);
  if (existente) throw err(400, `Ya hay otro cliente activo con el CUIT/CUIL "${cuit}" (${existente.apellidoRazonSocial}).`);
}

// Campos alineados con la ficha de cliente de Dux — ver comentario de
// cabecera. Apellido/razón social y categoría fiscal son obligatorios,
// igual que en Dux; todo el resto es opcional, también igual que en Dux.
function validarCliente(body) {
  const apellidoRazonSocial = normalizarTexto(body.apellidoRazonSocial);
  if (!apellidoRazonSocial) throw err(400, 'El apellido / razón social es obligatorio');
  const categoriaFiscal = normalizarEnumOpcional(body.categoriaFiscal, CATEGORIAS_FISCALES_VALIDAS, 'Categoría fiscal');
  if (!categoriaFiscal) throw err(400, 'La categoría fiscal es obligatoria');

  const codigo = normalizarOpcional(body.codigo);
  const nombre = normalizarTexto(body.nombre);
  const nombreFantasia = normalizarTexto(body.nombreFantasia);
  const sexo = normalizarEnumOpcional(body.sexo, SEXOS_VALIDOS, 'Sexo');
  const tipoCliente = normalizarTexto(body.tipoCliente);
  const origenCliente = normalizarTexto(body.origenCliente);
  const fechaNacimiento = normalizarFechaOpcional(body.fechaNacimiento, 'La fecha de nacimiento');
  const noEditable = normalizarBooleano(body.noEditable);
  const limiteCtaCteFacturacion = normalizarNumeroOpcional(body.limiteCtaCteFacturacion, 'El límite de cta. cte. en facturación');
  const limiteCtaCtePedido = normalizarNumeroOpcional(body.limiteCtaCtePedido, 'El límite de cta. cte. en pedido');

  const tipoDocumento = normalizarEnumOpcional(body.tipoDocumento, TIPOS_DOCUMENTO_VALIDOS, 'Tipo de documento');
  const numeroDocumento = normalizarTexto(body.numeroDocumento);
  const cuit = normalizarOpcional(body.cuit);
  const listaPrecioPorDefecto = normalizarTexto(body.listaPrecioPorDefecto);
  const condicionPago = normalizarTexto(body.condicionPago);
  const porcentajeDescuento = normalizarNumeroOpcional(body.porcentajeDescuento, 'El porcentaje de descuento');
  const vendedor = normalizarTexto(body.vendedor);
  const tipoComprobantePorDefecto = normalizarEnumOpcional(body.tipoComprobantePorDefecto, TIPOS_COMPROBANTE_VALIDOS, 'Tipo de comprobante por defecto');
  const transporteEntregaPorDefecto = normalizarTexto(body.transporteEntregaPorDefecto);
  const lugarEntregaPorDefecto = normalizarTexto(body.lugarEntregaPorDefecto);

  const provincia = normalizarTexto(body.provincia);
  const localidad = normalizarTexto(body.localidad);
  const domicilio = normalizarTexto(body.domicilio);
  const barrio = normalizarTexto(body.barrio);
  const codigoPostal = normalizarTexto(body.codigoPostal);
  const zona = normalizarTexto(body.zona);
  const telefono = normalizarTexto(body.telefono);
  const fax = normalizarTexto(body.fax);
  const companiaCelular = normalizarTexto(body.companiaCelular);
  const celular = normalizarTexto(body.celular);
  const personaContacto = normalizarTexto(body.personaContacto);
  const email = normalizarTexto(body.email);
  const paginaWeb = normalizarTexto(body.paginaWeb);
  const observaciones = normalizarTexto(body.observaciones);
  const descripcion = normalizarTexto(body.descripcion);
  const notas = normalizarTexto(body.notas);

  return {
    codigo, apellidoRazonSocial, nombre, nombreFantasia, sexo, tipoCliente, origenCliente,
    fechaNacimiento, noEditable, limiteCtaCteFacturacion, limiteCtaCtePedido,
    categoriaFiscal, tipoDocumento, numeroDocumento, cuit, listaPrecioPorDefecto,
    condicionPago, porcentajeDescuento, vendedor, tipoComprobantePorDefecto,
    transporteEntregaPorDefecto, lugarEntregaPorDefecto,
    provincia, localidad, domicilio, barrio, codigoPostal, zona, telefono, fax,
    companiaCelular, celular, personaContacto, email, paginaWeb, observaciones,
    descripcion, notas
  };
}

router.get('/', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrg(req));
    if (soloActivos) match.activo = { $ne: false };
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ apellidoRazonSocial: re }, { nombre: re }, { codigo: re }, { cuit: re }, { numeroDocumento: re }];
    }
    const clientes = await conReintento(async () => {
      const db = await getDb();
      return db.collection('clientes').find(match).sort({ apellidoRazonSocial: 1 }).toArray();
    });
    res.json(clientes);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un cliente.');
    const datos = validarCliente(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarCodigoUnico(db, req, datos.codigo, null);
      await validarCuitUnico(db, req, datos.cuit, null);
      const ahora = new Date();
      const nuevo = Object.assign({}, datos, { activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora });
      const r = await db.collection('clientes').insertOne(nuevo);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const datos = validarCliente(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarCodigoUnico(db, req, datos.codigo, id);
      await validarCuitUnico(db, req, datos.cuit, id);
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('clientes').findOneAndUpdate(
        match,
        { $set: Object.assign({}, datos, { updatedAt: new Date() }) },
        { returnDocument: 'after' }
      );
      return r && r.value !== undefined ? r.value : r;
    });
    if (!doc) throw err(404, 'Cliente no encontrado');
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('clientes').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
      if (!r.matchedCount) throw err(404, 'Cliente no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
