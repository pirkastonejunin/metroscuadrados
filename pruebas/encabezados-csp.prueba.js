const express = require('express');
const path = require('path'); const fs = require('fs');
const { chromium } = require('playwright');
(async () => {
  const REPO = path.join(__dirname, '..');
  const app = express(); app.use(require(REPO + '/seguridadHeaders')); app.use(express.static(path.join(REPO, 'public')));
  app.use('/api', (req, res) => res.status(401).json({ error: 'no' }));
  const srv = app.listen(4533);
  const b = await chromium.launch(); const ctx = await b.newContext(); let problemas = 0;
  for (const f of fs.readdirSync(path.join(REPO, 'public')).filter(x => x.endsWith('.html')).sort()) {
    const p = await ctx.newPage(); const viol = [];
    p.on('console', m => { const t = m.text(); if (/Content Security Policy|Refused to/i.test(t)) viol.push(t.slice(0, 200)); });
    p.on('pageerror', e => { if (/Content Security|ReferenceError|SyntaxError|is not defined/i.test(String(e))) viol.push(String(e).slice(0, 200)); });
    try { await p.goto('http://localhost:4533/' + f, { waitUntil: 'load', timeout: 15000 }); await p.waitForTimeout(600); } catch (e) { viol.push('goto: ' + e.message.slice(0, 100)); }
    if (viol.length) { problemas++; console.log('✘', f, [...new Set(viol)].slice(0, 3)); }
    await p.close();
  }
  const r = await fetch('http://localhost:4533/inicio.html');
  // Conectar el número de WhatsApp en modo coexistencia (Embedded Signup) carga el SDK de Facebook y abre sus marcos: la política tiene que dejarlo.
  const csp = r.headers.get('content-security-policy') || ''; const dir = n => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(n + ' ')) || '');
  if (!/https:\/\/connect\.facebook\.net/.test(dir('script-src')) || !/facebook\.com/.test(dir('frame-src')) || !/facebook\.com/.test(dir('connect-src'))) { problemas++; console.log('✘ la política bloquea el conector de Facebook (coexistencia de WhatsApp)'); }
  console.log('headers:', ['strict-transport-security', 'x-content-type-options', 'referrer-policy'].map(h => h + '=' + r.headers.get(h)).join(' | '));
  console.log(problemas ? problemas + ' pantallas con problemas' : 'ninguna pantalla viola la política'); await b.close(); srv.close(); process.exit(problemas ? 1 : 0);
})();
