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

/** TIR de una cuenta adicional (Trading 212, Trade Republic, MyInvestor…): mismo método que DEGIRO. */
function brokerXirrPct(broker, data) {
  const events = broker && broker.cashflow_events;
  if (!Array.isArray(events) || !events.length) return null;
  const cfs = events.map(([iso, amt]) => [isoToMs(iso), amt]).sort((a, b) => a[0] - b[0]);
  const net = -sum(cfs, ([, a]) => a);
  const wealth = net + (broker.total_return || 0);
  const lastEvent = cfs[cfs.length - 1][0];
  const valIso = (data && data.live_meta && data.live_meta.valuation_iso) || broker.date_max || '';
  const valuation = valIso ? isoToMs(valIso) : lastEvent;
  const terminal = Math.max(valuation, lastEvent);
  if (terminal - cfs[0][0] < DAY_MS) return null;
  const all = cfs.concat([[terminal, wealth]]).sort((a, b) => a[0] - b[0]);
  const r = xirr(all);
  return r == null ? null : round2(r * 100);
}

/* ---------- flujos consolidados, TIR consolidada y TTWROR ---------- */

/** Aportaciones netas de todas las cuentas, con fecha: importe positivo = dinero que entra. */
function contributionFlows(data) {
  const flows = [];
  ((data && data.degiro_cashflow_events) || []).forEach(([d, amt]) => { if (amt) flows.push({ date: d, amount: round2(-amt), account: 'DEGIRO' }); });
  ((data && data.ibkr && data.ibkr.contribution_events) || []).forEach(([d, amt]) => { if (amt) flows.push({ date: d, amount: round2(amt), account: 'IBKR' }); });
  Object.values((data && data.extra_brokers) || {}).forEach((b) => {
    (b.cashflow_events || []).forEach(([d, amt]) => { if (amt) flows.push({ date: d, amount: round2(-amt), account: b.id }); });
  });
  return flows.sort((a, b) => a.date.localeCompare(b.date));
}

/** Fecha de valoración de referencia de la cartera consolidada. */
function portfolioValuationDate(data) {
  const c = (data && data.combined) || {};
  const ib = (data && data.ibkr) || {};
  const extraList = Object.values((data && data.extra_brokers) || {});
  const valIso = (data && data.live_meta && data.live_meta.valuation_iso) || '';
  const ibDate = ib.period_end || '';
  const extraMaxDate = extraList.map((b) => b.date_max).filter(Boolean).sort().pop() || '';
  const flows = contributionFlows(data);
  const lastFlow = flows.length ? flows[flows.length - 1].date : '';
  return valIso || [c.degiro_date_max, ibDate, extraMaxDate].filter(Boolean).sort().pop() || lastFlow || '';
}

/**
 * TIR (XIRR) consolidada de toda la cartera.
 * Cada cuenta cierra en su propia fecha de valoración (DEGIRO y cuentas adicionales en
 * live_meta.valuation_iso o su último movimiento; IBKR en ibkr.period_end), así no actualizar
 * una cuenta no penaliza con 0 % de rendimiento el tramo entre fechas.
 */
