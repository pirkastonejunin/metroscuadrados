// Bandeja de pendientes (22/11/2026, pedido de Mato). Componente compartido por el cartel diario, la campanita y el Inicio:
//   - cada pendiente tiene nivel de urgencia (alta / media / baja), se puede agrupar por urgencia o por módulo
//   - click en el pendiente = ir al lugar donde se resuelve
//   - acciones: ✓ Hecho (recordatorios), ⏰ Posponer, ➕ Seguimiento (crea un recordatorio con enlace de vuelta), ✕ Descartar
//   - "Ver descartados y pospuestos" para restaurarlos
// Uso: PnBandeja.render(items, {agrupar}) devuelve el HTML; PnBandeja.enlazar(raiz, {getItems, hdrs, recargar}) atiende los clicks.
(function () {
  if (window.PnBandeja) return;
  const URG = {
    alta: { rotulo: 'Alta', color: '#c53030', fondo: 'rgba(197,48,48,.12)', orden: 0 },
    media: { rotulo: 'Media', color: '#d98324', fondo: 'rgba(217,131,36,.14)', orden: 1 },
    baja: { rotulo: 'Baja', color: '#2f855a', fondo: 'rgba(47,133,90,.13)', orden: 2 }
  };
  const GRUPOS = [['Recordatorios', ['recordatorio']], ['Comercial · CRM y visitas', ['crm', 'crm_sin_decidir', 'meta_token', 'visita']], ['Ventas', ['venta_sin_entregar', 'venta_sin_cobrar']], ['Compras', ['orden_compra', 'compra_por_pagar']], ['Tesorería', ['cheque_vencido', 'cheque_por_vencer', 'caja_sin_cerrar']], ['Stock', ['stock_bajo']], ['Obras', ['obra']]];
  const moduloDe = t => { const g = GRUPOS.find(x => x[1].indexOf(t) >= 0); return g ? g[0] : 'Otros'; };
  const CLAVE_AGRUPAR = 'pn_bandeja_agrupar';
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const urgDe = it => (URG[it.urgencia] ? it.urgencia : 'media');

  // Dónde se resuelve cada pendiente.
  function destino(it) {
    const tipo = it.tipo, id = it.id;
    if (tipo === 'recordatorio') return it.link || '';
    if (tipo === 'crm') return '/crm.html?abrir=crm-' + id;
    if (tipo === 'meta_token') return '/mesa.html';
    if (tipo === 'crm_sin_decidir') return '/mesa.html?abrir=' + id;
    if (tipo === 'visita') return '/admin-visitas.html?abrir=visita-' + id;
    if (tipo === 'obra') return '/admin-obras.html?abrir=obra-' + id;
    if (tipo === 'cheque_vencido' || tipo === 'cheque_por_vencer') return '/admin-tesoreria.html?tab=cheques';
    if (tipo === 'caja_sin_cerrar') { const p = String(id).split('|'); return '/admin-tesoreria.html?tab=cajadiaria&dia=' + encodeURIComponent(p[0]) + '&caja=' + encodeURIComponent(p[1] || ''); }
    if (tipo === 'orden_compra') return '/admin-compras.html?abrirOrden=' + encodeURIComponent(id);
    if (tipo === 'compra_por_pagar') return '/admin-compras.html?abrir=' + encodeURIComponent(id);
    if (tipo === 'venta_sin_entregar') return '/admin-ventas.html?abrir=' + encodeURIComponent(id) + '&entregar=1';
    if (tipo === 'venta_sin_cobrar') return '/admin-ventas.html?abrir=' + encodeURIComponent(id);
    if (tipo === 'stock_bajo') return '/admin-stock.html';
    return '';
  }

  function fmtFecha(it) {
    if (!it.fecha) return '';
    try {
      const d = new Date(it.fecha);
      const f = it.tipo === 'recordatorio' ? d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('es-AR');
      return esc(it.etiquetaFecha || 'Venció el') + ' ' + esc(f);
    } catch (e) { return ''; }
  }
  const btn = (act, i, txt, title) => '<button type="button" data-pb="' + act + '" data-i="' + i + '" title="' + esc(title) + '" style="border:1px solid var(--border,#ccc);background:transparent;border-radius:6px;font-size:11.5px;padding:2px 7px;cursor:pointer;color:inherit;font-family:inherit">' + txt + '</button>';

  function fila(it, i, opts) {
    const u = URG[urgDe(it)], url = destino(it);
    const ocultos = opts && opts.ocultos;
    let acciones;
    if (ocultos) {
      acciones = btn('restaurar', i, '↩ Volver a la bandeja', 'Restaurar este pendiente') + (it.oculto === 'pospuesta' && it.ocultoHasta ? ' <span style="font-size:11px;opacity:.65">Vuelve el ' + esc(new Date(it.ocultoHasta).toLocaleDateString('es-AR')) + '</span>' : ' <span style="font-size:11px;opacity:.65">Descartado</span>');
    } else {
      acciones = (it.tipo === 'recordatorio' ? btn('hecho', i, '✓ Hecho', 'Marcar el recordatorio como hecho') : btn('descartar', i, '✕ Descartar', 'Sacarlo de la bandeja')) + ' ' +
        '<span style="position:relative;display:inline-block">' + btn('posponer', i, '⏰ Posponer', 'Que vuelva a aparecer más adelante') + '</span> ' +
        btn('seguimiento', i, '➕ Seguimiento', 'Crear un recordatorio para hacer el seguimiento');
    }
    return '<div class="pn-bj-fila" data-i="' + i + '" style="padding:10px 14px;border-bottom:1px solid var(--border,#eee);border-left:4px solid ' + (ocultos ? 'transparent' : u.color) + ';' + (url && !ocultos ? 'cursor:pointer' : '') + '">' +
      '<div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1;min-width:0"><b>' + esc(it.titulo) + '</b>' +
      '<div style="font-size:12.5px;opacity:.75">' + esc(it.subtitulo || '') + '</div>' +
      '<div style="font-size:11.5px;opacity:.6">' + fmtFecha(it) + (opts && opts.mostrarModulo ? ' · ' + esc(moduloDe(it.tipo)) : '') + '</div></div>' +
      (ocultos ? '' : '<span title="Urgencia ' + u.rotulo.toLowerCase() + '" style="flex:none;font-size:10.5px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:' + u.color + ';background:' + u.fondo + ';border-radius:999px;padding:2px 8px">' + u.rotulo + '</span>') +
      '</div><div class="pn-bj-acc" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">' + acciones + '</div></div>';
  }
  const cabecera = (txt, n, color) => '<div style="padding:6px 14px;font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;background:rgba(128,128,128,.12);position:sticky;top:0;z-index:1;' + (color ? 'color:' + color : 'opacity:.7') + '">' + esc(txt) + ' · ' + n + '</div>';

  // HTML de toda la lista. items = los que se muestran (orden = el que viene del servidor); opts: {agrupar:'urgencia'|'modulo', ocultos}
  function render(items, opts) {
    opts = opts || {};
    if (!items.length) return '<div style="padding:22px 14px;text-align:center;opacity:.65;font-size:13px">' + (opts.ocultos ? 'No hay pendientes descartados ni pospuestos.' : 'Bandeja vacía 🎉') + '</div>';
    const idx = items.map((it, i) => ({ it, i }));
    const modo = opts.ocultos ? 'plano' : (opts.agrupar || agruparPreferido());
    let out = '';
    if (modo === 'urgencia') {
      ['alta', 'media', 'baja'].forEach(k => { const l = idx.filter(x => urgDe(x.it) === k); if (!l.length) return; out += cabecera('Urgencia ' + URG[k].rotulo.toLowerCase(), l.length, URG[k].color) + l.map(x => fila(x.it, x.i, { mostrarModulo: true })).join(''); });
    } else if (modo === 'modulo') {
      const orden = GRUPOS.map(g => g[0]).concat(['Otros']);
      orden.forEach(nom => { const l = idx.filter(x => moduloDe(x.it.tipo) === nom); if (!l.length) return; out += cabecera(nom, l.length) + l.map(x => fila(x.it, x.i, {})).join(''); });
    } else out = idx.map(x => fila(x.it, x.i, { ocultos: opts.ocultos, mostrarModulo: !opts.ocultos })).join('');
    return out;
  }
  function agruparPreferido() { try { return localStorage.getItem(CLAVE_AGRUPAR) === 'modulo' ? 'modulo' : 'urgencia'; } catch (e) { return 'urgencia'; } }
  function guardarAgrupar(v) { try { localStorage.setItem(CLAVE_AGRUPAR, v); } catch (e) {} }

  // Barra superior de la bandeja: cuántas de cada urgencia, selector de agrupación y acceso a descartados.
  function barra(items, cantOcultos, opts) {
    opts = opts || {};
    const c = { alta: 0, media: 0, baja: 0 }; items.forEach(it => { c[urgDe(it)]++; });
    const modo = opts.ocultos ? 'plano' : agruparPreferido();
    const chip = k => '<span style="font-size:11px;font-weight:800;color:' + URG[k].color + ';background:' + URG[k].fondo + ';border-radius:999px;padding:2px 8px">' + c[k] + ' ' + URG[k].rotulo.toLowerCase() + '</span>';
    const sel = (v, t) => '<button type="button" data-pb="agrupar" data-v="' + v + '" style="border:1px solid var(--border,#ccc);background:' + (modo === v ? 'rgba(128,128,128,.22)' : 'transparent') + ';border-radius:6px;font-size:11.5px;padding:2px 8px;cursor:pointer;color:inherit;font-family:inherit">' + t + '</button>';
    return '<div style="padding:8px 14px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--border,#eee)">' +
      (opts.ocultos ? '<button type="button" data-pb="volver" style="border:1px solid var(--border,#ccc);background:transparent;border-radius:6px;font-size:12px;padding:3px 9px;cursor:pointer;color:inherit;font-family:inherit">← Volver a la bandeja</button>' :
        chip('alta') + chip('media') + chip('baja') + '<span style="flex:1"></span>' + sel('urgencia', 'Por urgencia') + sel('modulo', 'Por módulo') +
        (cantOcultos ? '<button type="button" data-pb="ver-ocultos" style="border:0;background:transparent;text-decoration:underline;font-size:11.5px;cursor:pointer;color:inherit;opacity:.75;font-family:inherit">Descartados / pospuestos (' + cantOcultos + ')</button>' : '')) + '</div>';
  }

  async function llamar(hdrs, ruta, body) {
    const r = await fetch('/api/notificaciones' + ruta, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdrs), body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'No se pudo completar la acción');
    return d;
  }

  function menuPosponer(btnEl, it, ctx) {
    const viejo = document.getElementById('pn-bj-menu'); if (viejo) viejo.remove();
    const m = document.createElement('div'); m.id = 'pn-bj-menu';
    const r = btnEl.getBoundingClientRect();
    m.style.cssText = 'position:fixed;z-index:100002;background:var(--card,#fff);color:var(--text,#222);border:1px solid var(--border,#ccc);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25);padding:4px;min-width:150px;left:' + Math.max(8, Math.min(r.left, window.innerWidth - 170)) + 'px;top:' + Math.min(r.bottom + 4, window.innerHeight - 150) + 'px;font-size:13px';
    const op = [['Hasta mañana', { manana: true }], ['3 días', { dias: 3 }], ['1 semana', { dias: 7 }], ['1 mes', { dias: 30 }]];
    m.innerHTML = op.map((o, k) => '<div data-k="' + k + '" style="padding:7px 12px;cursor:pointer;border-radius:5px">' + o[0] + '</div>').join('');
    document.body.appendChild(m);
    const cerrar = () => { m.remove(); document.removeEventListener('click', fuera, true); };
    const fuera = e => { if (!m.contains(e.target)) { cerrar(); } };
    setTimeout(() => document.addEventListener('click', fuera, true), 0);
    m.addEventListener('mouseover', e => { const d = e.target.closest('[data-k]'); m.querySelectorAll('[data-k]').forEach(x => x.style.background = x === d ? 'rgba(128,128,128,.18)' : ''); });
    m.addEventListener('click', async e => {
      const d = e.target.closest('[data-k]'); if (!d) return;
      cerrar();
      try { await llamar(ctx.hdrs, '/ocultar', Object.assign({ tipo: it.tipo, id: it.id }, op[Number(d.dataset.k)][1])); ctx.recargar(); } catch (er) { alert(er.message); }
    });
  }

  // Formulario de seguimiento: crea un recordatorio (propio o asignado a otra persona) con enlace al lugar donde se resuelve.
  async function abrirSeguimiento(it, ctx) {
    const pad = n => String(n).padStart(2, '0');
    const aLocal = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const en = (dias, h) => { const d = new Date(); d.setDate(d.getDate() + dias); d.setHours(h, 0, 0, 0); return aLocal(d); };
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100001;display:flex;align-items:center;justify-content:center;padding:12px';
    const inp = 'width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--border,#ccc);border-radius:7px;background:transparent;color:inherit;font:inherit';
    ov.innerHTML = '<div style="background:var(--card,#fff);color:var(--text,#222);border-radius:14px;max-width:440px;width:100%;box-shadow:0 10px 40px rgba(0,0,0,.3);padding:16px 18px;font-family:inherit">' +
      '<div style="font-weight:800;font-size:15px;margin-bottom:10px">➕ Seguimiento</div>' +
      '<label style="font-size:12px;opacity:.7">Qué hay que hacer</label><input id="pn-sg-titulo" style="' + inp + '" value="' + esc('Seguimiento: ' + it.titulo) + '">' +
      '<label style="font-size:12px;opacity:.7;display:block;margin-top:8px">Cuándo</label>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px"><button type="button" data-q="' + en(1, 9) + '" style="border:1px solid var(--border,#ccc);background:transparent;border-radius:6px;padding:3px 9px;cursor:pointer;color:inherit;font:inherit;font-size:12px">Mañana 9:00</button><button type="button" data-q="' + en(3, 9) + '" style="border:1px solid var(--border,#ccc);background:transparent;border-radius:6px;padding:3px 9px;cursor:pointer;color:inherit;font:inherit;font-size:12px">En 3 días</button><button type="button" data-q="' + en(7, 9) + '" style="border:1px solid var(--border,#ccc);background:transparent;border-radius:6px;padding:3px 9px;cursor:pointer;color:inherit;font:inherit;font-size:12px">En 1 semana</button></div>' +
      '<input id="pn-sg-fecha" type="datetime-local" style="' + inp + '" value="' + en(1, 9) + '">' +
      '<label style="font-size:12px;opacity:.7;display:block;margin-top:8px">Para</label><select id="pn-sg-para" style="' + inp + '"><option value="">Yo</option></select>' +
      '<label style="font-size:12px;opacity:.7;display:block;margin-top:8px">Nota (opcional)</label><input id="pn-sg-nota" style="' + inp + '" value="' + esc(it.subtitulo || '') + '">' +
      '<label style="display:flex;gap:6px;align-items:center;margin-top:10px;font-size:13px"><input id="pn-sg-sacar" type="checkbox" checked style="width:auto"> Sacar este pendiente de la bandeja</label>' +
      '<div id="pn-sg-err" style="color:#c53030;font-size:12px;margin-top:6px"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button type="button" id="pn-sg-x" style="border:1px solid var(--border,#ccc);background:transparent;border-radius:8px;padding:7px 14px;cursor:pointer;color:inherit;font:inherit">Cancelar</button><button type="button" id="pn-sg-ok" style="border:0;background:#e8603c;color:#fff;border-radius:8px;padding:7px 16px;font-weight:700;cursor:pointer;font:inherit">Crear seguimiento</button></div></div>';
    document.body.appendChild(ov);
    const $ = id => ov.querySelector('#' + id);
    ov.addEventListener('click', e => { if (e.target === ov || e.target.id === 'pn-sg-x') { ov.remove(); return; } const q = e.target.closest('[data-q]'); if (q) $('pn-sg-fecha').value = q.dataset.q; });
    fetch('/api/notificaciones/usuarios-asignables', { headers: ctx.hdrs }).then(r => r.ok ? r.json() : []).then(us => us.filter(u => !u.yo).forEach(u => { const o = document.createElement('option'); o.value = u._id; o.textContent = u.nombre; $('pn-sg-para').appendChild(o); })).catch(() => {});
    $('pn-sg-ok').addEventListener('click', async () => {
      const titulo = $('pn-sg-titulo').value.trim(), fechaHora = $('pn-sg-fecha').value;
      if (!titulo) { $('pn-sg-err').textContent = 'Poné qué hay que hacer.'; return; }
      if (!fechaHora) { $('pn-sg-err').textContent = 'Elegí fecha y hora.'; return; }
      try {
        await llamar(ctx.hdrs, '/recordatorios', { titulo, fechaHora, nota: $('pn-sg-nota').value.trim(), asignadoAId: $('pn-sg-para').value || undefined, link: destino(it) || undefined });
        if ($('pn-sg-sacar').checked && it.tipo !== 'recordatorio') await llamar(ctx.hdrs, '/ocultar', { tipo: it.tipo, id: it.id });
        ov.remove(); ctx.recargar();
      } catch (e) { $('pn-sg-err').textContent = e.message; }
    });
    $('pn-sg-titulo').focus();
  }

  // Atiende los clicks dentro de `raiz`. ctx = { getItems(): items mostrados, hdrs, recargar(), alIr?(): se llama antes de navegar, verOcultos(): activa la vista de descartados, volver(), repintar() }
  function enlazar(raiz, ctx) {
    raiz.addEventListener('click', async function (e) {
      const b = e.target.closest('[data-pb]');
      if (b) {
        e.stopPropagation();
        const act = b.dataset.pb, items = ctx.getItems(), it = items[Number(b.dataset.i)];
        try {
          if (act === 'agrupar') { guardarAgrupar(b.dataset.v); ctx.repintar && ctx.repintar(); return; }
          if (act === 'ver-ocultos') { ctx.verOcultos && ctx.verOcultos(); return; }
          if (act === 'volver') { ctx.volver && ctx.volver(); return; }
          if (!it) return;
          if (act === 'descartar') { await llamar(ctx.hdrs, '/ocultar', { tipo: it.tipo, id: it.id }); ctx.recargar(); }
          else if (act === 'hecho') { await fetch('/api/notificaciones/recordatorios/' + encodeURIComponent(it.id) + '/hecho', { method: 'POST', headers: ctx.hdrs }); ctx.recargar(); }
          else if (act === 'posponer') menuPosponer(b, it, ctx);
          else if (act === 'seguimiento') abrirSeguimiento(it, ctx);
          else if (act === 'restaurar') { await llamar(ctx.hdrs, '/restaurar', { tipo: it.tipo, id: it.id }); ctx.recargar(); }
        } catch (er) { alert(er.message); }
        return;
      }
      const f = e.target.closest('.pn-bj-fila'); if (!f) return;
      const it = ctx.getItems()[Number(f.dataset.i)]; if (!it || it.oculto) return;
      const url = destino(it); if (!url) return;
      if (ctx.alIr) ctx.alIr();
      location.href = url;
    });
  }

  window.PnBandeja = { render, barra, enlazar, destino, URG, moduloDe, agruparPreferido };
})();
