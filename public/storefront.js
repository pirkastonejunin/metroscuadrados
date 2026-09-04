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
    m2: { nombre: 'm²', input: 'Metros cuadrados a cubrir', precioLabel: 'Precio por m²' },
    ml: { nombre: 'ml', input: 'Metros lineales a cubrir', precioLabel: 'Precio por metro lineal' },
    litro: { nombre: 'L', input: 'Litros a cubrir', precioLabel: 'Precio por litro' },
    unidad: { nombre: 'unidad(es)', input: 'Unidades a cubrir', precioLabel: 'Precio por unidad' }
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

  // Preferimos el atributo data-product-price (valor exacto en
  // centavos) si el theme lo trae; si no, parseamos el texto mostrado.
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

  function buildWidget(precioEnvase, coberturaEnvase, unidad, envase) {
    var precioUnidad = precioEnvase && coberturaEnvase ? precioEnvase / coberturaEnvase : null;

    var wrapper = document.createElement('div');
    wrapper.id = 'calc-m2-widget-marca';
    wrapper.style.cssText = 'margin:16px 0;padding:14px;border:1px solid #ddd;border-radius:8px;';

    var html = '';
    if (precioUnidad) {
      html += '<div style="font-size:20px;font-weight:600;margin-bottom:2px;">' + unidad.precioLabel + ': ' + formatPrice(precioUnidad) + '</div>';
      html += '<div style="font-size:14px;color:#666;margin-bottom:8px;">Precio por ' + envase + ': ' + formatPrice(precioEnvase) + '</div>';
    }
    html += '<div style="font-size:13px;color:#666;margin-bottom:8px;">Rendimiento: <strong>' + coberturaEnvase.toFixed(2) + ' ' + unidad.nombre + ' por ' + envase + '</strong></div>';
    html +=
      '<label style="display:block;font-size:13px;margin-bottom:4px;">' + unidad.input + '</label>' +
      '<input type="number" id="calc-m2-input" min="0.01" step="0.5" placeholder="' + unidad.input + '" ' +
      'style="width:100%;padding:8px;margin-bottom:8px;box-sizing:border-box;" />' +
      '<label id="calc-m2-desperdicio-label" style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:10px;cursor:pointer;">' +
      '<span id="calc-m2-desperdicio" data-checked="true" style="width:18px;height:18px;border:2px solid #333;border-radius:3px;display:inline-flex;align-items:center;justify-content:center;background:#333;color:#fff;font-size:13px;line-height:1;flex-shrink:0;box-sizing:border-box;">✓</span>' +
      'Incluir 10% de desperdicio (recomendado)</label>' +
      '<button type="button" id="calc-m2-btn" style="padding:8px 16px;cursor:pointer;">Calcular</button>' +
      '<div id="calc-m2-resultado" style="margin-top:10px;font-size:14px;"></div>' +
      '<div id="calc-m2-asociados" style="margin-top:14px;font-size:14px;"></div>';

    wrapper.innerHTML = html;
    return wrapper;
  }

  function handleFromUrl(pathname) {
    var match = pathname.match(/\/productos\/([^\/\?#]+)/);
    return match ? match[1].toLowerCase() : null;
  }

  function esFichaDeProducto(pathname) {
    var partes = pathname.split('/').filter(Boolean);
    return partes.length >= 2 && partes[0] === 'productos';
  }

  function init() {
    if (document.getElementById('calc-m2-widget-marca')) return; // ya insertado, no duplicar
    if (!esFichaDeProducto(window.location.pathname)) return;

    var handle = handleFromUrl(window.location.pathname);
    if (!handle) return;

    var url = APP_URL + '/public/bulto-handle/' + handle + '?domain=' + encodeURIComponent(window.location.hostname);

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.coberturaCaja || !data.tipoUnidad) return;
        var unidad = UNIDADES[data.tipoUnidad];
        if (!unidad) return;

        var coberturaEnvase = data.coberturaCaja;
        var envase = data.envase || 'caja';
        var asociados = data.asociados || [];

        var qtyInput = findQtyInput();
        if (!qtyInput) return;

        var priceEl = query(PRICE_SELECTORS);
        var precioEnvase = priceEl ? getPriceFromElement(priceEl) : null;

        var titleEl = query(TITLE_INSERT_SELECTORS);
        if (!titleEl) return;

        var widget = buildWidget(precioEnvase, coberturaEnvase, unidad, envase);
        titleEl.parentElement.insertBefore(widget, titleEl.nextSibling);

        var inputCantidad = widget.querySelector('#calc-m2-input');
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
          var cantidad = parseFloat(inputCantidad.value);
          var desperdicio = checkDesperdicio.getAttribute('data-checked') === 'true';

          if (!cantidad || cantidad <= 0) {
            resultado.style.color = '#c0392b';
            resultado.textContent = 'Ingresá una cantidad válida.';
            return;
          }

          var cantidadAjustada = desperdicio ? cantidad * 1.1 : cantidad;
          var envasesNecesarios = Math.ceil(cantidadAjustada / coberturaEnvase);
          var cubiertoReal = (envasesNecesarios * coberturaEnvase).toFixed(2);

          qtyInput.value = envasesNecesarios;
          qtyInput.dispatchEvent(new Event('change', { bubbles: true }));

          resultado.style.color = '#27632a';
          var texto = 'Para ' + cantidad + ' ' + unidad.nombre + (desperdicio ? ' (+10% desperdicio)' : '') +
            ' necesitás <strong>' + envasesNecesarios + ' ' + envase + '(s)</strong> (rinden ' + cubiertoReal + ' ' + unidad.nombre + ').';
          if (precioEnvase) {
            texto += '<br>Total estimado: <strong>' + formatPrice(envasesNecesarios * precioEnvase) + '</strong>.';
          }
          texto += '<br>La cantidad ya se actualizó arriba.';
          resultado.innerHTML = texto;

          renderAsociados(cantidadAjustada);
        });

        function renderAsociados(cantidadNecesaria) {
          var cont = widget.querySelector('#calc-m2-asociados');
          if (!asociados.length) { cont.innerHTML = ''; return; }

          var html = '<div style="border-top:1px solid #ddd;padding-top:12px;">' +
            '<div style="font-weight:600;margin-bottom:8px;">También vas a necesitar</div>';

          asociados.forEach(function (a, i) {
            var cantidad = Math.ceil(cantidadNecesaria / a.rinde);
            html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">';
            if (a.imagen) {
              html += '<img src="' + a.imagen + '" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;flex-shrink:0;" />';
            }
            html += '<div style="flex:1;min-width:0;">' +
              (a.url
                ? '<a href="' + a.url + '" style="font-weight:600;text-decoration:underline;">' + a.nombre + '</a>'
                : '<span style="font-weight:600;">' + a.nombre + '</span>') +
              '<div style="font-size:13px;color:#666;">' + cantidad + ' x' +
              (a.precio ? ' — ' + formatPrice(cantidad * a.precio) : '') + '</div>' +
              '</div>';
            if (a.variant_id) {
              html += '<button type="button" class="calc-m2-add" data-variant="' + a.variant_id +
                '" data-cantidad="' + cantidad + '" style="padding:6px 12px;cursor:pointer;flex-shrink:0;">Agregar</button>';
            }
            html += '</div>';
          });

          html += '</div>';
          cont.innerHTML = html;

          cont.querySelectorAll('.calc-m2-add').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var variantId = btn.getAttribute('data-variant');
              var cant = btn.getAttribute('data-cantidad');
              btn.textContent = 'Agregando...';
              btn.disabled = true;

              fetch('/comprar/' + variantId + '?quantity=' + cant, { method: 'GET' })
                .then(function () {
                  btn.textContent = 'Agregado ✓';
                })
                .catch(function () {
                  btn.textContent = 'Error';
                  btn.disabled = false;
                });
            });
          });
        }
      })
      .catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