function portfolioXirrPct(data) {
  const flows = contributionFlows(data);
  if (!flows.length) return null;
  const c = (data && data.combined) || {};
  const ib = (data && data.ibkr) || {};
  const extraList = Object.values((data && data.extra_brokers) || {});
  const valIso = (data && data.live_meta && data.live_meta.valuation_iso) || '';
  const degDate = valIso || c.degiro_date_max || '';
  const ibDate = ib.period_end || '';
  const valuation = portfolioValuationDate(data);
  const pValue = c.portfolio_value_total;
  if (typeof pValue !== 'number' || !isFinite(pValue)) return null;

  const terminals = [];
  const degFlows = flows.filter((f) => f.account === 'DEGIRO');
  const ibFlows = flows.filter((f) => f.account === 'IBKR');
  const extraNavTotal = round2(extraList.reduce((a, b) => a + (b.nav_total || 0), 0));
  const degNav = round2(pValue - (ib.nav_final || 0) - extraNavTotal);
  if (degFlows.length) {
    const tDeg = Math.max(isoToMs(degDate || degFlows[degFlows.length - 1].date), isoToMs(degFlows[degFlows.length - 1].date));
    terminals.push([tDeg, degNav]);
  }
  if (ibFlows.length) {
    const tIb = Math.max(isoToMs(ibDate || ibFlows[ibFlows.length - 1].date), isoToMs(ibFlows[ibFlows.length - 1].date));
    terminals.push([tIb, round2(ib.nav_final || 0)]);
  }
  extraList.forEach((b) => {
    const bFlows = flows.filter((f) => f.account === b.id);
    if (!bFlows.length) return;
    const bDate = valIso || b.date_max || bFlows[bFlows.length - 1].date;
    const tB = Math.max(isoToMs(bDate), isoToMs(bFlows[bFlows.length - 1].date));
    terminals.push([tB, round2(b.nav_total || 0)]);
  });
  if (!terminals.length) {
    const tEnd = Math.max(isoToMs(valuation), isoToMs(flows[flows.length - 1].date));
    terminals.push([tEnd, pValue]);
  }
  const pCfs = flows.map((f) => [isoToMs(f.date), -f.amount]).concat(terminals).sort((a, b) => a[0] - b[0]);
  if (pCfs[pCfs.length - 1][0] - pCfs[0][0] < DAY_MS) return null;
  const r = xirr(pCfs);
  return r == null ? null : round2(r * 100);
}

/** Anualiza un rendimiento acumulado (en tanto por uno) sobre `days` días. Devuelve % o null si < 30 días. */
function annualizeReturnPct(cumReturn, days) {
  if (cumReturn == null || !isFinite(cumReturn) || !(days >= 30)) return null;
  if (1 + cumReturn <= 0) return -100;
  const ann = Math.pow(1 + cumReturn, 365 / days) - 1;
  return isFinite(ann) ? round2(ann * 100) : null;
}

/**
 * Calcula TTWROR (Time-Weighted Rate of Return) por encadenamiento geométrico de subperiodos
 * entre valoraciones (`snapshots`: [{ date, value }]) descontando el efecto de los flujos
 * externos (`flows`: [{ date, amount }], amount > 0 = aportación, < 0 = retirada).
 *
 * Convención: cada snapshot en fecha t_k refleja el valor al cierre de t_k, ya incluyendo
 * los flujos de ese día. Los flujos en (t_{k-1}, t_k] se ponderan por el tiempo restante
 * dentro del subperiodo w_j = (t_k - t_j) / (t_k - t_{k-1}):
 *  - Si hay snapshot el mismo día del flujo (t_j = t_k), w_j = 0 -> TWR exacto.
 *  - Si un flujo cae entre snapshots, Dietz modificado intra-subperiodo.
 *  - Si el mercado está plano (V_k = V_{k-1} + F_k), el numerador es 0 -> TTWROR = 0 % exacto.
 */
