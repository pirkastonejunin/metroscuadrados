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

## CRM (leads, oportunidades y campañas)
Menú → "CRM" (reemplaza a "Leads de WhatsApp" y a la pestaña CRM del Panel de Visitas). Requiere el módulo "CRM y Bot de WhatsApp" (quien ya tiene Visitas también entra). Cada sucursal ve sus propios datos.
Tiene tres pestañas:
- Entrantes: contactos que llegaron por WhatsApp (Meta Ads o directos) con campaña/anuncio, resumen de la consulta y estado (Nuevo, Contactado, Calificado, Cerrado, Perdido). Si el teléfono coincide con un cliente cargado aparece "Ya es cliente". Con "Pasar a oportunidad" se lo sigue de cerca.
- Oportunidades: seguimiento con vendedor, próxima acción y fecha, notas; se puede dar de alta una a mano con "+ Nueva oportunidad", descartarla o convertirla. "Asignar visita" aparece solo en sucursales que trabajan con visitas (ej. Pirka); en Piedra Negra no se muestra.
- Campañas: cuántos leads trajo cada campaña/anuncio, cuántos ya son clientes, cuántos compraron y cuánto vendieron (solo compras hechas después de escribir), más leads por mes.
Importar CSV de Azuite y sincronizar con Azuite siguen en esta pantalla (se puede repetir sin pisar estados ni notas). Hay que elegir una sucursal para importar.

## CRM (pantalla única: Trabajar · Todas · Bot de WhatsApp)
Menú → "CRM". Reemplaza a las pantallas separadas de CRM (Entrantes y Oportunidades), Mesa de ventas y Bot de WhatsApp. Arriba hay tres vistas:
- **Trabajar**: la pantalla del vendedor, con la lista a la izquierda, el chat de WhatsApp en el centro y la ficha de venta a la derecha (detalle abajo).
- **Todas**: tabla con todas las oportunidades y contactos (filtros por temperatura, producto, estado y asesor; "Mostrar cerradas"). Al tocar una fila se abre en Trabajar. Los contactos que llegaron de Azuite o de un anuncio y todavía no son oportunidad aparecen acá como "Nuevo", con el botón "Pasar a oportunidad". "Vista clásica del CRM" abre la pantalla anterior mientras dure la transición.
- **Bot de WhatsApp**: probar el bot, conocimiento (incluye los interruptores de vendedor con datos reales y de oportunidades automáticas) e instrucciones. Quitar o cargar conversaciones de ejemplo se hace desde Trabajar (lista vacía) y Todas.

### Tablero (pantalla Trabajar)
- Columnas: **Hoy** (lo que hay que resolver hoy: mensajes nuevos, clientes que esperan, seguimientos de hoy o vencidos, "Falta decidir"; la idea es terminar el día vacía), **Esperando respuesta**, **Seguimiento**, **Presupuesto enviado** y **Por cerrar**. Se arrastran las tarjetas entre columnas (si el cliente estaba esperando respuesta y la movés, queda atendida hasta que escriba de nuevo); en la ficha, "Hacer presupuesto" abre una ventana con el cliente ya cargado (si no existe, se crea con nombre y teléfono del contacto); al guardar, la ventana se cierra y el resumen del presupuesto (productos, total con IVA) queda escrito en el chat para que lo revises y lo envíes. "Ver y editar" abre uno existente en la misma ventana, sin salir del CRM. El PDF todavía no se puede mandar por WhatsApp desde el sistema; abajo se sueltan en "Ganada" o "Perdida". Arriba: filtros (mías / toda la sucursal, temperatura, producto, buscar, "Solo Hoy") y el resumen del día. Hay también vista Lista y el Bot de WhatsApp.
- **Embudo** (tarjetas de arriba): cuántas oportunidades hay en cada etapa (Nuevos, En conversación, Presupuesto enviado, Por cerrar), con su monto y el porcentaje del total; la última muestra las ganadas del mes y el porcentaje de cierres. Al tocar una etapa, el tablero se filtra por ella.
- Al abrir una tarjeta se ve el chat a la izquierda y la ficha a la derecha. "Usar" copia la sugerencia de la IA a la caja (siempre la editás vos), "Analizar" pide el análisis, "Tomar" te asigna la conversación.
- **Decisión al salir**: si escribiste en una conversación, al cerrarla o abrir otra te pregunta qué sigue: Espero al cliente hoy, Seguimiento (mañana / 2 días / 1 semana), Posponer (fecha), Ganada o Perdida (con motivo). "Decidir después" la deja marcada "Falta decidir" en Hoy. El botón "Decidir qué sigue" está siempre disponible.
- **Esperando respuesta** vence ese día a las 15 hs (si se marca después de las 15, vuelve a Hoy al día siguiente). Si el cliente no contestó, la tarjeta vuelve a Hoy como "Sin respuesta: recordale" con un mensaje sugerido. Tras 3 recordatorios se propone cerrarla como perdida (sin respuesta). El seguimiento con fecha pasa a Hoy ese día (la campanita usa la oportunidad del CRM).
- Ficha: qué hacer ahora, etapa (Nuevo, En conversación, Presupuesto enviado, Por cerrar), temperatura (la propone la IA; si la cambiás no la pisa), presupuesto y "Más datos" (qué falta preguntar, notas internas, historial). Las cerradas (ganadas o perdidas) salen del tablero y se ven con "Cerradas"; desde ahí se pueden "Reabrir". Si el cliente vuelve a escribir después de cerrada, se reabre sola y vuelve a Hoy. Las oportunidades que vienen de Azuite aparecen sin chat.

