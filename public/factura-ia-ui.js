// ---------------------------------------------------------------------------
// FacturaIAUI — caja "Cargar la factura con IA" compartida por Compras y
// Gastos (5/10/2026, pedido de Mato). Permite sacar una foto, o subir un
// PDF u otro archivo; lo manda al servidor (POST <url>, ver facturaIA.js)
// y le devuelve a la pantalla el resultado para que complete el formulario.
//
// Uso:
//   en el HTML del formulario:  FacturaIAUI.cajaHtml('nc')
//   al abrir el formulario:     FacturaIAUI.registrar('nc', { url, headers: headersAuthJson, alResultado: fn })
//   después, desde la pantalla: FacturaIAUI.estado('nc', 'texto', esError), FacturaIAUI.avisos('nc', [...])
// ---------------------------------------------------------------------------
window.FacturaIAUI = (function () {
  var registro = {};
  var MAX_BYTES = 20 * 1024 * 1024;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function $(id) { return document.getElementById(id); }

  function inyectarEstilos() {
    if ($('facturaIaUiStyles')) return;
    var st = document.createElement('style');
    st.id = 'facturaIaUiStyles';
    st.textContent =
      '.fia-box{border:1px dashed var(--accent,#2a6);border-radius:10px;padding:12px;margin-bottom:14px;background:var(--bg,#f7f7f7)}' +
      '.fia-titulo{font-weight:800;margin-bottom:2px}' +
      '.fia-ayuda{font-size:12px;opacity:.75;margin-bottom:8px}' +
      '.fia-botones{display:flex;gap:8px;flex-wrap:wrap}' +
      '.fia-btn{cursor:pointer}' +
      '.fia-btn.deshabilitado{opacity:.45;pointer-events:none}' +
      '.fia-estado{font-size:13px;margin-top:8px}' +
      '.fia-estado.error{color:var(--danger,#c0392b)}' +
      '.fia-avisos{margin-top:8px;font-size:12px;border-left:3px solid #e0a800;padding:6px 10px;background:rgba(224,168,0,.12);border-radius:4px}' +
      '.fia-avisos div+div{margin-top:3px}' +
      '.fia-revision .fia-item{border:1px solid var(--border,#ddd);border-radius:8px;padding:10px;margin-top:8px;background:var(--card,#fff)}' +
      '.fia-revision .fia-item h4{margin:0 0 4px;font-size:13px}' +
      '.fia-revision .fia-sug{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}' +
      '.fia-revision .fia-acciones{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
      '.fia-revision .fia-buscar{position:relative;margin-top:6px}' +
      '.fia-revision .fia-opciones{position:absolute;left:0;right:0;z-index:5;background:var(--card,#fff);border:1px solid var(--border,#ddd);border-radius:8px;max-height:200px;overflow:auto}' +
      '.fia-revision .fia-opciones .opcion{padding:7px 10px;cursor:pointer;font-size:13px}' +
      '.fia-revision .fia-opciones .opcion:hover{background:var(--bg,#f2f2f2)}' +
      '.fia-revision .fia-opciones .sin-resultados{padding:7px 10px;font-size:12px;opacity:.7}';
    document.head.appendChild(st);
  }

  function cajaHtml(prefix, ayuda) {
    inyectarEstilos();
    return '<div class="fia-box" id="' + prefix + 'FiaBox">' +
      '<div class="fia-titulo">🧾 Cargar la factura con IA</div>' +
      '<div class="fia-ayuda">' + esc(ayuda || 'Sacá una foto o subí un PDF u otro archivo de la factura: la IA lee los datos y completa el formulario. Revisá todo antes de guardar.') + '</div>' +
      '<div class="fia-botones" id="' + prefix + 'FiaBotones">' +
      '<label class="btn secondary small fia-btn">📷 Sacar foto<input type="file" accept="image/*" capture="environment" hidden onchange="FacturaIAUI.elegido(this,\'' + prefix + '\')"></label>' +
      '<label class="btn secondary small fia-btn">📎 Subir archivo / PDF<input type="file" accept="image/*,application/pdf,.pdf,.xlsx,.xls,.csv,.txt,.xml,.json" hidden onchange="FacturaIAUI.elegido(this,\'' + prefix + '\')"></label>' +
      '</div>' +
      '<div class="fia-estado" id="' + prefix + 'FiaEstado"></div>' +
      '<div id="' + prefix + 'FiaAvisos"></div>' +
      '<div class="fia-revision" id="' + prefix + 'FiaRevision"></div>' +
      '</div>';
  }

  function registrar(prefix, cfg) { registro[prefix] = cfg; }

  function estado(prefix, texto, esError) {
    var el = $(prefix + 'FiaEstado');
    if (!el) return;
    el.textContent = texto || '';
    el.className = 'fia-estado' + (esError ? ' error' : '');
  }
  function avisos(prefix, lista) {
    var el = $(prefix + 'FiaAvisos');
    if (!el) return;
    lista = (lista || []).filter(Boolean);
    el.innerHTML = lista.length ? '<div class="fia-avisos">' + lista.map(function (a) { return '<div>⚠ ' + esc(a) + '</div>'; }).join('') + '</div>' : '';
  }
  function ocupado(prefix, si) {
    var cont = $(prefix + 'FiaBotones');
    if (cont) cont.querySelectorAll('.fia-btn').forEach(function (b) { b.classList.toggle('deshabilitado', !!si); });
  }

  function leerComoBase64(blobOFile) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).replace(/^data:[^;]*;base64,/, '')); };
      fr.onerror = function () { reject(new Error('No se pudo leer el archivo.')); };
      fr.readAsDataURL(blobOFile);
    });
  }

  // Las fotos de celular pesan varios MB: se reducen en el dispositivo
  // (máx. ~2200 px, JPEG) para subirlas más rápido. Si el navegador no
  // puede decodificarla se manda el archivo original y el servidor decide.
  function reducirImagen(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || /gif/.test(file.type)) return resolve(null);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var max = 2200, w = img.naturalWidth, h = img.naturalHeight;
          var k = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.round(w * k); c.height = Math.round(h * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          c.toBlob(function (blob) { URL.revokeObjectURL(url); resolve(blob); }, 'image/jpeg', 0.85);
        } catch (e) { URL.revokeObjectURL(url); resolve(null); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  async function elegido(input, prefix) {
    var file = input.files && input.files[0];
    input.value = '';
    var cfg = registro[prefix];
    if (!file || !cfg) return;
    if (file.size > MAX_BYTES) { estado(prefix, 'El archivo es demasiado grande (máximo 20 MB).', true); return; }
    ocupado(prefix, true);
    avisos(prefix, []);
    estado(prefix, 'Leyendo la factura… puede tardar unos segundos.');
    try {
      var reducida = await reducirImagen(file);
      var base64 = await leerComoBase64(reducida || file);
      var r = await fetch(cfg.url, {
        method: 'POST', headers: cfg.headers(),
        body: JSON.stringify({ archivoBase64: base64, mimeType: reducida ? 'image/jpeg' : (file.type || ''), nombreArchivo: file.name || '' })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(data.error || 'No se pudo leer la factura.');
      estado(prefix, 'Listo: revisá los datos cargados abajo antes de guardar.');
      await cfg.alResultado(data, file);
    } catch (e) {
      estado(prefix, e.message, true);
    } finally {
      ocupado(prefix, false);
    }
  }

  return { cajaHtml: cajaHtml, registrar: registrar, estado: estado, avisos: avisos, elegido: elegido, esc: esc };
})();
