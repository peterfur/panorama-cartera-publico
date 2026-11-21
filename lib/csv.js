'use strict';
/* Lectura y escritura de CSV (comillas dobles, separador configurable o autodetectado, BOM). */

/** Detecta el separador más probable (coma, punto y coma o tabulador) mirando las primeras líneas. */
function detectDelimiter(text) {
  if (!text) return ',';
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const sampleLines = [];
  let inQ = false, cur = '';
  for (let i = 0; i < text.length && sampleLines.length < 10; i++) {
    const ch = text[i];
    if (ch === '"') { inQ = !inQ; cur += ch; continue; }
    if (!inQ && ch === '\n') {
      if (cur.trim()) sampleLines.push(cur);
      cur = '';
      continue;
    }
    if (ch !== '\r') cur += ch;
  }
  if (cur.trim() && sampleLines.length < 10) sampleLines.push(cur);
  if (!sampleLines.length) return ',';

  const candidates = [',', ';', '\t'];
  let best = ',', bestScore = -1;
  candidates.forEach((sep) => {
    const counts = sampleLines.map((line) => {
      let c = 0, q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') q = !q;
        else if (!q && ch === sep) c++;
      }
      return c;
    });
    const headerCount = counts[0];
    if (headerCount <= 0) return;
    const consistent = counts.filter((c) => c === headerCount).length;
    const score = consistent * 100 + headerCount;
    if (score > bestScore) { bestScore = score; best = sep; }
  });
  return best;
}

function parseCsv(text, opts) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const sep = opts && opts.delimiter ? (opts.delimiter === 'auto' ? detectDelimiter(text) : opts.delimiter) : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === sep) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvField(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

module.exports = { parseCsv, toCsv, detectDelimiter };
