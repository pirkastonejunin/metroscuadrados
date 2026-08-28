# Calculadora de m² — app privada para Piedra Negra (v2, multi-tienda)

Reemplaza a "Metros Cuadrados": muestra precio por m²/ml/litro y calcula
cuántas cajas necesita comprar el cliente según lo que quiera cubrir.
Soporta tener la tienda real y la tienda demo instaladas al mismo
tiempo, cada una con su propia configuración.

## Qué cambió respecto a la v1

- Se sacó toda la parte de etiquetas/materiales (quedó en pausa para
  retomar más adelante con un enfoque distinto).
- Ahora la app funciona con **varias tiendas a la vez** (por ejemplo,
  tu tienda real y la demo). Cada tienda se identifica por su
  `store_id` y su dominio, guardados en MongoDB. `/admin.html` tiene
  un selector arriba de todo para elegir con cuál tienda estás
  trabajando en ese momento.

## Arquitectura

- `server.js` — backend (Node + Express). OAuth con Tiendanube,
  guarda/lee "unidades por bulto" vía Metafields, y expone un
  endpoint público para el storefront. Ahora todo queda separado por
  tienda en MongoDB (colección `stores`, un documento por tienda).
- `public/admin.html` — panel de carga, con selector de tienda arriba.
- `public/storefront.js` — script que se instala en cada tienda vía
  el Partner Portal.

## Paso 1 — Crear la app en el Partner Portal (si no la tenés ya)

1. https://partners.tiendanube.com → "Mis apps" → "Crear app".
2. Scopes: `read_products`, `write_products`, `scripts`.
3. Guardá `Client ID` y `Client Secret`.

## Paso 2 — Deployar el backend

1. Subí esta carpeta a GitHub.
2. Render (u otro hosting con Node) → New Web Service → conectá el repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Variables de entorno (ver `.env.example`): `CLIENT_ID`,
   `CLIENT_SECRET`, `USER_AGENT`, `MONGODB_URI`, `SCRIPT_ID`.
5. Una vez deployado, agregá `REDIRECT_URI` = `https://tu-app.onrender.com/auth/callback`.
6. En Render, **desactivá Auto-Deploy** (Settings) para no perder la
   conexión a Mongo en cada push accidental — no hace falta, ya que
   ahora todo el estado vive en MongoDB, pero igual es buena práctica
   controlar cuándo se redeploya.

## Paso 3 — MongoDB Atlas (base de datos gratis)

1. https://mongodb.com/cloud/atlas/register → cluster gratis M0.
2. Database Access → crear usuario con contraseña.
3. Network Access → Add IP Address → **Allow Access from Anywhere**
   (0.0.0.0/0), para que Render se pueda conectar.
4. Connect → Drivers → copiar el connection string, reemplazar
   `<password>`, y pegarlo en `MONGODB_URI` en Render.

## Paso 4 — Completar la Redirect URL en el Partner Portal

En el Partner Portal, pestaña "Configuración" de tu app, sección
"URLs": el campo **"URL para redirigir después de la instalación"**
(no el de "Página de la aplicación") debe ser exactamente:

```
https://tu-app.onrender.com/auth/callback
```

## Paso 5 — Instalar en cada tienda

Para cada tienda que quieras usar (demo y/o real):

1. Anda a `https://tu-app.onrender.com/install`.
2. Iniciá sesión en esa tienda y aceptá los permisos.
3. Vas a terminar en `/admin.html?store_id=XXXX` ya con esa tienda
   seleccionada en el desplegable de arriba.

Podés repetir esto para varias tiendas — cada una queda guardada por
separado, y el desplegable de `/admin.html` te deja cambiar entre
ellas sin perder nada.

## Paso 6 — Cargar el rendimiento de los productos

Con la tienda correcta seleccionada en el desplegable, cargá para
cada producto la unidad (m²/ml/litro/unidad) y cuánto rinde una caja.
También podés usar la carga masiva por Excel (botones arriba de la
tabla).

## Paso 7 — Subir el script al storefront

1. En `public/storefront.js`, la variable `APP_URL` ya apunta a tu
   backend — no hace falta tocarla si es la misma URL para todas las
   tiendas (el script manda su propio dominio en cada pedido, así el
   backend sabe de qué tienda es).
2. Partner Portal → tu app → Scripts → Create script: `location: store`,
   `event: onfirstinteraction`. Subí `storefront.js`.
3. Si "Instalación automática" aparece bloqueada, desplegá igual la
   versión a testing/producción, y activala manualmente por tienda
   visitando: `https://tu-app.onrender.com/admin/activar-script?store_id=XXXX`
   (una vez por cada tienda instalada).

## Notas importantes

- El selector del input de cantidad y el del precio nativo en
  `storefront.js` (`QTY_INPUT_SELECTORS`, `PRICE_SELECTORS`) están
  adivinados para temas comunes — si tu theme no coincide, inspeccioná
  esos elementos en la ficha del producto y agregá el selector real.
- El endpoint `/public/bulto/:id` es de solo lectura, no expone ningún
  `access_token` — es seguro que sea público.
- Si en algún momento necesitás correr **la misma tienda** en dos
  ambientes con el mismo dominio (poco común), avisá — el sistema
  identifica tiendas por dominio único.
