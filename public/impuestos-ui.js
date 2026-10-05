// ---------------------------------------------------------------------------
// ImpuestosUI — bloque de formulario compartido (5/10/2026, pedido de Mato)
// para cargar percepciones, retenciones, impuesto al crédito, impuesto al
// débito y otros impuestos en Compras, Gastos y Cobranza. Los tipos de
// percepción/retención vienen PRECARGADOS del servidor (GET
// <base>/tipos-impuestos, ver impuestos.js).
//
// Uso:
//   await ImpuestosUI.cargarTipos(BASE, headersAuth);       // una vez al iniciar
//   html = ImpuestosUI.bloqueHtml('impNC', { percepciones:true, retenciones:true,
//            extras:true, onChange:'actualizarTotalesCompra', ayudaRetenciones:'…' });
//   ImpuestosUI.leer('impNC')    -> { percepciones:[{tipo,monto,nota}], retenciones:[…],
//                                     impuestoCredito, impuestoDebito, otrosImpuestos }
//   ImpuestosUI.totales('impNC') -> { percepciones, retenciones, credito, debito, otros, cargos }
//   ImpuestosUI.cargar('impNC', datos)   // precarga (p. ej. lo que leyó la IA)
//
// `cargos` = lo que SUMA al total del comprobante (percepciones + crédito +
// débito + otros). Las retenciones no suman: se registran aparte.
// ---------------------------------------------------------------------------
window.ImpuestosUI = (function () {
  // Valores de respaldo por si el servidor no responde; el servidor manda
  // la lista oficial (impuestos.js).
  let tipos = {
    percepciones: [
      { clave: 'iva', nombre: 'Percepción de IVA' },
      { clave: 'iibb', nombre: 'Percepción de Ingresos Brutos (IIBB)' },
      { clave: 'ganancias', nombre: 'Percepción de Ganancias' },
      { clave: 'otra', nombre: 'Otra percepción' }
    ],
    retenciones: [
      { clave: 'iva', nombre: 'Retención de IVA' },
      { clave: 'iibb', nombre: 'Retención de Ingresos Brutos (IIBB)' },
      { clave: 'ganancias', nombre: 'Retención de Ganancias' },
      { clave: 'suss', nombre: 'Retención de SUSS' },
      { clave: 'otra', nombre: 'Otra retención' }
    ]
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function $(id) { return document.getElementById(id); }

  function inyectarEstilos() {
    if ($('impuestosUiStyles')) return;
    var st = document.createElement('style');
    st.id = 'impuestosUiStyles';
    st.textContent =
      '.imp-sub{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 6px;font-weight:600}' +
      '.imp-fila{display:grid;grid-template-columns:2fr 1fr 2fr auto;gap:8px;margin-bottom:6px;align-items:center}' +
      '.imp-fila .imp-quitar{background:none;border:none;color:#c0392b;font-size:20px;cursor:pointer;line-height:1;padding:0 6px}' +
      '.imp-vacio{font-size:12px;opacity:.7;margin-bottom:4px}' +
      '.imp-ayuda{font-size:12px;opacity:.75;margin:-2px 0 6px}' +
      '@media (max-width:640px){.imp-fila{grid-template-columns:1fr 1fr;}.imp-fila .imp-nota{grid-column:1 / span 2}.imp-fila .imp-quitar{grid-row:1;grid-column:2;justify-self:end}}';
    document.head.appendChild(st);
  }

  async function cargarTipos(baseUrl, headersFn) {
    try {
      var r = await fetch(baseUrl + '/tipos-impuestos', { headers: headersFn() });
      if (!r.ok) return;
      var d = await r.json();
      if (d && Array.isArray(d.percepciones) && Array.isArray(d.retenciones)) tipos = d;
    } catch (e) { console.error('No se pudieron traer los tipos de impuestos:', e.message); }
  }

  function opciones(lista, seleccionado) {
    return lista.map(function (t) { return '<option value="' + esc(t.clave) + '"' + (t.clave === seleccionado ? ' selected' : '') + '>' + esc(t.nombre) + '</option>'; }).join('');
  }

  function filaHtml(kind, linea) {
    var lista = kind === 'perc' ? tipos.percepciones : tipos.retenciones;
    linea = linea || {};
    return '<div class="imp-fila">' +
      '<select class="imp-tipo" onchange="ImpuestosUI.cambio(this)">' + opciones(lista, linea.tipo || 'iibb') + '</select>' +
      '<input type="number" class="imp-monto" min="0" step="0.01" placeholder="Monto" value="' + (linea.monto ? esc(linea.monto) : '') + '" oninput="ImpuestosUI.cambio(this)">' +
      '<input type="text" class="imp-nota" placeholder="Detalle (opcional)" value="' + esc(linea.nota || '') + '">' +
      '<button type="button" class="imp-quitar" title="Quitar" onclick="ImpuestosUI.quitar(this)">×</button>' +
      '</div>';
  }

  function bloqueHtml(prefix, cfg) {
    inyectarEstilos();
    cfg = cfg || {};
    var conPerc = cfg.percepciones !== false;
    var conRet = cfg.retenciones !== false;
    var extras = !!cfg.extras;
    var h = '<div class="imp-bloque" id="' + prefix + 'Imp" data-onchange="' + esc(cfg.onChange || '') + '">';
    if (cfg.titulo !== null) h += '<div class="section-title">' + esc(cfg.titulo || 'Impuestos adicionales') + '</div>';
    if (conPerc) {
      h += '<div class="imp-sub"><span>Percepciones</span><button type="button" class="btn secondary small" onclick="ImpuestosUI.agregar(\'' + prefix + '\',\'perc\')">+ Agregar percepción</button></div>';
      h += '<div id="' + prefix + 'PercLista"></div>';
    }
    if (conRet) {
      h += '<div class="imp-sub"><span>Retenciones</span><button type="button" class="btn secondary small" onclick="ImpuestosUI.agregar(\'' + prefix + '\',\'ret\')">+ Agregar retención</button></div>';
      if (cfg.ayudaRetenciones) h += '<div class="imp-ayuda">' + esc(cfg.ayudaRetenciones) + '</div>';
      h += '<div id="' + prefix + 'RetLista"></div>';
    }
    if (extras) {
      var cb = 'oninput="ImpuestosUI.cambio(this)"';
      h += '<div class="grid3" style="margin-top:10px">' +
        '<div><label>Impuesto al crédito</label><input type="number" id="' + prefix + 'Credito" min="0" step="0.01" placeholder="0,00" ' + cb + '></div>' +
        '<div><label>Impuesto al débito</label><input type="number" id="' + prefix + 'Debito" min="0" step="0.01" placeholder="0,00" ' + cb + '></div>' +
        '<div><label>Otros impuestos</label><input type="number" id="' + prefix + 'Otros" min="0" step="0.01" placeholder="0,00" ' + cb + '></div>' +
        '</div><div class="imp-ayuda">Los demás impuestos de la factura (impuestos internos, tasas, etc.) se cargan juntos en "Otros impuestos".</div>';
    }
    h += '</div>';
    return h;
  }

  function avisar(el) {
    var bloque = el.closest ? el.closest('.imp-bloque') : null;
    var nombre = bloque && bloque.getAttribute('data-onchange');
    if (nombre && typeof window[nombre] === 'function') window[nombre]();
  }
  function cambio(el) { avisar(el); }
  function quitar(btn) { var bloque = btn.closest('.imp-bloque'); btn.closest('.imp-fila').remove(); if (bloque) avisar(bloque); }

  function agregar(prefix, kind, linea) {
    var cont = $(prefix + (kind === 'perc' ? 'PercLista' : 'RetLista'));
    if (!cont) return;
    cont.insertAdjacentHTML('beforeend', filaHtml(kind, linea));
    var bloque = $(prefix + 'Imp');
    if (bloque && !linea) avisar(bloque);
  }

  function leerLista(prefix, sufijo) {
    var cont = $(prefix + sufijo);
    if (!cont) return [];
    var out = [];
    cont.querySelectorAll('.imp-fila').forEach(function (f) {
      var monto = num(f.querySelector('.imp-monto').value);
      if (monto <= 0) return;
      var linea = { tipo: f.querySelector('.imp-tipo').value, monto: monto };
      var nota = f.querySelector('.imp-nota').value.trim();
      if (nota) linea.nota = nota;
      out.push(linea);
    });
    return out;
  }
  function leerCampo(id) { var el = $(id); return el ? num(el.value) : 0; }

  function leer(prefix) {
    return {
      percepciones: leerLista(prefix, 'PercLista'),
      retenciones: leerLista(prefix, 'RetLista'),
      impuestoCredito: leerCampo(prefix + 'Credito'),
      impuestoDebito: leerCampo(prefix + 'Debito'),
      otrosImpuestos: leerCampo(prefix + 'Otros')
    };
  }

  function sumar(lista) { return r2(lista.reduce(function (a, l) { return a + l.monto; }, 0)); }
  function totales(prefix) {
    var d = leer(prefix);
    var percepciones = sumar(d.percepciones), retenciones = sumar(d.retenciones);
    return {
      percepciones: percepciones, retenciones: retenciones,
      credito: d.impuestoCredito, debito: d.impuestoDebito, otros: d.otrosImpuestos,
      cargos: r2(percepciones + d.impuestoCredito + d.impuestoDebito + d.otrosImpuestos)
    };
  }

  // Precarga el bloque (por ejemplo con lo que leyó la IA de una factura).
  function cargar(prefix, datos) {
    datos = datos || {};
    ['PercLista', 'RetLista'].forEach(function (s) { var c = $(prefix + s); if (c) c.innerHTML = ''; });
    (datos.percepciones || []).forEach(function (l) { agregar(prefix, 'perc', l); });
    (datos.retenciones || []).forEach(function (l) { agregar(prefix, 'ret', l); });
    var set = function (sufijo, v) { var el = $(prefix + sufijo); if (el) el.value = v ? v : ''; };
    set('Credito', datos.impuestoCredito); set('Debito', datos.impuestoDebito); set('Otros', datos.otrosImpuestos);
    var bloque = $(prefix + 'Imp');
    if (bloque) avisar(bloque);
  }

  // Renglones de resumen para mostrar debajo del total: [{ etiqueta, monto }].
  function lineasResumen(prefix) {
    var t = totales(prefix), out = [];
    if (t.percepciones) out.push({ etiqueta: 'Percepciones', monto: t.percepciones });
    if (t.credito) out.push({ etiqueta: 'Impuesto al crédito', monto: t.credito });
    if (t.debito) out.push({ etiqueta: 'Impuesto al débito', monto: t.debito });
    if (t.otros) out.push({ etiqueta: 'Otros impuestos', monto: t.otros });
    return out;
  }

  // Detalle (solo lectura) de un comprobante guardado, para las pantallas
  // de detalle: devuelve '' si no tiene nada cargado.
  function detalleHtml(doc, formatoMonto) {
    var fm = formatoMonto || function (n) { return '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var filas = [];
    (doc.percepciones || []).forEach(function (l) { filas.push([l.tipoNombre || l.tipo, l.monto, l.nota]); });
    if (doc.impuestoCredito) filas.push(['Impuesto al crédito', doc.impuestoCredito]);
    if (doc.impuestoDebito) filas.push(['Impuesto al débito', doc.impuestoDebito]);
    if (doc.otrosImpuestos) filas.push(['Otros impuestos', doc.otrosImpuestos]);
    var ret = (doc.retenciones || []).map(function (l) { return [l.tipoNombre || l.tipo, l.monto, l.nota]; });
    if (!filas.length && !ret.length) return '';
    var fila = function (f) { return '<div class="detalle-pago"><span>' + esc(f[0]) + (f[2] ? ' <span class="muted">(' + esc(f[2]) + ')</span>' : '') + '</span><span>' + fm(f[1]) + '</span></div>'; };
    var h = '';
    if (filas.length) h += '<div class="section-title">Impuestos adicionales (incluidos en el total)</div>' + filas.map(fila).join('');
    if (ret.length) h += '<div class="section-title">Retenciones practicadas (a favor, no cambian el saldo)</div>' + ret.map(fila).join('');
    return h;
  }

  return { cargarTipos: cargarTipos, bloqueHtml: bloqueHtml, agregar: agregar, quitar: quitar, cambio: cambio, leer: leer, totales: totales, cargar: cargar, lineasResumen: lineasResumen, detalleHtml: detalleHtml };
})();
