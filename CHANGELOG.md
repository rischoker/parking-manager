# Registro de cambios

## 1.2.0 — Bitácora de ingresos y panel remoto (2026-10-15)

Pensada para un parqueadero dentro de un **conjunto residencial privado**: saber
quién entró, a qué hora, con qué carro y a quién visitó, y poder consultarlo
**desde fuera de la caseta**. La base de datos se actualiza sola al abrir el
programa; no se pierde ni cambia nada de lo que ya tenías.

### Novedades en el programa de la caseta

* **Registrar ingreso** (botón en el Panel, para Admin y Vigilante): el vigilante registra
  a mano un vehículo con nombre, placa, **tipo** (visitante / residente / servicio o domicilio),
  **torre y apartamento**, **a quién visita**, **vehículo** (marca y color) y, si quiere, el espacio.
  El formulario del QR del cliente pide los mismos datos (opcionales).
* **Quién registró cada cosa:** cada sesión guarda quién registró la entrada (el vigilante o "QR")
  y quién registró la salida. Se ve en el detalle, en el Historial (columna *Registró*) y en el CSV/Excel.
* **Historial:** filtros nuevos por tipo de persona y por torre/apartamento.
* **Mensualistas — entradas y salidas reales:** antes "Marcar dentro/fuera" era un simple
  interruptor sin memoria. Ahora cada movimiento queda con su fecha, hora y quién lo registró
  (botón *Movimientos* en cada mensualidad). Un doble clic no crea movimientos falsos y una
  mensualidad cancelada no puede "entrar".
* **Bitácora** (solo Admin): registro de **quién hizo qué y cuándo** — ingresos, espacios asignados,
  salidas y cobros, cancelaciones, pagos de mensualidades, cambios de tarifas, horarios, usuarios y
  PIN, ajustes, e inicios de sesión (también los fallidos). Solo se puede consultar: no hay forma
  de editarla ni borrarla desde el programa. La acción y su anotación se guardan juntas, y **nunca
  se anotan PIN ni secretos**.
* **Probar conexión** en *Configuración → Respaldo y panel remoto* (comprueba la dirección y el secreto).

### Servicio en la nube (nuevo, opcional y gratuito): `cloud_worker/`

Un servicio sobre Cloudflare Workers + D1 (guía paso a paso: `cloud_worker/DEPLOY.md`).

* **Panel de consulta** (`/monitor/`) para el propietario y la administración: *Ahora* (quién está
  dentro), *Registro de ingresos* con filtros y CSV, *Mensualistas*, *Bitácora* y *Accesos*.
  **Solo lectura.** Cada persona entra con **su propia llave**; el propietario crea y revoca llaves
  (la revocación corta también las sesiones abiertas) y ve quién consultó el panel. La administración
  no ve la bitácora ni los teléfonos.
* **"Consulta desde cualquier lugar" para los clientes:** la misma página que ya existía para GitHub
  Pages, ahora servida por este servicio y **sin exponer** nombre, teléfono ni torre/apartamento.
* **Sincronización v2** (`app/cloud_sync.py`): envía sesiones, bitácora y movimientos de mensualistas.
  Solo envía lo que **cambió** (antes se reenviaban todas las sesiones activas cada 30 s: ~35 000
  escrituras al día solo en eso), reintenta si se cae internet sin duplicar nada, se detiene al primer
  fallo que se repetiría (sin internet, secreto equivocado) y, al **cambiar la dirección de destino,
  vuelve a enviar todo el historial**. Las horas viajan con su zona horaria.
* **Seguridad del servicio:** llaves aleatorias de 256 bits guardadas solo como huella; cookie
  `HttpOnly`/`Secure`/`SameSite=Strict`; bloqueo tras 5 intentos fallidos por dirección; comprobación de
  origen en acciones del navegador; política de contenido estricta (sin scripts en línea); datos de
  clientes siempre mostrados como texto; CSV que neutraliza fórmulas; sin llaves en la base de datos.
* El respaldo en **Google Sheets sigue funcionando** (solo sesiones): `AppsScript.gs` responde "ok" e
  ignora los tipos nuevos. Si ya lo usas, no hace falta cambiar nada.

