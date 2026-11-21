@echo off
rem Doble clic para abrir Panorama de Cartera en Windows.
rem Si no hay Node.js 18+ en el equipo, descarga una copia oficial portable en .runtime\node\.
setlocal
cd /d "%~dp0"

set "NODE_EXE="
set "LOCAL_NODE=.runtime\node\node.exe"

rem 1) Usa Node.js del sistema si existe y es version 18 o superior.
where node >nul 2>nul
if errorlevel 1 goto checklocal
node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
if not errorlevel 1 (
  set "NODE_EXE=node"
  goto run
)

:checklocal
rem 2) Si no, usa el Node.js portable ya descargado en esta carpeta.
if not exist "%LOCAL_NODE%" goto install
"%LOCAL_NODE%" -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
if not errorlevel 1 (
  set "NODE_EXE=.runtime\node\node.exe"
  goto run
)

:install
rem 3) Si tampoco existe, descarga Node.js LTS oficial portable en .runtime\node\.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\instalar-node.ps1"
if errorlevel 1 goto nonode
if not exist "%LOCAL_NODE%" goto nonode
set "NODE_EXE=.runtime\node\node.exe"

:run
"%NODE_EXE%" server.js --open
if errorlevel 1 pause
exit /b %errorlevel%

:nonode
echo.
echo No se ha podido preparar Node.js automaticamente.
echo Si no tienes conexion a internet ahora, o prefieres instalarlo a mano,
echo descargalo desde https://nodejs.org (version LTS) y vuelve a abrir este archivo.
echo.
pause
exit /b 1
