// -----------------------------------------------------------------------
// API de CONVERSIONES de Meta para mensajes de WhatsApp (anuncios que llevan a WhatsApp).
// Le avisa a Meta qué chats que vinieron de un anuncio terminaron en consulta calificada, presupuesto o venta, para que optimice los anuncios.
// - Solo se manda para chats que entraron por un anuncio (tienen `ctwa_clid` en el referral). Los demás se ignoran.
// - Eventos: LeadSubmitted (el bot calificó al cliente), InitiateCheckout (presupuesto enviado), Purchase (venta ganada, con monto).
// - Un evento por chat y tipo (no se repite). Todo queda registrado en `capi_eventos`. Nunca rompe el flujo de quien lo llama.
// - Se activa a mano desde CRM → Bot de WhatsApp → Conexión. Token: META_CAPI_TOKEN (o WA_TOKEN si ya tiene permiso). Nada de claves en el código.
// -----------------------------------------------------------------------
const graph = () => process.env.WA_GRAPH_BASE || ('https://graph.facebook.com/' + (process.env.WA_GRAPH_VERSION || 'v23.0'));
const EVENTOS = ['LeadSubmitted', 'InitiateCheckout', 'Purchase'];
const token = () => process.env.META_CAPI_TOKEN || process.env.WA_TOKEN || '';
async function pedir(url, op) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try { return await fetch(url, Object.assign({}, op, { signal: c.signal })); } finally { clearTimeout(t); }
}
async function configDe(db) { return (await db.collection('bot_config').findOne({ _id: 'capi' })) || {}; }
async function wabaDe(db) {
  if (process.env.WA_WABA_ID) return String(process.env.WA_WABA_ID).replace(/\D/g, '');
  const c = await db.collection('bot_config').findOne({ _id: 'coexistencia' }); return String((c && c.wabaId) || '').replace(/\D/g, '');
}
// Crea (o recupera) el conjunto de datos de la cuenta de WhatsApp Business: es el "buzón" de Meta donde llegan los eventos.
async function crearDataset(db) {
  if (!token()) return { ok: false, error: 'Falta el token (META_CAPI_TOKEN o WA_TOKEN) en Render.' };
  const waba = await wabaDe(db); if (!waba) return { ok: false, error: 'No se conoce el ID de la cuenta de WhatsApp Business (WA_WABA_ID).' };
  const r = await pedir(graph() + '/' + waba + '/dataset', { method: 'POST', headers: { Authorization: 'Bearer ' + token() } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) return { ok: false, error: 'Meta respondió ' + r.status + ': ' + ((d.error && d.error.message) || 'sin detalle') };
  await db.collection('bot_config').updateOne({ _id: 'capi' }, { $set: { datasetId: String(d.id), wabaId: waba, creadoAt: new Date() } }, { upsert: true });
  return { ok: true, datasetId: String(d.id), wabaId: waba };
}
// Manda un evento. `conv` es la conversación; `extra` puede traer { valor, moneda }. Devuelve { ok, motivo } y nunca lanza.
async function enviar(db, conv, evento, extra) {
  try {
    if (!EVENTOS.includes(evento) || !conv) return { ok: false, motivo: 'evento inválido' };
    const clid = conv.referral && conv.referral.ctwa_clid; if (!clid) return { ok: false, motivo: 'no vino de un anuncio' };
    const cfg = await configDe(db); if (!cfg.activo || !cfg.datasetId) return { ok: false, motivo: 'desactivado' };
    const col = db.collection('capi_eventos');
    if (await col.findOne({ convId: conv._id, evento, ok: true })) return { ok: false, motivo: 'ya enviado' };
    const valor = Number(extra && extra.valor) || 0;
    if (evento === 'Purchase' && !(valor > 0)) { await col.insertOne({ orgId: conv.orgId, convId: conv._id, evento, ok: false, error: 'La venta no tiene monto (sin presupuesto): no se informó', at: new Date() }); return { ok: false, motivo: 'sin monto' }; }
    const waba = cfg.wabaId || await wabaDe(db);
    const ev = { event_name: evento, event_time: Math.floor(Date.now() / 1000), action_source: 'business_messaging', messaging_channel: 'whatsapp', user_data: { whatsapp_business_account_id: waba, ctwa_clid: clid } };
    if (evento === 'Purchase') ev.custom_data = { currency: (extra && extra.moneda) || 'ARS', value: valor };
    const body = { data: [ev] }; if (cfg.codigoPrueba) body.test_event_code = cfg.codigoPrueba;
    const r = await pedir(graph() + '/' + cfg.datasetId + '/events', { method: 'POST', headers: { Authorization: 'Bearer ' + token(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const ok = r.ok && !d.error;
    await col.insertOne({ orgId: conv.orgId, convId: conv._id, evento, ok, valor: valor || undefined, error: ok ? undefined : ('Meta respondió ' + r.status + ': ' + ((d.error && d.error.message) || '')), at: new Date() });
    return { ok };
  } catch (e) { try { await db.collection('capi_eventos').insertOne({ orgId: conv && conv.orgId, convId: conv && conv._id, evento, ok: false, error: e.message, at: new Date() }); } catch (_) { /* nada */ } return { ok: false, motivo: e.message }; }
}
module.exports = { enviar, crearDataset, configDe, wabaDe, EVENTOS };