### Pruebas

* 17 pruebas de la API de ingresos/bitácora, 10 de la sincronización v2 (con un servidor "nube" falso),
  2 de las pantallas (administración y formulario del QR, en un navegador simulado), 1 de punta a punta
  (el programa real enviando al servicio real en local) y **46 comprobaciones del servicio en la nube**
  (recepción, llaves, bloqueo por intentos, viewers, filtros, CSV, pantalla del panel, ataques de
  inyección y entre sitios). En total **58 pruebas de Python + 46 del servicio**, todas en CI.
* Se corrigió durante las pruebas: un filtro del panel quedaba aplicado al entrar otra persona.

### Qué NO se pudo comprobar en este entorno

* **Un despliegue real en Cloudflare:** el servicio se probó completo en local (`wrangler dev --local`
  con una base D1 de prueba) y compila para publicar (`wrangler deploy --dry-run`), pero no se publicó
  en tu cuenta. La guía `DEPLOY.md` es el camino para hacerlo; lo más probable que requiera ajuste es
  el paso del dominio personalizado.
* **Windows real y WebView2:** igual que en 1.1, se confirma con la primera ejecución en GitHub Actions
  y abriendo el `.exe`.

### De la lista de mejoras de 1.1

El punto 4 (**registro de auditoría**) queda hecho. Siguen sin implementarse los demás (minutos de
gracia y tope diario, PIN por defecto, copia local automática, caducidad de pendientes, dirección fija
del QR, importar el Formulario, símbolo de moneda, PDF, firma de código).

## 1.1.0 — Revisión completa del proyecto (2026-10-09)

Cada error de esta lista se **reprodujo primero** contra un servidor en marcha
(no solo leyendo el código) y se corrigió después; los que tienen prueba
automática lo indican en la columna "Prueba". La versión 1.0 se conserva tal
cual en el zip original: esta versión no borra ni cambia tu información, la
base de datos se actualiza sola al abrir el programa.

### Errores graves corregidos

| # | Qué pasaba | Qué se hizo | Prueba |
|---|---|---|---|
| 1 | **El `.exe` empaquetado no habría arrancado.** El servidor se lanzaba con el texto `"app.main:app"`; PyInstaller solo sigue los `import` que ve, así que el servidor, las rutas y la lógica no entraban en el paquete. | `desktop_app.py` importa el objeto `app` directamente. | `test_pyinstaller_will_see_the_backend_modules` + compilación y arranque reales del paquete |
| 2 | **Sin consola, el `.exe` se cerraba al arrancar:** una aplicación de ventana no tiene `stdout`/`stderr` y el registro de uvicorn fallaba. | Se redirigen a `parkingmanager.log` (en la carpeta de datos). | `test_server_starts_when_the_process_has_no_console` |
| 3 | **Los botones "Exportar CSV / Excel" no hacían nada en el `.exe`:** pywebview cancela las descargas si no se activan. | `ALLOW_DOWNLOADS = True` (aparece el diálogo normal de "Guardar como"). | `test_downloads_are_enabled_for_the_export_buttons` |
| 4 | **Cambiar el tipo de una tarifa (por hora ⇄ fija) con un carro estacionado rompía el panel, el detalle de la sesión y la salida** (error 500 en cada recarga): el cobro de la sesión se calculaba con el tipo de la tarifa *actual* aplicado a la configuración que la sesión ya había guardado. | La sesión guarda también el **tipo** de tarifa (columna `pricing_type`, migración automática que rellena las sesiones antiguas) y conserva el precio con el que se registró. | `test_editing_rule_type_while_car_is_parked…`, `test_migration_adds_and_backfills…` |
| 5 | **Los nombres de clientes podían convertirse en fórmulas** al abrir el CSV/Excel exportado (un nombre que empiece por `=`, `+`, `-` o `@`). Los nombres vienen de un formulario público. | Se neutralizan al exportar; los teléfonos normales (`+57 300…`) no se alteran. | `test_exports_do_not_turn_customer_input_into_formulas` |
| 6 | **Un administrador degradado seguía siendo administrador hasta 12 h** (el rol quedaba grabado en su sesión). | Al cambiar el rol se cierran sus sesiones abiertas. | `test_demoting_an_admin_ends_their_open_session` |

