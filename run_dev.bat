@echo off
REM Runs ParkingManager directly from source (no .exe build needed).
REM Opens the same admin dashboard a packaged .exe would.
cd /d "%~dp0"
if not exist ".venv\Scripts\activate.bat" (
    echo No virtual environment found. Run setup_windows.bat first.
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat
python desktop_app.py
if errorlevel 1 pause
