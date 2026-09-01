(function () {
  var APP_URL = 'https://metroscuadrados.onrender.com';

  var PRICE_SELECTORS = [
    '.js-price-display',
    '.item-price',
    '.product-prices .price',
    '.price ins',
    '.price'
  ];

  var UNIDADES = {
    m2: 'm²',
    ml: 'ml',
    litro: 'L'
  };

  function handleFromUrl(url) {
    if (!url) return null;
    var match = url.match(/\/productos\/([^\/\?#]+)/);
    return match ? match[1].toLowerCase() : null;
  }

  function parsePrice(text) {
    if (!text) return null;
    var cleaned = text.replace(/[^0-9.,]/g, '');
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    var value = parseFloat(cleaned);
    return isNaN(value) ? null : value;
  }

  function getPriceFromElement(el) {
    var raw = el.getAttribute('data-product-price');
    if (raw) {
      var value = parseInt(raw, 10);
      if (!isNaN(value)) return value / 100;
    }
    return parsePrice(el.textContent);
  }

  function formatPrice(value) {
    return '$' + value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Sube desde el precio (unico por producto) buscando, nivel por
  // nivel, el ancestro mas cercano que contenga ALGUN link a
  // /productos/. Como puede haber varios <a> por tarjeta (imagen,
  // titulo, etc.), buscamos el primero que aparezca al subir de a
  // poco, para no terminar agarrando un link de otro producto vecino.
  function findHandleParaPrecio(priceEl) {
    var el = priceEl;
    for (var i = 0; i < 10; i++) {
      if (!el.parentElement) break;
      el = el.parentElement;
      var link = el.querySelector('a[href*="/productos/"]');
      if (link) {
        return handleFromUrl(link.getAttribute('href'));
      }
    }
    return null;
  }

  function esFichaDeProducto(pathname) {
    var partes = pathname.split('/').filter(Boolean);
    return partes.length >= 2 && partes[0] === 'productos';
  }

  function init() {
    // Nunca correr dentro de la ficha de un producto individual (aunque
    // tenga varias tarjetas de "productos relacionados" abajo, que
    // podrian confundirse con una grilla de categoria). Se detecta por
    // la URL en vez de LS, que no esta disponible de forma confiable
    // en todas las fichas de esta tienda.
    if (esFichaDeProducto(window.location.pathname)) return;

    var selectorCombinado = PRICE_SELECTORS.join(',');
    var priceEls = document.querySelectorAll(selectorCombinado);
    if (priceEls.length < 2) return; // pagina de producto individual, no listado

    var handleToPriceEl = {};
    priceEls.forEach(function (priceEl) {
      var handle = findHandleParaPrecio(priceEl);
      if (handle && !handleToPriceEl[handle]) {
        handleToPriceEl[handle] = priceEl;
      }
    });

    if (Object.keys(handleToPriceEl).length < 2) return;

    fetch(APP_URL + '/public/catalogo-precios?domain=' + encodeURIComponent(window.location.hostname))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var productos = data.productos || [];
        if (!productos.length) return;

        productos.forEach(function (p) {
          var priceEl = handleToPriceEl[p.handle];
          if (!priceEl) return;

          var precioCaja = getPriceFromElement(priceEl);
          if (!precioCaja || !p.coberturaCaja) return;

          var precioM2 = precioCaja / p.coberturaCaja;
          var unidadNombre = UNIDADES[p.tipoUnidad] || 'm²';

          priceEl.innerHTML =
            '<span>' + formatPrice(precioM2) + ' /' + unidadNombre + '</span>' +
            '<div style="font-size:11px;color:#888;font-weight:normal;">' + (p.envase || 'caja') + ' ' + formatPrice(precioCaja) + '</div>';
        });
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