function computeTtwror(snapshots, flows) {
  const cleanSnaps = (snapshots || [])
    .filter((s) => s && isIsoDate(s.date) && typeof s.value === 'number' && isFinite(s.value))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  // Deduplicar por fecha (la última valoración del día manda)
  const dedup = [];
  cleanSnaps.forEach((s) => {
    if (dedup.length && dedup[dedup.length - 1].date === s.date) dedup[dedup.length - 1] = s;
    else dedup.push(s);
  });
  const firstPosIdx = dedup.findIndex((s) => s.value > 0);
  if (firstPosIdx < 0 || dedup.length - firstPosIdx < 2) {
    return { pct: null, ann_pct: null, start_iso: null, end_iso: null, days: 0, subperiods: 0 };
  }

  const pts = dedup.slice(firstPosIdx);
  const cleanFlows = (flows || [])
    .filter((f) => f && isIsoDate(f.date) && typeof f.amount === 'number' && isFinite(f.amount) && f.amount !== 0)
    .map((f) => ({ t: isoToMs(f.date), date: f.date, amount: f.amount }))
    .sort((a, b) => a.t - b.t);

  let factor = 1;
  let validSubperiods = 0;
  let startIso = null;
  let endIso = null;
  let prev = pts[0];

  for (let k = 1; k < pts.length; k++) {
    const cur = pts[k];
    if (prev.value <= 0) {
      if (cur.value > 0) prev = cur;
      continue;
    }
    const t0 = isoToMs(prev.date);
    const t1 = isoToMs(cur.date);
    const span = t1 - t0;
    if (span <= 0) { prev = cur; continue; }

    let netFlow = 0;
    let weightedFlow = 0;
    for (let j = 0; j < cleanFlows.length; j++) {
      const f = cleanFlows[j];
      if (f.t <= t0) continue;
      if (f.t > t1) break;
      netFlow += f.amount;
      const w = (t1 - f.t) / span;
      weightedFlow += f.amount * w;
    }

    const base = prev.value + weightedFlow;
    if (base <= 0) {
      if (cur.value > 0) prev = cur;
      continue;
    }

    const r = (cur.value - prev.value - netFlow) / base;
    if (!isFinite(r)) { prev = cur; continue; }
    factor *= Math.max(0, 1 + r);
    if (!startIso) startIso = prev.date;
    endIso = cur.date;
    validSubperiods++;
    prev = cur;
  }

  if (!validSubperiods || !startIso || !endIso) {
    return { pct: null, ann_pct: null, start_iso: null, end_iso: null, days: 0, subperiods: 0 };
  }

  const cumReturn = factor - 1;
  const days = Math.round((isoToMs(endIso) - isoToMs(startIso)) / DAY_MS);
  return {
    pct: round2(cumReturn * 100),
    ann_pct: annualizeReturnPct(cumReturn, days),
    start_iso: startIso,
    end_iso: endIso,
    days,
    subperiods: validSubperiods,
  };
}

/**
 * Construye la serie consolidada de valoraciones (`data.history` + punto actual) y calcula
 * TTWROR YTD, TTWROR total (acumuladas y anualizadas) y TIR (XIRR) consolidada.
 */
