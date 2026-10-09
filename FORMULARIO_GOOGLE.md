# Formulario de Google + Hoja de cálculo (registro de clientes)

Esta guía crea, en **tu** cuenta de Google, un **Formulario** para que el cliente
registre su vehículo y una **Hoja de cálculo** donde quedan guardadas todas las
respuestas. Es gratis y se hace una sola vez (unos 2 minutos).

> **Por qué hay que ejecutar un script y no basta con "te lo dejo creado":** un
> Formulario de Google solo puede crearse desde dentro de la cuenta de su
> dueño. El script `cloud_sync/CreateGoogleForm.gs` lo construye por ti con un
> clic; no envía nada a nadie, solo crea el Formulario y la Hoja en tu Drive.

## Qué obtienes

| Pregunta | Reglas |
|---|---|
| Nombre completo | Obligatoria. No puede empezar con `=`, `+`, `-` o `@` (así nunca se interpreta como fórmula). |
| Placa del vehículo | Obligatoria. Solo letras, números y guiones (3 a 12 caracteres). |
| Teléfono (opcional) | Solo números, espacios, `+`, `-` y paréntesis. |
| Tratamiento de datos | Casilla obligatoria. **Revisa el texto** (variable `consentText` en el script) y ajústalo a tu política de datos. |

* **La hora de entrada la pone Google**, no el cliente: la primera columna de la
  Hoja ("Marca temporal") se sella en los servidores de Google en el instante en
  que la persona pulsa *Enviar*, y nadie puede editarla.
* El cliente **no puede** elegir espacio, tarifa ni monto: el Formulario
  sencillamente no tiene esos campos.
* Nadie ve las respuestas de los demás (`setPublishingSummary(false)`), y no se
  pide correo electrónico ni inicio de sesión.

## Paso a paso

1. Entra a <https://script.google.com> con la cuenta de Google donde quieres que
   queden el Formulario y la Hoja → **Nuevo proyecto**.
2. Borra el código de ejemplo y pega **todo** el contenido de
   `cloud_sync/CreateGoogleForm.gs`. Guarda (Ctrl+S).
3. (Opcional) Cambia el nombre del negocio y los textos en el bloque `CONFIG`
   del principio.
4. Arriba, en el selector de funciones, elige **`crearFormularioDeRegistro`** y
   pulsa **Ejecutar**.
5. Google pedirá permisos. Es el aviso normal para un script que tú mismo pegaste:
   **Revisar permisos → tu cuenta → Avanzado → Ir a (nombre del proyecto) →
   Permitir**. (Pide acceso a Formularios, Hojas de cálculo y Drive, solo para tus
   propios archivos.)
6. Abre **Registro de ejecución** (abajo). Verás tres enlaces:
   * **ENLACE PARA COMPARTIR (QR)** → el que reciben los clientes.
   * **ENLACE PARA EDITAR EL FORMULARIO** → para cambiar preguntas o textos.
   * **HOJA DE GOOGLE CON LAS RESPUESTAS** → ahí caen los registros, una fila por envío.
7. Haz una prueba: abre el enlace para compartir desde tu teléfono, envía un
   registro y comprueba que aparece la fila en la Hoja.

Si ejecutas la función otra vez no crea un segundo formulario: te vuelve a mostrar
los enlaces (también puedes ejecutar `mostrarEnlaces`). Con `cerrarFormulario` /
`abrirFormulario` dejas de recibir (o vuelves a recibir) respuestas, por ejemplo
fuera de horario.

## Hacer el QR del Formulario

```
python scripts/make_qr.py "https://docs.google.com/forms/d/e/XXXX/viewform" formulario.png
```

Imprime `formulario.png` y pégalo en la entrada. (Cualquier generador de QR
gratuito sirve igual.)

## Cómo encaja con ParkingManager (léelo antes de decidir cómo usarlo)

El programa tiene su **propia** página de registro por QR (`/mobile/register`),
y esa sigue siendo la entrada principal porque hace cosas que un Formulario de
Google **no puede** hacer:

| | Registro propio (QR del programa) | Formulario de Google |
|---|---|---|
| Hora de entrada | La estampa el servidor del parqueadero | La estampa Google |
| Aparece solo en la pantalla del vigilante | **Sí** (cola de pendientes) | **No** – se lee en la Hoja |
| El cliente ve su tarifa en vivo | **Sí** | **No** (un Formulario no puede mostrar datos personales después de enviar) |
| Funciona sin Wi-Fi del local | Con el túnel/Remote Access | **Sí**, desde cualquier red/datos móviles |
| Datos en Google Sheets | Con el respaldo en la nube (CLOUD_BACKUP.md) | **Sí**, directamente |

Usos recomendados:

* **Plan B / sin Wi-Fi:** QR del Formulario pegado junto al QR principal, para
  cuando el equipo del puesto esté apagado o el cliente no logre conectarse.
  El vigilante lee la fila nueva en la Hoja y asigna el espacio como siempre.
* **Registro de datos en Sheets** para quien quiere todo en Google (reportes,
  filtros, compartir con un contador).

Si quieres que las respuestas del Formulario **aparezcan solas como "pendientes"
dentro del programa** (importándolas desde la Hoja), eso es una ampliación
aparte: se puede hacer, pero esos clientes seguirían sin ver su tarifa en vivo.
Dime si lo quieres y lo agrego.

## Seguridad y privacidad

* El enlace del Formulario es público (quien lo tenga puede enviar un registro),
  igual que el QR del programa. Por eso el programa nunca confía en el cliente
  para hora, espacio ni monto, y el vigilante confirma cada ingreso.
* La Hoja contiene nombres, placas y teléfonos: **no la compartas públicamente**;
  compártela solo con quien la necesite.
* Si en algún momento recibes envíos de broma/spam, ejecuta `cerrarFormulario`
  o activa en el Formulario *Limitar a 1 respuesta* (obliga a iniciar sesión).
* No pongas esta Hoja a recibir el respaldo en la nube (`AppsScript.gs`) a menos
  que dejes ese script usando su pestaña **"Sesiones"** (es lo que hace por
  defecto); así el respaldo nunca se mezcla con la pestaña de respuestas.
