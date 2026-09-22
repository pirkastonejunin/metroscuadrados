# Configurar Google Calendar (visitas y obras, cada una a su propio calendario)

Esta app puede crear automáticamente un evento de Google Calendar por cada
**visita** (en el calendario del vendedor asignado) y por cada **obra** (en
el calendario del colocador asignado — un solo evento por obra, con fecha
de inicio y todos sus productos, no uno por producto). Todo esto pasa solo,
sin que nadie tenga que loguearse con Google ni tocar nada a mano: la app
usa una **cuenta de servicio** de Google que crea/edita/borra los eventos
por su cuenta.

Si algo de esto no está configurado (o falla en algún momento), la app
sigue funcionando exactamente igual — simplemente no se sincroniza ese
evento puntual. Nunca se traba una visita o una obra por un problema de
Calendar.

## Parte 1 — la cuenta de servicio (una sola vez, para toda la app)

1. Andá a [Google Cloud Console](https://console.cloud.google.com/) y creá
   un proyecto nuevo (o usá uno que ya tengas) — el nombre no importa, por
   ejemplo "Piedra Negra App".
2. Activá la **Google Calendar API**: en el buscador de arriba escribí
   "Google Calendar API" → **Habilitar**.
3. Creá la cuenta de servicio: menú ☰ → **IAM y administración** →
   **Cuentas de servicio** → **+ Crear cuenta de servicio**. Ponele un
   nombre (ej. "calculadora-m2-calendar") y guardá — no hace falta
   asignarle ningún rol especial ni acceso a nada más del proyecto.
4. Entrá a la cuenta de servicio recién creada → pestaña **Claves** →
   **Agregar clave** → **Crear clave nueva** → tipo **JSON** → Crear. Se
   descarga un archivo `.json` — **guardalo, lo vas a necesitar en el
   paso 6**.
5. En ese mismo archivo `.json`, buscá el campo `"client_email"` — es
   una dirección tipo
   `calculadora-m2-calendar@tu-proyecto.iam.gserviceaccount.com`. Esa es
   el **mail de la cuenta de servicio**: la vas a necesitar para
   compartirle cada calendario (siguiente parte).
6. En Render → tu servicio → **Environment**, cargá:
   - `GOOGLE_SERVICE_ACCOUNT_KEY` → pegá el contenido **completo** del
     archivo `.json` del paso 4 (todo el JSON, tal cual, como valor de
     esta variable).
   - `GOOGLE_CALENDAR_ID` → (opcional, recomendado) el id de un
     calendario "general" de respaldo — ver Parte 2. Sirve para que, si
     todavía no cargaste el calendario propio de algún vendedor o
     colocador, sus eventos no se pierdan: caen ahí mientras tanto.

## Parte 2 — el calendario general de respaldo (opcional pero recomendado)

Sirve como red de contención mientras vas cargando el calendario de cada
persona (Parte 3), y para cualquier vendedor/colocador al que no le quieras
crear uno propio.

1. En Google Calendar (con tu cuenta de Google normal), creá un calendario
   nuevo: **+** al lado de "Otros calendarios" → **Crear calendario nuevo**
   → nombre, por ejemplo "Piedra Negra — General".
2. Configuración de ese calendario → **Compartir con determinadas
   personas** → **+ Agregar personas** → pegá el mail de la cuenta de
   servicio (paso 5 de la Parte 1) → permiso **"Hacer cambios en los
   eventos"** → Enviar.
3. En la misma pantalla de configuración, bajá hasta **"Integrar
   calendario"** → copiá el **ID de calendario** (termina en
   `@group.calendar.google.com`).
4. Pegá ese id como `GOOGLE_CALENDAR_ID` en Render (paso 6 de la Parte 1).

## Parte 3 — el calendario de cada vendedor y cada colocador

Esta parte **ya no requiere entrar a Google Calendar a mano**: se hace
directo desde el panel de la app, un vendedor/colocador por vez.

1. **Vendedores** → panel de Visitas → pestaña **Vendedores** → en la fila
   de esa persona vas a ver un campo para poner su **mail de Google**
   (el que usa para entrar a Gmail/Google Calendar) y un botón
   **"Crear calendario"**.
2. **Colocadores** → panel de Obras → pestaña **Colocadores** → botón
   **Editar** del colocador → mismo campo de mail + botón
   **"Crear calendario"**.
3. Al tocar el botón, la app (con la cuenta de servicio) crea un
   calendario nuevo para esa persona y se lo comparte sola con permiso de
   **solo lectura** — no hace falta que nadie entre a Google Calendar a
   compartir ni copiar IDs. La persona puede abrir ese calendario desde
   su propio Google Calendar (en "Otros calendarios") para ver sus
   visitas/obras, aunque quien realmente crea y actualiza los eventos
   sigue siendo la app.
4. A partir de ahí, sus visitas (o sus obras) se sincronizan solas ahí.

**Dar de baja** a alguien es igual de simple: en esa misma fila/ficha
aparece un botón **"Dar de baja"** una vez que tiene calendario activo.
Al tocarlo, sus próximas visitas/obras dejan de sincronizarse a ese
calendario (caen al general de respaldo, si hay uno) — el calendario de
Google en sí y todo lo que ya se sincronizó ahí **no se borran**, así no
se pierde historial. Si más adelante querés reactivarlo, volvés a poner
el mail y tocás "Crear calendario" de nuevo (se crea uno nuevo).

Los eventos viejos, si los hubiera, no se reubican automáticamente al
cambiar de calendario.

## Qué sincroniza cada evento

- **Visita**: un evento por visita, en el calendario del vendedor
  asignado, con cliente/dirección/teléfono/notas y la fecha y hora de la
  visita. Se borra si se cancela, y se mueve de calendario si se
  reasigna la visita a otro vendedor.
- **Obra**: un evento por obra (no por producto), en el calendario del
  colocador asignado, con cliente/dirección/lista de productos/notas para
  el colocador, en la fecha de inicio de la obra. Se crea/actualiza recién
  cuando la obra tiene colocador asignado y fecha de inicio cargada; se
  borra si la obra se cancela, y se mueve de calendario si se reasigna a
  otro colocador.

## Si algo no sincroniza

- Revisá que `GOOGLE_SERVICE_ACCOUNT_KEY` esté bien pegado en Render (el
  JSON completo, sin recortar).
- Revisá que el calendario en cuestión (el de la persona, o el general)
  esté efectivamente compartido con el mail de la cuenta de servicio, con
  permiso de **"Hacer cambios en los eventos"** (no alcanza con "Ver todos
  los detalles del evento").
- Los errores de sincronización quedan en los logs del servidor en
  Render (nunca rompen la visita/obra en sí), así que ahí se puede ver el
  motivo exacto si hace falta.
