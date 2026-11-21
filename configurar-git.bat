@echo off
rem Prepara el repositorio git de esta carpeta y lo sube a GitHub.
rem Se puede ejecutar mas de una vez: cada vez confirma y sube lo que haya cambiado.
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 goto nogit

if exist ".git" goto hasrepo
git init -b main
if errorlevel 1 goto failed

:hasrepo
git config user.name >nul 2>nul
if not errorlevel 1 goto hasname
set /p GITNAME=Tu nombre para firmar los cambios: 
git config user.name "%GITNAME%"

:hasname
git config user.email >nul 2>nul
if not errorlevel 1 goto hasemail
set /p GITEMAIL=Tu correo de GitHub: 
git config user.email "%GITEMAIL%"

:hasemail
git add -A
git diff --cached --quiet
if not errorlevel 1 goto committed
git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 goto firstcommit
git commit -m "Actualizacion de la aplicacion"
if errorlevel 1 goto failed
goto committed

:firstcommit
git commit -m "Estado inicial de la cartera"
if errorlevel 1 goto failed

:committed
git remote get-url origin >nul 2>nul
if not errorlevel 1 goto push
echo.
echo Crea un repositorio PRIVADO y VACIO en https://github.com/new
echo (sin README, sin .gitignore y sin licencia) y copia su direccion.
echo Ejemplo: https://github.com/tu-usuario/panorama-cartera.git
echo.
set /p REPOURL=Pega aqui la direccion del repositorio: 
if "%REPOURL%"=="" goto failed
git remote add origin "%REPOURL%"
if errorlevel 1 goto failed

:push
git push -u origin main
if errorlevel 1 goto failed
echo.
echo Listo: la cartera esta en GitHub. A partir de ahora, cada cambio que guardes
echo en la aplicacion queda como un commit; subelos cuando quieras con: git push
echo.
pause
exit /b 0

:nogit
echo.
echo Git no esta instalado. Descargalo de https://git-scm.com/download/win,
echo instalalo con las opciones por defecto y vuelve a ejecutar este archivo.
echo.
pause
exit /b 1

:failed
echo.
echo No se ha podido completar. Revisa el mensaje de arriba y vuelve a intentarlo.
echo.
pause
exit /b 1
