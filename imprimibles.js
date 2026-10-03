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

const CONDICION_IVA_LABEL = {
  responsable_inscripto: 'Responsable Inscripto', monotributista: 'Monotributista', exento: 'Exento',
  consumidor_final: 'Consumidor Final', iva_no_alcanzado: 'IVA No Alcanzado'
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

// `titulo` es el <title> de la pestaña Y el encabezado grande del
// documento (ej. "Comprobante de venta Nº 00123"). `bodyHtml` es el
// contenido propio de cada imprimible (tabla de ítems, datos del cobro,
// etc.) — arma eso cada router, esta función solo le pone el marco.
function paginaImprimible({ titulo, org, bodyHtml }) {
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
</style>
</head>
<body>
  ${encabezadoNegocio(org)}
  ${bodyHtml}
  <div class="no-imprimir"><button onclick="window.print()">Imprimir</button></div>
</body>
</html>`;
}

module.exports = { paginaImprimible, encabezadoNegocio, escapeHtml, money, fechaLarga, CONDICION_IVA_LABEL };
