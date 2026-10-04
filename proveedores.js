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
const { authUsuario, requiereModulo, resolverOrg, filtroOrg } = require('./usuarios');
const { exportarXlsx, exportarPlantillaXlsx, parsearXlsxBase64 } = require('./importExport');

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

router.get('/', authAdmin, async (req, res) => {
  try {
    const soloActivos = req.query.incluirInactivos !== '1';
    const match = Object.assign({}, filtroOrg(req));
    if (soloActivos) match.activo = { $ne: false };
    if (req.query.q) {
      const re = new RegExp(String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      match.$or = [{ razonSocial: re }, { nombreFantasia: re }, { codigo: re }, { cuit: re }, { numeroDocumento: re }];
    }
    const proveedores = await conReintento(async () => {
      const db = await getDb();
      return db.collection('proveedores').find(match).sort({ razonSocial: 1 }).toArray();
    });
    res.json(proveedores);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// -----------------------------------------------------------------------
// Import / export en Excel (.xlsx) — ver importExport.js.
// -----------------------------------------------------------------------

router.get('/export', authAdmin, async (req, res) => {
  try {
    const match = Object.assign({ activo: { $ne: false } }, filtroOrg(req));
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
      const r = await db.collection('proveedores').updateOne(match, { $set: { activo: false, updatedAt: new Date() } });
      if (!r.matchedCount) throw err(404, 'Proveedor no encontrado');
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
    const limite = Math.min(Number(req.query.limite) || 300, 1000);
    const resultado = await conReintento(async () => {
      const db = await getDb();
      const proveedor = await db.collection('proveedores').findOne(Object.assign({ _id: id }, filtroOrg(req)));
      if (!proveedor) throw err(404, 'Proveedor no encontrado');

      const [compras, gastos, pagosCompra] = await Promise.all([
        db.collection('compras').find(Object.assign({ proveedorId: id, estado: { $ne: 'anulada' } }, filtroOrg(req))).toArray(),
        db.collection('gastos').find(Object.assign({ proveedorId: id, estado: { $ne: 'anulada' } }, filtroOrg(req))).toArray(),
        db.collection('compras_pagos').find(Object.assign({ proveedorId: id }, filtroOrg(req))).toArray()
      ]);

      const movimientos = [];
      for (const c of compras) {
        movimientos.push({
          tipo: 'debito', monto: c.total, fecha: c.fecha,
          concepto: `Compra #${c.numero}`, origen: 'compra',
          docId: c._id, docNumero: c.numero, docEstado: c.estado,
          tipoComprobante: c.tipoComprobante, puntoVenta: c.puntoVenta, comprobanteNumero: c.comprobanteNumero, esFiscal: c.esFiscal,
          items: c.items, observaciones: c.observaciones, moneda: c.moneda,
          totalPagado: c.totalPagado, saldoPendiente: c.saldoPendiente
        });
      }
      for (const p of pagosCompra) {
        movimientos.push({
          tipo: 'credito', monto: p.monto, fecha: p.fecha,
          concepto: `Pago${(p.aplicaciones || []).length ? ' — ' + p.aplicaciones.map(a => '#' + a.compraNumero).join(', ') : ''}`,
          origen: 'pago_compra', docId: p._id, nota: p.nota, tipoValor: p.tipoValor
        });
      }
      for (const g of gastos) {
        movimientos.push({
          tipo: 'debito', monto: g.total, fecha: g.fecha,
          concepto: `Gasto #${g.numero}`, origen: 'gasto',
          docId: g._id, docNumero: g.numero, docEstado: g.estado,
          tipoComprobante: g.tipoComprobante, puntoVenta: g.puntoVenta, comprobanteNumero: g.comprobanteNumero, esFiscal: g.esFiscal,
          items: g.items, observaciones: g.observaciones, moneda: g.moneda,
          totalPagado: g.totalPagado, saldoPendiente: g.saldoPendiente
        });
        for (const p of (g.pagos || [])) {
          movimientos.push({
            tipo: 'credito', monto: p.monto, fecha: p.fecha,
            concepto: `Pago — Gasto #${g.numero}`, origen: 'pago_gasto',
            docId: g._id, nota: p.nota, tipoValor: p.tipoValor
          });
        }
      }

      movimientos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
      const saldo = Math.round(movimientos.reduce((acc, m) => acc + (m.tipo === 'debito' ? m.monto : -m.monto), 0) * 100) / 100;

      return { proveedor, saldo, movimientos: movimientos.slice(0, limite) };
    });
    res.json(resultado);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
