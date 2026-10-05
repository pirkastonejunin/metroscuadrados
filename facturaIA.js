// ---------------------------------------------------------------------------
// Lectura de facturas con IA (5/10/2026, pedido de Mato) — se saca una foto,
// o se sube un PDF u otro archivo, de una factura de compra o de gasto y
// la IA (Claude, con visión) extrae: proveedor, CUIT, tipo/punto de
// venta/número, fecha, moneda, ítems, IVA, percepciones, retenciones,
// impuesto al crédito/débito y otros impuestos.
//
// Reglas que definió Mato:
//   - Si el proveedor no existe, se puede crear solo desde la factura.
//   - Si un ítem de la factura no coincide con un producto del catálogo,
//     el sistema PREGUNTA (vincular a uno existente o crear uno nuevo);
//     nunca inventa ni ignora un ítem. Por eso acá solo se auto-vincula
//     con coincidencia exacta de SKU o nombre casi idéntico; todo lo demás
//     vuelve sin vincular, con candidatos sugeridos.
//   - Solo se desglosan IVA, percepciones, retenciones, impuesto al
//     crédito, impuesto al débito e ingresos brutos; el resto va junto en
//     "otros impuestos".
//   - Acepta foto, PDF o cualquier archivo que se pueda leer (planillas
//     Excel/CSV y texto incluidos).
//
// Configuración (variables de entorno en Render):
//   Proveedor de IA (se usa el primero que tenga clave):
//   GEMINI_API_KEY       clave de la API de Google Gemini (aistudio.google.com).
//   GEMINI_MODEL         opcional — modelo de Gemini (default: gemini-3.8-flash).
//   ANTHROPIC_API_KEY    clave de la API de Anthropic.
//   FACTURA_IA_MODEL     opcional — modelo de Anthropic (default: claude-sonnet-5-5).
//   FACTURA_IA_PROVEEDOR opcional — fuerza "gemini" o "anthropic" si hay las dos claves.
//
// Uso (en compras.js y gastos.js):
//   require('./facturaIA').registrarRutasFacturaIA(router, { modo, authAdmin, getDb,
//     conReintento, filtroOrg });
// Agrega POST /leer-factura y POST /proveedor-rapido al router.
// ---------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_MODELO_DEFAULT = 'gemini-3.8-flash';
const MODELO_DEFAULT = 'claude-sonnet-5-5';
const MAX_BYTES_ARCHIVO = 20 * 1024 * 1024;
const MAX_CARACTERES_TEXTO = 60000;
const TIMEOUT_MS = 120000;

const TIPOS_COMPROBANTE = [
  'factura_a', 'factura_b', 'factura_c', 'factura_m',
  'nota_credito_a', 'nota_credito_b', 'nota_credito_c', 'nota_credito_m',
  'nota_debito_a', 'nota_debito_b', 'nota_debito_c', 'nota_debito_m',
  'recibo', 'ticket', 'otro'
];
const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27];
const CLAVES_PERCEPCION = ['iva', 'iibb', 'ganancias', 'otra'];
const CLAVES_RETENCION = ['iva', 'iibb', 'ganancias', 'suss', 'otra'];

function err(status, message) { return Object.assign(new Error(message), { status }); }
function redondear2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ---------------------------------------------------------------------------
// Utilidades de texto / CUIT
// ---------------------------------------------------------------------------

function soloDigitos(s) { return String(s === undefined || s === null ? '' : s).replace(/\D/g, ''); }

// Dígito verificador del CUIT/CUIL (módulo 11, pesos 5-4-3-2-7-6-5-4-3-2).
function cuitValido(cuit) {
  const d = soloDigitos(cuit);
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(d[i]) * pesos[i];
  let verif = 11 - (suma % 11);
  if (verif === 11) verif = 0;
  if (verif === 10) verif = 9; // casos especiales: la AFIP asigna 9 (o cambia el prefijo)
  return verif === Number(d[10]);
}
function formatearCuit(cuit) {
  const d = soloDigitos(cuit);
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : String(cuit || '').trim();
}

