# Calculadora de m² — app privada para Piedra Negra

Reemplaza a "Metros Cuadrados": agrega "unidades por bulto" como atributo
propio de cada producto (guardado vía metafield oficial de la API de
Tiendanube, sin tocar el SKU) y calcula automáticamente cuántos bultos
necesita comprar el cliente según los m² a cubrir.

## Arquitectura

- `server.js` — backend (Node + Express). Maneja el login OAuth con
  Tiendanube, guarda/lee el "unidades por bulto" de cada producto vía
  la API de Metafields, y expone un endpoint público para el storefront.
- `public/admin.html` — panel simple donde vos cargás cuántas unidades
  trae cada bulto, producto por producto.
- `public/storefront.js` — el script que se instala en tu tienda online
  (vía el Partner Portal) y muestra la calculadora en la ficha de
  producto.

## Paso 1 — Crear la app en el Partner Portal (gratis)

1. Entrá a https://partners.tiendanube.com y creá una cuenta si no
   tenés.
2. "Mis apps" → "Crear app". Ponele nombre, ej. "Calculadora m² Piedra
   Negra".
3. En "Scopes/Permisos" tildá como mínimo:
   - `read_products`
   - `write_products`
   - permiso de `scripts`
4. En "Redirect URL" poné la URL de tu backend + `/auth/callback`
   (la vas a tener después del paso 2 — podés volver a editar esto
   luego).
5. Guardá el `Client ID` y `Client Secret` que te da la plataforma.

## Paso 2 — Deployar el backend

Necesitás un hosting simple donde corra Node (esto es un backend real,
no un archivo estático). Opciones gratuitas/baratas: Render, Railway,
Fly.io.

1. Subí esta carpeta a un repo de GitHub (o subila directo si tu
   hosting lo permite).
2. Configurá las variables de entorno del `.env.example`:
   - `CLIENT_ID` y `CLIENT_SECRET` (del paso 1)
   - `REDIRECT_URI` = `https://tu-app.onrender.com/auth/callback`
   - `USER_AGENT` = algo como `CalculadoraM2 (tu-email@dominio.com)`
3. Deploy. Confirmá que `https://tu-app.onrender.com/install` responde
   (te va a redirigir a Tiendanube).
4. Volvé al Partner Portal y actualizá la "Redirect URL" con la URL
   real ya deployada.

## Paso 3 — Instalar la app en tu tienda

1. Como estás en modo desarrollo, desde el Partner Portal instalá la
   app en tu propia tienda (opción "Probar en mi tienda" o similar).
   Esto dispara el flujo OAuth: te lleva a `/install`, aceptás
   permisos, y Tiendanube te redirige a `/auth/callback`, que guarda
   el token.
2. Si todo salió bien, terminás en `/admin.html`.

## Paso 4 — Cargar "unidades por bulto"

En `/admin.html` vas a ver la lista de tus productos. Para cada uno
que se vende por m², completá cuántas unidades trae el bulto/caja/rollo
y tocá "Guardar". Eso queda guardado como metafield del producto — no
toca el SKU ni tu sistema de gestión.

## Paso 5 — Subir el script al storefront

1. Antes, editá `public/storefront.js`: reemplazá
   `TU-APP-DEPLOYADA.onrender.com` por la URL real de tu backend.
2. Volvé a deployar (para que `/public/bulto/:id` esté disponible;
   el archivo storefront.js en sí se sube aparte, ver paso siguiente).
3. En el Partner Portal, en el detalle de tu app, sección "Scripts" →
   "Create script":
   - `location`: store
   - `event`: onfirstinteraction (más simple, no requiere aprobación
     de Tiendanube; "onload" sí la requiere)
   - `auto installed`: sí
   - Subí el archivo `public/storefront.js` como versión del script.
4. Deployá esa versión a producción desde el mismo panel.

Listo — el script va a cargar solo en las fichas de producto de tu
tienda. Si el producto tiene "unidades por bulto" cargado, aparece la
calculadora; si no, no aparece nada (no rompe nada en el resto del
catálogo).

## Notas importantes

- El selector del input de cantidad (`QTY_INPUT_SELECTORS` en
  `storefront.js`) está pensado para el theme Base y derivados. Si tu
  tienda usa otro theme, inspeccioná el input de cantidad en la ficha
  de producto y agregá su selector a la lista.
- El endpoint `/public/bulto/:id` es de solo lectura y no expone tu
  access_token — es seguro que sea público.
- `db.json` guarda tu `access_token` — no lo subas a un repo público.
- Esta app es de uso privado (para tu propia tienda). Si en el futuro
  quisieras publicarla en el marketplace para otros comercios, hay un
  proceso de revisión aparte de Tiendanube — pero para uso interno no
  hace falta.
