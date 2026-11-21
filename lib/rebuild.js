'use strict';
/*
 * Reconstrucción de los datos del panel a partir de los libros de extractos.
 *
 *   libro de DEGIRO (CSV)  ─┐
 *   libro de IBKR (JSON)   ─┼─>  rebuild()  ─>  data/portfolio.json
 *   movimientos a mano     ─┘
 *
 * Los precios de mercado guardados no salen de ningún extracto: se conservan.
 */

const { round2, recomputeDerived } = require('./calc');
const degiro = require('./degiro');
const ibkr = require('./ibkr');

function rebuild(current, ledgers, applyMovement) {
  const data = JSON.parse(JSON.stringify(current));
  const warnings = [];
  data.sources = data.sources || {};
  const rows = ledgers.degiroRows || [];
  const ib = ledgers.ibkrLedger;

  if (rows.length) {
    const d = degiro.deriveDegiro(rows, data);
    warnings.push(...d.warnings);
    data.degiro_open_positions = d.positions;
    data.degiro_realized = d.realized;
    data.dividends = data.dividends.filter((x) => x.account !== 'DEGIRO').concat(d.dividends);
    data.degiro_cashflow_events = d.cashflows;
    data.behavior = d.behavior;
    Object.assign(data.combined, d.combined);
    // Divisas nuevas en cartera: tipo de cambio de partida, el último que aparece en el extracto.
    d.positions.forEach((p) => {
      const cur = p.live_price_cur;
      if (cur !== 'EUR' && !(data.live_meta.fx[cur] > 0) && d.lastRates[cur]) data.live_meta.fx[cur] = d.lastRates[cur];
    });
    data.sources.degiro = {
      rows: rows.length, date_min: d.combined.degiro_date_min, date_max: d.combined.degiro_date_max,
      balance_gaps: degiro.balanceGaps(rows), opening_balance: degiro.openingBalance(rows), unknown_rows: d.unknownCount,
    };
    setMonthly(data, 'degiro', d.monthly.map((m) => [m.month, m.degiro]));
  }

  if (ib && ib.statements && ib.statements.length) {
    const r = ibkr.deriveIbkr(ib);
    warnings.push(...r.warnings);
    data.ibkr = r.ibkr;
    data.dividends = data.dividends.filter((x) => x.account !== 'IBKR').concat(r.dividendRows);
    data.sources.ibkr = {
      statements: r.ibkr.statements.length, date_min: r.ibkr.period_start, date_max: r.ibkr.period_end,
      coverage_gaps: r.ibkr.coverage_gaps, nav_initial: r.ibkr.nav_initial,
    };
    const byMonth = new Map();
    r.ibkr.contribution_events.forEach(([d, v]) => byMonth.set(d.slice(0, 7), (byMonth.get(d.slice(0, 7)) || 0) + v));
    setMonthly(data, 'ibkr', Array.from(byMonth.entries()));
  }

  recomputeDerived(data);

  // Movimientos registrados a mano que ningún extracto importado cubre todavía: se vuelven a aplicar encima.
  const reapplied = [];
  if (rows.length && applyMovement) {
    (data.journal || []).forEach((j) => {
      if (j.kind !== 'movimiento' || j.superseded || !j.payload) return;
      try { applyMovement(data, j.payload); reapplied.push(j.id); }
      catch (e) {
        j.superseded = true; j.superseded_note = 'No se pudo volver a aplicar: ' + e.message;
        warnings.push(`El movimiento a mano «${j.summary}» no se ha podido volver a aplicar sobre los datos del extracto (${e.message}) y se ha descartado.`);
      }
    });
  }
  data.combined.ibkr_fees = data.ibkr.fees;
  data.combined.total_fees = round2(data.ibkr.fees + data.combined.degiro_fees);
  return { data, warnings, reapplied };
}

/** Sustituye en el gráfico mensual las aportaciones de una de las dos cuentas. */
function setMonthly(data, side, entries) {
  const map = new Map(data.monthly.map((m) => [m.month, { month: m.month, ibkr: m.ibkr, degiro: m.degiro }]));
  map.forEach((m) => { m[side] = 0; });
  entries.forEach(([month, v]) => {
    if (!map.has(month)) map.set(month, { month, ibkr: 0, degiro: 0 });
    map.get(month)[side] = round2(v);
  });
  data.monthly = Array.from(map.values()).filter((m) => m.ibkr !== 0 || m.degiro !== 0)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => Object.assign(m, { cum_ibkr: 0, cum_deg: 0, cum_total: 0 }));
}

module.exports = { rebuild };