function computePortfolioMetrics(data) {
  const c = (data && data.combined) || {};
  const flows = contributionFlows(data);
  const valuation = portfolioValuationDate(data);
  const pValue = c.portfolio_value_total;

  // Combinar data.history con el punto de cierre actual.
  const snaps = (data && Array.isArray(data.history) ? data.history : [])
    .filter((h) => h && isIsoDate(h.date) && (!valuation || h.date < valuation) && typeof h.value === 'number' && isFinite(h.value))
    .map((h) => ({ date: h.date, value: h.value }));
  if (valuation && isIsoDate(valuation) && typeof pValue === 'number' && isFinite(pValue)) {
    snaps.push({ date: valuation, value: pValue });
  }
  snaps.sort((a, b) => a.date.localeCompare(b.date));

  const totalRes = computeTtwror(snaps, flows);

  // YTD: desde el 1 de enero del año de la última valoración (o el cierre de fin de año anterior
  // en los 7 días previos al 1 de enero, ej. 31 dic) hasta hoy.
  let ytdRes = { pct: null, ann_pct: null, start_iso: null, end_iso: null, days: 0, subperiods: 0 };
  let ytdPartial = false;
  if (snaps.length >= 2) {
    const lastIso = snaps[snaps.length - 1].date;
    const year = lastIso.slice(0, 4);
    const jan1 = `${year}-01-01`;
    const jan1Ms = isoToMs(jan1);
    const prevCutoffMs = jan1Ms - 7 * DAY_MS;

    let baseSnap = null;
    for (let i = snaps.length - 1; i >= 0; i--) {
      const s = snaps[i];
      if (s.value <= 0) continue;
      const t = isoToMs(s.date);
      if (t <= jan1Ms && t >= prevCutoffMs) {
        baseSnap = s;
        break;
      }
    }

    let ytdSnaps;
    if (baseSnap) {
      ytdSnaps = snaps.filter((s) => s.date >= baseSnap.date);
      ytdPartial = false;
    } else {
      ytdSnaps = snaps.filter((s) => s.date >= jan1);
      const firstPos = ytdSnaps.find((s) => s.value > 0);
      ytdPartial = !!(firstPos && firstPos.date > jan1);
    }

    ytdRes = computeTtwror(ytdSnaps, flows);
    if (ytdRes.pct == null) ytdPartial = false;
  }

  return {
    as_of_iso: valuation || null,
    snapshots_count: snaps.length,
    ttwror_ytd_pct: ytdRes.pct,
    ttwror_ytd_ann_pct: ytdRes.ann_pct,
    ttwror_ytd_start_iso: ytdRes.start_iso,
    ttwror_ytd_days: ytdRes.days,
    ttwror_ytd_partial: ytdPartial,
    ttwror_total_pct: totalRes.pct,
    ttwror_total_ann_pct: totalRes.ann_pct,
    ttwror_total_start_iso: totalRes.start_iso,
    ttwror_total_days: totalRes.days,
    xirr_pct: portfolioXirrPct(data),
  };
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

  const returnPct = (ret, contrib) => (contrib > 0 ? round2(ret / contrib * 100) : (contrib === 0 && ret === 0 ? 0 : null));

  // 1b. Brókers adicionales (Trading 212, Trade Republic, MyInvestor, genéricos…): misma valoración que DEGIRO.
  const extraList = Object.values(data.extra_brokers || {});
  extraList.forEach((b) => {
    const bPos = b.positions || [];
    bPos.forEach((p) => {
      const cur = positionCurrency(p);
      const price = p.live_price != null ? p.live_price : p.last_price;
      const rate = cur === 'EUR' ? 1 : fx[cur];
      if (!(rate > 0)) throw new UserError(`Falta el tipo de cambio EUR/${cur} para valorar ${p.name} (${b.name}).`, 'fx');
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
    b.positions_count = bPos.length;
    b.cost_total = round2(sum(bPos, (p) => p.cost_total));
    b.value_total = round2(sum(bPos, (p) => p.live_value_eur));
    b.unrealized_pl = round2(b.value_total - b.cost_total);
    b.unrealized_pct = b.cost_total ? round2(b.unrealized_pl / b.cost_total * 100) : 0;
    const brz = b.realized || [];
    brz.sort((a, x) => a.pl - x.pl);
    b.realized_total = round2(sum(brz, (r) => r.pl));
    b.realized_gains = round2(sum(brz, (r) => (r.pl > 0 ? r.pl : 0)));
    b.realized_losses = round2(sum(brz, (r) => (r.pl < 0 ? r.pl : 0)));
    b.div_net = round2((b.div_gross || 0) + (b.div_tax || 0));
    b.contributions = round2((b.deposits_gross || 0) + (b.withdrawals || 0));
    b.total_return = round2(b.realized_total + b.unrealized_pl + b.div_net + (b.interest || 0) + (b.non_trade_fees || 0));
    b.total_return_pct = returnPct(b.total_return, b.contributions);
    b.implied_cash = round2(b.contributions + b.realized_total + b.div_net + (b.interest || 0) + (b.non_trade_fees || 0) - b.cost_total);
    b.nav_total = round2(b.contributions + b.total_return);
    const bx = brokerXirrPct(b, data);
    b.xirr_pct = bx != null ? bx : null;
  });

  const extraPositionsCount = sum(extraList, (b) => b.positions_count);
  const extraCostTotal = round2(sum(extraList, (b) => b.cost_total));
  const extraDivNet = round2(sum(extraList, (b) => b.div_net));
  const extraContributions = round2(sum(extraList, (b) => b.contributions));
  const extraTotalReturn = round2(sum(extraList, (b) => b.total_return));
  const extraFees = round2(sum(extraList, (b) => b.fees || 0));

  // 2. Recuentos.
  combined.degiro_positions_count = positions.length;
  combined.ibkr_positions_count = ibkr.positions.length;
  combined.open_positions_count = positions.length + ibkr.positions.length + extraPositionsCount;

  // 3. Coste y valor.
  combined.degiro_open_cost_total = round2(sum(positions, (p) => p.cost_total));
  combined.combined_cost_basis = round2(ibkr.stocks_cost + combined.degiro_open_cost_total + extraCostTotal);
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
  if (extraList.length) combined.total_fees = round2((ibkr.fees || 0) + combined.degiro_fees + extraFees);

  // 6. Dividendos (los agregados se llevan por incrementos; aquí solo las sumas entre agregados).
  data.dividends.sort((a, b) => b.gross_eur - a.gross_eur); // el gráfico toma los 12 primeros tal cual
  combined.degiro_div_net = round2(combined.degiro_div_gross + combined.degiro_div_tax);
  combined.ibkr_div_net = ibkr.div_net;
  combined.total_div_net = round2(combined.ibkr_div_net + combined.degiro_div_net + extraDivNet);

  // 7. Aportaciones.
  combined.degiro_contributions = round2(combined.degiro_deposits_gross + combined.degiro_withdrawals + combined.degiro_promo);
  combined.ibkr_contributions = ibkr.contributions;
  combined.total_contributions = round2(combined.ibkr_contributions + combined.degiro_contributions + extraContributions);
  let cumI = 0, cumD = 0, cumE = 0;
  const cumByExtra = {};
  data.monthly.sort((a, b) => a.month.localeCompare(b.month));
  data.monthly.forEach((m) => {
    cumI = round2(cumI + m.ibkr); cumD = round2(cumD + m.degiro);
    m.cum_ibkr = cumI; m.cum_deg = cumD;
    if (extraList.length) {
      const mExtra = m.extra || {};
      let monthExtraSum = 0;
      const snap = {};
      extraList.forEach((b) => {
        const v = Number(mExtra[b.id] || 0);
        monthExtraSum += v;
        cumByExtra[b.id] = round2((cumByExtra[b.id] || 0) + v);
        snap[b.id] = cumByExtra[b.id];
      });
      cumE = round2(cumE + monthExtraSum);
      m.cum_extra = cumE;
      m.cum_extra_by_broker = snap;
      m.cum_total = round2(cumI + cumD + cumE);
    } else {
      m.cum_total = round2(cumI + cumD);
    }
  });

  // 8. Rendimiento.
  combined.degiro_total_return = round2(
    combined.degiro_realized_total + combined.degiro_unrealized_pl + combined.degiro_div_net +
    combined.degiro_interest + combined.degiro_non_trade_fees + (combined.degiro_sec_lending || 0));
  combined.degiro_total_return_pct = returnPct(combined.degiro_total_return, combined.degiro_contributions);
  combined.portfolio_total_return = round2((ibkr.nav_final - ibkr.contributions) + combined.degiro_total_return + extraTotalReturn);
  combined.portfolio_total_return_pct = returnPct(combined.portfolio_total_return, combined.total_contributions);
  combined.portfolio_value_total = round2(combined.total_contributions + combined.portfolio_total_return);
  combined.degiro_implied_cash = round2(
    combined.degiro_contributions + combined.degiro_realized_total + combined.degiro_div_net +
    combined.degiro_interest + combined.degiro_non_trade_fees + (combined.degiro_sec_lending || 0) -
    combined.degiro_open_cost_total);

  // 9. TIR y métricas consolidadas (TTWROR YTD/total y TIR consolidada).
  const x = degiroXirrPct(data);
  if (x != null) combined.degiro_xirr_pct = x;
  ibkr.result = round2(ibkr.nav_final - ibkr.contributions);
  const xi = ibkrXirrPct(ibkr);
  if (xi != null) ibkr.xirr_pct = xi;
  combined.metrics = computePortfolioMetrics(data);

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
  xnpv, xirr, degiroXirrPct, ibkrXirrPct, brokerXirrPct,
  contributionFlows, portfolioValuationDate, portfolioXirrPct,
  annualizeReturnPct, computeTtwror, computePortfolioMetrics,
  FEE_CATEGORIES, nonTradeFees, positionCurrency, recomputeDerived,
};