### Seguridad

| # | Qué pasaba | Qué se hizo | Prueba |
|---|---|---|---|
| 7 | PIN numérico corto **sin límite de intentos**: se podían probar todas las combinaciones en minutos. | Bloqueo tras 5 fallos (30 s, se duplica hasta 15 min) y límite global por minuto. | `test_login_is_throttled…` |
| 8 | CORS abierto a cualquier sitio web (`*`): una página cualquiera abierta en el navegador del PC del administrador podía leer las respuestas del servidor. | Se quitó CORS (las páginas del cliente son del mismo origen y no lo necesitan). | `test_no_cors_headers…` |
| 9 | "Solo desde este PC" se basaba únicamente en la IP de origen: vulnerable a *DNS rebinding*. | Además se exige que el encabezado `Host` sea `127.0.0.1`/`localhost`/`[::1]`. | `test_admin_requests_with_a_foreign_host_header…` |
| 10 | `/docs` y `/openapi.json` publicaban la lista completa de rutas de administración a cualquier móvil de la red. | Desactivados. | idem 8 |
| 11 | El registro por QR **no validaba nada** y no tenía límites: nombres/placas absurdos, o cientos de registros falsos llenando la cola del vigilante. | Validación de nombre, placa y teléfono (servidor **y** pantalla del móvil), límite por dispositivo y tope de pendientes. | `test_registration_*`, `test_pending_queue_is_capped` |
| 12 | Página de estado de GitHub Pages: el número de espacio se insertaba en la página sin escapar. | `escapeHtml(...)`. | revisión de código |
| 13 | `PUT /cloud-sync` aceptaba cualquier cosa como URL y valores booleanos ambiguos. | Solo `http(s)://…`; booleanos normalizados. | revisión |

### Errores medios

| # | Qué pasaba | Qué se hizo | Prueba |
|---|---|---|---|
| 14 | Si una persona se registraba con **una placa ya conocida pero otro nombre** (carro vendido, prestado, error de digitación), **se reescribía el nombre en todo el historial** de esa placa. | Un nombre distinto crea su propio registro de cliente; el pasado queda como se grabó. | `test_same_plate_with_a_different_name…` |
| 15 | **Historial:** al filtrar "hasta el 9 de octubre" se quedaban fuera las entradas de ese mismo día (límite superior inclusivo a medianoche); sin paginación (carga todo); fechas mal escritas daban error 500. | Rango con fin exclusivo al día siguiente, rango personalizado en pantalla, paginación (`limit`/`offset`/`total`, 100 por defecto), errores 422 claros. Los exportes respetan los filtros. | `test_history_date_range_pagination_and_bad_dates` |
| 16 | **Mensualidades:** una suscripción del día 31 pasaba a vencer el 28 para siempre (31 ene → 28 feb → 28 mar → …). | Se conserva el día original de inicio. | `test_monthly_due_date_returns_to_the_original_billing_day` |
| 17 | **Sin internet, "Sincronizar ahora" se congelaba minutos:** esperaba 8 s por cada sesión. | Al primer fallo de conexión se abandona el ciclo (el siguiente reintenta todo). | `test_cloud_sync_gives_up_the_cycle…` |
| 18 | **Borrar una tarifa ya usada** daba un error 500; también se podía borrar la última tarifa activa y dejar al sistema sin precios. | Mensaje claro (400): "desactívala en su lugar"; siempre queda al menos una activa. | `test_deleting_a_rule_that_was_used…`, `test_cannot_delete_the_last_active_rule` |
| 19 | Con el puerto 8000 ocupado por otra aplicación, o con el programa ya abierto, el arranque fallaba sin explicar la causa. | Un segundo doble clic abre otra ventana sobre el servidor ya en marcha; si el puerto es de otro programa, un cuadro de diálogo lo explica. `/health` identifica a ParkingManager. | `test_port_already_in_use…`, `test_a_second_launch_reuses…` |

