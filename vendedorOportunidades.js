// ---------------------------------------------------------------------------
// Fase 2 del vendedor digital (19/10/2026): cuando el bot deriva a un cliente interesado, se crea (una sola vez) la OPORTUNIDAD del CRM
// con lo que el bot averiguó, asignada a la sucursal (sin vendedor: el vendedor la toma desde el CRM), y, si el bot armó un borrador de
// presupuesto y el teléfono corresponde a un cliente ya cargado, se crea ese presupuesto en estado "presupuestado" para que lo revise un asesor.
// Reutiliza crm.insertarOportunidad y presupuestos.crearBorradorDesdeBot. Nunca toca ventas, stock ni cuentas.
// ---------------------------------------------------------------------------
const lineasBorrador = (b) => (b && b.items || []).map(i => '- ' + i.cantidad + ' ' + (i.unidad || 'u.') + ' · ' + i.nombre + (i.precioFinal != null ? ' · $' + Math.round(i.precioFinal * i.cantidad).toLocaleString('es-AR') : '')).join('\n');

function hoyAR() { const a = new Date(Date.now() - 3 * 3600 * 1000); return new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate(), 3)); }

// conv: documento de wa_conversaciones; datos: lo que devolvió el bot ({resumen, producto, medidas, estilo, etiquetas}).
async function oportunidadDeConversacion(db, conv, datos) {
  datos = datos || {};
  const leads = db.collection('leads_whatsapp');
  const lead = await leads.findOne({ orgId: conv.orgId, tel10: conv.tel10 });
  if (!lead) return null;
  const d = conv.datos || {};
  const producto = datos.producto || d.producto || '', medidas = datos.medidas || d.medidas || '', estilo = datos.estilo || d.estilo || '';
  if (!producto && !(conv.borrador && conv.borrador.items && conv.borrador.items.length)) return null; // todavía no hay un interés concreto
  const resumen = datos.resumen || conv.resumen || lead.resumen || '';
  const notas = ['🤖 Derivado por el bot de WhatsApp', resumen, producto ? 'Producto: ' + producto : '', medidas ? 'Medidas: ' + medidas : '', estilo ? 'Estilo: ' + estilo : '',
    conv.borrador ? 'Lo que se le armó en el chat:\n' + lineasBorrador(conv.borrador) + (conv.borrador.totalFinal != null ? '\nTotal estimado con IVA: $' + Math.round(conv.borrador.totalFinal).toLocaleString('es-AR') : '') : ''].filter(Boolean).join('\n');
  let op = lead.oportunidadId ? await db.collection('oportunidades').findOne({ _id: lead.oportunidadId }) : null;
  let creada = false;
  if (!op || op.estado !== 'activa') {
    const crm = require('./crm');
    op = await crm.insertarOportunidad(db, {
      orgId: conv.orgId, cliente: { nombre: lead.nombre || conv.nombre || ('+' + conv.tel), telefono: conv.tel, email: lead.email || '', direccion: '', localidad: '' },
      origen: 'WhatsApp · bot' + (lead.campana ? ' · ' + lead.campana : ''), vendedorId: null, vendedorNombre: '', notas,
      proximaAccion: { fecha: hoyAR(), tipo: 'recontactar', nota: 'Contactar: lo derivó el bot de WhatsApp' }, leadId: lead._id
    });
    await leads.updateOne({ _id: lead._id }, { $set: { oportunidadId: op._id, estado: ['Nuevo', 'Contactado'].includes(lead.estado) ? 'Calificado' : lead.estado, updatedAt: new Date() } });
    creada = true;
  } else if (op.notas !== notas && (op.origen || '').startsWith('WhatsApp · bot')) {
    await db.collection('oportunidades').updateOne({ _id: op._id }, { $set: { notas, updatedAt: new Date() } }); // se actualiza solo si la creó el bot
  }
  // borrador de presupuesto: solo si hay cliente cargado con ese teléfono y todavía no se hizo uno para esta conversación
  let presupuesto = null;
  const b = conv.borrador;
  if (b && b.presupuestoId && b.cambiado) { // el cliente cambió el pedido después de generado el borrador
    try {
      const actualizado = await require('./presupuestos').actualizarBorradorDesdeBot(db, b.presupuestoId, b.items.map(i => ({ productoId: i.productoId, cantidad: i.cantidad })));
      await db.collection('wa_conversaciones').updateOne({ _id: conv._id }, { $unset: { 'borrador.cambiado': '' } });
      if (!actualizado) await db.collection('oportunidades').updateOne({ _id: op._id }, { $set: { updatedAt: new Date() }, $push: { cambiosBot: { fecha: new Date(), texto: 'El cliente cambió el pedido en el chat (el presupuesto #' + b.presupuestoNumero + ' ya estaba en manos de un asesor, no se modificó):\n' + lineasBorrador(b) } } });
    } catch (e) { console.error('[bot] actualizar borrador:', e.message); }
  } else if (b && b.items && b.items.length && !b.presupuestoId && lead.clienteId) {
    try {
      presupuesto = await require('./presupuestos').crearBorradorDesdeBot(db, {
        orgId: conv.orgId, clienteId: lead.clienteId, items: b.items.map(i => ({ productoId: i.productoId, cantidad: i.cantidad })),
        observaciones: 'Borrador armado por el bot de WhatsApp (oportunidad #' + op.numero + '). Revisar productos, cantidades, precios y disponibilidad antes de enviarlo.', convId: conv._id
      });
      await db.collection('wa_conversaciones').updateOne({ _id: conv._id }, { $set: { 'borrador.presupuestoId': presupuesto._id, 'borrador.presupuestoNumero': presupuesto.numero } });
      await db.collection('oportunidades').updateOne({ _id: op._id }, { $set: { presupuestoId: presupuesto._id, presupuestoNumero: presupuesto.numero, notas: notas + '\n📄 Borrador de presupuesto #' + presupuesto.numero + ' creado: revisarlo en Presupuestos.', updatedAt: new Date() } });
    } catch (e) { console.error('[bot] borrador de presupuesto:', e.message); }
  }
  return { oportunidadId: op._id, numero: op.numero, creada, presupuestoNumero: presupuesto ? presupuesto.numero : (b && b.presupuestoNumero) || null };
}

module.exports = { oportunidadDeConversacion, lineasBorrador, hoyAR };
