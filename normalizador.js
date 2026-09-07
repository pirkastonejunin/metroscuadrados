// --------------------------------------------------------------------------
// Normalizador de listas de precios de proveedores -> Dux — módulo adicional
// para la app "Calculadora m2".
//
// Se monta como router Express dentro del server.js existente. Lee la MISMA
// base Mongo Atlas (db "calculadora_m2") que ya usa la app, y agrega dos
// colecciones propias de este módulo:
//   - normalizador_config       : documento único (_id: 'global') con el
//                                 margen de cada una de las 5 listas de venta
//                                 de Dux (Colocado, Contado, Lista, Mayorista,
//                                 Tiendanube), aplicado sobre el costo neto.
//   - normalizador_proveedores  : un documento por proveedor, con el mapeo de
//                                 columnas de su archivo, la cadena de
//                                 descuentos, el factor de conversión de
//                                 unidad, la tabla de equivalencia de
//                                 códigos (proveedor -> Dux), reglas
//                                 opcionales para extraer medida/m² por
//                                 caja/categoría/marca cuando vienen todas
//                                 mezcladas en la columna de descripción, y
//                                 fórmulas propias por lista de venta (por
//                                 defecto cada lista usa el margen general).
//
// El PARSEO del archivo Excel/CSV del proveedor y la GENERACIÓN de los dos
// archivos de importación de Dux se hacen en el navegador (normalizador.html,
// con la misma librería xlsx por CDN que ya usa admin.html) — este módulo
// solo guarda y devuelve configuración. No sube ni procesa archivos.
//
// Integración (en server.js):
//   const normalizadorRouter = require('./normalizador');
//   app.use('/api/normalizador', normalizadorRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const router = express.Router();

const DB_NAME = 'calculadora_m2';
const LISTAS = ['colocado', 'contado', 'lista', 'mayorista', 'tiendanube'];

let mongoClient;
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (err) {
      mongoClient = null;
      throw err;
    }
  }
  return mongoClient.db(DB_NAME);
}

async function conReintento(fn) {
  try {
    return await fn();
  } catch (err) {
    mongoClient = null; // fuerza reconexion, mismo patron que server.js/cotizador.js
    return await fn();
  }
}

function margenesPorDefecto() {
  const m = {};
  LISTAS.forEach((l) => { m[l] = 0; });
  return m;
}

// ---------------------- Configuración global (márgenes) ----------------------

router.get('/config', async (req, res) => {
  try {
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('normalizador_config').findOne({ _id: 'global' });
    });
    res.json({ margenes: (doc && doc.margenes) || margenesPorDefecto() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', async (req, res) => {
  try {
    const margenes = req.body.margenes || {};
    const limpio = {};
    LISTAS.forEach((l) => {
      const v = parseFloat(margenes[l]);
      limpio[l] = isNaN(v) ? 0 : v;
    });
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('normalizador_config').updateOne(
        { _id: 'global' },
        { $set: { margenes: limpio } },
        { upsert: true }
      );
    });
    res.json({ ok: true, margenes: limpio });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------- Perfiles de proveedor ---------------------------

const TIPOS_FORMULA = ['margen_general', 'multiplicador_costo', 'multiplicador_lista', 'multiplicador_campo', 'vacio'];

function limpiarProveedor(body) {
  const descuentos = String(body.descuentos || '')
    .split(',')
    .map((s) => parseFloat(String(s).trim().replace(',', '.')))
    .filter((n) => !isNaN(n));

  const equivalencias = {};
  String(body.equivalenciasTexto || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((linea) => {
      const idx = linea.indexOf('=');
      if (idx === -1) return;
      const codProveedor = linea.slice(0, idx).trim().toLowerCase();
      const codDux = linea.slice(idx + 1).trim();
      if (codProveedor && codDux) equivalencias[codProveedor] = codDux;
    });

  const listaDeTexto = (s) => String(s || '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  const rd = body.reglasDescripcion || {};
  const reglasDescripcion = {
    activo: !!rd.activo,
    vocabularioMarca: listaDeTexto(rd.vocabularioMarcaTexto),
    vocabularioCategoria: listaDeTexto(rd.vocabularioCategoriaTexto),
    vocabularioCalidad: listaDeTexto(rd.vocabularioCalidadTexto),
    categoriaPorDefecto: String(rd.categoriaPorDefecto || '').trim().toUpperCase(),
    // se guardan tal cual (sin normalizar) para poder re-editar en el form
    vocabularioMarcaTexto: String(rd.vocabularioMarcaTexto || ''),
    vocabularioCategoriaTexto: String(rd.vocabularioCategoriaTexto || ''),
    vocabularioCalidadTexto: String(rd.vocabularioCalidadTexto || '')
  };

  const formulas = {};
  LISTAS.forEach((l) => {
    const f = (body.formulas && body.formulas[l]) || {};
    const tipo = TIPOS_FORMULA.includes(f.tipo) ? f.tipo : 'margen_general';
    formulas[l] = {
      tipo,
      base: String(f.base || '').trim(),
      valor: (f.valor !== undefined && f.valor !== '' && !isNaN(parseFloat(f.valor))) ? parseFloat(f.valor) : null,
      campo: String(f.campo || '').trim()
    };
  });

  return {
    nombre: String(body.nombre || '').trim(),
    columnas: {
      codigo: String((body.columnas && body.columnas.codigo) || '').trim().toUpperCase(),
      descripcion: String((body.columnas && body.columnas.descripcion) || '').trim().toUpperCase(),
      precio: String((body.columnas && body.columnas.precio) || '').trim().toUpperCase(),
      stock: String((body.columnas && body.columnas.stock) || '').trim().toUpperCase()
    },
    filaInicio: parseInt(body.filaInicio, 10) || 2,
    descuentos,
    factorConversion: parseFloat(body.factorConversion) || 1,
    equivalencias,
    equivalenciasTexto: String(body.equivalenciasTexto || ''), // se guarda tal cual para poder re-editar en el form
    reglasDescripcion,
    formulas
  };
}

router.get('/proveedores', async (req, res) => {
  try {
    const lista = await conReintento(async () => {
      const db = await getDb();
      return db.collection('normalizador_proveedores').find({}).sort({ nombre: 1 }).toArray();
    });
    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/proveedores/:id', async (req, res) => {
  try {
    const doc = await conReintento(async () => {
      const db = await getDb();
      return db.collection('normalizador_proveedores').findOne({ _id: new ObjectId(req.params.id) });
    });
    if (!doc) return res.status(404).json({ error: 'No encontrado' });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/proveedores', async (req, res) => {
  try {
    const datos = limpiarProveedor(req.body);
    if (!datos.nombre) return res.status(400).json({ error: 'Falta el nombre del proveedor' });
    const resultado = await conReintento(async () => {
      const db = await getDb();
      return db.collection('normalizador_proveedores').insertOne(datos);
    });
    res.json({ ok: true, _id: resultado.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/proveedores/:id', async (req, res) => {
  try {
    const datos = limpiarProveedor(req.body);
    if (!datos.nombre) return res.status(400).json({ error: 'Falta el nombre del proveedor' });
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('normalizador_proveedores').updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: datos }
      );
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/proveedores/:id', async (req, res) => {
  try {
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('normalizador_proveedores').deleteOne({ _id: new ObjectId(req.params.id) });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
