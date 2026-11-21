'use strict';
/*
 * Soporte multibroker para importación de extractos CSV.
 *
 * Brókers con detección automática:
 *  - Trading 212       (exportación CSV nativa, columnas dinámicas)
 *  - Trade Republic    (exportación CSV nativa de la app, pytr y formato Pocket Portfolio)
 *  - MyInvestor        (exportación de operaciones desde Inversis guardada como CSV)
 *  - OpenBrokerCSV     (formato estándar genérico: Date, Ticker, Type, Currency, Quantity, Price)
 *
 * Para cualquier otro CSV no reconocido, analiza las cabeceras, propone un mapeo
 * inteligente de columnas («Smart Mapping») y permite importarlo asignando un nombre
 * de bróker sin rechazar el archivo.
 */

const { parseCsv, detectDelimiter } = require('./csv');
const { UserError, round2, round4, isoToDmy, dateLabels } = require('./calc');

const PRESETS = {
  trading212: {
    id: 'trading212',
    name: 'Trading 212',
    chip: 'chip-t212',
    colorVar: '--t212',
  },
  traderepublic: {
    id: 'traderepublic',
    name: 'Trade Republic',
    chip: 'chip-tr',
    colorVar: '--tr',
  },
  myinvestor: {
    id: 'myinvestor',
    name: 'MyInvestor',
    chip: 'chip-myinv',
    colorVar: '--myinv',
  },
};

function emptyExtraLedgers() {
  return { version: 1, brokers: {} };
}

function slugifyBroker(name) {
  const clean = String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!clean) return 'otro';
  if (/^trading[\s_]?212$|^t212$/.test(clean)) return 'trading212';
  if (/^trade[\s_]?republic$|^tr$/.test(clean)) return 'traderepublic';
  if (/^my[\s_]?investor$|^inversis$/.test(clean)) return 'myinvestor';
  return clean.slice(0, 32);
}

function brokerMeta(id, customName) {
  const key = slugifyBroker(id || customName);
  if (PRESETS[key]) return Object.assign({}, PRESETS[key]);
  return {
    id: key,
    name: String(customName || id || 'Otro bróker').trim().slice(0, 48) || 'Otro bróker',
    chip: 'chip-other',
    colorVar: '--other-broker',
  };
}

/* ---------- normalización de cabeceras, números y fechas ---------- */

function normHeader(s) {
  return String(s == null ? '' : s)
    .replace(/^\uFEFF/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  if (raw !== raw.toUpperCase()) return raw; // ya viene en mayúsculas/minúsculas
  return raw.toLowerCase().replace(/(^|[\s\-/(.])([a-zñáéíóúü])/g, (_, sep, ch) => sep + ch.toUpperCase())
    .replace(/\b(S\.?a\.?|N\.?v\.?|Ag|Se|Plc|Inc\.?|Corp\.?|Ltd\.?|Etf|Ucits|Acc|Dist|Eur|Usd)\b/gi, (m) => {
      const up = m.toUpperCase();
      if (['ETF', 'UCITS', 'AG', 'SE', 'NV', 'SA', 'EUR', 'USD'].includes(up.replace(/\./g, ''))) return up;
      return m[0].toUpperCase() + m.slice(1).toLowerCase();
    });
}

/**
 * Parsea números flexibles: 1.234,56 / 1,234.56 / -45,20 / (12.34) / "120,50 EUR".
 * localeHint: 'es' | 'en' | 'auto'
 */
function parseFlexNum(raw, localeHint) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  let s = String(raw == null ? '' : raw).trim();
  if (!s || s === '-' || s === '—' || /^n\/?a$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
  // Quitar símbolos de moneda, porcentajes y espacios finos/NBSP
  s = s.replace(/[€$£¥%]/g, '').replace(/\b[A-Z]{3}\b/g, '').replace(/[\s\u00A0']/g, '');
  if (!s) return null;
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith('+')) { s = s.slice(1); }

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // El último separador es el decimal.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length > 2) {
      // Múltiples comas -> separador de miles
      s = s.replace(/,/g, '');
    } else if (localeHint === 'es') {
      s = s.replace(',', '.');
    } else if (localeHint === 'en') {
      // En inglés una coma seguida de 3 dígitos (y parte entera != 0) suele ser miles
      if (parts[1].length === 3 && parts[0] !== '0' && parts[0].length <= 3) s = parts[0] + parts[1];
      else s = parts[0] + '.' + parts[1];
    } else {
      // Auto: si empieza por 0, o decimales != 3 -> decimal; si exactamente 3 dígitos tras >=1 -> podría ser miles o participaciones
      if (parts[0] === '0' || parts[1].length !== 3) s = parts[0] + '.' + parts[1];
      else s = parts[0] + '.' + parts[1]; // en Europa 1,250 participaciones o 12,500 es casi siempre decimal en CSV con ;
    }
  } else if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) s = s.replace(/\./g, '');
    else if (localeHint === 'es' && parts[1].length === 3 && parts[0] !== '0') {
      s = parts[0] + parts[1];
    }
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

/**
 * Parsea fechas ISO (YYYY-MM-DD[ T]HH:MM:SS...) o europeas (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY).
 */
function parseFlexDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return { date: iso, time: (m[4] || '00:00:00').padEnd(8, ':00').slice(0, 8) };
    }
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[T\s](\d{1,2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]), y = Number(m[3]);
    if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return { date: iso, time: (m[4] || '00:00:00').padEnd(8, ':00').slice(0, 8) };
    }
  }
  return null;
}

function cleanCur(v, fallback) {
  const s = String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (/^[A-Z]{3}$/.test(s)) return s;
  return fallback || 'EUR';
}

function cleanIsin(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s) ? s : '';
}

function extractIsinFromText(v) {
  const m = /\b([A-Z]{2}[A-Z0-9]{9}[0-9])\b/.exec(String(v || '').toUpperCase());
  return m ? m[1] : '';
}

/* ---------- lectura de tablas CSV con detección de fila de cabecera ---------- */

function readCsvTable(text) {
  const delimiter = detectDelimiter(text);
  const rawRows = parseCsv(text, { delimiter });
  // Saltar líneas completamente vacías o de metadatos previas (típicas de Excel/Inversis)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const nonEmpty = rawRows[i].filter((c) => String(c || '').trim() !== '');
    if (nonEmpty.length < 3) continue;
    const joined = nonEmpty.map(normHeader).join(' | ');
    if (/(^|\| )?(date|fecha|datum|time|datetime|timestamp|action|accion|type|tipo|typ|isin|ticker|symbol)\b/.test(joined)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    headerIdx = rawRows.findIndex((r) => r.filter((c) => String(c || '').trim() !== '').length >= 2);
  }
  if (headerIdx < 0) return { delimiter, headers: [], normHeaders: [], rows: [] };
  const headers = rawRows[headerIdx].map((h) => String(h || '').trim());
  const normHeaders = headers.map(normHeader);
  const rows = rawRows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c || '').trim() !== ''));
  return { delimiter, headers, normHeaders, rows };
}

