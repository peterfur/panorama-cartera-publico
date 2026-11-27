'use strict';
/*
 * Comparación con índices: «¿y si cada euro que he aportado lo hubiera metido
 * en el S&P 500 (o en el Nasdaq-100) el mismo día?».
 *
 * Con cada aportación se compran participaciones del índice al precio de ese
 * día y con cada retirada se venden; el valor de esas participaciones a lo
 * largo del tiempo es la línea del índice. Así la comparación usa exactamente
 * el mismo dinero y las mismas fechas que la cartera real.
 *
 * Los índices se siguen con fondos cotizados que los replican (SPY, QQQ…) y su
 * precio «ajustado», que incluye los dividendos reinvertidos; se pasan a euros
 * con el tipo de cambio de cada semana. Los datos se guardan en
 * data/indices.json para poder trabajar sin conexión.
 */

const {
  round2, isoToMs, DAY_MS, xirr,
  contributionFlows, portfolioValuationDate, annualizeReturnPct, computePortfolioMetrics,
} = require('./calc');

const DEFAULT_BENCHMARKS = [
  { id: 'sp500', name: 'S&P 500', symbol: 'SPY', cur: 'USD' },
  { id: 'ndx', name: 'Nasdaq-100', symbol: 'QQQ', cur: 'USD' },
];

/** Precio en una fecha por interpolación lineal entre los dos puntos semanales que la rodean. */
function priceAt(points, iso) {
  if (!points.length) return null;
  const t = isoToMs(iso);
  if (t <= isoToMs(points[0][0])) return points[0][1];
  const last = points[points.length - 1];
  if (t >= isoToMs(last[0])) return last[1];
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (isoToMs(points[mid][0]) <= t) lo = mid; else hi = mid; }
  const [d0, p0] = points[lo], [d1, p1] = points[hi];
  const t0 = isoToMs(d0), t1 = isoToMs(d1);
  return t1 === t0 ? p0 : p0 + (p1 - p0) * (t - t0) / (t1 - t0);
}

/** Serie del índice en euros: [[fecha, precio en EUR]]. `fx` son dólares (u otra divisa) por euro. */
function eurPoints(series, fx) {
  if (!series || !series.points || !series.points.length) return [];
  if (series.cur === 'EUR') return series.points;
  if (!fx || !fx.length) return [];
  return series.points.map(([d, p]) => [d, p / priceAt(fx, d)]);
}

/** Último punto con fecha <= iso, o null. */
function atOrBefore(points, iso) {
  if (!points || !points.length || points[0][0] > iso) return null;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (points[mid][0] <= iso) lo = mid; else hi = mid - 1; }
  return points[lo];
}

/**
 * Añade a la serie semanal en euros (ajustada por dividendos) los cierres diarios,
 * para poder ver de cerca un día o una semana. Los diarios no traen los dividendos,
 * así que no se usan tal cual: dentro de cada semana se sigue su forma, pero la
 * línea pasa siempre por los cierres semanales ajustados. Después del último cierre
 * semanal, se mueve lo mismo que el diario.
 *  weekly: [[fecha, EUR]]; daily: [[fecha, precio]]; cur: divisa; fxDaily / fxWeekly: divisa por 1 EUR.
 */
