# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller build spec for ParkingManager.
#
# MUST be run on Windows (PyInstaller does not cross-compile: a build run on
# Linux produces a Linux binary, not a .exe). See BUILD_WINDOWS.md.
#
#   pyinstaller ParkingManager.spec
#
# Output: dist/ParkingManager/ParkingManager.exe  (onedir build -- see notes
# in BUILD_WINDOWS.md for why onedir is recommended over onefile here).

import sys
from pathlib import Path

block_cipher = None
PROJECT_ROOT = Path(SPECPATH)

a = Analysis(
    ['desktop_app.py'],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=[
        (str(PROJECT_ROOT / 'desktop_ui'), 'desktop_ui'),
        (str(PROJECT_ROOT / 'mobile_ui'), 'mobile_ui'),
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ParkingManager',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,          # no terminal window; it's a GUI app
    icon=None,               # put an .ico path here if you have one
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='ParkingManager',
)
