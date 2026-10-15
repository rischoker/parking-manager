# Servicio en la nube: panel de consulta, bitácora y "mi tarifa" desde cualquier lugar

Esta carpeta es el servicio que corre en internet (Cloudflare Workers + una base
de datos D1) y recibe, desde el programa del parqueadero, **cada ingreso, salida,
movimiento de mensualistas y acción del personal**. Con él obtienes:

| Para quién | Qué ve | Dónde |
|---|---|---|
| **Clientes** | Cuánto tiempo llevan y cuánto van a pagar, **sin conectarse a tu Wi-Fi** | `https://parqueadero.tudominio.co/?token=…` (el enlace sale en la pantalla del cliente) |
| **Tú (propietario)** | Todo: quién entró, a qué hora, con qué carro, a quién visita, quién lo registró; la bitácora de acciones; quién consulta el panel | `https://parqueadero.tudominio.co/monitor/` |
| **La administración** | Lo mismo que tú **excepto** la bitácora, los accesos y los teléfonos. Solo lectura | el mismo enlace, con su propia llave |

El programa del parqueadero **nunca recibe conexiones desde internet**: solo envía
datos hacia afuera. Si se cae internet, todo sigue funcionando en la caseta y los
datos se envían solos cuando vuelve.

---

## Costos

| Concepto | Costo |
|---|---|
| Cloudflare Workers + D1 (plan gratuito) | **0** |
| Dominio propio (recomendado) | aprox. **10 a 15 USD al año**, según la terminación; confirma el precio final en pantalla antes de pagar |

El plan gratuito permite 100 000 solicitudes y 100 000 escrituras en la base de
datos **por día**. El programa solo envía lo que cambia (un carro genera unas 4 a
6 escrituras en total: registro, espacio, salida y sus anotaciones en la bitácora),
así que incluso con cientos de ingresos al día se usa una fracción pequeña.

> **¿Por qué dominio propio?** Cloudflare entrega gratis una dirección tipo
> `parking-cloud.tuusuario.workers.dev`, que sirve para probar. Para el uso real
> con tus clientes es mejor un dominio tuyo: el enlace queda corto y estable, y no
> dependes de un subdominio pensado para pruebas.

---

## Lo que necesitas

1. **Una cuenta gratuita de Cloudflare** — <https://dash.cloudflare.com/sign-up>
2. **Node.js (versión LTS)** en el computador desde el que vas a publicar — <https://nodejs.org>
   (no tiene que ser el de la caseta; basta con que tenga esta carpeta del proyecto).
3. **Un dominio** (paso 1 de abajo).

Todos los comandos se escriben en **PowerShell**, dentro de la carpeta `cloud_worker`
del proyecto (en el Explorador: clic derecho dentro de la carpeta → *Abrir en Terminal*).

---

## Paso a paso (unos 30 minutos, una sola vez)

### 1. Comprar el dominio

En el panel de Cloudflare: **Domain Registration → Register Domains**, busca el
nombre que quieras (por ejemplo `miconjunto.co`) y cómpralo. Cloudflare cobra el
precio de costo, sin margen. Si ya tienes un dominio en otro lugar, también sirve:
*Add a domain* y sigue las instrucciones para apuntarlo a Cloudflare.

### 2. Instalar las herramientas

```powershell
npm install
npx wrangler login
```

`wrangler login` abre el navegador para que autorices el acceso a tu cuenta.

### 3. Crear la base de datos

```powershell
npx wrangler d1 create parking
```

Copia el `database_id` que muestra y pégalo en `wrangler.toml`, en la línea
`database_id = "..."`. Luego crea las tablas:

```powershell
npx wrangler d1 migrations apply parking --remote
```

### 4. Publicar el servicio

```powershell
npm run deploy
```

Al terminar muestra una dirección `https://parking-cloud.….workers.dev`. Ya está
publicado, pero todavía **nadie puede entrar ni enviar datos**: faltan las claves.

### 5. Crear las dos claves secretas

Necesitas dos textos largos y aleatorios. Genera cada uno con este comando
(ejecútalo dos veces):

```powershell
$b = New-Object byte[] 24; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString("x2") }) -join ""
```

Guarda **cada una en un lugar seguro** (un gestor de contraseñas) y regístralas en
Cloudflare. Cada comando te pide pegar el valor:

```powershell
npx wrangler secret put INGEST_SECRET     # la contraseña que usará el programa de la caseta
npx wrangler secret put SETUP_TOKEN       # código de un solo uso para crear tu llave de propietario
```

