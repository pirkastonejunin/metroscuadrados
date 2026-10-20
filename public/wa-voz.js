// Notas de voz para WhatsApp: graba con el micrófono y deja el audio en un formato que WhatsApp acepta (Opus en contenedor Ogg).
// Chrome/Edge graban en WebM/Opus: se reempaqueta a Ogg sin recodificar (no pierde calidad). Firefox graba Ogg directo y Safari MP4/AAC, que WhatsApp también acepta.
(function(){
  // ---- lectura de WebM (EBML) ----
  function vint(b, p, quitar){ const f = b[p]; let n = 1, m = 0x80; while (n <= 8 && !(f & m)){ n++; m >>= 1; } if (n > 8) throw new Error('WebM inválido'); let v = quitar ? (f & (m - 1)) : f; let todos = (f & (m - 1)) === m - 1; for (let i = 1; i < n; i++){ v = v * 256 + b[p + i]; if (b[p + i] !== 255) todos = false; } return { v, n, desconocido: quitar && todos }; }
  const MASTER = new Set([0x18538067, 0x1F43B675, 0x1654AE6B, 0xAE, 0xA0]);
  function leerWebm(b){
    const frames = []; let head = null;
    (function rec(p, fin){
      while (p < fin){
        const id = vint(b, p, false); const sz = vint(b, p + id.n, true); const ini = p + id.n + sz.n; const f = sz.desconocido ? fin : Math.min(fin, ini + sz.v);
        if (MASTER.has(id.v)) rec(ini, f);
        else if (id.v === 0x63A2 && !head) head = b.slice(ini, f);
        else if (id.v === 0xA3 || id.v === 0xA1){ const t = vint(b, ini, true); const d = ini + t.n + 3; if (d < f) frames.push(b.slice(d, f)); }
        p = f;
      }
    })(0, b.length);
    return { frames, head };
  }
  function muestras(pkt){ const toc = pkt[0], cfg = toc >> 3; let ms; if (cfg < 12) ms = [10, 20, 40, 60][cfg & 3]; else if (cfg < 16) ms = (cfg & 1) ? 20 : 10; else ms = [2.5, 5, 10, 20][cfg & 3];
    const c = toc & 3; const n = c === 0 ? 1 : c === 3 ? (pkt[1] & 63) : 2; return Math.round(n * ms * 48); }
  // ---- escritura de Ogg ----
  const TABLA = (function(){ const t = new Uint32Array(256); for (let i = 0; i < 256; i++){ let r = i << 24; for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04C11DB7) : (r << 1); t[i] = r >>> 0; } return t; })();
  function crc(b){ let c = 0; for (let i = 0; i < b.length; i++) c = ((c << 8) ^ TABLA[((c >>> 24) ^ b[i]) & 255]) >>> 0; return c >>> 0; }
  function pagina(paquetes, tipo, granule, serie, sec){
    const seg = []; paquetes.forEach(p => { let l = p.length; while (l >= 255){ seg.push(255); l -= 255; } seg.push(l); });
    if (seg.length > 255) throw new Error('Página Ogg demasiado grande');
    const dl = paquetes.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(27 + seg.length + dl); const dv = new DataView(o.buffer);
    o.set([0x4F, 0x67, 0x67, 0x53, 0, tipo]); dv.setUint32(6, granule % 4294967296, true); dv.setUint32(10, Math.floor(granule / 4294967296), true);
    dv.setUint32(14, serie, true); dv.setUint32(18, sec, true); o[26] = seg.length; o.set(seg, 27); let q = 27 + seg.length; paquetes.forEach(p => { o.set(p, q); q += p.length; });
    dv.setUint32(22, crc(o), true); return o;
  }
  function webmAOgg(buf){
    const { frames, head } = leerWebm(new Uint8Array(buf)); if (!frames.length) throw new Error('No se grabó audio.');
    let oh = head && head.length >= 19 && String.fromCharCode(...head.slice(0, 8)) === 'OpusHead' ? head : null;
    if (!oh){ oh = new Uint8Array(19); oh.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]); const dv = new DataView(oh.buffer); dv.setUint16(10, 312, true); dv.setUint32(12, 48000, true); }
    const pre = new DataView(oh.buffer, oh.byteOffset, oh.byteLength).getUint16(10, true);
    const tags = new TextEncoder().encode('OpusTags'); const vend = new TextEncoder().encode('Piedra Negra'); const ot = new Uint8Array(8 + 4 + vend.length + 4); ot.set(tags); new DataView(ot.buffer).setUint32(8, vend.length, true); ot.set(vend, 12);
    const serie = (Math.random() * 4294967295) >>> 0; const out = []; let sec = 0;
    out.push(pagina([oh], 0x02, 0, serie, sec++)); out.push(pagina([ot], 0, 0, serie, sec++));
    let gr = pre, lote = [], total = 0; const POR = 40;
    frames.forEach((f, i) => { gr += muestras(f); lote.push(f); const ult = i === frames.length - 1;
      if (lote.length === POR || ult){ out.push(pagina(lote, ult ? 0x04 : 0, gr, serie, sec++)); lote = []; } });
    const n = out.reduce((a, p) => a + p.length, 0); const r = new Uint8Array(n); let q = 0; out.forEach(p => { r.set(p, q); q += p.length; });
    return { blob: new Blob([r], { type: 'audio/ogg' }), seg: Math.round((gr - pre) / 48000) };
  }
  window.waWebmAOgg = webmAOgg;
  // ---- grabación ----
  window.waVozDisponible = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  window.waVozIniciar = async function(){
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const tipos = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4']; const tipo = tipos.find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined); const partes = []; const t0 = Date.now(); let cancelada = false;
    rec.ondataavailable = e => { if (e.data && e.data.size) partes.push(e.data); }; rec.start(250);
    const soltar = () => stream.getTracks().forEach(t => t.stop());
    return {
      inicio: t0,
      cancelar(){ cancelada = true; try{ rec.stop(); }catch(e){} soltar(); },
      detener(){ return new Promise((ok, ko) => { rec.onstop = async () => { soltar(); if (cancelada) return;
        try{ const mt = (rec.mimeType || tipo || '').split(';')[0]; const crudo = new Blob(partes, { type: mt }); const seg = Math.max(1, Math.round((Date.now() - t0) / 1000));
          if (mt === 'audio/webm') { const r = webmAOgg(await crudo.arrayBuffer()); ok({ blob: r.blob, mime: 'audio/ogg', ext: 'ogg', seg: r.seg || seg }); }
          else if (mt === 'audio/ogg') ok({ blob: crudo, mime: 'audio/ogg', ext: 'ogg', seg });
          else if (mt === 'audio/mp4') ok({ blob: crudo, mime: 'audio/mp4', ext: 'm4a', seg });
          else throw new Error('Este navegador graba en un formato que WhatsApp no acepta. Probá con Chrome.');
        }catch(e){ ko(e); } }; try{ rec.stop(); }catch(e){ ko(e); } }); }
    };
  };
})();