function normalizarTextoBusqueda(s) {
  return String(s === undefined || s === null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    // "50kg" y "50 kg" tienen que dar lo mismo: separa número y letras pegados.
    .replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ').trim();
}
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'con', 'para', 'por', 'sa', 'srl', 'sas', 'x', 'un', 'una']);
function tokens(s) {
  return normalizarTextoBusqueda(s).split(' ').filter(t => t && !PALABRAS_VACIAS.has(t) && (t.length > 1 || /\d/.test(t)));
}
// Coeficiente de Dice sobre conjuntos de tokens: 1 = mismos tokens.
function similitud(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  return (2 * inter) / (A.size + B.size);
}
function escaparRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// Regex que ignora acentos en las vocales (los nombres del catálogo
// pueden estar guardados con tilde).
function regexTokenSinAcentos(token) {
  const mapa = { a: '[aáàäâ]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöô]', u: '[uúùüû]', n: '[nñ]' };
  return escaparRegex(token).replace(/[aeioun]/g, c => mapa[c]);
}

function numero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v === undefined || v === null || v === '') return 0;
  let s = String(v).trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  // Formato argentino "1.234,56" → 1234.56; formato "1234.56" se respeta.
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Armado del pedido a la IA según el tipo de archivo
// ---------------------------------------------------------------------------

