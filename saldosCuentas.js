// ---------------------------------------------------------------------------
// Saldos de cuentas corrientes (11/10/2026): lo que los clientes le deben a la empresa y lo que la empresa les debe a los proveedores,
// tomado del SALDO DE LA CUENTA CORRIENTE (saldo inicial importado de Dux + lo que se opera en el sistema), no de sumar el pendiente de
// cada comprobante (que en el historial importado de Dux no coincide: cobros a cuenta, notas de crédito y ajustes no se reflejan ahí).
// Para la antigüedad, el saldo de cada cuenta se reparte entre sus comprobantes empezando por los más nuevos (lo más viejo se da por
// pagado primero); lo que no alcanza a cubrir un comprobante queda como "Saldo anterior".
// Se usa solo si ya se cargaron los saldos de Dux de esa sucursal; si no, los informes siguen con el criterio anterior.
// ---------------------------------------------------------------------------
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function usaSaldosClientes(db, orgMatch) { return !!(await db.collection('cuenta_corriente_movimientos').findOne(Object.assign({ origen: 'saldo_inicial_dux' }, orgMatch), { projection: { _id: 1 } })); }
async function usaSaldosProveedores(db, orgMatch) { return !!(await db.collection('proveedores_saldos_iniciales').findOne(orgMatch, { projection: { _id: 1 } })); }

// [{ clienteId, nombre, saldo }] con saldo > 0 (el cliente debe)
async function saldosClientes(db, orgMatch) {
  const clientes = await db.collection('clientes').find(orgMatch).project({ apellidoRazonSocial: 1, nombre: 1 }).toArray();
  const nombre = new Map(clientes.map(c => [String(c._id), [c.apellidoRazonSocial, c.nombre].filter(Boolean).join(', ')]));
  const saldos = await db.collection('cuenta_corriente_saldos').find({ clienteId: { $in: clientes.map(c => c._id) }, saldo: { $gt: 0.005 } }).toArray();
  return saldos.map(s => ({ clienteId: s.clienteId, nombre: nombre.get(String(s.clienteId)) || '(sin nombre)', saldo: round2(s.saldo) }));
}

// [{ proveedorId, nombre, saldo }] con saldo > 0 (se le debe): saldo inicial + compras y gastos cargados en el sistema − pagos del sistema
async function saldosProveedores(db, orgMatch) {
  const usd = { $cond: [{ $eq: ['$moneda', 'USD'] }, { $ifNull: ['$cotizacionDolar', 1] }, 1] };
  const signo = { $cond: [{ $regexMatch: { input: { $ifNull: ['$tipoComprobante', ''] }, regex: '^nota_credito' } }, -1, 1] };
  const nativo = Object.assign({ importado: { $ne: true }, estado: { $ne: 'anulada' }, proveedorId: { $ne: null } }, orgMatch);
  const [ini, comp, gas, pag] = await Promise.all([
    db.collection('proveedores_saldos_iniciales').find(orgMatch).project({ proveedorId: 1, monto: 1, proveedorNombre: 1 }).toArray(),
    db.collection('compras').aggregate([{ $match: nativo }, { $group: { _id: '$proveedorId', t: { $sum: { $multiply: [{ $ifNull: ['$total', 0] }, signo, usd] } } } }]).toArray(),
    db.collection('gastos').aggregate([{ $match: nativo }, { $group: { _id: '$proveedorId', t: { $sum: { $subtract: [{ $multiply: [{ $ifNull: ['$total', 0] }, signo, usd] }, { $sum: '$pagos.monto' }] } } } }]).toArray(),
    db.collection('compras_pagos').aggregate([{ $match: Object.assign({ importado: { $ne: true }, proveedorId: { $ne: null } }, orgMatch) }, { $group: { _id: '$proveedorId', t: { $sum: { $ifNull: ['$monto', 0] } } } }]).toArray()
  ]);
  const m = new Map(); const sumar = (id, v) => m.set(String(id), (m.get(String(id)) || 0) + v);
  ini.forEach(i => sumar(i.proveedorId, i.monto || 0)); comp.forEach(c => sumar(c._id, c.t)); gas.forEach(g => sumar(g._id, g.t)); pag.forEach(p => sumar(p._id, -p.t));
  const { ObjectId } = require('mongodb'); const ids = [...m.keys()].filter(k => m.get(k) > 0.005);
  const provs = ids.length ? await db.collection('proveedores').find({ _id: { $in: ids.map(i => new ObjectId(i)) } }).project({ razonSocial: 1 }).toArray() : [];
  const nombre = new Map(provs.map(p => [String(p._id), p.razonSocial]));
  return ids.map(k => ({ proveedorId: new ObjectId(k), nombre: nombre.get(k) || (ini.find(i => String(i.proveedorId) === k) || {}).proveedorNombre || '(sin nombre)', saldo: round2(m.get(k)) }));
}

// Reparte `saldo` entre comprobantes [{ fecha, cap, ...datos }] (ya ordenados del más nuevo al más viejo).
// Devuelve [{ ...datos, saldo }] (solo con saldo > 0) y, si sobra, un renglón "Saldo anterior" que cuenta como el más antiguo.
function repartir(saldo, comprobantes, anterior) {
  let resto = saldo; const out = [];
  for (const c of comprobantes) { if (resto <= 0.005) break; const x = Math.min(resto, Math.max(0, c.cap)); if (x <= 0.005) continue; out.push(Object.assign({}, c, { saldo: round2(x) })); resto -= x; }
  if (resto > 0.005) out.push(Object.assign({}, anterior, { saldo: round2(resto), diasFijos: 99999, fechaS: '', comprobante: 'Saldo anterior (sin comprobante)' }));
  return out;
}
module.exports = { usaSaldosClientes, usaSaldosProveedores, saldosClientes, saldosProveedores, repartir };
