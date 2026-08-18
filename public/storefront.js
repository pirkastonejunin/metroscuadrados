(function () {
  // Reemplazar por la URL real donde deployaste el backend (server.js)
  var APP_URL = 'https://TU-APP-DEPLOYADA.onrender.com';

  var QTY_INPUT_SELECTORS = [
    'input[name="quantity"]',
    '.js-item-qty',
    '.js-qty-input',
    'input.quantity-input'
  ];

  function findQtyInput() {
    for (var i = 0; i < QTY_INPUT_SELECTORS.length; i++) {
      var el = document.querySelector(QTY_INPUT_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function buildWidget(bultoUnidades) {
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:8px;';
    wrapper.innerHTML =
      '<div style="font-size:13px;color:#666;margin-bottom:8px;">' +
      'Este bulto trae <strong>' + bultoUnidades + ' unidades</strong></div>' +
      '<label style="display:block;font-size:13px;margin-bottom:4px;">Metros cuadrados a cubrir</label>' +
      '<input type="number" id="calc-m2-input" min="0.01" step="0.5" ' +
      'style="width:100%;padding:8px;margin-bottom:6px;box-sizing:border-box;" />' +
      '<label style="display:block;font-size:13px;margin-bottom:4px;">Cobertura de cada unidad (m²)</label>' +
      '<input type="number" id="calc-cobertura-input" min="0.01" step="0.01" ' +
      'style="width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;" />' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px;">' +
      '<input type="checkbox" id="calc-m2-desperdicio" checked /> Incluir 10% de desperdicio</label>' +
      '<button type="button" id="calc-m2-btn" style="padding:8px 16px;cursor:pointer;">Calcular</button>' +
      '<div id="calc-m2-resultado" style="margin-top:10px;font-size:14px;"></div>';
    return wrapper;
  }

  function init() {
    if (!window.LS || !LS.product || !LS.product.id) return;

    fetch(APP_URL + '/public/bulto/' + LS.product.id)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.value) return;
        var bultoUnidades = parseFloat(data.value);

        var qtyInput = findQtyInput();
        if (!qtyInput) return;

        var widget = buildWidget(bultoUnidades);
        var container = qtyInput.closest('form') || qtyInput.parentElement;
        container.appendChild(widget);

        document.getElementById('calc-m2-btn').addEventListener('click', function () {
          var m2 = parseFloat(document.getElementById('calc-m2-input').value);
          var coberturaUnidad = parseFloat(document.getElementById('calc-cobertura-input').value);
          var desperdicio = document.getElementById('calc-m2-desperdicio').checked;
          var resultado = document.getElementById('calc-m2-resultado');

          if (!m2 || m2 <= 0 || !coberturaUnidad || coberturaUnidad <= 0) {
            resultado.style.color = '#c0392b';
            resultado.textContent = 'Completá los metros cuadrados y la cobertura por unidad.';
            return;
          }

          var m2Ajustado = desperdicio ? m2 * 1.1 : m2;
          var unidadesNecesarias = Math.ceil(m2Ajustado / coberturaUnidad);
          var bultosNecesarios = Math.ceil(unidadesNecesarias / bultoUnidades);
          var cubierto = (unidadesNecesarias * coberturaUnidad).toFixed(2);

          qtyInput.value = bultosNecesarios;
          qtyInput.dispatchEvent(new Event('change', { bubbles: true }));

          resultado.style.color = '#27632a';
          resultado.textContent =
            'Necesitás ' + unidadesNecesarias + ' unidad(es) (' + cubierto + ' m²) = ' +
            bultosNecesarios + ' bulto(s). Cantidad actualizada arriba.';
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