function withDaily(weekly, daily, cur, fxDaily, fxWeekly) {
  if (!weekly.length || !daily || !daily.length) return weekly;
  const fxAt = (d) => {
    if (cur === 'EUR') return 1;
    const f = atOrBefore(fxDaily, d);
    if (f) return f[1];
    return fxWeekly && fxWeekly.length ? priceAt(fxWeekly, d) : null;
  };
  const dEur = (d) => { const p = atOrBefore(daily, d); const f = p && fxAt(p[0]); return p && f ? p[1] / f : null; };
  const firstDaily = daily[0][0];
  const lastW = weekly[weekly.length - 1];
  const extra = [];
  daily.forEach(([d]) => {
    if (d <= weekly[0][0]) return;
    const here = dEur(d);
    if (!here) return;
    if (d > lastW[0]) {
      const ref = dEur(lastW[0]);
      if (ref && lastW[0] >= firstDaily) extra.push([d, lastW[1] * here / ref]);
      return;
    }
    // Semana que contiene el día: [w0, w1].
    let hi = weekly.findIndex(([w]) => w >= d);
    if (weekly[hi][0] === d) return; // cierre semanal: manda el ajustado
    const [w0d, w0v] = weekly[hi - 1], [w1d, w1v] = weekly[hi];
    const a = w0d >= firstDaily ? dEur(w0d) : null, b = dEur(w1d);
    if (!b) return;
    if (!a) { extra.push([d, w1v * here / b]); return; } // primera semana con diarios: se ancla al cierre del viernes
    const f = (isoToMs(d) - isoToMs(w0d)) / (isoToMs(w1d) - isoToMs(w0d));
    const wInterp = w0v + (w1v - w0v) * f, dInterp = a + (b - a) * f;
    extra.push([d, wInterp * here / dInterp]);
  });
  if (!extra.length) return weekly;
  const m = new Map(weekly);
  extra.forEach(([d, v]) => { if (!m.has(d)) m.set(d, v); });
  return Array.from(m.entries()).sort((x, y) => x[0].localeCompare(y[0]));
}

function addDays(iso, n) { return new Date(isoToMs(iso) + n * DAY_MS).toISOString().slice(0, 10); }

/**
 * Calcula la comparación. Devuelve null si todavía no hay datos de índices.
 *  data: la cartera; cache: contenido de data/indices.json; benchmarks: lista de índices.
 */