function findCol(normHeaders, aliases) {
  for (const a of aliases) {
    const idx = normHeaders.indexOf(a);
    if (idx >= 0) return idx;
  }
  for (const a of aliases) {
    const idx = normHeaders.findIndex((h) => h.includes(a));
    if (idx >= 0) return idx;
  }
  return -1;
}

/* ---------- heurísticas de Smart Mapping ---------- */

const SMART_ALIASES = {
  date: ['date', 'datetime', 'timestamp', 'time', 'fecha operacion', 'fecha de operacion', 'fecha contratacion', 'fecha valor', 'fecha', 'datum', 'execution date', 'trade date'],
  type: ['type', 'action', 'transaction type', 'tipo operacion', 'tipo de operacion', 'operacion', 'tipo', 'typ', 'side', 'movimiento'],
  isin: ['isin', 'codigo isin', 'isin code'],
  ticker: ['ticker', 'symbol', 'simbolo', 'asset', 'activo', 'codigo'],
  name: ['name', 'nombre', 'descripcion', 'description', 'valor', 'fondo', 'producto', 'instrument', 'note', 'nota', 'titulo'],
  qty: ['quantity', 'shares', 'no of shares', 'units', 'titulos', 'participaciones', 'cantidad', 'acciones', 'anteile', 'qty'],
  price: ['price', 'price / share', 'precio', 'precio neto', 'precio ejecucion', 'valor liquidativo', 'vl', 'rate', 'openrate', 'spot price', 'kurs'],
  total_eur: ['total', 'amount', 'value', 'importe neto', 'importe', 'efectivo', 'betrag', 'valor', 'net amount', 'total eur'],
  cur: ['currency', 'divisa', 'moneda', 'wahrung', 'currency (price / share)', 'ccy'],
  fee: ['fee', 'fees', 'comision', 'comisiones', 'gastos', 'gebuhren', 'currency conversion fee', 'commission'],
  tax: ['tax', 'taxes', 'withholding tax', 'retencion', 'impuesto', 'impuestos', 'steuern', 'fiscalidad'],
};

function suggestMapping(normHeaders) {
  const m = {};
  Object.keys(SMART_ALIASES).forEach((field) => {
    const idx = findCol(normHeaders, SMART_ALIASES[field]);
    if (idx >= 0) m[field] = idx;
  });
  return m;
}

function guessBrokerNameFromFile(fileName, text) {
  const hay = (String(fileName || '') + ' ' + String(text || '').slice(0, 600)).toLowerCase();
  if (/trading\s*212|t212/.test(hay)) return 'Trading 212';
  if (/trade\s*republic|\bpytr\b/.test(hay)) return 'Trade Republic';
  if (/my\s*investor|inversis/.test(hay)) return 'MyInvestor';
  if (/revolut/.test(hay)) return 'Revolut';
  if (/etoro/.test(hay)) return 'eToro';
  if (/xtb/.test(hay)) return 'XTB';
  if (/scalable/.test(hay)) return 'Scalable Capital';
  if (/indexa/.test(hay)) return 'Indexa Capital';
  if (/r4|renta\s*4/.test(hay)) return 'Renta 4';
  if (/openbank/.test(hay)) return 'Openbank';
  const base = String(fileName || '').replace(/\.csv$/i, '').replace(/[_-]+/g, ' ').replace(/\d{4,}/g, '').trim();
  return base && base.length >= 3 && base.length <= 28 ? titleCase(base) : 'Otro bróker';
}

/* ---------- detección automática de formato ---------- */

function detectBroker(text, fileName) {
  const table = readCsvTable(text);
  const { delimiter, headers, normHeaders, rows } = table;
  if (!headers.length || headers.length < 2) {
    return { kind: 'invalid', delimiter, headers, rows };
  }
  const has = (h) => normHeaders.includes(h);
  const hasAny = (list) => list.some((h) => normHeaders.includes(h));

  // 1. Trading 212: Action + Time + columnas específicas T212
  if (has('action') && has('time') && (
    has('no of shares') || has('price / share') || has('currency (price / share)') ||
    has('currency (total)') || has('withholding tax') || has('currency conversion fee')
  )) {
    return { kind: 'trading212', preset: 'trading212', brokerName: 'Trading 212', delimiter, headers, normHeaders, rows };
  }

  // 2. MyInvestor / Inversis (español): cabeceras características de fondos/valores
  const fnLower = String(fileName || '').toLowerCase();
  const hasMyInvTerms =
    (hasAny(['fecha operacion', 'fecha de operacion', 'fecha contratacion', 'fecha']) &&
     hasAny(['tipo operacion', 'tipo de operacion', 'operacion', 'tipo']) &&
     (hasAny(['participaciones', 'titulos', 'precio neto', 'importe neto', 'valor liquidativo', 'vl']) ||
      /myinvestor|inversis/.test(fnLower) ||
      /suscripcion|reembolso|traspaso/i.test(text.slice(0, 4000))));
  if (hasMyInvTerms) {
    return { kind: 'myinvestor', preset: 'myinvestor', brokerName: 'MyInvestor', delimiter, headers, normHeaders, rows };
  }

  // 3. Trade Republic (app nativa, pytr o formato Pocket Portfolio para Trade Republic)
  const trFileHint = /trade[\s_-]*republic|account_transactions|\btr[\s_-]/i.test(fnLower);
  const hasTrCore =
    hasAny(['date', 'datetime', 'timestamp', 'fecha', 'datum']) &&
    hasAny(['type', 'tipo', 'typ', 'action']) &&
    (has('isin') || hasAny(['shares', 'acciones', 'anteile', 'quantity'])) &&
    hasAny(['value', 'amount', 'importe', 'betrag', 'total']);
  const isPytrExact =
    hasAny(['date', 'fecha', 'datum']) &&
    hasAny(['type', 'tipo', 'typ']) &&
    hasAny(['value', 'importe', 'betrag']) &&
    hasAny(['note', 'nota', 'notiz']) &&
    has('isin') &&
    hasAny(['shares', 'acciones', 'anteile']);
  const hasTrSignals =
    has('category') ||
    /sparplan|saveback|savings plan|plan de ahorro|trade republic|kauf|verkauf|ausschuttung|dividende|einzahlung|auszahlung/i.test(text.slice(0, 5000));
  if (isPytrExact || (hasTrCore && (trFileHint || hasTrSignals))) {
    return { kind: 'traderepublic', preset: 'traderepublic', brokerName: 'Trade Republic', delimiter, headers, normHeaders, rows };
  }

  // 4. OpenBrokerCSV (formato genérico estándar: Date, Ticker/ISIN, Type, Currency, Quantity, Price)
  const isOpenBroker =
    hasAny(['date', 'datetime', 'timestamp']) &&
    hasAny(['ticker', 'symbol', 'isin']) &&
    hasAny(['type', 'action']) &&
    hasAny(['quantity', 'shares', 'units']) &&
    hasAny(['price', 'rate']);
  if (isOpenBroker) {
    const brokerName = guessBrokerNameFromFile(fileName, text);
    const slug = slugifyBroker(brokerName);
    const preset = PRESETS[slug] ? slug : 'openbrokercsv';
    return { kind: 'openbrokercsv', preset, brokerName: PRESETS[slug] ? PRESETS[slug].name : brokerName, delimiter, headers, normHeaders, rows };
  }

  // 5. Desconocido -> Smart Mapping si tiene estructura tabular financiera (>= 3 columnas con fechas o cabeceras reconocibles)
  const suggested = suggestMapping(normHeaders);
  const sampleRows = rows.slice(0, 3).map((r) => r.slice(0, headers.length));
  const hasAnyDateInSample = sampleRows.some((r) => r.some((cell) => !!parseFlexDate(cell)));
  const looksMappable = headers.length >= 3 && rows.length >= 1 && (Object.keys(suggested).length >= 2 || hasAnyDateInSample);
  return {
    kind: looksMappable ? 'unknown' : 'unrecognized',
    delimiter,
    headers,
    normHeaders,
    rows,
    sampleRows,
    suggestedBrokerName: guessBrokerNameFromFile(fileName, text),
    suggestedMapping: suggested,
  };
}

