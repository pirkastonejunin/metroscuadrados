(function () {
  var APP_URL = 'https://metroscuadrados.onrender.com';

  // Encuentra, para un link de producto, el contenedor "tarjeta" mas
  // probable: sube en el arbol hasta encontrar un elemento que tenga
  // hermanos del mismo tag (senal de que es un item repetido en una grilla).
  // Esto evita tener que adivinar la clase CSS exacta del theme.
  function findCardContainer(link) {
    var el = link;
    for (var i = 0; i < 6; i++) {
      if (!el.parentElement) break;
      var mismoTag = Array.prototype.filter.call(el.parentElement.children, function (c) {
        return c.tagName === el.tagName;
      });
      if (mismoTag.length >= 2) return el;
      el = el.parentElement;
    }
    return link;
  }

  function handleFromUrl(url) {
    if (!url) return null;
    var match = url.match(/\/productos\/([^\/\?#]+)/);
    return match ? match[1] : null;
  }

  function init() {
    var links = document.querySelectorAll('a[href*="/productos/"]');
    if (links.length < 2) return; // pagina de producto individual, no es un listado

    // Agrupa por handle (puede haber mas de un <a> por producto: imagen y titulo)
    var handleToCard = {};
    links.forEach(function (link) {
      var handle = handleFromUrl(link.getAttribute('href'));
      if (handle && !handleToCard[handle]) {
        handleToCard[handle] = findCardContainer(link);
      }
    });

    var handles = Object.keys(handleToCard);
    if (handles.length < 2) return;

    fetch(APP_URL + '/public/catalogo')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var productos = (data.productos || []).filter(function (p) {
          var h = handleFromUrl(p.url);
          return h && handleToCard[h];
        });
        if (!productos.length) return;

        var materiales = [];
        productos.forEach(function (p) {
          if (p.material && materiales.indexOf(p.material) === -1) materiales.push(p.material);
        });
        if (!materiales.length) return;

        var handleToMaterial = {};
        productos.forEach(function (p) {
          var h = handleFromUrl(p.url);
          handleToMaterial[h] = p.material;
        });

        insertarPanel(materiales, handleToCard, handleToMaterial);
      })
      .catch(function () {});
  }

  function insertarPanel(materiales, handleToCard, handleToMaterial) {
    // Ancla de insercion: el padre comun de las tarjetas encontradas
    var primerCard = handleToCard[Object.keys(handleToCard)[0]];
    var contenedorGrilla = primerCard.parentElement;
    if (!contenedorGrilla || !contenedorGrilla.parentElement) return;

    var panel = document.createElement('div');
    panel.style.cssText = 'margin:14px 0;padding:12px;border:1px solid #ddd;border-radius:8px;';

    var html = '<div style="font-weight:600;font-size:14px;margin-bottom:8px;">Filtrar por material</div>';
    materiales.forEach(function (m) {
      var id = 'filtro-material-' + m.replace(/\s+/g, '-');
      html += '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:14px;margin-bottom:6px;font-size:13px;">' +
        '<input type="checkbox" class="filtro-material-chk" value="' + m + '" id="' + id + '" /> ' + m + '</label>';
    });
    panel.innerHTML = html;

    contenedorGrilla.parentElement.insertBefore(panel, contenedorGrilla);

    panel.querySelectorAll('.filtro-material-chk').forEach(function (chk) {
      chk.addEventListener('change', function () {
        aplicarFiltro(panel, handleToCard, handleToMaterial);
      });
    });
  }

  function aplicarFiltro(panel, handleToCard, handleToMaterial) {
    var seleccionados = Array.prototype.map.call(
      panel.querySelectorAll('.filtro-material-chk:checked'),
      function (chk) { return chk.value; }
    );

    Object.keys(handleToCard).forEach(function (handle) {
      var card = handleToCard[handle];
      var material = handleToMaterial[handle];
      var visible = seleccionados.length === 0 || seleccionados.indexOf(material) !== -1;
      card.style.display = visible ? '' : 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
