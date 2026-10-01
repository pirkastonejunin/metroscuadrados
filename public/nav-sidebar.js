// ---------------------------------------------------------------------------
// Panel de navegación lateral, compartido por las pantallas de "oficina"
// (Visitas, Calendario, Obras, Costos, Usuarios). Antes, para pasar de una
// pantalla a otra había que volver a /inicio.html (una pantalla entera solo
// para elegir a dónde ir). Ahora cada pantalla de oficina incluye este
// script y, apenas valida la sesión (mismo fetch a /api/usuarios/me que ya
// hacía cada una), llama a PiedraSidebar.render(me, 'clave-de-la-pantalla')
// una sola vez. El panel se arma con los mismos permisos por módulo que ya
// usaba /inicio.html (tieneModulo / soloAdmin / requiereVendedor), así que
// cada usuario ve exactamente los accesos que le corresponden.
//
// Deliberadamente NO se incluye en Cotizador / Mis visitas / Mis obras: esas
// las usan vendedores y colocadores muchas veces desde el celular, y un
// panel fijo les comería pantalla sin aportar (decisión con Mato, 28/9/2026).
//
// No pisa el localStorage que ya usan las pantallas (obras_admin_token /
// obras_org_activo) — lee y escribe las mismas claves, así que convive con
// la lógica de sesión propia de cada página.
// ---------------------------------------------------------------------------
(function () {
  const TOKEN_KEY = 'obras_admin_token';
  const ORG_KEY = 'obras_org_activo';

  const ICONOS = {
    inicio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/></svg>',
    visitas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/><line x1="7.5" y1="13.5" x2="7.5" y2="13.5"/><line x1="12" y1="13.5" x2="12" y2="13.5"/><line x1="16.5" y1="13.5" x2="16.5" y2="13.5"/><line x1="7.5" y1="17" x2="7.5" y2="17"/><line x1="12" y1="17" x2="12" y2="17"/></svg>',
    calendario: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16" rx="2.5"/><line x1="3" y1="9.5" x2="21" y2="9.5"/><line x1="8" y1="2.5" x2="8" y2="6.5"/><line x1="16" y1="2.5" x2="16" y2="6.5"/><circle cx="12" cy="14.5" r="2.2"/></svg>',
    obras: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V9.5L12 4l8 5.5V21"/><path d="M9 21v-6h6v6"/><line x1="4" y1="21" x2="20" y2="21"/><line x1="9" y1="11" x2="9" y2="11.01"/><line x1="15" y1="11" x2="15" y2="11.01"/></svg>',
    costos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>',
    usuarios: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
    misVisitas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="19" height="13" rx="2.2"/><path d="M8 7V5.5A1.6 1.6 0 019.6 4h4.8A1.6 1.6 0 0116 5.5V7"/><line x1="2.5" y1="12.5" x2="21.5" y2="12.5"/><line x1="11" y1="12.5" x2="13" y2="12.5"/></svg>',
    cotizador: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2"/><line x1="8" y1="6.5" x2="16" y2="6.5"/><line x1="8.3" y1="11" x2="8.3" y2="11"/><line x1="12" y1="11" x2="12" y2="11"/><line x1="15.7" y1="11" x2="15.7" y2="11"/><line x1="8.3" y1="14.5" x2="8.3" y2="14.5"/><line x1="12" y1="14.5" x2="12" y2="14.5"/><line x1="15.7" y1="14.5" x2="15.7" y2="14.5"/><line x1="8.3" y1="18" x2="15.7" y2="18"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>',
    cerrar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    salir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    fabrica: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V10l6 4v-4l6 4v-4l6 4v7z"/><line x1="3" y1="21" x2="21" y2="21"/></svg>',
    productos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
    clientes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M22 21v-2a4 4 0 00-3-3.87"/><path d="M15 3.13a4 4 0 010 7.75"/></svg>',
    proveedores: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    stock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    ventas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>',
    compras: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>'
  };

  function slug(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-');
  }

  const GRUPOS = [
    { nombre: 'Producción', items: [
      { key: 'costos', href: '/admin-costos.html', modulo: 'costos', label: 'Costos de Producción', icon: ICONOS.costos },
      { key: 'fabrica', href: '/fabrica.html', moduloAlguno: ['fabrica', 'costos'], label: 'Registrar producción', icon: ICONOS.fabrica }
    ]},
    // Grupo CRM (1/10/2026, pedido de Mato): todo lo que es seguimiento de
    // visitas y obras en sí (no facturación) queda acá, separado de
    // Comercial. Calendario se vino también para acá porque es agenda de
    // visitas/obras, no algo de ventas — si Mato prefiere que quede en
    // Comercial, es mover una línea.
    { nombre: 'CRM', items: [
      { key: 'visitas', href: '/admin-visitas.html', modulo: 'visitas', label: 'Panel de Visitas', icon: ICONOS.visitas },
      { key: 'mis-visitas', href: '/vendedor.html', requiereVendedor: true, label: 'Mis visitas', icon: ICONOS.misVisitas },
      { key: 'calendario', href: '/calendario.html', modulo: 'visitas,obras', label: 'Calendario', icon: ICONOS.calendario },
      { key: 'obras', href: '/admin-obras.html', modulo: 'obras', label: 'Panel de Obras', icon: ICONOS.obras },
      { key: 'mis-obras', href: '/colocador.html', soloAdmin: true, label: 'Mis obras', icon: ICONOS.obras }
    ]},
    { nombre: 'Comercial', items: [
      { key: 'clientes', href: '/admin-clientes.html', modulo: 'clientes', label: 'Clientes', icon: ICONOS.clientes },
      { key: 'ventas', href: '/admin-ventas.html', modulo: 'ventas', label: 'Ventas', icon: ICONOS.ventas },
      { key: 'cotizador', href: '/cotizador.html', modulo: 'cotizador', label: 'Cotizador', icon: ICONOS.cotizador }
    ]},
    { nombre: 'Inventario', items: [
      { key: 'productos', href: '/admin-productos.html', modulo: 'productos', label: 'Productos', icon: ICONOS.productos },
      { key: 'stock', href: '/admin-stock.html', modulo: 'stock', label: 'Stock', icon: ICONOS.stock }
    ]},
    { nombre: 'Proveedores', items: [
      { key: 'proveedores', href: '/admin-proveedores.html', modulo: 'proveedores', label: 'Proveedores', icon: ICONOS.proveedores },
      { key: 'compras', href: '/admin-compras.html', modulo: 'compras', label: 'Compras', icon: ICONOS.compras }
    ]},
    { nombre: 'Configuración', items: [
      { key: 'usuarios', href: '/admin-usuarios.html', modulo: 'usuarios', label: 'Usuarios y roles', icon: ICONOS.usuarios }
    ]}
  ];

  function tieneModulo(rol, claveCombinada) {
    if (!rol) return false;
    if (rol.protegido) return true;
    const requeridos = claveCombinada.split(',');
    const modulos = rol.modulos || [];
    return requeridos.every(k => modulos.includes(k));
  }
  function itemVisible(item, me) {
    if (item.soloAdmin) return !!(me.rol && me.rol.protegido);
    if (item.requiereVendedor) return !!(me.usuario && me.usuario.vendedorId) || !!(me.rol && me.rol.protegido);
    if (item.moduloAlguno) return !!(me.rol && me.rol.protegido) || item.moduloAlguno.some(k => tieneModulo(me.rol, k));
    return tieneModulo(me.rol, item.modulo);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let estilosInyectados = false;
  function inyectarEstilos() {
    if (estilosInyectados) return;
    estilosInyectados = true;
    const css = `
      :root { --pn-ink: var(--text, var(--ink, #171a1f)); }
      body.pn-sidebar-on { margin-left: 236px; }
      .pn-sidebar {
        position: fixed; top: 0; left: 0; bottom: 0; width: 236px; z-index: 300;
        background: var(--card); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; overflow-y: auto;
        font-family: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: var(--pn-ink); transition: transform 0.2s ease;
      }
      .pn-sidebar-brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit; }
      .pn-sidebar-brand img { height: 22px; width: auto; display: block; flex-shrink: 0; }
      .pn-sidebar-brand span { font-size: 13px; font-weight: 700; color: var(--pn-ink); }
      .pn-sidebar-org { padding: 12px 16px; border-bottom: 1px solid var(--border); }
      .pn-sidebar-org label { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 5px; }
      .pn-sidebar-org select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; background: var(--bg); color: var(--pn-ink); font-family: inherit; }
      /* display:block explícito: algunas pantallas ya tienen un selector
         global "nav{display:flex}" para su propia barra de pestañas, y sin
         esto ese estilo se filtraba acá y ponía los grupos uno al lado del
         otro en vez de uno debajo del otro. */
      .pn-sidebar-nav { display: block; flex: none; padding: 10px 10px; }
      .pn-grupo { display: block; margin-bottom: 4px; }
      .pn-grupo-header {
        display: flex; align-items: center; justify-content: space-between; width: 100%;
        background: none; border: none; cursor: pointer; padding: 8px 10px; margin: 2px 0;
        font-family: inherit; color: var(--muted); text-align: left;
      }
      .pn-grupo-header span { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
      .pn-grupo-header svg { width: 13px; height: 13px; flex-shrink: 0; transition: transform 0.15s ease; }
      .pn-grupo.pn-colapsado .pn-grupo-header svg { transform: rotate(-90deg); }
      .pn-grupo-items { display: flex; flex-direction: column; gap: 2px; }
      .pn-grupo.pn-colapsado .pn-grupo-items { display: none; }
      .pn-item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 9px; text-decoration: none; color: var(--pn-ink); font-size: 13px; font-weight: 600; }
      .pn-item svg { width: 17px; height: 17px; flex-shrink: 0; }
      .pn-item:hover { background: var(--bg); }
      .pn-item.pn-activo { background: var(--accent-soft); color: var(--accent); }
      .pn-sidebar-footer { padding: 12px 16px 16px; border-top: 1px solid var(--border); font-size: 12px; }
      .pn-sidebar-footer .pn-nombre { font-weight: 700; color: var(--pn-ink); margin-bottom: 8px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pn-sidebar-footer button { display: flex; align-items: center; gap: 7px; width: 100%; background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; font-family: inherit; font-weight: 600; }
      .pn-sidebar-footer button:hover { border-color: var(--danger, #c53030); color: var(--danger, #c53030); }
      .pn-sidebar-footer button svg { width: 15px; height: 15px; }
      .pn-toggle {
        display: none; position: fixed; top: 12px; left: 12px; z-index: 301; width: 38px; height: 38px;
        border-radius: 10px; background: var(--card); border: 1px solid var(--border); color: var(--pn-ink);
        align-items: center; justify-content: center; cursor: pointer; box-shadow: var(--shadow, 0 2px 8px rgba(0,0,0,.12));
      }
      .pn-toggle svg { width: 19px; height: 19px; }
      .pn-overlay { display: none; position: fixed; inset: 0; background: rgba(17,20,24,.4); z-index: 299; }
      @media (max-width: 900px) {
        body.pn-sidebar-on { margin-left: 0; }
        .pn-sidebar { transform: translateX(-100%); }
        body.pn-sidebar-abierta .pn-sidebar { transform: translateX(0); }
        body.pn-sidebar-abierta .pn-overlay { display: block; }
        .pn-toggle { display: flex; }
      }
    `;
    const tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  function render(me, paginaActual, opts) {
    opts = opts || {};
    inyectarEstilos();
    if (document.querySelector('.pn-sidebar')) return; // ya renderizado (evita duplicar si algo llama render 2 veces)

    const orgs = me.organizaciones || [];
    const orgActiva = localStorage.getItem(ORG_KEY) || '';
    // admin-costos.html ya trae su propio selector de organización en el
    // header (con el aviso de "todas" y la lógica de deshabilitar creación),
    // así que ahí se pide no repetirlo acá para no mostrar dos selectores.
    const mostrarOrgSelect = !opts.ocultarOrg && (orgs.length > 1 || me.puedeVerTodas);

    // Cada grupo se abre/cierra en acordeón (uno debajo del otro, no en
    // columnas) y recuerda cómo lo dejó el usuario. Por defecto arranca
    // abierto solo el grupo de la pantalla en la que está parado, así no
    // hace falta abrir nada para ver dónde está — y el resto queda
    // plegado hasta que lo toca.
    const gruposHtml = GRUPOS.map(g => {
      const itemsVisibles = g.items.filter(it => itemVisible(it, me));
      if (!itemsVisibles.length) return '';
      const grupoSlug = slug(g.nombre);
      const storageKey = 'pn_sidebar_grupo_' + grupoSlug;
      const guardado = localStorage.getItem(storageKey);
      const contieneActual = itemsVisibles.some(it => it.key === paginaActual);
      const abierto = guardado !== null ? guardado === '1' : contieneActual;
      return `
        <div class="pn-grupo${abierto ? '' : ' pn-colapsado'}" data-grupo="${grupoSlug}">
          <button type="button" class="pn-grupo-header">
            <span>${escapeHtml(g.nombre)}</span>
            ${ICONOS.chevron}
          </button>
          <div class="pn-grupo-items">
            ${itemsVisibles.map(it => `
              <a class="pn-item${it.key === paginaActual ? ' pn-activo' : ''}" href="${it.href}">
                ${it.icon}<span>${escapeHtml(it.label)}</span>
              </a>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    const nombreUsuario = (me.usuario && me.usuario.nombre) ? me.usuario.nombre : '';

    const overlay = document.createElement('div');
    overlay.className = 'pn-overlay';
    overlay.onclick = cerrarSidebarMovil;

    const toggle = document.createElement('button');
    toggle.className = 'pn-toggle';
    toggle.setAttribute('aria-label', 'Abrir menú');
    toggle.innerHTML = ICONOS.menu;
    toggle.onclick = function () {
      const abierta = document.body.classList.toggle('pn-sidebar-abierta');
      toggle.innerHTML = abierta ? ICONOS.cerrar : ICONOS.menu;
    };

    const aside = document.createElement('aside');
    aside.className = 'pn-sidebar';
    aside.innerHTML = `
      <a class="pn-sidebar-brand" href="/inicio.html">
        <img src="/assets/logo-piedra-negra.png" onerror="this.style.display='none'" alt="">
        ${ICONOS.inicio}<span>Piedra Negra</span>
      </a>
      ${mostrarOrgSelect ? `
        <div class="pn-sidebar-org">
          <label>Organización</label>
          <select id="pnSidebarOrg">
            ${orgs.map(o => `<option value="${o._id}" ${o._id === orgActiva ? 'selected' : ''}>${escapeHtml(o.nombre)}</option>`).join('')}
            ${me.puedeVerTodas ? `<option value="todas" ${orgActiva === 'todas' ? 'selected' : ''}>Todas las organizaciones</option>` : ''}
          </select>
        </div>
      ` : ''}
      <div class="pn-sidebar-nav">${gruposHtml}</div>
      <div class="pn-sidebar-footer">
        ${nombreUsuario ? `<span class="pn-nombre">${escapeHtml(nombreUsuario)}</span>` : ''}
        <button id="pnSidebarLogout">${ICONOS.salir}Cerrar sesión</button>
      </div>
    `;

    document.body.insertBefore(aside, document.body.firstChild);
    document.body.insertBefore(overlay, document.body.firstChild);
    document.body.insertBefore(toggle, document.body.firstChild);
    document.body.classList.add('pn-sidebar-on');

    aside.querySelectorAll('.pn-grupo-header').forEach(btn => {
      btn.addEventListener('click', function () {
        const grupo = btn.closest('.pn-grupo');
        const abierto = grupo.classList.toggle('pn-colapsado') === false;
        localStorage.setItem('pn_sidebar_grupo_' + grupo.dataset.grupo, abierto ? '1' : '0');
      });
    });

    const orgSelect = document.getElementById('pnSidebarOrg');
    if (orgSelect) {
      orgSelect.addEventListener('change', function () {
        if (this.value) localStorage.setItem(ORG_KEY, this.value);
        else localStorage.removeItem(ORG_KEY);
        location.reload();
      });
    }
    document.getElementById('pnSidebarLogout').addEventListener('click', function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(ORG_KEY);
      location.href = '/inicio.html';
    });

    function cerrarSidebarMovil() {
      document.body.classList.remove('pn-sidebar-abierta');
      toggle.innerHTML = ICONOS.menu;
    }
  }

  window.PiedraSidebar = { render };
})();