### 6. Conectar tu dominio

En el panel de Cloudflare: **Workers & Pages → parking-cloud → Settings → Domains &
Routes → Add → Custom domain** y escribe, por ejemplo, `parqueadero.miconjunto.co`.
Espera uno o dos minutos a que quede activo.

### 7. Crear tu llave de propietario

Abre `https://parqueadero.miconjunto.co/monitor/`. La primera vez muestra la
**Configuración inicial**: escribe tu nombre y el `SETUP_TOKEN` del paso 5.

Aparece tu **llave de propietario** (empieza por `pk_`). **Es la única vez que se
muestra**: cópiala a tu gestor de contraseñas. Con ella entras al panel.

Cuando ya entraste, borra el código de configuración, ya no hace falta:

```powershell
npx wrangler secret delete SETUP_TOKEN
```

### 8. Conectar el programa de la caseta

En ParkingManager → **Configuración → Respaldo y panel remoto (nube)**:

| Campo | Qué poner |
|---|---|
| Habilitado | ✔ |
| Dirección del servicio en la nube | `https://parqueadero.miconjunto.co/api/ingest` |
| Secreto compartido | el `INGEST_SECRET` del paso 5 |

Pulsa **Guardar**, luego **Probar conexión** (debe decir *Conexión correcta*) y
**Sincronizar ahora**. Todo el historial que ya tenías se sube solo, en unos
minutos, sin duplicarse.

### 9. Dar a los clientes el enlace "desde cualquier lugar"

En **Configuración → Página de estado**: activa la casilla y escribe
`https://parqueadero.miconjunto.co` (sin nada más). Desde ese momento la pantalla
que ve el cliente en su celular después de registrarse incluye el enlace
**"Consultar desde cualquier lugar"**: ahí ve su tiempo y su tarifa aunque ya no
esté en tu Wi-Fi, y el cobro se calcula con la misma tarifa que usa tu programa.

### 10. Dar acceso a la administración

Entra al panel con tu llave → pestaña **Accesos** → escribe el nombre de la persona
(por ejemplo *Administración — Juan Pérez*) → **Crear acceso**. Te muestra **su llave
una sola vez**: entrégasela a esa persona. Cada persona tiene su propia llave; puedes
**quitar el acceso** a cualquiera en cualquier momento y su llave deja de funcionar de
inmediato, incluso si tenía el panel abierto.

---

## Uso diario

* **Ahora:** quién está dentro, cuánto lleva, mensualistas dentro, entradas de hoy (se actualiza solo cada 20 s).
* **Registro de ingresos:** todo el historial con filtros (placa, nombre, torre/apto, a quién visita, tipo, estado, fechas) y **descarga en CSV** para Excel.
* **Mensualistas:** cada entrada y salida real, con quién la registró.
* **Bitácora** *(solo propietario)*: quién hizo qué en el programa (cobros, cambios de tarifas, usuarios, inicios de sesión fallidos…). Solo se puede consultar: nadie puede editarla ni borrarla desde aquí.
* **Accesos** *(solo propietario)*: las personas con llave y quién consultó el panel y cuándo.

Las horas son las del reloj del computador de la caseta (con su zona horaria): mantenlo
con la hora correcta.

---

## Seguridad: qué te protege y qué te toca a ti

**Ya está resuelto en el código** (y probado automáticamente):

* El panel es **solo lectura**: nadie puede crear, editar ni borrar ingresos desde internet.
* Las llaves se generan aleatorias (256 bits) y en la base de datos **solo se guarda su huella**, nunca la llave: ni siquiera con acceso a la base se pueden recuperar.
* Inicio de sesión con cookie protegida (`HttpOnly`, `Secure`, `SameSite=Strict`), vencimiento a las 12 horas, y bloqueo temporal tras 5 intentos fallidos desde la misma dirección.
* Los datos que escriben los clientes (nombres, etc.) se muestran siempre como texto, nunca se ejecutan; los CSV neutralizan fórmulas de Excel.
* Quien tiene solo el enlace de un cliente ve únicamente la placa, el espacio, las horas y la tarifa **de ese carro**: nunca su nombre, teléfono, torre/apartamento ni a quién visita.
* La administración (llave de consulta) **no ve teléfonos** ni la bitácora.
* El programa de la caseta nunca expone nada a internet.

**Te toca a ti:**

