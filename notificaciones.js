// ---------------------------------------------------------------------------
// Notificaciones — campanita de vencimientos en los paneles de Oficina.
//
// No tiene colección propia de "notificaciones": cada alerta se calcula al
// vuelo a partir de datos que ya existen en otras colecciones (oportunidades
// del CRM, visitas, tareas de obra). Así nunca se desincroniza de la
// realidad ni hay que mantener un estado aparte — si se resuelve el
// vencimiento (se descarta la oportunidad, se carga la visita, se marca la
// tarea terminada), la alerta desaparece sola en la próxima consulta.
//
// Vencimientos que reporta, uno por cada colección que ya tenía la noción de
// "fecha" o "vencido":
//   - CRM: oportunidades activas cuya próxima acción (ver crm.js) ya venció.
//   - Visitas: visitas agendadas cuya fecha/hora ya pasó y siguen en estado
//     'sin_visita' (nunca se les cargó nada — vendedor no fue o no cargó).
//   - Obras: tareas de una obra no cancelada/terminada, con fecha fin
//     estimada vencida y la tarea todavía no está 'terminada'.
//
// Cada tipo se puede prender/apagar globalmente (para todos los usuarios)
// desde una configuración simple — colección 'configuracion', un solo
// documento _id:'notificaciones'. Es, a propósito, el primer rincón de lo
// que Mato planteó como un futuro menú de Configuración más grande
// (activar/desactivar calendarios, accesos, etc. — ver roadmap-modulos.md
// en el proyecto de Cowork). Vive en el panel de Usuarios y roles porque ya
// es el lugar donde se administran accesos.
//
// Las alertas que ve cada usuario se filtran, además, por los módulos que
// realmente tiene habilitados: no tiene sentido mostrarle a alguien sin
// acceso a Obras un vencimiento de una tarea de obra.
//
// Endpoints:
//   GET  /api/notificaciones         -> { items: [...], config }
//   GET  /api/notificaciones/config  -> config actual (para pintar los
//                                        checkboxes en Usuarios y roles)
//   PUT  /api/notificaciones/config  -> cambia la config — requiere el
//                                        módulo 'usuarios' (no se suma un
//                                        módulo nuevo para esto)
//
// Integración (en server.js):
//   const notificacionesRouter = require('./notificaciones');
//   app.use('/api/notificaciones', notificacionesRouter);
// ---------------------------------------------------------------------------

const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario, tieneModulo, resolverOrg, filtroOrg } = require('./usuarios');

const router = express.Router();
const DB_NAME = 'calculadora_m2';

let mongoClient;
let mongoConectando = null;
async function getDb() {
  if (!mongoClient) {
    // Carrera de conexión (4/10/2026, ver compras.js): se guarda la
    // conexión EN CURSO para que los requests simultáneos de un proceso
    // recién arrancado esperen la misma, en vez de usar un cliente que
    // todavía no terminó de conectar.
    if (!mongoConectando) {
      const nuevoCliente = new MongoClient(process.env.MONGODB_URI);
      mongoConectando = nuevoCliente.connect().then(
        () => { mongoClient = nuevoCliente; mongoConectando = null; },
        (e) => { mongoConectando = null; throw e; }
      );
    }
    await mongoConectando;
  }
  return mongoClient.db(DB_NAME);
}

async function conReintento(fn) {
  try {
    return await fn();
  } catch (e) {
    try { if (mongoClient) await mongoClient.close(); } catch (_) {}
    mongoClient = null;
    return await fn();
  }
}

