@echo off
rem Crea al lado de esta carpeta una copia de la aplicacion SIN tus datos, para darsela a otra persona.
setlocal
cd /d "%~dp0"

set "NODE_EXE="
set "LOCAL_NODE=.runtime\node\node.exe"

where node >nul 2>nul
if errorlevel 1 goto checklocal
node -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
if not errorlevel 1 (
  set "NODE_EXE=node"
  goto run
)

:checklocal
if exist "%LOCAL_NODE%" (
  "%LOCAL_NODE%" -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >nul 2>nul
  if not errorlevel 1 (
    set "NODE_EXE=.runtime\node\node.exe"
    goto run
  )
)

echo.
echo No se encuentra Node.js 18+. Abre iniciar.bat una vez (lo descarga automaticamente)
echo o instalalo desde https://nodejs.org (version LTS).
echo.
pause
exit /b 1

:run
"%NODE_EXE%" scripts\copia-para-compartir.js
echo.
pause
exit /b %errorlevel%