* Guarda las llaves en un gestor de contraseñas; no las mandes por chat ni correo sin cifrar.
* Crea **una llave por persona** y revoca la de quien deje de necesitarla.
* **Cambiar el secreto del programa** (si sospechas que se filtró): genera uno nuevo, `npx wrangler secret put INGEST_SECRET`, y pégalo en *Configuración → Respaldo y panel remoto* del programa.
* **Perdiste la llave de propietario:** necesitas acceso a tu cuenta de Cloudflare (por eso es la raíz de la seguridad: activa la verificación en dos pasos allí). Genera un `SETUP_TOKEN` nuevo (`npx wrangler secret put SETUP_TOKEN`), borra al propietario actual y vuelve al paso 7:

  ```powershell
  npx wrangler d1 execute parking --remote --command "DELETE FROM web_sessions WHERE viewer_id IN (SELECT id FROM viewers WHERE role='OWNER'); DELETE FROM viewer_logins WHERE viewer_id IN (SELECT id FROM viewers WHERE role='OWNER'); DELETE FROM viewers WHERE role='OWNER';"
  ```

---

## Datos personales (importante en un conjunto residencial)

Este sistema guarda **nombres, placas, torre/apartamento, a quién visita cada persona,
teléfonos (opcional) y horas de entrada y salida**. En Colombia eso son datos
personales (Ley 1581 de 2012, *Habeas Data*) y quien decide para qué se usan es el
**conjunto residencial** (responsable del tratamiento). Lo habitual es:

* Tener una **política de tratamiento de datos** y un **aviso visible** en la portería
  (y, si quieren, en el texto legal de la pantalla de registro por QR) que diga que se
  registran datos de ingreso por razones de seguridad.
* Dar acceso al panel solo a quien lo necesita (por eso las llaves individuales).
* Definir **cuánto tiempo se conservan** los registros. Para borrar la información
  anterior a una fecha (en la nube) — **esto no se puede deshacer**:

  ```powershell
  npx wrangler d1 execute parking --remote --command "DELETE FROM sessions WHERE entry_ts < '2026-01-01'; DELETE FROM monthly_events WHERE ts < '2026-01-01'; DELETE FROM audit WHERE ts < '2026-01-01';"
  ```

  (El programa de la caseta conserva su propia copia: la base `parking.db`.)

Esto es orientación práctica, no asesoría legal: conviene que la administración lo revise
con su asesor jurídico.

---

## Si algo falla

El botón **Probar conexión** del programa da el motivo:

| Mensaje | Causa y solución |
|---|---|
| `Invalid or missing secret` | El *Secreto compartido* del programa no es igual al `INGEST_SECRET` (paso 5). Vuelve a pegarlo. |
| `Connection failed …` | No hay internet en la caseta, o la dirección está mal escrita. Ábrela en el navegador: `…/api/health` debe responder `{"ok":true…}`. |
| `HTTP 404` | Falta `/api/ingest` al final de la dirección. |
| `HTTP 5xx` | Cloudflare tuvo un problema momentáneo; el programa reintenta solo cada 30 s. |
| En el panel: *Falta definir el secreto SETUP_TOKEN* | Repite `npx wrangler secret put SETUP_TOKEN`. |
| *Demasiados intentos fallidos* | Espera el tiempo indicado; el bloqueo es por dirección. |

Para ver cuánto del plan gratuito usas: panel de Cloudflare → *Workers & Pages →
parking-cloud → Metrics*, y *Storage & Databases → D1 → parking*.

---

## Actualizar a una versión nueva

```powershell
git pull                          # o copia la carpeta nueva del proyecto
npm install
npm run migrate:remote            # solo aplica los cambios de base de datos que falten
npm run deploy
```

---

## Para quien desarrolla

```powershell
npm test          # levanta el servicio en local con una base D1 vacía y corre todas las pruebas
npm run dev       # servicio local con recarga: http://127.0.0.1:8787
```

* `src/` — el Worker (`ingest.js` recibe del programa; `monitor.js` es el panel; `index.js` enruta).
* `monitor/` — la página del panel (HTML/CSS/JS sin dependencias, sin scripts en línea).
* `migrations/` — esquema de la base de datos (D1).
* `scripts/prepare-public.mjs` — arma `public/`: copia la página del cliente desde `../github_pages` (única fuente) y le añade `config.js` para que lea de este servicio en vez de Google.
* Protocolo con el programa (v2): `POST /api/ingest` con `{secret, kind: session|audit|monthly_event|ping, record}` y `Authorization: Bearer <secreto>`. Los registros llevan identificadores estables (`session_token`, `uid`): reenviar uno nunca lo duplica.
