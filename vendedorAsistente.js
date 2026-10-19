// ---------------------------------------------------------------------------
// Fase 3 del vendedor digital (19/10/2026): ayuda para el ASESOR humano dentro de cada conversación del bot de WhatsApp.
// A pedido del asesor (botón, no automático) analiza el chat y devuelve: resumen, intención, temperatura del cliente, productos, datos que
// faltan, próximo paso y una RESPUESTA SUGERIDA que el asesor edita y envía (el asistente nunca manda nada). Para sugerir con datos reales usa
// las mismas herramientas del bot (productos, precio/enlace, disponibilidad, cálculo de material). Además permite programar el seguimiento
// en la oportunidad del CRM (próxima acción), que luego avisa la campanita.
// ---------------------------------------------------------------------------
const ia = require('./ia');
const vt = require('./vendedorTools');
const { hoyAR } = require('./vendedorOportunidades');

const INTENCIONES = ['comprar_ahora', 'cotizando', 'consulta', 'postventa', 'reclamo', 'otro'];
const ESQUEMA = {
  type: 'object',
  properties: {
    resumen: { type: 'string', description: 'Qué pasó en la conversación y qué quiere el cliente, en 2 o 3 frases.' },
    intencion: { type: 'string', enum: INTENCIONES },
    temperatura: { type: 'string', enum: ['caliente', 'tibio', 'frio'], description: 'Qué tan cerca está de comprar.' },
    productos: { type: 'array', items: { type: 'string' }, description: 'Productos o rubros que mencionó.' },
    datosFaltantes: { type: 'array', items: { type: 'string' }, description: 'Datos que conviene pedirle al cliente (medidas, zona, plazo...).' },
    proximoPaso: { type: 'string', description: 'La acción concreta que debería hacer el asesor ahora.' },
    respuestaSugerida: { type: 'string', description: 'Mensaje listo para enviarle al cliente, escrito como asesor de Piedra Negra.' },
    seguimientoDias: { type: 'integer', description: 'En cuántos días conviene volver a contactarlo (0 = hoy). 0 si no hace falta.' },
    alertas: { type: 'array', items: { type: 'string' }, description: 'Cosas que el asesor debe verificar (precio, stock, promesas del bot...).' }
  },
  required: ['resumen', 'intencion', 'temperatura', 'proximoPaso', 'respuestaSugerida']
};

const hora = (d) => { try { const a = new Date(new Date(d).getTime() - 3 * 3600 * 1000); return a.toISOString().slice(5, 10).split('-').reverse().join('/') + ' ' + a.toISOString().slice(11, 16); } catch (e) { return ''; } };
function transcripcion(mensajes) {
  return mensajes.slice(-40).map(m => {
    const quien = m.dir === 'in' ? 'Cliente' : (m.origen === 'bot' ? 'Bot' : 'Asesor');
    const txt = String(m.texto || (m.tipo && m.tipo !== 'text' ? '[' + m.tipo + ']' : '')).slice(0, 800);
    return '[' + hora(m.at) + '] ' + quien + ': ' + txt;
  }).join('\n');
}

