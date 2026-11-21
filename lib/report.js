'use strict';
/*
 * Informe de la cartera para leer fuera de la aplicación (o dárselo a una IA).
 *
 * buildReport() arma el contenido una sola vez, como una lista de secciones con
 * párrafos y tablas; toHtml() y toMarkdown() solo lo pintan. Así el HTML, el PDF
 * (que es ese mismo HTML impreso desde el navegador) y el texto dicen exactamente
 * lo mismo.
 *
 * El HTML no lleva scripts ni recursos externos: es un único archivo que se puede
 * abrir en cualquier sitio.
 */

const { round2, dateLabels, FEE_CATEGORIES } = require('./calc');
const { brokersIn } = require('./empty');

const nf2 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
const nfQ = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4, useGrouping: 'always' });
const nfP = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4, useGrouping: 'always' });
const DASH = '—';

const ok = (n) => typeof n === 'number' && isFinite(n);
const eur = (n) => (ok(n) ? nf2.format(n) + ' €' : DASH);
const eurS = (n) => (ok(n) ? (n > 0 ? '+' : '') + nf2.format(n) + ' €' : DASH);
const pct = (n, d) => (ok(n) ? (n > 0 ? '+' : '') + n.toFixed(d == null ? 2 : d).replace('.', ',') + ' %' : DASH);
const share = (n) => (ok(n) ? n.toFixed(1).replace('.', ',') + ' %' : DASH);
const qty = (n) => (ok(n) ? nfQ.format(n) : DASH);
const price = (n, cur) => (ok(n) ? nfP.format(n) + ' ' + cur : DASH);
const day = (iso) => (iso ? dateLabels(String(iso).slice(0, 10)).short : DASH);
const sum = (list, fn) => list.reduce((a, x) => a + (fn(x) || 0), 0);

/**
 * opts: { anon, includeTrades, titular, today, degiroTrades, ibkrTrades, checks }
 */