/* ---------- clasificación universal de tipos de movimiento ---------- */

function classifyAction(rawType, rawNote, amountSign) {
  const t = normHeader(rawType);
  const note = normHeader(rawNote || '');
  const combo = t + ' ' + note;

  if (!t && !note) return 'unknown';

  // Ignorados explícitos (gastos de tarjeta, redondeos, conversiones internas de divisa)
  if (/^(currency conversion|conversion de divisa|fx conversion|card|card transaction|tarjeta|pago con tarjeta|saveback|round up|cashback|gift|regalo|reward|bono tarjeta)/.test(t) ||
      /\b(card payment|card verification|saveback|round up|spending)\b/.test(t)) {
    return 'ignore';
  }
  if (/stock split/.test(t) || /\b(split|desdoblamiento)\b/.test(t)) return 'split';
  if (/traspaso.*entrada|transfer.*in|incoming.*transfer|switch.*in/.test(t)) return 'transfer_in';
  if (/traspaso.*salida|transfer.*out|outgoing.*transfer|switch.*out/.test(t)) return 'transfer_out';

  // Dividendos
  if (/dividend|dividendo|dividende|ausschuttung|cupon|coupon|distribution|reparto/.test(t)) return 'dividend';

  // Intereses (efectivo o préstamo de valores)
  if (/interest|interes|intereses|zinsen|lending/.test(t)) return 'interest';

  // Comisiones e impuestos sueltos
  if (/^(fee|fees|comision|comisiones|custodia|gastos|gebuhren|order fee|account fee)/.test(t)) return 'fee';
  if (/^(tax|taxes|impuesto|impuestos|steuer|steuern|withholding|retencion|tax refund|devolucion impuesto)/.test(t)) return 'tax_standalone';

  // Compras / suscripciones / planes de ahorro
  if (/^(market buy|limit buy|stop buy|stop limit buy|buy|compra|kauf|purchase|suscripcion|subscription|savings plan|sparplan|plan de ahorro|ejecucion plan|auto invest|autoinvest|invest)/.test(t) ||
      /\b(buy|compra|suscripcion|sparplan|savings plan)\b/.test(t)) {
    return 'buy';
  }

  // Ventas / reembolsos
  if (/^(market sell|limit sell|stop sell|stop limit sell|sell|venta|verkauf|reembolso|redemption)/.test(t) ||
      /\b(sell|venta|reembolso)\b/.test(t)) {
    return 'sell';
  }

  // "Trade" / "Ejecución" / "Operación" (Trade Republic usa a veces "Trade" tanto para compra como para venta)
  if (/^(trade|trading|order|orden|ejecucion|operacion|handelsausfuhrung)/.test(t)) {
    if (/\b(sell|venta|verkauf)\b/.test(combo)) return 'sell';
    if (/\b(buy|compra|kauf|sparplan|savings)\b/.test(combo)) return 'buy';
    if (amountSign != null && amountSign > 0) return 'sell';
    return 'buy';
  }

  // Depósitos y retiradas
  if (/^(deposit|deposito|ingreso|aportacion|einzahlung|top ?up|incoming transfer|transferencia recibida|sepa.*in|pay ?in)/.test(t) ||
      /\b(deposit|deposito|ingreso|aportacion|einzahlung)\b/.test(t)) {
    return 'deposit';
  }
  if (/^(withdrawal|withdraw|retirada|reintegro|auszahlung|payout|outgoing transfer|transferencia emitida|sepa.*out)/.test(t) ||
      /\b(withdrawal|retirada|auszahlung)\b/.test(t)) {
    return 'withdrawal';
  }
  if (/^(transfer|transferencia|uberweisung|bank transfer)/.test(t)) {
    return amountSign != null && amountSign < 0 ? 'withdrawal' : 'deposit';
  }

  return 'unknown';
}

/* ---------- fingerprint determinista para deduplicación ---------- */

function assignUids(brokerId, events) {
  const seen = new Map();
  return events.map((ev) => {
    if (ev.uid) return ev;
    const key = [
      brokerId, ev.date, ev.time || '', ev.kind,
      ev.isin || ev.ticker || ev.name || '',
      round4(ev.qty || 0), round4(ev.price || 0),
      round2(ev.eur || 0), round2(ev.fee_eur || 0), round2(ev.tax_eur || 0),
    ].join('|');
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return Object.assign({}, ev, { uid: `${key}#${n}` });
  });
}

/* ---------- parser: Trading 212 ---------- */

