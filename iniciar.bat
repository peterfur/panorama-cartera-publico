@echo off
rem Doble clic para abrir Panorama de Cartera en Windows.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node server.js --open
pause
exit /b 0

:nonode
echo.
echo No se encuentra Node.js en este ordenador.
echo Instalalo desde https://nodejs.org (version LTS) y vuelve a hacer doble clic aqui.
echo.
pause
exit /b 1
