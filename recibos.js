// -----------------------------------------------------------------------
// RECIBOS — formato único y detallado para el recibo de un cobro de venta y para el recibo de un cobro a cuenta
// (rediseñado el 5/11/2026, pedido de Mato: "el formato de los recibos no me gusta, armalo más detallado, con datos de los
// cheques y un poco más de info"). Usa el mismo encabezado "tipo Dux" que el comprobante (letra X: no es factura).
// Presentación pura + lecturas puntuales (cheque, caja/banco, cliente) con el `db` que le pasa quien llama: no decide nada de negocio.
// -----------------------------------------------------------------------
const { escapeHtml: esc, money, fechaLarga, fechaCorta, encabezadoComprobante, recuadroClienteComprobante, CATEGORIA_FISCAL_LABEL } = require('./imprimibles');

// ---- Importe en letras (SON PESOS: …) ----
const UNI = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE',
  'VEINTE', 'VEINTIUN', 'VEINTIDOS', 'VEINTITRES', 'VEINTICUATRO', 'VEINTICINCO', 'VEINTISEIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'];
const DEC = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CEN = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
function menorMil(n) {
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100), r = n % 100; const p = [];
  if (c) p.push(CEN[c]);
  if (r) { if (r < 30) p.push(UNI[r]); else { const d = DEC[Math.floor(r / 10)]; p.push(r % 10 ? d + ' Y ' + UNI[r % 10] : d); } }
  return p.join(' ');
}
function finalUno(s) { return s.replace(/(^| )UN$/, '$1UNO').replace(/VEINTIUN$/, 'VEINTIUNO'); }
function enteroALetras(n) {
  if (n === 0) return 'CERO';
  const mill = Math.floor(n / 1e6), miles = Math.floor((n % 1e6) / 1000), resto = n % 1000; const p = [];
  if (mill) p.push(mill === 1 ? 'UN MILLON' : enteroALetras(mill).replace(/UNO$/, 'UN') + ' MILLONES');
  if (miles) p.push(miles === 1 ? 'MIL' : menorMil(miles) + ' MIL');
  if (resto) p.push(finalUno(menorMil(resto)));
  return p.join(' ');
}
function importeEnLetras(monto, moneda) {
  const n = Math.round(Math.abs(Number(monto) || 0) * 100);
  const ent = Math.floor(n / 100), cent = n % 100;
  const exacto = ent >= 1e6 && ent % 1e6 === 0; // "UN MILLON DE PESOS"
  const nom = (moneda && moneda !== 'ARS') ? 'DOLARES ESTADOUNIDENSES' : 'PESOS';
  return `SON ${nom}: ${enteroALetras(ent)}${exacto ? ' DE' : ''} CON ${String(cent).padStart(2, '0')}/100`;
}

// Fecha DD/MM/AAAA sin corrimientos de huso: una fecha cargada a mano ("2026-12-15") se guarda a medianoche UTC y se muestra tal cual;
// una con hora (el momento del cobro) se muestra en hora argentina.
function fechaDoc(d) {
  if (!d) return '';
  const x = new Date(d); if (isNaN(x)) return '';
  const soloFecha = x.getUTCHours() === 0 && x.getUTCMinutes() === 0 && x.getUTCSeconds() === 0 && x.getUTCMilliseconds() === 0;
  return x.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: soloFecha ? 'UTC' : 'America/Argentina/Buenos_Aires' });
}

const LBL = { efectivo: 'Efectivo', cheque: 'Cheque', cuenta: 'Transferencia', tarjeta: 'Tarjeta' };
const TARJETA_TIPO = { credito: 'Crédito', debito: 'Débito' };

// Convierte un cobro (de una venta o de un recibo a cuenta) en una fila del recibo con todo su detalle. `v` trae tipoValor, monto,
// chequeId / chequeNumero…, cuentaTipo+cuentaId, tarjeta*. Los datos del cheque se leen de la ficha del cheque (más completa).
async function medioDeCobro(db, v) {
  const det = []; const add = (k, x) => { if (x !== undefined && x !== null && String(x).trim() !== '') det.push([k, x]); };
  if (v.tipoValor === 'cheque') {
    let ch = null; try { if (v.chequeId) ch = await db.collection('cheques').findOne({ _id: v.chequeId }); } catch (e) { /* se usan los datos del cobro */ }
    const d = ch || { numero: v.chequeNumero, banco: v.chequeBanco, fechaVencimiento: v.chequeVencimiento };
    add('Cheque Nº', d.numero); add('Banco', d.banco); add('Librador', d.librador); add('CUIT librador', d.cuitLibrador);
    add('Emisión', fechaDoc(d.fechaEmision)); add('Vencimiento', fechaDoc(d.fechaVencimiento));
    if (ch && ch.observaciones) add('Obs.', ch.observaciones);
  } else {
    if (v.cuentaId && v.cuentaTipo) {
      try { const c = await db.collection(v.cuentaTipo === 'caja' ? 'tesoreria_cajas' : 'tesoreria_bancos').findOne({ _id: v.cuentaId }, { projection: { nombre: 1 } });
        if (c && c.nombre) add(v.cuentaTipo === 'caja' ? 'Caja' : 'Acreditado en', c.nombre); } catch (e) { /* dato opcional */ }
    }
    if (v.tipoValor === 'tarjeta') {
      add('Tarjeta', [v.tarjetaEntidad, TARJETA_TIPO[v.tarjetaTipo] || v.tarjetaTipo].filter(Boolean).join(' '));
      if (Number(v.tarjetaCuotas) > 1) add('Cuotas', v.tarjetaCuotas);
      add('Lote', v.tarjetaLote); add('Cupón', v.tarjetaCupon); add('Cód. autorización', v.tarjetaCodigoAutorizacion); add('Plan', v.tarjetaPlanNombre);
      if (Number(v.tarjetaRecargo) > 0) add('Recargo por financiación', money(v.tarjetaRecargo));
    }
  }
  return { tipo: v.tipoValor, etiqueta: LBL[v.tipoValor] || v.tipoValor || '—', monto: Number(v.monto) || 0, detalle: det };
}