function parseTrading212(table) {
  const { normHeaders, rows } = table;
  const col = (name) => normHeaders.indexOf(name);
  const idxAction = col('action');
  const idxTime = col('time');
  const idxIsin = col('isin');
  const idxTicker = col('ticker');
  const idxName = col('name');
  const idxShares = col('no of shares');
  const idxPrice = col('price / share');
  const idxPriceCur = col('currency (price / share)');
  const idxFx = col('exchange rate');
  const idxTotal = col('total');
  const idxTotalCur = col('currency (total)');
  const idxWht = col('withholding tax');
  const idxWhtCur = col('currency (withholding tax)');
  const idxFxFee = col('currency conversion fee');
  const idxFxFeeCur = col('currency (currency conversion fee)');
  const idxStamp = findCol(normHeaders, ['stamp duty reserve tax', 'stamp duty', 'french transaction tax', 'finra fee']);
  const idxId = col('id');
  const idxNotes = col('notes');

  if (idxAction < 0 || idxTime < 0) throw new UserError('el CSV de Trading 212 no tiene las columnas Action y Time.');

  const get = (r, i) => (i >= 0 && i < r.length ? String(r[i] || '').trim() : '');
  const events = [];
  let ignored = 0;
  const warnings = [];

  rows.forEach((r) => {
    const actionRaw = get(r, idxAction);
    const dt = parseFlexDate(get(r, idxTime));
    if (!actionRaw || !dt) return;
    const total = parseFlexNum(get(r, idxTotal), 'en');
    const kind = classifyAction(actionRaw, get(r, idxNotes), total);
    if (kind === 'ignore') { ignored++; return; }
    if (kind === 'unknown') { ignored++; return; }

    const isin = cleanIsin(get(r, idxIsin));
    const ticker = get(r, idxTicker).toUpperCase();
    const name = titleCase(get(r, idxName) || ticker || isin || 'Valor');
    const qty = Math.abs(parseFlexNum(get(r, idxShares), 'en') || 0);
    const price = Math.abs(parseFlexNum(get(r, idxPrice), 'en') || 0);
    const priceCur = cleanCur(get(r, idxPriceCur), 'EUR');
    const totalCur = cleanCur(get(r, idxTotalCur), 'EUR');
    const fxRate = parseFlexNum(get(r, idxFx), 'en');
    const extId = get(r, idxId);

    // Comisiones en EUR (conversión de divisa + tasas)
    let feeEur = 0;
    const fxFee = Math.abs(parseFlexNum(get(r, idxFxFee), 'en') || 0);
    const fxFeeCur = cleanCur(get(r, idxFxFeeCur), totalCur);
    if (fxFee > 0) feeEur += fxFeeCur === 'EUR' ? fxFee : (fxRate > 0 ? fxFee / fxRate : fxFee);
    if (idxStamp >= 0) {
      const st = Math.abs(parseFlexNum(get(r, idxStamp), 'en') || 0);
      if (st > 0) feeEur += st;
    }
    feeEur = round2(feeEur);

    let totalEur = total != null ? Math.abs(total) : 0;
    if (totalCur !== 'EUR' && fxRate > 0) {
      totalEur = round2(totalEur / fxRate);
    }

    if (kind === 'buy' || kind === 'sell') {
      if (!(qty > 0)) return;
      // En Trading 212, Total en compra incluye comisiones; en venta es neto tras comisiones.
      let eur = totalEur > 0 ? (kind === 'buy' ? Math.max(0, round2(totalEur - feeEur)) : round2(totalEur + feeEur)) : 0;
      if (!(eur > 0) && price > 0) {
        eur = priceCur === 'EUR' ? round2(qty * price) : (fxRate > 0 ? round2(qty * price / fxRate) : round2(qty * price));
      }
      const impliedFx = priceCur !== 'EUR' && eur > 0 && price > 0 ? round4((qty * price) / eur) : (fxRate > 0 ? fxRate : null);
      events.push({
        uid: extId ? `t212:${extId}` : null,
        date: dt.date, time: dt.time, kind,
        isin, ticker, name,
        qty: round4(qty), price: round4(price || (eur / qty)), cur: priceCur,
        eur: round2(eur), fx_rate: impliedFx, fee_eur: feeEur, tax_eur: 0,
        note: actionRaw,
      });
    } else if (kind === 'dividend') {
      const netEur = totalEur;
      const wht = Math.abs(parseFlexNum(get(r, idxWht), 'en') || 0);
      const whtCur = cleanCur(get(r, idxWhtCur), priceCur);
      let taxEur = 0;
      if (wht > 0) {
        if (whtCur === 'EUR') taxEur = round2(wht);
        else if (fxRate > 0) taxEur = round2(wht / fxRate);
        else if (qty > 0 && price > 0 && whtCur === priceCur && qty * price > wht && netEur > 0) {
          // Proporción exacta a partir del bruto nativo (qty * price) y la retención nativa
          const ratio = wht / (qty * price - wht);
          taxEur = round2(netEur * ratio);
        }
      }
      const grossEur = round2(netEur + taxEur);
      if (!(grossEur > 0)) return;
      events.push({
        uid: extId ? `t212:${extId}` : null,
        date: dt.date, time: dt.time, kind: 'dividend',
        isin, ticker, name,
        qty: round4(qty), price: round4(price), cur: priceCur,
        eur: grossEur, fee_eur: 0, tax_eur: taxEur ? -taxEur : 0,
        gross_native: qty > 0 && price > 0 ? round2(qty * price) : grossEur,
        note: actionRaw,
      });
    } else if (kind === 'deposit' || kind === 'withdrawal') {
      if (!(totalEur > 0)) return;
      events.push({
        uid: extId ? `t212:${extId}` : null,
        date: dt.date, time: dt.time, kind,
        isin: '', ticker: '', name: actionRaw,
        qty: 0, price: 0, cur: 'EUR',
        eur: round2(totalEur), fee_eur: feeEur, tax_eur: 0,
        note: get(r, idxNotes) || actionRaw,
      });
    } else if (kind === 'interest') {
      const signed = total != null ? (totalCur === 'EUR' ? total : (fxRate > 0 ? total / fxRate : total)) : 0;
      if (!signed) return;
      events.push({
        uid: extId ? `t212:${extId}` : null,
        date: dt.date, time: dt.time, kind: 'interest',
        isin: '', ticker: '', name: actionRaw,
        qty: 0, price: 0, cur: 'EUR',
        eur: round2(signed), fee_eur: 0, tax_eur: 0,
        note: actionRaw,
      });
    } else if (kind === 'fee') {
      if (!(totalEur > 0)) return;
      events.push({
        uid: extId ? `t212:${extId}` : null,
        date: dt.date, time: dt.time, kind: 'fee',
        isin: '', ticker: '', name: actionRaw,
        qty: 0, price: 0, cur: 'EUR',
        eur: round2(totalEur), fee_eur: round2(totalEur), tax_eur: 0,
        note: actionRaw,
      });
    } else if (kind === 'split') {
      warnings.push(`Trading 212 (${dt.date}, ${name}): evento de desdoblamiento (stock split) detectado; revisa que la cantidad de títulos coincida con tu bróker.`);
    }
  });

  if (ignored) warnings.push(`Trading 212: ${ignored} ${ignored === 1 ? 'fila interna omitida' : 'filas internas omitidas'} (p. ej. conversiones de divisa internas).`);
  return { events: assignUids('trading212', events), warnings, ignored };
}

/* ---------- parser genérico por mapeo (Trade Republic, MyInvestor, OpenBrokerCSV y Smart Mapping) ---------- */

