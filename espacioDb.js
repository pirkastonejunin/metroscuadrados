// Uso de espacio de la base (9/10/2026, pedido de Mato): Atlas gratis (M0) tiene 512 MB y, llena, deja de
// escribir. GET /api/espacio-db → { usadoMB, limiteMB, porcentaje, nivel: 'ok'|'atencion'|'critico' }.
// Solo rol Administrador. El límite se puede cambiar con la variable DB_LIMITE_MB (por ejemplo 5120 en un plan pago).
const express = require('express');
const { MongoClient } = require('mongodb');
const { authUsuario } = require('./usuarios');

const router = express.Router();
let mongoClient, cache = null;
async function getDb() {
  if (!mongoClient) { const c = new MongoClient(process.env.MONGODB_URI); await c.connect(); mongoClient = c; }
  return mongoClient.db('calculadora_m2');
}
router.get('/', authUsuario, async (req, res) => {
  try {
    if (!(req.usuario && req.usuario.rol && req.usuario.rol.protegido)) return res.status(403).json({ error: 'Solo Administrador' });
    if (cache && Date.now() - cache.t < 5 * 60 * 1000) return res.json(cache.d);
    const s = await (await getDb()).command({ dbStats: 1, scale: 1 });
    const usadoMB = Math.round(((s.dataSize || 0) + (s.indexSize || 0)) / 1048576 * 10) / 10;
    const limiteMB = Number(process.env.DB_LIMITE_MB) || 512;
    const porcentaje = Math.round(usadoMB / limiteMB * 1000) / 10;
    const d = { usadoMB, limiteMB, porcentaje, nivel: porcentaje >= 90 ? 'critico' : porcentaje >= 80 ? 'atencion' : 'ok' };
    cache = { t: Date.now(), d };
    res.json(d);
  } catch (e) { mongoClient = null; res.status(500).json({ error: e.message }); }
});
module.exports = router;
