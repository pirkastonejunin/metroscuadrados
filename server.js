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
const KEY_TIPO = 'tipo_unidad';

// ---------- Mongo: una tienda por documento (store_id como _id) ----------

let mongoClient;
async function getStoresCollection() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    try {
      await mongoClient.connect();
    } catch (err) {
      mongoClient = null;
      throw err;
    }
  }
  return mongoClient.db('calculadora_m2').collection('stores');
}

function normalizarDominio(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function upsertStore(storeId, domain, accessToken) {
  const intentar = async () => {
    const col = await getStoresCollection();
    await col.updateOne(
      { _id: storeId },
      { $set: { store_id: storeId, domain: normalizarDominio(domain), access_token: accessToken } },
      { upsert: true }
    );
  };
  try {
    await intentar();
  } catch (err) {
    mongoClient = null; // fuerza reconexion
    await intentar();
  }
}

async function getStoreById(storeId) {
  const intentar = async () => {
    const col = await getStoresCollection();
    return col.findOne({ _id: parseInt(storeId, 10) });
  };
  try {
    return await intentar();
  } catch (err) {
    mongoClient = null;
    return await intentar();
  }
}

async function getStoreByDomain(domain) {
  const dominioLimpio = normalizarDominio(domain);
  const intentar = async () => {
    const col = await getStoresCollection();
    return col.findOne({ domain: dominioLimpio });
  };
  try {
    return await intentar();
  } catch (err) {
    mongoClient = null;
    return await intentar();
  }
}

async function listStores() {
  const intentar = async () => {
    const col = await getStoresCollection();
    return col.find({}).project({ store_id: 1, domain: 1, _id: 0 }).toArray();
  };
  try {
    return await intentar();
  } catch (err) {
    mongoClient = null;
    return await intentar();
  }
}

function apiHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    'User-Agent': process.env.USER_AGENT
  };
}

// Toma el store_id de la query (?store_id=123) y busca sus credenciales.
async function getStoreFromRequest(req) {
  const storeId = req.query.store_id;
  if (!storeId) {
    throw new Error('Falta el parametro store_id.');
  }
  const store = await getStoreById(storeId);
  if (!store) {
    throw new Error('Esa tienda no esta instalada todavia. Visita /install primero.');
  }
  return store;
}

// ---------- OAuth ----------

app.get('/install', (req, res) => {
  const url = 'https://www.tiendanube.com/apps/' + process.env.CLIENT_ID + '/authorize';
  res.redirect(url);
});

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

    const storeId = data.user_id;
    const accessToken = data.access_token;

    // Trae el dominio de la tienda para poder identificarla despues
    // desde el script del storefront (que solo conoce su propio dominio).
    const storeInfoResp = await fetch(API_BASE + '/' + storeId + '/store', {
      headers: apiHeaders(accessToken)
    });
    const storeInfo = await storeInfoResp.json();
    const domain = storeInfo.url || '';

    await upsertStore(storeId, domain, accessToken);

    // Activa el script en esta tienda (instalacion automatica no disponible)
    if (process.env.SCRIPT_ID) {
      try {
        await fetch(API_BASE + '/' + storeId + '/scripts', {
          method: 'POST',
          headers: apiHeaders(accessToken),
          body: JSON.stringify({
            script_id: parseInt(process.env.SCRIPT_ID, 10),
            query_params: '{}'
          })
        });
      } catch (e) {
        console.error('No se pudo activar el script automaticamente:', e.message);
      }
    }

    res.redirect('/admin.html?store_id=' + storeId + '&instalado=1');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Por si una tienda ya se instalo antes de tener SCRIPT_ID configurado
app.get('/admin/activar-script', async (req, res) => {
  try {
    const { store_id, access_token } = await getStoreFromRequest(req);
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

// ---------- Lista de tiendas instaladas (para el selector en admin.html) ----------

app.get('/api/stores', async (req, res) => {
  try {
    const stores = await listStores();
    res.json(stores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Metafields ----------

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

// ---------- Productos ----------

app.get('/api/products', async (req, res) => {
  try {
    const { store_id, access_token } = await getStoreFromRequest(req);
    const response = await fetch(
      API_BASE + '/' + store_id + '/products?per_page=200&fields=id,name,variants',
      { headers: apiHeaders(access_token) }
    );
    const products = await response.json();

    const conCobertura = await Promise.all(
      products.map(async (p) => {
        const cobertura = await getMetafieldValue(store_id, access_token, p.id, KEY_COBERTURA);
        const tipo = await getMetafieldValue(store_id, access_token, p.id, KEY_TIPO);
        return {
          id: p.id,
          name: p.name && (p.name.es || Object.values(p.name)[0]),
          sku: p.variants && p.variants[0] ? p.variants[0].sku : '',
          cobertura,
          tipo
        };
      })
    );

    res.json(conCobertura);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bulto/:productId', async (req, res) => {
  try {
    const { store_id, access_token } = await getStoreFromRequest(req);
    const productId = req.params.productId;
    const { cobertura, tipo } = req.body;

    const tiposValidos = ['m2', 'ml', 'litro', 'unidad'];
    if (!tipo || tiposValidos.indexOf(tipo) === -1) {
      return res.status(400).json({ error: 'Tipo de unidad invalido' });
    }
    const coberturaFinal = tipo === 'unidad' ? 1 : parseFloat(cobertura);
    if (!coberturaFinal || coberturaFinal <= 0) {
      return res.status(400).json({ error: 'Rendimiento invalido' });
    }

    await saveMetafieldValue(store_id, access_token, productId, KEY_COBERTURA, coberturaFinal);
    await saveMetafieldValue(store_id, access_token, productId, KEY_TIPO, tipo);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Endpoint publico consultado por storefront.js ----------
// El script no sabe su store_id, pero si su propio dominio
// (window.location.hostname), asi que buscamos la tienda por dominio.

app.get('/public/bulto/:productId', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const domain = req.query.domain;
    if (!domain) throw new Error('Falta el parametro domain.');

    const store = await getStoreByDomain(domain);
    if (!store) throw new Error('Dominio no reconocido: ' + domain);

    const cobertura = await getMetafieldValue(store.store_id, store.access_token, req.params.productId, KEY_COBERTURA);
    const tipo = await getMetafieldValue(store.store_id, store.access_token, req.params.productId, KEY_TIPO);
    res.json({
      coberturaCaja: cobertura ? parseFloat(cobertura.value) : null,
      tipoUnidad: tipo ? tipo.value : null
    });
  } catch (err) {
    res.status(500).json({ coberturaCaja: null, tipoUnidad: null, error: err.message });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log('Corriendo en puerto ' + PORT));
