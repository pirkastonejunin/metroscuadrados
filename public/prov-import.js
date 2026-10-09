// Pestaña "Importar lista" de la ficha de proveedor (9/10/2026).
// Usa las globales de admin-proveedores.html: headersAuth, headersAuthJson, escapeHtml, money.
// Rutas: /api/proveedores-import (ver proveedoresImport.js).
(function () {
  var PI = '/api/proveedores-import';
  var E = function (s) { return escapeHtml(s); };
  var estado = { id: null, listas: [], depositos: [], cotizacion: null, regla: null, archivo: null, nombreArchivo: '', headers: [] };

  function leerArchivo(file) {
    return new Promise(function (ok, mal) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { mal(new Error('No se pudo leer el archivo.')); };
      r.readAsDataURL(file);
    });
  }
  async function pedir(ruta, opts) {
    var r = await fetch(PI + ruta, Object.assign({ headers: headersAuthJson() }, opts || {}));
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || 'Error');
    return d;
  }
  function num(n, dec) { return Number(n).toLocaleString('es-AR', { minimumFractionDigits: dec == null ? 2 : dec, maximumFractionDigits: dec == null ? 2 : dec }); }
  function mon(n, m) { return n == null ? '—' : (m === 'USD' ? 'USD ' + num(n, 2) : '$ ' + num(n, 2)); }

  window.cargarImportarListaTab = async function (id) {
    var cont = document.getElementById('pimpContenido');
    estado.id = id; estado.archivo = null; estado.nombreArchivo = '';
    try {
      var d = await pedir('/' + id + '/regla');
      estado.listas = d.listas; estado.depositos = d.depositos; estado.cotizacion = d.cotizacionDolar; estado.regla = d.regla;
      cont.innerHTML = htmlTab(d);
      pintarMargenes();
      cargarHistorial();
    } catch (e) { cont.innerHTML = '<p class="err">' + E(e.message) + '</p>'; }
  };

  function htmlTab(d) {
    var r = d.regla || { matchPor: 'codigoExterno', columnas: {}, hoja: 1, filaEncabezado: 1, moneda: 'ARS', descuentos: [], recargoPct: 0, ivaIncluido: false, margenes: [], stock: { activo: false, depositoId: '', ceroSiNoViene: false }, alertaPct: 40 };
    estado.regla = r;
    var dep = '<option value="">— elegir —</option>' + d.depositos.map(function (x) { return '<option value="' + x._id + '"' + (String(r.stock.depositoId) === String(x._id) ? ' selected' : '') + '>' + E(x.nombre) + '</option>'; }).join('');
    return '' +
      '<p class="muted" style="margin:0 0 10px">Cada proveedor tiene su propia regla: cómo se leen sus listas, qué descuentos trae, qué margen se le pone y a qué depósito va su stock. Cuando te manda una lista nueva la subís acá, revisás los cambios y los aplicás.</p>' +
      '<details class="card" ' + (d.regla ? '' : 'open') + ' style="padding:12px"><summary style="cursor:pointer;font-weight:700">1. Regla de importación de ' + E(d.proveedor) + (d.regla ? '' : ' <span class="muted">(todavía no la armaste)</span>') + '</summary>' +
        '<div style="margin-top:12px">' +
          '<div class="row"><div style="flex:1;min-width:240px"><label>Archivo de ejemplo (para elegir las columnas)</label><input type="file" id="pimpEjemplo" accept=".xlsx,.xls,.csv" onchange="pimpDetectar()"></div>' +
          '<div style="width:90px"><label>Hoja Nº</label><input type="number" min="1" id="pimpHoja" value="' + r.hoja + '"></div>' +
          '<div style="width:140px"><label>Fila de los títulos</label><input type="number" min="1" id="pimpFila" value="' + r.filaEncabezado + '"></div></div>' +
          '<div id="pimpMuestra" class="muted" style="font-size:12px;margin:6px 0"></div>' +
          '<datalist id="pimpCols">' + (estado.headers || []).map(function (h) { return '<option value="' + E(h) + '">'; }).join('') + '</datalist>' +
          '<div class="row" style="margin-top:8px">' +
            '<div style="flex:1;min-width:150px"><label>Columna del código *</label><input id="pimpCCodigo" list="pimpCols" value="' + E(r.columnas.codigo || '') + '"></div>' +
            '<div style="flex:1;min-width:150px"><label>Columna del precio *</label><input id="pimpCPrecio" list="pimpCols" value="' + E(r.columnas.precio || '') + '"></div>' +
            '<div style="flex:1;min-width:150px"><label>Columna de stock (si manda)</label><input id="pimpCStock" list="pimpCols" value="' + E(r.columnas.stock || '') + '"></div>' +
            '<div style="flex:1;min-width:150px"><label>Columna de descripción (opcional)</label><input id="pimpCNombre" list="pimpCols" value="' + E(r.columnas.nombre || '') + '"></div></div>' +
          '<div class="row" style="margin-top:8px">' +
            '<div style="flex:1;min-width:200px"><label>El código de la lista es…</label><select id="pimpMatch"><option value="codigoExterno"' + (r.matchPor === 'codigoExterno' ? ' selected' : '') + '>El código del proveedor (campo “Código externo” del producto)</option><option value="sku"' + (r.matchPor === 'sku' ? ' selected' : '') + '>Mi SKU</option></select></div>' +
            '<div style="width:170px"><label>La lista viene en…</label><select id="pimpMoneda" onchange="pimpAvisoMoneda()"><option value="ARS"' + (r.moneda === 'ARS' ? ' selected' : '') + '>Pesos</option><option value="USD"' + (r.moneda === 'USD' ? ' selected' : '') + '>Dólares</option></select></div></div>' +
          '<div id="pimpAvisoMon" class="muted" style="font-size:12px;margin-top:4px"></div>' +
          '<div class="row" style="margin-top:8px">' +
            '<div style="flex:1;min-width:200px"><label>Descuentos en cascada (%) separados por coma</label><input id="pimpDesc" placeholder="Ej: 10, 5, 3" value="' + E((r.descuentos || []).join(', ')) + '"></div>' +
            '<div style="width:150px"><label>Recargo / flete (%)</label><input id="pimpRecargo" type="number" step="0.01" value="' + (r.recargoPct || 0) + '"></div>' +
            '<div style="flex:1;min-width:200px;padding-bottom:8px"><label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" id="pimpIva" style="width:auto"' + (r.ivaIncluido ? ' checked' : '') + '> Los precios de la lista ya incluyen IVA</label></div></div>' +
          '<div class="muted" style="font-size:12px;margin:6px 0">El costo se calcula: precio de lista → descuentos uno tras otro → más el recargo → sin IVA (si la lista lo incluye). Es el costo que queda en el producto.</div>' +
          '<label style="margin-top:10px">Precios de venta: margen sobre ese costo, por lista de precios</label><div id="pimpMargenes"></div>' +
          '<button type="button" class="btn secondary" style="margin-top:6px" onclick="pimpSumarMargen()">Sumar otra lista de precios</button>' +
          '<div style="margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:10px">' +
            '<label style="display:flex;gap:8px;align-items:center;font-weight:700;color:var(--text)"><input type="checkbox" id="pimpStockOn" style="width:auto"' + (r.stock.activo ? ' checked' : '') + ' onchange="pimpToggleStock()"> Este proveedor manda stock</label>' +
            '<div id="pimpStockBox" class="' + (r.stock.activo ? '' : 'hidden') + '" style="margin-top:8px">' +
              '<label>Depósito donde se carga su stock</label><select id="pimpDeposito">' + dep + '</select>' +
              '<div class="muted" style="font-size:12px;margin-top:4px">Poné el depósito virtual del proveedor (ej. Colomé). Tu depósito propio (Junín) queda bloqueado: una lista del proveedor no puede tocar tu mercadería.</div>' +
              '<label style="display:flex;gap:8px;align-items:center;margin-top:8px;font-weight:600"><input type="checkbox" id="pimpCero" style="width:auto"' + (r.stock.ceroSiNoViene ? ' checked' : '') + '> Si un producto de este proveedor ya no figura en la lista, dejar su stock en 0</label>' +
            '</div></div>' +
          '<div class="row" style="margin-top:12px"><div style="width:220px"><label>Marcar “revisar” si el costo varía más de (%)</label><input id="pimpAlerta" type="number" min="0" max="100" value="' + (r.alertaPct == null ? 40 : r.alertaPct) + '"></div></div>' +
          '<div class="err" id="pimpReglaErr"></div><div class="ok-msg" id="pimpReglaOk"></div>' +
          '<button type="button" class="btn" style="margin-top:10px" onclick="pimpGrabarRegla()">Grabar regla</button>' +
        '</div></details>' +
      '<div class="card" style="padding:12px"><div style="font-weight:700;margin-bottom:8px">2. Subir la lista que mandó el proveedor</div>' +
        '<div class="row"><div style="flex:1;min-width:240px"><input type="file" id="pimpArchivo" accept=".xlsx,.xls,.csv" onchange="pimpElegirArchivo()"></div>' +
        '<button type="button" class="btn" id="pimpBtnPrev" onclick="pimpRevisar()" disabled>Revisar cambios</button></div>' +
        '<div class="err" id="pimpErr"></div><div id="pimpPreview" style="margin-top:10px"></div></div>' +
      '<div class="card" style="padding:12px"><div style="font-weight:700;margin-bottom:6px">Últimas actualizaciones</div><div id="pimpHist" class="muted">Cargando...</div></div>';
  }

  function pintarMargenes() {
    var cont = document.getElementById('pimpMargenes'); if (!cont) return;
    var ms = estado.regla.margenes || [];
    if (!ms.length) { cont.innerHTML = '<p class="muted" style="margin:4px 0">Todavía no elegiste ninguna lista. Sumá al menos “Consumidor Final”.</p>'; pimpAvisoMoneda(); return; }
    cont.innerHTML = ms.map(function (m, i) {
      var ops = estado.listas.filter(function (l) { return l.formula !== 'cf_x_bulto'; }).map(function (l) { return '<option value="' + l._id + '"' + (String(m.listaId) === String(l._id) ? ' selected' : '') + '>' + E(l.nombre) + '</option>'; }).join('');
      return '<div class="row pimp-m" style="margin-bottom:6px" data-i="' + i + '">' +
        '<div style="flex:1;min-width:160px"><select class="pm-lista">' + ops + '</select></div>' +
        '<div style="width:120px"><input class="pm-margen" type="number" step="0.01" placeholder="Margen %" value="' + (m.margenPct == null ? '' : m.margenPct) + '"></div>' +
        '<div style="width:150px"><select class="pm-red"><option value="0">Sin redondeo</option>' + [1, 5, 10, 50, 100].map(function (x) { return '<option value="' + x + '"' + (Number(m.redondeo) === x ? ' selected' : '') + '>Redondear a $' + x + '</option>'; }).join('') + '</select></div>' +
        '<label style="display:flex;gap:6px;align-items:center;margin:0 0 8px;font-weight:600"><input class="pm-iva" type="checkbox" style="width:auto"' + (m.incluyeIva ? ' checked' : '') + '> Sumar IVA al precio</label>' +
        '<button type="button" class="btn secondary" onclick="pimpQuitarMargen(' + i + ')">Quitar</button></div>';
    }).join('');
    pimpAvisoMoneda();
  }
  function leerMargenes() {
    return Array.prototype.map.call(document.querySelectorAll('.pimp-m'), function (row) {
      return { listaId: row.querySelector('.pm-lista').value, margenPct: row.querySelector('.pm-margen').value, redondeo: row.querySelector('.pm-red').value, incluyeIva: row.querySelector('.pm-iva').checked };
    });
  }
  window.pimpSumarMargen = function () {
    estado.regla.margenes = leerMargenes();
    var usadas = estado.regla.margenes.map(function (m) { return String(m.listaId); });
    var libre = estado.listas.find(function (l) { return l.formula !== 'cf_x_bulto' && usadas.indexOf(String(l._id)) < 0; });
    if (!libre) return;
    estado.regla.margenes.push({ listaId: libre._id, margenPct: '', redondeo: 0, incluyeIva: libre.incluyeIva === true });
    pintarMargenes();
  };
  window.pimpQuitarMargen = function (i) { estado.regla.margenes = leerMargenes(); estado.regla.margenes.splice(i, 1); pintarMargenes(); };
  window.pimpToggleStock = function () { document.getElementById('pimpStockBox').classList.toggle('hidden', !document.getElementById('pimpStockOn').checked); };
  window.pimpAvisoMoneda = function () {
    var el = document.getElementById('pimpAvisoMon'); if (!el) return;
    var usd = document.getElementById('pimpMoneda').value === 'USD';
    el.textContent = usd ? (estado.cotizacion ? 'El costo queda en dólares en el producto; los precios en pesos se calculan con el dólar de hoy ($ ' + num(estado.cotizacion, 2) + '). Si el dólar cambia, hay que volver a subir la lista para recalcular los precios.' : 'Atención: no hay cotización del dólar cargada (Productos → Listas de precio). Cargala antes de importar.') : '';
  };

  window.pimpDetectar = async function () {
    var f = document.getElementById('pimpEjemplo').files[0]; if (!f) return;
    var err = document.getElementById('pimpReglaErr'); err.textContent = '';
    try {
      var b64 = await leerArchivo(f);
      var fila = parseInt(document.getElementById('pimpFila').value, 10);
      var d = await pedir('/' + estado.id + '/encabezados', { method: 'POST', body: JSON.stringify({ archivoBase64: b64, hoja: document.getElementById('pimpHoja').value, filaEncabezado: document.getElementById('pimpFila').value && document.getElementById('pimpFila').dataset.manual ? fila : undefined }) });
      estado.headers = d.encabezados;
      document.getElementById('pimpFila').value = d.filaEncabezado;
      document.getElementById('pimpCols').innerHTML = d.encabezados.map(function (h) { return '<option value="' + E(h) + '">'; }).join('');
      var ponerSi = function (id, v) { var el = document.getElementById(id); if (!el.value && v) el.value = v; };
      ponerSi('pimpCCodigo', d.sugeridas.codigo); ponerSi('pimpCPrecio', d.sugeridas.precio); ponerSi('pimpCStock', d.sugeridas.stock); ponerSi('pimpCNombre', d.sugeridas.nombre);
      document.getElementById('pimpMuestra').innerHTML = 'Columnas encontradas (fila ' + d.filaEncabezado + '): <b>' + d.encabezados.map(E).join(' · ') + '</b>' + (d.hojas.length > 1 ? '<br>El archivo tiene ' + d.hojas.length + ' hojas: ' + d.hojas.map(E).join(', ') + '.' : '') +
        '<br>Primeras filas: ' + d.muestra.map(function (f2) { return E(f2.slice(0, 5).join(' | ')); }).join('  //  ');
    } catch (e) { err.textContent = e.message; }
  };
  document.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'pimpFila') ev.target.dataset.manual = '1'; });

  window.pimpGrabarRegla = async function () {
    var err = document.getElementById('pimpReglaErr'), ok = document.getElementById('pimpReglaOk');
    err.textContent = ''; ok.textContent = '';
    var body = {
      matchPor: document.getElementById('pimpMatch').value,
      columnas: { codigo: document.getElementById('pimpCCodigo').value, precio: document.getElementById('pimpCPrecio').value, stock: document.getElementById('pimpCStock').value, nombre: document.getElementById('pimpCNombre').value },
      hoja: document.getElementById('pimpHoja').value, filaEncabezado: document.getElementById('pimpFila').value,
      moneda: document.getElementById('pimpMoneda').value,
      descuentos: document.getElementById('pimpDesc').value.split(/[,;\s]+/).filter(Boolean).map(function (x) { return x.replace(',', '.'); }),
      recargoPct: document.getElementById('pimpRecargo').value, ivaIncluido: document.getElementById('pimpIva').checked,
      margenes: leerMargenes(),
      stock: { activo: document.getElementById('pimpStockOn').checked, depositoId: document.getElementById('pimpDeposito') ? document.getElementById('pimpDeposito').value : '', ceroSiNoViene: document.getElementById('pimpCero') ? document.getElementById('pimpCero').checked : false },
      alertaPct: document.getElementById('pimpAlerta').value
    };
    if (!body.columnas.codigo || !body.columnas.precio) { err.textContent = 'Indicá la columna del código y la del precio.'; return; }
    try { await pedir('/' + estado.id + '/regla', { method: 'PUT', body: JSON.stringify(body) }); ok.textContent = 'Regla grabada.'; estado.regla = body; }
    catch (e) { err.textContent = e.message; }
  };

  window.pimpElegirArchivo = async function () {
    var f = document.getElementById('pimpArchivo').files[0];
    document.getElementById('pimpPreview').innerHTML = ''; document.getElementById('pimpErr').textContent = '';
    if (!f) { estado.archivo = null; document.getElementById('pimpBtnPrev').disabled = true; return; }
    try { estado.archivo = await leerArchivo(f); estado.nombreArchivo = f.name; document.getElementById('pimpBtnPrev').disabled = false; }
    catch (e) { document.getElementById('pimpErr').textContent = e.message; }
  };

  window.pimpRevisar = async function () {
    var err = document.getElementById('pimpErr'), box = document.getElementById('pimpPreview'), btn = document.getElementById('pimpBtnPrev');
    err.textContent = ''; box.innerHTML = '<span class="muted">Calculando…</span>'; btn.disabled = true;
    try {
      var d = await pedir('/' + estado.id + '/preview', { method: 'POST', body: JSON.stringify({ archivoBase64: estado.archivo }) });
      var s = d.resumen;
      var tarjeta = function (n, t, c) { return '<div style="flex:1;min-width:120px;border:1px solid var(--border);border-radius:10px;padding:8px 10px"><div style="font-size:20px;font-weight:800;' + (c ? 'color:' + c : '') + '">' + n + '</div><div class="muted" style="font-size:12px">' + t + '</div></div>'; };
      var cols = d.muestra.length && d.muestra[0].precios ? d.muestra[0].precios : [];
      var filas = d.muestra.map(function (m) {
        var precios = (m.precios || []).map(function (p) { return '<div style="font-size:12px"><span class="muted">' + E(p.lista) + ':</span> ' + (p.anterior == null ? '—' : num(p.anterior)) + ' → <b>' + num(p.nuevo) + '</b></div>'; }).join('');
        var st = m.stock ? (m.stock.cambia ? m.stock.anterior + ' → <b>' + m.stock.nuevo + '</b>' : '<span class="muted">' + m.stock.nuevo + '</span>') : '';
        var v = m.variacionPct == null ? '' : '<span style="color:' + (m.variacionPct > 0 ? 'var(--danger)' : 'var(--ok, #1a7f4b)') + ';font-weight:700">' + (m.variacionPct > 0 ? '+' : '') + num(m.variacionPct, 1) + '%</span>';
        return '<tr' + (m.alerta ? ' style="background:rgba(214,69,65,.08)"' : '') + '><td>' + E(m.sku) + '</td><td>' + E(m.nombre) + (m.alerta ? ' <b style="color:var(--danger)">revisar</b>' : '') + '</td><td style="text-align:right">' + mon(m.costoAnterior, m.monedaAnterior) + ' → <b>' + mon(m.costoNuevo, m.moneda) + '</b> ' + v + '</td><td>' + precios + '</td><td style="text-align:right">' + st + '</td></tr>';
      }).join('');
      var sinMatch = d.sinMatch.length ? '<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">' + s.sinMatch + ' códigos de la lista no están en el sistema (no se tocan)</summary><div style="font-size:12px;margin-top:4px;max-height:160px;overflow:auto">' + d.sinMatch.map(function (x) { return E(x.codigo) + (x.nombre ? ' – ' + E(x.nombre) : ''); }).join('<br>') + '</div></details>' : '';
      var dup = d.duplicados.length ? '<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">' + s.duplicados + ' códigos ambiguos o repetidos (no se tocan)</summary><div style="font-size:12px;margin-top:4px">' + d.duplicados.map(function (x) { return E(x.codigo) + ': ' + x.productos.map(E).join('; '); }).join('<br>') + '</div></details>' : '';
      var cero = d.aCero.length ? '<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">' + s.stockACero + ' productos del proveedor ya no figuran: su stock pasa a 0</summary><div style="font-size:12px;margin-top:4px;max-height:140px;overflow:auto">' + d.aCero.map(function (x) { return E(x.sku) + ' – ' + E(x.nombre) + ' (' + x.anterior + ' → 0)'; }).join('<br>') + '</div></details>' : '';
      var hayAlgo = s.costosCambian || s.preciosCambian || s.stockCambia;
      box.innerHTML = '<div class="row" style="gap:8px">' + tarjeta(s.vinculados, 'productos encontrados de ' + s.filasArchivo + ' filas') + tarjeta(s.costosCambian, 'costos cambian') + tarjeta(s.preciosCambian, 'precios cambian') +
        (s.deposito ? tarjeta(s.stockCambia, 'stock cambia en ' + E(s.deposito)) : '') + (s.alertas ? tarjeta(s.alertas, 'para revisar (variación grande)', 'var(--danger)') : '') + '</div>' +
        (s.moneda === 'USD' ? '<div class="muted" style="font-size:12px;margin-top:6px">Lista en dólares, dólar usado: $ ' + num(s.cotizacionDolar, 2) + '</div>' : '') +
        (filas ? '<div style="overflow:auto;max-height:420px;margin-top:10px"><table><thead><tr><th>SKU</th><th>Producto</th><th style="text-align:right">Costo</th><th>Precios</th><th style="text-align:right">Stock</th></tr></thead><tbody>' + filas + '</tbody></table></div>' + (d.hayMas ? '<div class="muted" style="font-size:12px">Se muestran los 300 con más cambio; el resto también se actualiza.</div>' : '') : '<p class="muted">No hay ningún cambio para aplicar.</p>') +
        sinMatch + dup + cero +
        (hayAlgo ? '<div style="margin-top:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap"><button type="button" class="btn" id="pimpBtnAplicar" onclick="pimpAplicar()">Hacer la actualización</button>' + (s.alertas ? '<label style="display:flex;gap:6px;align-items:center;margin:0;font-weight:600"><input type="checkbox" id="pimpOmitir" style="width:auto"> No tocar los ' + s.alertas + ' marcados “revisar”</label>' : '') + '</div>' : '');
    } catch (e) { box.innerHTML = ''; err.textContent = e.message; }
    btn.disabled = false;
  };

  window.pimpAplicar = async function () {
    var err = document.getElementById('pimpErr'), box = document.getElementById('pimpPreview'), btn = document.getElementById('pimpBtnAplicar');
    var omitir = document.getElementById('pimpOmitir') ? document.getElementById('pimpOmitir').checked : false;
    if (!confirm('Se actualizan costos, precios y stock con esta lista. ¿Seguimos?')) return;
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Actualizando…';
    try {
      var d = await pedir('/' + estado.id + '/aplicar', { method: 'POST', body: JSON.stringify({ archivoBase64: estado.archivo, nombreArchivo: estado.nombreArchivo, omitirAlertas: omitir }) });
      var s = d.resumen;
      box.innerHTML = '<p class="ok-msg">Listo: ' + s.costosActualizados + ' costos, ' + s.preciosActualizados + ' precios y ' + s.stocksActualizados + ' stocks actualizados' + (s.omitidosPorAlerta ? ' (' + s.omitidosPorAlerta + ' marcados “revisar” quedaron sin tocar)' : '') + '.</p>';
      document.getElementById('pimpArchivo').value = ''; estado.archivo = null; document.getElementById('pimpBtnPrev').disabled = true;
      cargarHistorial();
    } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Hacer la actualización'; }
  };

  async function cargarHistorial() {
    var el = document.getElementById('pimpHist'); if (!el) return;
    try {
      var h = await pedir('/' + estado.id + '/historial');
      el.innerHTML = h.length ? '<table><thead><tr><th>Fecha</th><th>Archivo</th><th>Quién</th><th style="text-align:right">Costos</th><th style="text-align:right">Precios</th><th style="text-align:right">Stock</th></tr></thead><tbody>' + h.map(function (x) {
        var s = x.resumen || {};
        return '<tr><td>' + new Date(x.fecha).toLocaleString('es-AR') + '</td><td>' + E(x.archivo) + '</td><td>' + E(x.usuario) + '</td><td style="text-align:right">' + (s.costosActualizados || 0) + '</td><td style="text-align:right">' + (s.preciosActualizados || 0) + '</td><td style="text-align:right">' + (s.stocksActualizados || 0) + '</td></tr>';
      }).join('') + '</tbody></table>' : 'Todavía no importaste ninguna lista de este proveedor.';
    } catch (e) { el.textContent = e.message; }
  }
})();
