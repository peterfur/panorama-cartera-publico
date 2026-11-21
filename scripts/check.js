#!/usr/bin/env node
'use strict';
/*
 * Comprobaciones desde la terminal:  npm run check
 * Sale con código 1 si alguna comprobación de nivel "error" falla.
 */
const path = require('path');
const { createStore } = require('../lib/store');
const { runChecks, summarize } = require('../lib/checks');

const data = createStore(path.join(__dirname, '..')).load();
const checks = runChecks(data);
const s = summarize(checks);
const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const val = (v, unit) => `${nf.format(v)} ${unit}`;

let group = null;
checks.forEach((k) => {
  if (k.group !== group) { group = k.group; console.log('\n' + group); }
  const icon = k.ok ? '  ✓' : (k.level === 'error' ? '  ✗' : '  ⚠');
  let line = `${icon} ${k.label}`;
  if (!k.ok && k.expected != null) line += `\n      guardado ${val(k.actual, k.unit)} · recalculado ${val(k.expected, k.unit)} · diferencia ${val(k.diff, k.unit)}`;
  if (!k.ok && k.detail) line += `\n      ${k.detail}`;
  if (!k.ok && k.note) line += `\n      ${k.note}`;
  console.log(line);
});
console.log(`\n${s.passed} de ${s.total} correctas` + (s.errors ? ` · ${s.errors} errores` : '') + (s.warnings ? ` · ${s.warnings} avisos` : ''));
process.exit(s.errors ? 1 : 0);
