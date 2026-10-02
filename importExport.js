// ---------------------------------------------------------------------------
// Import/Export genérico en Excel (.xlsx) — helper compartido por
// productos.js, clientes.js, proveedores.js, stock.js, ventas.js y
// compras.js (pedido de Mato, 30/9/2026: "todas las bases tengo que tener
// la posibilidad de importar y exportar").
//
// Decisiones de diseño:
//   - El archivo subido viaja como base64 dentro del JSON del body
//     ({ archivoBase64: "..." }), NO como multipart/form-data — así se
//     evita sumar la dependencia `multer` solo para esto, y se reusa el
//     mismo `express.json({limit:'15mb'})` que ya tiene toda la app.
//     15mb alcanza de sobra para una planilla de productos/clientes.
//   - `columnas` es un array de { clave, titulo, tipo?, aliases?,
//     mapaValores? } que define, EN ORDEN, las columnas del Excel tanto
//     al exportar como al importar. `tipo` puede ser 'texto' (default si
//     se omite), 'numero', 'fecha' o 'booleano' — controla cómo se
//     formatea al exportar y cómo se convierte el valor crudo de la
//     celda al importar. `aliases` (opcional) es una lista de otros
//     títulos de encabezado que también matchean esa columna — para
//     poder importar directo un Excel de otro sistema (Dux) sin que Mato
//     tenga que renombrar columnas a mano. `mapaValores` (opcional) es un
//     objeto { VALOR_CRUDO_EN_MAYUSCULAS: valorInterno } para traducir
//     valores que vienen distintos en el archivo de origen (ej: Dux usa
//     "PESOS"/"DOLARES" en vez de "ARS"/"USD").
//   - Al importar, el emparejamiento de columnas es por TÍTULO de
//     encabezado (normalizado: sin tildes, sin mayúsculas, sin espacios
//     de más), no por posición — así un Excel exportado de acá mismo (o
//     editado a mano respetando los títulos) siempre importa bien aunque
//     se reordenen o falten columnas opcionales.
//   - Cada router es responsable de: llamar a `parsearXlsxBase64`, y
//     después recorrer las filas aplicando SU PROPIA validación (la
//     misma función `validarX` que ya usa en POST/PUT) y upsert por la
//     clave natural del módulo (sku, código, cuit, etc.) — este helper
//     no sabe nada de colecciones ni de reglas de negocio, solo mueve
//     filas entre Excel y objetos JS.
//   - El resultado de un import siempre se reporta como
//     { creados, actualizados, errores: [{ fila, motivo }] } — nunca se
//     aborta todo el archivo por una fila mala, se saltea esa fila y se
//     informa en `errores` (fila 1 = encabezado, primera fila de datos
//     es la 2, igual que se ve en Excel).
// ---------------------------------------------------------------------------

const XLSX = require('xlsx');

function err(status, message) { return Object.assign(new Error(message), { status }); }

function normalizarEncabezado(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}

function formatearValorExport(v, tipo) {
  if (v === undefined || v === null) return '';
  if (tipo === 'fecha') {
    const d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('es-AR');
  }
  if (tipo === 'booleano') return v ? 'SI' : 'NO';
  if (v instanceof Date) return v.toLocaleDateString('es-AR');
  return v;
}

// `mapaValores` (opcional, por columna): traduce valores crudos del Excel
// a los valores internos de la app ANTES de aplicar `tipo` — pensado para
// poder importar un Excel que ya viene de otro sistema (ej: Dux) con sus
// propios textos ("PESOS"/"DOLARES", "S"/"N") sin tener que pedirle a
// Mato que edite el archivo a mano. La clave de `mapaValores` se compara
// en MAYÚSCULAS y sin espacios extra (no hace falta sacar tildes: los
// valores enum que usamos hoy no las llevan).
function convertirValorImport(v, tipo, mapaValores) {
  if (v === '' || v === undefined || v === null) return null;
  if (mapaValores) {
    const clave = String(v).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(mapaValores, clave)) {
      v = mapaValores[clave];
    }
  }
  if (v === '' || v === undefined || v === null) return null;
  if (tipo === 'numero') {
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (tipo === 'booleano') {
    const s = String(v).trim().toLowerCase();
    // 's'/'n' sueltas: así vienen los checkbox de Dux en su export
    // ("STOCKEABLE", "ACEPTA STOCK NEGATIVO", etc. son S/N, no SI/NO).
    return ['si', 'sí', 's', 'true', '1', 'x'].includes(s);
  }
  if (tipo === 'fecha') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return String(v).trim();
}

