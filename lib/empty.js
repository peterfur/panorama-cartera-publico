'use strict';
/*
 * Cartera vacía: el punto de partida de una instalación nueva, antes de importar
 * ningún extracto. Tiene todos los campos que usa la aplicación, a cero.
 */

function emptyPortfolio() {
  return {
    schema_version: 1,
    ibkr: {
      account: '', broker: 'Interactive Brokers', period_start: '', period_end: '',
      nav_initial: 0, nav_final: 0, cash_final: 0, accrued_div: 0,
      contributions: 0, contribution_events: [],
      div_gross: 0, div_tax: 0, div_net: 0, fees: 0,
      stocks_cost: 0, stocks_value: 0, stocks_pl: 0,
      positions: [], statements: [],
    },
    dividends: [],
    degiro_open_positions: [],
    degiro_realized: [],
    monthly: [],
    combined: {
      total_contributions: 0, ibkr_contributions: 0, degiro_contributions: 0,
      degiro_deposits_gross: 0, degiro_withdrawals: 0, degiro_promo: 0,
      total_div_net: 0, ibkr_div_net: 0, degiro_div_gross: 0, degiro_div_tax: 0, degiro_div_net: 0,
      total_fees: 0, ibkr_fees: 0, degiro_fees: 0,
      degiro_fees_breakdown: { trade: 0, market_conn: 0, adr: 0, trustly: 0, fr_tax: 0 },
      degiro_interest: 0, degiro_sec_lending: 0,
      open_positions_count: 0, ibkr_positions_count: 0, degiro_positions_count: 0,
      combined_cost_basis: 0, degiro_open_cost_total: 0,
      degiro_realized_total: 0, degiro_realized_gains: 0, degiro_realized_losses: 0,
      degiro_realized_count: 0, degiro_realized_gains_count: 0, degiro_realized_losses_count: 0,
      degiro_cash_wallet: 0, degiro_date_min: '', degiro_date_max: '', degiro_movements_count: 0,
      degiro_value_total: 0, degiro_unrealized_pl: 0, degiro_unrealized_pct: 0,
      degiro_xirr_pct: null, degiro_total_return: 0, degiro_total_return_pct: 0,
      degiro_implied_cash: 0, degiro_non_trade_fees: 0,
      portfolio_value_total: 0, portfolio_total_return: 0, portfolio_total_return_pct: 0,
    },
    live_meta: { fetched_date: '', fetched_date_long: '', manual: true, fx: { EUR: 1 }, sources: [], valuation_iso: '' },
    behavior: { quarterly: [], episodes: [] },
    degiro_cashflow_events: [],
    extra_brokers: {},
    journal: [],
    history: [],
  };
}

/** Qué cuentas tienen datos. */
function brokersIn(data) {
  const c = data.combined || {}, ib = data.ibkr || {};
  const extraObj = (data && data.extra_brokers) || {};
  const extra = Object.keys(extraObj).filter((k) => {
    const b = extraObj[k];
    return b && (b.movements_count > 0 || (b.positions || []).length > 0 || (b.cashflow_events || []).length > 0);
  });
  return {
    degiro: !!(c.degiro_date_min || (data.degiro_open_positions || []).length || (data.degiro_cashflow_events || []).length),
    ibkr: !!(ib.period_end || (ib.positions || []).length || (ib.contribution_events || []).length || ib.nav_final),
    extra,
  };
}

module.exports = { emptyPortfolio, brokersIn };
