// Enlaces del mail "Resumen del día" (26/11/2026): /pantalla.html?org=<sucursal>&desde=AAAA-MM-DD&hasta=AAAA-MM-DD&estado=...&origen=...&forma=...&tab=...
// Se carga ANTES del script de cada pantalla: deja elegida la sucursal (misma clave que usa todo el sistema) y guarda los filtros para que la
// pantalla los aplique al iniciar (aplicarEnlaceRes). Sin parámetros no hace nada.
(function () {
  var p = new URLSearchParams(location.search);
  var claves = ['org', 'desde', 'hasta', 'estado', 'origen', 'forma', 'tab'];
  var hay = claves.some(function (k) { return p.has(k); });
  window.ENLACE_RES = { activo: hay };
  claves.forEach(function (k) { window.ENLACE_RES[k] = p.get(k); });
  if (p.get('org')) { try { localStorage.setItem('obras_org_activo', p.get('org')); } catch (e) {} }
  if (hay) {
    claves.forEach(function (k) { p.delete(k); });
    try { history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p.toString() : '')); } catch (e) {}
  }
  // mapa: { parametro: 'idDelCampo' } — completa los campos que vengan en el enlace; devuelve true si completó alguno.
  window.aplicarEnlaceRes = function (mapa) {
    var algo = false;
    Object.keys(mapa).forEach(function (k) {
      var v = window.ENLACE_RES[k]; var el = document.getElementById(mapa[k]);
      if (v && el) { el.value = v; algo = true; }
    });
    return algo;
  };
})();