// ctx: { db, orgId, conv, mensajes, conocimiento, modo ('precio'|'link'|'link_o_precio'), ahora (texto) }
async function analizar(ctx) {
  const sistema = 'Sos el asistente interno de un ASESOR COMERCIAL de Piedra Negra (cerámicos, porcelanatos, revestimientos y materiales de construcción). El asesor es una persona: NO le hablás al cliente. '
    + 'Te paso la conversación de WhatsApp entre el cliente, el bot y los asesores. Analizala y completá el JSON. '
    + 'La "respuestaSugerida" es el mensaje que el asesor le mandaría al cliente: en español rioplatense (voseo), cálido, breve (máx. 4 líneas), que avance la venta con una sola pregunta o acción clara; no repitas lo que ya se le dijo. '
    + 'Si hace falta nombrar productos, precios, enlaces o disponibilidad, consultalos con las herramientas (nunca los inventes). No prometas descuentos, plazos de entrega ni stock que no estén confirmados; si el bot prometió algo dudoso, anotalo en "alertas". '
    + 'Si el último mensaje es del asesor o el cliente ya está atendido, la respuesta sugerida puede ser un seguimiento amable. Contexto: ' + (ctx.ahora || '') + '.'
    + (ctx.conocimiento ? '\n\nInformación del negocio (horarios, envíos, formas de pago):\n' + String(ctx.conocimiento).slice(0, 30000) : '')
    + vt.reglasPrompt(ctx.modo, false);
  const datos = ctx.conv.datos || {};
  const usuario = 'Cliente: ' + (ctx.conv.nombre || '(sin nombre)') + ' · +' + ctx.conv.tel + '\nEstado de la conversación: ' + ctx.conv.estado
    + (datos.producto || datos.medidas ? '\nDatos que juntó el bot: producto=' + (datos.producto || '-') + ', medidas=' + (datos.medidas || '-') + ', estilo=' + (datos.estilo || '-') : '')
    + (ctx.conv.borrador && ctx.conv.borrador.items ? '\nBorrador armado por el bot: ' + ctx.conv.borrador.items.map(i => i.cantidad + ' ' + i.unidad + ' ' + i.nombre).join('; ') : '')
    + '\n\nConversación:\n' + transcripcion(ctx.mensajes);
  const r = await ia.generar({
    uso: 'vendedor-asistente', orgId: ctx.orgId, sistema, mensajes: [{ role: 'user', text: usuario }], esquema: ESQUEMA, temperatura: 0.4, maxTokens: 1200, timeoutMs: 60000,
    proveedor: process.env.BOT_PROVEEDOR, modelo: process.env.BOT_MODELO || undefined, modelos: { anthropic: 'claude-haiku-4-5-20251001' },
    herramientas: vt.herramientas(ctx.db, ctx.orgId, ctx.modo, null), maxPasos: 4
  });
  const j = r.json;
  if (!j || !j.respuestaSugerida) throw Object.assign(new Error('La IA no devolvió un análisis válido. Probá de nuevo.'), { status: 502 });
  const lista = (v) => (Array.isArray(v) ? v : []).map(x => String(x).slice(0, 200)).slice(0, 8);
  return {
    resumen: String(j.resumen || '').slice(0, 800), intencion: INTENCIONES.includes(j.intencion) ? j.intencion : 'otro', temperatura: ['caliente', 'tibio', 'frio'].includes(j.temperatura) ? j.temperatura : 'tibio',
    productos: lista(j.productos), datosFaltantes: lista(j.datosFaltantes), proximoPaso: String(j.proximoPaso || '').slice(0, 400), respuestaSugerida: String(j.respuestaSugerida || '').slice(0, 1500),
    seguimientoDias: Number.isInteger(j.seguimientoDias) && j.seguimientoDias >= 0 && j.seguimientoDias <= 60 ? j.seguimientoDias : null, alertas: lista(j.alertas),
    consultas: (r.pasos || []).map(p => p.herramienta), modelo: r.modelo, costoUsd: r.costoUsd
  };
}

// Programa el seguimiento en la oportunidad del CRM (la crea, sin vendedor, si todavía no hay una activa). Devuelve { numero, fecha, creada }.
async function programarSeguimiento(db, conv, { dias, nota, resumen, usuarioNombre }) {
  dias = Math.min(Math.max(parseInt(dias, 10) || 0, 0), 60);
  const leads = db.collection('leads_whatsapp');
  const lead = await leads.findOne({ orgId: conv.orgId, tel10: conv.tel10 });
  if (!lead) throw Object.assign(new Error('Esta conversación todavía no tiene un lead asociado.'), { status: 409 });
  const fecha = new Date(hoyAR().getTime() + dias * 86400000);
  const proximaAccion = { fecha, tipo: 'recontactar', nota: String(nota || 'Seguimiento de la conversación de WhatsApp').slice(0, 300) };
  let op = lead.oportunidadId ? await db.collection('oportunidades').findOne({ _id: lead.oportunidadId }) : null;
  let creada = false;
  if (op && op.estado === 'activa') {
    await db.collection('oportunidades').updateOne({ _id: op._id }, { $set: { proximaAccion, updatedAt: new Date() } });
  } else {
    op = await require('./crm').insertarOportunidad(db, {
      orgId: conv.orgId, cliente: { nombre: lead.nombre || conv.nombre || ('+' + conv.tel), telefono: conv.tel, email: lead.email || '', direccion: '', localidad: '' },
      origen: 'WhatsApp · asistente' + (lead.campana ? ' · ' + lead.campana : ''), vendedorId: null, vendedorNombre: '', notas: [resumen || conv.resumen || '', usuarioNombre ? 'Seguimiento programado por ' + usuarioNombre : ''].filter(Boolean).join('\n'), proximaAccion, leadId: lead._id
    });
    await leads.updateOne({ _id: lead._id }, { $set: { oportunidadId: op._id, estado: ['Nuevo', 'Contactado'].includes(lead.estado) ? 'Calificado' : lead.estado, updatedAt: new Date() } });
    creada = true;
  }
  return { numero: op.numero, fecha, creada };
}

module.exports = { analizar, programarSeguimiento, transcripcion, ESQUEMA };
