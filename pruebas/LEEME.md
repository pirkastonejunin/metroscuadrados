# Pruebas automáticas

`npm test` corre todas las pruebas (`*.prueba.js`), cada una con su propia base de datos en memoria (con réplicas, como Atlas).
`npm test -- seguridad` corre solo las que tengan esa palabra en el nombre.

**Regla de trabajo:** no se publica (`git push`) si no dan todas verdes.

Qué cubren:
- `transacciones-*`: que Ventas, Compras, Gastos, Tesorería, Sueldos, Stock, Financiera y Clientes guarden todo o nada (se fuerza un error a mitad de la operación y se verifica que no quede nada suelto).
- `seguridad-*`: sesiones firmadas, accesos por módulo y sucursal, límite de intentos de login.
- `copia-seguridad`: la copia diaria cifrada: se exporta, se sube (con Cloudinary simulado que valida la firma), se restaura en otra base y se compara todo; también falla bien, no se pisa y conserva solo 14.
- `archivos-cloudinary`: fotos de visitas/obras y archivos de WhatsApp pasan a Cloudinary (con la nube simulada), si falla no se pierde nada y el CRM los sigue viendo.
- `auditoria`: el historial de cambios: registra solo lo exitoso y de usuarios identificados, tapa contraseñas/claves/fotos, y se consulta con filtros solo como Administrador.
- `encabezados-csp`: abre todas las pantallas en un navegador y verifica que la política de seguridad no bloquee nada.
- `estado-resultados-detalle`, `unificar-conceptos-gasto`, `imputar-cobros`: lógica de informes y cuenta corriente.

Necesitan `mongodb-memory-server` y, para `encabezados-csp`, `playwright`. (No están en `package.json` a propósito, para que Render no las instale al publicar: se usan solo en el entorno de trabajo.)

Cuando se agrega una función delicada (plata, stock, accesos), se agrega su prueba acá.
