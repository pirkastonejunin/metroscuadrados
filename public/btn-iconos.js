// Convierte automáticamente los botones de ACCIÓN (Guardar, Cancelar,
// Eliminar, Editar, etc.) a solo-ícono con tooltip al pasar el mouse, en
// todas las pantallas que cargan este script — así se ve más limpio sin
// tener que tocar cada botón a mano, uno por uno, en los ~20 archivos del
// sistema (3/10/2026, pedido de Mato: "que los botones tengan iconos y al
// pasar el mouse nos diga que es, para limpiar mas las pantallas").
//
// Cómo funciona: NO hace falta tocar el onclick de cada botón — solo se
// reemplaza lo que se VE (textContent) y se agrega el title/aria-label.
// Como la mayoría de los botones de este sistema se generan recién en
// tiempo de ejecución (listas, modales, detalles de venta, etc.), un solo
// pase al cargar la página no alcanza: se usa un MutationObserver que
// vigila TODO el documento y procesa cualquier botón nuevo que aparezca,
// en cualquier pantalla, en cualquier momento.
//
// A propósito, SOLO se convierten los botones cuyo texto coincide con un
// verbo de acción conocido (Guardar, Cancelar, Editar, Agregar...) — los
// botones que son nombres de sección/categoría (ej. "Usuarios", "Roles",
// "Formas de pago", "Pegamento") se dejan con su texto tal cual, porque
// convertirlos a un ícono genérico los haría más confusos, no más
// prolijos.
(function () {
  // [patrón (ya en minúscula y sin acentos), ícono]. Se evalúa en orden,
  // de más específico a más genérico — alcanza con que el texto del botón
  // EMPIECE con el patrón.
  var REGLAS = [
    // Casos puntuales (3/10/2026, pedido de Mato: "el de cobrar del rayo
    // no va ponele un billete y el de remito un camion") — van ANTES que
    // las reglas genéricas de "generar"/"registrar", que si no les
    // tocaría a estos dos el mismo ícono que a cualquier otro
    // "Generar..."/"Registrar...".
    [/^(generar remito|confirmar y generar remito)/, '🚚'],
    [/^(registrar cobro|cobrar)$/, '💵'],
    [/^cerrar sesi[oó]n$/, '🚪'],
    [/^salir$/, '🚪'],
    [/^(entrar|ingresar)$/, '🔑'],
    [/^guardar/, '💾'],
    [/^descartar/, '✕'],
    [/^rechazar/, '✕'],
    [/^cancelar/, '✕'],
    [/^cerrar$/, '✕'],
    [/^(borrar|eliminar|quitar)/, '🗑'],
    [/^(desactivar|dar de baja)/, '🚫'],
    [/^anular/, '🚫'],
    [/^editar/, '✎'],
    [/^(\+?\s*(agregar|nuevo|nueva|crear))/, '➕'],
    [/^importar/, '⬆'],
    [/^exportar/, '⬇'],
    [/^descargar/, '⬇'],
    [/^imprimir/, '🖨'],
    [/^compartir/, '📤'],
    [/^copiar/, '⧉'],
    [/^ver\b/, '👁'],
    [/^buscar/, '🔍'],
    [/^(volver|anterior|atr[aá]s)/, '←'],
    [/^(siguiente|continuar)/, '→'],
    [/^(confirmar|aplicar|procesar)/, '✓'],
    [/^registrar/, '✓'],
    [/^historial$/, '🕘'],
    [/^(sincronizar|resincronizar|actualizar)/, '↻'],
    [/^(transferir|transferencia)/, '🔁'],
    [/^calcular/, '🧮'],
    [/^configurar/, '⚙'],
    [/^generar/, '⚡']
  ];

  function normalizar(t) {
    return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  function iconoPara(textoNorm) {
    for (var i = 0; i < REGLAS.length; i++) {
      if (REGLAS[i][0].test(textoNorm)) return REGLAS[i][1];
    }
    return null;
  }

  // Botones que YA son un solo símbolo sin letras (cerrar modal "×"/"✕",
  // paginación "‹"/"›") — se les pone un title útil pero no se les toca
  // el ícono, ya están bien así.
  var SIMBOLOS_CONOCIDOS = { '×': 'Cerrar', '✕': 'Cerrar', '‹': 'Anterior', '›': 'Siguiente' };

  function procesar(btn) {
    if (!btn || btn.dataset.iconizado) return;
    var crudo = (btn.textContent || '').trim();
    if (!crudo) return;

    if (SIMBOLOS_CONOCIDOS[crudo]) {
      if (!btn.title) btn.title = SIMBOLOS_CONOCIDOS[crudo];
      btn.dataset.iconizado = '1';
      return;
    }

    // Si el botón ya trae su propio emoji al principio (ej: "🔄
    // Resincronizar", "📄 Ver PDF llave en mano"), se respeta ESE ícono
    // en vez de buscar uno nuevo — ya está hecho a mano.
    var m = crudo.match(/^([\u{1F300}-\u{1FAFF}\u{2190}-➿⬀-⯿])\s*(.*)$/u);
    var icono, resto;
    if (m) {
      icono = m[1];
      resto = m[2];
    } else {
      var norm = normalizar(crudo);
      icono = iconoPara(norm);
      resto = crudo;
      if (!icono) { btn.dataset.iconizado = '1'; return; } // no es un verbo de acción conocido: se deja como está
    }
    if (!btn.title) btn.title = resto || crudo;
    if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', resto || crudo);
    btn.textContent = icono;
    btn.dataset.iconizado = '1';
  }

  function procesarDesde(nodo) {
    if (!nodo || nodo.nodeType !== 1) return;
    if (nodo.tagName === 'BUTTON') procesar(nodo);
    if (nodo.querySelectorAll) {
      var lista = nodo.querySelectorAll('button');
      for (var i = 0; i < lista.length; i++) procesar(lista[i]);
    }
  }

  function iniciar() {
    procesarDesde(document.body);
    var obs = new MutationObserver(function (mutaciones) {
      for (var i = 0; i < mutaciones.length; i++) {
        var nodos = mutaciones[i].addedNodes;
        for (var j = 0; j < nodos.length; j++) procesarDesde(nodos[j]);
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }
})();
