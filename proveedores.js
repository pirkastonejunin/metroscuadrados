// ---------------------------------------------------------------------------
// Proveedores — registro maestro de proveedores (siguiente paso de migrar
// todo lo que hoy se lleva en Dux a este sistema, después de Productos y
// Clientes — decisión con Mato, 28-29/9/2026).
//
// A DIFERENCIA de Productos y Clientes: el artículo oficial de Dux sobre
// cómo crear/gestionar proveedores devolvió error 403 al intentar
// relevarlo (ayuda.duxsoftware.com.ar/es/articles/7856081-como-crear-y-
// gestionar-proveedores, probado varias veces). Por eso este esquema NO
// está confirmado campo por campo contra Dux como sí lo están Productos y
// Clientes — está armado por analogía directa con la ficha de Cliente
// (Dux usa el mismo patrón de "tercero" — Datos generales / Datos
// fiscales / Datos de contacto — para clientes y proveedores) más los
// campos mínimos que el propio Mato ya había anticipado en el roadmap
// (razón social, CUIT, contacto, condición de pago) y lo que hace falta
// para pagos (datos bancarios). CUANDO se pueda acceder al artículo real
// de Dux (o Mato lo pase a mano), hay que revisar este esquema contra los
// nombres reales y ajustar — se deja documentado acá y en el roadmap.
//
// Campo obligatorio: solo `razonSocial`. El resto es opcional (mismo
// criterio "liviano" que Clientes, no el de SKU-obligatorio de Productos).
//
// Vínculo con Productos (pendiente, no incluido en esta v1): el campo
// `proveedor` de `productos_catalogo` sigue siendo texto libre — cuando
// haga falta, se puede convertir a un `proveedorId` real apuntando acá.
//
// Colección nueva (en la misma base `calculadora_m2`):
//   proveedores : { codigo, razonSocial, nombreFantasia, rubro,
//     categoriaFiscal, tipoDocumento, numeroDocumento, cuit,
//     condicionPago, diasPago, moneda, banco, cbu, aliasCbu,
//     cuentaBancaria, provincia, localidad, domicilio, barrio,
//     codigoPostal, zona, telefono, celular, personaContacto, email,
//     paginaWeb, observaciones, descripcion, notas, activo, orgId,
//     createdAt, updatedAt }
//
// Módulo con clave propia ('proveedores'), datos separados por
// organización (mismo mecanismo orgId/resolverOrg/filtroOrg que el resto
// de la app).
//
// Integración (en server.js):
//   const proveedoresRouter = require('./proveedores');
//   app.use('/api/proveedores', proveedoresRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { authUsuario, requiereModulo, resolverOrg, filtroOrg, filtroOrgClientes } = require('./usuarios');
const { exportarXlsx, exportarPlantillaXlsx, parsearXlsxBase64 } = require('./importExport');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    // Carrera de conexión (4/10/2026, ver compras.js): se guarda la
    // conexión EN CURSO para que los requests simultáneos de un proceso
    // recién arrancado esperen la misma, en vez de usar un cliente que
    // todavía no terminó de conectar.
    if (!mongoConectando) {
      const nuevoCliente = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevoCliente.connect().then(
        () => { mongoClient = nuevoCliente; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
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

const authAdmin = [authUsuario, resolverOrg, requiereModulo('proveedores')];

// Mismo enum de categoría fiscal que Clientes (AFIP, no es específico de
// Dux-Cliente ni Dux-Proveedor — aplica a cualquier "tercero").
const CATEGORIAS_FISCALES_VALIDAS = ['consumidor_final', 'exento', 'monotributista', 'responsable_inscripto', 'exterior', 'iva_no_alcanzado'];
const TIPOS_DOCUMENTO_VALIDOS = ['cuil', 'cuit', 'dni', 'pasaporte'];
const MONEDAS_VALIDAS = ['ARS', 'USD'];

// Columnas del Excel de import/export (30/9/2026, pedido de Mato: "todas
// las bases tengo que tener la posibilidad de importar y exportar") — ver
// importExport.js para el formato de esta lista y cómo se usa.
const COLUMNAS_PROVEEDORES = [
  { clave: 'codigo', titulo: 'Código' },
  { clave: 'razonSocial', titulo: 'Razón social' },
  { clave: 'nombreFantasia', titulo: 'Nombre de fantasía' },
  { clave: 'rubro', titulo: 'Rubro' },
  { clave: 'categoriaFiscal', titulo: 'Categoría fiscal' },
  { clave: 'tipoDocumento', titulo: 'Tipo de documento' },
  { clave: 'numeroDocumento', titulo: 'Número de documento' },
  { clave: 'cuit', titulo: 'CUIT/CUIL' },
  { clave: 'condicionPago', titulo: 'Condición de pago' },
  { clave: 'diasPago', titulo: 'Días de pago', tipo: 'numero' },
  { clave: 'moneda', titulo: 'Moneda' },
  { clave: 'banco', titulo: 'Banco' },
  { clave: 'cbu', titulo: 'CBU' },
  { clave: 'aliasCbu', titulo: 'Alias CBU' },
  { clave: 'cuentaBancaria', titulo: 'Cuenta bancaria' },
  { clave: 'provincia', titulo: 'Provincia' },
  { clave: 'localidad', titulo: 'Localidad' },
  { clave: 'domicilio', titulo: 'Domicilio' },
  { clave: 'telefono', titulo: 'Teléfono' },
  { clave: 'celular', titulo: 'Celular' },
  { clave: 'email', titulo: 'Email' },
  { clave: 'personaContacto', titulo: 'Persona de contacto' },
  { clave: 'observaciones', titulo: 'Observaciones' },
  { clave: 'notas', titulo: 'Notas' }
];

function normalizarTexto(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

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

async function validarCodigoUnico(db, req, codigo, idExcluir) {
  if (!codigo) return;
  const match = Object.assign({ codigo, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('proveedores').findOne(match);
  if (existente) throw err(400, `Ya hay otro proveedor activo con el código "${codigo}" (${existente.razonSocial}).`);
}

async function validarCuitUnico(db, req, cuit, idExcluir) {
  if (!cuit) return;
  const match = Object.assign({ cuit, activo: { $ne: false } }, filtroOrg(req));
  if (idExcluir) match._id = { $ne: idExcluir };
  const existente = await db.collection('proveedores').findOne(match);
  if (existente) throw err(400, `Ya hay otro proveedor activo con el CUIT/CUIL "${cuit}" (${existente.razonSocial}).`);
}

// Campos por analogía con la ficha de Cliente de Dux — ver comentario de
// cabecera (el artículo real de Proveedores en Dux no se pudo relevar,
// 403). Solo razonSocial es obligatorio; todo el resto es opcional.
function validarProveedor(body) {
  const razonSocial = normalizarTexto(body.razonSocial);
  if (!razonSocial) throw err(400, 'La razón social es obligatoria');

  const codigo = normalizarOpcional(body.codigo);
  const nombreFantasia = normalizarTexto(body.nombreFantasia);
  const rubro = normalizarTexto(body.rubro);
  const categoriaFiscal = normalizarEnumOpcional(body.categoriaFiscal, CATEGORIAS_FISCALES_VALIDAS, 'Categoría fiscal');
  const tipoDocumento = normalizarEnumOpcional(body.tipoDocumento, TIPOS_DOCUMENTO_VALIDOS, 'Tipo de documento');
  const numeroDocumento = normalizarTexto(body.numeroDocumento);
  const cuit = normalizarOpcional(body.cuit);
  const condicionPago = normalizarTexto(body.condicionPago);
  const diasPago = normalizarNumeroOpcional(body.diasPago, 'Los días de pago');
  const moneda = normalizarEnumOpcional(body.moneda, MONEDAS_VALIDAS.map(m => m.toLowerCase()), 'Moneda');

  const banco = normalizarTexto(body.banco);
  const cbu = normalizarTexto(body.cbu);
  const aliasCbu = normalizarTexto(body.aliasCbu);
  const cuentaBancaria = normalizarTexto(body.cuentaBancaria);

  const provincia = normalizarTexto(body.provincia);
  const localidad = normalizarTexto(body.localidad);
  const domicilio = normalizarTexto(body.domicilio);
  const barrio = normalizarTexto(body.barrio);
  const codigoPostal = normalizarTexto(body.codigoPostal);
  const zona = normalizarTexto(body.zona);
  const telefono = normalizarTexto(body.telefono);
  const celular = normalizarTexto(body.celular);
  const personaContacto = normalizarTexto(body.personaContacto);
  const email = normalizarTexto(body.email);
  const paginaWeb = normalizarTexto(body.paginaWeb);
  const observaciones = normalizarTexto(body.observaciones);
  const descripcion = normalizarTexto(body.descripcion);
  const notas = normalizarTexto(body.notas);

  return {
    codigo, razonSocial, nombreFantasia, rubro, categoriaFiscal, tipoDocumento,
    numeroDocumento, cuit, condicionPago, diasPago, moneda: moneda ? moneda.toUpperCase() : null,
    banco, cbu, aliasCbu, cuentaBancaria,
    provincia, localidad, domicilio, barrio, codigoPostal, zona, telefono, celular,
    personaContacto, email, paginaWeb, observaciones, descripcion, notas
  };
}

// Las credenciales del portal (cifradas) nunca salen al navegador.
function sinSecretos(p) {
  if (!p || !p.portal) return p;
  const portal = { tipo: p.portal.tipo, usuario: p.portal.usuario, tieneClave: !!p.portal.claveCifrada };
  return Object.assign({}, p, { portal });
}

router.get('/', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrgClientes(req));
    if (soloActivos) match.activo = { $ne: false };
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$and = [{ $or: [{ razonSocial: re }, { nombreFantasia: re }, { codigo: re }, { cuit: re }, { numeroDocumento: re }] }];
    }
    const proveedores = await conReintento(async () => {
      const db = await getDb();
      return db.collection('proveedores').find(match).sort({ razonSocial: 1 }).toArray();
    });
    res.json(proveedores.map(sinSecretos));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Saldo de cada proveedor (el MISMO que muestra su cuenta corriente: saldo inicial Dux + compras y gastos propios + ajustes − pagos),
// para las tarjetas de totales y la columna Saldo de la lista. Positivo = le debemos; negativo = a favor nuestro.
router.get('/resumen-saldos', authAdmin, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const compartidos = req.orgId ? (await db.collection('proveedores').find({ $or: [{ orgIdsCompartidas: req.orgId }, { orgId: req.orgId, 'orgIdsCompartidas.0': { $exists: true } }] }).project({ _id: 1 }).toArray()).map(x => x._id) : [];
      const fo = req.orgId ? (compartidos.length ? { $or: [{ orgId: req.orgId }, { proveedorId: { $in: compartidos } }] } : { orgId: req.orgId }) : {};
      const mapa = new Map();
      const suma = (id, v) => { if (!id) return; const k = String(id); mapa.set(k, (mapa.get(k) || 0) + v); };
      const esNC = { $regexMatch: { input: { $ifNull: ['$tipoComprobante', ''] }, regex: '^nota_credito' } };
      const signo = { $cond: [esNC, -1, 1] };
      const [iniciales, compras, gastos, pagosGasto, pagos, ajustes] = await Promise.all([
        db.collection('proveedores_saldos_iniciales').aggregate([{ $group: { _id: '$proveedorId', t: { $sum: '$monto' } } }]).toArray(),
        db.collection('compras').aggregate([{ $match: Object.assign({ estado: { $ne: 'anulada' }, importado: { $ne: true } }, fo) }, { $group: { _id: '$proveedorId', t: { $sum: { $multiply: ['$total', signo] } } } }]).toArray(),
        db.collection('gastos').aggregate([{ $match: Object.assign({ estado: { $ne: 'anulada' }, importado: { $ne: true } }, fo) }, { $group: { _id: '$proveedorId', t: { $sum: { $multiply: ['$total', signo] } } } }]).toArray(),
        db.collection('gastos').aggregate([{ $match: Object.assign({ estado: { $ne: 'anulada' } }, fo) }, { $unwind: '$pagos' }, { $group: { _id: '$proveedorId', t: { $sum: '$pagos.monto' } } }]).toArray(),
        db.collection('compras_pagos').aggregate([{ $match: Object.assign({ importado: { $ne: true } }, fo) }, { $group: { _id: '$proveedorId', t: { $sum: '$monto' } } }]).toArray(),
        db.collection('proveedores_ajustes').aggregate([{ $match: fo }, { $group: { _id: '$proveedorId', t: { $sum: { $cond: [{ $eq: ['$tipo', 'debito'] }, '$monto', { $multiply: ['$monto', -1] }] } } } }]).toArray()
      ]);
      iniciales.forEach(x => suma(x._id, x.t)); compras.forEach(x => suma(x._id, x.t)); gastos.forEach(x => suma(x._id, x.t));
      pagosGasto.forEach(x => suma(x._id, -x.t)); pagos.forEach(x => suma(x._id, -x.t)); ajustes.forEach(x => suma(x._id, x.t));
      const provs = await db.collection('proveedores').find(Object.assign({}, filtroOrgClientes(req))).project({ razonSocial: 1, nombreFantasia: 1 }).toArray();
      const r2 = (n) => Math.round(n * 100) / 100;
      const saldos = {}; let deuda = 0, aFavor = 0, conDeuda = 0, mayor = null;
      provs.forEach(pr => {
        const s = r2(mapa.get(String(pr._id)) || 0); saldos[String(pr._id)] = s;
        if (s > 0.5) { deuda += s; conDeuda++; if (!mayor || s > mayor.saldo) mayor = { proveedorId: String(pr._id), nombre: pr.razonSocial || pr.nombreFantasia || '', saldo: s }; }
        else if (s < -0.5) aFavor += -s;
      });
      return { activos: provs.length, conDeuda, deuda: r2(deuda), aFavor: r2(aFavor), mayor, saldos };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Conciliación con Dux: por proveedor, el saldo que se trajo de Dux (saldo inicial) contra lo que da el historial importado
// (compras + gastos − notas de crédito − pagos). Sirve para ver si el signo del saldo de Dux quedó invertido o si hay diferencias puntuales.
// Nombre del comprobante para la cuenta corriente: "Factura A 0001-00001234" (si tiene tipo y número); si no, el texto de siempre.
const TIPO_COMP_LABEL = { factura_a: 'Factura A', factura_b: 'Factura B', factura_c: 'Factura C', factura_m: 'Factura M', nota_credito_a: 'Nota de Crédito A', nota_credito_b: 'Nota de Crédito B', nota_credito_c: 'Nota de Crédito C', nota_credito_m: 'Nota de Crédito M', nota_debito_a: 'Nota de Débito A', nota_debito_b: 'Nota de Débito B', nota_debito_c: 'Nota de Débito C', nota_debito_m: 'Nota de Débito M', recibo: 'Recibo', ticket: 'Ticket', otro: 'Comprobante' };
function nombreComprobante(d) {
  if (!d || !d.comprobanteNumero || /^[A-Z]-\d/.test(String(d.comprobanteNumero))) return null; // los importados de Dux ya traen su número completo (A-00012-00027691)
  const tipo = TIPO_COMP_LABEL[d.tipoComprobante] || (d.tipoComprobante ? String(d.tipoComprobante).replace(/_/g, ' ') : 'Comprobante');
  return tipo + ' ' + (d.puntoVenta ? d.puntoVenta + '-' : '') + d.comprobanteNumero;
}

// Los saldos iniciales cargados de Dux antes de la corrección tenían el signo al revés (Dux: negativo = le debemos). Se invierten una sola vez.
router.post('/corregir-signo-dux', authAdmin, async (req, res) => {
  try {
    const n = await conReintento(async () => {
      const db = await getDb();
      const r = await db.collection('proveedores_saldos_iniciales').updateMany({ origen: 'dux', signoCorregido: { $ne: true } }, [{ $set: { monto: { $multiply: ['$monto', -1] }, signoCorregido: true } }]);
      return r.modifiedCount;
    });
    res.json({ corregidos: n });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.get('/conciliacion-dux', authAdmin, async (req, res) => {
  try {
    const out = await conReintento(async () => {
      const db = await getDb();
      const compartidos = req.orgId ? (await db.collection('proveedores').find({ $or: [{ orgIdsCompartidas: req.orgId }, { orgId: req.orgId, 'orgIdsCompartidas.0': { $exists: true } }] }).project({ _id: 1 }).toArray()).map(x => x._id) : [];
      const fo = req.orgId ? (compartidos.length ? { $or: [{ orgId: req.orgId }, { proveedorId: { $in: compartidos } }] } : { orgId: req.orgId }) : {};
      const signo = { $cond: [{ $regexMatch: { input: { $ifNull: ['$tipoComprobante', ''] }, regex: '^nota_credito' } }, -1, 1] };
      const agg = (col, extra, valor) => db.collection(col).aggregate([{ $match: Object.assign({ estado: { $ne: 'anulada' } }, extra, fo) }, { $group: { _id: '$proveedorId', t: { $sum: valor }, n: { $sum: 1 } } }]).toArray();
      const [ini, compras, gastos, pagos, pagosGasto] = await Promise.all([
        db.collection('proveedores_saldos_iniciales').aggregate([{ $group: { _id: '$proveedorId', t: { $sum: '$monto' } } }]).toArray(),
        agg('compras', { importado: true }, { $multiply: ['$total', signo] }),
        agg('gastos', { importado: true }, { $multiply: ['$total', signo] }),
        db.collection('compras_pagos').aggregate([{ $match: Object.assign({ importado: true }, fo) }, { $group: { _id: '$proveedorId', t: { $sum: '$monto' }, n: { $sum: 1 } } }]).toArray(),
        db.collection('gastos').aggregate([{ $match: Object.assign({ estado: { $ne: 'anulada' }, importado: true }, fo) }, { $unwind: '$pagos' }, { $group: { _id: '$proveedorId', t: { $sum: '$pagos.monto' } } }]).toArray()
      ]);
      const m = new Map(); const get = (id) => { const k = String(id); if (!m.has(k)) m.set(k, { dux: 0, compras: 0, gastos: 0, pagos: 0 }); return m.get(k); };
      ini.forEach(x => { if (x._id) get(x._id).dux += x.t; }); compras.forEach(x => { if (x._id) get(x._id).compras += x.t; }); gastos.forEach(x => { if (x._id) get(x._id).gastos += x.t; });
      pagos.forEach(x => { if (x._id) get(x._id).pagos += x.t; }); pagosGasto.forEach(x => { if (x._id) get(x._id).pagos += x.t; });
      const provs = await db.collection('proveedores').find(filtroOrgClientes(req)).project({ razonSocial: 1, nombreFantasia: 1 }).toArray();
      const nombre = new Map(provs.map(pr => [String(pr._id), pr.razonSocial || pr.nombreFantasia || '']));
      const r2 = (n) => Math.round(n * 100) / 100;
      const filas = [];
      for (const [k, v] of m) {
        if (!nombre.has(k)) continue;
        const calc = r2(v.compras + v.gastos - v.pagos), dux = r2(v.dux);
        if (Math.abs(calc) < 0.5 && Math.abs(dux) < 0.5) continue;
        const diff = r2(dux - calc);
        const estado = Math.abs(diff) < 1 ? 'cuadra' : (Math.abs(dux + calc) < 1 ? 'invertido' : 'difiere');
        filas.push({ proveedorId: k, nombre: nombre.get(k), dux, compras: r2(v.compras), gastos: r2(v.gastos), pagos: r2(v.pagos), calculado: calc, diferencia: diff, estado });
      }
      filas.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
      const cnt = { cuadra: 0, invertido: 0, difiere: 0 }; filas.forEach(f => cnt[f.estado]++);
      const ambos = filas.filter(f => Math.abs(f.dux) >= 1 && Math.abs(f.calculado) >= 1);
      const mismoSigno = ambos.filter(f => (f.dux > 0) === (f.calculado > 0)).length;
      return { proveedores: filas.length, cuadran: cnt.cuadra, invertidos: cnt.invertido, difieren: cnt.difiere, conAmbos: ambos.length, mismoSigno, signoOpuesto: ambos.length - mismoSigno,
        totalDux: r2(filas.reduce((a, f) => a + f.dux, 0)), totalCalculado: r2(filas.reduce((a, f) => a + f.calculado, 0)), filas };
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Import / export en Excel (.xlsx) — ver importExport.js.
// -----------------------------------------------------------------------

router.get('/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrgClientes(req));
    const proveedores = await conReintento(async () => {
      const db = await getDb();
      return db.collection('proveedores').find(match).sort({ razonSocial: 1 }).toArray();
    });
    exportarXlsx(res, 'proveedores.xlsx', COLUMNAS_PROVEEDORES, proveedores);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/plantilla-import', authAdmin, (req, res) => {
  exportarPlantillaXlsx(res, 'plantilla-proveedores.xlsx', COLUMNAS_PROVEEDORES);
});

// Importa filas de un Excel: si viene Código o CUIT y ya existe un
// proveedor activo con ese mismo dato, lo actualiza; si no, lo crea.
// Nunca aborta el archivo entero por una fila con error — esa fila se
// saltea y se informa en `errores`.
router.post('/import', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de importar.');
    const filas = parsearXlsxBase64((req.body || {}).archivoBase64, COLUMNAS_PROVEEDORES);
    if (!filas.length) throw err(400, 'El Excel no tiene filas de datos');

    const resultado = await conReintento(async () => {
      const db = await getDb();
      let creados = 0, actualizados = 0;
      const errores = [];
      for (const fila of filas) {
        try {
          const datos = validarProveedor(fila);
          let existente = null;
          if (datos.codigo) {
            existente = await db.collection('proveedores').findOne(Object.assign({ codigo: datos.codigo, activo: { $ne: false } }, filtroOrg(req)));
          }
          if (!existente && datos.cuit) {
            existente = await db.collection('proveedores').findOne(Object.assign({ cuit: datos.cuit, activo: { $ne: false } }, filtroOrg(req)));
          }
          const ahora = new Date();
          if (existente) {
            await db.collection('proveedores').updateOne(
              { _id: existente._id },
              { $set: Object.assign({}, datos, { updatedAt: ahora }) }
            );
            actualizados++;
          } else {
            await db.collection('proveedores').insertOne(
              Object.assign({}, datos, { activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora })
            );
            creados++;
          }
        } catch (e) {
          errores.push({ fila: fila.__fila, motivo: e.message });
        }
      }
      return { creados, actualizados, errores };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un proveedor.');
    const datos = validarProveedor(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarCodigoUnico(db, req, datos.codigo, null);
      await validarCuitUnico(db, req, datos.cuit, null);
      const ahora = new Date();
      const nuevo = Object.assign({}, datos, { activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora });
      const r = await db.collection('proveedores').insertOne(nuevo);
      return Object.assign({ _id: r.insertedId }, nuevo);
    });
    res.json(doc);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const datos = validarProveedor(req.body || {});
    const doc = await conReintento(async () => {
      const db = await getDb();
      await validarCodigoUnico(db, req, datos.codigo, id);
      await validarCuitUnico(db, req, datos.cuit, id);
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('proveedores').findOneAndUpdate(
        match,
        { $set: Object.assign({}, datos, { updatedAt: new Date() }) },
        { returnDocument: 'after' }
      );
      return r && r.value !== undefined ? r.value : r;
    });
    if (!doc) throw err(404, 'Proveedor no encontrado');
    res.json(sinSecretos(doc));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const match = Object.assign({ _id: id }, filtroOrg(req));
      const r = await db.collection('proveedores').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
      if (!r.matchedCount) throw err(404, 'Proveedor no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ajuste manual de saldo del proveedor: un movimiento propio (colección proveedores_ajustes) que suma (débito: le debemos más) o resta
// (crédito: le debemos menos) a su cuenta corriente, con motivo y sucursal. Se puede quitar si se cargó por error.
router.post('/:id/ajuste-saldo', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const b = req.body || {};
    const tipo = b.tipo === 'credito' ? 'credito' : (b.tipo === 'debito' ? 'debito' : '');
    if (!tipo) throw err(400, 'Elegí si el ajuste aumenta o disminuye lo que le debemos.');
    const monto = Math.round(Number(b.monto) * 100) / 100;
    if (!(monto > 0)) throw err(400, 'El monto del ajuste tiene que ser mayor a 0.');
    const motivo = normalizarTexto(b.motivo);
    if (!motivo) throw err(400, 'Escribí el motivo del ajuste.');
    if (!req.orgId) throw err(400, 'Elegí con qué sucursal operás para registrar el ajuste.');
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || '')) ? new Date(b.fecha + 'T12:00:00-03:00') : new Date();
    const out = await conReintento(async () => {
      const db = await getDb();
      const prov = await db.collection('proveedores').findOne(Object.assign({ _id: id }, filtroOrgClientes(req)));
      if (!prov) throw err(404, 'Proveedor no encontrado');
      const doc = { proveedorId: id, proveedorNombre: prov.razonSocial || prov.nombreFantasia || '', orgId: req.orgId, tipo, monto, fecha, motivo,
        usuarioNombre: (req.usuario && req.usuario.nombre) || '', createdAt: new Date() };
      const r = await db.collection('proveedores_ajustes').insertOne(doc);
      return Object.assign({ _id: r.insertedId }, doc);
    });
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/:id/ajuste-saldo/:ajusteId', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id), aid = toObjectId(req.params.ajusteId);
    if (!id || !aid) throw err(400, 'id inválido');
    await conReintento(async () => {
      const db = await getDb();
      const prov = await db.collection('proveedores').findOne(Object.assign({ _id: id }, filtroOrgClientes(req)));
      if (!prov) throw err(404, 'Proveedor no encontrado');
      const r = await db.collection('proveedores_ajustes').deleteOne({ _id: aid, proveedorId: id });
      if (!r.deletedCount) throw err(404, 'Ajuste no encontrado');
    });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Cuenta corriente del proveedor (4/10/2026, pedido de Mato: "cuando
// entramos en proveedores en al lado de los datos debemos crear una
// pestaña para ver el saldo de la cuenta corriente. y que sea similar al
// de clientes, que nos de las opciones de ver los comprobantes y
// demas") — a diferencia de Clientes, ACÁ NO hay una colección de
// movimientos propia: se reconstruye en el momento a partir de lo que ya
// existe en Compras y Gastos (cada uno ya lleva su propio
// saldoPendiente/totalPagado por comprobante) — evita duplicar ese
// estado en una segunda colección que se podría desincronizar.
//
//   Débito = una Compra o un Gasto (no anulado) — por su total.
//   Crédito = un pago: de `compras_pagos` (cubre tanto el pago puntual
//     de una compra como un pago a cuenta repartido entre varias) o de
//     cada entrada del array `pagos` embebido en un Gasto (Gastos
//     todavía no tiene su propio "pago a cuenta" como Compras).
//
// Incluye Compras Y Gastos juntos (pedido de Mato) — ambos representan
// plata que le debemos al mismo proveedor.
// -----------------------------------------------------------------------
router.get('/:id/cuenta-corriente', authAdmin, async (req, res) => {
  try {
    const id = toObjectId(req.params.id);
    if (!id) throw err(400, 'id inválido');
    const limite = Math.min(Number(req.query.limite) || 1000, 2000);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: id }, filtroOrgClientes(req)));
      if (!proveedor) throw err(404, 'Proveedor no encontrado');

      // Un proveedor compartido entre sucursales (unificado) muestra toda su cuenta, de todas las sucursales que lo usan.
      const fOrg = (proveedor.orgIdsCompartidas || []).length ? { orgId: { $in: [proveedor.orgId].concat(proveedor.orgIdsCompartidas) } } : filtroOrg(req);
      // Reparación: pagos hechos en modo "todas las sucursales" quedaron sin sucursal y no aparecían; se la ponemos según la compra a la que se aplicaron.
      const huerfanos = await db.collection('compras_pagos').find({ proveedorId: id, $or: [{ orgId: null }, { orgId: { $exists: false } }] }).toArray();
      for (const hp of huerfanos) {
        const cid = hp.aplicaciones && hp.aplicaciones[0] && hp.aplicaciones[0].compraId;
        const cmp = cid ? await db.collection('compras').findOne({ _id: cid }, { projection: { orgId: 1 } }) : null;
        const oid = (cmp && cmp.orgId) || proveedor.orgId;
        if (oid) await db.collection('compras_pagos').updateOne({ _id: hp._id }, { $set: { orgId: oid } });
      }
      const [compras, gastos, pagosCompra, saldosIni, ajustes] = await Promise.all([
        db.collection('compras').find(Object.assign({ proveedorId: id, estado: { $ne: 'anulada' } }, fOrg)).toArray(),
        db.collection('gastos').find(Object.assign({ proveedorId: id, estado: { $ne: 'anulada' } }, fOrg)).toArray(),
        db.collection('compras_pagos').find(Object.assign({ proveedorId: id }, fOrg)).toArray(),
        db.collection('proveedores_saldos_iniciales').find({ proveedorId: id }).toArray(),
        db.collection('proveedores_ajustes').find(Object.assign({ proveedorId: id }, fOrg)).toArray()
      ]);

      const movimientos = [];
      // Saldo inicial de Dux (importado aparte): es la base del saldo. Las compras, gastos y pagos importados de Dux
      // se muestran como historial pero NO suman al saldo (ya están dentro del saldo inicial).
      for (const si of saldosIni) {
        if (!si.monto) continue;
        movimientos.push({ tipo: si.monto > 0 ? 'debito' : 'credito', monto: Math.abs(si.monto), fecha: si.fecha, concepto: 'Saldo inicial Dux', origen: 'saldo_inicial_dux', docId: si._id, moneda: 'ARS' });
      }
      for (const a of ajustes) {
        movimientos.push({ tipo: a.tipo, monto: a.monto, fecha: a.fecha, concepto: 'Ajuste de saldo — ' + a.motivo, origen: 'ajuste', docId: a._id, nota: a.usuarioNombre ? 'Cargó ' + a.usuarioNombre : '', moneda: 'ARS' });
      }
      for (const c of compras) {
        movimientos.push({
          tipo: /^nota_credito/.test(c.tipoComprobante || '') ? 'credito' : 'debito', monto: c.total, fecha: c.fecha,
          concepto: nombreComprobante(c) || (/^nota_(credito|debito)/.test(c.tipoComprobante || '') ? `${/^nota_credito/.test(c.tipoComprobante) ? 'Nota de crédito' : 'Nota de débito'} ${c.numeroOriginal || ''} (Dux)` : c.numeroOriginal ? `Compra ${c.numeroOriginal} (Dux)` : `Compra #${c.numero}`), origen: 'compra',
          docId: c._id, docNumero: c.numero, docEstado: c.estado, importado: !!c.importado,
          tipoComprobante: c.tipoComprobante, puntoVenta: c.puntoVenta, comprobanteNumero: c.comprobanteNumero, esFiscal: c.esFiscal,
          items: c.items, observaciones: c.observaciones, moneda: c.moneda,
          totalPagado: c.totalPagado, saldoPendiente: c.saldoPendiente
        });
      }
      const nombreCompraPorId = new Map(compras.map(c => [String(c._id), nombreComprobante(c)]).filter(x => x[1]));
      for (const p of pagosCompra) {
        movimientos.push({
          tipo: 'credito', monto: p.monto, fecha: p.fecha,
          concepto: p.importado ? `Pago Dux Nº ${p.numeroOriginal || ''}${p.montoSinAplicar > 0 ? ' (a cuenta)' : ''}` : `Pago${(p.aplicaciones || []).length ? ' — ' + p.aplicaciones.map(a => nombreCompraPorId.get(String(a.compraId)) || '#' + a.compraNumero).join(', ') : ''}`,
          origen: 'pago_compra', docId: p._id, nota: p.nota, tipoValor: p.tipoValor, importado: !!p.importado
        });
      }
      for (const g of gastos) {
        movimientos.push({
          tipo: /^nota_credito/.test(g.tipoComprobante || '') ? 'credito' : 'debito', monto: g.total, fecha: g.fecha,
          concepto: nombreComprobante(g) || (/^nota_(credito|debito)/.test(g.tipoComprobante || '') ? `${/^nota_credito/.test(g.tipoComprobante) ? 'Nota de crédito' : 'Nota de débito'} ${g.numeroOriginal || ''} (Dux)` : g.numeroOriginal ? `Gasto ${g.numeroOriginal} (Dux)` : `Gasto #${g.numero}`), origen: 'gasto',
          docId: g._id, docNumero: g.numero, docEstado: g.estado, importado: !!g.importado,
          tipoComprobante: g.tipoComprobante, puntoVenta: g.puntoVenta, comprobanteNumero: g.comprobanteNumero, esFiscal: g.esFiscal,
          items: g.items, observaciones: g.observaciones, moneda: g.moneda,
          totalPagado: g.totalPagado, saldoPendiente: g.saldoPendiente
        });
        for (const p of (g.pagos || [])) {
          movimientos.push({
            tipo: 'credito', monto: p.monto, fecha: p.fecha,
            concepto: `Pago — ${nombreComprobante(g) || 'Gasto #' + g.numero}`, origen: 'pago_gasto',
            docId: g._id, nota: p.nota, tipoValor: p.tipoValor
          });
        }
      }

      movimientos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      const saldo = Math.round(movimientos.filter(m => !m.importado).reduce((acc, m) => acc + (m.tipo === 'debito' ? m.monto : -m.monto), 0) * 100) / 100;

      return { proveedor, saldo, movimientos: movimientos.slice(0, limite) };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Pestañas de la ficha del proveedor (7/10/2026, pedido de Mato): productos
// comprados y órdenes de compra.
async function proveedorDeLaOrg(db, req) {
  const id = toObjectId(req.params.id);
  if (!id) throw err(400, 'id inválido');
  const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: id }, filtroOrgClientes(req)));
  if (!proveedor) throw err(404, 'Proveedor no encontrado');
  return proveedor;
}

// Productos comprados: agrupados por producto a partir de las compras no
// anuladas (cantidad total, monto, último precio y última compra).
router.get('/:id/productos', authAdmin, async (req, res) => {
  try {
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const prov = await proveedorDeLaOrg(db, req);
      const compras = await db.collection('compras')
        .find(Object.assign({ proveedorId: prov._id, estado: { $ne: 'anulada' } }, filtroOrg(req)))
        .project({ fecha: 1, moneda: 1, items: 1 }).sort({ fecha: -1 }).limit(1000).toArray();
      const mapa = new Map();
      for (const c of compras) {
        for (const it of (c.items || [])) {
          const clave = String(it.productoId || it.sku || it.nombre);
          let p = mapa.get(clave);
          if (!p) {
            p = { productoId: it.productoId || null, sku: it.sku || '', nombre: it.nombre || '', cantidad: 0, monto: {}, compras: 0,
              ultimaCompra: c.fecha, ultimoPrecio: Number(it.precioUnitario) || 0, ultimaMoneda: c.moneda || 'ARS' };
            mapa.set(clave, p);
          }
          const mon = c.moneda || 'ARS';
          p.cantidad += Number(it.cantidad) || 0;
          p.monto[mon] = (p.monto[mon] || 0) + (Number(it.subtotal) || 0);
          p.compras += 1;
        }
      }
      return { compras: compras.length, productos: [...mapa.values()].sort((a, b) => new Date(b.ultimaCompra) - new Date(a.ultimaCompra)) };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get('/:id/ordenes', authAdmin, async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      const prov = await proveedorDeLaOrg(db, req);
      return db.collection('ordenes_compra')
        .find(Object.assign({ proveedorId: prov._id }, filtroOrg(req)))
        .project({ numero: 1, fecha: 1, moneda: 1, total: 1, estado: 1, estadoRecepcion: 1, observaciones: 1 })
        .sort({ fecha: -1, numero: -1 }).limit(300).toArray();
    });
    res.json(lista);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