## Bot de WhatsApp
Menú → "Bot de WhatsApp". Es el asistente propio que atiende los mensajes de WhatsApp: pregunta (máximo 3 preguntas) qué producto necesita, medidas y estilo, y lo deriva a un asesor; no cotiza. Cuando el cliente acepta al asesor, el bot ya no escribe (solo avisa el horario si vuelve a escribir, como mucho cada 6 horas). Si un asesor escribe desde el celular o desde esta pantalla, el bot deja de contestar en esa conversación ("Tomar yo"); con "Devolver al bot" vuelve a atender. Cada conversación alimenta la pantalla de Leads. El texto de instrucciones del bot está en el archivo bot-prompt.md. Para apagarlo sin desconectarlo: BOT_ACTIVO=0 en Render.
En la pantalla del bot, la solapa "Probar el bot" permite chatear como si fueras un cliente (con texto, foto o audio) para ver cómo responde la IA, sin WhatsApp y sin guardar nada. Ahí mismo se pueden editar y guardar las instrucciones del bot (solo Administrador); "Volver al original" restaura el texto del sistema.
En la pantalla del bot, el interruptor "Vendedor con datos reales (en prueba)" (por sucursal, apagado por defecto, solo Administrador) deja que el bot consulte el sistema. Al lado hay un selector de qué comparte de cada producto: "Da el precio final" (con IVA, lista Consumidor Final), "Pasa el link a la tienda" (link de Tiendanube, sin precio; solo para productos vinculados con la tienda) o "Link (si no hay, precio)". Además y dice si un producto está "disponible" o "se consulta" (nunca cantidades de stock), y calcula cajas y total para una superficie en m2. "Probar el bot" siempre usa los datos reales aunque el interruptor esté apagado y muestra qué consultó. La tarjeta "Probar con 30 consultas de ejemplo" corre un lote de pruebas y muestra cada respuesta junto a lo esperado (se puede elegir proveedor y modelo para comparar). El gasto de IA del mes (con tope configurable en Render, IA_TOPE_USD_MES) lo ve el Administrador en /api/ia/uso.
Otro interruptor, "Oportunidades y presupuestos automáticos (en prueba)": cuando el bot deriva a un cliente con interés concreto, crea la oportunidad en el CRM (sin vendedor asignado: la toma alguien de la sucursal; origen "WhatsApp · bot") y, si armó un presupuesto con el cliente y el teléfono pertenece a un cliente ya cargado, deja un borrador en Presupuestos (estado presupuestado, hecho por "Bot de WhatsApp") para que un asesor lo revise antes de enviarlo. Si el cliente cambia el pedido y nadie tocó el borrador, se actualiza el mismo; no se crean duplicados. No toca ventas, stock ni cuentas.
Mientras WhatsApp no esté conectado la bandeja está vacía: el botón "Cargar 3 conversaciones de ejemplo" (solo Administrador) crea tres conversaciones de muestra para probar el asistente (nunca se envían por WhatsApp) y "Quitar las conversaciones de ejemplo" las borra junto con las oportunidades y leads que se hayan creado a partir de ellas.
Asistente del vendedor: al abrir una conversación del bot, el botón "Analizar con IA" (lo pide el asesor, no corre solo) muestra un resumen, qué quiere el cliente, si está caliente/tibio/frío, qué datos faltan, el próximo paso, alertas para verificar y una respuesta sugerida; "Usar en la respuesta" la pasa al cuadro de mensaje para editarla y enviarla (el asistente nunca envía nada). "Programar seguimiento" fija la próxima acción en la oportunidad del CRM (si no hay una la crea, sin vendedor asignado) y la campanita avisa cuando vence. Cada análisis gasta un poco de IA y cuenta para el tope mensual.
La solapa "Conocimiento" del bot permite enseñarle con páginas web (se pueden actualizar), archivos (PDF de catálogos, Excel, CSV, texto, imágenes), textos propios y, activando el interruptor, los productos del sistema (nombres, rubros y marcas, sin precios ni stock). Cada fuente se puede ver, editar, apagar o quitar. Solo Administrador puede cambiarlas. Hay que elegir una sucursal arriba (no "todas").
