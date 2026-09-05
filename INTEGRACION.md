# Cotizador de obra — cómo integrarlo a tu app existente

Este módulo se agrega a tu proyecto Node/Express actual (el mismo que tiene
`server.js`, conectado a MongoDB Atlas y a Tiendanube). No modifica ninguna
colección existente: solo **lee** `stores` y `rendimientos` (las mismas que
ya usa la calculadora m2) y agrega dos colecciones propias:
`tarifas_mano_obra` y `cotizaciones` (historial de presupuestos).

## 1. Copiar archivos

Copiá estos dos archivos a tu repo, respetando la carpeta `public/` que ya
tenés (donde vive `admin.html`):

```
cotizador.js              -> junto a server.js
public/cotizador.html     -> dentro de tu carpeta public/
```

## 2. Instalar la dependencia nueva

Solo se agrega una librería para generar el PDF (todo lo demás — express,
mongodb — ya las tenés):

```bash
npm install pdfkit
```

## 3. Enganchar el router en server.js

Agregá estas dos líneas en `server.js` (por ejemplo, después de donde ya
hacés `app.use(express.static(...))`):

```js
const cotizadorRouter = require('./cotizador');
app.use('/api/cotizador', cotizadorRouter);
```

Con eso ya queda disponible en `/cotizador.html` (servido automáticamente
por el `express.static` que ya tenés) y sus endpoints en `/api/cotizador/*`.

## 4. Variables de entorno

Usa las mismas que ya tenés configuradas en Render: `MONGODB_URI` y
`USER_AGENT`. No hace falta ninguna nueva.

## 5. Deploy

Como se agrega al mismo servicio de Render que ya tenés (mismo repo, mismo
deploy), en cuanto hagas push y Render redeploye vas a poder entrar desde
cualquier lado a:

```
https://metroscuadrados.onrender.com/cotizador.html
```

Como pediste, no tiene login — la protección es que la URL no está
linkeada desde ningún lado público (no aparece en el storefront ni en el
admin de Tiendanube). Si más adelante querés agregarle una clave simple,
es un cambio chico (avisame).

## 6. Cómo se calcula cada rubro

Para **piso**, **zócalo**, **puerta** y **nivelación** (si aplica), se
busca en `rendimientos` la cobertura configurada del producto elegido y se
calcula:

```
paquetes_necesarios = ceil(cantidad_de_obra / rendimiento_del_producto)
subtotal = paquetes_necesarios * precio_actual_en_tiendanube
```

La **mano de obra** (si está tildada) se suma aparte, con las tarifas que
cargues en la pestaña "Tarifas de mano de obra" (por m² de piso, por ml de
zócalo, por puerta, y por m² de nivelación — como pediste, la nivelación
suma producto **y** mano de obra por separado).

## 7. Solo el catálogo ya configurado aparece en el selector

El selector de productos de cada rubro solo muestra productos que **ya
tienen rendimiento cargado** en el admin de la calculadora m2 (con su
unidad, cobertura y envase). Si falta cargar el rendimiento de algún
producto para poder cotizarlo, hay que hacerlo primero ahí — el cotizador
lee esa misma configuración, no la duplica.

El filtro "por rubro" busca dentro de la **categoría de Tiendanube** del
producto (y también por nombre), así que no hace falta preconfigurar
ninguna lista de rubros: aparecen las categorías reales de tu catálogo.

## 8. Verificación que ya se hizo acá

- `node --check cotizador.js` → sintaxis OK.
- Se probó `calcularCotizacion(...)` (la función pura de cálculo, sin red
  ni base de datos) con 3 casos: obra completa con mano de obra, un rubro
  sin producto elegido (debe avisar cuál falta) y una división exacta
  (para verificar que no redondea de más). Los tres casos pasaron —
  ver `test-calculo.js`, se puede volver a correr con
  `node test-calculo.js` una vez instalado `pdfkit` (o con los mismos
  stubs si preferís no instalar nada).
- No se pudo levantar el server completo acá (este entorno no tiene salida
  a npm ni a tu Mongo/Tiendanube reales), así que el flujo end-to-end
  conviene probarlo una vez deployado: cargar una obra de prueba, elegir
  productos, calcular, guardar y descargar el PDF.

## 9. Cosas para revisar con vos después de probarlo

- Si el catálogo de tu tienda es grande, `/api/cotizador/productos` puede
  tardar unos segundos la primera vez que se abre cada rubro (trae todos
  los productos de Tiendanube igual que ya hace `/api/products` del
  admin). El frontend lo cachea una sola vez por sesión para no repetir la
  consulta al cambiar de rubro.
- Las tarifas de mano de obra son por tienda (`store_id`), así que si
  manejás varias tiendas cada una tiene las suyas.
