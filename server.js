require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'db.json');
const API_BASE = 'https://api.tiendanube.com/v1';
const NAMESPACE = process.env.METAFIELD_NAMESPACE || 'calculadora_m2';
const KEY = process.env.METAFIELD_KEY || 'unidades_por_bulto';

function readDb() {
  if (!fs.existsSync(DB_PATH)) return {};
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}
function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function apiHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': process.env.USER_AGENT
  };
}

function getStoreCreds() {
  const db = readDb();
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

    writeDb({ store_id: data.user_id, access_token: data.access_token });

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
    const { store_id, access_token } = getStoreCreds();
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
    const { store_id, access_token } = getStoreCreds();
    const response = await fetch(
      API_BASE + '/' + store_id + '/products?per_page=200&fields=id,name,variants',
      { headers: apiHeaders(access_token) }
    );
    const products = await response.json();

    // Trae el valor de bulto ya guardado para cada producto
    const withBulto = await Promise.all(
      products.map(async (p) => {
        const bulto = await getMetafieldValue(store_id, access_token, p.id);
        return {
          id: p.id,
          name: p.name && (p.name.es || Object.values(p.name)[0]),
          sku: p.variants && p.variants[0] ? p.variants[0].sku : '',
          bulto
        };
      })
    );

    res.json(withBulto);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getMetafieldValue(storeId, token, productId) {
  const response = await fetch(
    API_BASE + '/' + storeId + '/metafields/products?owner_id=' + productId +
      '&namespace=' + NAMESPACE + '&key=' + KEY,
    { headers: apiHeaders(token) }
  );
  const list = await response.json();
  if (Array.isArray(list) && list.length > 0) {
    return { id: list[0].id, value: list[0].value };
  }
  return null;
}

// Guarda / actualiza el "unidades por bulto" de un producto
app.post('/api/bulto/:productId', async (req, res) => {
  try {
    const { store_id, access_token } = getStoreCreds();
    const productId = req.params.productId;
    const { value } = req.body;

    if (!value || isNaN(parseFloat(value)) || parseFloat(value) <= 0) {
      return res.status(400).json({ error: 'Valor invalido' });
    }

    const existing = await getMetafieldValue(store_id, access_token, productId);

    let response;
    if (existing) {
      response = await fetch(API_BASE + '/' + store_id + '/metafields/' + existing.id, {
        method: 'PUT',
        headers: apiHeaders(access_token),
        body: JSON.stringify({ value: String(value) })
      });
    } else {
      response = await fetch(API_BASE + '/' + store_id + '/metafields', {
        method: 'POST',
        headers: apiHeaders(access_token),
        body: JSON.stringify({
          namespace: NAMESPACE,
          key: KEY,
          value: String(value),
          owner_id: parseInt(productId, 10),
          owner_resource: 'Product'
        })
      });
    }

    const result = await response.json();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint PUBLICO (sin token) que consulta el script del storefront
// Devuelve solo { value } o { value: null }. No expone el access_token.
app.get('/public/bulto/:productId', async (req, res) => {
  try {
    const { store_id, access_token } = getStoreCreds();
    const data = await getMetafieldValue(store_id, access_token, req.params.productId);
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ value: data ? data.value : null });
  } catch (err) {
    res.status(500).json({ value: null });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log('Corriendo en puerto ' + PORT));
