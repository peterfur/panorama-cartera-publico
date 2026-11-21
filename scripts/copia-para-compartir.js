#!/usr/bin/env node
'use strict';
/*
 * Copia de la aplicación SIN tus datos, para dársela a otra persona.
 *
 *   node scripts/copia-para-compartir.js [carpeta-destino]
 *
 * Por defecto crea «panorama-cartera-para-compartir» al lado de esta carpeta.
 * Lleva solo el programa: ni data/ (tu cartera, tus extractos, tus índices),
 * ni .env (tu clave), ni extractos/, ni el historial de git, ni las pruebas
 * (usan una copia de tus datos). config.json va vacío: sin nombre ni símbolos.
 * Quien la reciba empieza con la cartera vacía e importa sus extractos.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = '.copia-panorama-cartera';
const target = path.resolve(process.argv[2] || path.join(ROOT, '..', 'panorama-cartera-para-compartir'));

if (path.resolve(target) === path.resolve(ROOT) || path.resolve(target).startsWith(path.resolve(ROOT) + path.sep)) {
  console.error('La copia tiene que ir fuera de la carpeta de la aplicación.');
  process.exit(1);
}
if (fs.existsSync(target)) {
  if (!fs.existsSync(path.join(target, MARK))) {
    console.error(`Ya existe ${target} y no es una copia anterior de esta aplicación: no se toca. Elige otra carpeta.`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true }); // copia anterior: se rehace entera
}

const INCLUDE = [
  'server.js', 'package.json', 'README.md', 'DOCUMENTACION-TECNICA.md', '.gitignore', '.gitattributes',
  'iniciar.bat', 'iniciar.command', 'configurar-git.bat', 'crear-copia-para-compartir.bat',
  'lib', 'public', 'scripts/check.js', 'scripts/copia-para-compartir.js', 'scripts/instalar-node.ps1',
];
INCLUDE.forEach((rel) => {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return;
  const dst = path.join(target, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
});

// Configuración sin nada personal (la carpeta data/ se crea vacía al arrancar).
const cfg = {
  titular: '',
  autoCommit: true,
  autoPush: false,
  alphaVantage: { delayMs: 1300, cacheMinutes: 15, autoFx: ['USD'], symbols: {} },
};
fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
const envTemplate = [
  '# Ajustes locales de Panorama de Cartera (este archivo no se sube a GitHub: está en .gitignore).',
  '',
  '# Clave gratuita de Alpha Vantage: https://www.alphavantage.co/support/#api-key',
  '# Sin clave la aplicación funciona igual, pero los precios se introducen a mano.',
  '# También puedes pegarla directamente desde la propia página en «Actualizar precios».',
  'ALPHAVANTAGE_API_KEY=',
  '',
  '# Puerto local (cambia el número si el 8765 ya está ocupado)',
  'PORT=8765',
  '',
].join('\n');
fs.writeFileSync(path.join(target, '.env'), envTemplate, 'utf8');
fs.writeFileSync(path.join(target, MARK), 'Copia de Panorama de Cartera sin datos personales.\n');

// Las pruebas no viajan: quita el script de package.json para que no falle.
const pkgFile = path.join(target, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
delete pkg.scripts.test;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');

console.log(`Copia sin datos personales creada en:\n  ${target}\n\nComprímela (botón derecho → Comprimir en archivo ZIP) y pásasela. Al abrir iniciar.bat empezará con la cartera vacía.`);
