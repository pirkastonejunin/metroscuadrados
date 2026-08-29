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

  // Sube desde el link de producto hasta encontrar el contenedor
  // "tarjeta" mas probable (hermanos del mismo tag = item repetido
  // en una grilla). No depende de adivinar la clase CSS del theme.
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

  function findPriceEl(card) {
    for (var i = 0; i < PRICE_SELECTORS.length; i++) {
      var el = card.querySelector(PRICE_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function init() {
    var links = document.querySelectorAll('a[href*="/productos/"]');
    if (links.length < 2) return; // pagina de producto individual, no listado

    var handleToCard = {};
    links.forEach(function (link) {
      var handle = handleFromUrl(link.getAttribute('href'));
      if (handle && !handleToCard[handle]) {
        handleToCard[handle] = findCardContainer(link);
      }
    });

    if (Object.keys(handleToCard).length < 2) return;

    fetch(APP_URL + '/public/catalogo-precios?domain=' + encodeURIComponent(window.location.hostname))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var productos = data.productos || [];
        if (!productos.length) return;

        productos.forEach(function (p) {
          var card = handleToCard[p.handle];
          if (!card) return;

          var priceEl = findPriceEl(card);
          if (!priceEl) return;

          var precioCaja = getPriceFromElement(priceEl);
          if (!precioCaja || !p.coberturaCaja) return;

          var precioM2 = precioCaja / p.coberturaCaja;
          var unidadNombre = UNIDADES[p.tipoUnidad] || 'm²';

          priceEl.innerHTML =
            '<span>' + formatPrice(precioM2) + ' /' + unidadNombre + '</span>' +
            '<div style="font-size:11px;color:#888;font-weight:normal;">caja ' + formatPrice(precioCaja) + '</div>';
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
