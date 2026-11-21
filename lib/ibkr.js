'use strict';
/*
 * Interactive Brokers: lectura del «Informe de actividad» en CSV (en español),
 * libro de extractos sin repetidos y reconstrucción del bloque de IBKR.
 *
 * IBKR no deja exportar más de un año por informe, así que lo normal es tener
 * varios informes con fechas que se tocan o se solapan. Por eso:
 *  - Lo que son HECHOS con fecha (operaciones, dividendos, retenciones,
 *    depósitos, retiradas, comisiones) se guarda uno a uno y se reconoce si ya
 *    estaba: un solape entre informes no duplica nada.
 *  - Lo que es una FOTO (posiciones, efectivo, valor de la cuenta) se toma
 *    siempre del informe que termina más tarde.
 */

const { parseCsv } = require('./csv');
const { UserError, round2, round4, isoToMs, DAY_MS } = require('./calc');
const { titleCase } = require('./degiro');

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function num(s) {
  const t = String(s == null ? '' : s).trim().replace(/,/g, '').replace(/%$/, '');
  if (t === '' || t === '--') return 0;
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
}
/** "Junio 20, 2025" -> "2025-06-20" */
function esDate(s) {
  const m = /^([A-Za-zñÑáéíóú]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(s).trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase().replace('setiembre', 'septiembre'));
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

function looksLikeIbkr(text) {
  const head = text.replace(/^﻿/, '').slice(0, 400);
  return /^Statement,Header,/.test(head);
}

/** Agrupa el CSV en bloques: cada cabecera («Header») abre un bloque nuevo de su sección. */
function readBlocks(text) {
  const blocks = [];
  let current = null;
  parseCsv(text).forEach((r) => {
    if (r.length < 2) return;
    const [section, kind] = r;
    if (kind === 'Header') { current = { section, header: r.slice(2), rows: [] }; blocks.push(current); return; }
    if (!current || current.section !== section) { current = { section, header: [], rows: [] }; blocks.push(current); }
    const values = r.slice(2);
    const obj = {};
    current.header.forEach((h, i) => { if (h !== '' && !(h in obj)) obj[h] = values[i] == null ? '' : values[i]; });
    current.rows.push({ kind, values, get: (name) => (obj[name] == null ? '' : obj[name]) });
  });
  return blocks;
}

/** Numera las claves repetidas dentro de un mismo informe (dos apuntes idénticos legítimos). */
function keyed(list, keyOf) {
  const seen = new Map();
  return list.map((item) => {
    const base = keyOf(item);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return Object.assign({ key: n === 1 ? base : `${base}#${n}` }, item);
  });
}

/**
 * Lee un informe de actividad. Devuelve { statement, events }.
 */
function parseIbkrCsv(text, fileName) {
  if (!looksLikeIbkr(text)) throw new UserError('No parece un informe de actividad de Interactive Brokers en CSV.');
  const blocks = readBlocks(text);
  const of = (section) => blocks.filter((b) => b.section === section);
  const fields = (section) => {
    const out = {};
    of(section).forEach((b) => b.rows.forEach((r) => { if (r.kind === 'Data') out[r.values[0]] = r.values[1]; }));
    return out;
  };

  const st = fields('Statement');
  if (!st.Period) {
    throw new UserError('El informe de IBKR no está en español o no es un «Informe de actividad». En IBKR: Rendimiento e informes → Extractos → Actividad, formato CSV, con el idioma de la cuenta en español.');
  }
  const acct = fields('Información sobre la cuenta');
  if (!acct.Cuenta) throw new UserError('El informe de IBKR no está en español: no se encuentra la sección «Información sobre la cuenta».');
  if (acct['Divisa base'] && acct['Divisa base'] !== 'EUR') throw new UserError(`La divisa base de la cuenta de IBKR es ${acct['Divisa base']}; la aplicación solo admite cuentas en EUR.`);
  const parts = st.Period.split(' - ');
  const start = esDate(parts[0]), end = esDate(parts[parts.length - 1]);
  if (!start || !end) throw new UserError(`No se entiende el periodo del informe de IBKR («${st.Period}»).`);

  // --- valor liquidativo ---
  const navBlocks = of('Valor liquidativo');
  const nav = { start: 0, end: 0, cash: 0, stocks: 0 };
  let twr = null;
  navBlocks.forEach((b) => {
    if (b.header[0] === 'Clase de activo') {
      b.rows.forEach((r) => {
        const cls = r.get('Clase de activo'), prior = num(r.get('Total previo')), cur = num(r.get('Actual (total)'));
        if (cls === 'Total') { nav.start = prior; nav.end = cur; }
        else if (cls === 'Efectivo') nav.cash = cur;
        else if (cls === 'Acción' || cls === 'Acciones') nav.stocks = cur;
      });
    } else if (/rendimiento ponderada/i.test(b.header[0] || '')) {
      if (b.rows[0]) twr = num(b.rows[0].values[0]);
    }
  });
  const change = {};
  of('Cambio en NAV').forEach((b) => b.rows.forEach((r) => { change[r.values[0]] = num(r.values[1]); }));

  // --- instrumentos: símbolo -> ISIN, nombre ---
  const instruments = {};
  of('Información de instrumento financiero').forEach((b) => b.rows.forEach((r) => {
    if (r.kind !== 'Data') return;
    instruments[r.get('Símbolo')] = { isin: r.get('Id. de seguridad'), conid: r.get('Conid'), name: r.get('Descripción'), underlying: r.get('Underlying') || r.get('Símbolo') };
  }));
  const idOf = (symbol) => (instruments[symbol] && (instruments[symbol].isin || instruments[symbol].conid)) || symbol;

  // --- posiciones abiertas (foto al final del periodo) ---
  const unrealEur = {};
  of('Resumen del rendimiento realizado y no realizado').forEach((b) => b.rows.forEach((r) => {
    if (r.kind === 'Data' && r.get('Categoría de activo') === 'Acciones') unrealEur[r.get('Símbolo')] = num(r.get('No realiz. Total'));
  }));
  const positions = [];
  const stocksTotal = { cost: 0, value: 0, pl: 0 };
  // Cada divisa trae sus posiciones, su total en esa divisa y su total en euros: con la
  // proporción entre los dos totales se pasa a euros el valor y el coste de cada posición.
  let group = [], nativeTotal = null;
  of('Posiciones abiertas').forEach((b) => b.rows.forEach((r) => {
    if (r.get('Categoría de activo') !== 'Acciones') return;
    if (r.kind === 'Total') {
      if (r.get('Divisa') !== 'EUR') nativeTotal = { cost: num(r.get('Base de coste')), value: num(r.get('Valor')) };
      else if (group.length) {
        const eurCost = num(r.get('Base de coste')), eurValue = num(r.get('Valor'));
        group.forEach((p) => {
          const kv = nativeTotal && nativeTotal.value ? eurValue / nativeTotal.value : 1;
          const kc = nativeTotal && nativeTotal.cost ? eurCost / nativeTotal.cost : 1;
          p.value_eur = round2(p.value * kv); p.cost_eur = round2(p.cost_tot * kc);
        });
        group = []; nativeTotal = null;
      }
    }
    if (r.kind === 'Data' && r.get('DataDiscriminator') === 'Summary') {
      const sym = r.get('Símbolo'), ins = instruments[sym] || {};
      const cost = num(r.get('Base de coste')), value = num(r.get('Valor'));
      positions.push({
        sym: ins.underlying || sym, name: titleCase(ins.name || sym), isin: ins.isin || '', qty: num(r.get('Cantidad')), cur: r.get('Divisa'),
        cost_u: round2(num(r.get('Precio de coste'))), cost_tot: round2(cost), price: round4(num(r.get('Precio de cierre'))), value: round2(value),
        pl_eur: round2(unrealEur[sym] != null ? unrealEur[sym] : 0), ret_pct: cost ? round2((value - cost) / cost * 100) : 0,
      });
      group.push(positions[positions.length - 1]);
    } else if (r.kind === 'Total' && r.get('Divisa') === 'EUR') {
      // La última fila «Total … EUR» es el total general en euros.
      stocksTotal.cost = num(r.get('Base de coste')); stocksTotal.value = num(r.get('Valor')); stocksTotal.pl = num(r.get('PyG no realizadas'));
    }
  }));

  // --- efectivo final por divisa ---
  const cash = {};
  of('Informe de efectivo').forEach((b) => b.rows.forEach((r) => {
    if (r.kind === 'Data' && r.values[0] === 'Efectivo final' && /^[A-Z]{3}$/.test(r.values[1])) cash[r.values[1]] = round2(num(r.values[2]));
  }));
  let salesTax = 0;
  of('Informe de efectivo').forEach((b) => b.rows.forEach((r) => {
    if (r.kind === 'Data' && r.values[0] === 'Impuesto de ventas' && r.values[1] === 'Resumen de la divisa base') salesTax = num(r.values[2]);
  }));
  if (!salesTax && change['Impuesto de ventas']) salesTax = change['Impuesto de ventas'];

  // --- operaciones ---
  const trades = [], fxFees = [];
  of('Operaciones').forEach((b) => {
    const isStock = b.header.includes('PyG realizadas');
    let pending = [];
    const closeGroup = (eurRow, nativeRow) => {
      // Convierte comisión y resultado a euros con la proporción de los totales del propio informe.
      const feeRate = nativeRow && num(nativeRow.get('Tarifa/com.')) ? num(eurRow.get('Tarifa/com.')) / num(nativeRow.get('Tarifa/com.')) : null;
      const plRate = nativeRow && num(nativeRow.get('PyG realizadas')) ? num(eurRow.get('PyG realizadas')) / num(nativeRow.get('PyG realizadas')) : null;
      const anyRate = nativeRow && num(nativeRow.get('Productos')) ? num(eurRow.get('Productos')) / num(nativeRow.get('Productos')) : null;
      pending.forEach((t) => {
        t.proceeds_eur = t.cur === 'EUR' ? t.proceeds : (anyRate != null ? t.proceeds * anyRate : null);
        t.fee_eur = t.cur === 'EUR' ? t.fee : t.fee * (feeRate != null ? feeRate : (anyRate || 0));
        t.realized_eur = t.cur === 'EUR' ? t.realized : t.realized * (plRate != null ? plRate : (anyRate || 0));
        trades.push(t);
      });
      pending = [];
    };
    let lastNativeTotal = null;
    b.rows.forEach((r) => {
      const cat = r.get('Categoría de activo');
      if (r.kind === 'Data' && r.get('DataDiscriminator') === 'Order') {
        const [d, t] = r.get('Fecha/Hora').split(',').map((x) => x.trim());
        if (isStock && cat === 'Acciones') {
          const sym = r.get('Símbolo');
          pending.push({
            date: d, time: t || '', symbol: sym, id: idOf(sym), cur: r.get('Divisa'), qty: num(r.get('Cantidad')), price: num(r.get('Precio trans.')),
            proceeds: num(r.get('Productos')), fee: num(r.get('Tarifa/com.')), realized: num(r.get('PyG realizadas')), code: r.get('Código'),
          });
        } else if (cat === 'Fórex') {
          const fee = num(r.get('Com. entrante EUR'));
          if (fee) fxFees.push({ date: d, time: t || '', symbol: r.get('Símbolo'), qty: num(r.get('Cantidad')), price: num(r.get('Precio trans.')), fee_eur: fee });
        }
      } else if (r.kind === 'Total' && isStock && cat === 'Acciones') {
        if (r.get('Divisa') === 'EUR' && lastNativeTotal) { closeGroup(r, lastNativeTotal); lastNativeTotal = null; }
        else if (r.get('Divisa') === 'EUR') { closeGroup(r, null); }
        else lastNativeTotal = r;
      }
    });
    if (pending.length) closeGroup({ get: () => '0' }, null);
  });

  // --- apuntes con fecha y divisa, con su total en euros por bloque de divisa ---
  function datedRows(section) {
    const out = [];
    of(section).forEach((b) => {
      let group = [];
      const flush = (eurTotal) => {
        const native = group.reduce((a, x) => a + x.amount, 0);
        group.forEach((x) => { x.eur = x.cur === 'EUR' ? x.amount : (eurTotal != null && native ? x.amount * eurTotal / native : null); out.push(x); });
        group = [];
      };
      b.rows.forEach((r) => {
        if (r.kind !== 'Data') return;
        const first = r.values[0];
        if (/^[A-Z]{3}$/.test(first)) {
          if (group.length && group[0].cur !== first) flush(null);
          group.push({ cur: first, date: r.get('Fecha') || r.get('Fecha de liquidación'), desc: r.get('Descripción'), amount: num(r.get('Cantidad')) });
        } else if (first === 'Total en EUR') flush(num(r.get('Cantidad')));
      });
      flush(null);
    });
    return out;
  }
  const dividends = datedRows('Dividendos'), withholding = datedRows('Retención de impuestos'), deposits = datedRows('Depósitos y retiradas');
  const fees = [];
  of('Tarifas').forEach((b) => b.rows.forEach((r) => {
    if (r.kind !== 'Data' || !/^[A-Z]{3}$/.test(r.get('Divisa'))) return;
    fees.push({ cur: r.get('Divisa'), date: r.get('Fecha'), desc: r.get('Descripción'), amount: num(r.get('Cantidad')) });
  }));
  const actions = [];
  of('Acciones corporativas').forEach((b) => b.rows.forEach((r) => {
    if (r.kind === 'Data' && r.get('Descripción')) actions.push({ date: r.get('Fecha del informe'), desc: r.get('Descripción') });
  }));
  // Nombre e ISIN de cada dividendo: «MLI(US6247561029) Dividendo en efectivo…»
  const tag = (x) => {
    const m = /^(.+?)\(([A-Z0-9]{12})\)/.exec(x.desc);
    x.isin = m ? m[2] : '';
    x.symbol = m ? m[1].trim() : '';
    return x;
  };
  dividends.forEach(tag); withholding.forEach(tag);

  const missingEur = dividends.concat(withholding, deposits).filter((x) => x.eur == null);
  if (missingEur.length) throw new UserError(`El informe de IBKR trae importes en ${missingEur[0].cur} sin su total en euros; no se puede importar.`);
  const nonEurFees = fees.filter((f) => f.cur !== 'EUR');
  if (nonEurFees.length) throw new UserError(`El informe de IBKR trae comisiones en ${nonEurFees[0].cur}; la aplicación solo sabe leerlas en EUR.`);

  const statement = {
    file: fileName || '', account: acct.Cuenta, broker: st.BrokerName || 'Interactive Brokers', start, end,
    generated: (st.WhenGenerated || '').slice(0, 10),
    twr_pct: twr == null ? null : round2(twr),
    nav_start: round2(nav.start), nav_end: round2(nav.end), cash_end: round2(nav.cash), stocks_end: round2(nav.stocks),
    cash, positions, instruments,
    stocks_cost: round2(stocksTotal.cost), stocks_value: round2(stocksTotal.value), stocks_pl: round2(stocksTotal.pl),
    sales_tax: salesTax, commissions: change.Comisiones || 0,
  };
  const events = {
    trades: keyed(trades, (t) => `${t.id}|${t.date} ${t.time}|${t.qty}|${t.price}`),
    fxFees: keyed(fxFees, (t) => `${t.symbol}|${t.date} ${t.time}|${t.qty}|${t.price}`),
    deposits: keyed(deposits, (x) => `${x.date}|${x.cur}|${x.amount}|${x.desc}`),
    dividends: keyed(dividends, (x) => `${x.date}|${x.cur}|${x.amount}|${x.isin || x.desc}`),
    withholding: keyed(withholding, (x) => `${x.date}|${x.cur}|${x.amount}|${x.isin || x.desc}`),
    fees: keyed(fees, (x) => `${x.date}|${x.cur}|${x.amount}|${x.desc}`),
    actions: keyed(actions, (x) => `${x.date}|${x.desc}`),
  };
  // Comprobación interna: las comisiones reconstruidas deben coincidir con las que declara el informe.
  const rebuilt = events.trades.reduce((a, t) => a + t.fee_eur, 0) + events.fxFees.reduce((a, t) => a + t.fee_eur, 0);
  statement.commissions_ok = Math.abs(rebuilt - statement.commissions) <= 0.02;
  return { statement, events };
}

const EVENT_KINDS = ['trades', 'fxFees', 'deposits', 'dividends', 'withholding', 'fees', 'actions'];
function emptyLedger() {
  const events = {}; EVENT_KINDS.forEach((k) => { events[k] = []; });
  return { version: 1, statements: [], events };
}

/** Une un informe al libro. Devuelve { ledger, added, duplicates, replaced }. */
function mergeIbkr(ledger, parsed) {
  const out = JSON.parse(JSON.stringify(ledger && ledger.statements ? ledger : emptyLedger()));
  EVENT_KINDS.forEach((k) => { if (!out.events[k]) out.events[k] = []; });
  if (out.statements.length && out.statements[0].account !== parsed.statement.account) {
    throw new UserError(`Este informe es de la cuenta ${parsed.statement.account}, y los que ya había son de la cuenta ${out.statements[0].account}.`);
  }
  let added = 0, duplicates = 0;
  const src = `${parsed.statement.start}|${parsed.statement.end}`;
  EVENT_KINDS.forEach((k) => {
    const have = new Map(out.events[k].map((e, i) => [e.key, i]));
    parsed.events[k].forEach((e) => {
      const item = Object.assign({}, e, { src });
      if (have.has(e.key)) {
        duplicates++;
        // Mismo apunte en dos informes: se queda siempre la versión del informe más antiguo,
        // para que el resultado no dependa del orden en que se importen.
        const i = have.get(e.key);
        if (src < (out.events[k][i].src || '')) out.events[k][i] = item;
      } else { have.set(e.key, out.events[k].length); out.events[k].push(item); added++; }
    });
    out.events[k].sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`) || a.key.localeCompare(b.key));
  });
  const same = out.statements.findIndex((s) => s.start === parsed.statement.start && s.end === parsed.statement.end);
  const replaced = same >= 0;
  // «changed»: el informe aporta algo (es nuevo, o es otra versión del mismo periodo con cifras distintas).
  const body = (s) => JSON.stringify(Object.assign({}, s, { file: '' }));
  const changed = !replaced || body(out.statements[same]) !== body(parsed.statement);
  if (replaced) out.statements[same] = Object.assign({}, parsed.statement, changed ? {} : { file: out.statements[same].file });
  else out.statements.push(parsed.statement);
  out.statements.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  return { ledger: out, added, duplicates, replaced, changed };
}

/** Tramos de fechas sin cubrir entre el primer informe y el último. */
function coverageGaps(statements) {
  const gaps = [];
  const sorted = statements.slice().sort((a, b) => a.start.localeCompare(b.start));
  let reach = null;
  sorted.forEach((s) => {
    if (reach != null && isoToMs(s.start) > isoToMs(reach) + DAY_MS) {
      gaps.push({ from: new Date(isoToMs(reach) + DAY_MS).toISOString().slice(0, 10), to: new Date(isoToMs(s.start) - DAY_MS).toISOString().slice(0, 10) });
    }
    if (reach == null || s.end > reach) reach = s.end;
  });
  return gaps;
}

/** Reconstruye el bloque `ibkr` del panel y sus filas de dividendos. */
function deriveIbkr(ledger) {
  const sts = ledger.statements;
  if (!sts.length) return null;
  const first = sts.reduce((a, s) => (s.start < a.start ? s : a), sts[0]);
  const last = sts.reduce((a, s) => (s.end > a.end || (s.end === a.end && s.generated > a.generated) ? s : a), sts[0]);
  const ev = ledger.events;
  const warnings = [];

  const contributionEvents = ev.deposits.map((d) => [d.date, round2(d.eur)]);
  // Si el primer informe no arranca con la cuenta vacía, lo que ya había cuenta como aportación inicial.
  if (first.nav_start > 0.005) {
    contributionEvents.unshift([first.start, first.nav_start]);
    warnings.push(`El primer informe de IBKR (desde ${first.start}) no empieza con la cuenta vacía: los ${first.nav_start} € que ya había se cuentan como aportación inicial. Importa los informes anteriores para tener el histórico completo.`);
  }
  contributionEvents.sort((a, b) => a[0].localeCompare(b[0]));
  const contributions = round2(contributionEvents.reduce((a, e) => a + e[1], 0));

  const divGross = ev.dividends.reduce((a, d) => a + d.eur, 0);
  const divTax = ev.withholding.reduce((a, d) => a + d.eur, 0);
  const tradeFees = ev.trades.reduce((a, t) => a + t.fee_eur, 0) + ev.fxFees.reduce((a, t) => a + t.fee_eur, 0);
  const otherFees = ev.fees.reduce((a, f) => a + f.amount, 0) + sts.reduce((a, s) => a + (s.sales_tax || 0), 0);
  const realized = ev.trades.reduce((a, t) => a + t.realized_eur, 0);

  // Nombre legible de cada valor, a partir de la información de instrumentos de cualquier informe.
  const byIsin = {};
  sts.forEach((s) => Object.keys(s.instruments || {}).forEach((sym) => { const i = s.instruments[sym]; if (i.isin) byIsin[i.isin] = i; }));
  const rows = new Map();
  const rowFor = (x) => {
    const k = x.isin || x.symbol || x.desc;
    if (!rows.has(k)) {
      const ins = byIsin[x.isin];
      rows.set(k, { account: 'IBKR', name: ins ? `${ins.underlying} · ${titleCase(ins.name)}` : (x.symbol || x.desc), isin: x.isin, cur: x.cur, gross_native: 0, gross_eur: 0, tax_eur: 0, approx: false });
    }
    return rows.get(k);
  };
  ev.dividends.forEach((d) => { const r = rowFor(d); r.gross_native += d.amount; r.gross_eur += d.eur; });
  ev.withholding.forEach((d) => { const r = rowFor(d); r.tax_eur += d.eur; });
  const dividendRows = Array.from(rows.values()).map((r) => Object.assign(r, { gross_native: round2(r.gross_native), gross_eur: round2(r.gross_eur), tax_eur: round2(r.tax_eur) })).filter((r) => r.gross_eur > 0);

  const gaps = coverageGaps(sts);
  gaps.forEach((g) => warnings.push(`Falta el informe de IBKR del ${g.from} al ${g.to}: los movimientos de esas fechas no están contados.`));
  sts.forEach((s) => { if (s.commissions_ok === false) warnings.push(`En el informe de IBKR ${s.start} – ${s.end} las comisiones reconstruidas no coinciden con las que declara el propio informe.`); });

  const ibkr = {
    account: last.account, broker: last.broker,
    period_start: first.start, period_end: last.end, statement_generated: last.generated,
    nav_initial: first.nav_start, nav_final: last.nav_end,
    cash_final: last.cash_end, cash_by_cur: last.cash,
    accrued_div: round2(last.nav_end - last.cash_end - last.stocks_end),
    contributions, contribution_events: contributionEvents,
    result: round2(last.nav_end - contributions),
    realized_pl: round2(realized),
    div_gross: round2(divGross), div_tax: round2(divTax), div_net: round2(divGross + divTax),
    fees: round2(tradeFees + otherFees),
    stocks_cost: last.stocks_cost, stocks_value: last.stocks_value, stocks_pl: last.stocks_pl,
    positions: last.positions,
    statements: sts.map((s) => ({ start: s.start, end: s.end, generated: s.generated, twr_pct: s.twr_pct, file: s.file })),
    coverage_gaps: gaps,
    corporate_actions: ev.actions.map((a) => ({ date: a.date, desc: a.desc })),
  };
  return { ibkr, dividendRows, warnings };
}

module.exports = { looksLikeIbkr, parseIbkrCsv, mergeIbkr, deriveIbkr, coverageGaps, emptyLedger, EVENT_KINDS };
