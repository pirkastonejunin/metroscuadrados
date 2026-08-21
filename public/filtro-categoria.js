(function () {
  var APP_URL = 'https://metroscuadrados.onrender.com';

  // Candidatos para el contenedor de cada producto en la grilla de categoria.
  // Cada item debe tener adentro un <a> que apunte a /productos/{handle}
  var ITEM_SELECTORS = [
    '.js-item-product',
    '.item-product',
    '.product-item',
    'li.item'
  ];

  var GRID_SELECTORS = [
    '.js-product-list',
    '.category-products',
    '.product-list',
    '#category-products'
  ];

  function query(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function queryAll(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      if (els.length > 0) return els;
    }
    return [];
  }

  function handleFromHref(href) {
    if (!href) return null;
    var match = href.match(/\/productos\/([^\/\?#]+)/);
    return match ? match[1] : null;
  }

  function init() {
    if (!window.LS || !LS.category || !LS.category.id) return;

    var items = queryAll(ITEM_SELECTORS);
    if (!items.length) return;

    fetch(APP_URL + '/public/atributos-categoria/' + LS.category.id)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.facetas || Object.keys(data.facetas).length === 0) return;

        // Mapa handle -> atributos, para cruzar con los items del DOM
        var handleToAtributos = {};
        data.productos.forEach(function (p) {
          if (p.handle) handleToAtributos[p.handle] = p.atributos;
        });

        // Le pone a cada item del DOM sus atributos en un data-attr
        var itemsConDatos = [];
        items.forEach(function (item) {
          var link = item.querySelector('a[href*="/productos/"]');
          var handle = link ? handleFromHref(link.getAttribute('href')) : null;
          var atributos = handle ? handleToAtributos[handle] : null;
          if (atributos) {
            itemsConDatos.push({ el: item, atributos: atributos });
          }
        });

        if (!itemsConDatos.length) return;

        var panel = buildFilterPanel(data.facetas, itemsConDatos);
        var grid = query(GRID_SELECTORS) || items[0].parentElement;
        grid.parentElement.insertBefore(panel, grid);
      })
      .catch(function () {});
  }

  function buildFilterPanel(facetas, itemsConDatos) {
    var panel = document.createElement('div');
    panel.style.cssText = 'margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:8px;';

    var html = '<div style="font-weight:600;margin-bottom:10px;">Filtrar por</div>';
    Object.keys(facetas).forEach(function (clave) {
      html += '<div style="margin-bottom:10px;">';
      html += '<div style="font-size:13px;color:#666;margin-bottom:4px;">' + clave + '</div>';
      facetas[clave].forEach(function (valor) {
        var id = 'filtro-' + clave + '-' + valor;
        html += '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;">' +
          '<input type="checkbox" class="filtro-atributo" data-clave="' + clave + '" data-valor="' + valor + '" id="' + id + '" /> ' + valor + '</label>';
      });
      html += '</div>';
    });

    panel.innerHTML = html;

    panel.querySelectorAll('.filtro-atributo').forEach(function (chk) {
      chk.addEventListener('change', function () {
        aplicarFiltros(panel, itemsConDatos);
      });
    });

    return panel;
  }

  function aplicarFiltros(panel, itemsConDatos) {
    var seleccionados = {}; // { clave: [valores seleccionados] }
    panel.querySelectorAll('.filtro-atributo:checked').forEach(function (chk) {
      var clave = chk.getAttribute('data-clave');
      var valor = chk.getAttribute('data-valor');
      if (!seleccionados[clave]) seleccionados[clave] = [];
      seleccionados[clave].push(valor);
    });

    var claves = Object.keys(seleccionados);

    itemsConDatos.forEach(function (item) {
      var visible = claves.every(function (clave) {
        return seleccionados[clave].indexOf(item.atributos[clave]) !== -1;
      });
      item.el.style.display = visible ? '' : 'none';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