const CONFIG_ID_GLOBAL = 'notificaciones';
// Catálogo de alertas (4/10/2026, pedido de Mato: "agregame para habilitar y
// deshabilitar todas aquellas que creas conveniente, ejemplo vencimiento de
// cheques, recordatorios, etc."). Cada tipo tiene su interruptor por
// organización en Usuarios y roles → Notificaciones. `modulo` es el acceso
// que necesita el usuario para verla (null = cualquiera con acceso al panel).
// Los que "molestan" más (muchos avisos) arrancan apagados.
const CATALOGO = [
  { key: 'crm', grupo: 'Comercial', label: 'CRM — próximas acciones vencidas', default: true, modulo: 'visitas' },
  { key: 'visitas', grupo: 'Comercial', label: 'Visitas sin confirmar', default: true, modulo: 'visitas' },
  { key: 'obras', grupo: 'Obras', label: 'Obras — tareas atrasadas', default: true, modulo: 'obras' },
  { key: 'chequesVencidos', grupo: 'Tesorería', label: 'Cheques vencidos (de terceros sin depositar / propios sin pagar)', default: true, modulo: 'tesoreria' },
  { key: 'chequesPorVencer', grupo: 'Tesorería', label: 'Cheques por vencer en los próximos 3 días', default: true, modulo: 'tesoreria' },
  { key: 'cajaSinCerrar', grupo: 'Tesorería', label: 'Caja con movimientos de días anteriores sin cierre', default: true, modulo: 'tesoreria' },
  { key: 'ordenesSinRecibir', grupo: 'Compras', label: 'Órdenes de compra sin recibir hace más de 7 días', default: true, modulo: 'compras' },
  { key: 'comprasPorPagar', grupo: 'Compras', label: 'Compras con saldo a pagar hace más de 30 días', default: false, modulo: 'compras' },
  { key: 'ventasSinEntregar', grupo: 'Ventas', label: 'Ventas con mercadería sin entregar hace más de 3 días', default: true, modulo: 'ventas' },
  { key: 'cobrosPendientes', grupo: 'Ventas', label: 'Ventas con saldo sin cobrar hace más de 30 días', default: false, modulo: 'ventas' },
  { key: 'stockBajoMinimo', grupo: 'Stock', label: 'Productos con stock por debajo del mínimo', default: false, modulo: 'stock' }
];
const CONFIG_DEFAULT = {};
CATALOGO.forEach(t => { CONFIG_DEFAULT[t.key] = t.default; });

// La configuración pasa a ser por organización (24/9/2026, multi-tenant) —
// cada franquicia prende/apaga sus propios tipos de alerta sin afectar a
// las demás. orgId null (un protegido viendo "todas") usa el default fijo,
// sin pararse en la config de ninguna franquicia puntual.
function configId(orgId) { return orgId ? `${CONFIG_ID_GLOBAL}:${orgId}` : CONFIG_ID_GLOBAL; }

async function leerConfig(orgId) {
  return conReintento(async () => {
    const db = await getDb();
    const doc = (await db.collection('configuracion').findOne({ _id: configId(orgId) })) || {};
    const cfg = {};
    CATALOGO.forEach(t => { cfg[t.key] = doc[t.key] !== undefined ? !!doc[t.key] : t.default; });
    return cfg;
  });
}

// Argentina no tiene horario de verano: offset fijo -03:00. Mismo criterio
// ya usado en visitas.js (parsearFechaHoraLocal) y crm.js
// (normalizarProximaAccion) para no correrse un día con fechas "solo día" —
// acá se usa para decidir "hoy a la medianoche en Argentina", el corte que
// separa "vence hoy" de "ya venció".
function inicioDeHoyArgentina() {
  const ahoraAR = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(ahoraAR.getUTCFullYear(), ahoraAR.getUTCMonth(), ahoraAR.getUTCDate(), 3, 0, 0, 0));
}

const TIPOS_PROXIMA_ACCION = { rellamar: 'Rellamar', recontactar: 'Recontactar', enviar_info: 'Enviar información', otro: 'Otro' };