function compare(data, cache, benchmarks) {
  const flows = contributionFlows(data);
  const list = (benchmarks && benchmarks.length ? benchmarks : DEFAULT_BENCHMARKS);
  if (!flows.length || !cache || !cache.series) return null;
  const usable = list.map((b) => {
    const series = cache.series[b.symbol];
    const fxW = cache.fx && series ? cache.fx[series.cur] : null;
    let pts = eurPoints(series, fxW);
    let dailyFrom = null;
    if (pts.length && cache.daily && cache.daily[b.symbol]) {
      const n = pts.length;
      pts = withDaily(pts, cache.daily[b.symbol], series.cur, (cache.fxDaily || {})[series.cur], fxW);
      if (pts.length > n) dailyFrom = cache.daily[b.symbol][0][0];
    }
    return pts.length ? Object.assign({}, b, { pts, dailyFrom }) : null;
  }).filter(Boolean);
  if (!usable.length) return null;

  const start = flows[0].date;
  const asOf = usable.reduce((m, b) => (b.pts[b.pts.length - 1][0] < m ? b.pts[b.pts.length - 1][0] : m), '9999-12-31');
  if (usable.some((b) => b.pts[0][0] > addDays(start, 7))) {
    // El índice empieza después de la primera aportación: no se puede comparar desde el principio.
    return { error: 'Los datos del índice no llegan hasta la primera aportación. Vuelve a actualizarlos.' };
  }

  // Línea de tiempo: la primera aportación y luego cada cierre (semanal, y diario donde lo hay)
  // hasta la última fecha común.
  const dset = new Set();
  usable.forEach((b) => b.pts.forEach(([d]) => { if (d > start && d <= asOf) dset.add(d); }));
  const dates = [start].concat(Array.from(dset).sort());

  const pMetrics = computePortfolioMetrics(data);
  const ytdStart = pMetrics.ttwror_ytd_start_iso || `${asOf.slice(0, 4)}-01-01`;

  const contribAt = (d) => round2(flows.filter((f) => f.date <= d).reduce((a, f) => a + f.amount, 0));
  const series = usable.map((b) => {
    let units = 0, i = 0;
    const values = dates.map((d) => {
      while (i < flows.length && flows[i].date <= d) { units += flows[i].amount / priceAt(b.pts, flows[i].date); i++; }
      return round2(units * priceAt(b.pts, d));
    });
    const final = values[values.length - 1];
    const contributed = contribAt(asOf);
    const cfs = flows.filter((f) => f.date <= asOf).map((f) => [isoToMs(f.date), -f.amount]).concat([[isoToMs(asOf), final]]);
    const xr = isoToMs(asOf) - isoToMs(start) > 30 * DAY_MS ? xirr(cfs) : null;
    let ttwrorYtdPct = null, ttwrorYtdAnnPct = null;
    if (ytdStart && asOf > ytdStart && b.pts[0][0] <= addDays(ytdStart, 7)) {
      const pStart = priceAt(b.pts, ytdStart);
      const pEnd = priceAt(b.pts, asOf);
      if (pStart > 0 && pEnd > 0) {
        const rYtd = pEnd / pStart - 1;
        ttwrorYtdPct = round2(rYtd * 100);
        const ytdDays = Math.round((isoToMs(asOf) - isoToMs(ytdStart)) / DAY_MS);
        ttwrorYtdAnnPct = annualizeReturnPct(rYtd, ytdDays);
      }
    }
    return {
      id: b.id, name: b.name, symbol: b.symbol, cur: b.cur,
      values, final, gain: round2(final - contributed), gainPct: contributed > 0 ? round2((final / contributed - 1) * 100) : null,
      xirr: xr == null ? null : round2(xr * 100),
      ttwror_ytd_pct: ttwrorYtdPct,
      ttwror_ytd_ann_pct: ttwrorYtdAnnPct,
    };
  });

  // La cartera real: su valor de hoy, sus métricas reales (TTWROR + TIR consolidada) y las fotos guardadas.
  const c = data.combined;
  const valuation = portfolioValuationDate(data) || flows[flows.length - 1].date;
  const pValue = c.portfolio_value_total;
  const history = (data.history || []).filter((h) => h.date >= start && h.date < valuation).concat([{ date: valuation, value: pValue, contributions: c.total_contributions }]);

  // Desde cuándo hay cierres diarios de todos los índices (para ver de cerca un día o una semana).
  const dailyFrom = usable.every((b) => b.dailyFrom) ? usable.map((b) => b.dailyFrom).sort().pop() : null;
  return {
    start, asOf, ytdStart, fetched: cache.fetched || null, dates, dailyFrom,
    contributions: dates.map(contribAt),
    series,
    portfolio: {
      date: valuation, value: pValue, contributed: c.total_contributions,
      gain: round2(pValue - c.total_contributions),
      gainPct: c.total_contributions > 0 ? round2((pValue / c.total_contributions - 1) * 100) : null,
      xirr: pMetrics.xirr_pct,
      ttwror_ytd_pct: pMetrics.ttwror_ytd_pct,
      ttwror_ytd_ann_pct: pMetrics.ttwror_ytd_ann_pct,
      ttwror_ytd_start_iso: pMetrics.ttwror_ytd_start_iso,
      ttwror_ytd_partial: pMetrics.ttwror_ytd_partial,
      ttwror_total_pct: pMetrics.ttwror_total_pct,
      ttwror_total_ann_pct: pMetrics.ttwror_total_ann_pct,
      history,
    },
  };
}

/** Guarda una foto del valor de la cartera con fecha (una por día: la última del día manda). */
function recordSnapshot(data, iso) {
  if (!Array.isArray(data.history)) data.history = [];
  const point = { date: iso, value: data.combined.portfolio_value_total, contributions: data.combined.total_contributions };
  const i = data.history.findIndex((h) => h.date === iso);
  if (i >= 0) data.history[i] = point; else data.history.push(point);
  data.history.sort((a, b) => a.date.localeCompare(b.date));
}


module.exports = { DEFAULT_BENCHMARKS, contributionFlows, priceAt, eurPoints, withDaily, compare, recordSnapshot };
