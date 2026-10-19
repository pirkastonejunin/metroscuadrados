// PDF simple de un presupuesto para mandarlo por WhatsApp (pdfkit, sin navegador).
const PDFDocument = require('pdfkit');
const fecha = d => new Date(d).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
function generar(p, org, cliente) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 }); const bufs = [];
    doc.on('data', b => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    const mon = n => (p.moneda === 'USD' ? 'US$ ' : '$ ') + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    org = org || {};
    doc.font('Helvetica-Bold').fontSize(16).text(org.razonSocial || org.nombre || 'Presupuesto', 40, 40);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text([org.domicilio, org.telefono, org.email].filter(Boolean).join('  ·  '), 40, 60);
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(16).text('PRESUPUESTO', 380, 40, { width: 175, align: 'right' });
    doc.font('Helvetica').fontSize(10).text('Nº ' + String(p.numero).padStart(5, '0'), 380, 60, { width: 175, align: 'right' }).text('Fecha: ' + fecha(p.fecha), 380, 74, { width: 175, align: 'right' });
    doc.moveTo(40, 96).lineTo(555, 96).strokeColor('#ccc').stroke();
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(10).text('Cliente: ', 40, 106, { continued: true }).font('Helvetica').text(p.clienteNombre || '');
    if (cliente && (cliente.telefono || cliente.domicilio)) doc.fillColor('#555').fontSize(9).text([cliente.telefono, cliente.domicilio].filter(Boolean).join('  ·  '));
    let y = 140; doc.fillColor('#000').font('Helvetica-Bold').fontSize(9);
    doc.rect(40, y, 515, 18).fill('#eee'); doc.fillColor('#000');
    doc.text('Producto', 46, y + 5); doc.text('Cant.', 330, y + 5, { width: 40, align: 'right' }); doc.text('Precio', 375, y + 5, { width: 80, align: 'right' }); doc.text('Subtotal', 460, y + 5, { width: 90, align: 'right' });
    y += 24; doc.font('Helvetica').fontSize(9);
    for (const it of p.items || []) {
      const alto = Math.max(14, doc.heightOfString((it.sku ? it.sku + ' - ' : '') + it.nombre, { width: 280 }) + 4);
      if (y + alto > 760) { doc.addPage(); y = 40; }
      doc.text((it.sku ? it.sku + ' - ' : '') + it.nombre, 46, y, { width: 280 }); doc.text(String(Number(it.cantidad).toLocaleString('es-AR')), 330, y, { width: 40, align: 'right' });
      doc.text(mon(it.precioUnitario), 375, y, { width: 80, align: 'right' }); doc.text(mon(it.subtotal != null ? it.subtotal : it.precioUnitario * it.cantidad), 460, y, { width: 90, align: 'right' });
      y += alto; doc.moveTo(40, y - 2).lineTo(555, y - 2).strokeColor('#eee').stroke();
    }
    y += 8;
    if (p.descuentoPorcentaje || p.descuentoMonto) { doc.font('Helvetica').text('Subtotal: ' + mon(p.subtotal), 360, y, { width: 190, align: 'right' }); y += 14; doc.text('Descuento: ' + (p.descuentoPorcentaje ? p.descuentoPorcentaje + '%' : mon(p.descuentoMonto)), 360, y, { width: 190, align: 'right' }); y += 14; }
    doc.font('Helvetica-Bold').fontSize(13).text('TOTAL: ' + mon(p.total), 300, y, { width: 250, align: 'right' }); y += 26;
    doc.font('Helvetica').fontSize(8).fillColor('#555').text('Precios finales con IVA incluido. Presupuesto sujeto a disponibilidad de stock y variación de precios.', 40, y, { width: 515 }); y += 24;
    if (p.observaciones) { doc.fillColor('#000').fontSize(9).text('Observaciones: ' + p.observaciones, 40, y, { width: 515 }); }
    doc.end();
  });
}
module.exports = { generar };