function parseMappedCsv(brokerId, brokerName, table, mapping, opts) {
  opts = opts || {};
  const { delimiter, headers, normHeaders, rows } = table;
  const localeHint = opts.localeHint || (delimiter === ';' ? 'es' : 'auto');

  const colIdx = (field) => {
    if (mapping && mapping[field] != null && mapping[field] !== '' && Number(mapping[field]) >= 0) {
      return Number(mapping[field]);
    }
    return -1;
  };
  const iDate = colIdx('date');
  const iType = colIdx('type');
  const iIsin = colIdx('isin');
  const iTicker = colIdx('ticker');
  const iName = colIdx('name');
  const iQty = colIdx('qty');
  const iPrice = colIdx('price');
  const iTotal = colIdx('total_eur');
  const iCur = colIdx('cur');
  const iFee = colIdx('fee');
  const iTax = colIdx('tax');
  const iRef = findCol(normHeaders, ['id', 'reference', 'referencia', 'no operacion', 'n operacion', 'order id', 'transaction id']);
  const iFx = findCol(normHeaders, ['exchange rate', 'fx rate', 'tipo de cambio', 'cambio']);

  if (iDate < 0) throw new UserError('falta la columna de Fecha.');
  if (iType < 0 && iQty < 0 && iTotal < 0) throw new UserError('falta la columna de Tipo de operación o los importes.');

  const get = (r, i) => (i >= 0 && i < r.length ? String(r[i] || '').trim() : '');
  const events = [];
  let ignored = 0, traspasos = 0, unparsedRows = 0;
  const warnings = [];

  rows.forEach((r) => {
    const dt = parseFlexDate(get(r, iDate));
    if (!dt) { unparsedRows++; return; }

    const rawType = get(r, iType);
    const rawName = get(r, iName);
    const rawTotal = parseFlexNum(get(r, iTotal), localeHint);
    const rawQty = parseFlexNum(get(r, iQty), localeHint);
    const rawPrice = parseFlexNum(get(r, iPrice), localeHint);
    const rawFee = Math.abs(parseFlexNum(get(r, iFee), localeHint) || 0);
    const rawTax = Math.abs(parseFlexNum(get(r, iTax), localeHint) || 0);
    const fxRate = parseFlexNum(get(r, iFx), localeHint);
    const cur = cleanCur(get(r, iCur), 'EUR');
    const extRef = get(r, iRef);

    let isin = cleanIsin(get(r, iIsin)) || extractIsinFromText(rawName) || extractIsinFromText(get(r, iTicker));
    const tickerRaw = get(r, iTicker).toUpperCase();
    const ticker = tickerRaw && tickerRaw !== isin ? tickerRaw : '';
    const name = titleCase(rawName || ticker || isin || rawType || 'Operación');

    const kind = rawType
      ? classifyAction(rawType, rawName, rawTotal != null ? rawTotal : (rawQty != null ? -rawQty : null))
      : (rawQty > 0 ? 'buy' : (rawQty < 0 ? 'sell' : 'unknown'));

    if (kind === 'ignore') { ignored++; return; }
    if (kind === 'unknown') { ignored++; return; }

    const qty = Math.abs(rawQty || 0);
    const price = Math.abs(rawPrice || 0);
    const feeEur = round2(rawFee);
    const uid = extRef ? `${brokerId}:${extRef}` : null;

    if (kind === 'buy' || kind === 'sell' || kind === 'transfer_in' || kind === 'transfer_out') {
      if (kind === 'transfer_in' || kind === 'transfer_out') traspasos++;
      let eur = rawTotal != null ? Math.abs(rawTotal) : 0;
      let effPrice = price;
      let effQty = qty;
      if (!(eur > 0) && effQty > 0 && effPrice > 0) {
        eur = cur === 'EUR' ? round2(effQty * effPrice) : (fxRate > 0 ? round2(effQty * effPrice / fxRate) : round2(effQty * effPrice));
      }
      if (!(effPrice > 0) && effQty > 0 && eur > 0) {
        effPrice = round4(eur / effQty);
      }
      if (!(effQty > 0) && eur > 0 && effPrice > 0) {
        effQty = round4(eur / effPrice);
      }
      if (!(effQty > 0)) { ignored++; return; }

      // Para Trade Republic (pytr / app), el campo Value/Amount incluye comisiones en muchos extractos:
      // si eur coincide con qty * price + fee (en compra) o qty * price - fee (en venta), se separa la comisión.
      let tradeEur = eur;
      if (feeEur > 0 && effPrice > 0 && cur === 'EUR') {
        const gross = round2(effQty * effPrice);
        if ((kind === 'buy' || kind === 'transfer_in') && Math.abs(eur - (gross + feeEur)) < 0.05) {
          tradeEur = gross;
        } else if ((kind === 'sell' || kind === 'transfer_out') && Math.abs(eur - (gross - feeEur)) < 0.05) {
          tradeEur = gross;
        }
      }
      const impliedFx = cur !== 'EUR' && tradeEur > 0 && effPrice > 0 ? round4((effQty * effPrice) / tradeEur) : (fxRate > 0 ? fxRate : null);

      events.push({
        uid,
        date: dt.date, time: dt.time, kind,
        isin, ticker, name,
        qty: round4(effQty), price: round4(effPrice), cur,
        eur: round2(tradeEur), fx_rate: impliedFx, fee_eur: feeEur, tax_eur: 0,
        note: rawType || kind,
      });
    } else if (kind === 'dividend') {
      let netOrGross = rawTotal != null ? Math.abs(rawTotal) : (qty > 0 && price > 0 ? round2(qty * price) : 0);
      if (!(netOrGross > 0)) return;
      // Si el archivo trae columna de retención (tax > 0): en pytr/Trade Republic y MyInvestor
      // el importe neto suele ser lo abonado en cuenta; si net + tax cuadra, bruto = net + tax.
      const grossEur = opts.dividendTotalIsNet && rawTax > 0 ? round2(netOrGross + rawTax) : round2(netOrGross);
      const taxEur = rawTax > 0 ? -round2(Math.min(rawTax, grossEur)) : 0;
      events.push({
        uid,
        date: dt.date, time: dt.time, kind: 'dividend',
        isin, ticker, name,
        qty: round4(qty), price: round4(price), cur,
        eur: grossEur, fee_eur: feeEur, tax_eur: taxEur,
        gross_native: grossEur,
        note: rawType || 'Dividendo',
      });
    } else if (kind === 'deposit' || kind === 'withdrawal') {
      const amt = rawTotal != null ? Math.abs(rawTotal) : 0;
      if (!(amt > 0)) return;
      events.push({
        uid,
        date: dt.date, time: dt.time, kind,
        isin: '', ticker: '', name: rawType || kind,
        qty: 0, price: 0, cur: 'EUR',
        eur: round2(amt), fee_eur: feeEur, tax_eur: 0,
        note: rawName || rawType,
      });
    } else if (kind === 'interest') {
      const amt = rawTotal != null ? rawTotal : 0;
      if (!amt) return;
      // Si viene con retención (p. ej. cuenta remunerada Trade Republic), el bruto para RCM es neto + retención si procede
      const gross = amt > 0 && rawTax > 0 && opts.dividendTotalIsNet ? round2(amt + rawTax) : round2(amt);
      events.push({
        uid,
        date: dt.date, time: dt.time, kind: 'interest',
        isin: '', ticker: '', name: rawType || 'Interés',
        qty: 0, price: 0, cur: 'EUR',
        eur: gross, fee_eur: 0, tax_eur: rawTax > 0 ? -round2(rawTax) : 0,
        note: rawName || rawType,
      });
    } else if (kind === 'fee') {
      const amt = rawTotal != null ? Math.abs(rawTotal) : feeEur;
      if (!(amt > 0)) return;
      events.push({
        uid,
        date: dt.date, time: dt.time, kind: 'fee',
        isin: '', ticker: '', name: rawType || 'Comisión',
        qty: 0, price: 0, cur: 'EUR',
        eur: round2(amt), fee_eur: round2(amt), tax_eur: 0,
        note: rawName || rawType,
      });
    } else if (kind === 'tax_standalone') {
      // Impuesto suelto: se registra como retención/ajuste si tiene importe negativo o se omite con aviso si es ajuste bancario
      ignored++;
    } else if (kind === 'split') {
      warnings.push(`${brokerName} (${dt.date}, ${name}): desdoblamiento detectado; verifica los títulos abiertos.`);
    }
  });

  if (traspasos > 0) {
    warnings.push(`${brokerName}: se han importado ${traspasos} ${traspasos === 1 ? 'traspaso de fondos' : 'traspasos de fondos'}. En España los traspasos entre fondos no tributan en IRPF y conservan la fecha y coste de adquisición originales; la simulación fiscal los excluye de ventas tributables.`);
  }
  if (ignored > 0) {
    warnings.push(`${brokerName}: ${ignored} ${ignored === 1 ? 'fila no bursátil omitida' : 'filas no bursátiles omitidas'} (p. ej. pagos con tarjeta, saveback o movimientos internos).`);
  }
  if (!events.length && unparsedRows === rows.length) {
    throw new UserError(`no se ha podido leer ninguna fecha válida en la columna «${headers[iDate] || 'Fecha'}». Revisa el mapeo de columnas.`);
  }
  return { events: assignUids(brokerId, events), warnings, ignored };
}

