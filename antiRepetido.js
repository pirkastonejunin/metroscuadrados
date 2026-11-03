// Envíos repetidos (auditoría 3/11/2026): doble clic, el navegador que reenvía, o el usuario que toca "Guardar" otra vez
// porque la respuesta tarda. Si llega el MISMO POST (mismo usuario, misma ruta, mismo contenido) mientras el primero todavía
// se está procesando, o hasta 3 segundos después de que terminó, no se ejecuta de nuevo: se espera a que termine el primero y
// se devuelve su misma respuesta. (3 s y no más: hay pantallas que consultan un estado con el mismo POST cada 4 s.) Así una venta, un cobro o
// un pago no se guardan dos veces. Solo en memoria del proceso (Render corre una sola instancia).
const crypto = require('crypto');
const VENTANA_MS = 3000, EN_CURSO_MAX_MS = 120000;
const EXCLUIR = [/^\/api\/usuarios\/login/, /webhook/i, /^\/api\/bot\//];
const vistos = new Map();

function limpiar(ahora) {
  if (vistos.size < 200) return;
  for (const [k, v] of vistos) if ((v.terminado && ahora - v.fin > VENTANA_MS) || ahora - v.t > EN_CURSO_MAX_MS) vistos.delete(k);
}

function antiRepetido(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = req.headers['x-admin-token'];
  if (!token || EXCLUIR.some(r => r.test(req.originalUrl || req.url))) return next();
  let cuerpo; try { cuerpo = JSON.stringify(req.body || {}); } catch (e) { return next(); }
  const clave = crypto.createHash('sha256').update([token, req.headers['x-org-id'] || '', req.headers['x-org-operar'] || '', req.originalUrl, cuerpo].join('\u0000')).digest('hex');
  const ahora = Date.now();
  limpiar(ahora);
  const previo = vistos.get(clave);
  if (previo && ((!previo.terminado && ahora - previo.t <= EN_CURSO_MAX_MS) || (previo.terminado && ahora - previo.fin <= VENTANA_MS))) {
    return previo.listo.then(r => {
      if (!r) return next(); // la primera no respondió JSON (un PDF, un archivo): se deja pasar
      res.set('X-Envio-Repetido', '1');
      res.status(r.status).json(r.body);
    });
  }
  let resolver;
  const entrada = { t: ahora, terminado: false, listo: new Promise(r => { resolver = r; }) };
  vistos.set(clave, entrada);
  const jsonOriginal = res.json.bind(res);
  res.json = (body) => { if (!entrada.terminado) { entrada.terminado = true; entrada.fin = Date.now(); resolver({ status: res.statusCode, body }); } return jsonOriginal(body); };
  const cerrar = () => { if (!entrada.terminado) { entrada.terminado = true; entrada.fin = Date.now(); resolver(null); } };
  res.on('finish', cerrar); // no en 'close': si el cliente corta, el primero sigue corriendo y el repetido tiene que esperarlo
  next();
}
module.exports = antiRepetido;
