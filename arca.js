// ---------------------------------------------------------------------------
// Conexión con ARCA (ex AFIP) — 5/10/2026, "parte fiscal".
//
// Librería SIN rutas HTTP (las rutas están en fiscal.js). Hace cuatro cosas:
//   1. Certificado propio de cada organización: genera la clave privada y el
//      pedido de certificado (CSR) dentro del sistema, guarda la clave
//      CIFRADA (AES-256-GCM) y valida el certificado que devuelve ARCA.
//   2. WSAA: pide y cachea el ticket de acceso (token + sign) por servicio.
//   3. WSFEv1: último número autorizado, solicitud de CAE, consulta de un
//      comprobante, parámetros (puntos de venta, condiciones de IVA).
//   4. Padrón (ws_sr_constancia_inscripcion): datos de un CUIT.
//
// Todo el SOAP se arma y lee a mano (sin librerías SOAP) para tener control
// total del orden de los elementos y de los errores.
//
// Variables de entorno (todas opcionales):
//   ARCA_SECRETO       clave para cifrar las claves privadas guardadas en la
//                      base. Si no está, se deriva de MONGODB_URI (funciona,
//                      pero si algún día cambia esa cadena habría que
//                      regenerar el certificado).
//   ARCA_WSAA_URL, ARCA_WSFE_URL, ARCA_PADRON_URL   para pisar los destinos
//                      (se usan en las pruebas).
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const forge = require('node-forge');
const { XMLParser } = require('fast-xml-parser');

const TIMEOUT_MS = 60000;

const DESTINOS = {
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
    padron: 'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5'
  },
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
    padron: 'https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5'
  }
};
function destino(entorno, cual) {
  const env = { wsaa: 'ARCA_WSAA_URL', wsfe: 'ARCA_WSFE_URL', padron: 'ARCA_PADRON_URL' }[cual];
  if (process.env[env]) return process.env[env];
  return (DESTINOS[entorno] || DESTINOS.homologacion)[cual];
}

function err(status, message, extra) { return Object.assign(new Error(message), { status }, extra || {}); }
function soloDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
function redondear2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }

// Hora de Argentina (UTC-3 fijo, no hay horario de verano).
function ahoraAR(offsetMs = 0) { return new Date(Date.now() - 3 * 3600 * 1000 + offsetMs); }
function isoAR(offsetMs = 0) { return ahoraAR(offsetMs).toISOString().slice(0, 19) + '-03:00'; }
function yyyymmddAR(fecha) {
  const d = fecha ? new Date(new Date(fecha).getTime() - 3 * 3600 * 1000) : ahoraAR();
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// CUIT/CUIL: 11 dígitos con dígito verificador (módulo 11).
function cuitValido(valor) {
  const c = soloDigitos(valor);
  if (c.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let s = 0;
  for (let i = 0; i < 10; i++) s += Number(c[i]) * pesos[i];
  let v = 11 - (s % 11);
  if (v === 11) v = 0;
  if (v === 10) v = 9;
  return v === Number(c[10]);
}

// ---------------------------------------------------------------------------
// Cifrado de la clave privada guardada en la base
// ---------------------------------------------------------------------------

function claveDeCifrado() {
  const base = process.env.ARCA_SECRETO || process.env.MONGODB_URI;
  if (!base) throw err(500, 'Falta ARCA_SECRETO (o MONGODB_URI) en el servidor para cifrar la clave del certificado.');
  return crypto.scryptSync(String(base), 'piedranegra-arca-v1', 32);
}
function usaSecretoPropio() { return !!process.env.ARCA_SECRETO; }

function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', claveDeCifrado(), iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
function descifrar(valor) {
  const p = String(valor || '').split('.');
  if (p.length !== 4 || p[0] !== 'v1') throw err(500, 'La clave del certificado guardada no tiene un formato válido.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', claveDeCifrado(), Buffer.from(p[1], 'base64'));
    d.setAuthTag(Buffer.from(p[2], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[3], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    throw err(500, 'No se pudo descifrar la clave del certificado (cambió ARCA_SECRETO o MONGODB_URI). Hay que generar el certificado de nuevo.');
  }
}

// ---------------------------------------------------------------------------
// Certificado: CSR, validación y guardado
// ---------------------------------------------------------------------------

function generarCsr({ cuit, razonSocial, alias }) {
  const cuitDig = soloDigitos(cuit);
  if (!cuitValido(cuitDig)) throw err(400, 'El CUIT de la organización no es válido. Cargalo bien en Configuración → Organizaciones.');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const key = forge.pki.privateKeyFromPem(keyPem);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  const nombre = String(alias || 'sistema').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || 'sistema';
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: String(razonSocial || 'Empresa').replace(/[^\w .,&-]/g, '').slice(0, 60) || 'Empresa' },
    { name: 'commonName', value: nombre },
    { name: 'serialNumber', value: 'CUIT ' + cuitDig }
  ]);
  csr.sign(key, forge.md.sha256.create());
  return { csrPem: forge.pki.certificationRequestToPem(csr), keyPem };
}