/* ---------- punto de entrada único de parseo para archivos no DEGIRO/IBKR ---------- */

/**
 * Parsea un CSV de Trading 212, Trade Republic, MyInvestor, OpenBrokerCSV o con mapeo personalizado.
 * Si el formato es desconocido y no se proporciona `userMapping`, devuelve `{ needsMapping: true, ... }`.
 */
function parseBrokerCsv(text, fileName, userMapping) {
  const det = detectBroker(text, fileName);
  if (det.kind === 'invalid' || det.kind === 'unrecognized') {
    throw new UserError('no se reconoce como extracto de DEGIRO, Interactive Brokers, Trading 212, Trade Republic, MyInvestor ni como CSV bursátil válido.');
  }

  // Si el usuario envió un mapeo explícito (Smart Mapping)
  if (userMapping && userMapping.columns) {
    const brokerName = String(userMapping.brokerName || det.suggestedBrokerName || 'Otro bróker').trim().slice(0, 48) || 'Otro bróker';
    const meta = brokerMeta(userMapping.brokerId || brokerName, brokerName);
    const parsed = parseMappedCsv(meta.id, meta.name, det, userMapping.columns, {
      dividendTotalIsNet: !!userMapping.dividendTotalIsNet,
    });
    if (!parsed.events.length) {
      throw new UserError(`no se ha encontrado ningún movimiento válido con ese mapeo para ${meta.name}.`);
    }
    return {
      needsMapping: false,
      brokerId: meta.id,
      brokerName: meta.name,
      preset: PRESETS[meta.id] ? meta.id : 'custom',
      events: parsed.events,
      warnings: parsed.warnings,
    };
  }

  if (det.kind === 'unknown') {
    return {
      needsMapping: true,
      name: fileName,
      delimiter: det.delimiter,
      headers: det.headers,
      sampleRows: det.sampleRows,
      suggestedBrokerName: det.suggestedBrokerName,
      suggestedMapping: det.suggestedMapping,
      rowCount: det.rows.length,
    };
  }

  if (det.kind === 'trading212') {
    const parsed = parseTrading212(det);
    if (!parsed.events.length) throw new UserError('el archivo de Trading 212 no contiene movimientos reconocidos.');
    return {
      needsMapping: false,
      brokerId: 'trading212',
      brokerName: 'Trading 212',
      preset: 'trading212',
      events: parsed.events,
      warnings: parsed.warnings,
    };
  }

  if (det.kind === 'traderepublic') {
    const map = suggestMapping(det.normHeaders);
    const parsed = parseMappedCsv('traderepublic', 'Trade Republic', det, map, { dividendTotalIsNet: true });
    if (!parsed.events.length) throw new UserError('el archivo de Trade Republic no contiene movimientos bursátiles reconocidos.');
    return {
      needsMapping: false,
      brokerId: 'traderepublic',
      brokerName: 'Trade Republic',
      preset: 'traderepublic',
      events: parsed.events,
      warnings: parsed.warnings,
    };
  }

  if (det.kind === 'myinvestor') {
    const map = suggestMapping(det.normHeaders);
    const parsed = parseMappedCsv('myinvestor', 'MyInvestor', det, map, { localeHint: 'es', dividendTotalIsNet: false });
    if (!parsed.events.length) throw new UserError('el archivo de MyInvestor no contiene operaciones reconocidas.');
    return {
      needsMapping: false,
      brokerId: 'myinvestor',
      brokerName: 'MyInvestor',
      preset: 'myinvestor',
      events: parsed.events,
      warnings: parsed.warnings,
    };
  }

  // OpenBrokerCSV
  const meta = brokerMeta(det.brokerName, det.brokerName);
  const map = suggestMapping(det.normHeaders);
  const parsed = parseMappedCsv(meta.id, meta.name, det, map, { dividendTotalIsNet: false });
  if (!parsed.events.length) throw new UserError('el archivo CSV no contiene movimientos válidos.');
  return {
    needsMapping: false,
    brokerId: meta.id,
    brokerName: meta.name,
    preset: det.preset,
    events: parsed.events,
    warnings: parsed.warnings,
  };
}

/* ---------- fusión deduplicada del libro de brókers adicionales ---------- */

