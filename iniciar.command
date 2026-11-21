#!/bin/sh
# Doble clic para abrir Panorama de Cartera en macOS (en Linux: ./iniciar.command).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "No se encuentra Node.js. Instálalo desde https://nodejs.org (versión LTS) y vuelve a intentarlo."
  exit 1
fi
exec node server.js --open
