// ---------------------------------------------------------------------------
// Impuestos — tipos precargados y cálculo compartido entre Compras, Gastos
// y los cobros de Ventas/Tesorería (5/10/2026, pedido de Mato).
//
// Reglas que definió Mato:
//   - Se DESGLOSAN: IVA, percepciones, retenciones, impuesto al crédito,
//     impuesto al débito e ingresos brutos. Todo lo demás (impuestos
//     internos, tasas, etc.) se agrupa en "otros impuestos".
//   - Ingresos brutos se carga como percepción/retención de tipo "iibb".
//   - Los tipos de percepción y retención son los mismos en Compras,
//     Gastos y Cobranza, y vienen PRECARGADOS (se eligen de una lista).
//   - La empresa NO es agente de retención: una retención cargada en una
//     compra/gasto es una que nos practicó el proveedor, y una cargada en
//     un cobro es una que nos practicó el cliente (impuesto a favor).
//
// Cómo impactan en los importes:
//   - Percepciones, impuesto al crédito, impuesto al débito y otros
//     impuestos SUMAN al total del comprobante (vienen dentro de la
//     factura que hay que pagar).
//   - Las retenciones de una compra/gasto se REGISTRAN pero no tocan el
//     total ni el saldo (son un dato fiscal a favor, para el libro de
//     impuestos).
//   - En un COBRO, la retención cancela deuda del cliente sin que entre
//     plata: el efectivo/cheque/transferencia cobrado va a la caja o
//     banco, y el cobro aplicado contra la cuenta corriente es
//     cobrado + retenciones.
//
// Para agregar un tipo nuevo alcanza con sumarlo a las listas de abajo.
// ---------------------------------------------------------------------------

const TIPOS_PERCEPCION = [
  { clave: 'iva', nombre: 'Percepción de IVA' },
  { clave: 'iibb', nombre: 'Percepción de Ingresos Brutos (IIBB)' },
  { clave: 'ganancias', nombre: 'Percepción de Ganancias' },
  { clave: 'otra', nombre: 'Otra percepción' }
];

const TIPOS_RETENCION = [
  { clave: 'iva', nombre: 'Retención de IVA' },
  { clave: 'iibb', nombre: 'Retención de Ingresos Brutos (IIBB)' },
  { clave: 'ganancias', nombre: 'Retención de Ganancias' },
  { clave: 'suss', nombre: 'Retención de SUSS' },
  { clave: 'otra', nombre: 'Otra retención' }
];

function err(status, message) { return Object.assign(new Error(message), { status }); }
function redondear2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Normaliza una lista de líneas { tipo, monto, nota? } contra el catálogo
// de tipos. Las líneas vacías (sin monto, o monto 0) se descartan en
// silencio — son filas del formulario que quedaron sin completar. Un
// monto negativo, un tipo desconocido o un monto que no es número SÍ
// dan error.
function normalizarLineasImpuesto(raw, tiposValidos, etiqueta) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) throw err(400, `${etiqueta}: formato inválido`);
  const porClave = new Map(tiposValidos.map(t => [t.clave, t]));
  const lineas = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') throw err(400, `${etiqueta}: formato inválido`);
    const montoRaw = (l.monto === undefined || l.monto === null || l.monto === '') ? 0 : Number(l.monto);
    if (!Number.isFinite(montoRaw)) throw err(400, `${etiqueta}: el monto tiene que ser un número`);
    if (montoRaw < 0) throw err(400, `${etiqueta}: el monto no puede ser negativo`);
    if (montoRaw === 0) continue;
    const clave = String(l.tipo === undefined || l.tipo === null ? '' : l.tipo).trim().toLowerCase();
    const tipo = porClave.get(clave);
    if (!tipo) throw err(400, `${etiqueta}: tipo inválido "${clave}" (opciones: ${tiposValidos.map(t => t.clave).join(', ')})`);
    const linea = { tipo: tipo.clave, tipoNombre: tipo.nombre, monto: redondear2(montoRaw) };
    const nota = (l.nota === undefined || l.nota === null) ? '' : String(l.nota).trim();
    if (nota) linea.nota = nota;
    lineas.push(linea);
  }
  return lineas;
}