// Preferencias personales (4/10/2026, pedido de Mato: "ponelo con un permiso
// aparte para que cada usuario pueda modificarlo"). Cada usuario con el permiso
// 'notificaciones' puede apagar, solo para él, alertas que la organización
// tiene prendidas. No puede prender una que la organización apagó.
function prefId(usuarioId) { return `notifUsuario:${usuarioId}`; }
async function leerApagadasUsuario(db, usuarioId) {
  const doc = await db.collection('configuracion').findOne({ _id: prefId(usuarioId) });
  return (doc && Array.isArray(doc.apagadas)) ? doc.apagadas.filter(k => CATALOGO.some(t => t.key === k)) : [];
}

const MS_DIA = 24 * 60 * 60 * 1000;
const nombreCliente = (v) => v.clienteNombre || (v.cliente && v.cliente.nombre) || 'Cliente';
const fmtMonto = (n, m) => (m === 'USD' ? 'US$ ' : '$ ') + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
// Mismo criterio de "día" que la planilla de caja diaria (ver tesoreria.js).
function diaDeMovimientoAR(f) {
  const d = new Date(f);
  const soloFecha = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  return soloFecha ? d.toISOString().slice(0, 10) : new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

router.get('/', authUsuario, resolverOrg, async (req, res) => {
  try {
    const config = await leerConfig(req.orgId);
    const hoyAR = inicioDeHoyArgentina();
    const ahora = new Date();
    const items = [];

    await conReintento(async () => {
      const db = await getDb();
      const apagadas = await leerApagadasUsuario(db, req.usuario._id);
      // Activa = prendida en la organización + el usuario tiene el módulo + no la apagó él.
      const activa = (key) => {
        const t = CATALOGO.find(x => x.key === key);
        return config[key] && !apagadas.includes(key) && (!t.modulo || tieneModulo(req.usuario, t.modulo));
      };

      if (activa('crm')) {
        const oportunidades = await db.collection('oportunidades')
          .find(Object.assign({ estado: 'activa', 'proximaAccion.fecha': { $ne: null, $lt: hoyAR } }, filtroOrg(req)))
          .sort({ 'proximaAccion.fecha': 1 }).limit(50).toArray();
        for (const o of oportunidades) {
          items.push({
            tipo: 'crm', id: String(o._id),
            titulo: (o.cliente && o.cliente.nombre) || 'Oportunidad sin nombre',
            subtitulo: (TIPOS_PROXIMA_ACCION[o.proximaAccion.tipo] || 'Próxima acción') + (o.proximaAccion.nota ? ' — ' + o.proximaAccion.nota : ''),
            fecha: o.proximaAccion.fecha
          });
        }
      }

      if (activa('visitas')) {
        const visitas = await db.collection('visitas')
          .find(Object.assign({ estado: 'sin_visita', fechaHora: { $lt: ahora } }, filtroOrg(req)))
          .sort({ fechaHora: 1 }).limit(50).toArray();
        for (const v of visitas) {
          items.push({
            tipo: 'visita', id: String(v._id),
            titulo: (v.cliente && v.cliente.nombre) || 'Visita sin nombre',
            subtitulo: 'Visita sin confirmar' + (v.vendedorNombre ? ' — ' + v.vendedorNombre : ''),
            fecha: v.fechaHora
          });
        }
      }

      if (activa('obras')) {
        const obras = await db.collection('obras')
          .find(Object.assign({
            estado: { $nin: ['terminada', 'cancelada'] },
            tareas: { $elemMatch: { estado: { $ne: 'terminada' }, fechaFinEstimada: { $ne: null, $lt: hoyAR } } }
          }, filtroOrg(req)))
          .limit(50).toArray();
        for (const o of obras) {
          for (const t of (o.tareas || [])) {
            if (t.estado !== 'terminada' && t.fechaFinEstimada && t.fechaFinEstimada < hoyAR) {
              items.push({
                tipo: 'obra', id: String(o._id),
                titulo: `Obra #${o.numero} — ${(o.cliente && o.cliente.nombre) || ''}`,
                subtitulo: `${t.tipoTrabajo} — fin estimado vencido`,
                fecha: t.fechaFinEstimada
              });
            }
          }
        }
      }

      // ---- Tesorería: cheques ----
      const quiereVencidos = activa('chequesVencidos');
      const quierePorVencer = activa('chequesPorVencer');
      if (quiereVencidos || quierePorVencer) {
        const hasta = new Date(hoyAR.getTime() + 3 * MS_DIA);
        const cheques = await db.collection('cheques')
          .find(Object.assign({ estado: { $in: ['en_cartera', 'emitido'] }, fechaVencimiento: { $ne: null, $lt: hasta } }, filtroOrg(req)))
          .sort({ fechaVencimiento: 1 }).limit(100).toArray();
        for (const c of cheques) {
          const vencido = new Date(c.fechaVencimiento) < hoyAR;
          if (vencido && !quiereVencidos) continue;
          if (!vencido && !quierePorVencer) continue;
          const propio = c.tipo === 'propio';
          items.push({
            tipo: vencido ? 'cheque_vencido' : 'cheque_por_vencer', id: String(c._id),
            titulo: `Cheque ${propio ? 'propio' : 'de tercero'} ${c.numero || ''} — ${fmtMonto(c.monto, c.moneda)}`.trim(),
            subtitulo: (vencido ? (propio ? 'Vencido, todavía figura emitido (sin confirmar el pago)' : 'Vencido, todavía en cartera (sin depositar ni cobrar)') : (propio ? 'Por vencer — hay que tener fondos en el banco' : 'Por vencer — para depositar o cobrar'))
              + (propio ? (c.proveedorNombre ? ' — ' + c.proveedorNombre : '') : (c.clienteNombre ? ' — ' + c.clienteNombre : '')),
            fecha: c.fechaVencimiento, etiquetaFecha: vencido ? 'Venció el' : 'Vence el'
          });
        }
      }

      // ---- Tesorería: cajas con días sin cerrar (últimos 7) ----
      if (activa('cajaSinCerrar')) {
        const { cuentaHabilitada } = require('./tesoreria');
        const cajas = (await db.collection('tesoreria_cajas').find({}).toArray()).filter(c => cuentaHabilitada(c, req));
        if (cajas.length) {
          const ids = cajas.map(c => c._id);
          const desde = new Date(Date.now() - 9 * MS_DIA);
          const movs = await db.collection('tesoreria_movimientos').find({ cuentaTipo: 'caja', cuentaId: { $in: ids }, fecha: { $gte: desde } }, { projection: { cuentaId: 1, fecha: 1 } }).toArray();
          const hoyDia = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
          const limiteDia = new Date(Date.now() - 3 * 3600000 - 7 * MS_DIA).toISOString().slice(0, 10);
          const pendientes = new Map(); // "cuentaId|dia"
          movs.forEach(m => { const d = diaDeMovimientoAR(m.fecha); if (d < hoyDia && d >= limiteDia) pendientes.set(String(m.cuentaId) + '|' + d, { cuentaId: m.cuentaId, dia: d }); });
          if (pendientes.size) {
            const cierres = await db.collection('tesoreria_cierres').find({ cuentaId: { $in: ids }, dia: { $gte: limiteDia } }, { projection: { cuentaId: 1, dia: 1 } }).toArray();
            cierres.forEach(c => pendientes.delete(String(c.cuentaId) + '|' + c.dia));
            const nombre = new Map(cajas.map(c => [String(c._id), c.nombre]));
            Array.from(pendientes.values()).sort((a, b) => a.dia.localeCompare(b.dia)).forEach(p => {
              items.push({
                tipo: 'caja_sin_cerrar', id: p.dia + '|' + p.cuentaId,
                titulo: `Caja «${nombre.get(String(p.cuentaId)) || ''}» sin cerrar`,
                subtitulo: `Tuvo movimientos el ${p.dia.split('-').reverse().join('/')} y no se cargó el cierre`,
                fecha: new Date(p.dia + 'T12:00:00Z'), etiquetaFecha: 'Día'
              });
            });
          }
        }
      }

      // ---- Compras ----
      if (activa('ordenesSinRecibir')) {
        const limite = new Date(Date.now() - 7 * MS_DIA);
        const ordenes = await db.collection('ordenes_compra')
          .find(Object.assign({ estado: { $ne: 'anulada' }, estadoRecepcion: { $in: ['pendiente', 'parcial', null] }, createdAt: { $lt: limite } }, filtroOrg(req)))
          .sort({ createdAt: 1 }).limit(50).toArray();
        for (const o of ordenes) {
          items.push({
            tipo: 'orden_compra', id: String(o._id),
            titulo: `Orden de compra #${o.numero}${o.proveedorNombre ? ' — ' + o.proveedorNombre : ''}`,
            subtitulo: o.estadoRecepcion === 'parcial' ? 'Recibida parcialmente, falta mercadería' : 'Todavía sin recibir la mercadería',
            fecha: o.createdAt, etiquetaFecha: 'Desde el'
          });
        }
      }
      if (activa('comprasPorPagar')) {
        const limite = new Date(Date.now() - 30 * MS_DIA);
        const compras = await db.collection('compras')
          .find(Object.assign({ estado: { $ne: 'anulada' }, saldoPendiente: { $gt: 0 }, createdAt: { $lt: limite } }, filtroOrg(req)))
          .sort({ createdAt: 1 }).limit(50).toArray();
        for (const c of compras) {
          items.push({
            tipo: 'compra_por_pagar', id: String(c._id),
            titulo: `Compra #${c.numero}${c.proveedorNombre ? ' — ' + c.proveedorNombre : ''}`,
            subtitulo: `Saldo a pagar ${fmtMonto(c.saldoPendiente, c.moneda)}`,
            fecha: c.createdAt, etiquetaFecha: 'Desde el'
          });
        }
      }

      // ---- Ventas ----
      if (activa('ventasSinEntregar')) {
        const limite = new Date(Date.now() - 3 * MS_DIA);
        const ventas = await db.collection('ventas')
          .find(Object.assign({ estado: { $in: ['pendiente', 'parcialmente_entregada'] }, createdAt: { $lt: limite } }, filtroOrg(req)))
          .sort({ createdAt: 1 }).limit(50).toArray();
        for (const v of ventas) {
          items.push({
            tipo: 'venta_sin_entregar', id: String(v._id),
            titulo: `Venta Nº ${v.numero} — ${nombreCliente(v)}`,
            subtitulo: v.estado === 'parcialmente_entregada' ? 'Entregada parcialmente, falta mercadería' : 'Mercadería sin entregar (sin remito)',
            fecha: v.createdAt, etiquetaFecha: 'Desde el'
          });
        }
      }
      if (activa('cobrosPendientes')) {
        const limite = new Date(Date.now() - 30 * MS_DIA);
        const ventas = await db.collection('ventas')
          .find(Object.assign({ estado: { $ne: 'anulada' }, saldoPendiente: { $gt: 0 }, createdAt: { $lt: limite } }, filtroOrg(req)))
          .sort({ createdAt: 1 }).limit(50).toArray();
        for (const v of ventas) {
          items.push({
            tipo: 'venta_sin_cobrar', id: String(v._id),
            titulo: `Venta Nº ${v.numero} — ${nombreCliente(v)}`,
            subtitulo: `Saldo sin cobrar ${fmtMonto(v.saldoPendiente, v.moneda)}`,
            fecha: v.createdAt, etiquetaFecha: 'Desde el'
          });
        }
      }

      // ---- Stock bajo mínimo (productos con cantidadMinima cargada) ----
      if (activa('stockBajoMinimo')) {
        const productos = await db.collection('productos_catalogo')
          .find(Object.assign({ activo: { $ne: false }, cantidadMinima: { $gt: 0 } }, filtroOrg(req)), { projection: { sku: 1, nombre: 1, cantidadMinima: 1, unidad: 1 } })
          .limit(1000).toArray();
        if (productos.length) {
          const existencias = await db.collection('stock_actual')
            .find({ productoId: { $in: productos.map(p => p._id) }, depositoId: { $ne: null } }, { projection: { productoId: 1, cantidad: 1 } }).toArray();
          const total = new Map();
          existencias.forEach(e => total.set(String(e.productoId), (total.get(String(e.productoId)) || 0) + (e.cantidad || 0)));
          productos.filter(p => (total.get(String(p._id)) || 0) < p.cantidadMinima).slice(0, 30).forEach(p => {
            items.push({
              tipo: 'stock_bajo', id: String(p._id),
              titulo: `${p.sku ? p.sku + ' — ' : ''}${p.nombre}`,
              subtitulo: `Stock ${Math.round((total.get(String(p._id)) || 0) * 100) / 100} ${p.unidad || ''} — mínimo ${p.cantidadMinima}`,
              fecha: ahora, etiquetaFecha: 'Hoy'
            });
          });
        }
      }
    });

    items.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    res.json({ items, config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/config', authUsuario, resolverOrg, async (req, res) => {
  try { res.json(await leerConfig(req.orgId)); } catch (e) { res.status(500).json({ error: e.message }); }
});

// Catálogo completo + estado de la organización + preferencias propias.
router.get('/catalogo', authUsuario, resolverOrg, async (req, res) => {
  try {
    const config = await leerConfig(req.orgId);
    const apagadas = await conReintento(async () => leerApagadasUsuario(await getDb(), req.usuario._id));
    res.json({
      catalogo: CATALOGO.map(t => ({ key: t.key, grupo: t.grupo, label: t.label, modulo: t.modulo, disponibleParaMi: !t.modulo || tieneModulo(req.usuario, t.modulo) })),
      config, apagadas,
      puedeEditarMias: tieneModulo(req.usuario, 'notificaciones'),
      puedeEditarOrganizacion: tieneModulo(req.usuario, 'usuarios')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Preferencias propias — requiere el permiso 'notificaciones' (aparte de Configuración).
router.put('/mias', authUsuario, resolverOrg, async (req, res) => {
  try {
    if (!tieneModulo(req.usuario, 'notificaciones')) {
      return res.status(403).json({ error: 'Tu usuario no tiene el permiso de Notificaciones. Pedile a un administrador que te lo habilite.' });
    }
    const pedidas = Array.isArray(req.body && req.body.apagadas) ? req.body.apagadas : [];
    const apagadas = Array.from(new Set(pedidas.filter(k => CATALOGO.some(t => t.key === k))));
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('configuracion').updateOne({ _id: prefId(req.usuario._id) }, { $set: { apagadas, updatedAt: new Date() } }, { upsert: true });
    });
    res.json({ apagadas });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put('/config', authUsuario, resolverOrg, async (req, res) => {
  try {
    if (!tieneModulo(req.usuario, 'usuarios')) {
      return res.status(403).json({ error: 'Tu usuario no tiene acceso a Usuarios y roles, que es donde vive esta configuración.' });
    }
    if (!req.orgId) return res.status(400).json({ error: 'Elegí con qué organización estás trabajando para cambiar su configuración.' });
    const set = {};
    CATALOGO.forEach(t => { if (req.body && req.body[t.key] !== undefined) set[t.key] = !!req.body[t.key]; });
    await conReintento(async () => {
      const db = await getDb();
      await db.collection('configuracion').updateOne({ _id: configId(req.orgId) }, { $set: set }, { upsert: true });
    });
    res.json(await leerConfig(req.orgId));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
