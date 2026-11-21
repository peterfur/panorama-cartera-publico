@echo off
rem Crea al lado de esta carpeta una copia de la aplicacion SIN tus datos, para darsela a otra persona.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node scripts\copia-para-compartir.js
echo.
pause
exit /b 0

:nonode
echo No se encuentra Node.js. Instalalo desde https://nodejs.org (version LTS).
pause
exit /b 1
