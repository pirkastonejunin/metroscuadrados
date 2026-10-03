// -----------------------------------------------------------------------
// IMPRIMIBLES — plantilla HTML compartida para todo lo que se imprime
// (comprobante de venta, recibo, remito y, en el futuro, factura).
// Sumado el 3/10/2026, pedido de Mato: "comencemos a trabajar en los
// imprimibles... tene en cuenta que tiene que tener los datos del
// negocio (de cada una de las sucursales)".
//
// Es una EXCEPCIÓN DELIBERADA NUEVA a "cada router repite la lógica
// mínima", distinta de la ya anotada para lógica de negocio sensible al
// dinero (aplicarMovimientoCuenta/registrarMovimientoCuentaCorriente):
// esto es lógica de PRESENTACIÓN pura, sin acceso a la base — no decide
// nada de negocio, solo arma el HTML con el mismo encabezado/estilo para
// que todos los imprimibles se vean iguales. Se importa desde
// ventas.js y tesoreria.js. No necesita el cuidado de "colgar de router
// en vez de module.exports" porque no exporta nada agregado después de
// un module.exports — es el único export del archivo, de punta a punta.
//
// Los datos del negocio por sucursal viven en `organizaciones` (ver
// usuarios.js, POST/PUT /organizaciones) — este archivo no toca Mongo,
// solo recibe ese documento ya resuelto por quien lo llama.
// -----------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n, moneda) {
  const num = Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (moneda && moneda !== 'ARS') ? `${moneda} ${num}` : `$ ${num}`;
}

