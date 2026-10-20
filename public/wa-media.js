// Fotos, audios, videos y documentos de las conversaciones de WhatsApp (se usa en admin-bot.html).
(function(){
  const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const MEDIA = {}; const OK = /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|amr|wav|x-m4a)|video\/(mp4|3gpp|webm|quicktime)|application\/pdf)$/;
  const css = document.createElement('style');
  css.textContent = '.wm-i{display:block;max-width:240px;max-height:260px;border-radius:10px;margin-bottom:4px;min-width:90px;min-height:70px;object-fit:cover;cursor:zoom-in;background:rgba(127,127,127,.15)}.wm-b{margin-bottom:4px}.wm-b button{font:inherit;font-size:13px;padding:5px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;cursor:pointer}.wm-b audio,.wm-b video{max-width:240px;display:block}.wm-v{position:fixed;inset:0;z-index:10003;background:rgba(0,0,0,.82);display:grid;place-items:center;cursor:zoom-out}.wm-v img{max-width:92vw;max-height:90vh;border-radius:8px}.wm-v button{position:absolute;top:14px;right:14px;font-size:18px;padding:6px 12px;border-radius:8px;border:0;cursor:pointer}';
  document.head.appendChild(css);
  window.waMediaHtml = function(m){
    const a = m && m.archivo; if (!a) return ''; const id = esc(a.id);
    if (a.tipo==='image'||a.tipo==='sticker') return '<img class="wm-i" data-mid="'+id+'" alt="Foto"'+(MEDIA[a.id]?' src="'+MEDIA[a.id]+'"':'')+'>';
    if (a.tipo==='audio') return '<div class="wm-b"><button data-mid="'+id+'" data-act="audio">▶ '+(a.voz?'Escuchar el audio':'Escuchar')+'</button></div>';
    if (a.tipo==='video') return '<div class="wm-b"><button data-mid="'+id+'" data-act="video">▶ Ver el video</button></div>';
    return '<div class="wm-b"><button data-mid="'+id+'" data-act="doc" data-n="'+esc(a.nombre||'archivo')+'">📥 Abrir '+esc(a.nombre||'el archivo')+'</button></div>';
  };
  // texto debajo del archivo (en documentos y videos la primera línea es la etiqueta)
  window.waMediaTexto = function(m){ const a = m.archivo; if (!a) return m.texto||('['+(m.tipo||'archivo')+']'); return (a.tipo==='document'||a.tipo==='video') ? String(m.texto||'').split('\n').slice(1).join('\n') : (m.texto||''); };
  async function bajar(id){
    if (MEDIA[id]) return MEDIA[id];
    const r = await fetch('/api/bot/media/'+encodeURIComponent(id), {headers: window.H ? window.H() : {}});
    if (!r.ok){ let d={}; try{ d = await r.json(); }catch(e){} throw new Error(d.error||('Error '+r.status)); }
    const b = await r.blob(); const t = (b.type||'').split(';')[0];
    return MEDIA[id] = URL.createObjectURL(OK.test(t) ? b : new Blob([b],{type:'application/octet-stream'}));
  }
  function grande(src){
    const o = document.createElement('div'); o.className='wm-v'; o.innerHTML = '<img src="'+src+'" alt="Foto"><button aria-label="Cerrar">✕</button>';
    const x = () => { o.remove(); document.removeEventListener('keydown', k); }; const k = e => { if (e.key==='Escape') x(); };
    o.onclick = e => { if (e.target.tagName!=='IMG') x(); }; document.addEventListener('keydown', k); document.body.appendChild(o);
  }
  window.waMediaActivar = function(cont){
    if (!cont) return;
    cont.querySelectorAll('img.wm-i').forEach(img=>{
      if (img.getAttribute('src')){ img.onclick = () => grande(img.src); return; }
      bajar(img.dataset.mid).then(u=>{ img.src = u; img.onclick = () => grande(u); })
        .catch(e=>{ const s = document.createElement('span'); s.style.fontSize='12px'; s.textContent = '🖼 '+e.message; img.replaceWith(s); });
    });
    cont.querySelectorAll('button[data-act]').forEach(b=>b.onclick = async () => {
      const id = b.dataset.mid, act = b.dataset.act; const t0 = b.textContent; b.disabled = true; b.textContent = 'Cargando…';
      try{ const u = await bajar(id);
        if (act==='audio'){ const au = document.createElement('audio'); au.controls = true; au.src = u; au.autoplay = true; b.replaceWith(au); }
        else if (act==='video'){ const v = document.createElement('video'); v.controls = true; v.src = u; v.autoplay = true; v.playsInline = true; b.replaceWith(v); }
        else { const a = document.createElement('a'); a.href = u; a.target = '_blank'; a.rel='noopener'; a.download = b.dataset.n||'archivo'; document.body.appendChild(a); a.click(); a.remove(); b.disabled = false; b.textContent = t0; }
      }catch(e){ b.disabled = false; b.textContent = t0; alert(e.message); }
    });
  };
})();
