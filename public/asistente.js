// Asistente del sistema (17/10/2026): botón flotante con chat de IA para preguntar cómo se usa el sistema y dejar propuestas
// de mejora. Se carga solo desde nav-sidebar.js (todas las pantallas con menú lateral). Usa el token de sesión guardado.
(function () {
  if (window.__pnAsistente) return; window.__pnAsistente = true;
  const TOKEN_KEY = 'obras_admin_token';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hdr = () => ({ 'x-admin-token': localStorage.getItem(TOKEN_KEY) || '', 'Content-Type': 'application/json' });
  let mensajes = [], propuestaPendiente = null, ocupado = false;
  try { mensajes = JSON.parse(sessionStorage.getItem('pn_asistente_msgs') || '[]'); } catch (e) { mensajes = []; }
  const guardar = () => { try { sessionStorage.setItem('pn_asistente_msgs', JSON.stringify(mensajes.slice(-20))); } catch (e) {} };

  const css = `
  #pnAsBtn{position:fixed;right:18px;bottom:18px;z-index:900;width:54px;height:54px;border-radius:50%;border:0;background:#1f9d55;color:#fff;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;transition:transform .15s}
  #pnAsBtn:hover{transform:scale(1.06)} #pnAsBtn svg{width:26px;height:26px}
  #pnAsPanel{position:fixed;right:18px;bottom:84px;z-index:901;width:380px;max-width:calc(100vw - 24px);height:540px;max-height:calc(100vh - 110px);background:#fff;color:#1d1d1f;border:1px solid #d9d9de;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  #pnAsPanel.abierto{display:flex}
  #pnAsPanel .as-top{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#1d1d1f;color:#fff}
  #pnAsPanel .as-top b{flex:1;font-size:14px} #pnAsPanel .as-top button{background:transparent;border:0;color:#fff;cursor:pointer;font-size:12px;opacity:.85;padding:2px 6px}
  #pnAsMsgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f6f6f8}
  .as-m{max-width:88%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
  .as-m.u{align-self:flex-end;background:#ff5a36;color:#fff;border-bottom-right-radius:3px}
  .as-m.a{align-self:flex-start;background:#fff;border:1px solid #e3e3e8;border-bottom-left-radius:3px}
  .as-m.sis{align-self:center;background:transparent;color:#6b6b73;font-size:12px;text-align:center}
  .as-sug{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
  .as-sug button{background:#fff;border:1px solid #d9d9de;border-radius:999px;padding:5px 10px;font-size:12.5px;cursor:pointer;color:#1d1d1f}
  .as-sug button:hover{border-color:#ff5a36;color:#ff5a36}
  .as-prop{align-self:stretch;background:#fff8f5;border:1px solid #ffc9b9;border-radius:12px;padding:10px 12px}
  .as-prop h4{margin:0 0 4px;font-size:13px} .as-prop p{margin:0 0 8px;font-size:13px;white-space:pre-wrap}
  .as-prop .as-tags{font-size:11.5px;color:#6b6b73;margin-bottom:8px}
  .as-prop button{border:0;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;margin-right:6px}
  .as-prop .ok{background:#ff5a36;color:#fff} .as-prop .no{background:#e9e9ee;color:#1d1d1f}
  #pnAsForm{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e3e8;background:#fff}
  #pnAsIn{flex:1;resize:none;border:1px solid #d9d9de;border-radius:10px;padding:8px 10px;font:inherit;max-height:90px;color:#1d1d1f;background:#fff}
  #pnAsSend{background:#ff5a36;color:#fff;border:0;border-radius:10px;padding:0 14px;cursor:pointer;font-weight:600}
  #pnAsSend:disabled{opacity:.5;cursor:default}
  .as-lista{padding:12px;overflow-y:auto;flex:1;background:#f6f6f8} .as-lista .it{background:#fff;border:1px solid #e3e3e8;border-radius:10px;padding:8px 10px;margin-bottom:8px;font-size:13px}
  .as-lista .it small{color:#6b6b73;display:block}
  @media (max-width:520px){#pnAsPanel{right:8px;bottom:78px;width:calc(100vw - 16px);height:calc(100vh - 100px)}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const btn = document.createElement('button');
  btn.id = 'pnAsBtn'; btn.title = 'Asistente del sistema'; btn.setAttribute('aria-label', 'Abrir asistente del sistema');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z"/><circle cx="9" cy="12" r=".6"/><circle cx="12.5" cy="12" r=".6"/><circle cx="16" cy="12" r=".6"/></svg>';
  const panel = document.createElement('div');
  panel.id = 'pnAsPanel';
  panel.innerHTML = `<div class="as-top"><b>Asistente del sistema</b><button id="pnAsMias" title="Ver las propuestas que enviaste">Mis propuestas</button><button id="pnAsNuevo" title="Empezar una conversación nueva">Reiniciar</button><button id="pnAsX" aria-label="Cerrar">✕</button></div>
    <div id="pnAsMsgs"></div>
    <form id="pnAsForm"><textarea id="pnAsIn" rows="1" placeholder="Preguntá cómo se hace algo o contá qué mejorarías…"></textarea><button id="pnAsSend" type="submit">Enviar</button></form>`;
  document.body.appendChild(btn); document.body.appendChild(panel);
  const $m = () => document.getElementById('pnAsMsgs');

  const SUGERENCIAS = ['¿Cómo cobro una venta con Point?', '¿Cómo cargo una seña?', '¿Cómo convierto un presupuesto en venta?', 'Quiero proponer una mejora'];

  function pintar() {
    const c = $m(); c.innerHTML = '';
    if (!mensajes.length) {
      c.insertAdjacentHTML('beforeend', '<div class="as-m a">¡Hola! Soy el asistente del sistema. Puedo explicarte cómo se usa cada pantalla, y si se te ocurre algo para mejorar o algo no te cierra, lo dejo registrado para que lo vea el administrador.</div>');
      c.insertAdjacentHTML('beforeend', '<div class="as-sug">' + SUGERENCIAS.map(s => `<button type="button" data-s="${esc(s)}">${esc(s)}</button>`).join('') + '</div>');
      c.querySelectorAll('.as-sug button').forEach(b => b.onclick = () => enviar(b.dataset.s));
    }
    mensajes.forEach(m => { if (m.role === 'sis') c.insertAdjacentHTML('beforeend', `<div class="as-m sis">${esc(m.content)}</div>`); else c.insertAdjacentHTML('beforeend', `<div class="as-m ${m.role === 'user' ? 'u' : 'a'}">${esc(m.content)}</div>`); });
    if (propuestaPendiente) {
      const p = propuestaPendiente;
      c.insertAdjacentHTML('beforeend', `<div class="as-prop"><h4>${esc(p.titulo)}</h4><p>${esc(p.descripcion)}</p><div class="as-tags">${esc(p.tipo)} · prioridad ${esc(p.prioridad)}</div><button class="ok" id="pnAsOk">Enviar propuesta</button><button class="no" id="pnAsNo">Ahora no</button></div>`);
      document.getElementById('pnAsOk').onclick = registrar;
      document.getElementById('pnAsNo').onclick = () => { propuestaPendiente = null; mensajes.push({ role: 'sis', content: 'Propuesta descartada.' }); guardar(); pintar(); };
    }
    if (ocupado) c.insertAdjacentHTML('beforeend', '<div class="as-m a" style="opacity:.7">Escribiendo…</div>');
    c.scrollTop = c.scrollHeight;
  }

  async function enviar(texto) {
    texto = String(texto || '').trim();
    if (!texto || ocupado) return;
    mensajes.push({ role: 'user', content: texto }); propuestaPendiente = null; ocupado = true; guardar(); pintar();
    document.getElementById('pnAsSend').disabled = true;
    try {
      const r = await fetch('/api/asistente/chat', { method: 'POST', headers: hdr(), body: JSON.stringify({ mensajes: mensajes.filter(m => m.role !== 'sis'), pantalla: location.pathname + location.search }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo consultar al asistente');
      mensajes.push({ role: 'assistant', content: d.respuesta });
      propuestaPendiente = d.propuesta || null;
    } catch (e) { mensajes.push({ role: 'sis', content: e.message }); }
    ocupado = false; guardar(); pintar();
    document.getElementById('pnAsSend').disabled = false; document.getElementById('pnAsIn').focus();
  }

  async function registrar() {
    const p = propuestaPendiente; if (!p) return;
    const b = document.getElementById('pnAsOk'); if (b) b.disabled = true;
    try {
      const r = await fetch('/api/asistente/propuestas', { method: 'POST', headers: hdr(), body: JSON.stringify(Object.assign({}, p, { pantalla: location.pathname + location.search, contexto: mensajes.filter(m => m.role !== 'sis') })) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'No se pudo registrar');
      propuestaPendiente = null;
      mensajes.push({ role: 'sis', content: '✔ Propuesta registrada: "' + p.titulo + '". La va a revisar el administrador.' });
    } catch (e) { mensajes.push({ role: 'sis', content: e.message }); }
    guardar(); pintar();
  }

  async function verMias() {
    const c = $m();
    c.innerHTML = '<div class="as-m sis">Cargando…</div>';
    try {
      const r = await fetch('/api/asistente/propuestas/mias', { headers: hdr() });
      const l = await r.json();
      if (!r.ok) throw new Error(l.error || 'Error');
      c.innerHTML = '<div class="as-lista">' + (l.length ? l.map(p => `<div class="it"><b>${esc(p.titulo)}</b><small>${esc(p.pantalla || 'General')} · ${esc(p.estado)} · ${new Date(p.createdAt).toLocaleDateString('es-AR')}</small>${p.nota ? `<small>Respuesta: ${esc(p.nota)}</small>` : ''}</div>`).join('') : '<div class="as-m sis">Todavía no enviaste propuestas.</div>') + '<button type="button" class="as-sug" id="pnAsVolver" style="border:0;background:none;color:#ff5a36;cursor:pointer">← Volver al chat</button></div>';
      document.getElementById('pnAsVolver').onclick = pintar;
    } catch (e) { c.innerHTML = `<div class="as-m sis">${esc(e.message)}</div>`; }
  }

  function abrir(v) { panel.classList.toggle('abierto', v); if (v) { pintar(); setTimeout(() => document.getElementById('pnAsIn').focus(), 50); } }
  btn.onclick = () => abrir(!panel.classList.contains('abierto'));
  document.getElementById('pnAsX').onclick = () => abrir(false);
  document.getElementById('pnAsNuevo').onclick = () => { mensajes = []; propuestaPendiente = null; guardar(); pintar(); };
  document.getElementById('pnAsMias').onclick = verMias;
  document.getElementById('pnAsForm').onsubmit = e => { e.preventDefault(); const i = document.getElementById('pnAsIn'); const t = i.value; i.value = ''; i.style.height = 'auto'; enviar(t); };
  document.getElementById('pnAsIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('pnAsForm').requestSubmit(); } });
  document.getElementById('pnAsIn').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(90, e.target.scrollHeight) + 'px'; });
})();
