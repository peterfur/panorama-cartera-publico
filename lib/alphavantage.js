'use strict';
/*
 * Cliente mínimo de Alpha Vantage (https://www.alphavantage.co).
 *
 * La clave se lee de .env (ALPHAVANTAGE_API_KEY) y no sale nunca hacia el
 * navegador: el panel pregunta a este servidor y el servidor pregunta a
 * Alpha Vantage. El plan gratuito permite unas 25 consultas al día, así que
 * las respuestas se guardan en memoria unos minutos para que un reintento no
 * gaste cupo.
 */

class QuoteError extends Error {
  constructor(code, message) { super(message); this.name = 'QuoteError'; this.code = code; }
}

const LEADING_NOISE = /^(?:adr\s+on|sponsored\s+adr\s+on|the)\s+/i;
const TRAILING_NOISE = [
  /\s*\([^)]*\)\s*$/,
  /[\s,.-]+(?:class\s+[a-z0-9]{1,2}|cl\.?\s*[a-z0-9]{1,2}|class|ord(?:inary)?|common\s+stock|registered|reg\.?|shs|shares)$/i,
  /[\s,]+(?:holdings?|hldgs?|corporation|corp\.?|incorporated|inc\.?|company|co\.?|limited|ltd\.?|p\.?l\.?c\.?|n\.?v\.?|s\.?a\.?|a\.?g\.?|s\.?p\.?a\.?|s\.?e\.?|a\.?b\.?|oyj|asa|k\.?k\.?|l\.?l\.?c\.?|l\.?p\.?|group|grp\.?|publ\.?|adr|ao)\.?$/i,
];

/**
 * Limpia sufijos típicos de brókers (Class A, Holdings, Inc., N.V., PLC…)
 * para mejorar los resultados de SYMBOL_SEARCH, conservando un fallback útil.
 */
function cleanSearchQuery(name) {
  const original = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!original) return '';
  let s = original;
  // Eliminar anotaciones entre paréntesis en medio o al final, p. ej. "(Publ)"
  const withoutParens = s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (withoutParens.length >= 2) s = withoutParens;

  let changed = true;
  while (changed) {
    changed = false;
    const noLead = s.replace(LEADING_NOISE, '').trim();
    if (noLead !== s && noLead.length >= 2) {
      s = noLead;
      changed = true;
    }
    for (const re of TRAILING_NOISE) {
      const next = s.replace(re, '').replace(/[\s,]+$/, '').trim();
      if (next !== s && next.length >= 2) {
        s = next;
        changed = true;
      }
    }
  }
  s = s.replace(/[\s,]+$/, '').trim();
  return s.length >= 2 ? s : original;
}

function normalizeMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const symbol = String(m['1. symbol'] != null ? m['1. symbol'] : (m.symbol || '')).trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-]{1,15}$/.test(symbol)) return null;
  const rawScore = m['9. matchScore'] != null ? m['9. matchScore'] : m.matchScore;
  const score = parseFloat(rawScore);
  return {
    symbol,
    name: String(m['2. name'] != null ? m['2. name'] : (m.name || '')).trim(),
    type: String(m['3. type'] != null ? m['3. type'] : (m.type || '')).trim(),
    region: String(m['4. region'] != null ? m['4. region'] : (m.region || '')).trim(),
    currency: String(m['8. currency'] != null ? m['8. currency'] : (m.currency || '')).trim().toUpperCase(),
    matchScore: isFinite(score) ? score : 0,
  };
}

/**
 * Elige el mejor candidato de SYMBOL_SEARCH priorizando coincidencia exacta
 * de divisa, tipo Equity, matchScore y similitud de nombre.
 */
