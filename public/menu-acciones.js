// Agrupa los botones de acción SECUNDARIOS que quedan varios juntos en
// una misma fila (ej: Imprimir + Generar Nota de Crédito + Anular, en el
// detalle de una venta) bajo un único botón "⚙" que despliega un menú de
// texto con cada opción — pensado para pantallas donde ya quedaban
// muchos íconos pegados unos a otros (3/10/2026, pedido de Mato: "la
// otra opcion es poner un engranaje y q de ahi se despliegue un menu con
// todas las opciones quizas esa queda mas ordenada aun" — confirmado
// para "en todas las pantallas con varios botones juntos").
//
// Se apoya en btn-iconos.js: SOLO agrupa botones que ya quedaron
// marcados como ícono de acción (data-accion-icono="1") — nunca toca
// botones de sección/categoría (esos nunca se marcan así) ni filas con
// un único botón.
//
// Reglas de seguridad, para no romper nada de lo que ya funciona:
//  - Guardar (💾) y Confirmar/Aplicar/Procesar/Registrar (✓) NUNCA se
//    agrupan: son la acción PRINCIPAL del formulario, tienen que seguir
//    visibles siempre, no escondidas en un menú.
//  - Un botón cuyo onclick usa "this." (ej: "this.closest(...)") tampoco
//    se agrupa — mover/clonar ese click a otro lugar del DOM podría
//    hacer que "this" ya no apunte a donde tiene que apuntar.
//  - Recién agrupa cuando quedan 3 o más botones elegibles juntos en el
//    mismo contenedor — una pareja típica (ej. Guardar + Cancelar) se
//    deja como estaba, un menú de una sola opción no tendría sentido.
//  - Los botones originales NO se mueven de lugar (se ocultan con
//    display:none nomás): las opciones del menú son botones nuevos que
//    copian el mismo onclick, así ningún comportamiento que dependa de
//    la posición en el DOM se ve afectado.
(function () {
  var ICONOS_PRINCIPALES = ['💾', '✓'];
  var UMBRAL = 3;

  function esRiesgoso(btn) {
    var onclick = btn.getAttribute('onclick') || '';
    return /\bthis\s*\./.test(onclick);
  }

  function esElegible(btn) {
    // El `closest` es una segunda red de seguridad (la principal es
    // marcar trigger/items con data-iconizado al crearlos, más abajo):
    // un botón que ya es parte de un menú armado por este mismo script
    // nunca puede volver a agruparse — eso fue lo que colgó la página
    // (3/10/2026, bug real reportado por Mato: "cuando quiero abrir
    // venta y entrar a una queda trabada la pagina"): btn-iconos.js veía
    // el "⚙" y los ítems del menú como botones nuevos, les ponía
    // data-accion-icono, y este script los volvía a agrupar en un menú
    // DENTRO del menú — en bucle infinito, uno más anidado que el
    // anterior, para siempre.
    return btn.tagName === 'BUTTON' &&
      btn.dataset.accionIcono === '1' &&
      ICONOS_PRINCIPALES.indexOf(btn.textContent) === -1 &&
      !esRiesgoso(btn) &&
      !btn.closest('.menu-acciones-wrap');
  }

  function cerrarTodosLosMenus(exceptoPanel) {
    document.querySelectorAll('.menu-acciones-panel').forEach(function (p) {
      if (p !== exceptoPanel) { p.classList.remove('abierto'); p.style.display = 'none'; }
    });
  }

  // El menú se ubica con position:fixed (7/10/2026, bug reportado por Mato en Clientes:
  // el menú del engranaje quedaba fuera de pantalla). Así no lo recorta el
  // contenedor de la tabla (overflow) y se acomoda: alineado al borde derecho del
  // engranaje, y hacia arriba si abajo no entra.
  function ubicarPanel(trigger, panel) {
    var r = trigger.getBoundingClientRect();
    var w = panel.offsetWidth, h = panel.offsetHeight, m = 8;
    var left = r.right - w;
    if (left + w > window.innerWidth - m) left = window.innerWidth - m - w;
    if (left < m) left = m;
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - m) top = Math.max(m, r.top - h - 4);
    panel.style.position = 'fixed';
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.marginTop = '0';
    panel.style.zIndex = '1000';
  }

  function armarMenu(cont) {
    if (!cont || cont.dataset.menuArmado) return;
    var hijos = Array.prototype.slice.call(cont.children);
    var elegibles = hijos.filter(esElegible);
    if (elegibles.length < UMBRAL) return;

    cont.dataset.menuArmado = '1';

    var envoltorio = document.createElement('span');
    envoltorio.className = 'menu-acciones-wrap';
    envoltorio.style.position = 'relative';
    envoltorio.style.display = 'inline-block';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = elegibles[0].className;
    trigger.title = 'Más acciones';
    trigger.setAttribute('aria-label', 'Más acciones');
    trigger.textContent = '⚙';
    // Clave del fix: se marca como "ya procesado" ANTES de insertarlo en
    // el documento, así btn-iconos.js lo ignora por completo (su guarda
    // es "if (btn.dataset.iconizado) return;") y nunca le toca el
    // contenido ni lo marca como accionIcono.
    trigger.dataset.iconizado = '1';

    var panel = document.createElement('div');
    panel.className = 'menu-acciones-panel';
    panel.style.cssText = 'display:none;position:absolute;top:100%;left:0;z-index:40;background:#fff;' +
      'border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.12);' +
      'min-width:200px;padding:4px;margin-top:4px;';

    elegibles.forEach(function (b) {
      var item = document.createElement('button');
      item.type = 'button';
      item.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;text-align:left;' +
        'background:none;border:none;padding:8px 10px;font-size:13.5px;cursor:pointer;border-radius:6px;';
      item.onmouseenter = function () { item.style.background = '#f2f1ee'; };
      item.onmouseleave = function () { item.style.background = 'none'; };
      var spanIcono = document.createElement('span');
      spanIcono.textContent = b.textContent;
      var spanTexto = document.createElement('span');
      spanTexto.textContent = b.title || b.getAttribute('aria-label') || '';
      item.appendChild(spanIcono);
      item.appendChild(spanTexto);
      item.dataset.iconizado = '1'; // mismo fix que el trigger, ver más arriba
      var onclickAttr = b.getAttribute('onclick');
      if (onclickAttr) item.setAttribute('onclick', onclickAttr);
      item.addEventListener('click', function () { panel.classList.remove('abierto'); });
      panel.appendChild(item);
      b.style.display = 'none';
    });

    trigger.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var yaAbierto = panel.classList.contains('abierto');
      cerrarTodosLosMenus(null);
      panel.classList.toggle('abierto', !yaAbierto);
      panel.style.display = panel.classList.contains('abierto') ? 'block' : 'none';
      if (!yaAbierto) ubicarPanel(trigger, panel);
    });

    cont.insertBefore(envoltorio, elegibles[0]);
    envoltorio.appendChild(trigger);
    envoltorio.appendChild(panel);
  }

  function contenedoresDesde(nodo) {
    var set = [];
    if (!nodo || nodo.nodeType !== 1) return set;
    if (nodo.matches && nodo.matches('button[data-accion-icono="1"]') && nodo.parentElement) {
      set.push(nodo.parentElement);
    }
    if (nodo.querySelectorAll) {
      nodo.querySelectorAll('button[data-accion-icono="1"]').forEach(function (b) {
        if (b.parentElement && set.indexOf(b.parentElement) === -1) set.push(b.parentElement);
      });
    }
    return set;
  }

  function procesarDesde(nodo) {
    contenedoresDesde(nodo).forEach(armarMenu);
  }

  function iniciar() {
    procesarDesde(document.body);
    document.addEventListener('click', function () { cerrarTodosLosMenus(null); });
    window.addEventListener('resize', function () { cerrarTodosLosMenus(null); });
    window.addEventListener('scroll', function () { cerrarTodosLosMenus(null); }, true);
    var obs = new MutationObserver(function (mutaciones) {
      for (var i = 0; i < mutaciones.length; i++) {
        var nodos = mutaciones[i].addedNodes;
        for (var j = 0; j < nodos.length; j++) procesarDesde(nodos[j]);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Corre DESPUÉS de btn-iconos.js (que es el que pone
  // data-accion-icono) — como btn-iconos.js también usa
  // DOMContentLoaded + MutationObserver, alcanza con iniciar igual acá;
  // el primer pase de este script ve lo que btn-iconos.js ya procesó en
  // el pase sincrónico inicial, y los casos que llegan después (botones
  // armados en tiempo de ejecución) los ve el MutationObserver de este
  // mismo script, que corre en paralelo al de btn-iconos.js.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