function mergeBrokerLedger(extraLedgers, brokerId, brokerName, preset, newEvents) {
  const next = JSON.parse(JSON.stringify(extraLedgers || emptyExtraLedgers()));
  next.version = 1;
  next.brokers = next.brokers || {};
  const existing = next.brokers[brokerId] || { id: brokerId, name: brokerName, preset: preset || brokerId, events: [] };
  existing.name = brokerName || existing.name;
  if (preset) existing.preset = preset;
  const knownUids = new Set((existing.events || []).map((e) => e.uid));
  let added = 0, duplicates = 0;
  (newEvents || []).forEach((ev) => {
    if (knownUids.has(ev.uid)) { duplicates++; return; }
    knownUids.add(ev.uid);
    existing.events.push(ev);
    added++;
  });
  existing.events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.uid.localeCompare(b.uid));
  next.brokers[brokerId] = existing;
  return { ledgers: next, added, duplicates };
}

/* ---------- derivación del estado de cada bróker adicional ---------- */

function deriveBroker(brokerEntry, prevPortfolio) {
  const id = brokerEntry.id;
  const meta = brokerMeta(id, brokerEntry.name);
  const events = (brokerEntry.events || []).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.uid.localeCompare(b.uid));
  const prevBroker = (prevPortfolio && prevPortfolio.extra_brokers && prevPortfolio.extra_brokers[id]) || null;
  const prevPosById = new Map();
  const prevPosByIsin = new Map();
  if (prevBroker && Array.isArray(prevBroker.positions)) {
    prevBroker.positions.forEach((p) => {
      if (p.id) prevPosById.set(p.id, p);
      if (p.isin) prevPosByIsin.set(p.isin, p);
    });
  }

  const hasExplicitCashflows = events.some((e) => e.kind === 'deposit' || e.kind === 'withdrawal');
  const posMap = new Map();
  const realizedMap = new Map();
  const divMap = new Map();
  const cashflowEvents = []; // [iso, -signedEur] (convención DEGIRO: negativo = dinero que entra)
  const monthlyMap = new Map();
  const lastRates = {};
  const trades = [];         // para IRPF y reporte
  const dividendEvents = []; // para IRPF
  const interestEvents = []; // para IRPF
  const warnings = [];

  let depositsGross = 0, withdrawals = 0, divGross = 0, divTax = 0;
  let tradeFees = 0, nonTradeFeesSum = 0, interestSum = 0;
  let simCash = 0; // solo se usa para inferir aportaciones si el CSV no trae depósitos/retiradas

  const addCashflow = (date, signedEur) => {
    if (!signedEur) return;
    if (signedEur > 0) depositsGross = round2(depositsGross + signedEur);
    else withdrawals = round2(withdrawals + signedEur);
    cashflowEvents.push([date, round2(-signedEur)]);
    const ym = date.slice(0, 7);
    monthlyMap.set(ym, round2((monthlyMap.get(ym) || 0) + signedEur));
  };

  events.forEach((ev) => {
    if (ev.fx_rate > 0 && ev.cur && ev.cur !== 'EUR') lastRates[ev.cur] = ev.fx_rate;

    if (ev.kind === 'deposit') {
      addCashflow(ev.date, ev.eur);
      if (ev.fee_eur > 0) nonTradeFeesSum = round2(nonTradeFeesSum - ev.fee_eur);
      return;
    }
    if (ev.kind === 'withdrawal') {
      addCashflow(ev.date, -ev.eur);
      if (ev.fee_eur > 0) nonTradeFeesSum = round2(nonTradeFeesSum - ev.fee_eur);
      return;
    }
    if (ev.kind === 'fee') {
      const f = Math.abs(ev.fee_eur || ev.eur || 0);
      nonTradeFeesSum = round2(nonTradeFeesSum - f);
      simCash = round2(simCash - f);
      return;
    }
    if (ev.kind === 'interest') {
      const amt = round2(ev.eur || 0);
      const tax = round2(ev.tax_eur || 0);
      interestSum = round2(interestSum + amt + tax);
      simCash = round2(simCash + amt + tax);
      interestEvents.push({ date: ev.date, account: meta.name, kind: 'interest', amount_eur: amt });
      return;
    }
    if (ev.kind === 'dividend') {
      const gross = round2(Math.abs(ev.eur || 0));
      const tax = round2(ev.tax_eur <= 0 ? ev.tax_eur : -ev.tax_eur);
      if (!(gross > 0)) return;
      divGross = round2(divGross + gross);
      divTax = round2(divTax + tax);
      simCash = round2(simCash + gross + tax);
      const key = (ev.isin || ev.ticker || ev.name).toLowerCase();
      if (!divMap.has(key)) {
        divMap.set(key, { account: meta.name, broker_id: id, name: ev.name, cur: ev.cur || 'EUR', gross_native: 0, gross_eur: 0, tax_eur: 0, approx: false });
      }
      const drow = divMap.get(key);
      drow.gross_native = round2(drow.gross_native + (ev.gross_native || gross));
      drow.gross_eur = round2(drow.gross_eur + gross);
      drow.tax_eur = round2(drow.tax_eur + tax);
      dividendEvents.push({
        date: ev.date, account: meta.name, name: ev.name, isin: ev.isin || '', cur: ev.cur || 'EUR',
        gross_eur: gross, tax_eur: tax, approx: false,
      });
      return;
    }

    if (ev.kind === 'buy' || ev.kind === 'transfer_in') {
      const code = ev.isin || ev.ticker || slugifyBroker(ev.name).toUpperCase();
      const cur = ev.cur || 'EUR';
      const posId = `${code}:${cur}`;
      const fee = round2(Math.abs(ev.fee_eur || 0));
      const outlay = round2(Math.abs(ev.eur || 0) + fee);
      if (!hasExplicitCashflows && ev.kind === 'buy') {
        const need = round2(Math.max(0, outlay - simCash));
        if (need > 0.005) { addCashflow(ev.date, need); simCash = round2(simCash + need); }
        simCash = round2(simCash - outlay);
      } else if (!hasExplicitCashflows && ev.kind === 'transfer_in') {
        if (outlay > 0.005) addCashflow(ev.date, outlay);
      }
      if (fee > 0) tradeFees = round2(tradeFees - fee);

      let p = posMap.get(posId);
      if (!p) {
        p = {
          id: posId, broker_id: id, isin: ev.isin || code, ticker: ev.ticker || '',
          name: ev.name || code, qty: 0, cost_total: 0, cost_avg: 0,
          last_price: ev.price, last_price_cur: cur, last_price_date: isoToDmy(ev.date),
          opened: ev.date,
        };
        posMap.set(posId, p);
      }
      p.qty = round4(p.qty + ev.qty);
      p.cost_total = round2(p.cost_total + outlay);
      p.last_price = ev.price;
      p.last_price_cur = cur;
      p.last_price_date = isoToDmy(ev.date);
      if (ev.name && p.name === code) p.name = ev.name;

      if (ev.kind === 'buy') {
        trades.push({
          date: ev.date, time: ev.time || '00:00:00', account: meta.name, side: 'compra',
          isin: ev.isin || code, name: p.name, qty: ev.qty, price: ev.price, cur,
          eur: round2(Math.abs(ev.eur || 0)), fee, pl: 0,
        });
      }
      return;
    }

    if (ev.kind === 'sell' || ev.kind === 'transfer_out') {
      const code = ev.isin || ev.ticker || slugifyBroker(ev.name).toUpperCase();
      const cur = ev.cur || 'EUR';
      const posId = `${code}:${cur}`;
      let p = posMap.get(posId);
      if (!p) {
        // Buscar por mismo ISIN/ticker en otra divisa si existe
        for (const cand of posMap.values()) {
          if ((ev.isin && cand.isin === ev.isin) || (ev.ticker && cand.ticker === ev.ticker)) { p = cand; break; }
        }
      }
      const fee = round2(Math.abs(ev.fee_eur || 0));
      const proceedsGross = round2(Math.abs(ev.eur || 0));
      const proceedsNet = round2(proceedsGross - fee);
      if (fee > 0) tradeFees = round2(tradeFees - fee);

      if (!p || p.qty <= 1e-9) {
        warnings.push(`${meta.name} (${ev.date}): venta de ${ev.name} sin posición abierta previa (puede faltar el historial anterior).`);
        if (!hasExplicitCashflows) simCash = round2(simCash + proceedsNet);
        return;
      }
      const sellQty = Math.min(ev.qty, p.qty);
      const full = Math.abs(sellQty - p.qty) < 1e-6;
      const costRemoved = full ? p.cost_total : round2(p.cost_total * (sellQty / p.qty));
      const pl = ev.kind === 'sell' ? round2(proceedsNet - costRemoved) : 0;

      if (ev.kind === 'sell') {
        const rKey = p.isin || p.id;
        if (!realizedMap.has(rKey)) realizedMap.set(rKey, { name: p.name, isin: p.isin, account: meta.name, broker_id: id, pl: 0 });
        realizedMap.get(rKey).pl = round2(realizedMap.get(rKey).pl + pl);
        trades.push({
          date: ev.date, time: ev.time || '00:00:00', account: meta.name, side: 'venta',
          isin: p.isin, name: p.name, qty: sellQty, price: ev.price, cur,
          eur: proceedsGross, fee, pl,
        });
      }

      if (!hasExplicitCashflows) {
        if (ev.kind === 'sell') simCash = round2(simCash + proceedsNet);
        else if (costRemoved > 0.005) addCashflow(ev.date, -costRemoved);
      }

      if (full) {
        posMap.delete(p.id);
      } else {
        p.qty = round4(p.qty - sellQty);
        p.cost_total = round2(p.cost_total - costRemoved);
        p.last_price = ev.price;
        p.last_price_cur = cur;
        p.last_price_date = isoToDmy(ev.date);
      }
    }
  });

  // Conservar precios de mercado ya guardados si existen
  const positions = Array.from(posMap.values()).filter((p) => p.qty > 1e-6).map((p) => {
    const prev = prevPosById.get(p.id) || (p.isin ? prevPosByIsin.get(p.isin) : null);
    const hasSaved = prev && prev.live_price > 0 && !/^Precio de la última operación/.test(prev.live_src || '');
    const livePrice = hasSaved ? prev.live_price : p.last_price;
    const liveCur = hasSaved ? (prev.live_price_cur || p.last_price_cur) : p.last_price_cur;
    const dmyParts = p.last_price_date.split('-');
    const lastIso = `${dmyParts[2]}-${dmyParts[1]}-${dmyParts[0]}`;
    const liveSrc = hasSaved ? prev.live_src : `Precio de la última operación (${dateLabels(lastIso).short})`;
    return Object.assign(p, {
      cost_avg: round4(p.cost_total / p.qty),
      live_price: livePrice,
      live_price_cur: liveCur,
      live_src: liveSrc,
    });
  });

  const realized = Array.from(realizedMap.values()).sort((a, b) => a.pl - b.pl);
  const dividends = Array.from(divMap.values());
  cashflowEvents.sort((a, b) => a[0].localeCompare(b[0]));
  const monthly = Array.from(monthlyMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const dates = events.map((e) => e.date).sort();

  const contributions = round2(depositsGross + withdrawals);
  const divNet = round2(divGross + divTax);
  const totalFees = round2(tradeFees + nonTradeFeesSum);

  if (!hasExplicitCashflows && events.some((e) => e.kind === 'buy')) {
    warnings.push(`${meta.name}: el archivo no incluye filas de ingresos/retiradas bancarias; las aportaciones netas (${contributions.toFixed(2).replace('.', ',')} €) se han estimado a partir del capital invertido en las compras.`);
  }

  return {
    broker: {
      id,
      name: meta.name,
      preset: brokerEntry.preset || id,
      positions,
      realized,
      cashflow_events: cashflowEvents,
      monthly,
      cashflows_inferred: !hasExplicitCashflows,
      deposits_gross: depositsGross,
      withdrawals,
      contributions,
      div_gross: divGross,
      div_tax: divTax,
      div_net: divNet,
      fees: totalFees,
      trade_fees: tradeFees,
      non_trade_fees: nonTradeFeesSum,
      interest: interestSum,
      date_min: dates[0] || '',
      date_max: dates[dates.length - 1] || '',
      movements_count: events.length,
      positions_count: positions.length,
      // Estos campos los calcula recomputeDerived() en lib/calc.js:
      cost_total: 0, value_total: 0, unrealized_pl: 0, unrealized_pct: 0,
      realized_total: 0, realized_gains: 0, realized_losses: 0,
      total_return: 0, total_return_pct: 0, implied_cash: 0, nav_total: 0, xirr_pct: null,
    },
    dividends,
    lastRates,
    trades,
    dividendEvents,
    interestEvents,
    warnings,
  };
}

/** Plantilla CSV estándar OpenBrokerCSV lista para descargar desde la interfaz. */
const GENERIC_CSV_TEMPLATE = [
  'Date,Ticker,ISIN,Name,Type,Currency,Quantity,Price,Total,Fee,Tax',
  '2025-01-15,,,Ingreso inicial,Deposit,EUR,0,0,1000.00,0,0',
  '2025-01-16,VWCE,IE00BK5BQT80,Vanguard FTSE All-World UCITS ETF,Buy,EUR,8,120.50,964.00,1.00,0',
  '2025-06-20,AAPL,US0378331005,Apple Inc.,Dividend,USD,0,0,12.50,0,1.88',
].join('\n') + '\n';

module.exports = {
  PRESETS,
  GENERIC_CSV_TEMPLATE,
  emptyExtraLedgers,
  slugifyBroker,
  brokerMeta,
  parseFlexNum,
  parseFlexDate,
  detectBroker,
  parseBrokerCsv,
  mergeBrokerLedger,
  deriveBroker,
};
