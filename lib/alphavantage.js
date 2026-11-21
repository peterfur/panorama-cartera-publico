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

  return { quote, fx, daily, fxDaily, weekly, fxWeekly };
}

module.exports = { createClient, QuoteError };
