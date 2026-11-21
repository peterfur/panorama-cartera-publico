'use strict';
/*
 * Comprobaciones de coherencia de data/portfolio.json.
 *
 * Cada comprobación compara una cifra guardada con la misma cifra recalculada
 * por otro camino. No modifican nada: solo dicen si los datos cuadran.
 *
 *   nivel "error" -> los datos están mal y el panel mostraría cifras incorrectas.
 *   nivel "aviso" -> diferencia esperable (redondeos, datos que el extracto no trae).
 */

const { round2, round4, sum, isoToMs, DAY_MS, degiroXirrPct, ibkrXirrPct, brokerXirrPct, nonTradeFees, positionCurrency } = require('./calc');

function runChecks(data) {
  const out = [];
  const c = data.combined, ibkr = data.ibkr, pos = data.degiro_open_positions, fx = data.live_meta.fx;
  const extraList = Object.values(data.extra_brokers || {});
  const extraPosCount = sum(extraList, (b) => (b.positions || []).length);
  const extraCost = round2(sum(extraList, (b) => b.cost_total || 0));
  const extraDivNet = round2(sum(extraList, (b) => b.div_net || 0));
  const extraContrib = round2(sum(extraList, (b) => b.contributions || 0));
  const extraRet = round2(sum(extraList, (b) => b.total_return || 0));

  function eq(group, label, actual, expected, opts) {
    opts = opts || {};
    const tol = opts.tol == null ? 0.011 : opts.tol;
    const a = Number(actual), e = Number(expected);
    const ok = isFinite(a) && isFinite(e) && Math.abs(a - e) <= tol;
    out.push({ group, label, ok, level: opts.level || 'error', actual: round4(a), expected: round4(e), diff: round4(a - e), unit: opts.unit || '€', note: opts.note || '' });
  }
  function truth(group, label, ok, detail, level) {
    out.push({ group, label, ok: !!ok, level: level || 'error', detail: ok ? '' : (detail || ''), note: '' });
  }

  /* ---- Posiciones DEGIRO ---- */
  const G1 = 'Posiciones DEGIRO';
  const badPos = [];
  pos.forEach((p) => {
    const cur = positionCurrency(p);
    const rate = cur === 'EUR' ? 1 : fx[cur];
    const problems = [];
    if (!(p.qty > 0)) problems.push('cantidad');
    if (!(p.cost_total > 0)) problems.push('coste');
    if (!(rate > 0)) problems.push('tipo de cambio ' + cur);
    else {
      if (Math.abs(p.live_price_eur - p.live_price / rate) > 0.0002) problems.push('precio en EUR');
      if (Math.abs(p.live_value_eur - round2(p.qty * p.live_price / rate)) > 0.011) problems.push('valor');
    }
    if (Math.abs(p.live_pl_eur - (p.live_value_eur - p.cost_total)) > 0.011) problems.push('plusvalía');
    if (Math.abs(p.live_pl_pct - (p.live_value_eur - p.cost_total) / p.cost_total * 100) > 0.011) problems.push('rentabilidad %');
    if (Math.abs(p.cost_avg - p.cost_total / p.qty) > 0.0002) problems.push('coste medio');
    if (problems.length) badPos.push(`${p.name}: ${problems.join(', ')}`);
  });
  truth(G1, `Cada posición: valor = cantidad × precio ÷ tipo de cambio (${pos.length} posiciones)`, !badPos.length, badPos.join(' · '));
  const isins = pos.map((p) => p.id || p.isin);
  truth(G1, 'No hay posiciones duplicadas', new Set(isins).size === isins.length, 'Hay posiciones repetidas');
  eq(G1, 'Valor total = suma de posiciones', c.degiro_value_total, sum(pos, (p) => p.live_value_eur));
  eq(G1, 'Coste total = suma de posiciones', c.degiro_open_cost_total, sum(pos, (p) => p.cost_total));
  eq(G1, 'Plusvalía no realizada = valor − coste', c.degiro_unrealized_pl, c.degiro_value_total - c.degiro_open_cost_total);
  eq(G1, extraList.length ? 'Coste combinado = todas las cuentas' : 'Coste combinado = IBKR + DEGIRO', c.combined_cost_basis, ibkr.stocks_cost + c.degiro_open_cost_total + extraCost);
  truth(G1, 'Recuento de posiciones', c.degiro_positions_count === pos.length && c.ibkr_positions_count === ibkr.positions.length && c.open_positions_count === pos.length + ibkr.positions.length + extraPosCount, 'El número de posiciones guardado no coincide con las tablas');

  /* ---- Resultado realizado ---- */
  const G2 = 'Resultado realizado';
  const rz = data.degiro_realized;
  eq(G2, 'Total realizado = suma de cierres', c.degiro_realized_total, sum(rz, (r) => r.pl));
  eq(G2, 'Ganancias + pérdidas = total', c.degiro_realized_gains + c.degiro_realized_losses, c.degiro_realized_total);
  truth(G2, 'Recuento de cierres', c.degiro_realized_count === rz.length && c.degiro_realized_gains_count + c.degiro_realized_losses_count === rz.length, 'El número de cierres no coincide con la tabla');
  truth(G2, 'Tabla ordenada por resultado', rz.every((r, i) => i === 0 || rz[i - 1].pl <= r.pl), 'La lista no está ordenada: la tabla saldría desordenada');

  /* ---- Dividendos ---- */
  const G3 = 'Dividendos';
  const dv = data.dividends;
  const deg = dv.filter((d) => d.account === 'DEGIRO'), ib = dv.filter((d) => d.account === 'IBKR');
  const roundNote = 'Tolerancia de 5 céntimos: cada fila está redondeada por separado.';
  eq(G3, 'DEGIRO bruto = suma de filas', c.degiro_div_gross, sum(deg, (d) => d.gross_eur), { tol: 0.051, note: roundNote });
  eq(G3, 'DEGIRO retención = suma de filas', c.degiro_div_tax, sum(deg, (d) => d.tax_eur), { tol: 0.051, note: roundNote });
  eq(G3, 'DEGIRO neto = bruto + retención', c.degiro_div_net, c.degiro_div_gross + c.degiro_div_tax);
  eq(G3, 'IBKR bruto = suma de filas', ibkr.div_gross, sum(ib, (d) => d.gross_eur), { tol: 0.051, note: roundNote });
  eq(G3, 'IBKR neto = bruto + retención', ibkr.div_net, ibkr.div_gross + ibkr.div_tax);
  eq(G3, extraList.length ? 'Total neto = suma de todas las cuentas' : 'Total neto = IBKR + DEGIRO', c.total_div_net, ibkr.div_net + c.degiro_div_net + extraDivNet);
  truth(G3, 'Tabla ordenada por importe bruto', dv.every((d, i) => i === 0 || dv[i - 1].gross_eur >= d.gross_eur), 'La lista no está ordenada: el gráfico no mostraría los 12 mayores');
  truth(G3, 'Retenciones con signo negativo', dv.every((d) => d.tax_eur <= 0 && d.gross_eur > 0), 'Hay una retención positiva o un bruto no positivo');

  /* ---- Comisiones ---- */
  const G4 = 'Comisiones';
  const bd = c.degiro_fees_breakdown;
  eq(G4, 'Total DEGIRO = suma del desglose', c.degiro_fees, Object.keys(bd).reduce((a, k) => a + bd[k], 0));
  eq(G4, 'Comisiones fuera de compraventa', c.degiro_non_trade_fees, nonTradeFees(bd));

  /* ---- Aportaciones ---- */
  const G5 = 'Aportaciones';
  const ev = data.degiro_cashflow_events;
  eq(G5, 'DEGIRO = depósitos − retiradas + promoción', c.degiro_contributions, c.degiro_deposits_gross + c.degiro_withdrawals + c.degiro_promo);
  eq(G5, 'DEGIRO = suma de flujos fechados (base de la TIR)', c.degiro_contributions, -sum(ev, (e) => e[1]));
  eq(G5, 'IBKR = suma de sus aportaciones fechadas', ibkr.contributions, sum(ibkr.contribution_events, (e) => e[1]));
  eq(G5, extraList.length ? 'Total = suma de todas las cuentas' : 'Total = IBKR + DEGIRO', c.total_contributions, ibkr.contributions + c.degiro_contributions + extraContrib);
  const last = data.monthly[data.monthly.length - 1] || { cum_deg: 0, cum_ibkr: 0, cum_extra: 0 };
  eq(G5, 'Gráfico mensual DEGIRO = depósitos − retiradas', last.cum_deg, c.degiro_deposits_gross + c.degiro_withdrawals);
  eq(G5, 'Gráfico mensual IBKR = aportaciones IBKR', last.cum_ibkr, ibkr.contributions);
  let cumI = 0, cumD = 0, cumE = 0, monthlyOk = true;
  data.monthly.forEach((m, i) => {
    cumI += m.ibkr; cumD += m.degiro;
    const mEx = m.extra ? Object.values(m.extra).reduce((a, v) => a + (Number(v) || 0), 0) : 0;
    cumE += mEx;
    if (Math.abs(cumI - m.cum_ibkr) > 0.011 || Math.abs(cumD - m.cum_deg) > 0.011 || Math.abs(m.cum_total - m.cum_ibkr - m.cum_deg - (m.cum_extra || 0)) > 0.011) monthlyOk = false;
    if (extraList.length && Math.abs(cumE - (m.cum_extra || 0)) > 0.011) monthlyOk = false;
    if (i > 0 && data.monthly[i - 1].month >= m.month) monthlyOk = false;
  });
  truth(G5, 'Acumulados mensuales consecutivos y en orden', monthlyOk, 'Algún acumulado mensual no coincide con la suma de los meses anteriores');
  truth(G5, 'Flujos fechados en orden y dentro del periodo', ev.every((e, i) => (i === 0 || ev[i - 1][0] <= e[0]) && e[0] >= c.degiro_date_min && e[0] <= c.degiro_date_max), 'Hay flujos desordenados o fuera del periodo de la cuenta');

  /* ---- Rendimiento ---- */
  const G6 = 'Rendimiento';
  eq(G6, 'DEGIRO = realizado + no realizado + dividendos + intereses + comisiones', c.degiro_total_return,
    c.degiro_realized_total + c.degiro_unrealized_pl + c.degiro_div_net + c.degiro_interest + c.degiro_non_trade_fees + (c.degiro_sec_lending || 0));
  if (c.degiro_contributions > 0) eq(G6, 'DEGIRO % sobre lo aportado', c.degiro_total_return_pct, c.degiro_total_return / c.degiro_contributions * 100, { unit: '%' });
  else truth(G6, 'DEGIRO % sobre lo aportado', c.degiro_total_return_pct == null || (c.degiro_contributions === 0 && c.degiro_total_return === 0 && c.degiro_total_return_pct === 0), 'Con aportaciones netas ≤ 0 el % sobre lo aportado no aplica');
  eq(G6, extraList.length ? 'Cartera = suma del rendimiento de todas las cuentas' : 'Cartera = (valor IBKR − aportado IBKR) + DEGIRO', c.portfolio_total_return, (ibkr.nav_final - ibkr.contributions) + c.degiro_total_return + extraRet);
  if (c.total_contributions > 0) eq(G6, 'Cartera % sobre lo aportado', c.portfolio_total_return_pct, c.portfolio_total_return / c.total_contributions * 100, { unit: '%' });
  else truth(G6, 'Cartera % sobre lo aportado', c.portfolio_total_return_pct == null || (c.total_contributions === 0 && c.portfolio_total_return === 0 && c.portfolio_total_return_pct === 0), 'Con aportaciones netas ≤ 0 el % sobre lo aportado no aplica');
  eq(G6, 'Valor total = aportaciones + rendimiento', c.portfolio_value_total, c.total_contributions + c.portfolio_total_return);
  eq(G6, 'IBKR: valor de acciones − coste = plusvalía', ibkr.stocks_pl, ibkr.stocks_value - ibkr.stocks_cost);
  eq(G6, 'IBKR: valor de la cuenta = acciones + efectivo + dividendo devengado', ibkr.nav_final, ibkr.stocks_value + ibkr.cash_final + ibkr.accrued_div);
  const x = degiroXirrPct(data);
  if (x != null) {
    eq(G6, 'TIR de DEGIRO recalculada', c.degiro_xirr_pct, x, { tol: 0.101, unit: '%', note: 'Tolerancia de 0,1 puntos: la TIR depende del día exacto de valoración.' });
  }

  if (ibkr.xirr_pct != null) {
    const xi = ibkrXirrPct(ibkr);
    if (xi != null) eq(G6, 'TIR de IBKR recalculada', ibkr.xirr_pct, xi, { tol: 0.011, unit: '%' });
    eq(G6, 'IBKR: resultado = valor de la cuenta − aportaciones netas', ibkr.result, ibkr.nav_final - ibkr.contributions);
  }

  /* ---- Extractos importados ---- */
  const src = data.sources || {};
  if (src.degiro) {
    const G9 = 'Extractos importados';
    const gaps = src.degiro.balance_gaps || [];
    truth(G9, `DEGIRO: ${src.degiro.rows} movimientos del ${src.degiro.date_min} al ${src.degiro.date_max}, sin saltos en el saldo`, !gaps.length,
      gaps.map((g) => `faltan movimientos entre el ${g.after} y el ${g.before}`).join(' · '));
    truth(G9, 'DEGIRO: el libro arranca con la cuenta a cero', src.degiro.opening_balance == null || Math.abs(src.degiro.opening_balance) < 0.011,
      `El primer movimiento parte de un saldo de ${src.degiro.opening_balance} €: falta el extracto desde la apertura de la cuenta`);
    truth(G9, 'DEGIRO: todos los movimientos son de un tipo conocido', !src.degiro.unknown_rows, `${src.degiro.unknown_rows} movimientos de tipo desconocido no se han contado`, 'aviso');
    eq(G9, 'DEGIRO: el monedero del extracto coincide con el efectivo reconstruido', c.degiro_cash_wallet, c.degiro_implied_cash,
      { tol: 1, note: 'Con los movimientos a mano posteriores al extracto puede haber una pequeña diferencia de redondeo.' });
  }
  if (src.ibkr) {
    const G9 = 'Extractos importados';
    const gaps = src.ibkr.coverage_gaps || [];
    truth(G9, `IBKR: ${src.ibkr.statements} ${src.ibkr.statements === 1 ? 'informe' : 'informes'} del ${src.ibkr.date_min} al ${src.ibkr.date_max}, sin huecos entre periodos`, !gaps.length,
      gaps.map((g) => `falta el periodo del ${g.from} al ${g.to}`).join(' · '));
    truth(G9, 'IBKR: el primer informe arranca con la cuenta vacía', !(src.ibkr.nav_initial > 0.005), `La cuenta ya tenía ${src.ibkr.nav_initial} € al empezar el primer informe: faltan los informes anteriores`, 'aviso');
  }

  /* ---- Efectivo ---- */
  const G7 = 'Efectivo';
  eq(G7, 'Efectivo implícito = entradas − coste de lo que sigue en cartera', c.degiro_implied_cash,
    c.degiro_contributions + c.degiro_realized_total + c.degiro_div_net + c.degiro_interest + c.degiro_non_trade_fees + (c.degiro_sec_lending || 0) - c.degiro_open_cost_total);
  eq(G7, 'Monedero de DEGIRO frente a efectivo implícito', c.degiro_cash_wallet, c.degiro_implied_cash,
    { tol: 5, level: 'aviso', note: 'Deben parecerse (±5 €); la diferencia viene de redondeos de divisa acumulados. Si se separan, falta o sobra algún movimiento.' });

  /* ---- Comportamiento ---- */
  const G8 = 'Operativa';
  const qs = data.behavior.quarterly;
  truth(G8, 'Trimestres: operaciones = compras + ventas, ticket medio = capital ÷ compras',
    qs.every((q) => q.n_trades === q.n_buys + q.n_sells && Math.abs(q.avg_buy_size - (q.n_buys ? q.capital / q.n_buys : 0)) <= 0.011),
    'Algún trimestre tiene totales que no cuadran');
  truth(G8, 'Cierres: días en cartera = cierre − apertura',
    data.behavior.episodes.every((e) => e.close >= e.open && Math.abs(e.holding_days - (isoToMs(e.close) - isoToMs(e.open)) / DAY_MS) <= 1),
    'Algún cierre tiene fechas incoherentes');

  /* ---- Cuentas adicionales (Trading 212, Trade Republic, MyInvestor…) ---- */
  if (extraList.length) {
    const G10 = 'Cuentas adicionales';
    extraList.forEach((b) => {
      const bPos = b.positions || [];
      const bad = [];
      bPos.forEach((p) => {
        const cur = positionCurrency(p);
        const rate = cur === 'EUR' ? 1 : fx[cur];
        const probs = [];
        if (!(p.qty > 0)) probs.push('cantidad');
        if (!(p.cost_total > 0)) probs.push('coste');
        if (!(rate > 0)) probs.push('tipo de cambio ' + cur);
        else if (Math.abs(p.live_value_eur - round2(p.qty * p.live_price / rate)) > 0.011) probs.push('valor');
        if (Math.abs(p.live_pl_eur - (p.live_value_eur - p.cost_total)) > 0.011) probs.push('plusvalía');
        if (probs.length) bad.push(`${p.name}: ${probs.join(', ')}`);
      });
      truth(G10, `${b.name}: valoración de posiciones (${bPos.length})`, !bad.length, bad.join(' · '));
      eq(G10, `${b.name}: valor total = suma de posiciones`, b.value_total, sum(bPos, (p) => p.live_value_eur));
      eq(G10, `${b.name}: rendimiento = realizado + no realizado + dividendos + intereses + comisiones`, b.total_return,
        b.realized_total + b.unrealized_pl + b.div_net + (b.interest || 0) + (b.non_trade_fees || 0));
      eq(G10, `${b.name}: patrimonio neto = posiciones + efectivo implícito`, b.nav_total, b.value_total + b.implied_cash);
      const bx = brokerXirrPct(b, data);
      if (bx != null && b.xirr_pct != null) eq(G10, `${b.name}: TIR recalculada`, b.xirr_pct, bx, { tol: 0.101, unit: '%' });
    });
  }

  return out;
}

function summarize(checks) {
  const errors = checks.filter((k) => !k.ok && k.level === 'error').length;
  const warnings = checks.filter((k) => !k.ok && k.level !== 'error').length;
  return { total: checks.length, passed: checks.filter((k) => k.ok).length, errors, warnings };
}

module.exports = { runChecks, summarize };
