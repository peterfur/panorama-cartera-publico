#!/usr/bin/env node
'use strict';
/*
 * Panorama de Cartera — servidor local.
 *
 *   node server.js            arranca en http://localhost:8765
 *   node server.js --open     arranca y abre el navegador
 *
 * No tiene dependencias: solo Node.js 18 o superior. Escucha únicamente en
 * 127.0.0.1, así que nada de esto es visible desde fuera de tu ordenador.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { UserError, todayIso, dateLabels, FEE_CATEGORIES, computePortfolioMetrics } = require('./lib/calc');
const { applyMovement, applyPrices, TYPES, fmtEur } = require('./lib/movements');
const { runChecks, summarize } = require('./lib/checks');
const { createStore } = require('./lib/store');
const { createClient, QuoteError, cleanSearchQuery, pickBestSymbolMatch } = require('./lib/alphavantage');
const degiro = require('./lib/degiro');
const ibkr = require('./lib/ibkr');
const brokers = require('./lib/brokers');
const { rebuild } = require('./lib/rebuild');
const report = require('./lib/report');
const benchmark = require('./lib/benchmark');
const irpf = require('./lib/irpf');
const { emptyPortfolio, brokersIn } = require('./lib/empty');

// Lo que se anota de cada movimiento en el historial (tal como se escribió en el formulario).
const JOURNAL_FIELDS = ['tipo', 'fecha', 'isin', 'nombre', 'cantidad', 'precio', 'divisa', 'importe_eur', 'comision_eur', 'fecha_apertura',
  'bruto_nativo', 'bruto_eur', 'retencion_eur', 'importe', 'categoria', 'sentido', 'av_symbol', 'av_cur'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function createApp(root, options) {
  options = options || {};
  const store = createStore(root);
  // Instalación nueva: se empieza con una cartera vacía, lista para importar extractos.
  if (!fs.existsSync(store.dataFile)) {
    fs.mkdirSync(path.dirname(store.dataFile), { recursive: true });
    fs.writeFileSync(store.dataFile, JSON.stringify(emptyPortfolio(), null, 2) + '\n', 'utf8');
  }
  const publicDir = path.join(root, 'public');
  const env = () => store.loadEnv();
  const apiKey = () => (env().ALPHAVANTAGE_API_KEY || '').trim();
  let av = null, avSignature = '';
  function client() {
    const cfg = store.loadConfig();
    const sig = `${env().ALPHAVANTAGE_BASE_URL || ''}|${cfg.alphaVantage.cacheMinutes}`;
    if (!av || sig !== avSignature) {
      av = createClient({ getKey: apiKey, baseUrl: env().ALPHAVANTAGE_BASE_URL, cacheMinutes: cfg.alphaVantage.cacheMinutes });
      avSignature = sig;
    }
    return av;
  }

  // Una sola escritura a la vez: dos guardados simultáneos no pueden pisarse.
  let queue = Promise.resolve();
  function exclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  function send(res, status, body, headers) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    const payload = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, Object.assign({
      'Content-Type': isJson ? MIME['.json'] : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    }, headers || {}));
    res.end(payload);
  }

  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > (maxBytes || 1024 * 1024)) { reject(new UserError('Petición demasiado grande.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject(new UserError('El cuerpo de la petición no es JSON válido.')); }
      });
      req.on('error', reject);
    });
  }

  async function statePayload(extra) {
    const data = store.load();
    if (data && data.combined) data.combined.metrics = computePortfolioMetrics(data);
    const cfg = store.loadConfig();
    const checks = runChecks(data);
    let bench = null;
    const indices = store.loadIndices();
    try { bench = benchmark.compare(data, indices, cfg.benchmarks); } catch (e) { bench = { error: 'No se ha podido calcular la comparación con los índices: ' + e.message }; }
    let tax = null;
    try {
      tax = irpf.computeIrpf(data, {
        degiroRows: store.loadDegiroLedger(),
        ibkrLedger: store.loadIbkrLedger(),
        extraLedgers: store.loadExtraLedgers(),
      }, { today: todayIso() });
    } catch (e) { tax = { error: 'No se ha podido calcular la simulación fiscal: ' + e.message }; }
    return Object.assign({
      data,
      benchmark: bench,
      irpf: tax,
      checks,
      checksSummary: summarize(checks),
      config: {
        titular: cfg.titular,
        symbols: cfg.alphaVantage.symbols,
        autoFx: cfg.alphaVantage.autoFx,
        delayMs: cfg.alphaVantage.delayMs,
        feeCategories: FEE_CATEGORIES,
        benchmarks: cfg.benchmarks,
        movementTypes: TYPES,
      },
      status: {
        hasApiKey: !!apiKey(),
        git: await store.gitInfo(),
        autoCommit: !!cfg.autoCommit,
        canUndo: store.listBackups().length > 0,
        today: todayIso(),
        brokers: brokersIn(data),
        dataFile: path.relative(root, store.dataFile).split(path.sep).join('/'),
      },
    }, extra || {});
  }

  /* ---------- importación de extractos ---------- */

  const KEY_FIGURES = [
    ['portfolio_value_total', 'Valor total de la cartera', (d) => d.combined.portfolio_value_total],
    ['total_contributions', 'Aportaciones netas', (d) => d.combined.total_contributions],
    ['portfolio_total_return', 'Rendimiento total', (d) => d.combined.portfolio_total_return],
    ['degiro_value_total', 'DEGIRO · valor de las posiciones', (d) => d.combined.degiro_value_total],
    ['degiro_realized_total', 'DEGIRO · resultado realizado', (d) => d.combined.degiro_realized_total],
    ['ibkr_nav', 'IBKR · valor de la cuenta', (d) => d.ibkr.nav_final],
    ['total_div_net', 'Dividendos netos', (d) => d.combined.total_div_net],
  ];

  /**
   * Calcula qué pasaría al importar estos archivos, sin guardar nada.
   * Devuelve { preview, data, ledgers, summary }.
   */
  function computeImport(files, mappings) {
    if (!Array.isArray(files) || !files.length) throw new UserError('No se ha recibido ningún archivo.');
    if (files.length > 12) throw new UserError('Demasiados archivos a la vez (máximo 12).');
    mappings = (mappings && typeof mappings === 'object') ? mappings : {};
    const current = store.load();
    let degiroRows = store.loadDegiroLedger();
    let ibkrLedger = store.loadIbkrLedger();
    let extraLedgers = store.loadExtraLedgers();
    let touchedDegiro = false, touchedIbkr = false, touchedExtra = false, degiroFileMax = null;
    const touchedExtraIds = new Set();
    const reports = [];
    const parseWarnings = [];
    const unmappedFiles = [];

    files.forEach((f, idx) => {
      const name = String((f && f.name) || 'archivo').slice(0, 120);
      const text = String((f && f.content) || '');
      try {
        if (degiro.looksLikeDegiro(text)) {
          const rows = degiro.parseDegiroCsv(text);
          const m = degiro.mergeLedger(degiroRows, rows);
          degiroRows = m.rows; touchedDegiro = true;
          const dates = rows.map((r) => degiro.dmyToIso(r[0])).sort();
          if (!degiroFileMax || dates[dates.length - 1] > degiroFileMax) degiroFileMax = dates[dates.length - 1];
          reports.push({ name, broker: 'DEGIRO', brokerId: 'degiro', from: dates[0], to: dates[dates.length - 1], total: rows.length, added: m.added, duplicates: m.duplicates });
        } else if (ibkr.looksLikeIbkr(text)) {
          const parsed = ibkr.parseIbkrCsv(text, name);
          const m = ibkr.mergeIbkr(ibkrLedger, parsed);
          ibkrLedger = m.ledger; touchedIbkr = true;
          reports.push({ name, broker: 'IBKR', brokerId: 'ibkr', from: parsed.statement.start, to: parsed.statement.end, total: m.added + m.duplicates, added: m.added, duplicates: m.duplicates, replaced: m.replaced, changed: m.changed });
        } else {
          const userMap = mappings[idx] || mappings[name] || null;
          const parsed = brokers.parseBrokerCsv(text, name, userMap);
          if (parsed.needsMapping) {
            unmappedFiles.push(Object.assign({ fileIndex: idx }, parsed));
            return;
          }
          const m = brokers.mergeBrokerLedger(extraLedgers, parsed.brokerId, parsed.brokerName, parsed.preset, parsed.events);
          extraLedgers = m.ledgers; touchedExtra = true;
          touchedExtraIds.add(parsed.brokerId);
          parseWarnings.push(...(parsed.warnings || []));
          const dates = parsed.events.map((e) => e.date).sort();
          reports.push({
            name, broker: parsed.brokerName, brokerId: parsed.brokerId,
            from: dates[0], to: dates[dates.length - 1],
            total: parsed.events.length, added: m.added, duplicates: m.duplicates,
          });
        }
      } catch (e) {
        if (e instanceof UserError) throw new UserError(`${name}: ${e.message}`);
        throw e;
      }
    });

    if (unmappedFiles.length) {
      return {
        data: current, added: 0,
        ledgers: { degiroRows: null, ibkrLedger: null, extraLedgers: null },
        summary: '',
        preview: {
          needsMapping: true,
          unmappedFiles,
          files: reports,
          blocking: [],
          warnings: parseWarnings,
          superseded: [],
          figures: [],
          added: 0,
          positions: { before: current.combined.open_positions_count, after: current.combined.open_positions_count },
          nothingNew: false,
        },
      };
    }

    // Los movimientos registrados a mano que este extracto de DEGIRO ya cubre dejan de contarse aparte.
    const working = JSON.parse(JSON.stringify(current));
    const superseded = [];
    if (touchedDegiro) {
      (working.journal || []).forEach((j) => {
        if (j.kind === 'movimiento' && !j.superseded && j.date && j.date <= degiroFileMax) {
          j.superseded = true; superseded.push({ id: j.id, date: j.date, summary: j.summary });
        }
      });
    }
    const hadLedger = store.loadDegiroLedger().length > 0;
    const built = rebuild(working, { degiroRows, ibkrLedger, extraLedgers }, hadLedger || touchedDegiro ? applyMovement : null);
    const data = built.data;
    const allWarnings = parseWarnings.concat(built.warnings || []);

    const blocking = [];
    const src = data.sources || {};
    if (src.degiro) {
      if (src.degiro.opening_balance != null && Math.abs(src.degiro.opening_balance) > 0.011) {
        blocking.push(`El extracto de DEGIRO no empieza al abrir la cuenta (parte de un saldo de ${fmtEur(src.degiro.opening_balance)}). Exporta el «Estado de cuenta» desde la fecha de apertura; puede solaparse con lo ya importado.`);
      }
      (src.degiro.balance_gaps || []).forEach((g) => blocking.push(`Faltan movimientos de DEGIRO entre el ${dateLabels(g.after).short} y el ${dateLabels(g.before).short}: exporta un extracto que cubra esas fechas (puede solaparse con los demás).`));
    }
    if (src.ibkr) {
      (src.ibkr.coverage_gaps || []).forEach((g) => blocking.push(`Falta el informe de IBKR del ${dateLabels(g.from).short} al ${dateLabels(g.to).short}: expórtalo también (puede solaparse con los demás).`));
    }
    const checks = runChecks(data);
    const failed = checks.filter((k) => !k.ok && k.level === 'error').map((k) => k.label);
    if (!blocking.length && failed.length) blocking.push('Con estos extractos los datos no cuadran: ' + failed.join('; ') + '.');

    const extraFigures = Array.from(touchedExtraIds).map((bid) => {
      const bAfter = (data.extra_brokers && data.extra_brokers[bid]) || {};
      const bBefore = (current.extra_brokers && current.extra_brokers[bid]) || {};
      return { id: `extra_${bid}`, label: `${bAfter.name || bid} · valor de la cuenta`, before: bBefore.nav_total || 0, after: bAfter.nav_total || 0 };
    });
    const figures = KEY_FIGURES.map(([id, label, get]) => ({ id, label, before: get(current), after: get(data) })).concat(extraFigures);
    const added = reports.reduce((a, r) => a + r.added, 0);
    const summary = reports.map((r) => `${r.name} (${r.broker}, ${r.added} ${r.added === 1 ? 'apunte nuevo' : 'apuntes nuevos'}${r.duplicates ? `, ${r.duplicates} ya estaban` : ''})`).join(' · ');
    return {
      data, added,
      ledgers: {
        degiroRows: touchedDegiro ? degiroRows : null,
        ibkrLedger: touchedIbkr ? ibkrLedger : null,
        extraLedgers: touchedExtra ? extraLedgers : null,
      },
      summary: `Extractos importados: ${summary}`,
      preview: {
        needsMapping: false,
        files: reports, blocking, warnings: allWarnings, superseded, figures, added,
        positions: { before: current.degiro_open_positions.length, after: data.degiro_open_positions.length },
        totalPositions: { before: current.combined.open_positions_count, after: data.combined.open_positions_count },
        degiro: src.degiro ? { from: src.degiro.date_min, to: src.degiro.date_max, rows: src.degiro.rows } : null,
        ibkr: src.ibkr ? { from: src.ibkr.date_min, to: src.ibkr.date_max, statements: src.ibkr.statements } : null,
        extra: src.extra || null,
        nothingNew: added === 0 && !reports.some((r) => r.changed),
      },
    };
  }

  function saveSymbolsConfig(newSymbols) {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch (e) { /* se crea */ }
    raw.alphaVantage = raw.alphaVantage || {};
    raw.alphaVantage.symbols = Object.assign({}, raw.alphaVantage.symbols, newSymbols);
    store.saveConfig(raw);
    return raw.alphaVantage.symbols;
  }

  function listOpenPositions(data) {
    const out = Array.isArray(data && data.degiro_open_positions) ? data.degiro_open_positions.slice() : [];
    Object.values((data && data.extra_brokers) || {}).forEach((b) => {
      if (b && Array.isArray(b.positions)) out.push(...b.positions);
    });
    return out;
  }

  async function searchSymbol(rawQuery, cur) {
    const av = client();
    const cleaned = cleanSearchQuery(rawQuery) || rawQuery;
    let usedQuery = cleaned;
    let matches = await av.symbolSearch(cleaned);
    if (!matches.length && cleaned.toLowerCase() !== rawQuery.toLowerCase()) {
      usedQuery = rawQuery;
      matches = await av.symbolSearch(rawQuery);
    }
    const best = pickBestSymbolMatch(matches, { currency: cur, name: rawQuery });
    return { query: usedQuery, matches, best };
  }

  /** Aplica un cambio sobre una copia; solo se guarda si todo cuadra. */
  function mutate(kind, apply) {
    return exclusive(async () => {
      const data = store.load();
      const before = summarize(runChecks(data));
      const result = apply(data);
      const after = runChecks(data);
      const sumAfter = summarize(after);
      if (sumAfter.errors > before.errors) {
        const broken = after.filter((k) => !k.ok && k.level === 'error').map((k) => k.label).join('; ');
        throw new UserError('No se ha guardado: con este cambio los datos dejarían de cuadrar (' + broken + ').');
      }
      store.addJournal(data, Object.assign({ kind, summary: result.summary }, result.journal || {}));
      benchmark.recordSnapshot(data, todayIso());
      const cfg = store.loadConfig();
      if (result.newSymbols && Object.keys(result.newSymbols).length) {
        saveSymbolsConfig(result.newSymbols);
      }
      store.save(data);
      const commit = await store.commit(`${kind}: ${result.summary}`, cfg);
      return statePayload({ saved: { summary: result.summary, commit } });
    });
  }

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/portfolio') return send(res, 200, await statePayload());

    if (route === 'GET /api/report') {
      // Informe para leer fuera de la aplicación: HTML autónomo (también sirve para imprimir a PDF) o texto.
      const format = url.searchParams.get('format') === 'md' ? 'md' : 'html';
      const data = store.load();
      const cfg = store.loadConfig();
      const rows = store.loadDegiroLedger();
      const ib = store.loadIbkrLedger();
      const extraLedgers = store.loadExtraLedgers();
      const extraTrades = Object.values((extraLedgers && extraLedgers.brokers) || {})
        .flatMap((entry) => (entry && entry.events && entry.events.length ? brokers.deriveBroker(entry, data).trades : []));
      const model = report.buildReport(data, {
        anon: url.searchParams.get('anon') !== '0',
        includeTrades: url.searchParams.get('trades') !== '0',
        titular: cfg.titular, today: todayIso(),
        degiroTrades: rows.length ? degiro.deriveDegiro(rows, data).trades : [],
        ibkrTrades: (ib.events && ib.events.trades) || [],
        extraTrades,
        checks: summarize(runChecks(data)),
        benchmark: (() => { try { return benchmark.compare(data, store.loadIndices(), cfg.benchmarks); } catch (e) { return null; } })(),
        irpf: (() => { try { return irpf.computeIrpf(data, { degiroRows: rows, ibkrLedger: ib, extraLedgers }, { today: todayIso() }); } catch (e) { return null; } })(),
      });
      const name = `cartera-${todayIso()}.${format}`;
      const headers = {
        'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${name}"`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      };
      return send(res, 200, format === 'md' ? report.toMarkdown(model) : report.toHtml(model), headers);
    }
    if (route === 'GET /api/import/template') {
      return send(res, 200, brokers.GENERIC_CSV_TEMPLATE, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="plantilla-openbrokercsv.csv"',
      });
    }
    if (route === 'GET /api/irpf/simulate') {
      const parseQ = (k, def) => {
        const raw = url.searchParams.get(k);
        if (raw == null || raw === '') return def;
        return parseFloat(String(raw).trim().replace(',', '.'));
      };
      const sim = irpf.simulateSale(
        store.load(),
        { degiroRows: store.loadDegiroLedger(), ibkrLedger: store.loadIbkrLedger(), extraLedgers: store.loadExtraLedgers() },
        {
          isin: url.searchParams.get('isin') || '',
          qty: parseQ('qty', NaN),
          priceEur: parseQ('price_eur', NaN),
          feeEur: parseQ('fee_eur', 0),
          date: url.searchParams.get('date') || todayIso(),
        },
        { today: todayIso() }
      );
      return send(res, 200, sim);
    }
    if (route === 'GET /api/quote') {
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) throw new UserError('Símbolo no válido.');
      return send(res, 200, await client().quote(symbol));
    }
    if (route === 'GET /api/symbol-search') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) throw new UserError('Falta el texto de búsqueda.', 'q');
      const curRaw = String(url.searchParams.get('cur') || '').trim().toUpperCase();
      if (curRaw && !/^[A-Z]{3}$/.test(curRaw)) throw new UserError('Divisa no válida.', 'cur');
      return send(res, 200, await searchSymbol(q, curRaw || ''));
    }
    if (route === 'GET /api/fx') {
      const cur = String(url.searchParams.get('currency') || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur) || cur === 'EUR') throw new UserError('Divisa no válida.');
      return send(res, 200, await client().fx(cur));
    }
    if (route === 'GET /api/indices/daily') {
      // Último cierre de un índice de referencia, con los ~100 días anteriores (y su tipo de cambio):
      // se guardan para poder ver de cerca un día o una semana en la gráfica de comparación.
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      const cfg = store.loadConfig();
      const b = (cfg.benchmarks && cfg.benchmarks.length ? cfg.benchmarks : benchmark.DEFAULT_BENCHMARKS).find((x) => x.symbol === symbol);
      if (!b) throw new UserError('Ese símbolo no es uno de los índices de referencia.');
      const av = client();
      const r = await av.daily(b.symbol);
      let fxPts = null, cached = !!r.cached;
      if (b.cur !== 'EUR') { const f = await av.fxDaily('EUR', b.cur); fxPts = f.points; cached = cached && !!f.cached; }
      await exclusive(() => store.addIndexDaily(b.symbol, r.points, b.cur, fxPts));
      const [day, price] = r.points[r.points.length - 1];
      return send(res, 200, Object.assign({ symbol: b.symbol, price, day }, cached ? { cached: true } : {}));
    }

    if (route === 'POST /api/apikey') {
      const body = await readBody(req);
      const key = String(body.key || '').trim();
      if (!/^[A-Za-z0-9]{8,64}$/.test(key)) throw new UserError('La clave no tiene el formato esperado: son solo letras y números, sin espacios.', 'key');
      if (process.env.ALPHAVANTAGE_API_KEY) throw new UserError('La clave está fijada como variable de entorno del sistema; cámbiala ahí.', 'key');
      store.setEnvVar('ALPHAVANTAGE_API_KEY', key);
      return send(res, 200, { ok: true, hasApiKey: !!apiKey() });
    }
    if (route === 'POST /api/indices/refresh') {
      await readBody(req);
      return send(res, 200, await exclusive(async () => {
        // Por índice, su serie semanal ajustada y sus cierres diarios recientes; por divisa, el
        // cambio semanal y el diario (por defecto, 6 consultas). Lo semanal se guarda desde unas
        // semanas antes de la primera aportación; lo diario se va acumulando.
        const cfg = store.loadConfig();
        const list = cfg.benchmarks && cfg.benchmarks.length ? cfg.benchmarks : benchmark.DEFAULT_BENCHMARKS;
        const flows = benchmark.contributionFlows(store.load());
        const from = flows.length ? new Date(Date.parse(flows[0].date) - 60 * 86400000).toISOString().slice(0, 10) : '0000';
        const av = client();
        const wait = () => new Promise((r) => setTimeout(r, cfg.alphaVantage.delayMs || 1300));
        const old = store.loadIndices() || {};
        const cache = { fetched: todayIso(), series: {}, fx: {}, daily: old.daily || {}, fxDaily: old.fxDaily || {} };
        let first = true;
        const step = async (fn) => { if (!first) await wait(); first = false; return fn(); };
        const currencies = Array.from(new Set(list.map((b) => b.cur).filter((c) => c !== 'EUR')));
        for (const b of list) {
          const pts = await step(() => av.weekly(b.symbol));
          cache.series[b.symbol] = { cur: b.cur, points: pts.filter(([d]) => d >= from) };
        }
        for (const cur of currencies) {
          const pts = await step(() => av.fxWeekly('EUR', cur));
          cache.fx[cur] = pts.filter(([d]) => d >= from);
        }
        store.saveIndices(cache);
        // Los diarios son un extra (para ver de cerca un día o una semana): si fallan, se sigue.
        let dailyNote = '';
        try {
          for (const b of list) { const r = await step(() => av.daily(b.symbol)); store.addIndexDaily(b.symbol, r.points, null, null); }
          for (const cur of currencies) { const r = await step(() => av.fxDaily('EUR', cur)); store.addIndexDaily(null, null, cur, r.points); }
        } catch (e) {
          if (!(e instanceof QuoteError)) throw e;
          dailyNote = ` · sin los cierres diarios (${e.message})`;
        }
        const asOf = Object.values(cache.series).reduce((m, s) => { const l = s.points.length ? s.points[s.points.length - 1][0] : m; return l < m ? l : m; }, '9999');
        const summary = `Índices actualizados hasta el ${dateLabels(asOf).short}${dailyNote}`;
        const commit = await store.commit(`índices: ${list.map((b) => b.name).join(', ')} hasta ${asOf}`, cfg, ['data/indices.json']);
        return statePayload({ saved: { summary, commit } });
      }));
    }
    if (route === 'POST /api/symbols') {
      const body = await readBody(req);
      const isin = String(body.isin || '').trim().toUpperCase();
      if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) throw new UserError('ISIN no válido (debe tener 12 caracteres).', 'isin');
      const symbol = String(body.symbol || '').trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) throw new UserError('Símbolo de Alpha Vantage no válido.', 'symbol');
      const cur = String(body.cur || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) throw new UserError('Divisa no válida (código de 3 letras, p. ej. USD).', 'cur');
      const label = String(body.label || '').trim().slice(0, 80) || symbol;
      const entry = { symbol, cur, label };
      const symbols = await exclusive(() => saveSymbolsConfig({ [isin]: entry }));
      return send(res, 200, { ok: true, isin, entry, symbols });
    }
    if (route === 'POST /api/prices') {
      const body = await readBody(req);
      return send(res, 200, await mutate('precios', (data) => applyPrices(data, body)));
    }
    if (route === 'POST /api/import/preview') {
      const body = await readBody(req, 16 * 1024 * 1024);
      return send(res, 200, await exclusive(async () => computeImport(body.files, body.mappings).preview));
    }
    if (route === 'POST /api/import') {
      const body = await readBody(req, 16 * 1024 * 1024);
      return send(res, 200, await exclusive(async () => {
        const beforeIsins = new Set(listOpenPositions(store.load()).map((p) => p.isin).filter(Boolean));
        const r = computeImport(body.files, body.mappings);
        if (r.preview.needsMapping) throw new UserError('Completa el mapeo de columnas antes de importar.');
        if (r.preview.blocking.length) throw new UserError('No se ha importado: ' + r.preview.blocking[0]);
        store.addJournal(r.data, { kind: 'importacion', summary: r.summary, files: r.preview.files });
        benchmark.recordSnapshot(r.data, todayIso());
        store.save(r.data, r.ledgers);

        // Autodetección best-effort de símbolos de Alpha Vantage para posiciones nuevas (máx. 3 consultas).
        const cfg = store.loadConfig();
        const existingSymbols = (cfg.alphaVantage && cfg.alphaVantage.symbols) || {};
        const autoSymbols = {};
        if (apiKey()) {
          const seen = new Set();
          const newMissing = listOpenPositions(r.data).filter((p) => {
            if (!p || !p.isin || beforeIsins.has(p.isin) || existingSymbols[p.isin] || seen.has(p.isin)) return false;
            seen.add(p.isin);
            return true;
          }).slice(0, 3);
          if (newMissing.length) {
            const av = client();
            const delayMs = cfg.alphaVantage.delayMs != null ? cfg.alphaVantage.delayMs : 1300;
            for (let i = 0; i < newMissing.length; i++) {
              if (i > 0 && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
              const pos = newMissing[i];
              const targetCur = String(pos.live_price_cur || pos.last_price_cur || '').trim().toUpperCase();
              const query = cleanSearchQuery(pos.name) || pos.name;
              try {
                const matches = await av.symbolSearch(query);
                const best = pickBestSymbolMatch(matches, { currency: targetCur, name: pos.name });
                if (best && (!targetCur || best.currency === targetCur) && (!best.type || /^equity$/i.test(best.type)) && best.matchScore >= 0.6) {
                  autoSymbols[pos.isin] = {
                    symbol: best.symbol,
                    cur: best.currency || targetCur || 'EUR',
                    label: best.region ? `${best.region}: ${best.symbol}` : best.symbol,
                  };
                }
              } catch (e) {
                if (e instanceof QuoteError && ['rate_limited', 'bad_key', 'no_api_key', 'network'].includes(e.code)) break;
              }
            }
            if (Object.keys(autoSymbols).length) saveSymbolsConfig(autoSymbols);
          }
        }

        const commit = await store.commit(`importación: ${r.preview.files.map((f) => f.name).join(', ')}`, cfg);
        return statePayload({ saved: { summary: r.summary, commit }, autoSymbols });
      }));
    }
    if (route === 'POST /api/movements') {
      const body = await readBody(req);
      return send(res, 200, await mutate('movimiento', (data) => {
        const covered = data.sources && data.sources.degiro && data.sources.degiro.date_max;
        if (covered && typeof body.fecha === 'string' && body.fecha < covered) {
          throw new UserError(`Los extractos importados ya cubren hasta el ${dateLabels(covered).short}. Si falta un movimiento anterior, importa un extracto más reciente en lugar de registrarlo a mano.`, 'fecha');
        }
        const r = applyMovement(data, body);
        const payload = {};
        JOURNAL_FIELDS.forEach((k) => { if (body[k] != null && body[k] !== '') payload[k] = String(body[k]).slice(0, 100); });
        r.journal = { type: body.tipo, date: body.fecha, payload };
        return r;
      }));
    }
    if (route === 'POST /api/undo') {
      await readBody(req);
      return send(res, 200, await exclusive(async () => {
        const current = store.load();
        const last = (current.journal || [])[current.journal ? current.journal.length - 1 : 0];
        const restored = store.undo();
        if (!restored) throw new UserError('No hay ningún cambio guardado que deshacer.');
        const summary = last ? last.summary : 'último cambio';
        const commit = await store.commit(`deshacer: ${summary}`, store.loadConfig());
        return statePayload({ saved: { summary: `Deshecho: ${summary}`, commit } });
      }));
    }
    return send(res, 404, { error: { code: 'not_found', message: 'Ruta desconocida.' } });
  }

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Ruta no válida'); }
    if (rel.includes('\0')) return send(res, 400, 'Ruta no válida');
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep)) return send(res, 403, 'Prohibido');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'No encontrado');
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const isFont = file.endsWith('.woff2');
      send(res, 200, buf, {
        'Content-Type': type,
        'Cache-Control': isFont ? 'public, max-age=31536000, immutable' : 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      });
    });
  }

  function allowedHost(req) {
    // Protección frente a páginas web que intenten hablar con este servidor local.
    const host = String(req.headers.host || '').toLowerCase();
    const okHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    if (!okHost) return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return false;
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin') return false;
    }
    return true;
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'Petición no válida'); }
    if (!allowedHost(req)) return send(res, 403, { error: { code: 'forbidden', message: 'Origen no permitido.' } });
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((err) => {
        if (err instanceof UserError) return send(res, 400, { error: { code: 'invalid', message: err.message, field: err.field } });
        if (err instanceof QuoteError) return send(res, err.code === 'network' ? 503 : 502, { error: { code: err.code, message: err.message } });
        if (!options.quiet) console.error(err);
        send(res, 500, { error: { code: 'internal', message: 'Error interno: ' + err.message } });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
    serveStatic(req, res, url);
  });

  return { server, store };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

if (require.main === module) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) { console.error(`Hace falta Node.js 18 o superior (tienes ${process.versions.node}).`); process.exit(1); }
  const root = __dirname;
  const { server, store } = createApp(root);
  const env = store.loadEnv();
  const port = parseInt(env.PORT || '8765', 10);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`El puerto ${port} ya está en uso. ¿Tienes la app abierta en otra ventana? Puedes usar otro con PORT=8766 en .env.`);
    else console.error(err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    const sum = summarize(runChecks(store.load()));
    console.log('');
    console.log('  Panorama de Cartera');
    console.log('  ' + url);
    console.log('');
    console.log(`  Comprobaciones: ${sum.passed}/${sum.total} correctas` + (sum.errors ? `  ·  ${sum.errors} ERRORES (ejecuta "npm run check")` : ''));
    console.log(`  Alpha Vantage:  ${(env.ALPHAVANTAGE_API_KEY || '').trim() ? 'clave configurada' : 'sin clave — los precios se introducen a mano (ver README)'}`);
    console.log('');
    console.log('  Pulsa Ctrl+C para cerrar.');
    if (process.argv.includes('--open')) openBrowser(url);
  });
}

module.exports = { createApp };
