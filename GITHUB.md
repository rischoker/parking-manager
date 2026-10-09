# Subir el proyecto a GitHub (y compilar el .exe allí)

Esta guía responde a **"¿qué necesito para crear el repositorio?"** y deja el
proyecto listo para que GitHub pruebe el código y compile `ParkingManager.exe`
por ti en cada cambio (no necesitas Python ni PyInstaller en tu PC).

## Qué necesito de ti (resumen)

| # | Dato | Recomendación |
|---|---|---|
| 1 | **Cuenta de GitHub** | La que ya usas (`rischoker`). Confírmame que es esa. |
| 2 | **Nombre del repositorio** | `parking-manager` |
| 3 | **Visibilidad** | **Privado.** El código incluye la lógica de tarifas y de seguridad; no hay razón para exponerlo. |
| 4 | **Un repositorio vacío creado por ti** | En GitHub: *New repository* → **sin** README, **sin** .gitignore, **sin** licencia (el proyecto ya trae los suyos). |
| 5 | **Permiso de acceso para mí** | Que la aplicación de GitHub conectada a Claude tenga acceso a ese repositorio (*Settings → Applications → Installed GitHub Apps → Configure → Repository access*). Con eso puedo subir el código y abrir el flujo de compilación yo mismo. |

Un repositorio **no** se puede crear "desde fuera" sin una de estas dos cosas:
la conexión de GitHub con acceso de escritura (punto 5) o un token tuyo. **No me
pegues contraseñas ni tokens en el chat**; si prefieres hacerlo tú, abajo está
el procedimiento completo, son 5 comandos.

> **Estado actual:** la herramienta de línea de comandos de GitHub (`gh`) en mi
> entorno no tiene una sesión válida, así que por ahora no puedo crear el
> repositorio por mi cuenta. La vía más corta es que tú crees el repositorio
> vacío (punto 4) y me des acceso (punto 5).

## Público o privado: qué cambia

| | Privado (recomendado) | Público |
|---|---|---|
| Quién ve el código | Solo tú y a quien invites | Cualquiera |
| Pruebas y compilación (GitHub Actions) | Sí. Cuenta contra los 2 000 min/mes del plan gratuito (una compilación de Windows gasta unos 20 min contados) | Sí, sin límite práctico |
| Descargar el `.exe` desde *Releases* | Solo con tu sesión iniciada | Cualquiera |
| **Página de estado en GitHub Pages** | **No** (en el plan gratuito Pages exige repositorio público) | Sí |

**Cómo combinar las dos cosas:** deja `parking-manager` privado y, **solo si
quieres la página de estado para clientes** (`GITHUB_PAGES_STATUS.md`), crea un
segundo repositorio **público** llamado `parking-status` con el contenido de la
carpeta `github_pages/` (nada más). Ese repositorio es público por naturaleza,
así que lo único que debe contener es la página y la dirección `/exec` de tu
Apps Script, que ya es pública para quien tenga un código de sesión.

## Qué NO debe subirse nunca

El `.gitignore` incluido ya excluye lo habitual (`*.db`, `*.log`, `.venv/`,
`build/`, `dist/`, `.devdata/`). Además:

* **La base de datos real** (`%APPDATA%\ParkingManager\parking.db`) vive fuera de
  la carpeta del proyecto: no la copies dentro.
* **El `SHARED_SECRET` de tu Apps Script** y el PIN de cualquier usuario. El
  secreto solo existe en el editor de Apps Script y dentro del programa
  (*Configuración → Respaldo en la nube*); no lo pegues en ningún archivo del
  proyecto.
* **El enlace de edición de tu Formulario y tu Hoja** (solo se comparte el enlace
  de *respuesta* del Formulario, que es el del QR).

Si alguna vez subes un secreto por error, no basta con borrarlo en un commit
nuevo (queda en el historial): **cámbialo** (nuevo `SHARED_SECRET`, nueva
implementación de Apps Script) y recién después limpia el historial.

## Subir el código tú mismo (5 comandos)

1. Instala **Git for Windows**: <https://git-scm.com/download/win> (todo por defecto).
2. Crea en GitHub el repositorio vacío `parking-manager` (privado).
3. Abre una terminal (PowerShell) **dentro de la carpeta del proyecto** y ejecuta:

```powershell
git init -b main
git add .
git commit -m "ParkingManager v1.1"
git remote add origin https://github.com/rischoker/parking-manager.git
git push -u origin main
```

La primera vez Git abre el navegador para iniciar sesión en GitHub (Git
Credential Manager); no hay que escribir contraseñas en la terminal.

Si Git protesta con *"Please tell me who you are"*, ejecuta antes una sola vez:

```powershell
git config --global user.name "Tu Nombre"
git config --global user.email "tu-correo@ejemplo.com"
```

## Qué pasa después de subirlo

El archivo `.github/workflows/ci.yml` se activa solo y, en la pestaña **Actions**
del repositorio, ejecuta:

1. **Pruebas automáticas** (Linux, ~1 min): API, seguridad, migración de base de
   datos, empaquetado, motor de tarifas, sintaxis de todo el JavaScript y los
   scripts de Google contra un simulador de Hojas/Formularios.
2. **Compilar ParkingManager.exe** (Windows, ~5-10 min): PyInstaller, y una
   **prueba de humo**: arranca el `.exe` en modo `--headless`, comprueba que
   `/health` responde y que se sirven las pantallas de administración y de
   registro. Si el `.exe` no arranca, la compilación falla y se imprime el
   archivo de registro.
3. **Publicar versión** (solo con etiquetas `v*`): adjunta `ParkingManager-windows.zip`
   a una *Release* con notas automáticas.

Esta prueba de humo es importante: el entorno en el que preparé esta revisión
es Linux, así que **la primera ejecución en GitHub es la verificación real del
`.exe` de Windows**. Si algo falla, pásame el registro rojo de Actions y lo
corrijo.

### Sacar el .exe

* **De cualquier compilación:** *Actions → (la ejecución) → Artifacts →
  ParkingManager-windows*.
* **Como versión numerada:**

```powershell
git tag v1.1.0
git push origin v1.1.0
```

  El zip aparece en la pestaña **Releases**. Descomprímelo y abre
  `ParkingManager\ParkingManager.exe`.

Windows SmartScreen avisará la primera vez porque el programa no está firmado
(ver `BUILD_WINDOWS.md`): *Más información → Ejecutar de todos modos*.

## Trabajar con ramas (recomendado)

Para no romper la versión que funciona:

```powershell
git switch -c cambio-tarifas     # trabajas en una rama
# ...cambios...
git add . && git commit -m "Ajuste de tarifas"
git push -u origin cambio-tarifas
```

Abre un *Pull request* en GitHub: las pruebas se ejecutan solas y solo
cuando salen en verde lo unes a `main`. En *Settings → Branches* puedes exigir
que las pruebas pasen antes de unir.

## Los commits que haga yo

Cuando yo subo cambios al repositorio, cada commit termina con una línea
`Co-Authored-By: Claude …` y un enlace a la sesión, para que quede claro qué
cambió y por qué. Si no los quieres, dímelo y los omito.

## Lista de comprobación

- [ ] Cuenta confirmada (`rischoker`)
- [ ] Repositorio `parking-manager` creado, **vacío** y privado
- [ ] Acceso de la aplicación de GitHub de Claude a ese repositorio (o la subida con los 5 comandos)
- [ ] *Actions* en verde (pruebas + compilación de Windows)
- [ ] Etiqueta `v1.1.0` para generar la primera *Release*
- [ ] (Opcional) repositorio público `parking-status` para la página de estado