function limpiarPem(texto, tipo) {
  const m = String(texto || '').match(new RegExp(`-----BEGIN ${tipo}-----[\\s\\S]+?-----END ${tipo}-----`));
  return m ? m[0].replace(/\r/g, '').trim() + '\n' : null;
}

// Verifica que el certificado pegado sea de ESTA clave, que no esté vencido y
// (si lo trae) que corresponda al CUIT de la organización.
function validarCertificado({ certTexto, keyPem, cuit }) {
  const certPem = limpiarPem(certTexto, 'CERTIFICATE');
  if (!certPem) throw err(400, 'Eso no parece un certificado: tiene que empezar con "-----BEGIN CERTIFICATE-----".');
  let cert;
  try { cert = forge.pki.certificateFromPem(certPem); } catch (e) { throw err(400, 'No se pudo leer el certificado: ' + e.message); }
  const key = forge.pki.privateKeyFromPem(keyPem);
  if (cert.publicKey.n.toString(16) !== key.n.toString(16)) {
    throw err(400, 'Este certificado no corresponde a la solicitud generada por el sistema. Generá una solicitud nueva y pedí el certificado de nuevo en ARCA.');
  }
  const ahora = new Date();
  if (cert.validity.notAfter < ahora) throw err(400, 'El certificado ya está vencido.');
  const attrSerial = cert.subject.attributes.find(a => a.type === '2.5.4.5' || a.name === 'serialNumber' || a.shortName === 'serialNumber');
  const serial = (attrSerial && attrSerial.value) || '';
  const cuitCert = soloDigitos(serial);
  if (cuitCert && cuit && cuitCert !== soloDigitos(cuit)) {
    throw err(400, `El certificado es del CUIT ${cuitCert}, pero la organización tiene el CUIT ${soloDigitos(cuit)}.`);
  }
  return { certPem, vence: cert.validity.notAfter, sujeto: cert.subject.attributes.map(a => `${a.shortName || a.name}=${a.value}`).join(', ') };
}

// ---------------------------------------------------------------------------
// SOAP
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false, trimValues: true,
  isArray: (name) => ['Err', 'Evt', 'Obs', 'FECAEDetResponse', 'PtoVenta', 'CondicionIvaReceptor', 'impuesto', 'Tributo', 'IvaTipo'].includes(name)
});

async function postSoap(url, soapAction, xml) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp, texto;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: soapAction },
      body: xml, signal: ctl.signal
    });
    texto = await resp.text();
  } catch (e) {
    if (e.name === 'AbortError') throw err(504, 'ARCA tardó demasiado en responder. Probá de nuevo en unos minutos.', { incierto: true });
    throw err(502, 'No se pudo conectar con ARCA: ' + e.message, { incierto: true });
  } finally { clearTimeout(timer); }
  let doc;
  try { doc = parser.parse(texto); } catch (e) { throw err(502, 'ARCA devolvió una respuesta ilegible (estado ' + resp.status + ').', { incierto: true }); }
  const env = doc && doc.Envelope;
  const body = env && env.Body;
  if (!body) throw err(502, 'ARCA devolvió una respuesta inesperada (estado ' + resp.status + ').', { incierto: true });
  if (body.Fault) {
    const f = body.Fault;
    const msg = (f.faultstring || f.Reason && f.Reason.Text || 'error').toString();
    throw err(502, msg, { fault: true, faultcode: f.faultcode });
  }
  return body;
}

// ---------------------------------------------------------------------------
// WSAA — ticket de acceso (token + sign), cacheado en la base
// ---------------------------------------------------------------------------

