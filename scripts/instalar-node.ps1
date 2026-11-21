<#
  Descarga una copia oficial y portable de Node.js LTS dentro de .runtime\node\
  para ejecutar Panorama de Cartera sin instalar nada en el sistema ni pedir
  permisos de administrador. Verifica la firma SHA-256 oficial de nodejs.org.
#>
param(
  [string]$RootDir = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
  # En PowerShell moderno TLS 1.2+ ya viene activado por defecto.
}

$RuntimeDir = Join-Path $RootDir '.runtime'
$NodeDir    = Join-Path $RuntimeDir 'node'
$NodeExe    = Join-Path $NodeDir 'node.exe'
$TmpDir     = Join-Path $RuntimeDir 'tmp'

if (Test-Path -LiteralPath $NodeExe) {
  & $NodeExe -e "process.exit(parseInt(process.versions.node,10)>=18?0:1)" *> $null
  if ($LASTEXITCODE -eq 0) {
    exit 0
  }
}

$archRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($archRaw.ToUpperInvariant()) {
  'AMD64' { $arch = 'x64' }
  'ARM64' { $arch = 'arm64' }
  'X86'   { $arch = 'x86' }
  default {
    Write-Host "Arquitectura de Windows no soportada automaticamente: $archRaw"
    exit 1
  }
}

Write-Host ''
Write-Host '  No se ha encontrado Node.js 18+ en este ordenador.'
Write-Host '  Preparando Node.js LTS oficial en modo portable (solo la primera vez)...'
Write-Host '  No necesita permisos de administrador ni instala nada en el sistema.'
Write-Host ''

try {
  Write-Host '  [1/3] Consultando la ultima version LTS en nodejs.org...'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 30
  $fileKey = "win-$arch-zip"
  $release = $index | Where-Object {
    $_.lts -and ($_.lts -ne $false) -and ($_.files -contains $fileKey)
  } | Select-Object -First 1

  if (-not $release) {
    throw "No se ha encontrado una version LTS de Node.js para Windows ($arch)."
  }

  $version = [string]$release.version
  if ($version -notmatch '^v\d+\.\d+\.\d+$') {
    throw "Version de Node.js inesperada: $version"
  }

  $zipName = "node-$version-win-$arch.zip"
  $baseUrl = "https://nodejs.org/dist/$version"

  $shasumsText = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 30).Content
  $expectedHash = $null
  foreach ($line in ($shasumsText -split "`r?`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
      if ($Matches[2].Trim() -eq $zipName) {
        $expectedHash = $Matches[1].ToLowerInvariant()
        break
      }
    }
  }
  if (-not $expectedHash) {
    throw "No se encontro la suma SHA-256 de $zipName en nodejs.org."
  }

  if (Test-Path -LiteralPath $TmpDir) {
    Remove-Item -LiteralPath $TmpDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

  $zipPath = Join-Path $TmpDir $zipName
  Write-Host "  [2/3] Descargando Node.js $version ($arch) desde nodejs.org..."
  Invoke-WebRequest -Uri "$baseUrl/$zipName" -OutFile $zipPath -UseBasicParsing -TimeoutSec 300

  Write-Host '  [3/3] Verificando integridad (SHA-256) y extrayendo node.exe...'
  $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw 'La verificacion SHA-256 no coincide. Descarga descartada por seguridad.'
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $extractDir = Join-Path $TmpDir 'extract'
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null

  $prefix = "node-$version-win-$arch/"
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    foreach ($name in @('node.exe', 'LICENSE')) {
      $entry = $zip.GetEntry($prefix + $name)
      if ($entry) {
        $dest = Join-Path $extractDir $name
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
      }
    }
  } finally {
    $zip.Dispose()
  }

  $extractedNode = Join-Path $extractDir 'node.exe'
  if (-not (Test-Path -LiteralPath $extractedNode)) {
    throw 'El paquete oficial descargado no contiene node.exe.'
  }

  $verOut = & $extractedNode -v 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "No se pudo ejecutar node.exe descargado: $verOut"
  }

  if (Test-Path -LiteralPath $NodeDir) {
    Remove-Item -LiteralPath $NodeDir -Recurse -Force
  }
  Move-Item -LiteralPath $extractDir -Destination $NodeDir

  Write-Host "  Listo: Node.js $verOut guardado en .runtime\node\"
  Write-Host ''
  exit 0
} catch {
  Write-Host ''
  Write-Host "  Error: $($_.Exception.Message)"
  exit 1
} finally {
  if (Test-Path -LiteralPath $TmpDir) {
    Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
