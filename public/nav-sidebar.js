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
  // "Sucursal con la que se opera" (donde se guardan las altas y cambios), separada de la "vista" (ORG_KEY: una sucursal o todas).
  const OPERAR_KEY = 'obras_org_operar';
  // Cuando la vista es "todas las sucursales", todos los pedidos al servidor llevan además la sucursal de operación,
  // así lo que se guarda queda en UNA sucursal (el servidor lo exige). Las pantallas no necesitan cambiar nada.
  (function () {
    if (window.__pnFetchOrg) return; window.__pnFetchOrg = true;
    const f0 = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const operar = localStorage.getItem(OPERAR_KEY);
        if (operar && url.indexOf('/api/') !== -1 && init && init.headers) {
          const h = init.headers;
          const esTodas = h instanceof Headers ? h.get('x-org-id') === 'todas' : h['x-org-id'] === 'todas';
          if (esTodas) {
            if (h instanceof Headers) h.set('x-org-operar', operar);
            else init = Object.assign({}, init, { headers: Object.assign({}, h, { 'x-org-operar': operar }) });
          }
        }
      } catch (e) { /* nunca romper un pedido por esto */ }
      return f0.call(this, input, init);
    };
  })();
  let OCULTAR_ORG = false;

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
    compras: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>',
    bases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
    fiscal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><polyline points="14 3 14 8 19 8"/><polyline points="9 14 11 16 15 12"/></svg>',
    tesoreria: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="21" x2="22" y2="21"/><path d="M4 21V10l8-6 8 6v11"/><line x1="9" y1="21" x2="9" y2="13"/><line x1="15" y1="21" x2="15" y2="13"/></svg>',
    // Remitos (3/10/2026, pedido de Mato: "tenemos que tener en el menu
    // comercial un submenu para ver los remitos emitidos") — mismo ícono
    // de camión que ya se usa para el botón de generar remito.
    remitos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    // Presupuestos (3/10/2026, pedido de Mato): clipboard con un check,
    // distinto del ícono de ventas (carrito) para que se note que es otra
    // cosa (no compromete stock ni cuenta corriente).
    presupuestos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2h6a1 1 0 011 1v2H8V3a1 1 0 011-1z"/><path d="M8 4H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2"/><path d="M9 14l2 2 4-4"/></svg>',
    // Gastos (3/10/2026, pedido de Mato): billete con una flecha de
    // salida, distinto del ícono de Compras (caja) — no hay mercadería
    // de por medio, es una erogación.
    gastos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 6v.01M18 18v-.01"/></svg>'
  };

  // Íconos extra (15/10/2026) para que cada pantalla del menú tenga el suyo, y un color por pantalla (pedido de Mato: "algún icono con
  // colores para que sea más fácil de identificar").
  const SVG_ATTR = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  Object.assign(ICONOS, {
    tarjeta: `<svg ${SVG_ATTR}><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>`,
    libro: `<svg ${SVG_ATTR}><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`,
    grafico: `<svg ${SVG_ATTR}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
    tendencia: `<svg ${SVG_ATTR}><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
    banco: `<svg ${SVG_ATTR}><path d="M3 10l9-6 9 6"/><line x1="5" y1="10" x2="5" y2="18"/><line x1="10" y1="10" x2="10" y2="18"/><line x1="14" y1="10" x2="14" y2="18"/><line x1="19" y1="10" x2="19" y2="18"/><line x1="3" y1="21" x2="21" y2="21"/></svg>`,
    recibo: `<svg ${SVG_ATTR}><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/></svg>`,
    alerta: `<svg ${SVG_ATTR}><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    mail: `<svg ${SVG_ATTR}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/></svg>`,
    etiqueta: `<svg ${SVG_ATTR}><path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`
  });
  // Ícono propio y color por pantalla.
  const ESTILO_ITEM = {
    costos: ['#d97706'], fabrica: ['#ea580c'],
    visitas: ['#7c3aed'], 'mis-visitas': ['#8b5cf6'], calendario: ['#0ea5e9'], obras: ['#b45309'], 'mis-obras': ['#a16207'],
    clientes: ['#2563eb'], ventas: ['#16a34a'], cobranza: ['#0d9488', 'recibo'], cotizador: ['#9333ea'], remitos: ['#0891b2'], presupuestos: ['#c026d3'],
    productos: ['#ea580c'], stock: ['#65a30d'], tiendanube: ['#0284c7', 'etiqueta'],
    proveedores: ['#4f46e5'], compras: ['#db2777'], gastos: ['#dc2626'],
    sueldos: ['#0f766e'],
    tesoreria: ['#059669', 'banco'], mercadopago: ['#0ea5e9', 'tarjeta'], financiera: ['#7c3aed', 'tendencia'],
    'fiscal-config': ['#475569'], 'fiscal-ventas': ['#16a34a', 'libro'], 'fiscal-compras': ['#db2777', 'libro'], 'fiscal-retenciones': ['#d97706', 'libro'],
    'informe-ventas': ['#16a34a', 'grafico'], 'informe-resultados': ['#2563eb', 'tendencia'], 'informe-deudores': ['#dc2626', 'alerta'],
    'informe-proveedores': ['#4f46e5', 'alerta'], facturacion: ['#0891b2', 'grafico']
  };
  function iconoItem(it) {
    const est = ESTILO_ITEM[it.key];
    const svg = (est && est[1] && ICONOS[est[1]]) || it.icon;
    const color = est ? est[0] : 'var(--accent, #555)';
    return `<span class="pn-ico" style="--c:${color}">${svg}</span>`;
  }

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
      // Cobranza (2/10/2026, pedido de Mato): acceso directo para hacer un
      // recibo a la cuenta de un cliente sin pasar por Tesorería — la
      // misma ruta POST /api/tesoreria/cobros-cuenta-cliente de siempre,
      // que sigue pidiendo el módulo 'tesoreria' (es la que mueve la
      // plata de verdad), pero expuesta acá porque conceptualmente es
      // tarea de Comercial, no de administración de cajas/bancos.
      { key: 'cobranza', href: '/admin-cobranza.html', modulo: 'tesoreria', label: 'Cobranza', icon: ICONOS.tesoreria },
      { key: 'cotizador', href: '/cotizador.html', modulo: 'cotizador', label: 'Cotizador', icon: ICONOS.cotizador },
      // Remitos emitidos (3/10/2026, pedido de Mato): listado de todos los
      // remitos generados, para verlos/reimprimirlos sin tener que entrar
      // venta por venta. Reusa el módulo 'ventas' (no es un módulo nuevo).
      { key: 'remitos', href: '/admin-remitos.html', modulo: 'ventas', label: 'Remitos', icon: ICONOS.remitos },
      // Presupuestos (3/10/2026, pedido de Mato): "lo mismo que venta pero
      // que no comprometa stock ni cuenta", con estados y seguimiento, y
      // la posibilidad de importar cotizaciones ya armadas en el
      // cotizador. Reusa el módulo 'ventas' (no es un módulo nuevo).
      { key: 'presupuestos', href: '/admin-presupuestos.html', modulo: 'ventas', label: 'Presupuestos', icon: ICONOS.presupuestos }
    ]},
    { nombre: 'Inventario', items: [
      { key: 'productos', href: '/admin-productos.html', modulo: 'productos', label: 'Productos', icon: ICONOS.productos },
      { key: 'stock', href: '/admin-stock.html', modulo: 'stock', label: 'Stock', icon: ICONOS.stock },
      // Vínculo de productos con Tiendanube (13/10/2026): vínculos actuales, comparación de precios y emparejamiento de pendientes.
      { key: 'tiendanube', href: '/admin-tiendanube.html', modulo: 'productos', label: 'Tiendanube', icon: ICONOS.bases || ICONOS.productos }
    ]},
    { nombre: 'Proveedores', items: [
      { key: 'proveedores', href: '/admin-proveedores.html', modulo: 'proveedores', label: 'Proveedores', icon: ICONOS.proveedores },
      { key: 'compras', href: '/admin-compras.html', modulo: 'compras', label: 'Compras', icon: ICONOS.compras },
      { key: 'gastos', href: '/admin-gastos.html', modulo: 'gastos', label: 'Gastos', icon: ICONOS.gastos }
    ]},
    // Tesorería (2/10/2026): cajas, bancos y cheques — el día a día. El
    // alta/habilitación de cajas y bancos vive en Configuración, no acá.
    { nombre: 'Personal', items: [
      { key: 'sueldos', href: '/admin-sueldos.html', modulo: 'sueldos', label: 'Sueldos', icon: ICONOS.usuarios }
    ]},
    { nombre: 'Tesorería', items: [
      { key: 'tesoreria', href: '/admin-tesoreria.html', modulo: 'tesoreria', label: 'Tesorería', icon: ICONOS.tesoreria },
      { key: 'mercadopago', href: '/admin-mercadopago.html', modulo: 'tesoreria', label: 'Mercado Pago', icon: ICONOS.tesoreria },
      { key: 'financiera', href: '/admin-financiera.html', modulo: 'tesoreria', label: 'Financiera', icon: ICONOS.tesoreria }
    ]},
    // Fiscal (5/10/2026): conexión con ARCA, facturación electrónica y libros.
    { nombre: 'Fiscal', items: [
      { key: 'fiscal-config', href: '/admin-fiscal.html', modulo: 'fiscal', label: 'Puntos de venta y ARCA', icon: ICONOS.fiscal },
      { key: 'fiscal-ventas', href: '/admin-fiscal-libros.html?vista=ventas', modulo: 'fiscal', label: 'Libro IVA Ventas', icon: ICONOS.fiscal },
      { key: 'fiscal-compras', href: '/admin-fiscal-libros.html?vista=compras', modulo: 'fiscal', label: 'Libro IVA Compras', icon: ICONOS.fiscal },
      { key: 'fiscal-retenciones', href: '/admin-fiscal-libros.html?vista=retenciones', modulo: 'fiscal', label: 'Percepciones y retenciones', icon: ICONOS.fiscal }
    ]},
    // Reportes (7/10/2026, pedido de Mato): siempre al final del menú, separados
    // de la parte operativa. Los reportes nuevos van acá adentro.
    { nombre: 'Reportes', items: [
      { key: 'informe-ventas', href: '/admin-informe-ventas.html', modulo: 'informe_ventas', label: 'Informe de ventas', icon: ICONOS.ventas || ICONOS.fiscal },
      { key: 'informe-resultados', href: '/admin-informe-resultados.html', modulo: 'informe_resultados', label: 'Estado de resultados', icon: ICONOS.fiscal },
      { key: 'informe-deudores', href: '/admin-informe-deudores.html', modulo: 'informe_deudores', label: 'Deudores (clientes)', icon: ICONOS.clientes },
      { key: 'informe-proveedores', href: '/admin-informe-proveedores.html', modulo: 'informe_proveedores', label: 'Deuda con proveedores', icon: ICONOS.proveedores },
      { key: 'facturacion', href: '/admin-facturacion.html', modulo: 'tablero_facturacion', label: 'Facturación por sucursal', icon: ICONOS.fiscal }
    ]}
  ];
  // Orden del menú (7/10/2026, pedido de Mato): primero lo comercial, después
  // lo que se compra y se guarda, la plata, producción, personal, fiscal y reportes.
  const ORDEN_GRUPOS = ['CRM', 'Comercial', 'Proveedores', 'Inventario', 'Tesorería', 'Producción', 'Personal', 'Fiscal', 'Reportes'];
  GRUPOS.sort((a, b) => { const i = ORDEN_GRUPOS.indexOf(a.nombre), j = ORDEN_GRUPOS.indexOf(b.nombre); return (i < 0 ? 99 : i) - (j < 0 ? 99 : j); });

  // Configuración (4/10/2026, pedido de Mato): ya no es un grupo del menú
  // lateral — vive en el desplegable del usuario, arriba a la derecha, junto
  // con "Cerrar sesión".
  const ITEMS_CONFIGURACION = [
    { key: 'usuarios', href: '/admin-usuarios.html', modulo: 'usuarios', label: 'Configuración (usuarios, roles, notificaciones)', icon: ICONOS.usuarios },
    { key: 'bases', href: '/admin-config-bases.html', modulo: 'productos', label: 'Bases y catálogos', icon: ICONOS.bases },
    { key: 'integraciones', href: '/admin-integraciones.html', modulo: 'usuarios', label: 'Integraciones', icon: ICONOS.usuarios },
    { key: 'correo', href: '/admin-correo.html', modulo: 'usuarios', label: 'Correo a clientes', icon: ICONOS.usuarios }
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
      .pn-sidebar-brand { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 16px 16px 12px; border-bottom: 1px solid var(--border); text-decoration: none; color: inherit; }
      .pn-sidebar-brand img { height: 22px; width: auto; display: block; flex-shrink: 0; }
      .pn-sidebar-brand select { flex: 1 1 100%; min-width: 0; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; font-weight: 600; background: var(--bg); color: var(--pn-ink); font-family: inherit; }
      .pn-sidebar-org { padding: 12px 16px; border-bottom: 1px solid var(--border); }
      .pn-sidebar-org label { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 5px; }
      .pn-sidebar-org select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; font-size: 12.5px; background: var(--bg); color: var(--pn-ink); font-family: inherit; }
      /* display:block explícito: algunas pantallas ya tienen un selector
         global "nav{display:flex}" para su propia barra de pestañas, y sin
         esto ese estilo se filtraba acá y ponía los grupos uno al lado del
         otro en vez de uno debajo del otro. */
      .pn-sidebar-nav { display: block; flex: none; padding: 10px 10px; }
      .pn-grupo { display: block; margin-bottom: 8px; }
      .pn-grupo-header {
        display: flex; align-items: center; justify-content: space-between; width: 100%;
        background: none; border: none; cursor: pointer; padding: 8px 10px; margin: 2px 0;
        font-family: inherit; color: var(--pn-ink); text-align: left;
      }
      /* Títulos de grupo más marcados (1/10/2026, pedido de Mato: que se
         distingan mejor de los módulos de abajo) — antes eran gris clarito
         y chiquito; ahora van en negro/blanco (según tema), más grandes y
         con más separación arriba, para que se note que son un encabezado
         y no otro ítem más. */
      .pn-grupo-header span { font-size: 11.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; }
      .pn-grupo-header svg { width: 13px; height: 13px; flex-shrink: 0; transition: transform 0.15s ease; }
      .pn-grupo.pn-colapsado .pn-grupo-header svg { transform: rotate(-90deg); }
      .pn-grupo-items { display: flex; flex-direction: column; gap: 2px; }
      .pn-grupo.pn-colapsado .pn-grupo-items { display: none; }
      .pn-item { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: 9px; text-decoration: none; color: var(--pn-ink); font-size: 13px; font-weight: 600; }
      .pn-item svg { width: 17px; height: 17px; flex-shrink: 0; }
      .pn-ico { width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); }
      .pn-ico svg { width: 16px; height: 16px; }
      .pn-item.pn-activo .pn-ico { background: var(--c); color: #fff; }
      .pn-item:hover { background: var(--bg); }
      .pn-item.pn-activo { background: var(--accent-soft); color: var(--accent); }
      .pn-sidebar-footer { padding: 12px 16px 16px; border-top: 1px solid var(--border); font-size: 12px; }
      .pn-sidebar-footer .pn-nombre { font-weight: 700; color: var(--pn-ink); margin-bottom: 8px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pn-sidebar-footer button { display: flex; align-items: center; gap: 7px; width: 100%; background: transparent; border: 1px solid var(--border); color: var(--muted); padding: 7px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; font-family: inherit; font-weight: 600; }
      .pn-sidebar-footer button:hover { border-color: var(--danger, #c53030); color: var(--danger, #c53030); }
      .pn-sidebar-footer button svg { width: 15px; height: 15px; }
      .pn-extras { display: inline-flex; align-items: center; gap: 8px; margin-right: 10px; vertical-align: middle; }
      .pn-dolar { display: inline-flex; flex-direction: column; line-height: 1.1; padding: 4px 10px; border: 1px solid var(--border, #ccc); border-radius: 8px; font-size: 13px; font-weight: 800; color: var(--pn-ink, inherit); background: var(--card, #fff); white-space: nowrap; }
      .pn-dolar small { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted, #777); }
      .pn-bell { position: relative; }
      .pn-bell-btn { position: relative; background: transparent; border: 1px solid var(--border, #ccc); border-radius: 8px; width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--muted, #777); padding: 0; }
      .pn-bell-btn:hover { border-color: var(--accent, #555); color: var(--accent, #555); }
      .pn-bell-btn svg { width: 18px; height: 18px; }
      .pn-bell-badge { position: absolute; top: -5px; right: -5px; background: #c53030; color: #fff; font-size: 10px; font-weight: 800; min-width: 16px; height: 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; padding: 0 4px; line-height: 1; }
      .pn-bell-panel { position: absolute; top: 44px; right: 0; width: 320px; max-width: calc(100vw - 24px); background: var(--card, #fff); border: 1px solid var(--border, #ccc); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.18); z-index: 500; max-height: 420px; overflow: auto; display: none; }
      .pn-bell.pn-abierto .pn-bell-panel { display: block; }
      .pn-bell-head { padding: 12px 14px; border-bottom: 1px solid var(--border, #ddd); font-weight: 700; font-size: 13px; }
      .pn-bell-item { padding: 10px 14px; border-bottom: 1px solid var(--border, #ddd); cursor: pointer; }
      .pn-bell-item:last-child { border-bottom: none; }
      .pn-bell-item:hover { background: var(--bg, #f5f5f5); }
      .pn-bell-item b { display: block; font-size: 13px; }
      .pn-bell-item span { display: block; font-size: 12px; color: var(--muted, #777); margin-top: 2px; }
      .pn-bell-item em { display: block; font-style: normal; font-size: 11px; color: #c53030; font-weight: 700; margin-top: 4px; }
      .pn-bell-head { display: flex; align-items: center; justify-content: space-between; }
      .pn-bell-add { background: var(--accent, #555); color: #fff; border: none; border-radius: 6px; width: 26px; height: 26px; font-size: 18px; line-height: 1; cursor: pointer; padding: 0; }
      .pn-bell-form { display: none; padding: 10px 14px; border-bottom: 1px solid var(--border, #ddd); background: var(--bg, #f7f7f7); }
      .pn-bell-form.pn-abierto { display: block; }
      .pn-bell-form input, .pn-bell-form textarea { width: 100%; box-sizing: border-box; margin: 3px 0 6px; padding: 7px 8px; border: 1px solid var(--border, #ccc); border-radius: 6px; font: inherit; font-size: 13px; }
      .pn-bell-form button.pn-guardar { background: var(--accent, #555); color: #fff; border: none; border-radius: 6px; padding: 7px 12px; font-weight: 700; font-size: 13px; cursor: pointer; }
      .pn-bell-form .pn-msg { font-size: 12px; margin-top: 6px; }
      .pn-bell-hecho { margin-top: 6px; background: transparent; border: 1px solid var(--border, #ccc); border-radius: 6px; font-size: 12px; padding: 3px 8px; cursor: pointer; color: var(--text, inherit); }
      .pn-bell-vacio { padding: 20px 14px; text-align: center; color: var(--muted, #777); font-size: 13px; }
      .pn-orgbar { display: inline-flex; align-items: center; gap: 6px; margin-right: 10px; vertical-align: middle; }
      .pn-orgbar .pn-orgbar-lbl { white-space: nowrap; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
      .pn-orgbar select, .pn-orgbar .pn-orgbar-fija { padding: 7px 10px; border: 1px solid var(--accent, #555); border-radius: 8px; font-size: 13px; font-weight: 700; background: var(--accent-soft, var(--bg)); color: var(--accent, var(--pn-ink)); font-family: inherit; max-width: 220px; cursor: pointer; }
      .pn-orgbar .pn-orgbar-fija { cursor: default; }
      .pn-orgbar.pn-orgbar-todas select { border-color: #b7791f; background: #fffaf0; color: #b7791f; }
      @media (max-width: 600px) { .pn-orgbar .pn-orgbar-lbl { display: none; } .pn-orgbar select { max-width: 140px; } }
      .pn-usermenu { position: relative; display: inline-block; }
      .pn-usermenu > button.pn-usermenu-btn {
        display: inline-flex; align-items: center; gap: 7px; background: transparent; border: 1px solid var(--border);
        color: var(--pn-ink); padding: 7px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit; font-weight: 600; max-width: 240px;
      }
      .pn-usermenu > button.pn-usermenu-btn:hover { border-color: var(--accent, #555); color: var(--accent, #555); }
      .pn-usermenu-btn .pn-nom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pn-usermenu-btn svg { width: 15px; height: 15px; flex-shrink: 0; }
      .pn-usermenu-menu {
        display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 250px; z-index: 400;
        background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 6px;
        box-shadow: var(--shadow, 0 8px 24px rgba(0,0,0,.18));
      }
      .pn-usermenu.pn-abierto .pn-usermenu-menu { display: block; }
      .pn-usermenu-menu a, .pn-usermenu-menu button.pn-um-item {
        display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 8px; border: none; background: none;
        text-decoration: none; color: var(--pn-ink); font-size: 13px; font-weight: 600; font-family: inherit; cursor: pointer; text-align: left;
      }
      .pn-usermenu-menu a:hover, .pn-usermenu-menu button.pn-um-item:hover { background: var(--bg); }
      .pn-usermenu-menu a.pn-activo { background: var(--accent-soft); color: var(--accent); }
      .pn-usermenu-menu svg { width: 16px; height: 16px; flex-shrink: 0; }
      .pn-usermenu-menu hr { border: none; border-top: 1px solid var(--border); margin: 5px 4px; }
      .pn-usermenu-menu button.pn-um-salir:hover { color: var(--danger, #c53030); }
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

  function cerrarSesionPN() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ORG_KEY);
    location.href = '/inicio.html';
  }
  // Reemplaza el "nombre + Cerrar sesión" de la barra de arriba de cada
  // pantalla por un desplegable: nombre ▾ → Configuración, Bases y catálogos
  // y Cerrar sesión. Se engancha al #topbarUser que ya tienen las pantallas.
  // Selector de sucursal SIEMPRE visible arriba, al lado del usuario: dice en qué
  // sucursal se está trabajando y permite cambiarla desde cualquier pantalla.
  // Sucursal de operación vigente: la guardada si sigue siendo válida; si la vista (ORG_KEY) es una sucursal puntual, esa; si no, Piedra Negra / la primera.
  function sucursalOperar(me) {
    const orgs = me.organizaciones || [];
    const ids = orgs.map(o => String(o._id));
    const vista = localStorage.getItem(ORG_KEY) || '';
    let op = vista && vista !== 'todas' && ids.includes(vista) ? vista : localStorage.getItem(OPERAR_KEY);
    if (!op || !ids.includes(op)) { const def = orgs.find(o => o.nombre === 'Piedra Negra') || orgs[0]; op = def ? String(def._id) : ''; }
    if (op) localStorage.setItem(OPERAR_KEY, op);
    return op;
  }
  function montarSelectorOrg(me, wrap) {
    if (document.querySelector('.pn-orgbar') || OCULTAR_ORG) return;
    const orgs = me.organizaciones || [];
    if (!orgs.length && !me.puedeVerTodas) return;
    const orgActiva = localStorage.getItem(ORG_KEY) || '';
    const puedeElegir = orgs.length > 1 || me.puedeVerTodas;
    const operar = sucursalOperar(me);
    const box = document.createElement('div');
    box.className = 'pn-orgbar' + (orgActiva === 'todas' ? ' pn-orgbar-todas' : '');
    if (!puedeElegir) {
      box.innerHTML = `<span class="pn-orgbar-lbl">Sucursal</span><span class="pn-orgbar-fija">${escapeHtml(orgs[0].nombre)}</span>`;
    } else if (me.puedeVerTodas) {
      // Operás en UNA sucursal (acá se guarda todo); la vista puede ser solo esa o todas.
      box.innerHTML = `<span class="pn-orgbar-lbl">Opero en</span><select id="pnTopOrg" aria-label="Sucursal con la que operás" title="Sucursal en la que se guardan las ventas, compras, pagos, etc.">
          ${orgs.map(o => `<option value="${o._id}" ${o._id === operar ? 'selected' : ''}>${escapeHtml(o.nombre)}</option>`).join('')}
        </select>
        <span class="pn-orgbar-lbl">Ver</span><select id="pnTopVista" aria-label="Qué sucursales ver" title="Ver solo la sucursal con la que operás, o los datos de todas">
          <option value="una" ${orgActiva !== 'todas' ? 'selected' : ''}>Solo esta sucursal</option>
          <option value="todas" ${orgActiva === 'todas' ? 'selected' : ''}>Todas las sucursales</option>
        </select>`;
    } else {
      box.innerHTML = `<span class="pn-orgbar-lbl">Sucursal</span><select id="pnTopOrg" aria-label="Sucursal de trabajo" title="Sucursal con la que estás trabajando (cambiala acá en cualquier momento)">
        ${orgs.map(o => `<option value="${o._id}" ${o._id === orgActiva ? 'selected' : ''}>${escapeHtml(o.nombre)}</option>`).join('')}
      </select>`;
    }
    wrap.parentElement.insertBefore(box, wrap);
    const sel = box.querySelector('#pnTopOrg'), selVista = box.querySelector('#pnTopVista');
    if (sel) sel.addEventListener('change', function () {
      if (me.puedeVerTodas) {
        localStorage.setItem(OPERAR_KEY, this.value);
        localStorage.setItem(ORG_KEY, (localStorage.getItem(ORG_KEY) === 'todas') ? 'todas' : this.value);
      } else if (this.value) localStorage.setItem(ORG_KEY, this.value); else localStorage.removeItem(ORG_KEY);
      location.reload();
    });
    if (selVista) selVista.addEventListener('change', function () {
      localStorage.setItem(ORG_KEY, this.value === 'todas' ? 'todas' : sucursalOperar(me));
      location.reload();
    });
  }
  // Campanita de notificaciones + cotización del dólar, siempre visibles arriba al lado del usuario (16/10/2026).
  function montarExtrasTopbar(wrap) {
    if (document.querySelector('.pn-extras')) return;
    const token = localStorage.getItem(TOKEN_KEY) || '';
    if (!token) return;
    const hdrs = { 'x-admin-token': token };
    const org = localStorage.getItem(ORG_KEY) || '';
    if (org) hdrs['x-org-id'] = org;
    const enInicio = !!document.getElementById('notifWrap'); // inicio.html ya trae su propia campanita
    const box = document.createElement('div');
    box.className = 'pn-extras';
    box.innerHTML = '<span class="pn-dolar" style="display:none" title="Dólar oficial Banco Nación (venta)"><small>Dólar</small><span class="pn-dolar-v">—</span></span>' +
      (enInicio ? '' : '<div class="pn-bell"><button type="button" data-iconizado="1" class="pn-bell-btn" aria-label="Notificaciones" title="Notificaciones"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg><span class="pn-bell-badge" style="display:none">0</span></button><div class="pn-bell-panel"><div class="pn-bell-head"><span>Notificaciones</span><button type="button" data-iconizado="1" class="pn-bell-add" title="Agregar recordatorio" aria-label="Agregar recordatorio">+</button></div><div class="pn-bell-form"><label style="font-size:12px;font-weight:700">Recordatorio</label><input class="pn-r-titulo" placeholder="¿Qué querés recordar?"><input class="pn-r-fecha" type="datetime-local"><textarea class="pn-r-nota" rows="2" placeholder="Nota (opcional)"></textarea><button type="button" data-iconizado="1" class="pn-guardar">Guardar y agendar</button><div class="pn-msg"></div></div><div class="pn-bell-body"></div></div></div>');
    wrap.parentElement.insertBefore(box, wrap);
    const dolarEl = box.querySelector('.pn-dolar');
    fetch('/api/productos/config/cotizacion-dolar', { headers: hdrs }).then(r => r.ok ? r.json() : null).then(function (d) {
      if (!d) return;
      const v = (d.bna && d.bna.venta) || d.valor;
      if (!v) return;
      dolarEl.querySelector('.pn-dolar-v').textContent = '$ ' + Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      dolarEl.style.display = '';
    }).catch(function () {});
    if (enInicio) return;
    const bell = box.querySelector('.pn-bell'), btn = bell.querySelector('.pn-bell-btn'), badge = bell.querySelector('.pn-bell-badge'), body = bell.querySelector('.pn-bell-body');
    let items = [];
    const destino = function (tipo, id) {
      if (tipo === 'crm') return '/admin-visitas.html?abrir=crm-' + id;
      if (tipo === 'visita') return '/admin-visitas.html?abrir=visita-' + id;
      if (tipo === 'obra') return '/admin-obras.html?abrir=obra-' + id;
      if (tipo === 'cheque_vencido' || tipo === 'cheque_por_vencer') return '/admin-tesoreria.html?tab=cheques';
      if (tipo === 'caja_sin_cerrar') { const p = String(id).split('|'); return '/admin-tesoreria.html?tab=cajadiaria&dia=' + encodeURIComponent(p[0]) + '&caja=' + encodeURIComponent(p[1] || ''); }
      if (tipo === 'orden_compra' || tipo === 'compra_por_pagar') return '/admin-compras.html';
      if (tipo === 'venta_sin_entregar' || tipo === 'venta_sin_cobrar') return '/admin-ventas.html';
      if (tipo === 'stock_bajo') return '/admin-stock.html';
      return '';
    };
    const pintar = function () {
      badge.textContent = items.length > 9 ? '9+' : String(items.length);
      badge.style.display = items.length ? '' : 'none';
      body.innerHTML = items.length ? items.map(function (it, i) {
        return '<div class="pn-bell-item" data-i="' + i + '"><b>' + escapeHtml(it.titulo) + '</b><span>' + escapeHtml(it.subtitulo || '') + '</span>' + (it.fecha ? '<em>' + escapeHtml(it.etiquetaFecha || 'Venció el') + ' ' + new Date(it.fecha).toLocaleString('es-AR', it.tipo === 'recordatorio' ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' } : undefined) + '</em>' : '') + (it.tipo === 'recordatorio' ? '<button type="button" data-iconizado="1" class="pn-bell-hecho" data-hecho="' + i + '">✓ Hecho</button>' : '') + '</div>';
      }).join('') : '<div class="pn-bell-vacio">Sin pendientes.</div>';
    };
    const cargar = function () {
      fetch('/api/notificaciones', { headers: hdrs }).then(r => r.ok ? r.json() : null).then(function (d) {
        if (!d) { bell.style.display = 'none'; return; }
        items = d.items || []; pintar();
      }).catch(function () {});
    };
    btn.addEventListener('click', function (e) { e.stopPropagation(); bell.classList.toggle('pn-abierto'); });
    const form = bell.querySelector('.pn-bell-form'), msg = form.querySelector('.pn-msg');
    bell.querySelector('.pn-bell-add').addEventListener('click', function (e) {
      e.stopPropagation(); form.classList.toggle('pn-abierto'); msg.textContent = '';
      const f = form.querySelector('.pn-r-fecha');
      if (!f.value) { const d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); f.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
      form.querySelector('.pn-r-titulo').focus();
    });
    form.addEventListener('click', function (e) { e.stopPropagation(); });
    form.querySelector('.pn-guardar').addEventListener('click', function () {
      const titulo = form.querySelector('.pn-r-titulo').value.trim(), fechaHora = form.querySelector('.pn-r-fecha').value, nota = form.querySelector('.pn-r-nota').value.trim();
      msg.style.color = '#c53030';
      if (!titulo) { msg.textContent = 'Poné un título.'; return; }
      if (!fechaHora) { msg.textContent = 'Elegí fecha y hora.'; return; }
      fetch('/api/notificaciones/recordatorios', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdrs), body: JSON.stringify({ titulo, fechaHora, nota }) })
        .then(r => r.json().then(d => ({ ok: r.ok, d }))).then(function (x) {
          if (!x.ok) { msg.textContent = x.d.error || 'No se pudo guardar'; return; }
          msg.style.color = '#2f855a';
          msg.textContent = x.d.enCalendario ? '✓ Guardado y agendado en el calendario.' : (x.d.calendarioConectado ? '✓ Guardado (no se pudo crear el evento en el calendario).' : '✓ Guardado. El calendario de Google no está conectado, así que no se creó el evento.');
          form.querySelector('.pn-r-titulo').value = ''; form.querySelector('.pn-r-nota').value = '';
          cargar();
        }).catch(function () { msg.textContent = 'Error de conexión'; });
    });
    body.addEventListener('click', function (e) {
      const bh = e.target.closest('.pn-bell-hecho');
      if (bh) {
        e.stopPropagation();
        const it = items[Number(bh.dataset.hecho)]; if (!it) return;
        fetch('/api/notificaciones/recordatorios/' + encodeURIComponent(it.id) + '/hecho', { method: 'POST', headers: hdrs }).then(cargar);
        return;
      }
      const el = e.target.closest('.pn-bell-item'); if (!el) return;
      const it = items[Number(el.dataset.i)]; const url = it && destino(it.tipo, it.id);
      if (url) location.href = url;
    });
    document.addEventListener('click', function (e) { if (!bell.contains(e.target)) bell.classList.remove('pn-abierto'); });
    cargar(); setInterval(cargar, 5 * 60 * 1000);
  }
  function montarMenuUsuario(me, paginaActual, nombreUsuario) {
    const spanUser = document.getElementById('topbarUser') || document.getElementById('oficinaNombre');
    if (!spanUser || document.querySelector('.pn-usermenu')) return;
    const raiz = spanUser.parentElement;
    const btnLogoutOriginal = Array.from(raiz.querySelectorAll('button')).find(b => /logout/i.test(b.getAttribute('onclick') || '')) || null;
    const contenedor = btnLogoutOriginal ? btnLogoutOriginal.parentElement : raiz;
    const items = ITEMS_CONFIGURACION.filter(it => itemVisible(it, me));
    const wrap = document.createElement('div');
    wrap.className = 'pn-usermenu';
    wrap.innerHTML = `
      <button type="button" data-iconizado="1" class="pn-usermenu-btn" aria-haspopup="true" aria-expanded="false">
        ${ICONOS.usuarios}<span class="pn-nom">${escapeHtml(nombreUsuario || 'Mi usuario')}</span>${ICONOS.chevron}
      </button>
      <div class="pn-usermenu-menu" role="menu">
        ${items.map(it => `<a href="${it.href}" class="${it.key === paginaActual ? 'pn-activo' : ''}">${it.icon}<span>${escapeHtml(it.label)}</span></a>`).join('')}
        ${items.length ? '<hr>' : ''}
        <button type="button" data-iconizado="1" class="pn-um-item pn-um-salir">${ICONOS.salir}<span>Cerrar sesión</span></button>
      </div>
    `;
    spanUser.style.display = 'none';
    if (btnLogoutOriginal) btnLogoutOriginal.style.display = 'none';
    if (btnLogoutOriginal) contenedor.insertBefore(wrap, btnLogoutOriginal); else contenedor.appendChild(wrap);
    montarSelectorOrg(me, wrap);
    montarExtrasTopbar(wrap);
    const btn = wrap.querySelector('.pn-usermenu-btn');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const abierto = wrap.classList.toggle('pn-abierto');
      btn.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) wrap.classList.remove('pn-abierto'); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') wrap.classList.remove('pn-abierto'); });
    wrap.querySelector('.pn-um-salir').addEventListener('click', function () {
      if (btnLogoutOriginal) btnLogoutOriginal.click(); else cerrarSesionPN();
    });
  }

  // Aviso de espacio de la base: solo Administrador, solo si pasó el 80 %, y se puede cerrar (vuelve a aparecer al día siguiente).
  function avisarEspacioDb(me) {
    try {
      if (!(me && me.rol && me.rol.protegido)) return;
      const hoy = new Date().toISOString().slice(0, 10);
      if (localStorage.getItem('pn_aviso_espacio') === hoy) return;
      const token = localStorage.getItem('obras_admin_token') || '';
      if (!token) return;
      fetch('/api/espacio-db', { headers: { 'x-admin-token': token } }).then(r => r.ok ? r.json() : null).then(function (d) {
        if (!d || d.nivel === 'ok') return;
        const critico = d.nivel === 'critico';
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;max-width:340px;padding:12px 14px;border-radius:10px;font:600 13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2);color:#fff;background:' + (critico ? '#b42318' : '#b45309');
        el.innerHTML = (critico ? '⚠️ Base de datos casi llena: ' : 'Base de datos al ' + d.porcentaje + ' %: ') + d.usadoMB + ' de ' + d.limiteMB + ' MB (' + d.porcentaje + ' %). ' +
          (critico ? 'Si se llena, el sistema deja de guardar ventas y cobros. ' : '') + 'Liberá espacio o pasá a un plan pago. <span style="text-decoration:underline;cursor:pointer;margin-left:6px">Cerrar</span>';
        el.querySelector('span').onclick = function () { localStorage.setItem('pn_aviso_espacio', hoy); el.remove(); };
        document.body.appendChild(el);
      }).catch(function () {});
    } catch (e) { /* aviso accesorio: nunca debe romper el menú */ }
  }

  function render(me, paginaActual, opts) {
    opts = opts || {};
    inyectarEstilos();
    if (document.querySelector('.pn-sidebar')) return; // ya renderizado (evita duplicar si algo llama render 2 veces)

    const orgs = me.organizaciones || [];
    if (me.puedeVerTodas) sucursalOperar(me);
    const orgActiva = localStorage.getItem(ORG_KEY) || '';
    // admin-costos.html ya trae su propio selector de organización en el
    // header (con el aviso de "todas" y la lógica de deshabilitar creación),
    // así que ahí se pide no repetirlo acá para no mostrar dos selectores.
    OCULTAR_ORG = paginaActual === 'costos'; // costos trae su propio selector
    const hayTopbar = !!(document.getElementById('topbarUser') || document.getElementById('oficinaNombre'));
    const mostrarOrgSelect = !opts.ocultarOrg && !hayTopbar && (orgs.length > 1 || me.puedeVerTodas);

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
                ${iconoItem(it)}<span>${escapeHtml(it.label)}</span>
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
      <div class="pn-sidebar-brand">
        <a href="/inicio.html" title="Inicio" style="display:flex;align-items:center;flex-shrink:0"><img src="/assets/logo-piedra-negra.png" onerror="this.outerHTML='<b style=&quot;font-size:13px&quot;>Piedra Negra</b>'" alt="Piedra Negra"></a>
        ${mostrarOrgSelect ? `<select id="pnSidebarOrg" aria-label="Organización" title="Organización con la que estás trabajando">
          ${orgs.map(o => `<option value="${o._id}" ${o._id === orgActiva ? 'selected' : ''}>${escapeHtml(o.nombre)}</option>`).join('')}
          ${me.puedeVerTodas ? `<option value="todas" ${orgActiva === 'todas' ? 'selected' : ''}>Todas las organizaciones</option>` : ''}
        </select>` : ''}
      </div>
      <div class="pn-sidebar-nav">${gruposHtml}</div>
      ${(document.getElementById('topbarUser') || document.getElementById('oficinaNombre')) ? '' : `<div class="pn-sidebar-footer">
        ${nombreUsuario ? `<span class="pn-nombre">${escapeHtml(nombreUsuario)}</span>` : ''}
        <button id="pnSidebarLogout">${ICONOS.salir}Cerrar sesión</button>
      </div>`}
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
        if (this.value && this.value !== 'todas') localStorage.setItem(OPERAR_KEY, this.value);
        location.reload();
      });
    }
    const btnSidebarLogout = document.getElementById('pnSidebarLogout');
    if (btnSidebarLogout) btnSidebarLogout.addEventListener('click', cerrarSesionPN);
    montarMenuUsuario(me, paginaActual, nombreUsuario);
    avisarEspacioDb(me);

    function cerrarSidebarMovil() {
      document.body.classList.remove('pn-sidebar-abierta');
      toggle.innerHTML = ICONOS.menu;
    }
  }

  window.PiedraSidebar = { render };
})();
