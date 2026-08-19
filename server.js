require('dotenv').config();
const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_BASE = 'https://api.tiendanube.com/v1';
const NAMESPACE = process.env.METAFIELD_NAMESPACE || 'calculadora_m2';
const KEY_COBERTURA = 'cobertura_m2_caja';

let mongoClient;
async function getConfigCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (err) {
      mongoClient = null; // permite reintentar en la proxima llamada
      throw err;
    }
  }
  try {
    return mongoClient.db('calculadora_m2').collection('config');
  } catch (err) {
    mongoClient = null;
    throw err;
  }
}

async function readDb() {
  try {
    const col = await getConfigCollection();
    const doc = await col.findOne({ _id: 'main' });
    return doc || {};
  } catch (err) {
    mongoClient = null; // fuerza reconexion
    const col = await getConfigCollection();
    const doc = await col.findOne({ _id: 'main' });
    return doc || {};
  }
}
async function writeDb(data) {
  try {
    const col = await getConfigCollection();
    await col.updateOne({ _id: 'main' }, { $set: data }, { upsert: true });
  } catch (err) {
    mongoClient = null; // fuerza reconexion
    const col = await getConfigCollection();
    await col.updateOne({ _id: 'main' }, { $set: data }, { upsert: true });
  }
}

function apiHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': process.env.USER_AGENT
  };
}

async function getStoreCreds() {
  const db = await readDb();
  if (!db.store_id || !db.access_token) {
    throw new Error('La tienda todavia no instalo la app. Visita /install primero.');
  }
  return db;
}

// PASO 1: instalar la app -> redirige a Tiendanube para aceptar permisos
app.get('/install', (req, res) => {
  const url = 'https://www.tiendanube.com/apps/' + process.env.CLIENT_ID + '/authorize';
  res.redirect(url);
});

// PASO 2: Tiendanube redirige aca con ?code=... -> lo canjeamos por un access_token
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Falta el parametro code.');

  try {
    const response = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code
      })
    });
    const data = await response.json();
    if (!data.access_token) {
      return res.status(400).json({ error: 'No se pudo obtener el token', detail: data });
    }

    await writeDb({ store_id: data.user_id, access_token: data.access_token });

    // Activa el script en esta tienda (necesario porque "Instalación
    // automática" no está disponible para esta app).
    if (process.env.SCRIPT_ID) {
      try {
        await fetch(API_BASE + '/' + data.user_id + '/scripts', {
          method: 'POST',
          headers: apiHeaders(data.access_token),
          body: JSON.stringify({
            script_id: parseInt(process.env.SCRIPT_ID, 10),
            query_params: '{}'
          })
        });
      } catch (e) {
        console.error('No se pudo activar el script automaticamente:', e.message);
      }
    }

    res.redirect('/admin.html?instalado=1');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Por si la tienda ya se instalo antes de tener SCRIPT_ID configurado:
// activa el script a mano, sin reinstalar la app.
app.get('/admin/activar-script', async (req, res) => {
  try {
    const { store_id, access_token } = await getStoreCreds();
    if (!process.env.SCRIPT_ID) {
      return res.status(400).json({ error: 'Falta la variable de entorno SCRIPT_ID' });
    }
    const response = await fetch(API_BASE + '/' + store_id + '/scripts', {
      method: 'POST',
      headers: apiHeaders(access_token),
      body: JSON.stringify({
        script_id: parseInt(process.env.SCRIPT_ID, 10),
        query_params: '{}'
      })
    });
    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista productos con sus variantes (id + sku) para el panel admin
app.get('/api/products', async (req, res) => {
  try {
    const { store_id, access_token } = await getStoreCreds();
    const response = await fetch(
      API_BASE + '/' + store_id + '/products?per_page=200&fields=id,name,variants',
      { headers: apiHeaders(access_token) }
    );
    const products = await response.json();

    // Trae el valor de bulto ya guardado para cada producto
    const withCobertura = await Promise.all(
      products.map(async (p) => {
        const cobertura = await getMetafieldValue(store_id, access_token, p.id, KEY_COBERTURA);
        return {
          id: p.id,
          name: p.name && (p.name.es || Object.values(p.name)[0]),
          sku: p.variants && p.variants[0] ? p.variants[0].sku : '',
          cobertura
        };
      })
    );

    res.json(withCobertura);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getMetafieldValue(storeId, token, productId, key) {
  const response = await fetch(
    API_BASE + '/' + storeId + '/metafields/products?owner_id=' + productId +
      '&namespace=' + NAMESPACE + '&key=' + key,
    { headers: apiHeaders(token) }
  );
  const list = await response.json();
  if (Array.isArray(list) && list.length > 0) {
    return { id: list[0].id, value: list[0].value };
  }
  return null;
}

async function saveMetafieldValue(storeId, token, productId, key, value) {
  const existing = await getMetafieldValue(storeId, token, productId, key);
  if (existing) {
    return fetch(API_BASE + '/' + storeId + '/metafields/' + existing.id, {
      method: 'PUT',
      headers: apiHeaders(token),
      body: JSON.stringify({ value: String(value) })
    }).then((r) => r.json());
  }
  return fetch(API_BASE + '/' + storeId + '/metafields', {
    method: 'POST',
    headers: apiHeaders(token),
    body: JSON.stringify({
      namespace: NAMESPACE,
      key: key,
      value: String(value),
      owner_id: parseInt(productId, 10),
      owner_resource: 'Product'
    })
  }).then((r) => r.json());
}

// Guarda / actualiza cuantos m2 cubre la caja de un producto
app.post('/api/bulto/:productId', async (req, res) => {
  try {
    const { store_id, access_token } = await getStoreCreds();
    const productId = req.params.productId;
    const { cobertura } = req.body;

    if (!cobertura || isNaN(parseFloat(cobertura)) || parseFloat(cobertura) <= 0) {
      return res.status(400).json({ error: 'Rendimiento invalido' });
    }

    await saveMetafieldValue(store_id, access_token, productId, KEY_COBERTURA, cobertura);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint PUBLICO (sin token) que consulta el script del storefront
// Devuelve solo { value } o { value: null }. No expone el access_token.
app.get('/public/bulto/:productId', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const { store_id, access_token } = await getStoreCreds();
    const cobertura = await getMetafieldValue(store_id, access_token, req.params.productId, KEY_COBERTURA);
    res.json({
      coberturaCaja: cobertura ? parseFloat(cobertura.value) : null
    });
  } catch (err) {
    res.status(500).json({ coberturaCaja: null, error: err.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log('Corriendo en puerto ' + PORT));
