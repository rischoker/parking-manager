@echo off
REM ParkingManager -- first-time setup on Windows.
REM Creates a virtual environment, installs dependencies, and initializes
REM the database with 20 parking spaces, default pricing, and default
REM schedules. Safe to re-run; it will not duplicate data.

REM Always operate from the folder this script itself lives in, regardless
REM of how it was launched (double-click, typed path from a Command Prompt
REM opened elsewhere, drag-and-drop). Without this, running the script from
REM a different working directory silently creates .venv in the WRONG
REM place and then can't find requirements.txt, app\, etc.
cd /d "%~dp0"

setlocal enabledelayedexpansion

REM --- Verify Python actually WORKS, not just that a file named python.exe
REM     exists. Windows ships a placeholder python.exe that does nothing
REM     but print a Microsoft Store message whenever no real Python is on
REM     PATH -- "where python" finds that placeholder file too (it's a
REM     real file, it just doesn't work), so checking for its existence
REM     alone isn't enough and silently lets every step below fail while
REM     still claiming success at the end. This checks that running it
REM     actually reports a Python version instead.
set PYTHON_OK=0
for /f "delims=" %%v in ('python --version 2^>^&1') do (
    echo %%v | findstr /B /C:"Python " >nul && set PYTHON_OK=1
)
if "!PYTHON_OK!"=="0" (
    echo ============================================================
    echo Python was not found -- or "python" on this PC currently
    echo points to a broken Microsoft Store shortcut instead of a
    echo real Python installation. This is a common Windows quirk,
    echo not a problem with this project.
    echo.
    echo Fix:
    echo   1. Go to https://www.python.org/downloads/ and download Python
    echo      ^(3.11 or newer^).
    echo   2. Run the installer. On the FIRST screen, check the box
    echo      "Add python.exe to PATH" before clicking Install Now.
    echo   3. Close this Command Prompt completely and open a NEW one --
    echo      PATH changes don't apply to windows already open.
    echo   4. Run setup_windows.bat again.
    echo ============================================================
    pause
    exit /b 1
)
echo === Found a working Python: ===
python --version

echo === Creating virtual environment ^(.venv^) ===
python -m venv .venv
if not exist ".venv\Scripts\python.exe" (
    echo.
    echo Virtual environment creation failed -- .venv\Scripts\python.exe
    echo was not created. Scroll up for the actual error from Python above.
    pause
    exit /b 1
)

echo === Activating virtual environment ===
call .venv\Scripts\activate.bat

echo === Installing dependencies ^(this can take a few minutes^) ===
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo "pip install" failed -- scroll up to see which package and why.
    echo A common cause is no internet connection on this machine.
    pause
    exit /b 1
)

echo === Initializing database ===
python -m app.seed_data
if errorlevel 1 (
    echo.
    echo Database initialization failed -- scroll up for the actual error.
    pause
    exit /b 1
)

echo.
echo Setup complete.
echo   - To run the app now:            run_dev.bat
echo   - To build ParkingManager.exe:    build_windows.bat
echo.
pause
