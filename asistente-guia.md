# Guía del sistema de gestión de Grupo Piedra Negra

Esta guía es lo único que el asistente sabe del sistema. Si algo no está acá, no se inventa: se dice que no se sabe y se ofrece dejar una propuesta o consulta para el administrador.

## Cómo está organizado

El menú lateral tiene estos grupos (cada usuario ve solo los que su rol permite): CRM, Comercial, Proveedores, Inventario, Tesorería, Producción, Personal, Fiscal y Reportes. Arriba a la derecha, en el menú del usuario, están Configuración (usuarios, roles, notificaciones, cajas y bancos), Bases y catálogos, Integraciones y Correo a clientes, y Cerrar sesión.

Arriba hay un selector de sucursal (organización). Se puede ver una sola sucursal o "todas". Cuando se ve "todas", al guardar algo se pide en qué sucursal se opera. Los precios de costo, los planes de tarjeta y los costos de Mercado Pago son iguales para todas las sucursales.

## CRM

- **Panel de Visitas:** visitas a clientes agendadas, con vendedor, estado y presupuesto asociado. Tiene una pestaña CRM con las oportunidades (embudo: activa, convertida, descartada). Al asignar una visita a una oportunidad, esta queda convertida.
- **Calendario:** agenda de visitas y tareas de obra. En la pantalla de inicio hay además un calendario de vencimientos.
- **Panel de Obras:** obras con tareas, colocadores, seguimiento y pagos.
- **Mis visitas / Mis obras:** pantallas pensadas para el celular de vendedores y colocadores.
- La campanita muestra vencimientos: oportunidades con acción vencida, visitas sin cargar y tareas de obra atrasadas.

## Comercial

### Clientes
Ficha con datos personales, de facturación (categoría fiscal obligatoria, CUIT, lista de precios y vendedor por defecto) y de contacto. En "Editar cliente" hay una pestaña Cuenta corriente con el historial y el saldo (saldo positivo: el cliente debe; negativo: tiene a favor). Desde ahí se cobra cada venta con saldo.

### Presupuestos
- Se crean con cliente, fecha, vendedor, moneda, **lista de precios**, ítems, descuentos y observaciones. Se pueden importar del cotizador.
- **Cuotas con tarjeta (opcional):** un desplegable donde se elige con qué medio se ofrecen cuotas (por ejemplo Mercado Pago Point, Link de pago u otra tarjeta). Abajo se ve el precio de cada plan. Es solo informativo: no suma al total ni a las comisiones.
- Estados: presupuestado, en seguimiento, aprobado, rechazado. Un presupuesto aprobado se convierte en venta con el botón **Convertir en venta**; la venta hereda la lista de precios y los planes de cuotas quedan sugeridos para el cobro.
- Un presupuesto no compromete stock ni cuenta corriente.

### Ventas
- Se cargan con cliente, tipo de comprobante (Comprobante X no fiscal o Factura), lista de precios, ítems, descuentos, vendedor y tipo de entrega.
- **Entrega inmediata:** descuenta stock en ese momento y genera remito (pide depósito). **Pendiente:** no toca stock hasta entregarla; el depósito se elige al entregar.
- Anular una venta reingresa el stock y revierte la cuenta corriente.
- Cobros: parciales o totales, en efectivo (a una caja), transferencia o tarjeta (a un banco) o cheque (entra en cartera). La fecha del cobro se puede cambiar. Cada cobro puede imprimir recibo.
- La venta siempre se carga a precio de contado. El recargo por cuotas se aplica al cobrar.
- Botones del detalle: imprimir comprobante, imprimir remito, recibo por cada pago, cobrar con Point, link de pago, anular pago.
- Si la venta es fiscal, se emite la factura electrónica con ARCA (requiere punto de venta configurado).

### Cobrar con Mercado Pago (Point y link de pago)
- Desde una venta con saldo: **Cobrar con Point** (terminal física) o **Link de pago** (link para mandar por WhatsApp, vence en 7 días).
- En la ventana aparece **Plan de pago**: sin plan (un pago, sin recargo) o un plan de cuotas con su recargo. Si el plan tiene recargo, el cliente paga monto + recargo; la venta se cancela solo por el monto y el recargo queda como ingreso financiero. Si el presupuesto tenía un plan, viene elegido.
- La comisión e impuestos reales de Mercado Pago se descuentan en Tesorería cuando el pago se acredita.
- El cobro se registra solo cuando Mercado Pago confirma. Se puede cancelar un cobro pendiente.
- También se puede cobrar con Point o link un **cobro a cuenta** (por ejemplo una seña) desde Cobranza, Cuenta corriente o Tesorería, con selector de plan: queda a favor del cliente el monto sin recargo.

### Cobranza
Recibo directo a la cuenta de un cliente, sin venta puntual (señas, pagos adelantados, pagos de deuda). Se puede imprimir el recibo.

### Cotizador
Calcula cantidades y precios de materiales y mano de obra para una obra y arma una cotización que se puede enviar o importar como presupuesto.

### Remitos
Listado de todos los remitos emitidos, para verlos o reimprimirlos.

## Inventario

- **Productos:** catálogo con SKU obligatorio, rubro, marca, costo, precio, IVA, unidades por bulto y listas de precio. Se busca por SKU o nombre. La grilla pagina de a 100.
- **Listas de precio:** el precio de un producto en una lista sale de su costo más el porcentaje de la lista, salvo que tenga un precio puntual para esa lista. Algunas listas aplican solo a una selección de productos.
- **Stock:** pestañas Stock actual, Movimientos y Depósitos. Los movimientos son ingreso, egreso o transferencia y no se editan: un error se corrige con otro movimiento. Avisa cuando el stock baja del mínimo.
- **Tiendanube:** vínculos de productos con la tienda online y comparación de precios.

