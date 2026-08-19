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

  // Convierte "$ 47.811,24" en 47811.24 (formato AR: punto de miles, coma decimal)
  function parsePrice(text) {
    if (!text) return null;
    var cleaned = text.replace(/[^0-9.,]/g, '');
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    var value = parseFloat(cleaned);
    return isNaN(value) ? null : value;
  }

  function formatPrice(value) {
    return '$' + value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function buildWidget(precioCaja, coberturaCaja) {
    var precioM2 = precioCaja && coberturaCaja ? precioCaja / coberturaCaja : null;

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:8px;';

    var html = '';
    if (precioM2) {
      html += '<div style="font-size:20px;font-weight:600;margin-bottom:2px;">Precio por m²: ' + formatPrice(precioM2) + '</div>';
      html += '<div style="font-size:14px;color:#666;margin-bottom:8px;">Precio por caja: ' + formatPrice(precioCaja) + '</div>';
    }
    html += '<div style="font-size:13px;color:#666;margin-bottom:8px;">Rendimiento: <strong>' + coberturaCaja.toFixed(2) + ' m² por caja</strong></div>';
    html +=
      '<label style="display:block;font-size:13px;margin-bottom:4px;">Metros cuadrados a cubrir</label>' +
      '<input type="number" id="calc-m2-input" min="0.01" step="0.5" placeholder="m² a cubrir" ' +
      'style="width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;" />' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px;">' +
      '<input type="checkbox" id="calc-m2-desperdicio" checked /> Incluir 10% de desperdicio (recomendado)</label>' +
      '<button type="button" id="calc-m2-btn" style="padding:8px 16px;cursor:pointer;">Calcular</button>' +
      '<div id="calc-m2-resultado" style="margin-top:10px;font-size:14px;"></div>';

    wrapper.innerHTML = html;
    return wrapper;
  }

  function init() {
    if (!window.LS || !LS.product || !LS.product.id) return;

    fetch(APP_URL + '/public/bulto/' + LS.product.id)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.coberturaCaja) return;

        var coberturaCaja = data.coberturaCaja;

        var qtyInput = findQtyInput();
        if (!qtyInput) return;

        var priceEl = query(PRICE_SELECTORS);
        var precioCaja = priceEl ? parsePrice(priceEl.textContent) : null;

        var titleEl = query(TITLE_INSERT_SELECTORS);
        if (!titleEl) return;

        var widget = buildWidget(precioCaja, coberturaCaja);
        titleEl.parentElement.insertBefore(widget, titleEl.nextSibling);

        document.getElementById('calc-m2-btn').addEventListener('click', function () {
          var m2 = parseFloat(document.getElementById('calc-m2-input').value);
          var desperdicio = document.getElementById('calc-m2-desperdicio').checked;
          var resultado = document.getElementById('calc-m2-resultado');

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
          var texto = 'Para cubrir ' + m2 + ' m²' + (desperdicio ? ' (+10% desperdicio)' : '') +
            ' necesitás <strong>' + bultosNecesarios + ' caja(s)</strong> (rinden ' + cubiertoReal + ' m²).';
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