function buildReport(data, opts) {
  opts = opts || {};
  const c = data.combined, ibkr = data.ibkr, lm = data.live_meta || {};
  const fx = lm.fx || {};
  const imported = !!(ibkr.statements && ibkr.statements.length);
  const sections = [];
  const add = (title, body) => sections.push(Object.assign({ title, paragraphs: [], tables: [] }, body));

  /* ---------- posiciones de las dos cuentas en una sola lista, en euros ---------- */
  const positions = [];
  data.degiro_open_positions.forEach((p) => positions.push({
    account: 'DEGIRO', name: p.name, isin: p.isin, qty: p.qty, cur: p.live_price_cur, price: p.live_price,
    value: p.live_value_eur, cost: p.cost_total, pl: p.live_pl_eur, plPct: p.live_pl_pct, opened: p.opened || null, approx: false,
  }));
  let ibkrApprox = false;
  ibkr.positions.forEach((p) => {
    let value = p.value_eur, cost = p.cost_eur, approx = false;
    if (!ok(value)) {
      // Informe importado con una versión anterior: se convierte con el tipo de cambio guardado.
      const rate = p.cur === 'EUR' ? 1 : fx[p.cur];
      value = rate ? round2(p.value / rate) : null;
      cost = ok(value) && ok(p.pl_eur) ? round2(value - p.pl_eur) : null;
      approx = p.cur !== 'EUR'; if (approx) ibkrApprox = true;
    }
    positions.push({
      account: 'IBKR', name: p.name, isin: p.isin || p.sym, qty: p.qty, cur: p.cur, price: p.price,
      value, cost, pl: p.pl_eur, plPct: ok(cost) && cost ? round2(p.pl_eur / cost * 100) : p.ret_pct, opened: null, approx,
    });
  });
  positions.sort((a, b) => (b.value || 0) - (a.value || 0));
  const totalPositions = sum(positions, (p) => p.value);

  const degiroNet = round2(c.degiro_contributions + c.degiro_total_return);
  const ibkrCash = round2((ibkr.cash_final || 0) + (ibkr.accrued_div || 0));
  const ibkrResult = ok(ibkr.result) ? ibkr.result : round2(ibkr.nav_final - ibkr.contributions);

  const has = brokersIn(data);
  const both = has.degiro && has.ibkr;
  const brokerDesc = both
    ? 'Es una cartera personal de acciones repartida entre dos brókers: DEGIRO e Interactive Brokers (IBKR).'
    : (has.degiro ? 'Es una cartera personal de acciones en DEGIRO.' : (has.ibkr ? 'Es una cartera personal de acciones en Interactive Brokers (IBKR).' : 'Cartera personal sin movimientos importados todavía.'));
  const dataDates = [
    has.degiro ? `DEGIRO: movimientos del ${day(c.degiro_date_min)} al ${day(c.degiro_date_max)}; sus posiciones se valoran con precios de mercado del ${day(lm.valuation_iso) !== DASH ? day(lm.valuation_iso) : (lm.fetched_date || DASH)}${lm.manual ? ' (introducidos a mano)' : ''}.` : '',
    has.ibkr ? `IBKR: ${imported ? `${ibkr.statements.length} ${ibkr.statements.length === 1 ? 'informe' : 'informes'} de actividad` : 'extracto'} del ${day(ibkr.period_start)} al ${day(ibkr.period_end)}; posiciones, precios y efectivo son los del ${day(ibkr.period_end)}.` : '',
  ].filter(Boolean).join(' ');

  /* ---------- cabecera ---------- */
  const intro = [
    `Informe generado el ${day(opts.today)} por Panorama de Cartera, la aplicación con la que el titular lleva su cartera. ${brokerDesc}`,
    'Todas las cifras están en euros salvo que se indique otra divisa. Los números usan el formato español: punto para los miles y coma para los decimales (1.234,56). Un importe negativo es una pérdida, un coste o un saldo deudor.',
    dataDates ? `Fecha de los datos. ${dataDates}` : '',
  ].filter(Boolean);
  if (!opts.anon && opts.titular) intro.unshift(`Titular: ${opts.titular}.${has.ibkr && ibkr.account ? ` Cuenta de IBKR: ${ibkr.account}.` : ''}`);

  /* ---------- 1. resumen ---------- */
  add('Resumen', {
    tables: [{
      head: ['Concepto', 'Total', 'DEGIRO', 'IBKR'], align: 'lrrr',
      rows: [
        ['Patrimonio neto (posiciones + efectivo)', eur(c.portfolio_value_total), eur(degiroNet), eur(ibkr.nav_final)],
        ['Valor de las posiciones', eur(round2(c.degiro_value_total + ibkr.stocks_value)), eur(c.degiro_value_total), eur(ibkr.stocks_value)],
        ['Efectivo', eur(round2(c.degiro_cash_wallet + ibkrCash)), eur(c.degiro_cash_wallet), eur(ibkrCash)],
        ['Aportaciones netas (ingresos − retiradas)', eur(c.total_contributions), eur(c.degiro_contributions), eur(ibkr.contributions)],
        ['Rendimiento total acumulado', eurS(c.portfolio_total_return), eurS(c.degiro_total_return), eurS(ibkrResult)],
        ['Rendimiento sobre lo aportado', pct(c.portfolio_total_return_pct), pct(c.degiro_total_return_pct), pct(ibkr.contributions > 0 ? ibkrResult / ibkr.contributions * 100 : null)],
        ['TIR anualizada', DASH, pct(c.degiro_xirr_pct), pct(ibkr.xirr_pct)],
        ['Plusvalía no realizada', eurS(round2(c.degiro_unrealized_pl + ibkr.stocks_pl)), eurS(c.degiro_unrealized_pl), eurS(ibkr.stocks_pl)],
        ['Resultado realizado en ventas', ok(ibkr.realized_pl) ? eurS(round2(c.degiro_realized_total + ibkr.realized_pl)) : DASH, eurS(c.degiro_realized_total), eurS(ibkr.realized_pl)],
        ['Dividendos netos cobrados', eur(c.total_div_net), eur(c.degiro_div_net), eur(ibkr.div_net)],
        ['Comisiones y costes', eur(round2(c.degiro_fees + ibkr.fees)), eur(c.degiro_fees), eur(ibkr.fees)],
        ['Intereses de la cuenta de efectivo', eur(c.degiro_interest), eur(c.degiro_interest), DASH],
        ['Posiciones abiertas', String(positions.length), String(data.degiro_open_positions.length), String(ibkr.positions.length)],
      ],
    }],
    paragraphs: [
      c.degiro_cash_wallet < -0.005
        ? `El efectivo de DEGIRO es negativo (${eur(c.degiro_cash_wallet)}): se ha comprado por encima del efectivo disponible y DEGIRO cobra intereses por ese saldo (${eur(c.degiro_interest)} acumulados). El patrimonio neto ya lo descuenta.`
        : `Efectivo en DEGIRO: ${eur(c.degiro_cash_wallet)}.`,
      'La TIR es la tasa interna de retorno anualizada: tiene en cuenta la fecha de cada aportación y retirada. No se da una TIR conjunta; cada cuenta tiene la suya, calculada con el mismo método.',
    ],
  });

  /* ---------- 1b. comparación con índices ---------- */
  const B = opts.benchmark;
  if (B && !B.error && B.series && B.series.length) {
    const P = B.portfolio;
    const rows = [['Tu cartera', eur(P.value), eurS(P.gain), pct(P.gainPct, 1), pct(P.xirr, 1), DASH]]
      .concat(B.series.map((s) => [`${s.name} (${s.symbol})`, eur(s.final), eurS(s.gain), pct(s.gainPct, 1), pct(s.xirr, 1), eurS(round2(P.value - s.final))]));
    // Valor a final de cada trimestre (y el último dato), para ver la evolución.
    const idx = [];
    B.dates.forEach((d, i) => { const next = B.dates[i + 1]; if (!next || next.slice(0, 7) !== d.slice(0, 7) && ['03', '06', '09', '12'].includes(d.slice(5, 7))) idx.push(i); });
    const evo = idx.map((i) => [B.dates[i], eur(B.contributions[i])].concat(B.series.map((s) => eur(s.values[i]))));
    add('Comparación con índices (mismo dinero, mismas fechas)', {
      tables: [
        { head: ['', 'Valor', 'Ganancia', 'Sobre lo aportado', 'TIR anual', 'Tu cartera frente al índice'], align: 'lrrrrr', rows },
        { caption: 'Evolución trimestral de lo aportado y de su valor en cada índice', head: ['Fecha', 'Aportado'].concat(B.series.map((s) => s.name)), align: 'l' + 'r'.repeat(B.series.length + 1), rows: evo },
      ],
      paragraphs: [
        `Cada índice muestra lo que valdría el dinero aportado (${eur(P.contributed)} netos desde el ${day(B.start)}) si cada aportación y cada retirada se hubiera hecho ese mismo día en un fondo que replica el índice (${B.series.map((s) => `${s.symbol} para el ${s.name}`).join(', ')}), con dividendos reinvertidos y en euros. Sin comisiones ni impuestos. Índices hasta el ${day(B.asOf)}; la cartera, a la fecha de los datos indicada al principio.`,
        'La TIR anual tiene en cuenta cuándo entró cada euro: es la cifra adecuada para comparar la gestión de la cartera con el índice. La TIR de la cartera aquí es la conjunta de las dos cuentas.',
      ],
    });
  }

  /* ---------- 2. posiciones ---------- */
  const posRows = positions.map((p) => [
    p.account, p.name, p.isin, qty(p.qty), price(p.price, p.cur), (p.approx ? '≈ ' : '') + eur(p.value), share(totalPositions ? p.value / totalPositions * 100 : null),
    (p.approx ? '≈ ' : '') + eur(p.cost), eurS(p.pl), pct(p.plPct, 1), p.opened ? day(p.opened) : DASH,
  ]);
  posRows.push(['Total', '', '', '', '', eur(round2(totalPositions)), '100,0 %', eur(round2(sum(positions, (p) => p.cost))), eurS(round2(sum(positions, (p) => p.pl))), '', '']);
  const byCur = new Map();
  positions.forEach((p) => byCur.set(p.cur, (byCur.get(p.cur) || 0) + (p.value || 0)));
  const curRows = Array.from(byCur.entries()).sort((a, b) => b[1] - a[1]).map(([cur, v]) => [cur, eur(round2(v)), share(totalPositions ? v / totalPositions * 100 : null)]);
  add('Posiciones abiertas', {
    tables: [
      { head: ['Cuenta', 'Valor', 'ISIN', 'Títulos', 'Precio', 'Valor (EUR)', 'Peso', 'Coste (EUR)', 'Plusvalía (EUR)', 'Plusvalía %', 'Abierta desde'], align: 'lllrrrrrrrl', rows: posRows, lastRowTotal: true },
      { caption: 'Exposición por divisa de cotización', head: ['Divisa', 'Valor (EUR)', 'Peso'], align: 'lrr', rows: curRows },
    ],
    paragraphs: [
      'El peso es el valor de cada posición sobre el valor de todas las posiciones (sin contar el efectivo). El coste incluye las comisiones de compra y se calcula por coste medio. «Abierta desde» es la fecha de la primera compra de la posición actual; en IBKR no se indica.',
      'La divisa es la de la cotización usada para valorar cada posición, que puede no ser la del mercado donde se compró: algunos valores se valoran con su cotización en otra bolsa.' +
        (ibkrApprox ? ' Los importes de IBKR marcados con ≈ se han pasado a euros con el tipo de cambio guardado en la aplicación.' : ''),
    ],
  });

  /* ---------- 3. dividendos ---------- */
  const divs = data.dividends.slice().sort((a, b) => b.gross_eur - a.gross_eur);
  add('Dividendos cobrados por valor (histórico)', {
    tables: [{
      head: ['Cuenta', 'Valor', 'Divisa', 'Bruto (EUR)', 'Retención (EUR)', 'Neto (EUR)'], align: 'lllrrr',
      rows: divs.map((d) => [d.account, d.name, d.cur, (d.approx ? '≈ ' : '') + eur(d.gross_eur), eur(d.tax_eur), eur(round2(d.gross_eur + d.tax_eur))])
        .concat([['Total', '', '', eur(round2(sum(divs, (d) => d.gross_eur))), eur(round2(sum(divs, (d) => d.tax_eur))), eur(round2(sum(divs, (d) => d.gross_eur + d.tax_eur)))]]),
      lastRowTotal: true,
    }],
    paragraphs: ['Incluye valores que ya no están en cartera. Los importes con ≈ son estimaciones a la espera de la conversión a euros del bróker.'],
  });

  /* ---------- 4. resultado realizado ---------- */
  const rz = data.degiro_realized.slice().sort((a, b) => b.pl - a.pl);
  if (has.degiro || rz.length) {
    add('Resultado realizado por valor en DEGIRO (histórico)', {
      tables: [{
        head: ['Valor', 'ISIN', 'Resultado (EUR)'], align: 'llr',
        rows: rz.map((r) => [r.name, r.isin, eurS(r.pl)]).concat([['Total', '', eurS(c.degiro_realized_total)]]), lastRowTotal: true,
      }],
      paragraphs: [
        `${c.degiro_realized_gains_count} valores con ganancia (${eurS(c.degiro_realized_gains)}) y ${c.degiro_realized_losses_count} con pérdida (${eurS(c.degiro_realized_losses)}). Resultado de las ventas por coste medio, comisiones incluidas; una fila por valor aunque se haya comprado y vendido varias veces.` +
        (ok(ibkr.realized_pl) ? ` En IBKR el resultado realizado acumulado es de ${eurS(ibkr.realized_pl)}.` : ''),
      ],
    });
  }

  /* ---------- 5. aportaciones ---------- */
  const years = new Map();
  data.monthly.forEach((m) => {
    const y = m.month.slice(0, 4);
    if (!years.has(y)) years.set(y, { d: 0, i: 0 });
    years.get(y).d += m.degiro; years.get(y).i += m.ibkr;
  });
  let acc = 0;
  const yearRows = Array.from(years.entries()).sort().map(([y, v]) => { acc += v.d + v.i; return [y, eur(round2(v.d)), eur(round2(v.i)), eur(round2(v.d + v.i)), eur(round2(acc))]; });
  add('Aportaciones netas', {
    tables: [
      { caption: 'Por año', head: ['Año', 'DEGIRO', 'IBKR', 'Total del año', 'Acumulado'], align: 'lrrrr', rows: yearRows },
      { caption: 'Por mes (solo los meses con movimientos)', head: ['Mes', 'DEGIRO', 'IBKR', 'Acumulado'], align: 'lrrr', rows: data.monthly.map((m) => [m.month, eur(m.degiro), eur(m.ibkr), eur(m.cum_total)]) },
    ],
    paragraphs: ['Dinero ingresado desde el banco menos dinero retirado. Un importe negativo es una retirada.' +
      (c.degiro_promo ? ` Aparte, DEGIRO abonó ${eur(c.degiro_promo)} de una promoción, que cuenta como aportación en el total de la cuenta.` : '')],
  });

  /* ---------- 6. costes ---------- */
  const bd = c.degiro_fees_breakdown || {};
  add('Comisiones y costes', {
    tables: [{
      head: ['Concepto', 'Importe (EUR)'], align: 'lr',
      rows: Object.keys(bd).filter((k) => bd[k]).map((k) => ['DEGIRO · ' + (FEE_CATEGORIES[k] || k), eur(bd[k])])
        .concat([['DEGIRO · Intereses de la cuenta de efectivo', eur(c.degiro_interest)], ['IBKR · Comisiones', eur(ibkr.fees)],
          ['Total', eur(round2(c.degiro_fees + c.degiro_interest + ibkr.fees))]]),
      lastRowTotal: true,
    }],
  });

  /* ---------- 7. operativa ---------- */
  const eps = data.behavior.episodes.slice().sort((a, b) => a.close.localeCompare(b.close));
  if (has.degiro || data.behavior.quarterly.length || eps.length) {
    const stat = (list) => {
      const wins = list.filter((e) => e.pnl > 0).length;
      return [String(list.length), list.length ? Math.round(wins / list.length * 100) + ' %' : DASH, eurS(round2(sum(list, (e) => e.pnl))),
        list.length ? String(Math.round(sum(list, (e) => e.holding_days) / list.length)) : DASH];
    };
    add('Operativa en DEGIRO', {
      tables: [
        {
          caption: 'Por trimestre', head: ['Trimestre', 'Operaciones', 'Compras', 'Ventas', 'Valores distintos', 'Capital comprado (EUR)', 'Compra media (EUR)'], align: 'lrrrrrr',
          rows: data.behavior.quarterly.map((q) => [q.quarter, String(q.n_trades), String(q.n_buys), String(q.n_sells), String(q.tickers), eur(q.capital), eur(q.avg_buy_size)]),
        },
        {
          caption: 'Posiciones cerradas: resumen', head: ['Grupo', 'Cierres', 'Con ganancia', 'Resultado (EUR)', 'Días medios en cartera'], align: 'lrrrr',
          rows: [
            ['Todas'].concat(stat(eps)),
            ['Mantenidas 14 días o menos'].concat(stat(eps.filter((e) => e.holding_days <= 14))),
            ['Mantenidas más de 14 días'].concat(stat(eps.filter((e) => e.holding_days > 14))),
          ].concat(Array.from(new Set(eps.map((e) => e.close.slice(0, 4)))).sort().map((y) => [`Cerradas en ${y}`].concat(stat(eps.filter((e) => e.close.slice(0, 4) === y))))),
        },
        {
          caption: 'Posiciones cerradas: detalle', head: ['Valor', 'ISIN', 'Apertura', 'Cierre', 'Días', 'Resultado (EUR)'], align: 'llllrr',
          rows: eps.map((e) => [e.name, e.isin, day(e.open), day(e.close), String(e.holding_days), eurS(e.pnl)]),
        },
      ],
      paragraphs: ['Una posición cerrada es un ciclo completo: desde la primera compra de un valor hasta que se vende todo. El mismo valor puede aparecer varias veces. Las operaciones del trimestre cuentan cada ejecución, y el capital comprado incluye comisiones.'],
    });
  }

  /* ---------- 8. operaciones ---------- */
  if (opts.includeTrades && ((opts.degiroTrades && opts.degiroTrades.length) || (opts.ibkrTrades && opts.ibkrTrades.length))) {
    const tables = [];
    if (opts.degiroTrades && opts.degiroTrades.length) {
      tables.push({
        caption: `DEGIRO (${opts.degiroTrades.length} órdenes ejecutadas)`,
        head: ['Fecha', 'Tipo', 'Valor', 'ISIN', 'Títulos', 'Precio', 'Importe (EUR)', 'Comisión (EUR)', 'Resultado (EUR)'], align: 'llllrrrrr',
        rows: opts.degiroTrades.map((t) => [t.date, t.side === 'compra' ? 'Compra' : 'Venta', t.name, t.isin, qty(t.qty), price(t.price, t.cur), eur(t.eur), eur(-t.fee), t.side === 'venta' ? eurS(t.pl) : '']),
      });
    }
    if (opts.ibkrTrades && opts.ibkrTrades.length) {
      tables.push({
        caption: `Interactive Brokers (${opts.ibkrTrades.length} operaciones)`,
        head: ['Fecha', 'Tipo', 'Valor', 'Títulos', 'Precio', 'Importe en su divisa', 'Comisión (EUR)', 'Resultado (EUR)'], align: 'lllrrrrr',
        rows: opts.ibkrTrades.map((t) => [t.date, t.qty >= 0 ? 'Compra' : 'Venta', t.symbol, qty(Math.abs(t.qty)), price(t.price, t.cur), price(Math.abs(t.proceeds), t.cur), eur(round2(t.fee_eur)), t.qty < 0 ? eurS(round2(t.realized_eur)) : '']),
      });
    }
    add('Todas las operaciones', {
      tables,
      paragraphs: ['Fechas en formato año-mes-día. En DEGIRO, el importe es lo pagado o cobrado en euros por los títulos, sin la comisión, y una orden ejecutada en varios tramos aparece como una sola fila con su precio medio.'],
    });
  }

  /* ---------- 8b. simulación fiscal IRPF (España) ---------- */
  const TX = opts.irpf;
  if (TX && !TX.error && TX.hasData && TX.years && TX.years.length) {
    const yearRows = TX.years.map((y) => [
      String(y.year),
      eurS(y.gains),
      eurS(y.lossesGross),
      y.lossesBlocked ? eur(y.lossesBlocked) : DASH,
      y.lossesLiberated ? eur(y.lossesLiberated) : DASH,
      eurS(y.gppYear),
      eur(y.rcmNet),
      eur(y.baseAhorro),
      eur(y.cuotaIntegra),
      eur(y.cuotaNetaEst),
    ]);
    const paras = [
      'Estimación orientativa para IRPF en España (territorio común, Base Imponible del Ahorro): método FIFO global por ISIN uniendo todas las cuentas, regla antiaplicación de los 2 meses (art. 33.5.f LIRPF), compensación cruzada hasta el 25 % y arrastre de saldos negativos durante 4 ejercicios (art. 49 LIRPF). Escala del ahorro 2023–2024 (19–28 %) y desde 2025 (19–30 %).',
      'La cuota neta estimada descuenta una deducción orientativa por doble imposición internacional (art. 80 LIRPF, tope estándar 15 % de convenio). No incluye otras rentas del ahorro externas a esta cartera ni sustituye el asesoramiento fiscal.',
    ];
    if (TX.pendingBlocked && TX.pendingBlocked.length) {
      paras.push(`Pérdidas bloqueadas pendientes de liberar (en lotes abiertos): ${eur(TX.pendingBlockedTotal)}.`);
    }
    add('Simulación fiscal IRPF (España · FIFO y regla de los 2 meses)', {
      tables: [{
        caption: 'Resumen por ejercicio fiscal (Base del Ahorro)',
        head: ['Año', 'Ganancias', 'Pérdidas brutas', 'Bloqueadas (2m)', 'Liberadas', 'Saldo GPP', 'RCM (div.+int.)', 'Base ahorro', 'Cuota íntegra', 'Cuota neta est.'],
        align: 'lrrrrrrrrr',
        rows: yearRows,
      }],
      paragraphs: paras,
    });
  }

  /* ---------- 9. método ---------- */
  const method = [
    'Coste de una posición: lo pagado en euros en cada compra, comisiones incluidas. Al vender se da de baja la parte proporcional (coste medio).',
    'Rendimiento de DEGIRO: resultado realizado + plusvalía no realizada + dividendos netos + intereses + préstamo de valores + comisiones que no son de compraventa. Las de compraventa ya están dentro del coste y del resultado.',
    'Rendimiento de IBKR: valor de la cuenta menos aportaciones netas, así que incluye el efecto del tipo de cambio.',
    'Patrimonio neto: aportaciones netas + rendimiento total. Equivale al valor de las posiciones más el efectivo.',
    'Los precios de mercado de DEGIRO no vienen en sus extractos: son los últimos guardados en la aplicación, a la fecha indicada al principio. Entre esa fecha y hoy el valor puede haber cambiado.',
  ];
  if (imported && ibkr.statements.some((s) => ok(s.twr_pct))) {
    method.push('Rentabilidad ponderada por tiempo que declara IBKR en cada informe: ' + ibkr.statements.filter((s) => ok(s.twr_pct)).map((s) => `${pct(s.twr_pct)} (${day(s.start)} – ${day(s.end)})`).join('; ') + '.');
  }
  if (ibkr.corporate_actions && ibkr.corporate_actions.length) {
    method.push('Operaciones corporativas en IBKR: ' + ibkr.corporate_actions.map((a) => `${day(a.date)}, ${a.desc}`).join('; ') + '.');
  }
  if (opts.checks) {
    method.push(opts.checks.errors
      ? `Atención: ${opts.checks.errors} de las ${opts.checks.total} comprobaciones internas de coherencia de la aplicación no cuadran en este momento.`
      : `Las ${opts.checks.total} comprobaciones internas de coherencia de la aplicación cuadran (por ejemplo, que el valor total sea la suma de las posiciones y que el saldo del extracto coincida con el efectivo reconstruido).`);
  }
  add('Cómo se han calculado las cifras', { list: method });

  return { title: `Informe de cartera · ${day(opts.today)}`, intro, sections, generated: opts.today };
}

