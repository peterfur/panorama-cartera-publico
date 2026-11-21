'use strict';
/*
 * Lectura y escritura de los datos en disco.
 *
 *  - data/portfolio.json   -> la cartera (se versiona con git)
 *  - data/backups/         -> copia del estado anterior en cada guardado (no se versiona)
 *  - config.json           -> ajustes sin secretos (se versiona)
 *  - .env                  -> la clave de Alpha Vantage (NUNCA se versiona)
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { parseLedger, serializeLedger } = require('./degiro');
const { emptyLedger } = require('./ibkr');
const { DEFAULT_BENCHMARKS } = require('./benchmark');

const MAX_BACKUPS = 40;
const MAX_JOURNAL = 500;

function createStore(root) {
  const dataDir = path.join(root, 'data');
  const dataFile = path.join(dataDir, 'portfolio.json');
  const backupDir = path.join(dataDir, 'backups');
  const degiroFile = path.join(dataDir, 'degiro-movimientos.csv');
  const ibkrFile = path.join(dataDir, 'ibkr-extractos.json');
  const indicesFile = path.join(dataDir, 'indices.json');
  const configFile = path.join(root, 'config.json');
  const envFile = path.join(root, '.env');

  function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  function writeJsonAtomic(file, obj) {
    writeTextAtomic(file, JSON.stringify(obj, null, 2) + '\n');
  }
  function writeTextAtomic(file, text) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      // En Windows un antivirus o la sincronización de OneDrive pueden tener el
      // archivo abierto un instante: se escribe directamente como alternativa.
      fs.writeFileSync(file, text, 'utf8');
      try { fs.unlinkSync(tmp); } catch (e2) { /* se queda el .tmp, que git ignora */ }
    }
  }

  function load() { return readJson(dataFile); }

  function loadConfig() {
    const defaults = {
      titular: '', autoCommit: true, autoPush: false,
      alphaVantage: { delayMs: 1300, cacheMinutes: 15, autoFx: [], symbols: {} },
      benchmarks: DEFAULT_BENCHMARKS,
    };
    let cfg = {};
    try { cfg = readJson(configFile); } catch (e) { if (e.code !== 'ENOENT') throw new Error('config.json no es un JSON válido: ' + e.message); }
    const av = Object.assign({}, defaults.alphaVantage, cfg.alphaVantage || {});
    return Object.assign({}, defaults, cfg, { alphaVantage: av });
  }
  function saveConfig(cfg) { writeJsonAtomic(configFile, cfg); }

  /** Variables de .env (formato CLAVE=valor). Las variables de entorno reales mandan. */
  function loadEnv() {
    const env = {};
    try {
      fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach((line) => {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch (e) { /* sin .env: no pasa nada */ }
    return Object.assign(env, process.env);
  }

  /** Guarda (o sustituye) una variable en .env conservando el resto del archivo. */
  function setEnvVar(name, value) {
    let lines = [];
    try { lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/); } catch (e) { /* aún no existe */ }
    const re = new RegExp('^\\s*' + name + '\\s*=');
    let found = false;
    lines = lines.map((l) => { if (re.test(l)) { found = true; return `${name}=${value}`; } return l; });
    if (!found) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      if (!lines.length) lines.push('# Secretos locales de Panorama de Cartera. Este archivo no se sube a GitHub (.gitignore).');
      lines.push(`${name}=${value}`);
    }
    writeTextAtomic(envFile, lines.join('\n').replace(/\n*$/, '\n'));
  }

  function stamp() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
  }
  /* ---------- libros de extractos ---------- */

  function loadDegiroLedger() {
    try { return parseLedger(fs.readFileSync(degiroFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  function loadIbkrLedger() {
    try { return readJson(ibkrFile); } catch (e) { if (e.code === 'ENOENT') return emptyLedger(); throw e; }
  }

  /* ---------- copias de seguridad: una carpeta por guardado, con todos los archivos de datos ---------- */

  const DATA_FILES = ['portfolio.json', 'degiro-movimientos.csv', 'ibkr-extractos.json'];
  // Caché de los índices: se versiona con los datos pero no entra en las copias ni en «deshacer».
  const CACHE_FILES = ['indices.json'];

  function listBackups() {
    try {
      return fs.readdirSync(backupDir)
        .map((name) => ({ name, stamp: (/^(?:portfolio-)?(\d{8}-\d{6}-\d{3})(?:\.json)?$/.exec(name) || [])[1] }))
        .filter((b) => b.stamp).sort((a, b) => a.stamp.localeCompare(b.stamp)).map((b) => b.name);
    } catch (e) { return []; }
  }

  /**
   * Guarda el estado nuevo dejando antes una copia del anterior.
   * `ledgers` es opcional: { degiroRows, ibkrLedger } cuando el guardado viene de importar extractos.
   */
  function save(data, ledgers) {
    const dir = path.join(backupDir, stamp());
    fs.mkdirSync(dir, { recursive: true });
    const existed = [];
    DATA_FILES.forEach((f) => {
      const src = path.join(dataDir, f);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dir, f)); existed.push(f); }
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ existed }) + '\n');
    if (ledgers && ledgers.degiroRows) writeTextAtomic(degiroFile, serializeLedger(ledgers.degiroRows));
    if (ledgers && ledgers.ibkrLedger) writeJsonAtomic(ibkrFile, ledgers.ibkrLedger);
    writeJsonAtomic(dataFile, data);
    const all = listBackups();
    all.slice(0, Math.max(0, all.length - MAX_BACKUPS)).forEach((f) => { try { fs.rmSync(path.join(backupDir, f), { recursive: true, force: true }); } catch (e) { /* da igual */ } });
  }

  /** Vuelve al estado anterior al último guardado. Devuelve los datos restaurados o null. */
  function undo() {
    const all = listBackups();
    if (!all.length) return null;
    const entry = path.join(backupDir, all[all.length - 1]);
    if (fs.statSync(entry).isDirectory()) {
      const existed = readJson(path.join(entry, 'manifest.json')).existed;
      DATA_FILES.forEach((f) => {
        const dst = path.join(dataDir, f);
        if (existed.includes(f)) writeTextAtomic(dst, fs.readFileSync(path.join(entry, f), 'utf8'));
        else if (fs.existsSync(dst)) fs.unlinkSync(dst); // ese archivo no existía antes del cambio que se deshace
      });
    } else {
      writeTextAtomic(dataFile, fs.readFileSync(entry, 'utf8')); // copia con el formato de la primera versión
    }
    fs.rmSync(entry, { recursive: true, force: true });
    return load();
  }

  function addJournal(data, entry) {
    if (!Array.isArray(data.journal)) data.journal = [];
    const last = data.journal[data.journal.length - 1];
    data.journal.push(Object.assign({ id: (last ? last.id : 0) + 1, ts: new Date().toISOString() }, entry));
    if (data.journal.length > MAX_JOURNAL) data.journal.splice(0, data.journal.length - MAX_JOURNAL);
  }

  /* ---------- git ---------- */

  function git(args) {
    return new Promise((resolve) => {
      execFile('git', ['-C', root].concat(args), { timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || (err && err.message) || '').trim() });
      });
    });
  }
  function samePath(a, b) {
    const norm = (p) => {
      let r = path.resolve(p);
      try { r = fs.realpathSync(r); } catch (e) { /* se compara tal cual */ }
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    return norm(a) === norm(b);
  }
  async function gitInfo() {
    const inside = await git(['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.out !== 'true') return { repo: false };
    // Solo vale si la raíz del repositorio es esta carpeta (no un repositorio que la contenga).
    const top = await git(['rev-parse', '--show-toplevel']);
    if (!top.ok || !samePath(top.out, root)) return { repo: false };
    const head = await git(['log', '-1', '--format=%h|%s|%cI']);
    const remote = await git(['remote', 'get-url', 'origin']);
    const dirty = await git(['status', '--porcelain', '--'].concat(await trackedPaths()));
    const [hash, subject, date] = head.ok ? head.out.split('|') : [];
    return { repo: true, hash: hash || null, subject: subject || null, date: date || null, hasRemote: remote.ok, pending: dirty.ok && dirty.out.length > 0 };
  }
  /** Los archivos que la aplicación versiona: los datos y la configuración, y solo los que existen. */
  async function trackedPaths() {
    const all = DATA_FILES.concat(CACHE_FILES).map((f) => 'data/' + f).concat(['config.json']);
    const known = await git(['ls-files', '--'].concat(all));
    const tracked = new Set(known.ok ? known.out.split('\n').filter(Boolean) : []);
    // Un archivo que ya no existe pero estaba versionado también cuenta: hay que confirmar su borrado.
    return all.filter((rel) => fs.existsSync(path.join(root, rel)) || tracked.has(rel));
  }
  /** Confirma en git SOLO los datos y la configuración. Nunca falla hacia fuera. */
  /* ---------- datos de índices (caché de Alpha Vantage, aparte de las copias de seguridad) ---------- */
  function loadIndices() {
    try { return readJson(indicesFile); } catch (e) { return null; }
  }
  function saveIndices(cache) {
    // Cada punto [fecha, valor] en una sola línea: el archivo ocupa la cuarta parte y se lee mejor en git.
    const text = JSON.stringify(cache, null, 2).replace(/\[\s+("\d{4}-\d{2}-\d{2}"),\s+(-?[\d.eE+-]+)\s+\]/g, '[$1, $2]');
    writeTextAtomic(indicesFile, text + '\n');
  }

  /** Junta dos series [[fecha, valor]]: la nueva manda en las fechas repetidas. */
  function mergePoints(oldPts, newPts) {
    const m = new Map(oldPts || []);
    (newPts || []).forEach(([d, p]) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d) && p > 0) m.set(d, p); });
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }
  /**
   * Añade cierres diarios de un índice (y del cambio de su divisa) a data/indices.json.
   * Se acumulan: cada consulta trae los últimos ~100 días y se suman a los que ya había.
   */
  function addIndexDaily(symbol, points, cur, fxPoints) {
    const cache = loadIndices() || { fetched: null, series: {}, fx: {} };
    cache.daily = cache.daily || {};
    cache.fxDaily = cache.fxDaily || {};
    if (symbol && points && points.length) cache.daily[symbol] = mergePoints(cache.daily[symbol], points);
    if (cur && fxPoints) cache.fxDaily[cur] = mergePoints(cache.fxDaily[cur], fxPoints);
    saveIndices(cache);
  }

  async function commit(message, cfg, onlyPaths) {
    if (!cfg.autoCommit) return { done: false, reason: 'desactivado' };
    const info = await gitInfo();
    if (!info.repo) return { done: false, reason: 'sin repositorio' };
    const paths = onlyPaths || await trackedPaths();
    await git(['add', '-A', '--'].concat(paths));
    const res = await git(['commit', '-m', message, '--'].concat(paths));
    if (!res.ok) return { done: false, reason: /nothing to commit|nada para hacer commit/i.test(res.out + res.err) ? 'sin cambios' : (res.err || res.out).split('\n')[0] };
    const head = await git(['log', '-1', '--format=%h']);
    let pushed = false, pushError = null;
    if (cfg.autoPush && info.hasRemote) {
      const p = await git(['push']);
      pushed = p.ok; if (!p.ok) pushError = p.err.split('\n')[0];
    }
    return { done: true, hash: head.out, pushed, pushError };
  }

  return { root, dataFile, load, save, undo, addJournal, loadConfig, saveConfig, loadEnv, setEnvVar, listBackups, gitInfo, commit, loadDegiroLedger, loadIbkrLedger, loadIndices, saveIndices, addIndexDaily };
}

module.exports = { createStore };