function firmarTra(tra, certPem, keyPem) {
  const cert = forge.pki.certificateFromPem(certPem);
  const key = forge.pki.privateKeyFromPem(keyPem);
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() }
    ]
  });
  p7.sign();
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

const ticketsEnCurso = new Map();

async function obtenerTicket(db, cfg, servicio) {
  if (!cfg || !cfg.certPem || !cfg.keyEnc) throw err(400, 'Todavía no hay un certificado cargado para conectarse con ARCA (Fiscal → Configuración).');
  // Si el certificado se comparte entre sucursales, el ticket también: ARCA no
  // da un segundo ticket vigente para el mismo certificado y servicio.
  const dueno = cfg.ticketOrgId || cfg.orgId;
  const filtro = { orgId: dueno, entorno: cfg.entorno, servicio };
  const guardado = await db.collection('arca_tickets').findOne(filtro);
  if (guardado && guardado.expira > new Date(Date.now() + 5 * 60 * 1000) && guardado.certHuella === cfg.certHuella) {
    return { token: guardado.token, sign: guardado.sign };
  }
  const clave = `${dueno}|${cfg.entorno}|${servicio}`;
  if (ticketsEnCurso.has(clave)) return ticketsEnCurso.get(clave);
  const p = (async () => {
    const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(Date.now() / 1000)}</uniqueId><generationTime>${isoAR(-10 * 60 * 1000)}</generationTime><expirationTime>${isoAR(10 * 60 * 1000)}</expirationTime></header><service>${esc(servicio)}</service></loginTicketRequest>`;
    const cms = firmarTra(tra, cfg.certPem, descifrar(cfg.keyEnc));
    const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
    let body;
    try {
      body = await postSoap(destino(cfg.entorno, 'wsaa'), '""', xml);
    } catch (e) {
      if (e.fault && /alreadyAuthenticated|ya posee un TA/i.test(e.message + ' ' + (e.faultcode || ''))) {
        throw err(502, 'ARCA indica que ya hay un ticket vigente para este certificado y el sistema no lo tiene guardado. Esperá unos minutos (hasta que venza) y probá de nuevo.');
      }
      if (e.fault && /notAuthorized|no autorizado|no tiene autorizaci/i.test(e.message + ' ' + (e.faultcode || ''))) {
        throw err(502, `ARCA no autorizó este certificado para el servicio "${servicio}". Tenés que asociarlo en ARCA (Administrador de Relaciones de Clave Fiscal → Nueva relación → ${servicio}). Detalle: ${e.message}`);
      }
      throw e;
    }
    const retorno = body.loginCmsResponse && body.loginCmsResponse.loginCmsReturn;
    if (!retorno) throw err(502, 'ARCA no devolvió el ticket de acceso.');
    const ta = parser.parse(String(retorno)).loginTicketResponse;
    const cred = ta && ta.credentials;
    if (!cred || !cred.token || !cred.sign) throw err(502, 'El ticket de acceso de ARCA vino incompleto.');
    const expira = new Date(ta.header && ta.header.expirationTime ? ta.header.expirationTime : Date.now() + 11 * 3600 * 1000);
    await db.collection('arca_tickets').updateOne(filtro, { $set: { token: cred.token, sign: cred.sign, expira, certHuella: cfg.certHuella, updatedAt: new Date() } }, { upsert: true });
    return { token: cred.token, sign: cred.sign };
  })();
  ticketsEnCurso.set(clave, p);
  try { return await p; } finally { ticketsEnCurso.delete(clave); }
}

// ---------------------------------------------------------------------------
// WSFEv1
// ---------------------------------------------------------------------------

const NS_FE = 'http://ar.gov.afip.dif.FEV1/';

function sobreFe(cfg, ticket, operacion, cuerpoXml) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operacion} xmlns="${NS_FE}"><Auth><Token>${esc(ticket.token)}</Token><Sign>${esc(ticket.sign)}</Sign><Cuit>${soloDigitos(cfg.cuit)}</Cuit></Auth>${cuerpoXml}</${operacion}></soap:Body></soap:Envelope>`;
}
async function llamarFe(db, cfg, operacion, cuerpoXml) {
  const ticket = await obtenerTicket(db, cfg, 'wsfe');
  const body = await postSoap(destino(cfg.entorno, 'wsfe'), `"${NS_FE}${operacion}"`, sobreFe(cfg, ticket, operacion, cuerpoXml));
  const r = body[operacion + 'Response'] && body[operacion + 'Response'][operacion + 'Result'];
  if (!r) throw err(502, `ARCA no devolvió resultado para ${operacion}.`);
  return r;
}
function erroresFe(r) {
  const out = [];
  const errs = r.Errors && r.Errors.Err;
  (errs || []).forEach(e => out.push({ codigo: Number(e.Code), mensaje: e.Msg }));
  return out;
}
function eventosFe(r) {
  const evs = r.Events && r.Events.Evt;
  return (evs || []).map(e => ({ codigo: Number(e.Code), mensaje: e.Msg }));
}

async function dummyFe(cfg) {
  const body = await postSoap(destino(cfg.entorno, 'wsfe'), `"${NS_FE}FEDummy"`, `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><FEDummy xmlns="${NS_FE}"/></soap:Body></soap:Envelope>`);
  return body.FEDummyResponse && body.FEDummyResponse.FEDummyResult;
}

async function ultimoAutorizado(db, cfg, ptoVta, cbteTipo) {
  const r = await llamarFe(db, cfg, 'FECompUltimoAutorizado', `<PtoVta>${Number(ptoVta)}</PtoVta><CbteTipo>${Number(cbteTipo)}</CbteTipo>`);
  const e = erroresFe(r);
  if (e.length) throw err(502, 'ARCA: ' + e.map(x => `(${x.codigo}) ${x.mensaje}`).join(' | '), { errores: e });
  return Number(r.CbteNro || 0);
}

async function puntosDeVenta(db, cfg) {
  const r = await llamarFe(db, cfg, 'FEParamGetPtosVenta', '');
  const e = erroresFe(r);
  const lista = (r.ResultGet && r.ResultGet.PtoVenta || []).map(p => ({ numero: Number(p.Nro), tipoEmision: p.EmisionTipo, bloqueado: p.Bloqueado === 'S', baja: p.FchBaja && p.FchBaja !== 'NULL' ? p.FchBaja : null }));
  return { lista, errores: e };
}

async function consultarComprobante(db, cfg, ptoVta, cbteTipo, cbteNro) {
  const r = await llamarFe(db, cfg, 'FECompConsultar', `<FeCompConsReq><CbteTipo>${Number(cbteTipo)}</CbteTipo><CbteNro>${Number(cbteNro)}</CbteNro><PtoVta>${Number(ptoVta)}</PtoVta></FeCompConsReq>`);
  const e = erroresFe(r);
  // Solo el 602 ("no existe el comprobante") significa que no está: cualquier
  // otro error (autenticación, servicio caído) es INCIERTO y no puede tomarse
  // como "no existe", o se pediría otro número y se duplicaría la factura.
  if (e.length) {
    if (e.every(x => Number(x.codigo) === 602)) return { existe: false, errores: e };
    throw err(502, 'ARCA: ' + e.map(x => `(${x.codigo}) ${x.mensaje}`).join(' | '), { errores: e, incierto: true });
  }
  const g = r.ResultGet;
  if (!g) return { existe: false, errores: [] };
  return { existe: true, cae: g.CodAutorizacion, caeVto: g.FchVto, importe: Number(g.ImpTotal), fecha: g.CbteFch, docTipo: Number(g.DocTipo), docNro: String(g.DocNro), resultado: g.Resultado };
}

// Tipos de comprobante de ARCA.
const CBTE_TIPO = {
  factura: { A: 1, B: 6, C: 11 },
  nota_debito: { A: 2, B: 7, C: 12 },
  nota_credito: { A: 3, B: 8, C: 13 }
};
// Condición de IVA del receptor (FEParamGetCondicionIvaReceptor).
const COND_IVA_RECEPTOR = {
  responsable_inscripto: 1, exento: 4, consumidor_final: 5, monotributista: 6, exterior: 9, iva_no_alcanzado: 15
};
const DOC_TIPO = { cuit: 80, cuil: 86, dni: 96, pasaporte: 94, consumidor_final: 99 };

function num2(n) { return Number(n).toFixed(2); }

// Arma el <FECAEDetRequest>. El ORDEN de los elementos es el del esquema de
// ARCA (v4.x) — el servidor ignora en silencio lo que llega desordenado.
function armarDetalle(p) {
  const esC = p.letra === 'C';
  const fiscal = p.fiscal;
  const impNeto = fiscal.neto;
  const impIva = esC ? 0 : fiscal.iva;
  const impTotal = redondear2(impNeto + impIva);
  let x = '<FECAEDetRequest>';
  x += `<Concepto>${p.concepto || 1}</Concepto>`;
  x += `<DocTipo>${p.docTipo}</DocTipo><DocNro>${p.docNro}</DocNro>`;
  x += `<CbteDesde>${p.cbteNro}</CbteDesde><CbteHasta>${p.cbteNro}</CbteHasta>`;
  x += `<CbteFch>${p.fecha}</CbteFch>`;
  x += `<ImpTotal>${num2(impTotal)}</ImpTotal><ImpTotConc>0.00</ImpTotConc><ImpNeto>${num2(impNeto)}</ImpNeto><ImpOpEx>0.00</ImpOpEx><ImpTrib>0.00</ImpTrib><ImpIVA>${num2(impIva)}</ImpIVA>`;
  if ((p.concepto || 1) !== 1) x += `<FchServDesde>${p.fecha}</FchServDesde><FchServHasta>${p.fecha}</FchServHasta><FchVtoPago>${p.fecha}</FchVtoPago>`;
  x += `<MonId>${esc(p.moneda.id)}</MonId><MonCotiz>${Number(p.moneda.cotiz).toFixed(6)}</MonCotiz>`;
  x += `<CondicionIVAReceptorId>${p.condIvaReceptor}</CondicionIVAReceptorId>`;
  if (p.asociado) {
    x += `<CbtesAsoc><CbteAsoc><Tipo>${p.asociado.tipo}</Tipo><PtoVta>${p.asociado.ptoVta}</PtoVta><Nro>${p.asociado.nro}</Nro>${p.asociado.cuit ? `<Cuit>${soloDigitos(p.asociado.cuit)}</Cuit>` : ''}${p.asociado.fecha ? `<CbteFch>${p.asociado.fecha}</CbteFch>` : ''}</CbteAsoc></CbtesAsoc>`;
  }
  if (!esC && fiscal.grupos && fiscal.grupos.length) {
    x += '<Iva>' + fiscal.grupos.map(g => `<AlicIva><Id>${g.idArca}</Id><BaseImp>${num2(g.baseImp)}</BaseImp><Importe>${num2(g.importe)}</Importe></AlicIva>`).join('') + '</Iva>';
  }
  x += '</FECAEDetRequest>';
  return { xml: x, impTotal };
}

async function solicitarCae(db, cfg, p) {
  const { xml, impTotal } = armarDetalle(p);
  const cuerpo = `<FeCAEReq><FeCabReq><CantReg>1</CantReg><PtoVta>${Number(p.ptoVta)}</PtoVta><CbteTipo>${Number(p.cbteTipo)}</CbteTipo></FeCabReq><FeDetReq>${xml}</FeDetReq></FeCAEReq>`;
  const r = await llamarFe(db, cfg, 'FECAESolicitar', cuerpo);
  const errores = erroresFe(r);
  const eventos = eventosFe(r);
  const det = (r.FeDetResp && r.FeDetResp.FECAEDetResponse || [])[0] || {};
  const cab = r.FeCabResp || {};
  const resultado = det.Resultado || cab.Resultado || (errores.length ? 'R' : '');
  // Sin resultado, sin CAE y sin errores: respuesta ilegible → incierto, no rechazo.
  if (!resultado && !det.CAE && !errores.length) throw err(502, 'ARCA devolvió una respuesta que no se pudo interpretar.', { incierto: true });
  const observaciones = ((det.Observaciones && det.Observaciones.Obs) || []).map(o => ({ codigo: Number(o.Code), mensaje: o.Msg }));
  return {
    resultado, // A aprobado · O aprobado con observaciones · R rechazado
    aprobado: (resultado === 'A' || resultado === 'O') && !!det.CAE,
    cae: det.CAE || null, caeVto: det.CAEFchVto || null,
    cbteNro: Number(det.CbteDesde || p.cbteNro),
    observaciones, errores, eventos, impTotal
  };
}

// ---------------------------------------------------------------------------
// QR de la factura (RG 4291)
// ---------------------------------------------------------------------------
function urlQr({ fecha, cuit, ptoVta, cbteTipo, cbteNro, importe, moneda, cotiz, docTipo, docNro, cae }) {
  const f = String(fecha);
  const datos = {
    ver: 1, fecha: `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`, cuit: Number(soloDigitos(cuit)),
    ptoVta: Number(ptoVta), tipoCmp: Number(cbteTipo), nroCmp: Number(cbteNro), importe: Number(importe),
    moneda: moneda || 'PES', ctz: Number(cotiz || 1), tipoDocRec: Number(docTipo), nroDocRec: Number(docNro || 0),
    tipoCodAut: 'E', codAut: Number(cae)
  };
  return 'https://www.afip.gob.ar/fe/qr/?p=' + Buffer.from(JSON.stringify(datos)).toString('base64');
}

// ---------------------------------------------------------------------------
// Padrón — consulta de CUIT
// ---------------------------------------------------------------------------

const NS_PADRON = 'http://a5.soap.ws.server.puc.sr/';

function categoriaFiscalDePadron(persona) {
  if (persona.datosMonotributo && (persona.datosMonotributo.impuesto || persona.datosMonotributo.categoriaMonotributo)) return 'monotributista';
  const imps = (persona.datosRegimenGeneral && persona.datosRegimenGeneral.impuesto) || [];
  const activos = imps.filter(i => String(i.estadoImpuesto || '').toUpperCase() === 'AC').map(i => String(i.idImpuesto));
  if (activos.includes('30')) return 'responsable_inscripto';
  if (activos.includes('32')) return 'exento';
  if (activos.includes('33')) return 'responsable_inscripto'; // IVA Responsable No Inscripto (histórico)
  return '';
}

async function consultarCuit(db, cfg, cuitConsulta) {
  const cuit = soloDigitos(cuitConsulta);
  if (!cuitValido(cuit)) throw err(400, 'El CUIT no es válido (revisá los 11 dígitos).');
  const ticket = await obtenerTicket(db, cfg, 'ws_sr_constancia_inscripcion');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="${NS_PADRON}"><soapenv:Header/><soapenv:Body><a5:getPersona_v2><token>${esc(ticket.token)}</token><sign>${esc(ticket.sign)}</sign><cuitRepresentada>${soloDigitos(cfg.cuit)}</cuitRepresentada><idPersona>${cuit}</idPersona></a5:getPersona_v2></soapenv:Body></soapenv:Envelope>`;
  const body = await postSoap(destino(cfg.entorno, 'padron'), '""', xml);
  const ret = body.getPersona_v2Response && body.getPersona_v2Response.personaReturn;
  if (!ret) throw err(502, 'ARCA no devolvió datos para ese CUIT.');
  if (ret.errorConstancia) {
    const e = ret.errorConstancia.error;
    const msg = Array.isArray(e) ? e.join(' ') : (e || 'sin detalle');
    throw err(404, 'ARCA no encontró ese CUIT: ' + msg);
  }
  const persona = ret.persona || ret;
  const g = persona.datosGenerales || {};
  const dom = g.domicilioFiscal || {};
  const razonSocial = g.razonSocial || [g.apellido, g.nombre].filter(Boolean).join(' ');
  return {
    cuit, razonSocial: String(razonSocial || '').trim(),
    nombre: g.nombre || '', apellido: g.apellido || '',
    tipoPersona: g.tipoPersona || '', estadoClave: g.estadoClave || '',
    domicilio: dom.direccion || '', localidad: dom.localidad || '', codigoPostal: dom.codPostal || '',
    provincia: dom.descripcionProvincia || '',
    categoriaFiscal: categoriaFiscalDePadron(persona),
    activo: String(g.estadoClave || '').toUpperCase() === 'ACTIVO'
  };
}

module.exports = {
  DESTINOS, destino, err, soloDigitos, cuitValido, redondear2, yyyymmddAR, isoAR,
  cifrar, descifrar, usaSecretoPropio, generarCsr, validarCertificado, limpiarPem,
  obtenerTicket, firmarTra, postSoap,
  dummyFe, ultimoAutorizado, puntosDeVenta, consultarComprobante, solicitarCae, armarDetalle,
  CBTE_TIPO, COND_IVA_RECEPTOR, DOC_TIPO, urlQr, consultarCuit, categoriaFiscalDePadron
};
