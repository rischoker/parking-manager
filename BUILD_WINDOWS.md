# Building ParkingManager.exe on Windows

PyInstaller does not cross-compile: a build run on Linux or Mac produces a
Linux/Mac binary, not a `.exe`. **This step must be done on a real Windows
10/11 machine.** Everything else (all the source code, the database logic,
the pricing engine, the whole UI) was already built and tested for you --
this is just the final "shrink-wrap into an .exe" step.

## Don't have a Windows PC handy? Let GitHub build it

The repository includes a GitHub Actions workflow
(`.github/workflows/ci.yml`) that runs the automated tests and builds
`ParkingManager.exe` on a Windows machine hosted by GitHub, then starts the
built `.exe` in `--headless` mode and checks that it answers before
accepting the build. See **GITHUB.md** (in Spanish) for how to turn it on and
download the result. The manual steps below produce the same thing.

## Prerequisites

- Windows 10 (21H2+) or Windows 11.
- [Python 3.11 or newer](https://www.python.org/downloads/) -- during
  install, check **"Add python.exe to PATH"**.
- **Microsoft Edge WebView2 Runtime** -- this is what actually renders the
  dashboard inside the native window. It comes preinstalled on all current
  Windows 10/11 machines (it ships with Windows Update / Edge). If a
  machine somehow doesn't have it, grab the "Evergreen Bootstrapper" from
  https://developer.microsoft.com/microsoft-edge/webview2/ -- it's a ~2MB
  installer.
- No internet connection is required to *run* the finished app. You do need
  internet once, on the build machine, to `pip install` dependencies.

## Step 1 -- First-time setup

Copy the whole `parking-manager` folder onto the Windows machine, open it,
and double-click:

```
setup_windows.bat
```

This creates a `.venv` virtual environment, installs everything from
`requirements.txt`, and initializes the database (20 spaces, default
pricing rules, default schedules).

## Step 2 -- Try it before packaging

```
run_dev.bat
```

This opens the exact same admin dashboard a packaged `.exe` would, running
straight from source. Use this to confirm everything works and to try out
the QR flow from your phone (see the main README's "How the administrator
uses the system" section) before spending time on a build.

## Step 3 -- Build the executable

```
build_windows.bat
```

This runs `pyinstaller ParkingManager.spec` and produces:

```
dist\ParkingManager\ParkingManager.exe
dist\ParkingManager\...  (supporting files -- DLLs, the bundled desktop_ui/
                           and mobile_ui/ folders, the Python runtime, etc.)
```

**Copy the entire `dist\ParkingManager` folder** to wherever you want to run
the app from (e.g. `C:\ParkingManager`). `ParkingManager.exe` needs the
other files in that folder next to it -- don't move just the `.exe` by
itself. Create a shortcut to `ParkingManager.exe` on the Desktop or in the
Start Menu for daily use.

### Why "onedir" instead of a single-file "onefile" exe?

The included `.spec` builds a folder (`onedir`), not a single-file exe.
Single-file builds re-extract themselves to a temp folder on *every*
launch, which is slower and -- more importantly -- some antivirus tools
flag self-extracting exes as suspicious. A onedir build launches instantly
and is much less likely to trip Windows Defender / SmartScreen heuristics.
If you'd still rather have a single file, add `--onefile` when running
PyInstaller manually instead of using the provided `.spec`.

## First launch

- **Windows Firewall will show a prompt** the first time you launch --
  choose **"Allow access"** for Private networks. This is expected and
  required: it's what lets phones on your Wi-Fi reach the QR registration
  page. (It is *not* needed for, and doesn't affect, the admin-only
  protection -- that's enforced separately, in software, regardless of the
  firewall; see the main README's Security section.)
- **SmartScreen may warn "Windows protected your PC"** the first time you
  run an exe from an unrecognized publisher, because this build isn't
  code-signed. Click "More info" -> "Run anyway". This is normal for
  any unsigned app and only appears once. If you want to remove this
  warning permanently, you'd need to purchase a code-signing certificate
  and sign `ParkingManager.exe` -- outside the scope of this project but a
  reasonable next step for real deployment.
- Default admin PIN is **1234** -- change it immediately under
  Settings -> Administrator PIN.

## Where the data lives

The database is created at:

```
%APPDATA%\ParkingManager\parking.db
```

(typically `C:\Users\<you>\AppData\Roaming\ParkingManager\parking.db`) --
NOT inside the `dist\ParkingManager` folder. This means you can rebuild or
replace the `.exe` at any time without losing data, and it survives
reinstalls. To fully reset the app, close it and delete the
`%APPDATA%\ParkingManager` folder.

## Rebuilding after you change the code

Just re-run `build_windows.bat`. It clears the previous `build\` and
`dist\` folders first.

## Troubleshooting

**"no se encontró Python" / "Python was not found" / a message about
installing from the Microsoft Store**, even though `setup_windows.bat`
seemed to get partway through: Windows ships a placeholder `python.exe`
that exists as a real file (so simple existence checks find it) but does
nothing except print that message -- it shows up whenever no real Python
installation is on PATH. Install Python from
[python.org/downloads](https://www.python.org/downloads/), **check "Add
python.exe to PATH" on the installer's first screen**, then close and
reopen the Command Prompt (PATH changes don't apply to windows already
open) before running `setup_windows.bat` again. `setup_windows.bat`
actively checks for this specific situation and will stop with a clear
message rather than silently failing through every remaining step.

**"Failed to execute script desktop_app"** or a missing-module error on
launch: a dependency wasn't picked up automatically. Add it to
`hiddenimports` in `ParkingManager.spec` and rebuild. This is common with
packages (like `pywebview`) that load platform backends dynamically.

**The window opens but shows a blank/white page**: the WebView2 Runtime is
probably missing or outdated -- install it from the link above.

**Antivirus deletes or quarantines the exe right after building**: this is
a known PyInstaller false-positive pattern (the bootloader stub looks
similar to some malware packers to heuristic scanners). Add an exclusion
for the `dist\ParkingManager` folder in your antivirus, or use Windows
Defender's "Allow on device" option from the notification.

**Port 8000 already in use**: another program is using it, and
ParkingManager now says so in a message box instead of failing silently. Set
`PARKINGMANAGER_PORT` as a system environment variable to a free port
(e.g. `8001`) before launching. (Double-clicking ParkingManager while it is
already running just opens a second window on the running server.)

**The app closes or does nothing on launch**: look at
`%APPDATA%\ParkingManager\parkingmanager.log` -- the windowed `.exe` has no
console, so anything it would have printed is written there. Running
`ParkingManager.exe --headless` from a terminal starts only the server (no
window), which is the quickest way to tell a server problem from a window
problem.
