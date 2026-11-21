'use strict';
/*
 * Cálculo de la cartera.
 *
 * Todo lo que en el panel es "derivado" (valor de cada posición, plusvalías,
 * totales, rentabilidad, TIR) sale de aquí. La regla es: los movimientos y
 * las actualizaciones de precio tocan los datos "primarios" y después se
 * llama SIEMPRE a recomputeDerived(), que vuelve a calcular el resto.
 */

class UserError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'UserError';
    this.field = field || null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }
function sum(list, fn) { return list.reduce((acc, x) => acc + fn(x), 0); }

/* ---------- fechas (siempre a medianoche UTC para que no bailen con la zona horaria) ---------- */

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function isoToMs(iso) { return new Date(iso.slice(0, 10) + 'T00:00:00Z').getTime(); }
function todayIso(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function dateLabels(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { short: `${d} ${MONTHS_SHORT[m - 1]} ${y}`, long: `${d} de ${MONTHS_LONG[m - 1]} de ${y}` };
}
/** YYYY-MM-DD -> DD-MM-YYYY (formato que usa "last_price_date" en los datos). */
function isoToDmy(iso) { const [y, m, d] = iso.split('-'); return `${d}-${m}-${y}`; }
function quarterOf(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

/* ---------- TIR / XIRR por bisección ---------- */

function xnpv(rate, cfs, t0) {
  return cfs.reduce((s, [t, cf]) => s + cf / Math.pow(1 + rate, (t - t0) / (DAY_MS * 365.0)), 0);
}
function xirr(cfs) {
  const t0 = cfs[0][0];
  let lo = -0.99, hi = 10.0;
  let flo = xnpv(lo, cfs, t0);
  const fhi = xnpv(hi, cfs, t0);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = xnpv(mid, cfs, t0);
    if (flo * fmid <= 0) { hi = mid; } else { lo = mid; flo = fmid; }
  }
  return (lo + hi) / 2;
}

/**
 * TIR de DEGIRO: cada aportación/retirada en su fecha y, como flujo final, el
 * patrimonio total a la fecha de valoración (aportaciones netas + rendimiento
 * total). Devuelve el porcentaje con 2 decimales, o null si no hay datos.
 */
function degiroXirrPct(data) {
  const events = data.degiro_cashflow_events;
  if (!Array.isArray(events) || !events.length) return null;
  const cfs = events.map(([iso, amt]) => [isoToMs(iso), amt]).sort((a, b) => a[0] - b[0]);
  const net = -sum(cfs, ([, a]) => a);
  const wealth = net + data.combined.degiro_total_return;
  const lastEvent = cfs[cfs.length - 1][0];
  const valuation = data.live_meta && data.live_meta.valuation_iso ? isoToMs(data.live_meta.valuation_iso) : lastEvent;
  const terminal = Math.max(valuation, lastEvent);
  if (terminal - cfs[0][0] < DAY_MS) return null;
  const all = cfs.concat([[terminal, wealth]]).sort((a, b) => a[0] - b[0]);
  const r = xirr(all);
  return r == null ? null : round2(r * 100);
}

/** TIR de IBKR: aportaciones y retiradas en sus fechas y el valor de la cuenta al final del último informe. */
function ibkrXirrPct(ibkr) {
  const events = ibkr.contribution_events;
  if (!Array.isArray(events) || !events.length || !ibkr.period_end) return null;
  const cfs = events.map(([iso, amt]) => [isoToMs(iso), -amt]).sort((a, b) => a[0] - b[0]);
  const terminal = Math.max(isoToMs(ibkr.period_end), cfs[cfs.length - 1][0]);
  if (terminal - cfs[0][0] < DAY_MS) return null;
  const all = cfs.concat([[terminal, ibkr.nav_final]]).sort((a, b) => a[0] - b[0]);
  const r = xirr(all);
  return r == null ? null : round2(r * 100);
}

/* ---------- comisiones ---------- */

const FEE_CATEGORIES = {
  trade: 'Comisiones de compraventa',
  market_conn: 'Conectividad con mercados',
  adr: 'Comisiones ADR/GDR',
  trustly: 'Depósitos instantáneos',
  fr_tax: 'Impuesto sobre transacciones',
  other: 'Otras comisiones',
};
function nonTradeFees(breakdown) {
  return round2(Object.keys(breakdown).filter((k) => k !== 'trade').reduce((a, k) => a + breakdown[k], 0));
}

/* ---------- recálculo de todo lo derivado ---------- */

function positionCurrency(p) { return p.live_price_cur || p.last_price_cur; }

function recomputeDerived(data) {
  const { ibkr, combined } = data;
  const positions = data.degiro_open_positions;
  const fx = data.live_meta.fx;

  // 1. Posiciones abiertas de DEGIRO: precio -> euros -> valor y plusvalía.
  positions.forEach((p) => {
    const cur = positionCurrency(p);
    const price = p.live_price != null ? p.live_price : p.last_price;
    const rate = cur === 'EUR' ? 1 : fx[cur];
    if (!(rate > 0)) throw new UserError(`Falta el tipo de cambio EUR/${cur} para valorar ${p.name}.`, 'fx');
    const priceEur = price / rate;
    const valueEur = round2(p.qty * priceEur);
    p.cost_avg = round4(p.cost_total / p.qty);
    p.live_price = price;
    p.live_price_cur = cur;
    p.live_price_eur = round4(priceEur);
    p.live_value_eur = valueEur;
    p.live_pl_eur = round2(valueEur - p.cost_total);
    p.live_pl_pct = p.cost_total ? round2((valueEur - p.cost_total) / p.cost_total * 100) : 0;
  });
  data.live_meta.sources = positions.map((p) => p.live_src);

  // 2. Recuentos.
  combined.degiro_positions_count = positions.length;
  combined.ibkr_positions_count = ibkr.positions.length;
  combined.open_positions_count = positions.length + ibkr.positions.length;

  // 3. Coste y valor.
  combined.degiro_open_cost_total = round2(sum(positions, (p) => p.cost_total));
  combined.combined_cost_basis = round2(ibkr.stocks_cost + combined.degiro_open_cost_total);
  combined.degiro_value_total = round2(sum(positions, (p) => p.live_value_eur));
  combined.degiro_unrealized_pl = round2(combined.degiro_value_total - combined.degiro_open_cost_total);
  combined.degiro_unrealized_pct = combined.degiro_open_cost_total
    ? round2(combined.degiro_unrealized_pl / combined.degiro_open_cost_total * 100) : 0;

  // 4. Resultado realizado (una fila por valor).
  const realized = data.degiro_realized;
  realized.sort((a, b) => a.pl - b.pl); // la tabla y el gráfico dependen de este orden
  combined.degiro_realized_total = round2(sum(realized, (r) => r.pl));
  combined.degiro_realized_gains = round2(sum(realized, (r) => (r.pl > 0 ? r.pl : 0)));
  combined.degiro_realized_losses = round2(sum(realized, (r) => (r.pl < 0 ? r.pl : 0)));
  combined.degiro_realized_count = realized.length;
  combined.degiro_realized_gains_count = realized.filter((r) => r.pl > 0).length;
  combined.degiro_realized_losses_count = realized.filter((r) => r.pl <= 0).length;

  // 5. Comisiones.
  const bd = combined.degiro_fees_breakdown;
  combined.degiro_fees = round2(Object.keys(bd).reduce((a, k) => a + bd[k], 0));
  combined.degiro_non_trade_fees = nonTradeFees(bd);

  // 6. Dividendos (los agregados se llevan por incrementos; aquí solo las sumas entre agregados).
  data.dividends.sort((a, b) => b.gross_eur - a.gross_eur); // el gráfico toma los 12 primeros tal cual
  combined.degiro_div_net = round2(combined.degiro_div_gross + combined.degiro_div_tax);
  combined.ibkr_div_net = ibkr.div_net;
  combined.total_div_net = round2(combined.ibkr_div_net + combined.degiro_div_net);

  // 7. Aportaciones.
  combined.degiro_contributions = round2(combined.degiro_deposits_gross + combined.degiro_withdrawals + combined.degiro_promo);
  combined.ibkr_contributions = ibkr.contributions;
  combined.total_contributions = round2(combined.ibkr_contributions + combined.degiro_contributions);
  let cumI = 0, cumD = 0;
  data.monthly.sort((a, b) => a.month.localeCompare(b.month));
  data.monthly.forEach((m) => {
    cumI = round2(cumI + m.ibkr); cumD = round2(cumD + m.degiro);
    m.cum_ibkr = cumI; m.cum_deg = cumD; m.cum_total = round2(cumI + cumD);
  });

  // 8. Rendimiento.
  const returnPct = (ret, contrib) => (contrib > 0 ? round2(ret / contrib * 100) : (contrib === 0 && ret === 0 ? 0 : null));
  combined.degiro_total_return = round2(
    combined.degiro_realized_total + combined.degiro_unrealized_pl + combined.degiro_div_net +
    combined.degiro_interest + combined.degiro_non_trade_fees + (combined.degiro_sec_lending || 0));
  combined.degiro_total_return_pct = returnPct(combined.degiro_total_return, combined.degiro_contributions);
  combined.portfolio_total_return = round2((ibkr.nav_final - ibkr.contributions) + combined.degiro_total_return);
  combined.portfolio_total_return_pct = returnPct(combined.portfolio_total_return, combined.total_contributions);
  combined.portfolio_value_total = round2(combined.total_contributions + combined.portfolio_total_return);
  combined.degiro_implied_cash = round2(
    combined.degiro_contributions + combined.degiro_realized_total + combined.degiro_div_net +
    combined.degiro_interest + combined.degiro_non_trade_fees + (combined.degiro_sec_lending || 0) -
    combined.degiro_open_cost_total);

  // 9. TIR.
  const x = degiroXirrPct(data);
  if (x != null) combined.degiro_xirr_pct = x;
  ibkr.result = round2(ibkr.nav_final - ibkr.contributions);
  const xi = ibkrXirrPct(ibkr);
  if (xi != null) ibkr.xirr_pct = xi;

  // 10. Estadísticas de comportamiento.
  (data.behavior.quarterly || []).forEach((q) => {
    q.n_trades = q.n_buys + q.n_sells;
    q.avg_buy_size = q.n_buys ? round2(q.capital / q.n_buys) : 0;
  });
  data.behavior.quarterly.sort((a, b) => a.quarter.localeCompare(b.quarter));

  return data;
}

module.exports = {
  UserError, DAY_MS, round2, round4, sum,
  isIsoDate, isoToMs, todayIso, dateLabels, isoToDmy, quarterOf, MONTHS_SHORT, MONTHS_LONG,
  xnpv, xirr, degiroXirrPct, ibkrXirrPct,
  FEE_CATEGORIES, nonTradeFees, positionCurrency, recomputeDerived,
};
