@echo off
REM Builds ParkingManager.exe using PyInstaller. Run this on a Windows
REM machine (PyInstaller does not cross-compile between operating systems).
cd /d "%~dp0"
if not exist ".venv\Scripts\activate.bat" (
    echo No virtual environment found. Run setup_windows.bat first.
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat

echo === Cleaning previous build ===
rmdir /s /q build 2>nul
rmdir /s /q dist 2>nul

echo === Building with PyInstaller ===
pyinstaller ParkingManager.spec

echo.
if exist dist\ParkingManager\ParkingManager.exe (
    echo Build succeeded:
    echo   dist\ParkingManager\ParkingManager.exe
    echo.
    echo Copy the ENTIRE "dist\ParkingManager" folder to wherever you want to
    echo run the app from -- ParkingManager.exe needs the other files next to
    echo it. Create a desktop shortcut to the .exe inside that folder.
) else (
    echo Build did not produce an exe -- check the output above for errors.
)
echo.
pause