/* ---------- Markdown ---------- */

function mdCell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
function toMarkdown(report) {
  const out = [`# ${report.title}`, ''];
  report.intro.forEach((p) => { out.push(p, ''); });
  report.sections.forEach((s) => {
    out.push(`## ${s.title}`, '');
    s.tables.forEach((t) => {
      if (t.caption) out.push(`**${t.caption}**`, '');
      out.push('| ' + t.head.map(mdCell).join(' | ') + ' |');
      out.push('| ' + t.head.map((_, i) => (t.align[i] === 'r' ? '---:' : '---')).join(' | ') + ' |');
      t.rows.forEach((r) => out.push('| ' + r.map(mdCell).join(' | ') + ' |'));
      out.push('');
    });
    s.paragraphs.forEach((p) => { out.push(p, ''); });
    (s.list || []).forEach((p) => out.push(`- ${p}`));
    if (s.list) out.push('');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------- HTML ---------- */

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:#fff;color:#1a2420;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:1080px;margin:0 auto}
h1{font-size:26px;margin:0 0 14px;letter-spacing:-.01em}
h2{font-size:18px;margin:38px 0 12px;padding-bottom:6px;border-bottom:2px solid #1e6e52}
h3{font-size:12px;margin:20px 0 6px;text-transform:uppercase;letter-spacing:.06em;color:#4e5c51}
p{margin:0 0 10px;max-width:92ch}
.intro p{color:#4e5c51}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:0 0 12px;font-size:12.5px}
th,td{padding:5px 9px;border-bottom:1px solid #d6dece;text-align:left;vertical-align:top}
th{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#4e5c51;border-bottom:1px solid #83907e;white-space:nowrap}
td.r,th.r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-top:1px solid #83907e;border-bottom:none}
ul{margin:0 0 10px;padding-left:20px;max-width:92ch}
li{margin-bottom:6px}
footer{margin-top:40px;font-size:12px;color:#83907e}
@media print{
  body{padding:0;font-size:10.5px}
  main{max-width:none}
  h2{break-after:avoid;margin-top:22px}
  h3{break-after:avoid}
  table{font-size:8.5px}
  th{font-size:7.5px}
  th,td{padding:3px 5px}
  tr{break-inside:avoid}
  thead{display:table-header-group}
  .wrap{overflow:visible}
  @page{size:A4 landscape;margin:12mm}
}
`;
function toHtml(report) {
  const h = [];
  h.push('<!doctype html>', '<html lang="es">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(report.title)}</title>`, `<style>${CSS}</style>`, '</head>', '<body>', '<main>', `<h1>${esc(report.title)}</h1>`, '<div class="intro">');
  report.intro.forEach((p) => h.push(`<p>${esc(p)}</p>`));
  h.push('</div>');
  report.sections.forEach((s) => {
    h.push('<section>', `<h2>${esc(s.title)}</h2>`);
    s.tables.forEach((t) => {
      if (t.caption) h.push(`<h3>${esc(t.caption)}</h3>`);
      const cls = (i) => (t.align[i] === 'r' ? ' class="r"' : '');
      h.push('<div class="wrap"><table>', '<thead><tr>' + t.head.map((x, i) => `<th${cls(i)}>${esc(x)}</th>`).join('') + '</tr></thead>', '<tbody>');
      t.rows.forEach((r, ri) => h.push(`<tr${t.lastRowTotal && ri === t.rows.length - 1 ? ' class="total"' : ''}>` + r.map((x, i) => `<td${cls(i)}>${esc(x)}</td>`).join('') + '</tr>'));
      h.push('</tbody>', '</table></div>');
    });
    s.paragraphs.forEach((p) => h.push(`<p>${esc(p)}</p>`));
    if (s.list) h.push('<ul>' + s.list.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul>');
    h.push('</section>');
  });
  h.push('<footer>Generado por Panorama de Cartera. Documento informativo: no es asesoramiento financiero.</footer>', '</main>', '</body>', '</html>');
  return h.join('\n') + '\n';
}

module.exports = { buildReport, toMarkdown, toHtml };