### Respaldo en Google Sheets (`cloud_sync/AppsScript.gs`)

* **Bloqueo de escritura** (`LockService`): dos sesiones simultáneas ya no pueden
  crear filas duplicadas ni pisarse.
* **Pestaña propia "Sesiones":** agregar otras pestañas (gráficos, la hoja de
  respuestas del Formulario…) ya no desvía el respaldo. Si ya usabas la primera
  pestaña con el encabezado de ParkingManager, se sigue usando.
* **Columnas de texto:** Google Sheets convertía las fechas ISO en fechas (y
  desplazaba la hora según la zona horaria de la hoja) y evaluaba como fórmula
  cualquier valor que empezara por `=`.

> **Para actualizar:** pega el nuevo `AppsScript.gs` conservando tu `SHARED_SECRET`
> y publica una **nueva versión** (*Implementar → Administrar implementaciones →
> Editar → Nueva versión*). La URL no cambia.

### Mejoras pequeñas

* El panel resuelve la ocupación de los 20 espacios con una sola consulta.
* El servidor usa el arranque moderno de FastAPI (`lifespan`) en lugar de `on_event`.
* Los mensajes nuevos del servidor (límite de intentos, fecha inválida, tarifa en uso…) se traducen en el panel.
* Versión 1.1.0 en la API.

### Novedades

* **Formulario de Google + Hoja de cálculo** de registro: `cloud_sync/CreateGoogleForm.gs`
  y guía en `FORMULARIO_GOOGLE.md`.
* **`scripts/make_qr.py`:** genera el QR de cualquier enlace (por ejemplo, el del Formulario).
* **Pruebas automáticas** (`python -m pytest`): 28 pruebas con un servidor real,
  más pruebas de los scripts de Google con simuladores de Hojas y Formularios.
* **GitHub Actions** (`.github/workflows/ci.yml`): pruebas en cada cambio, compilación
  del `.exe` en Windows con prueba de arranque y publicación de versiones. Guía: `GITHUB.md`.
* `python desktop_app.py --headless` arranca solo el servidor (útil para probar).

## Qué NO se pudo comprobar en este entorno

* **Windows real:** las pruebas y la compilación de prueba se hicieron en Linux. El
  comportamiento de WebView2 (ventana, "Guardar como") y del cortafuegos de Windows
  se confirma con la primera ejecución en GitHub Actions y abriendo el `.exe`.
* **Google real:** `AppsScript.gs` y `CreateGoogleForm.gs` se probaron contra
  simuladores de las APIs de Google, no contra tu cuenta.

## Opciones de mejora que **no** se implementaron (decisión tuya)

Son cambios de negocio o de alcance, por eso no se tocaron sin preguntar:

1. **Minutos de gracia** (por ejemplo, 10-15 min gratis) y **tope diario** o tarifa
   fija por 24 h: hoy una estancia de 60 min + 1 s cobra dos horas y una tarifa fija
   cobra lo mismo por 1 día que por 3.
2. **Obligar a cambiar el PIN por defecto** (`admin` / `1234`) en el primer inicio de sesión.
3. **Copia de seguridad local automática** de `parking.db` (diaria, con las últimas N copias).
4. **Registro de auditoría:** quién asignó, cobró o canceló cada sesión (importante con varios turnos).
5. **Caducidad automática de registros pendientes** (por ejemplo, 30 min sin asignar).
6. **Dirección fija para el QR:** el programa detecta la IP del PC; si el router la cambia
   (DHCP), el QR impreso deja de funcionar. Opciones: reservar la IP en el router o poder
   escribir un nombre/IP manual en Configuración.
7. **Importar las respuestas del Formulario** a la lista de pendientes del programa.
8. **Símbolo de moneda:** el panel usa `$` fijo e ignora el ajuste de moneda.
9. **Exportar a PDF** (CSV y Excel ya existen).
10. **Traducción de errores del servidor** desde el propio servidor (hoy se reconocen por patrón en la pantalla).
11. **Firma de código** del `.exe` para quitar el aviso de SmartScreen.
