// Parecido entre nombres de producto (compartido por equivalencias de proveedores y vínculo con Tiendanube).
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' '); }
const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'con', 'para', 'por', 'x', 'm2', 'm²', 'unidad', 'cm', 'mm', 'mts', 'mt']);
function tokensNombre(s) {
  const t = norm(s).replace(/[()]/g, ' ').replace(/(\d)\s*[x×*]\s*(\d)/g, '$1x$2').replace(/(\d),(\d)/g, '$1.$2').split(/[^a-z0-9.x]+/).filter(Boolean);
  return [...new Set(t.map(w => w.replace(/^\.+|\.+$/g, '')).filter(w => w && !PALABRAS_VACIAS.has(w) && (w.length > 1 || /\d/.test(w))))];
}
function parecido(a, b) {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let comunes = 0, peso = 0, pesoTotal = 0;
  const pesoDe = w => (/\d/.test(w) ? 2 : 1);
  for (const w of a) { pesoTotal += pesoDe(w); if (sb.has(w)) { comunes++; peso += pesoDe(w); } }
  for (const w of b) if (!a.includes(w)) pesoTotal += pesoDe(w);
  return comunes ? (2 * peso) / (pesoTotal + peso) : 0;
}
module.exports = { norm, tokensNombre, parecido };