function fechaLarga(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-AR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// DD/MM/AAAA — el formato que usa el encabezado del Comprobante (ver
// encabezadoComprobante), distinto de `fechaLarga` (texto, para el
// cuerpo de recibo/remito).
function fechaCorta(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function numero(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const CONDICION_IVA_LABEL = {
  responsable_inscripto: 'Responsable Inscripto', monotributista: 'Monotributista', exento: 'Exento',
  consumidor_final: 'Consumidor Final', iva_no_alcanzado: 'IVA No Alcanzado'
};

// Mismo enum/labels que `CATEGORIA_FISCAL_LABEL` en admin-clientes.html
// (frontend) — acá se necesita del lado del servidor para imprimir la
// línea "IVA:" del cliente en el Comprobante.
const CATEGORIA_FISCAL_LABEL = {
  consumidor_final: 'Consumidor Final', exento: 'Exento', monotributista: 'Monotributista',
  responsable_inscripto: 'Responsable Inscripto', exterior: 'Exterior', iva_no_alcanzado: 'IVA No Alcanzado'
};

function encabezadoNegocio(org) {
  org = org || {};
  const lineas = [];
  if (org.cuit) lineas.push(`CUIT: ${escapeHtml(org.cuit)}`);
  if (org.direccion) lineas.push(escapeHtml(org.direccion));
  if (org.telefono) lineas.push(`Tel: ${escapeHtml(org.telefono)}`);
  if (org.condicionIva && CONDICION_IVA_LABEL[org.condicionIva]) lineas.push(CONDICION_IVA_LABEL[org.condicionIva]);
  return `
    <div class="header-imprimible">
      ${org.logoBase64 ? `<img src="${org.logoBase64}" class="logo" alt="Logo">` : ''}
      <div class="datos-negocio">
        <div class="razon-social">${escapeHtml(org.razonSocial || org.nombre || '')}</div>
        ${lineas.map(l => `<div>${l}</div>`).join('')}
      </div>
    </div>
  `;
}

// Encabezado "tipo Dux" para el Comprobante de venta (3/10/2026, pedido
// de Mato: "podes hacer el diseño del compr mas parecido a esto?",
// adjuntando un comprobante real de Dux) — logo en un recuadro, razón
// social centrada, un recuadro con la letra (X/F) y el título +
// numeración + fecha a la derecha, más la línea de datos fiscales de la
// sucursal debajo. Distinto del `encabezadoNegocio` genérico (que sigue
// usando el recibo y el remito) porque este formato es específico del
// comprobante: una vez que se construya la Factura real (AFIP), lo más
// probable es que reuse este mismo encabezado.
function encabezadoComprobante(org, { letra, numeroFmt, fecha, tituloGrande }) {
  org = org || {};
  const lineaFiscal1 = [];
  if (org.condicionIva && CONDICION_IVA_LABEL[org.condicionIva]) lineaFiscal1.push(CONDICION_IVA_LABEL[org.condicionIva].toUpperCase());
  if (org.cuit) lineaFiscal1.push(`CUIT: ${escapeHtml(org.cuit)}`);
  const lineaFiscal2 = [];
  if (org.inicioActividad) lineaFiscal2.push(`INICIO ACT.: ${escapeHtml(org.inicioActividad)}`);
  if (org.ingresosBrutos) lineaFiscal2.push(`ING. BRUTOS: ${escapeHtml(org.ingresosBrutos)}`);
  return `
    <div class="cmp-header">
      <div class="cmp-logo-box">${org.logoBase64 ? `<img src="${org.logoBase64}" alt="Logo">` : ''}</div>
      <div class="cmp-negocio">
        <div class="cmp-razon">${escapeHtml(org.razonSocial || org.nombre || '')}</div>
        ${org.nombre && org.razonSocial && org.nombre !== org.razonSocial ? `<div>${escapeHtml(org.nombre)}</div>` : ''}
        ${org.direccion ? `<div>${escapeHtml(org.direccion)}</div>` : ''}
        ${org.telefono ? `<div>TEL: ${escapeHtml(org.telefono)}</div>` : ''}
      </div>
      <div class="cmp-letra">${escapeHtml(letra)}</div>
      <div class="cmp-titulo">
        <div class="cmp-titulo-grande">${escapeHtml(tituloGrande || 'COMPROBANTE')}</div>
        <div class="cmp-numero">Nº ${escapeHtml(numeroFmt)}</div>
        <div class="cmp-fecha">FECHA: ${escapeHtml(fecha)}</div>
      </div>
    </div>
    ${(lineaFiscal1.length || lineaFiscal2.length) ? `
      <div class="cmp-fiscal-linea">
        <div>${lineaFiscal1.join('&nbsp;&nbsp;&nbsp;')}</div>
        <div>${lineaFiscal2.join('&nbsp;&nbsp;&nbsp;')}</div>
      </div>
    ` : ''}
  `;
}

// Recuadro de datos del cliente del Comprobante, mismo diseño de Dux:
// Señor/es + IVA + CUIT en una fila, Domicilio/Localidad/Provincia en
// otra, Correo/Condición de pago en otra, Observaciones al final — cada
// campo vacío se muestra igual (con el rótulo) para mantener el mismo
// recuadro, como en el original.
function recuadroClienteComprobante({ nombre, iva, cuit, domicilio, localidad, provincia, email, condicionPago, observaciones }) {
  return `
    <div class="cmp-cliente-box">
      <div class="cmp-cliente-fila">
        <div><strong>SEÑOR/ES:</strong> ${escapeHtml(nombre || '')}</div>
        <div><strong>IVA:</strong> ${escapeHtml(iva || '')}</div>
        <div><strong>CUIT:</strong> ${escapeHtml(cuit || '')}</div>
      </div>
      <div class="cmp-cliente-fila">
        <div><strong>DOMICILIO:</strong> ${escapeHtml(domicilio || '')}</div>
        <div><strong>LOCALIDAD:</strong> ${escapeHtml(localidad || '')}</div>
        <div><strong>PROVINCIA:</strong> ${escapeHtml(provincia || '')}</div>
      </div>
      <div class="cmp-cliente-fila">
        <div><strong>CORREO ELECTRONICO:</strong> ${escapeHtml(email || '')}</div>
        <div><strong>CONDICION PAGO:</strong> ${escapeHtml(condicionPago || '')}</div>
      </div>
      <div class="cmp-cliente-fila"><div><strong>OBSERVACIONES:</strong> ${escapeHtml(observaciones || '')}</div></div>
    </div>
  `;
}

// `titulo` es el <title> de la pestaña Y el encabezado grande del
// documento (ej. "Comprobante de venta Nº 00123"). `bodyHtml` es el
// contenido propio de cada imprimible (tabla de ítems, datos del cobro,
// etc.) — arma eso cada router, esta función solo le pone el marco.
// `headerHtml` (opcional, 3/10/2026): si se pasa, reemplaza el
// encabezado genérico de `encabezadoNegocio` — lo usa el Comprobante
// para su propio encabezado "tipo Dux" (ver `encabezadoComprobante`).
function paginaImprimible({ titulo, org, bodyHtml, headerHtml }) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titulo)}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #1a1a1a; margin: 0; padding: 20px; }
  .header-imprimible { display: flex; gap: 16px; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 18px; }
  .header-imprimible .logo { max-height: 70px; max-width: 160px; object-fit: contain; }
  .datos-negocio .razon-social { font-size: 16px; font-weight: bold; margin-bottom: 2px; }
  .datos-negocio div { line-height: 1.4; color: #333; }
  h1 { font-size: 18px; margin: 0 0 14px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; font-size: 12.5px; }
  th { background: #f2f2f2; }
  td.num, th.num { text-align: right; }
  .totales { margin-top: 14px; width: 280px; margin-left: auto; }
  .totales td { border: none; padding: 3px 8px; }
  .totales .total-final td { font-weight: bold; font-size: 14px; border-top: 2px solid #333; }
  .datos-doc { display: flex; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; gap: 10px; }
  .datos-doc > div { min-width: 220px; }
  .muted { color: #666; }
  .no-imprimir { margin-top: 24px; }
  .no-imprimir button { font-size: 14px; padding: 8px 16px; cursor: pointer; }
  @media print { .no-imprimir { display: none; } }

  /* Comprobante "tipo Dux" (3/10/2026) — ver encabezadoComprobante */
  .cmp-header { display: flex; align-items: stretch; gap: 14px; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 4px; }
  .cmp-logo-box { width: 72px; min-width: 72px; border: 1px solid #999; display: flex; align-items: center; justify-content: center; padding: 4px; }
  .cmp-logo-box img { max-width: 100%; max-height: 64px; object-fit: contain; }
  .cmp-negocio { flex: 1; text-align: center; padding-top: 2px; }
  .cmp-negocio .cmp-razon { font-size: 15px; font-weight: bold; margin-bottom: 2px; }
  .cmp-negocio div { line-height: 1.4; color: #222; font-size: 12px; }
  .cmp-letra { width: 44px; min-width: 44px; border: 2px solid #333; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: bold; }
  .cmp-titulo { width: 230px; min-width: 190px; text-align: right; }
  .cmp-titulo-grande { font-size: 19px; font-weight: bold; }
  .cmp-titulo .cmp-numero { font-size: 15px; margin-top: 2px; }
  .cmp-titulo .cmp-fecha { font-size: 13px; font-weight: bold; margin-top: 2px; }
  .cmp-fiscal-linea { display: flex; justify-content: space-between; font-size: 11.5px; font-weight: bold; border-bottom: 2px solid #333; padding-bottom: 10px; margin-bottom: 14px; gap: 10px; flex-wrap: wrap; }
  .cmp-cliente-box { border: 1px solid #333; margin-bottom: 16px; }
  .cmp-cliente-fila { display: flex; gap: 18px; padding: 4px 8px; border-bottom: 1px solid #333; font-size: 12px; }
  .cmp-cliente-fila:last-child { border-bottom: none; }
  .cmp-cliente-fila > div { flex: 1; }
  .cmp-condicion-venta { margin-top: 20px; font-size: 11px; color: #333; border-top: 1px solid #999; padding-top: 8px; white-space: pre-line; }
</style>
</head>
<body>
  ${headerHtml || encabezadoNegocio(org)}
  ${bodyHtml}
  <div class="no-imprimir"><button onclick="window.print()">Imprimir</button></div>
</body>
</html>`;
}

module.exports = {
  paginaImprimible, encabezadoNegocio, encabezadoComprobante, recuadroClienteComprobante,
  escapeHtml, money, numero, fechaLarga, fechaCorta, CONDICION_IVA_LABEL, CATEGORIA_FISCAL_LABEL
};