function tipoDeArchivo(mimeType, nombre) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  const ext = (String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (/^image\/(jpeg|jpg|png|gif|webp|heic|heif|bmp|tiff?)$/.test(mime) || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'].includes(ext)) return 'imagen';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (/spreadsheet|ms-excel|opendocument\.spreadsheet/.test(mime) || ['xlsx', 'xls', 'ods'].includes(ext)) return 'planilla';
  if (mime === 'text/csv' || ext === 'csv') return 'csv';
  if (mime.startsWith('text/') || ['txt', 'xml', 'json', 'md'].includes(ext) || /json|xml/.test(mime)) return 'texto';
  return null;
}

// Las fotos de celular suelen pasar los 5 MB que admite la API por
// imagen: se corrige la orientación y se reduce a ~2200 px de lado
// (suficiente para leer una factura) como JPEG.
async function prepararImagen(buffer) {
  let sharp;
  try { sharp = require('sharp'); } catch (e) { sharp = null; }
  if (!sharp) {
    if (buffer.length > 4.5 * 1024 * 1024) throw err(400, 'La imagen es muy pesada. Sacá la foto de nuevo con menos resolución o subí un PDF.');
    return { buffer, mediaType: detectarMediaTypeImagen(buffer) };
  }
  try {
    const salida = await sharp(buffer).rotate().resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    return { buffer: salida, mediaType: 'image/jpeg' };
  } catch (e) {
    throw err(400, 'No pude leer esa imagen. Probá con una foto en JPG o PNG, o subí la factura en PDF.');
  }
}
function detectarMediaTypeImagen(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

function planillaATexto(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const partes = [];
  wb.SheetNames.slice(0, 3).forEach(nombre => {
    partes.push(`--- Hoja: ${nombre} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[nombre]));
  });
  return partes.join('\n\n');
}

async function armarContenidoArchivo({ base64, mimeType, nombreArchivo }) {
  if (!base64 || typeof base64 !== 'string') throw err(400, 'Falta el archivo de la factura.');
  const limpio = base64.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(limpio, 'base64');
  if (!buffer.length) throw err(400, 'El archivo está vacío.');
  if (buffer.length > MAX_BYTES_ARCHIVO) throw err(400, 'El archivo es demasiado grande (máximo 20 MB).');
  const tipo = tipoDeArchivo(mimeType, nombreArchivo);
  if (!tipo) throw err(400, 'No puedo leer ese tipo de archivo. Usá una foto (JPG/PNG), un PDF, una planilla Excel/CSV o un archivo de texto.');

  if (tipo === 'imagen') {
    const { buffer: img, mediaType } = await prepararImagen(buffer);
    return [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: img.toString('base64') } }];
  }
  if (tipo === 'pdf') {
    return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }];
  }
  let texto;
  try {
    texto = (tipo === 'planilla') ? planillaATexto(buffer) : buffer.toString('utf8');
  } catch (e) {
    throw err(400, 'No pude abrir ese archivo. Verificá que no esté dañado o protegido con contraseña.');
  }
  if (!texto.trim()) throw err(400, 'El archivo no tiene contenido legible.');
  if (texto.length > MAX_CARACTERES_TEXTO) texto = texto.slice(0, MAX_CARACTERES_TEXTO);
  return [{ type: 'text', text: `Contenido del archivo "${nombreArchivo || 'factura'}":\n\n${texto}` }];
}

// ---------------------------------------------------------------------------
// Instrucciones y esquema de salida
// ---------------------------------------------------------------------------

const INSTRUCCIONES = `Sos un asistente que carga facturas de compra y de gastos en el sistema de gestión de una empresa argentina (Grupo Piedra Negra, materiales de construcción). Recibís la foto, el PDF o el archivo de un comprobante que un PROVEEDOR le emitió a la empresa, y devolvés sus datos llamando a la herramienta "registrar_factura".

Reglas:
- "proveedor" es el EMISOR del comprobante (quien vende), nunca el comprador. El CUIT es el del emisor (11 dígitos).
- Tipo de comprobante: "Factura A/B/C/M" → factura_a/b/c/m; "Nota de Crédito" y "Nota de Débito" con su letra; "Recibo" → recibo; ticket o ticket-factura → ticket; remitos, presupuestos u otros → otro.
- Punto de venta y número: "0001-00001234" → puntoVenta "0001", numero "00001234" (conservá los ceros).
- Fecha de emisión en formato AAAA-MM-DD. Moneda ARS salvo que el comprobante esté claramente en dólares.
- Importes como números con punto decimal (los comprobantes argentinos usan "1.234,56" = 1234.56). Nunca inventes datos: lo que no se lea o no figure, dejalo vacío o en 0 y agregalo a "avisos".
- Ítems: una entrada por línea del comprobante, con su código si lo tiene (el código/SKU del proveedor), descripción tal como figura, cantidad y precio unitario. En Factura A y M el precio unitario es SIN IVA y la alícuota es la de cada línea (21, 10.5, 27, etc.). En Factura B/C, tickets y comprobantes sin IVA discriminado, usá alícuota 0 y el precio tal como figura. Si una línea tiene bonificación o descuento propio, dejá el precio ya descontado y avisalo. Si un comprobante de servicios (luz, gas, teléfono, internet, alquiler, etc.) no detalla ítems, cargá una línea por cada concepto principal facturado, o una sola con el neto gravado.
- Impuestos: SOLO se desglosan el IVA (ya incluido por línea mediante la alícuota; informá el total en ivaTotal), las percepciones (IVA, Ingresos Brutos "iibb", Ganancias u otra), las retenciones (IVA, iibb, Ganancias, SUSS u otra), el impuesto al crédito bancario, el impuesto al débito bancario (Ley 25.413) y las percepciones/retenciones de Ingresos Brutos. TODO LO DEMÁS (impuestos internos, tasas municipales, fondos, cargos y contribuciones, impuesto PAIS, etc.) se suma en un único importe "otrosImpuestos". No dupliques: un importe va en un solo lugar.
- "totales.neto" es el subtotal sin IVA ni impuestos; "totales.total" es el importe total final del comprobante tal como figura.
- Si el archivo no es un comprobante de compra o gasto, devolvé esComprobante en false.
- En "avisos" anotá, en español y en frases cortas, cualquier duda de lectura (texto borroso, importe ilegible, línea cortada, etc.).`;

const HERRAMIENTA = {
  name: 'registrar_factura',
  description: 'Registra los datos leídos de la factura o comprobante.',
  input_schema: {
    type: 'object',
    properties: {
      esComprobante: { type: 'boolean' },
      proveedor: {
        type: 'object',
        properties: {
          razonSocial: { type: 'string' },
          cuit: { type: 'string', description: 'CUIT del emisor, con o sin guiones' },
          domicilio: { type: 'string' }
        }
      },
      comprobante: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: TIPOS_COMPROBANTE },
          puntoVenta: { type: 'string' },
          numero: { type: 'string' },
          fecha: { type: 'string', description: 'AAAA-MM-DD' },
          moneda: { type: 'string', enum: ['ARS', 'USD'] }
        }
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            codigo: { type: 'string' },
            descripcion: { type: 'string' },
            cantidad: { type: 'number' },
            precioUnitario: { type: 'number' },
            alicuotaIva: { type: 'number', enum: ALICUOTAS_IVA }
          },
          required: ['descripcion', 'cantidad', 'precioUnitario', 'alicuotaIva']
        }
      },
      impuestos: {
        type: 'object',
        properties: {
          ivaTotal: { type: 'number' },
          percepciones: {
            type: 'array',
            items: { type: 'object', properties: { tipo: { type: 'string', enum: CLAVES_PERCEPCION }, monto: { type: 'number' }, detalle: { type: 'string' } }, required: ['tipo', 'monto'] }
          },
          retenciones: {
            type: 'array',
            items: { type: 'object', properties: { tipo: { type: 'string', enum: CLAVES_RETENCION }, monto: { type: 'number' }, detalle: { type: 'string' } }, required: ['tipo', 'monto'] }
          },
          impuestoCredito: { type: 'number' },
          impuestoDebito: { type: 'number' },
          otrosImpuestos: { type: 'number' }
        }
      },
      totales: { type: 'object', properties: { neto: { type: 'number' }, total: { type: 'number' } } },
      avisos: { type: 'array', items: { type: 'string' } }
    },
    required: ['esComprobante', 'proveedor', 'comprobante', 'items', 'impuestos', 'totales']
  }
};

function proveedorIA() {
  const forzado = String(process.env.FACTURA_IA_PROVEEDOR || '').toLowerCase();
  if (forzado === 'gemini' || forzado === 'anthropic') return forzado;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'anthropic';
}

// Gemini no acepta enums numéricos en el esquema: se sacan (la normalización
// posterior ya ajusta las alícuotas a los valores válidos).
function esquemaParaGemini(nodo) {
  if (Array.isArray(nodo)) return nodo.map(esquemaParaGemini);
  if (!nodo || typeof nodo !== 'object') return nodo;
  const out = {};
  for (const k of Object.keys(nodo)) {
    if (k === 'enum' && nodo.type === 'number') continue;
    out[k] = esquemaParaGemini(nodo[k]);
  }
  return out;
}

function partesGemini(contenidoArchivo) {
  const partes = contenidoArchivo.map(b => {
    if (b.type === 'text') return { text: b.text };
    return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
  });
  partes.push({ text: 'Leé este comprobante y devolvé sus datos en el formato pedido.' });
  return partes;
}

async function pedirAlServicio(url, opciones) {
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opciones, { signal: controlador.signal }));
  } catch (e) {
    if (e.name === 'AbortError') throw err(504, 'La IA tardó demasiado en leer la factura. Probá de nuevo.');
    throw err(502, 'No se pudo conectar con el servicio de IA: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function llamarGemini(contenidoArchivo) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw err(503, 'La lectura de facturas con IA todavía no está configurada: falta la variable GEMINI_API_KEY en el servidor.');
  const modelo = process.env.GEMINI_MODEL || GEMINI_MODELO_DEFAULT;
  const resp = await pedirAlServicio(GEMINI_URL + encodeURIComponent(modelo) + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCCIONES.replace('llamando a la herramienta "registrar_factura"', 'como un objeto JSON con el esquema indicado') }] },
      contents: [{ role: 'user', parts: partesGemini(contenidoArchivo) }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: esquemaParaGemini(HERRAMIENTA.input_schema), temperature: 0 }
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detalle = (data && data.error && data.error.message) ? data.error.message : ('estado ' + resp.status);
    if (resp.status === 401 || resp.status === 403 || /API key not valid|API_KEY_INVALID/i.test(detalle)) throw err(502, 'La clave de la IA (GEMINI_API_KEY) no es válida.');
    if (resp.status === 429) throw err(429, 'Se superó el límite de uso de la IA (el plan gratuito tiene un tope diario). Esperá un momento y probá de nuevo.');
    throw err(502, 'El servicio de IA devolvió un error: ' + detalle);
  }
  const cand = (data.candidates || [])[0];
  const texto = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(x => x.text || '').join('') : '';
  if (!texto) {
    const bloqueo = data.promptFeedback && data.promptFeedback.blockReason;
    throw err(502, 'La IA no devolvió datos de la factura' + (bloqueo ? ' (' + bloqueo + ')' : '') + '. Probá con una foto más nítida.');
  }
  let json;
  try { json = JSON.parse(texto.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch (e) { throw err(502, 'La IA devolvió una respuesta que no se pudo interpretar. Probá de nuevo.'); }
  if (data.usageMetadata) console.log(`[facturaIA] modelo=${modelo} tokens_in=${data.usageMetadata.promptTokenCount} tokens_out=${data.usageMetadata.candidatesTokenCount}`);
  return json;
}

async function llamarIA(contenidoArchivo) {
  if (proveedorIA() === 'gemini') return llamarGemini(contenidoArchivo);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw err(503, 'La lectura de facturas con IA todavía no está configurada: falta la variable GEMINI_API_KEY (o ANTHROPIC_API_KEY) en el servidor.');
  const modelo = process.env.FACTURA_IA_MODEL || MODELO_DEFAULT;
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelo,
        max_tokens: 8000,
        system: INSTRUCCIONES,
        tools: [HERRAMIENTA],
        tool_choice: { type: 'tool', name: HERRAMIENTA.name },
        messages: [{ role: 'user', content: contenidoArchivo.concat([{ type: 'text', text: 'Leé este comprobante y registrá sus datos.' }]) }]
      }),
      signal: controlador.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw err(504, 'La IA tardó demasiado en leer la factura. Probá de nuevo.');
    throw err(502, 'No se pudo conectar con el servicio de IA: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detalle = (data && data.error && data.error.message) ? data.error.message : ('estado ' + resp.status);
    if (resp.status === 401) throw err(502, 'La clave de la IA (ANTHROPIC_API_KEY) no es válida.');
    if (resp.status === 429) throw err(429, 'Se superó el límite de uso de la IA. Esperá un momento y probá de nuevo.');
    throw err(502, 'El servicio de IA devolvió un error: ' + detalle);
  }
  const bloque = (data.content || []).find(b => b.type === 'tool_use' && b.name === HERRAMIENTA.name);
  if (!bloque || !bloque.input) throw err(502, 'La IA no devolvió datos de la factura. Probá con una foto más nítida.');
  if (data.usage) console.log(`[facturaIA] modelo=${modelo} tokens_in=${data.usage.input_tokens} tokens_out=${data.usage.output_tokens}`);
  return bloque.input;
}

// ---------------------------------------------------------------------------
// Normalización de lo que devuelve la IA
// ---------------------------------------------------------------------------

function padIzq(valor, largo) {
  const d = soloDigitos(valor);
  return d ? d.padStart(largo, '0') : '';
}

function normalizarResultado(crudo) {
  const avisos = Array.isArray(crudo.avisos) ? crudo.avisos.map(a => String(a).trim()).filter(Boolean) : [];
  const prov = crudo.proveedor || {};
  const comp = crudo.comprobante || {};
  const imp = crudo.impuestos || {};
  const tot = crudo.totales || {};

  const cuitCrudo = String(prov.cuit || '').trim();
  const cuitOk = cuitCrudo ? cuitValido(cuitCrudo) : false;
  if (cuitCrudo && !cuitOk) avisos.push(`El CUIT leído (${cuitCrudo}) no tiene un dígito verificador válido: puede haberse leído mal. Revisalo contra la factura.`);
  if (!cuitCrudo) avisos.push('No se pudo leer el CUIT del proveedor.');

  let tipoComprobante = TIPOS_COMPROBANTE.includes(comp.tipo) ? comp.tipo : '';
  if (!tipoComprobante) avisos.push('No se pudo determinar el tipo de comprobante: elegilo a mano.');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(comp.fecha || '')) ? comp.fecha : '';
  if (!fecha) avisos.push('No se pudo leer la fecha del comprobante.');

  const items = (Array.isArray(crudo.items) ? crudo.items : []).map(it => {
    const alicuota = numero(it.alicuotaIva);
    return {
      codigo: String(it.codigo || '').trim(),
      descripcion: String(it.descripcion || '').trim(),
      cantidad: numero(it.cantidad) > 0 ? numero(it.cantidad) : 1,
      precioUnitario: Math.max(0, numero(it.precioUnitario)),
      alicuotaIva: ALICUOTAS_IVA.includes(alicuota) ? alicuota : 21
    };
  }).filter(it => it.descripcion || it.codigo);

  const lineas = (arr, claves) => (Array.isArray(arr) ? arr : [])
    .map(l => ({ tipo: claves.includes(l.tipo) ? l.tipo : 'otra', monto: redondear2(numero(l.monto)), nota: String(l.detalle || '').trim() }))
    .filter(l => l.monto > 0);
  const impuestos = {
    ivaTotal: redondear2(numero(imp.ivaTotal)),
    percepciones: lineas(imp.percepciones, CLAVES_PERCEPCION),
    retenciones: lineas(imp.retenciones, CLAVES_RETENCION),
    impuestoCredito: Math.max(0, redondear2(numero(imp.impuestoCredito))),
    impuestoDebito: Math.max(0, redondear2(numero(imp.impuestoDebito))),
    otrosImpuestos: Math.max(0, redondear2(numero(imp.otrosImpuestos)))
  };

  // Control cruzado: ítems + IVA + percepciones + crédito/débito + otros
  // contra el total impreso. Una diferencia suele ser una línea mal
  // leída; se avisa para que se revise antes de guardar. Las retenciones
  // no entran: no forman parte del total de la factura.
  const totalDeclarado = redondear2(numero(tot.total));
  const totalCalculado = redondear2(
    items.reduce((a, it) => a + it.cantidad * it.precioUnitario * (1 + it.alicuotaIva / 100), 0) +
    impuestos.percepciones.reduce((a, l) => a + l.monto, 0) +
    impuestos.impuestoCredito + impuestos.impuestoDebito + impuestos.otrosImpuestos
  );
  if (totalDeclarado > 0 && Math.abs(totalCalculado - totalDeclarado) > Math.max(1, totalDeclarado * 0.005)) {
    avisos.push(`La suma de los ítems e impuestos leídos ($ ${totalCalculado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}) no coincide con el total de la factura ($ ${totalDeclarado.toLocaleString('es-AR', { minimumFractionDigits: 2 })}). Revisá los importes antes de guardar.`);
  }
  if (!items.length && crudo.esComprobante !== false) avisos.push('No se pudo leer ningún ítem de la factura.');

  return {
    esComprobante: crudo.esComprobante !== false,
    proveedor: {
      razonSocial: String(prov.razonSocial || '').trim(),
      cuit: cuitCrudo ? formatearCuit(cuitCrudo) : '',
      cuitValido: cuitOk,
      domicilio: String(prov.domicilio || '').trim()
    },
    comprobante: {
      tipoComprobante,
      puntoVenta: padIzq(comp.puntoVenta, 4),
      comprobanteNumero: padIzq(comp.numero, 8),
      fecha,
      moneda: comp.moneda === 'USD' ? 'USD' : 'ARS'
    },
    items, impuestos,
    totales: { neto: redondear2(numero(tot.neto)), total: totalDeclarado, totalCalculado },
    avisos
  };
}

// ---------------------------------------------------------------------------
// Coincidencias con los datos de la empresa
// ---------------------------------------------------------------------------

async function buscarProveedor(db, filtro, prov) {
  const lista = await db.collection('proveedores')
    .find(Object.assign({ activo: { $ne: false } }, filtro))
    .project({ razonSocial: 1, nombreFantasia: 1, cuit: 1, numeroDocumento: 1, condicionPago: 1 })
    .limit(5000).toArray();
  const cuitBuscado = soloDigitos(prov.cuit);
  if (cuitBuscado.length === 11) {
    const porCuit = lista.find(p => soloDigitos(p.cuit) === cuitBuscado || soloDigitos(p.numeroDocumento) === cuitBuscado);
    if (porCuit) return { proveedor: porCuit, criterio: 'cuit' };
  }
  const nombre = normalizarTextoBusqueda(prov.razonSocial);
  if (nombre) {
    const porNombre = lista.find(p => normalizarTextoBusqueda(p.razonSocial) === nombre || normalizarTextoBusqueda(p.nombreFantasia) === nombre);
    if (porNombre) return { proveedor: porNombre, criterio: 'nombre' };
  }
  return { proveedor: null, criterio: null };
}

// Auto-vincula SOLO con SKU exacto o un nombre prácticamente idéntico y
// sin otro candidato parecido; en cualquier otro caso devuelve candidatos
// para que la persona decida (pedido de Mato: "que nos pregunte").
async function buscarProducto(db, filtro, item) {
  const candidatos = new Map();
  const agregar = (p, score, criterio) => {
    const clave = String(p._id);
    const previo = candidatos.get(clave);
    if (!previo || score > previo.score) candidatos.set(clave, { _id: p._id, sku: p.sku || '', nombre: p.nombre || '', costo: p.costo === undefined ? null : p.costo, score, criterio });
  };
  const base = Object.assign({ activo: { $ne: false } }, filtro);
  const proy = { sku: 1, nombre: 1, costo: 1 };

  const codigo = String(item.codigo || '').trim();
  if (codigo) {
    const porSku = await db.collection('productos_catalogo').find(Object.assign({ sku: { $regex: '^' + escaparRegex(codigo) + '$', $options: 'i' } }, base)).project(proy).limit(3).toArray();
    porSku.forEach(p => agregar(p, 1, 'sku'));
  }
  const toks = tokens(item.descripcion).sort((a, b) => b.length - a.length).slice(0, 4);
  if (toks.length) {
    const porNombre = await db.collection('productos_catalogo')
      .find(Object.assign({ $or: toks.map(t => ({ nombre: { $regex: regexTokenSinAcentos(t), $options: 'i' } })) }, base))
      .project(proy).limit(60).toArray();
    porNombre.forEach(p => agregar(p, similitud(item.descripcion, p.nombre), 'nombre'));
  }
  const ordenados = Array.from(candidatos.values()).sort((a, b) => b.score - a.score);
  const mejor = ordenados[0];
  const segundo = ordenados[1];
  const seguro = mejor && (
    mejor.criterio === 'sku' ||
    (mejor.score >= 0.85 && (!segundo || segundo.score < mejor.score - 0.1))
  );
  return {
    producto: seguro ? mejor : null,
    candidatos: ordenados.filter(c => c.score >= 0.4).slice(0, 5)
  };
}

// Para Gastos: las líneas son conceptos de gasto, no productos.
async function buscarConcepto(db, filtro, item) {
  const lista = await db.collection('gastos_conceptos').find(Object.assign({ activo: { $ne: false } }, filtro)).project({ nombre: 1 }).limit(2000).toArray();
  const ordenados = lista.map(c => ({ _id: c._id, nombre: c.nombre, score: similitud(item.descripcion, c.nombre) })).sort((a, b) => b.score - a.score);
  const mejor = ordenados[0];
  const segundo = ordenados[1];
  const seguro = mejor && mejor.score >= 0.85 && (!segundo || segundo.score < mejor.score - 0.1);
  return { concepto: seguro ? mejor : null, candidatos: ordenados.filter(c => c.score >= 0.4).slice(0, 5) };
}

// Crea un proveedor mínimo desde los datos de la factura. Mismo gate de
// CUIT único que el módulo Proveedores.
async function crearProveedorRapido(db, req, filtro, datos) {
  const razonSocial = String(datos.razonSocial || '').trim();
  if (!razonSocial) throw err(400, 'La razón social del proveedor es obligatoria.');
  const cuit = datos.cuit ? formatearCuit(datos.cuit) : '';
  if (cuit) {
    const d = soloDigitos(cuit);
    const existentes = await db.collection('proveedores').find(Object.assign({ activo: { $ne: false } }, filtro)).project({ razonSocial: 1, cuit: 1 }).limit(5000).toArray();
    const dupe = existentes.find(p => soloDigitos(p.cuit) === d);
    if (dupe) throw err(400, `Ya hay un proveedor activo con el CUIT "${cuit}" (${dupe.razonSocial}).`);
  }
  const ahora = new Date();
  const nuevo = {
    codigo: null, razonSocial, nombreFantasia: '', rubro: '', categoriaFiscal: null,
    tipoDocumento: cuit ? 'cuit' : null, numeroDocumento: cuit || '', cuit: cuit || null,
    condicionPago: '', diasPago: null, moneda: null,
    banco: '', cbu: '', aliasCbu: '', cuentaBancaria: '',
    provincia: '', localidad: '', domicilio: String(datos.domicilio || '').trim(), barrio: '', codigoPostal: '', zona: '',
    telefono: '', celular: '', personaContacto: '', email: '', paginaWeb: '',
    observaciones: 'Creado automáticamente al leer una factura con IA.', descripcion: '', notas: '',
    activo: true, orgId: req.orgId, createdAt: ahora, updatedAt: ahora
  };
  const r = await db.collection('proveedores').insertOne(nuevo);
  return Object.assign({ _id: r.insertedId }, nuevo);
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

function registrarRutasFacturaIA(router, { modo, authAdmin, getDb, conReintento, filtroOrg }) {
  // POST /leer-factura  { archivoBase64, mimeType, nombreArchivo }
  router.post('/leer-factura', authAdmin, async (req, res) => {
    try {
      if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de leer una factura.');
      const b = req.body || {};
      const contenido = await armarContenidoArchivo({ base64: b.archivoBase64, mimeType: b.mimeType, nombreArchivo: b.nombreArchivo });
      const crudo = await llamarIA(contenido);
      const factura = normalizarResultado(crudo);
      if (!factura.esComprobante) throw err(400, 'Ese archivo no parece ser una factura o comprobante. Probá con otra foto o archivo.');

      const resultado = await conReintento(async () => {
        const db = await getDb();
        const filtro = filtroOrg(req);
        const { proveedor, criterio } = await buscarProveedor(db, filtro, factura.proveedor);
        const items = [];
        for (const it of factura.items) {
          if (modo === 'gastos') {
            const { concepto, candidatos } = await buscarConcepto(db, filtro, it);
            items.push(Object.assign({}, it, { concepto, candidatos }));
          } else {
            const { producto, candidatos } = await buscarProducto(db, filtro, it);
            items.push(Object.assign({}, it, { producto, candidatos }));
          }
        }
        // Aviso si el comprobante ya está cargado para ese proveedor.
        let duplicado = null;
        if (proveedor && factura.comprobante.tipoComprobante && factura.comprobante.puntoVenta && factura.comprobante.comprobanteNumero) {
          const coleccion = modo === 'gastos' ? 'gastos' : 'compras';
          const dupe = await db.collection(coleccion).findOne(Object.assign({
            proveedorId: proveedor._id, tipoComprobante: factura.comprobante.tipoComprobante,
            puntoVenta: factura.comprobante.puntoVenta, comprobanteNumero: factura.comprobante.comprobanteNumero,
            estado: { $ne: 'anulada' }
          }, filtro));
          if (dupe) duplicado = { _id: dupe._id, numero: dupe.numero };
        }
        return Object.assign({}, factura, {
          items,
          proveedorCoincidencia: proveedor ? { _id: proveedor._id, razonSocial: proveedor.razonSocial, condicionPago: proveedor.condicionPago || '', criterio } : null,
          duplicado
        });
      });
      res.json(resultado);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // POST /proveedor-rapido  { razonSocial, cuit, domicilio }
  router.post('/proveedor-rapido', authAdmin, async (req, res) => {
    try {
      if (!req.orgId) throw err(400, 'Elegí con qué organización estás trabajando antes de crear un proveedor.');
      const doc = await conReintento(async () => {
        const db = await getDb();
        return crearProveedorRapido(db, req, filtroOrg(req), req.body || {});
      });
      res.json(doc);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
}

module.exports = {
  registrarRutasFacturaIA,
  // Expuestos para pruebas:
  cuitValido, formatearCuit, normalizarResultado, similitud, tokens, numero, tipoDeArchivo,
  buscarProducto, buscarProveedor, buscarConcepto, crearProveedorRapido, armarContenidoArchivo
};
