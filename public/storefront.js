(function () {
  var APP_URL = 'https://metroscuadrados.onrender.com';

  var QTY_INPUT_SELECTORS = [
    'input[name="quantity"]',
    '.js-item-qty',
    '.js-qty-input',
    'input.quantity-input'
  ];

  var TITLE_INSERT_SELECTORS = [
    '#single-product h1',
    '.product-name h1',
    'h1.js-product-name',
    'h1'
  ];

  var PRICE_SELECTORS = [
    '.js-price-display',
    '#product-price',
    '.product-prices .price',
    '.price ins',
    '.price'
  ];

  var UNIDADES = {
    m2: { nombre: 'm²', input: 'Metros cuadrados a cubrir', precioLabel: 'Precio por m²', rindeLabel: 'Rendimiento' },
    ml: { nombre: 'ml', input: 'Metros lineales a cubrir', precioLabel: 'Precio por metro lineal', rindeLabel: 'Rendimiento' },
    litro: { nombre: 'L', input: 'Litros a cubrir', precioLabel: 'Precio por litro', rindeLabel: 'Rendimiento' }
  };

  function query(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function findQtyInput() {
    return query(QTY_INPUT_SELECTORS);
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

  function buildWidget(precioCaja, coberturaCaja, unidad) {
    var precioM2 = precioCaja && coberturaCaja ? precioCaja / coberturaCaja : null;

    var wrapper = document.createElement('div');
    wrapper.id = 'calc-m2-widget-marca';
    wrapper.style.cssText = 'margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:8px;';

    var html = '';
    if (precioM2) {
      html += '<div style="font-size:20px;font-weight:600;margin-bottom:2px;">' + unidad.precioLabel + ': ' + formatPrice(precioM2) + '</div>';
      html += '<div style="font-size:14px;color:#666;margin-bottom:8px;">Precio por caja: ' + formatPrice(precioCaja) + '</div>';
    }
    html += '<div style="font-size:13px;color:#666;margin-bottom:8px;">' + unidad.rindeLabel + ': <strong>' + coberturaCaja.toFixed(2) + ' ' + unidad.nombre + ' por caja</strong></div>';
    html +=
      '<label style="display:block;font-size:13px;margin-bottom:4px;">' + unidad.input + '</label>' +
      '<input type="number" id="calc-m2-input" min="0.01" step="0.5" placeholder="' + unidad.input + '" ' +
      'style="width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;" />' +
      '<label id="calc-m2-desperdicio-label" style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;cursor:pointer;">' +
      '<span id="calc-m2-desperdicio" data-checked="true" style="width:18px;height:18px;border:2px solid #333;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;background:#333;color:#fff;font-size:13px;line-height:1;flex-shrink:0;box-sizing:border-box;">✓</span>' +
      'Incluir 10% de desperdicio (recomendado)</label>' +
      '<button type="button" id="calc-m2-btn" style="padding:8px 16px;cursor:pointer;">Calcular</button>' +
      '<div id="calc-m2-resultado" style="margin-top:10px;font-size:14px;"></div>';

    wrapper.innerHTML = html;
    return wrapper;
  }

  function handleFromUrl(pathname) {
    var match = pathname.match(/\/productos\/([^\/\?#]+)/);
    return match ? match[1] : null;
  }

  function esFichaDeProducto(pathname) {
    var partes = pathname.split('/').filter(Boolean);
    return partes.length >= 2 && partes[0] === 'productos';
  }

  function init() {
    if (document.getElementById('calc-m2-widget-marca')) return;
    if (!esFichaDeProducto(window.location.pathname)) return;

    var handle = handleFromUrl(window.location.pathname);
    if (!handle) return;

    var url = APP_URL + '/public/bulto-handle/' + handle + '?domain=' + encodeURIComponent(window.location.hostname);

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.coberturaCaja || !data.tipoUnidad || data.tipoUnidad === 'unidad') return;
        var unidad = UNIDADES[data.tipoUnidad];
        if (!unidad) return;

        var coberturaCaja = data.coberturaCaja;

        var qtyInput = findQtyInput();
        if (!qtyInput) return;

        var priceEl = query(PRICE_SELECTORS);
        var precioCaja = priceEl ? getPriceFromElement(priceEl) : null;

        var titleEl = query(TITLE_INSERT_SELECTORS);
        if (!titleEl) return;

        var widget = buildWidget(precioCaja, coberturaCaja, unidad);
        titleEl.parentElement.insertBefore(widget, titleEl.nextSibling);

        var inputM2 = widget.querySelector('#calc-m2-input');
        var checkDesperdicio = widget.querySelector('#calc-m2-desperdicio');
        var labelDesperdicio = widget.querySelector('#calc-m2-desperdicio-label');
        var resultado = widget.querySelector('#calc-m2-resultado');
        var boton = widget.querySelector('#calc-m2-btn');

        labelDesperdicio.addEventListener('click', function (e) {
          e.preventDefault();
          var checked = checkDesperdicio.getAttribute('data-checked') === 'true';
          checked = !checked;
          checkDesperdicio.setAttribute('data-checked', String(checked));
          checkDesperdicio.style.background = checked ? '#333' : '#fff';
          checkDesperdicio.textContent = checked ? '✓' : '';
        });

        boton.addEventListener('click', function () {
          var m2 = parseFloat(inputM2.value);
          var desperdicio = checkDesperdicio.getAttribute('data-checked') === 'true';

          if (!m2 || m2 <= 0) {
            resultado.style.color = '#c0392b';
            resultado.textContent = 'Ingresá los metros cuadrados a cubrir.';
            return;
          }

          var m2Ajustado = desperdicio ? m2 * 1.1 : m2;
          var bultosNecesarios = Math.ceil(m2Ajustado / coberturaCaja);
          var cubiertoReal = (bultosNecesarios * coberturaCaja).toFixed(2);

          qtyInput.value = bultosNecesarios;
          qtyInput.dispatchEvent(new Event('change', { bubbles: true }));

          resultado.style.color = '#27632a';
          var texto = 'Para cubrir ' + m2 + ' ' + unidad.nombre + (desperdicio ? ' (+10% desperdicio)' : '') +
            ' necesitás <strong>' + bultosNecesarios + ' caja(s)</strong> (rinden ' + cubiertoReal + ' ' + unidad.nombre + ').';
          if (precioCaja) {
            texto += '<br>Total estimado: <strong>' + formatPrice(bultosNecesarios * precioCaja) + '</strong>.';
          }
          texto += '<br>La cantidad ya se actualizó arriba.';
          resultado.innerHTML = texto;
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