async function datosCliente(db, clienteId, nombreGuardado) {
  let c = null; try { if (clienteId) c = await db.collection('clientes').findOne({ _id: clienteId }); } catch (e) { /* se imprime con el nombre guardado */ }
  const nombre = c ? ([c.apellidoRazonSocial, c.nombre].filter(Boolean).join(' ').trim() || nombreGuardado || '') : (nombreGuardado || '');
  return { c, nombre };
}

// Arma encabezado + cuerpo. `resumen`: [[rótulo, valor]] (ej. total del comprobante, cobrado, saldo). `anulado`: muestra el cartel.
async function armarRecibo(db, { org, clienteId, clienteNombre, numeroFmt, fecha, moneda, medios, retenciones, concepto, nota, usuario, resumen, anulado }) {
  const { c, nombre } = await datosCliente(db, clienteId, clienteNombre);
  const total = medios.reduce((a, m) => a + m.monto, 0);
  const rets = (retenciones || []).filter(r => Number(r.monto) > 0);
  const totalRet = rets.reduce((a, r) => a + (Number(r.monto) || 0), 0);
  const headerHtml = encabezadoComprobante(org, { letra: 'X', numeroFmt, fecha: fechaDoc(fecha), tituloGrande: 'RECIBO' });
  const filas = medios.map(m => `<tr><td><strong>${esc(m.etiqueta)}</strong></td><td class="rc-det">${m.detalle.length ? m.detalle.map(([k, x]) => `<span><em>${esc(k)}:</em> ${esc(x)}</span>`).join('') : '<span class="muted">—</span>'}</td><td class="num">${money(m.monto, moneda)}</td></tr>`).join('');
  const bodyHtml = `
    ${anulado ? '<div class="cmp-homologacion">COBRO ANULADO — ESTE RECIBO NO TIENE VALIDEZ</div>' : ''}
    ${recuadroClienteComprobante({
      nombre, iva: c && c.categoriaFiscal ? (CATEGORIA_FISCAL_LABEL[c.categoriaFiscal] || '') : '', cuit: c ? c.cuit : '', domicilio: c ? c.domicilio : '', localidad: c ? c.localidad : '',
      provincia: c ? c.provincia : '', email: c ? c.email : '', condicionPago: c ? c.condicionPago : '', observaciones: nota || ''
    })}
    <h2 class="rc-sub">Detalle de lo recibido</h2>
    <table class="rc-medios"><thead><tr><th style="width:15%">Medio</th><th>Detalle</th><th class="num" style="width:18%">Importe</th></tr></thead><tbody>${filas}</tbody></table>
    <table class="totales">
      <tr><td>Total recibido</td><td class="num">${money(total, moneda)}</td></tr>
      ${rets.map(r => `<tr><td>Retención ${esc(r.tipoNombre || '')}</td><td class="num">${money(r.monto, moneda)}</td></tr>`).join('')}
      <tr class="total-final"><td>${rets.length ? 'Total aplicado' : 'Total'}</td><td class="num">${money(total + totalRet, moneda)}</td></tr>
    </table>
    <div class="rc-letras">${esc(importeEnLetras(total + totalRet, moneda))}</div>
    <p class="rc-concepto"><strong>En concepto de:</strong> ${esc(concepto || '')}</p>
    ${(resumen && resumen.length) ? `<table class="rc-resumen">${resumen.map(([k, x]) => `<tr><td>${esc(k)}</td><td class="num">${esc(x)}</td></tr>`).join('')}</table>` : ''}
    <div class="rc-firmas"><div><div class="rc-linea"></div>Firma y aclaración</div><div><div class="rc-linea"></div>Recibió${usuario ? ': ' + esc(usuario) : ''}</div></div>
    <p class="muted rc-pie">Documento no válido como factura. Emitido el ${esc(fechaLarga(new Date()))}.</p>`;
  return { headerHtml, bodyHtml, telefono: c ? (c.celular || c.telefono || '') : '' };
}

module.exports = { armarRecibo, medioDeCobro, importeEnLetras };
