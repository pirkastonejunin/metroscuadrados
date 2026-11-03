// Encabezados de seguridad (auditoría 3/11/2026). Se mandan en todas las respuestas:
//  - HSTS: el navegador usa siempre https con este sitio.
//  - nosniff: el navegador no adivina el tipo de un archivo (evita que una subida se ejecute como script).
//  - Referrer-Policy: no se filtran las direcciones internas a otros sitios.
//  - CSP: solo se cargan scripts/estilos/fuentes/imágenes de los sitios que el sistema usa de verdad (propios, Google Fonts,
//    jsDelivr para la librería de Excel, Cloudinary para fotos) y nadie puede meter el sistema en un marco ajeno (clickjacking).
//    Los scripts y estilos "en línea" siguen permitidos porque todas las pantallas los usan.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' https://api.cloudinary.com",
  "frame-src 'self' blob: data:",
  "object-src 'self' blob: data:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self' https://*.mitiendanube.com https://*.tiendanube.com https://*.nuvemshop.com.br"
].join('; ');

module.exports = function seguridadHeaders(req, res, next) {
  res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  next();
};
module.exports.CSP = CSP;
