#!/bin/sh
# Doble clic para abrir Panorama de Cartera en macOS (en Linux: ./iniciar.command).
# Si no hay Node.js 18+ instalado, descarga una copia oficial portable en .runtime/node/.
set -u
cd "$(dirname "$0")" || exit 1

has_node18() {
  "$1" -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" >/dev/null 2>&1
}

NODE_BIN=""
LOCAL_NODE=".runtime/node/bin/node"

# 1) Usa Node.js del sistema si existe y es versión 18 o superior.
if command -v node >/dev/null 2>&1 && has_node18 node; then
  NODE_BIN="node"
# 2) Si no, usa el Node.js portable ya descargado en esta carpeta.
elif [ -x "$LOCAL_NODE" ] && has_node18 "$LOCAL_NODE"; then
  NODE_BIN="$LOCAL_NODE"
fi

# 3) Si tampoco existe, descarga Node.js LTS oficial portable verificando SHA-256.
if [ -z "$NODE_BIN" ]; then
  OS_RAW="$(uname -s)"
  ARCH_RAW="$(uname -m)"
  case "$OS_RAW" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *)
      echo "Sistema operativo no soportado para descarga automática ($OS_RAW)."
      echo "Instala Node.js 18+ (LTS) desde https://nodejs.org y vuelve a intentarlo."
      exit 1
      ;;
  esac
  case "$ARCH_RAW" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)
      echo "Arquitectura no soportada para descarga automática ($ARCH_RAW)."
      echo "Instala Node.js 18+ (LTS) desde https://nodejs.org y vuelve a intentarlo."
      exit 1
      ;;
  esac

  if [ "$OS" = "darwin" ]; then
    FILE_KEY="osx-${ARCH}-tar"
  else
    FILE_KEY="linux-${ARCH}"
  fi

  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    echo "Faltan curl o tar para descargar Node.js automáticamente."
    echo "Instala Node.js 18+ (LTS) desde https://nodejs.org y vuelve a intentarlo."
    exit 1
  fi

  if command -v shasum >/dev/null 2>&1; then
    HASH_CMD="shasum -a 256"
  elif command -v sha256sum >/dev/null 2>&1; then
    HASH_CMD="sha256sum"
  else
    echo "No se encontró shasum ni sha256sum para verificar la descarga."
    echo "Instala Node.js 18+ (LTS) desde https://nodejs.org y vuelve a intentarlo."
    exit 1
  fi

  echo ""
  echo "  No se ha encontrado Node.js 18+ en este ordenador."
  echo "  Preparando Node.js LTS oficial en modo portable (solo la primera vez)..."
  echo "  No necesita permisos de administrador ni instala nada en el sistema."
  echo ""

  TMP_DIR=".runtime/tmp"
  rm -rf "$TMP_DIR"
  mkdir -p "$TMP_DIR"
  trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

  echo "  [1/3] Consultando la última versión LTS en nodejs.org..."
  VERSION="$(curl -fsSL --connect-timeout 20 https://nodejs.org/dist/index.tab | awk -F '\t' -v key="$FILE_KEY" '
    NR > 1 && $10 != "" && $10 != "-" && $10 != "false" {
      n = split($3, f, ",")
      for (i = 1; i <= n; i++) {
        if (f[i] == key) { print $1; exit }
      }
    }
  ')"

  case "$VERSION" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *)
      echo "  Error: no se pudo determinar la versión LTS en nodejs.org."
      echo "  Instala Node.js (LTS) manualmente desde https://nodejs.org y vuelve a intentarlo."
      exit 1
      ;;
  esac

  TAR_NAME="node-${VERSION}-${OS}-${ARCH}.tar.gz"
  BASE_URL="https://nodejs.org/dist/${VERSION}"
  EXPECTED_HASH="$(curl -fsSL --connect-timeout 20 "${BASE_URL}/SHASUMS256.txt" | awk -v name="$TAR_NAME" '$2 == name || $2 == "*"name { print tolower($1); exit }')"
  if [ -z "$EXPECTED_HASH" ]; then
    echo "  Error: no se encontró la suma SHA-256 de ${TAR_NAME}."
    exit 1
  fi

  echo "  [2/3] Descargando Node.js ${VERSION} (${OS}-${ARCH}) desde nodejs.org..."
  if ! curl -fSL --connect-timeout 20 -o "${TMP_DIR}/${TAR_NAME}" "${BASE_URL}/${TAR_NAME}"; then
    echo "  Error al descargar Node.js. Comprueba tu conexión o instálalo desde https://nodejs.org."
    exit 1
  fi

  echo "  [3/3] Verificando integridad (SHA-256) y extrayendo node..."
  ACTUAL_HASH="$($HASH_CMD "${TMP_DIR}/${TAR_NAME}" | awk '{ print tolower($1) }')"
  if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
    echo "  Error: la verificación SHA-256 no coincide. Descarga descartada por seguridad."
    exit 1
  fi

  mkdir -p "${TMP_DIR}/extract"
  PREFIX="node-${VERSION}-${OS}-${ARCH}"
  if ! tar -xzf "${TMP_DIR}/${TAR_NAME}" -C "${TMP_DIR}/extract" --strip-components=1 "${PREFIX}/bin/node" "${PREFIX}/LICENSE"; then
    echo "  Error al extraer Node.js."
    exit 1
  fi

  if ! "${TMP_DIR}/extract/bin/node" -v >/dev/null 2>&1; then
    echo "  Error: el binario de Node.js descargado no se pudo ejecutar."
    exit 1
  fi

  rm -rf ".runtime/node"
  mv "${TMP_DIR}/extract" ".runtime/node"
  rm -rf "$TMP_DIR"
  trap - EXIT INT TERM

  echo "  Listo: Node.js $("$LOCAL_NODE" -v) guardado en .runtime/node/"
  echo ""
  NODE_BIN="$LOCAL_NODE"
fi

exec "$NODE_BIN" server.js --open