function normalizarMontoOpcional(v, etiqueta) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw err(400, `${etiqueta} tiene que ser un número mayor o igual a 0`);
  return redondear2(n);
}

function sumarMontos(lineas) {
  return redondear2((lineas || []).reduce((a, l) => a + (Number(l.monto) || 0), 0));
}

// Lee y valida todo el bloque de impuestos de una compra o un gasto a
// partir del body del request. `cargosSobreTotal` es lo que SUMA al total
// (percepciones + impuesto al crédito + impuesto al débito + otros).
function normalizarImpuestosComprobante(body) {
  const b = body || {};
  const percepciones = normalizarLineasImpuesto(b.percepciones, TIPOS_PERCEPCION, 'Percepciones');
  const retenciones = normalizarLineasImpuesto(b.retenciones, TIPOS_RETENCION, 'Retenciones');
  const impuestoCredito = normalizarMontoOpcional(b.impuestoCredito, 'El impuesto al crédito');
  const impuestoDebito = normalizarMontoOpcional(b.impuestoDebito, 'El impuesto al débito');
  const otrosImpuestos = normalizarMontoOpcional(b.otrosImpuestos, 'Otros impuestos');
  const totalPercepciones = sumarMontos(percepciones);
  const totalRetenciones = sumarMontos(retenciones);
  const cargosSobreTotal = redondear2(totalPercepciones + impuestoCredito + impuestoDebito + otrosImpuestos);
  return {
    percepciones, retenciones, impuestoCredito, impuestoDebito, otrosImpuestos,
    totalPercepciones, totalRetenciones, cargosSobreTotal
  };
}

// Total a pagar de un comprobante: (subtotal neto + IVA) con los
// descuentos aplicados, más los cargos de impuestos. El IVA entra en el
// total (5/10/2026, Mato: el total guardado tiene que ser el mismo que
// se ve en pantalla). Los descuentos se aplican sobre neto + IVA, igual
// que el formulario.
function calcularTotalConImpuestos(subtotal, importeIva, descuentoPorcentaje, descuentoMonto, cargosSobreTotal) {
  let total = (Number(subtotal) || 0) + (Number(importeIva) || 0);
  if (descuentoPorcentaje) total -= total * (descuentoPorcentaje / 100);
  if (descuentoMonto) total -= descuentoMonto;
  total = Math.max(0, total);
  return redondear2(total + (Number(cargosSobreTotal) || 0));
}

// Guarda cada retención como un registro propio (colección
// `retenciones_sufridas`) para poder armar después el detalle de
// retenciones a favor por tipo y período, sin tener que recorrer todos
// los comprobantes y cobros. `origen` es 'compra' | 'gasto' |
// 'cobro_venta' | 'cobro_cuenta'. Si falla, NO tumba la operación
// principal: la retención ya quedó guardada dentro del comprobante o
// del cobro, esto es solo el índice.
async function registrarRetencionesSufridas(db, req, { origen, retenciones, fecha, moneda, referencia }) {
  try {
    if (!Array.isArray(retenciones) || !retenciones.length) return;
    const ahora = new Date();
    const usuarioNombre = (req.usuario && req.usuario.nombre) ? req.usuario.nombre : '';
    const docs = retenciones.map(r => Object.assign({
      origen, tipo: r.tipo, tipoNombre: r.tipoNombre, monto: r.monto, nota: r.nota || '',
      moneda: moneda || 'ARS', fecha: fecha || ahora, usuarioNombre, orgId: req.orgId, createdAt: ahora
    }, referencia || {}));
    await db.collection('retenciones_sufridas').insertMany(docs);
  } catch (e) {
    console.error('No se pudo indexar la retención sufrida:', e.message);
  }
}

// Handler listo para `router.get('/tipos-impuestos', auth, tiposImpuestosHandler)`.
function tiposImpuestosHandler(req, res) {
  res.json({ percepciones: TIPOS_PERCEPCION, retenciones: TIPOS_RETENCION });
}

module.exports = {
  TIPOS_PERCEPCION, TIPOS_RETENCION,
  normalizarLineasImpuesto, normalizarImpuestosComprobante, calcularTotalConImpuestos,
  sumarMontos, redondear2, registrarRetencionesSufridas, tiposImpuestosHandler
};