## Proveedores

Proveedores (con datos fiscales y bancarios), Compras (recepción con ingreso de stock y pagos parciales, mismas formas de pago que ventas) y Gastos. La facturación de proveedores puede leerse con IA desde una foto o PDF de la factura.

## Tesorería

- **Tesorería:** saldos de cajas y bancos, movimientos y cheques. Los cheques de terceros pasan por en cartera, depositado, rechazado, endosado o anulado; los propios por emitido, pagado, rechazado o anulado.
- **Mercado Pago y tarjetas** (tres pestañas): *Conexión* (token, banco donde entra la plata, terminal Point), *Tarjetas y cuotas* (tablas de **Mercado Pago Point** y **Link de pago**, con costo % más IVA 21%, recargo al cliente y la opción "Ofrecer"; más otras tarjetas cargadas a mano) y *Cobros* (lista de cobros hechos con Mercado Pago).
- **Financiera:** operaciones con cheques descontados en financieras.
- Las cajas y los bancos se dan de alta y se habilitan por sucursal y por usuario en Configuración → Cajas y Bancos. El efectivo solo va a una caja; transferencias y tarjetas solo a un banco.

## Fiscal

Puntos de venta y conexión con ARCA, Libro IVA Ventas, Libro IVA Compras y Percepciones y retenciones.

## Reportes

Informe de ventas, Estado de resultados (incluye costos financieros de tarjetas y Mercado Pago y recargos cobrados), Deudores (clientes), Deuda con proveedores y Facturación por sucursal. Cada reporte requiere su permiso.

## Producción y Personal

Costos de Producción (costeo de fabricación), Registrar producción (carga diaria de la fábrica, que ingresa a stock el producto terminado) y **Panel de producción**. Sueldos para personal.

### Panel de producción
Tablero para ver lo fabricado y qué falta fabricar. Arriba elige el período (7, 14, 30 o 60 días). Muestra lo producido hoy y en el período, el promedio por día de fabricación y cuántos productos tienen faltante. Después, un gráfico de m² fabricados día a día y una tabla con, por cada producto de producción: lo producido hoy y en el período, el **stock** (físico en todos los depósitos), lo **comprometido** (reservado por ventas pendientes de entrega), el **disponible** (stock menos comprometido), el **faltante** (lo comprometido que el stock no cubre, o sea lo que hay que fabricar) y **A fabricar** (ese faltante en paquetes, según el rendimiento por paquete del producto). El número de **Comprometido** es un link: abre el detalle de a qué clientes se les debe ese producto (comprobante, fecha, sucursal y cantidad pendiente de entrega, con el total y cuánto falta para cubrirlo). Se puede filtrar "Solo con faltante". Abajo hay una matriz con la producción de cada producto por día. El stock se vincula con el producto de Costos por SKU: si un producto no tiene SKU o el SKU no está en el catálogo, se ve su producción pero no su stock ni su faltante. El aviso de "productos sin vincular" lista cada uno con el motivo (no tiene SKU, o su SKU no está en Productos) y sugiere productos del catálogo con nombre parecido; se corrige cargando en Costos de Producción el mismo SKU que tiene en Productos. Si falta el rendimiento por paquete, "A fabricar" no se puede calcular.

## Usuarios y permisos

En Configuración: usuarios, roles (cada rol habilita módulos), notificaciones, organizaciones (sucursales con razón social, CUIT y datos para imprimir) y cajas y bancos. El rol Administrador tiene acceso a todo. Si un usuario no ve una pantalla, falta habilitarle el módulo en su rol.

## Si algo no anda

- Si un cobro de Mercado Pago queda en "registrando" o con error, se puede verificar desde la lista de cobros.
- Si no aparece un plan de cuotas al cobrar, hay que revisar que esté marcado como "Ofrecer" en Mercado Pago y tarjetas, en la tabla del canal que corresponda.
- Para cualquier problema que la guía no resuelva, el asistente deja registrada la consulta para el administrador.

## Leads de WhatsApp
Menú → "Leads de WhatsApp". Muestra los contactos que llegaron por WhatsApp (Meta Ads o directos) con su campaña/anuncio, el resumen de lo que consultaron y el estado (Nuevo, Contactado, Calificado, Cerrado, Perdido). Si el teléfono coincide con un cliente cargado, aparece como "Ya es cliente". Arriba hay el resumen por campaña y por mes, con el porcentaje que terminó siendo cliente. Se carga con "Importar CSV" usando el archivo exportado de la bandeja de Azuite; se puede repetir y no pisa el estado ni las notas que se hayan cambiado acá. Hay que elegir una sucursal para importar.
En la misma pantalla hay "Conexión con Azuite (API)": "Probar conexión", "Sincronizar nuevos" y "Traer todo el histórico". Requiere que en Render esté cargada la variable AZUITE_API_KEY (la key de solo lectura de Azuite). Si además se carga AZUITE_ORG_ID (id de la sucursal), se sincroniza solo cada 2 minutos.
Para recibir los leads al instante, en Azuite → Integraciones → "Conectar tu sistema (webhook)" se pone la URL https://metroscuadrados.onrender.com/api/leads/azuite/webhook. El secret que muestra Azuite va en Render como AZUITE_WEBHOOK_SECRET (junto con AZUITE_ORG_ID). Los leads que traen solo email y no teléfono no se guardan.