function pickBestSymbolMatch(matches, opts) {
  if (!Array.isArray(matches) || !matches.length) return null;
  opts = opts || {};
  const targetCur = opts.currency ? String(opts.currency).trim().toUpperCase() : '';
  const targetClean = opts.name ? cleanSearchQuery(opts.name).toLowerCase() : '';
  const targetTokens = targetClean ? targetClean.split(/[^a-z0-9]+/).filter((t) => t.length >= 2) : [];

  let best = null;
  let bestScore = -Infinity;
  for (const raw of matches) {
    const m = normalizeMatch(raw);
    if (!m) continue;
    let score = (m.matchScore || 0) * 100;
    if (targetCur && m.currency === targetCur) score += 50;
    else if (targetCur && m.currency && m.currency !== targetCur) score -= 10;
    if (/^equity$/i.test(m.type)) score += 25;
    if (targetClean && m.name) {
      const candClean = cleanSearchQuery(m.name).toLowerCase();
      if (candClean === targetClean) score += 15;
      else if (candClean.startsWith(targetClean) || targetClean.startsWith(candClean)) score += 10;
      else if (targetTokens.length && targetTokens.every((t) => candClean.includes(t))) score += 8;
    }
    // En USD, ligera preferencia por ticker principal sin sufijo de bolsa secundaria (p. ej. VRT frente a VRT.DEX)
    if (m.currency === 'USD' && !m.symbol.includes('.')) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function createClient(opts) {
  const getKey = opts.getKey;
  const baseUrl = (opts.baseUrl || 'https://www.alphavantage.co').replace(/\/$/, '');
  const cacheMs = (opts.cacheMinutes == null ? 15 : opts.cacheMinutes) * 60 * 1000;
  const cache = new Map();

  async function call(params) {
    const key = getKey();
    if (!key) throw new QuoteError('no_api_key', 'No hay clave de Alpha Vantage configurada (archivo .env).');
    const cacheKey = JSON.stringify(params);
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < cacheMs) return Object.assign({}, hit.value, { cached: true });

    const qs = new URLSearchParams(Object.assign({}, params, { apikey: key })).toString();
    let res;
    try {
      res = await fetch(`${baseUrl}/query?${qs}`, { signal: AbortSignal.timeout(15000) });
    } catch (e) {
      throw new QuoteError('network', 'Sin conexión con Alpha Vantage (¿estás sin internet?).');
    }
    if (!res.ok) throw new QuoteError('upstream', `Alpha Vantage respondió con un error (${res.status}).`);
    let payload;
    try { payload = await res.json(); } catch (e) { throw new QuoteError('upstream', 'Respuesta ilegible de Alpha Vantage.'); }

    const note = payload.Note || payload.Information || payload['Error Message'];
    if (note) {
      if (/premium|entitled/i.test(note) && !/25 requests|per day/i.test(note)) throw new QuoteError('premium', 'Esa consulta solo está en los planes de pago de Alpha Vantage.');
      if (/rate limit|per day|per minute|frequency|requests/i.test(note)) throw new QuoteError('rate_limited', 'Se alcanzó el límite de consultas gratuitas de Alpha Vantage.');
      if (/apikey|api key/i.test(note)) throw new QuoteError('bad_key', 'Alpha Vantage rechazó la clave: revisa ALPHAVANTAGE_API_KEY en .env.');
      throw new QuoteError('no_data', 'Alpha Vantage no tiene datos para esa consulta.');
    }
    return { payload, store(value) { cache.set(cacheKey, { at: Date.now(), value }); return value; } };
  }

  /** Último precio de un símbolo, en la divisa en la que cotiza ese símbolo. */
  async function quote(symbol) {
    const r = await call({ function: 'GLOBAL_QUOTE', symbol, datatype: 'json' });
    if (r.cached) return r;
    const gq = r.payload['Global Quote'] || {};
    const price = parseFloat(gq['05. price']);
    if (!(price > 0)) throw new QuoteError('no_data', `Alpha Vantage no devuelve precio para ${symbol}.`);
    return r.store({ symbol, price, day: gq['07. latest trading day'] || null });
  }

  /** Tipo de cambio expresado como "unidades de la divisa por 1 EUR". */
  async function fx(currency) {
    const r = await call({ function: 'CURRENCY_EXCHANGE_RATE', from_currency: currency, to_currency: 'EUR' });
    if (r.cached) return r;
    const row = r.payload['Realtime Currency Exchange Rate'] || {};
    const eurPerUnit = parseFloat(row['5. Exchange Rate']);
    if (!(eurPerUnit > 0)) throw new QuoteError('no_data', `Alpha Vantage no devuelve tipo de cambio para ${currency}.`);
    return r.store({ currency, rate: Math.round((1 / eurPerUnit) * 10000) / 10000 });
  }

  /** Cierres diarios (últimos ~100 días de mercado), sin ajustar: { points: [[fecha, precio]], cached? }. */
  async function daily(symbol) {
    const r = await call({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact', datatype: 'json' });
    if (r.cached) return r;
    const ts = r.payload['Time Series (Daily)'] || {};
    const points = Object.keys(ts).sort().map((d) => [d, parseFloat(ts[d]['4. close'])]).filter(([, p]) => p > 0);
    if (!points.length) throw new QuoteError('no_data', `Alpha Vantage no devuelve cierres diarios para ${symbol}.`);
    return r.store({ points });
  }

  /** Tipo de cambio diario: unidades de `to` por 1 de `from`: { points, cached? }. */
  async function fxDaily(from, to) {
    const r = await call({ function: 'FX_DAILY', from_symbol: from, to_symbol: to, outputsize: 'compact', datatype: 'json' });
    if (r.cached) return r;
    const ts = r.payload['Time Series FX (Daily)'] || {};
    const points = Object.keys(ts).sort().map((d) => [d, parseFloat(ts[d]['4. close'])]).filter(([, p]) => p > 0);
    if (!points.length) throw new QuoteError('no_data', `Alpha Vantage no devuelve el cambio diario ${from}/${to}.`);
    return r.store({ points });
  }

  /** Serie semanal con el precio ajustado (dividendos reinvertidos): [[fecha, precio]] de la más antigua a la más reciente. */
  async function weekly(symbol) {
    const r = await call({ function: 'TIME_SERIES_WEEKLY_ADJUSTED', symbol, datatype: 'json' });
    if (r.cached) return r.points;
    const ts = r.payload['Weekly Adjusted Time Series'] || {};
    const points = Object.keys(ts).sort().map((d) => [d, parseFloat(ts[d]['5. adjusted close'])]).filter(([, p]) => p > 0);
    if (!points.length) throw new QuoteError('no_data', `Alpha Vantage no devuelve histórico para ${symbol}.`);
    return r.store({ points }).points;
  }

  /** Tipo de cambio semanal: unidades de `to` por 1 de `from` (EUR→USD: dólares por euro). */
  async function fxWeekly(from, to) {
    const r = await call({ function: 'FX_WEEKLY', from_symbol: from, to_symbol: to, datatype: 'json' });
    if (r.cached) return r.points;
    const ts = r.payload['Time Series FX (Weekly)'] || {};
    const points = Object.keys(ts).sort().map((d) => [d, parseFloat(ts[d]['4. close'])]).filter(([, p]) => p > 0);
    if (!points.length) throw new QuoteError('no_data', `Alpha Vantage no devuelve histórico del cambio ${from}/${to}.`);
    return r.store({ points }).points;
  }

  /** Búsqueda de símbolos en Alpha Vantage (SYMBOL_SEARCH). Devuelve lista normalizada. */
  async function symbolSearch(keywords) {
    const kw = String(keywords == null ? '' : keywords).trim();
    if (!kw) return [];
    const r = await call({ function: 'SYMBOL_SEARCH', keywords: kw, datatype: 'json' });
    if (r.cached) return r.matches;
    const raw = Array.isArray(r.payload.bestMatches) ? r.payload.bestMatches : [];
    const matches = raw.map(normalizeMatch).filter(Boolean);
    return r.store({ matches }).matches;
  }

  return { quote, fx, daily, fxDaily, weekly, fxWeekly, symbolSearch };
}

/** Búsqueda directa de símbolos usando una clave explícita (mismo manejo de errores/rate-limit). */
async function symbolSearch(keywords, apiKey, opts) {
  const c = createClient({
    getKey: () => String(apiKey == null ? '' : apiKey).trim(),
    baseUrl: (opts && opts.baseUrl) || process.env.ALPHAVANTAGE_BASE_URL,
    cacheMinutes: 0,
  });
  return c.symbolSearch(keywords);
}

module.exports = { createClient, QuoteError, cleanSearchQuery, pickBestSymbolMatch, symbolSearch };
