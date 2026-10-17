// Cobro con Mercado Pago (Point o link de pago) reutilizable desde cualquier pantalla
// (15/10/2026, pedido de Mato: "que el Point esté vinculado en todas las pantallas
// donde puedo acceder al cobro": ventas, cobranza, cuenta corriente, tesorería).
// Uso: MPCobro.abrir({ tipo: 'point'|'link', ventaId | clienteId, titulo, saldo, monto, montoFn, onAcreditado })
//   - ventaId: cobra (total o parcial) esa venta. clienteId: cobro a cuenta del cliente.
//   - monto / montoFn(): monto inicial sugerido (si no, el saldo).
// Usa las variables globales TOKEN y ORG de cada pantalla. El cobro se registra solo
// cuando Mercado Pago confirma (webhook o consulta desde acá).
(function () {
  const BASE = '/api/mercadopago';
  const EST = { pendiente: 'Esperando pago', registrando: 'Registrando…', acreditado: 'Cobrado ✔', error: 'Error al registrar', rechazado: 'Rechazado', cancelado: 'Cancelado' };
  let timer = null, ctx = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function hdr(json) {
    const h = { 'x-admin-token': (typeof TOKEN !== 'undefined' ? TOKEN : '') };
    if (typeof ORG !== 'undefined' && ORG) h['x-org-id'] = ORG;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  function parar() { if (timer) { clearInterval(timer); timer = null; } }
  function cerrar() { parar(); const o = document.getElementById('mpCobroOv'); if (o) o.remove(); }
  function pintar(html) {
    let o = document.getElementById('mpCobroOv');
    if (!o) { o = document.createElement('div'); o.id = 'mpCobroOv'; document.body.appendChild(o); }
    o.innerHTML = `<div class="modal-bg" style="z-index:400"><div class="modal" style="max-width:480px"><span class="close-x" onclick="MPCobro.cerrar()">✕</span>${html}</div></div>`;
  }
  const rutaBase = () => ctx.ventaId ? `${BASE}/ventas/${ctx.ventaId}` : `${BASE}/clientes/${ctx.clienteId}`;
  const nombreTipo = () => ctx.tipo === 'point' ? 'Cobrar con Point' : 'Link de pago';

  async function abrir(opts) {
    cerrar();
    ctx = Object.assign({}, opts);
    if (!ctx.ventaId && !ctx.clienteId) { alert('Elegí primero la venta o el cliente a cobrar.'); return; }
    let monto = ctx.montoFn ? Number(ctx.montoFn()) : (ctx.monto != null ? Number(ctx.monto) : Number(ctx.saldo));
    if (!(monto > 0)) monto = '';
    let terminales = [];
    if (ctx.tipo === 'point') {
      try { const r = await fetch(BASE + '/terminales', { headers: hdr() }); terminales = r.ok ? await r.json() : []; } catch (e) {}
    }
    ctx.planes = [];
    ctx.monto0 = monto;
    pintar(`
      <h2>${nombreTipo()}</h2>
      <p class="muted">${esc(ctx.titulo || '')}${ctx.saldo != null && ctx.ventaId ? ' · Saldo pendiente: ' + money(ctx.saldo) : ''}</p>
      <label>Monto a cobrar</label><input id="mpcMonto" type="number" step="0.01" min="0.01" value="${monto}" oninput="MPCobro.planes()">
      ${ctx.ventaId ? '<div id="mpcPlanBox"></div>' : ''}
      ${ctx.tipo === 'point' ? `<label style="margin-top:8px">Terminal</label><select id="mpcTerm"><option value="">Usar la terminal por defecto</option>${terminales.map(t => `<option value="${esc(t.id)}">${esc(t.nombre || t.id)}${t.pdv ? '' : ' (no está en modo PDV)'}</option>`).join('')}</select>` : ''}
      ${!ctx.ventaId ? '<p class="muted" style="margin-top:8px">Es un cobro a cuenta: queda como recibo en la cuenta corriente del cliente.</p>' : ''}
      <div class="err" id="mpcErr"></div>
      <div id="mpcEstado" class="muted" style="margin-top:8px"></div>
      <button class="btn" id="mpcGo" style="margin-top:10px" onclick="MPCobro.iniciar()">${ctx.tipo === 'point' ? 'Enviar a la terminal' : 'Generar link'}</button>`);
    if (ctx.ventaId) cargarPlanes();
  }

  // Planes de cuotas del canal: el cliente paga monto + recargo del plan (el costo lo absorbe el cliente si así está configurado).
  let planTimer = null;
  function planes() { clearTimeout(planTimer); planTimer = setTimeout(cargarPlanes, 300); }
  async function cargarPlanes() {
    const box = document.getElementById('mpcPlanBox'); if (!box) return;
    const monto = Number(document.getElementById('mpcMonto').value) || 0;
    const sug = (ctx.planesSugeridos || []).map(String);
    const previo = (document.getElementById('mpcPlan') || {}).value || (lista.find(p => sug.includes(String(p._id))) || {})._id || '';
    let lista = [];
    try { const r = await fetch(`${BASE}/planes-cobro?canal=${ctx.tipo}&monto=${monto}`, { headers: hdr() }); lista = r.ok ? await r.json() : []; } catch (e) {}
    ctx.planes = lista;
    if (!lista.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<label style="margin-top:8px">Plan de pago</label><select id="mpcPlan" onchange="MPCobro.resumen()"><option value="">Sin plan (un pago, sin recargo)</option>${lista.map(p => `<option value="${esc(p._id)}"${String(p._id) === String(previo) ? ' selected' : ''}>${esc(p.nombre)}${p.recargoPorcentaje ? ' — recargo ' + p.recargoPorcentaje + '%' : ' — sin recargo'}</option>`).join('')}</select><div id="mpcResumen" class="muted" style="margin-top:6px"></div>`;
    resumen();
  }
  function resumen() {
    const sel = document.getElementById('mpcPlan'), el = document.getElementById('mpcResumen'); if (!sel || !el) return;
    const p = ctx.planes.find(x => String(x._id) === sel.value);
    const monto = Number(document.getElementById('mpcMonto').value) || 0;
    el.innerHTML = p && p.recargo > 0 ? `El cliente paga <b>${money(p.total)}</b> (${money(monto)} + recargo ${money(p.recargo)}). La venta se cancela por ${money(monto)}; el recargo queda como ingreso financiero.` : (p ? `El cliente paga ${money(monto)} en ${p.cuotas} cuota${p.cuotas > 1 ? 's' : ''}, sin recargo.` : '');
  }

  async function iniciar() {
    const monto = Number(document.getElementById('mpcMonto').value);
    const err = document.getElementById('mpcErr'); err.textContent = '';
    if (!(monto > 0)) { err.textContent = 'El monto tiene que ser mayor a 0'; return; }
    const body = { monto };
    const ps = document.getElementById('mpcPlan'); if (ps && ps.value) body.planId = ps.value;
    if (ctx.tipo === 'point') { const t = document.getElementById('mpcTerm').value; if (t) body.terminalId = t; }
    document.getElementById('mpcGo').disabled = true;
    try {
      const r = await fetch(rutaBase() + '/' + ctx.tipo, { method: 'POST', headers: hdr(true), body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      ctx.cobroId = d._id; ctx.monto = d.monto; ctx.montoCobrar = d.montoCobrar;
      if (ctx.tipo === 'link') mostrarLink(d.linkUrl, d.montoCobrar || d.monto); else esperarPoint();
      timer = setInterval(verificar, ctx.tipo === 'point' ? 4000 : 8000);
    } catch (e) { err.textContent = e.message; const b = document.getElementById('mpcGo'); if (b) b.disabled = false; }
  }

  function esperarPoint() {
    document.getElementById('mpcEstado').innerHTML = `Cobro enviado a la terminal${ctx.montoCobrar && ctx.montoCobrar !== ctx.monto ? ' por ' + money(ctx.montoCobrar) : ''}. Pedile al cliente que pase o acerque la tarjeta.<br><b>Esperando el pago…</b> <button class="btn small danger" onclick="MPCobro.cancelar()">Cancelar cobro</button>`;
    document.getElementById('mpcGo').style.display = 'none';
  }

  function mostrarLink(url, monto) {
    const texto = `Hola! Te paso el link para pagar ${money(monto)}: ${url}`;
    pintar(`
      <h2>Link de pago — ${money(monto)}</h2>
      <input id="mpcLink" readonly value="${esc(url)}" onclick="this.select()">
      <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <button class="btn" onclick="MPCobro.copiar()">Copiar link</button>
        <a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(texto)}">Enviar por WhatsApp</a>
        <button class="btn secondary" onclick="MPCobro.verificar(true)">Verificar pago</button>
      </div>
      <div id="mpcEstado" class="muted" style="margin-top:10px">Esperando el pago… Cuando el cliente pague, el cobro se registra solo. El link vence en 7 días.</div>`);
  }

  async function verificar(manual) {
    if (!ctx || !ctx.cobroId) return null;
    try {
      const r = await fetch(`${BASE}/cobros/${ctx.cobroId}/verificar`, { method: 'POST', headers: hdr(true) });
      const d = await r.json().catch(() => ({}));
      const el = document.getElementById('mpcEstado');
      if (d.estado === 'acreditado') {
        parar();
        const cb = ctx.onAcreditado;
        pintar(`<h2>Cobrado ✔</h2><p class="ok-msg">Se registró el cobro de ${money(d.monto)} con Mercado Pago${ctx.ventaId ? ' en la venta' : ' en la cuenta del cliente'} y en Tesorería.</p><button class="btn" onclick="MPCobro.cerrar()">Cerrar</button>`);
        if (cb) { try { cb(d); } catch (e) {} }
      } else if (d.estado && d.estado !== 'pendiente') {
        parar();
        if (el) el.innerHTML = '<b>' + esc(EST[d.estado] || d.estado) + '</b>' + (d.error ? ' — ' + esc(d.error) : '');
      } else if (manual && el) {
        el.innerHTML = 'Todavía no se acreditó el pago. Esperando…';
      }
      return d;
    } catch (e) { return null; }
  }

  async function cancelar() {
    if (!ctx || !ctx.cobroId) return;
    if (!confirm('¿Cancelar este cobro de Mercado Pago?')) return;
    parar();
    const r = await fetch(`${BASE}/cobros/${ctx.cobroId}/cancelar`, { method: 'POST', headers: hdr(true) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) alert(d.error || 'No se pudo cancelar');
    cerrar();
  }

  function copiar() { const el = document.getElementById('mpcLink'); el.select(); try { navigator.clipboard.writeText(el.value); } catch (e) { document.execCommand('copy'); } }

  window.MPCobro = { planes, resumen, abrir, iniciar, verificar, cancelar, cerrar, copiar };
})();