// Genera y envía un .xlsx descargable con las `columnas` dadas, a partir
// de un array de objetos `filas` (cada fila lee sus valores de
// fila[columna.clave]).
function exportarXlsx(res, nombreArchivo, columnas, filas) {
  const encabezados = columnas.map(c => c.titulo);
  const datos = filas.map(fila => columnas.map(c => formatearValorExport(fila[c.clave], c.tipo)));
  const ws = XLSX.utils.aoa_to_sheet([encabezados, ...datos]);
  // Ancho de columna aproximado, para que no quede todo apretado al abrir
  // en Excel/Sheets — no es crítico, solo prolijidad.
  ws['!cols'] = columnas.map(c => ({ wch: Math.max(12, c.titulo.length + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Datos');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
}

// Genera un .xlsx "plantilla" con solo los encabezados (sin filas) — para
// que el botón "Descargar plantilla" de cada módulo le dé a Mato un
// Excel con las columnas correctas ya armadas, listo para completar.
function exportarPlantillaXlsx(res, nombreArchivo, columnas) {
  exportarXlsx(res, nombreArchivo, columnas, []);
}

// Recibe el base64 de un .xlsx (tal cual lo manda el browser, con o sin
// el prefijo "data:...;base64,") y devuelve un array de filas { clave:
// valor, ... } según `columnas`, usando la PRIMERA hoja del archivo.
// Cada fila trae además `__fila` (número de fila en el Excel, para poder
// señalar errores puntuales al usuario).
// `mapeoManual` (opcional) = { clave: tituloEncabezadoReal } — equivalencia
// elegida A MANO por Mato cuando el archivo no trae los títulos/aliases
// esperados (2/10/2026, pedido de Mato: "que me deje elegir equivalencia
// de columna cuando no coincide con la plantilla"). Se suma como un
// alias más de esa columna, con prioridad sobre el automático: ver
// leerEncabezadosXlsxBase64 y sugerirMapeo más abajo, que son los que le
// arman a la pantalla de import la lista de encabezados reales del
// archivo para que arme ese mapeo.
function parsearXlsxBase64(base64, columnas, mapeoManual) {
  if (!base64) throw err(400, 'Falta el archivo (.xlsx)');
  let buffer;
  try {
    buffer = Buffer.from(String(base64).replace(/^data:.*;base64,/, ''), 'base64');
  } catch (e) {
    throw err(400, 'El archivo no es un base64 válido');
  }
  if (!buffer.length) throw err(400, 'El archivo está vacío');
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    throw err(400, 'No se pudo leer el archivo — ¿es un .xlsx válido?');
  }
  const nombreHoja = wb.SheetNames[0];
  if (!nombreHoja) throw err(400, 'El Excel no tiene ninguna hoja');
  const hoja = wb.Sheets[nombreHoja];
  const filasCrudas = XLSX.utils.sheet_to_json(hoja, { defval: '', raw: false });
  // `aliases` (opcional, por columna): otros títulos de encabezado que
  // también deben reconocerse como esa misma columna — para poder
  // importar directamente un Excel que viene de otro sistema (ej: el
  // export de productos de Dux trae "CODIGO"/"PRODUCTO"/"UNIDAD MEDIDA"
  // en vez de nuestros títulos "SKU (Código)"/"Nombre"/"Unidad") sin
  // pedirle a Mato que renombre columnas a mano.
  const columnaPorTitulo = new Map();
  columnas.forEach(c => {
    columnaPorTitulo.set(normalizarEncabezado(c.titulo), c);
    (c.aliases || []).forEach(a => columnaPorTitulo.set(normalizarEncabezado(a), c));
  });
  if (mapeoManual) {
    for (const [clave, tituloReal] of Object.entries(mapeoManual)) {
      if (!tituloReal) continue;
      const columna = columnas.find(c => c.clave === clave);
      if (columna) columnaPorTitulo.set(normalizarEncabezado(tituloReal), columna);
    }
  }
  return filasCrudas.map((filaCruda, idx) => {
    const fila = {};
    for (const [encabezado, valor] of Object.entries(filaCruda)) {
      const columna = columnaPorTitulo.get(normalizarEncabezado(encabezado));
      if (!columna) continue; // columna no reconocida — se ignora, no es error
      fila[columna.clave] = convertirValorImport(valor, columna.tipo, columna.mapaValores);
    }
    Object.defineProperty(fila, '__fila', { value: idx + 2, enumerable: false });
    return fila;
  });
}

// Lee solo los encabezados (primera fila) de un .xlsx en base64 — se usa
// ANTES de importar de verdad, para mostrarle a Mato qué columnas trae
// el archivo y dejarlo elegir a mano la equivalencia cuando no coinciden
// con la plantilla.
function leerEncabezadosXlsxBase64(base64) {
  if (!base64) throw err(400, 'Falta el archivo (.xlsx)');
  let buffer;
  try {
    buffer = Buffer.from(String(base64).replace(/^data:.*;base64,/, ''), 'base64');
  } catch (e) {
    throw err(400, 'El archivo no es un base64 válido');
  }
  if (!buffer.length) throw err(400, 'El archivo está vacío');
  let wb;
  try {
    // `sheetRows: 2` (2/10/2026 — bug reportado por Mato: "Unexpected end
    // of JSON input" al importar): sin esto, leer solo los encabezados
    // igual parseaba el archivo ENTERO (con el catálogo real, ~20.000
    // filas) — y como esto se agregó como un paso previo al import real,
    // ahora se parseaba el mismo archivo grande dos veces seguidas antes
    // de empezar a guardar nada, lo que en Render alcanzaba a cortar la
    // conexión (mismo síntoma ya visto antes con el import de Productos,
    // ver comentario de TANDA_IMPORT más abajo). Con `sheetRows` la
    // librería deja de leer el resto de las filas apenas tiene el
    // encabezado, así que esto queda rápido sin importar el tamaño real
    // del archivo.
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheetRows: 2 });
  } catch (e) {
    throw err(400, 'No se pudo leer el archivo — ¿es un .xlsx válido?');
  }
  const nombreHoja = wb.SheetNames[0];
  if (!nombreHoja) throw err(400, 'El Excel no tiene ninguna hoja');
  const hoja = wb.Sheets[nombreHoja];
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: false, defval: '' });
  const encabezados = (filas[0] || []).map(h => String(h == null ? '' : h).trim()).filter(Boolean);
  if (!encabezados.length) throw err(400, 'El Excel no tiene encabezados en la primera fila');
  return encabezados;
}

// Dados los encabezados REALES de un archivo y las `columnas` esperadas,
// arma una sugerencia automática de qué encabezado le corresponde a cada
// columna (misma lógica de título/alias que usa parsearXlsxBase64) —
// para prellenar la pantalla de equivalencias y que Mato solo tenga que
// corregir las que de verdad no coinciden.
function sugerirMapeo(encabezados, columnas) {
  const tituloPorNormalizado = new Map();
  columnas.forEach(c => {
    tituloPorNormalizado.set(normalizarEncabezado(c.titulo), c);
    (c.aliases || []).forEach(a => tituloPorNormalizado.set(normalizarEncabezado(a), c));
  });
  const sugeridos = {};
  columnas.forEach(c => { sugeridos[c.clave] = null; });
  encabezados.forEach(h => {
    const columna = tituloPorNormalizado.get(normalizarEncabezado(h));
    if (columna && !sugeridos[columna.clave]) sugeridos[columna.clave] = h;
  });
  return sugeridos;
}

module.exports = { exportarXlsx, exportarPlantillaXlsx, parsearXlsxBase64, leerEncabezadosXlsxBase64, sugerirMapeo };
