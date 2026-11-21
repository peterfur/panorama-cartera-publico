'use strict';
/*
 * DEGIRO: lectura del extracto de cuenta en CSV, libro de movimientos sin
 * repetidos y reconstrucción de toda la parte de DEGIRO a partir de ese libro.
 *
 * Idea central: el libro (data/degiro-movimientos.csv) es la unión de todos
 * los extractos que se han importado. Importar otra vez el mismo extracto, o
 * uno cuyas fechas se solapan con otro anterior, no cambia nada: cada fila se
 * reconoce por su fecha, hora, importe, saldo e identificador de orden.
 * Todas las cifras de DEGIRO se recalculan SIEMPRE desde el libro completo.
 */

const { parseCsv, toCsv } = require('./csv');
const { UserError, round2, round4, isoToMs, isoToDmy, dateLabels, quarterOf, DAY_MS } = require('./calc');

const HEADER = ['Fecha', 'Hora', 'Fecha valor', 'Producto', 'ISIN', 'Descripción', 'Tipo', 'Variación', '', 'Saldo', '', 'ID Orden'];
// Índices de columna
const C = { date: 0, time: 1, vdate: 2, product: 3, isin: 4, desc: 5, fx: 6, cur: 7, amount: 8, balCur: 9, balance: 10, order: 11 };

const TRADE_RE = /^(Compra|Venta) ([\d.,]+) (.+)@([\d.,]+) ([A-Z]{3}) \(([A-Z0-9]{12})\)$/;
const DEPOSITS = new Set(['flatex Deposit', 'Flatex Instant Deposit', 'Reservation iDEAL']);
const WITHDRAWALS = new Set(['flatex Withdrawal', 'Processed Flatex Withdrawal']);
const INTEREST = new Set(['Interés', 'Flatex Interest Income']);
const TRADE_FEE = 'Costes de transacción y/o externos de DEGIRO';

/* ---------- utilidades ---------- */

/** "1.234,56" -> 1234.56 ; "" -> null */
function esNum(s) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}
/** DD-MM-AAAA -> AAAA-MM-DD */
function dmyToIso(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
/** Como str.title() de Python: mayúscula tras cualquier carácter que no sea letra. */
function titleCase(s) {
  let out = '', prevLetter = false;
  for (const ch of String(s)) {
    const isLetter = ch.toLowerCase() !== ch.toUpperCase();
    out += isLetter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevLetter = isLetter;
  }
  return out;
}
function groupKey(r) { return `${dmyToIso(r[C.date])} ${r[C.time]}`; }

/**
 * Huella de una fila. No incluye el nombre del producto ni el ISIN (DEGIRO los
 * cambia cuando una empresa cambia de nombre), pero sí todo lo que identifica
 * el apunte: fechas, hora, importe, saldo resultante y orden.
 */
function fingerprint(r) {
  const m = TRADE_RE.exec(r[C.desc]);
  const kind = m ? `${m[1]}|${m[2]}|${m[4]}|${m[5]}` : r[C.desc];
  return [r[C.date], r[C.time], r[C.vdate], kind, r[C.fx], r[C.cur], r[C.amount], r[C.balCur], r[C.balance], r[C.order]].join('\u001f');
}

/* ---------- lectura ---------- */

function looksLikeDegiro(text) {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
  return /^Fecha,Hora,Fecha valor,Producto,ISIN,/.test(first);
}

/** Devuelve las filas (12 columnas, de la más reciente a la más antigua, como las exporta DEGIRO). */
function parseDegiroCsv(text) {
  const all = parseCsv(text);
  if (!all.length || all[0][0] !== 'Fecha' || all[0][1] !== 'Hora' || all[0][5] !== 'Descripción') {
    throw new UserError('No parece un «Estado de cuenta» de DEGIRO en CSV (en DEGIRO: Actividad → Estado de cuenta → Exportar → CSV, con la web en español).');
  }
  const rows = [];
  for (let i = 1; i < all.length; i++) {
    const r = all[i].map((x) => String(x).trim());
    if (r.length === 1 && r[0] === '') continue;
    while (r.length < 12) r.push('');
    if (!r[C.date]) {
      // Fila de continuación: la descripción era demasiado larga y DEGIRO la partió en dos.
      if (!rows.length) throw new UserError('El archivo empieza con una fila incompleta.');
      rows[rows.length - 1][C.desc] += ' ' + r[C.desc];
      continue;
    }
    if (!dmyToIso(r[C.date]) || !/^\d{2}:\d{2}$/.test(r[C.time])) throw new UserError(`Fila ${i + 1}: fecha u hora no reconocidas («${r[C.date]} ${r[C.time]}»).`);
    rows.push(r.slice(0, 12));
  }
  if (!rows.length) throw new UserError('El extracto no contiene movimientos.');
  return rows;
}

function serializeLedger(rows) { return toCsv([HEADER].concat(rows)); }
function parseLedger(text) { return text && text.trim() ? parseDegiroCsv(text) : []; }

/**
 * Une un extracto al libro sin repetir filas.
 * Devuelve { rows, added, duplicates, addedRows }.
 */
function mergeLedger(existing, incoming) {
  const groups = new Map();
  const add = (map, r) => { const k = groupKey(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); };
  existing.forEach((r) => add(groups, r));
  const incomingGroups = new Map();
  incoming.forEach((r) => add(incomingGroups, r));

  let added = 0, duplicates = 0;
  const addedRows = [];
  incomingGroups.forEach((rows, key) => {
    if (!groups.has(key)) {
      groups.set(key, rows.slice());
      added += rows.length; addedRows.push(...rows);
      return;
    }
    // Mismo minuto ya presente: se comparan fila a fila (por si hubiera apuntes idénticos legítimos).
    const have = groups.get(key);
    const counts = new Map();
    have.forEach((r) => { const f = fingerprint(r); counts.set(f, (counts.get(f) || 0) + 1); });
    rows.forEach((r) => {
      const f = fingerprint(r);
      const left = counts.get(f) || 0;
      if (left > 0) { counts.set(f, left - 1); duplicates++; }
      else { have.push(r); added++; addedRows.push(r); }
    });
  });
  const keys = Array.from(groups.keys()).sort().reverse();
  const rows = [];
  keys.forEach((k) => rows.push(...groups.get(k)));
  return { rows, added, duplicates, addedRows };
}

/* ---------- reconstrucción ---------- */

/**
 * Recalcula toda la parte de DEGIRO desde el libro.
 * `prev` son los datos actuales (para conservar los precios de mercado guardados).
 */
function deriveDegiro(ledgerRows, prev) {
  const rows = ledgerRows.slice().reverse(); // cronológico
  const warnings = [];
  const unknown = [];

  // --- órdenes: todas las filas que comparten identificador ---
  const orders = new Map();
  rows.forEach((r) => {
    if (!r[C.order]) return;
    if (!orders.has(r[C.order])) orders.set(r[C.order], []);
    orders.get(r[C.order]).push(r);
  });

  const positions = new Map();   // isin -> posición abierta
  const realized = new Map();    // isin -> { name, isin, pl }
  const episodes = [];
  const quarters = new Map();
  const fees = { trade: 0, market_conn: 0, adr: 0, trustly: 0, fr_tax: 0, other: 0 };
  const lastRate = {};           // divisa -> último tipo de cambio visto
  const pendingFx = {};          // divisa -> partidas de dividendos pendientes de convertir
  const dividends = new Map();   // isin -> fila de dividendos
  const cashflows = [];
  const monthly = new Map();
  let depositsGross = 0, withdrawals = 0, promo = 0, interest = 0, secLending = 0;
  let nTradeRows = 0;
  const tradeLog = [];           // una entrada por orden ejecutada, para el informe e IRPF
  const dividendEvents = [];     // apuntes fechados de dividendos/retenciones en EUR (para IRPF)
  const interestEvents = [];     // apuntes fechados de intereses y préstamo de valores (para IRPF)

  const quarter = (iso) => {
    const k = quarterOf(iso);
    if (!quarters.has(k)) quarters.set(k, { quarter: k, n_trades: 0, n_buys: 0, n_sells: 0, tickers: 0, capital: 0, avg_buy_size: 0, isins: new Set() });
    return quarters.get(k);
  };
  const divRow = (r) => {
    const key = r[C.isin] || r[C.product];
    if (!dividends.has(key)) dividends.set(key, { account: 'DEGIRO', name: titleCase(r[C.product]), isin: r[C.isin], cur: r[C.cur], gross_native: 0, gross_eur: 0, tax_eur: 0, estimated: false });
    const d = dividends.get(key);
    d.name = titleCase(r[C.product]);
    return d;
  };
  const settle = (cur, rate, estimated) => {
    (pendingFx[cur] || []).forEach((p) => { p.apply(p.amount / rate, !!estimated); if (estimated && p.row) p.row.estimated = true; });
    pendingFx[cur] = [];
  };
  const defer = (cur, amount, apply, row) => { (pendingFx[cur] = pendingFx[cur] || []).push({ amount, apply, row }); };

  function processOrder(id) {
    const group = orders.get(id);
    const trades = group.filter((r) => TRADE_RE.test(r[C.desc]));
    if (!trades.length) { group.forEach(processPlainRow); return; }
    const first = TRADE_RE.exec(trades[0][C.desc]);
    const side = first[1], isin = first[6], tradeCur = first[5];
    const iso = dmyToIso(trades[0][C.date]);
    let qty = 0, native = 0, eur = 0, fee = 0, hasEurLeg = false, lastPrice = null;
    trades.forEach((r) => {
      const m = TRADE_RE.exec(r[C.desc]);
      let q = esNum(m[2]), p = esNum(m[4]);
      const amt = Math.abs(esNum(r[C.amount]));
      // "1.230" puede ser 1230 o 1,23: se decide con el importe de la propia fila.
      if (Math.abs(q * p - amt) > Math.max(0.02, amt * 0.002)) {
        const q2 = parseFloat(m[2].replace(',', '.')), p2 = parseFloat(m[4].replace(',', '.'));
        if (Math.abs(q2 * p - amt) <= Math.max(0.02, amt * 0.002)) q = q2;
        else if (Math.abs(q * p2 - amt) <= Math.max(0.02, amt * 0.002)) p = p2;
        else if (Math.abs(q2 * p2 - amt) <= Math.max(0.02, amt * 0.002)) { q = q2; p = p2; }
      }
      qty += q; native += amt; lastPrice = p; nTradeRows++;
      if (r[C.cur] === 'EUR') { eur += esNum(r[C.amount]); hasEurLeg = true; }
    });
    group.forEach((r) => {
      if (TRADE_RE.test(r[C.desc])) return;
      const amt = esNum(r[C.amount]) || 0;
      if (r[C.desc] === TRADE_FEE) fee += amt;
      else if (/Cambio de Divisa$/.test(r[C.desc])) {
        if (r[C.cur] === 'EUR') { eur += amt; hasEurLeg = true; }
        const rate = esNum(r[C.fx]); if (rate && r[C.cur] !== 'EUR') lastRate[r[C.cur]] = rate;
      } else processPlainRow(r);
    });
    if (!hasEurLeg) {
      const rate = lastRate[tradeCur];
      if (!rate) throw new UserError(`La operación del ${dateLabels(iso).short} en ${tradeCur} no trae su conversión a euros y no hay ningún tipo de cambio anterior de esa divisa.`);
      eur = (side === 'Compra' ? -1 : 1) * native / rate;
      warnings.push(`Operación del ${dateLabels(iso).short} (${trades[0][C.product]}) sin conversión a euros en el extracto: importe estimado con el último tipo de cambio.`);
    }
    fee = Math.abs(fee);
    fees.trade -= fee;
    const q = quarter(iso);
    q.isins.add(isin);
    const name = titleCase(trades[0][C.product]);

    // Una posición es un valor en una línea de cotización concreta: el mismo ISIN
    // comprado en euros y en dólares son dos posiciones distintas, como en DEGIRO.
    const key = `${isin}:${tradeCur}`;
    let p = positions.get(key);
    if (side === 'Compra') {
      if (!p) { p = { id: key, name, isin, qty: 0, cost: 0, opened: iso, episodePl: 0 }; positions.set(key, p); }
      p.name = name;
      p.qty = round4(p.qty + qty);
      p.cost += -eur + fee;
      p.last = { price: lastPrice, cur: tradeCur, iso };
      tradeLog.push({ date: iso, time: trades[0][C.time] || '', side: 'compra', name, isin, qty: round4(qty), price: round4(native / qty), cur: tradeCur, eur: round2(-eur), fee: round2(fee) });
      q.n_buys += trades.length; q.capital += -eur + fee;
    } else {
      if (!p || qty > p.qty + 1e-6) {
        throw new UserError(`El extracto contiene una venta de ${trades[0][C.product]} el ${dateLabels(iso).short} sin sus compras anteriores: falta un extracto de fechas previas.`);
      }
      const full = Math.abs(qty - p.qty) < 1e-6;
      const costRemoved = full ? p.cost : p.cost * qty / p.qty;
      const pl = eur - fee - costRemoved;
      if (!realized.has(isin)) realized.set(isin, { name, isin, pl: 0 });
      const rz = realized.get(isin); rz.pl += pl; rz.name = name;
      p.episodePl += pl;
      tradeLog.push({ date: iso, time: trades[0][C.time] || '', side: 'venta', name, isin, qty: round4(qty), price: round4(native / qty), cur: tradeCur, eur: round2(eur), fee: round2(fee), pl: round2(pl) });
      q.n_sells += trades.length;
      if (full) {
        episodes.push({
          isin, name: trades[0][C.product], open: p.opened + 'T00:00:00', close: iso + 'T00:00:00',
          holding_days: Math.round((isoToMs(iso) - isoToMs(p.opened)) / DAY_MS), pnl: round2(p.episodePl),
        });
        positions.delete(key);
      } else {
        p.qty = round4(p.qty - qty);
        p.cost -= costRemoved;
        p.last = { price: lastPrice, cur: tradeCur, iso };
      }
    }
  }

  function processPlainRow(r) {
    const desc = r[C.desc], cur = r[C.cur], iso = dmyToIso(r[C.date]);
    const amt = esNum(r[C.amount]) || 0;
    if (desc === 'Degiro Cash Sweep Transfer' || /^Transferir (desde|a) su Cuenta de Efectivo/.test(desc)) return; // traspasos internos
    if (/Cambio de Divisa$/.test(desc)) {
      const rate = esNum(r[C.fx]);
      if (rate && cur !== 'EUR') { lastRate[cur] = rate; settle(cur, rate); }
      return;
    }
    if (DEPOSITS.has(desc) || WITHDRAWALS.has(desc)) {
      if (cur !== 'EUR') { unknown.push(r); return; }
      if (DEPOSITS.has(desc)) depositsGross += amt; else withdrawals += amt;
      cashflows.push([iso, round2(-amt)]);
      const mk = iso.slice(0, 7);
      monthly.set(mk, (monthly.get(mk) || 0) + amt);
      return;
    }
    if (/^Promoción DEGIRO/.test(desc)) { promo += amt; cashflows.push([iso, round2(-amt)]); return; }
    if (INTEREST.has(desc)) { interest += amt; interestEvents.push({ date: iso, account: 'DEGIRO', kind: 'interest', amount_eur: round2(amt) }); return; }
    if (/^Ingresos por Préstamo de Valores/.test(desc)) { secLending += amt; interestEvents.push({ date: iso, account: 'DEGIRO', kind: 'sec_lending', amount_eur: round2(amt) }); return; }
    if (/^Comisión de conectividad con el mercado/.test(desc)) { fees.market_conn += amt; return; }
    if (/^Comisión por transferencia Trustly/.test(desc)) { fees.trustly += amt; return; }
    if (desc === 'Impuesto de transacción Francés') { fees.fr_tax += amt; return; }
    if (desc === 'Dividendo' || desc === 'Retención del dividendo' || desc === 'ADR/GDR Pass-Through Fee') {
      const d = divRow(r);
      const apply = (eur, est) => {
        if (desc === 'Dividendo') {
          d.gross_eur += eur;
          dividendEvents.push({ date: iso, account: 'DEGIRO', name: d.name, isin: d.isin, cur, gross_eur: round2(eur), tax_eur: 0, approx: !!est });
        } else if (desc === 'Retención del dividendo') {
          d.tax_eur += eur;
          dividendEvents.push({ date: iso, account: 'DEGIRO', name: d.name, isin: d.isin, cur, gross_eur: 0, tax_eur: round2(eur), approx: !!est });
        } else fees.adr += eur;
      };
      if (desc === 'Dividendo') d.gross_native += amt;
      if (cur === 'EUR') apply(amt, false); else defer(cur, amt, apply, d);
      return;
    }
    if (desc === TRADE_FEE) { fees.trade += amt; return; }
    unknown.push(r);
  }

  const done = new Set();
  rows.forEach((r) => {
    const id = r[C.order];
    if (id) { if (!done.has(id)) { done.add(id); processOrder(id); } return; }
    processPlainRow(r);
  });

  // Dividendos en divisa todavía sin convertir a euros en el extracto: se estiman.
  Object.keys(pendingFx).forEach((cur) => {
    if (!pendingFx[cur].length) return;
    const rate = lastRate[cur] || (prev && prev.live_meta && prev.live_meta.fx && prev.live_meta.fx[cur]);
    if (!rate) { warnings.push(`Hay importes en ${cur} sin convertir y sin tipo de cambio conocido: no se han contado.`); return; }
    warnings.push(`Hay ${pendingFx[cur].length === 1 ? 'un importe' : pendingFx[cur].length + ' importes'} en ${cur} que DEGIRO aún no ha convertido a euros: se han estimado con el último tipo de cambio (1 EUR = ${String(rate).replace('.', ',')} ${cur}).`);
    settle(cur, rate, true);
  });
  if (unknown.length) {
    const kinds = Array.from(new Set(unknown.map((r) => r[C.desc]))).slice(0, 5).join('; ');
    warnings.push(`${unknown.length} ${unknown.length === 1 ? 'movimiento de un tipo desconocido no se ha contado' : 'movimientos de tipos desconocidos no se han contado'}: ${kinds}.`);
  }

  // --- salida con la misma forma que usa el panel ---
  const prevPos = new Map();
  ((prev && prev.degiro_open_positions) || []).forEach((p) => { prevPos.set(p.id || p.isin, p); if (!prevPos.has(p.isin)) prevPos.set(p.isin, p); });
  const open = Array.from(positions.values()).map((p) => {
    const old = prevPos.get(p.id) || prevPos.get(p.isin);
    const out = {
      id: p.id, name: p.name, isin: p.isin, qty: p.qty, cost_total: round2(p.cost), cost_avg: round4(p.cost / p.qty),
      last_price: p.last.price, last_price_cur: p.last.cur, last_price_date: isoToDmy(p.last.iso),
    };
    if (old && old.live_price != null) {
      out.live_price = old.live_price; out.live_price_cur = old.live_price_cur; out.live_src = old.live_src;
    } else {
      out.live_price = p.last.price; out.live_price_cur = p.last.cur;
      out.live_src = `Precio de la última operación (${dateLabels(p.last.iso).short})`;
    }
    out.opened = p.opened;
    out.episode_realized = round2(p.episodePl);
    return out;
  }).sort((a, b) => b.cost_total - a.cost_total);

  const quarterly = Array.from(quarters.values()).sort((a, b) => a.quarter.localeCompare(b.quarter)).map((q) => ({
    quarter: q.quarter, n_trades: q.n_buys + q.n_sells, n_buys: q.n_buys, n_sells: q.n_sells, tickers: q.isins.size,
    capital: round2(q.capital), avg_buy_size: q.n_buys ? round2(q.capital / q.n_buys) : 0, isins: Array.from(q.isins).sort(),
  }));

  const divList = Array.from(dividends.values()).map((d) => ({
    account: 'DEGIRO', name: d.name, isin: d.isin, cur: d.cur, gross_native: round2(d.gross_native),
    gross_eur: round2(d.gross_eur), tax_eur: round2(d.tax_eur), approx: !!d.estimated,
  })).filter((d) => d.gross_eur > 0);

  const lastEur = ledgerRows.find((r) => r[C.balCur] === 'EUR' && r[C.balance] !== '');
  const dates = ledgerRows.map((r) => dmyToIso(r[C.date])).sort();
  const breakdown = {};
  Object.keys(fees).forEach((k) => { if (k !== 'other' || fees[k]) breakdown[k] = round2(fees[k]); });

  return {
    warnings, unknownCount: unknown.length, tradeRows: nTradeRows, lastRates: lastRate, trades: tradeLog,
    dividendEvents, interestEvents,
    positions: open,
    realized: Array.from(realized.values()).map((r) => ({ name: r.name, isin: r.isin, pl: round2(r.pl) })),
    dividends: divList,
    cashflows: cashflows.sort((a, b) => a[0].localeCompare(b[0])),
    monthly: Array.from(monthly.entries()).map(([month, v]) => ({ month, degiro: round2(v) })).sort((a, b) => a.month.localeCompare(b.month)),
    behavior: { quarterly, episodes },
    combined: {
      degiro_deposits_gross: round2(depositsGross),
      degiro_withdrawals: round2(withdrawals),
      degiro_promo: round2(promo),
      degiro_div_gross: round2(divList.reduce((a, d) => a + d.gross_eur, 0)),
      degiro_div_tax: round2(divList.reduce((a, d) => a + d.tax_eur, 0)),
      degiro_fees_breakdown: breakdown,
      degiro_interest: round2(interest),
      degiro_sec_lending: round2(secLending),
      degiro_cash_wallet: lastEur ? esNum(lastEur[C.balance]) : 0,
      degiro_date_min: dates[0],
      degiro_date_max: dates[dates.length - 1],
      degiro_movements_count: ledgerRows.length,
    },
  };
}

/**
 * Continuidad del saldo en euros: cada fila debe partir del saldo que dejó la
 * anterior. Si entre dos extractos falta un tramo de fechas, aquí se ve.
 * Devuelve la lista de saltos [{ after, before, expected, found }].
 */
function balanceGaps(ledgerRows) {
  const rows = ledgerRows.slice().reverse();
  const gaps = [];
  let prev = null, prevRow = null;
  rows.forEach((r) => {
    if (r[C.balCur] !== 'EUR' || r[C.balance] === '') return;
    const bal = esNum(r[C.balance]);
    const isTransfer = /^Transferir (desde|a) su Cuenta de Efectivo/.test(r[C.desc]);
    if (prev != null && !isTransfer) {
      const amt = r[C.cur] === 'EUR' ? (esNum(r[C.amount]) || 0) : 0;
      if (Math.abs(prev + amt - bal) > 0.011) {
        gaps.push({ after: dmyToIso(prevRow[C.date]), before: dmyToIso(r[C.date]), expected: round2(prev + amt), found: bal });
      }
    }
    prev = bal; prevRow = r;
  });
  return gaps;
}

/** Saldo en euros que había justo antes del primer movimiento del libro (0 si el libro arranca al abrir la cuenta). */
function openingBalance(ledgerRows) {
  for (let i = ledgerRows.length - 1; i >= 0; i--) {
    const r = ledgerRows[i];
    if (r[C.balCur] !== 'EUR' || r[C.balance] === '') continue;
    if (/^Transferir (desde|a) su Cuenta de Efectivo/.test(r[C.desc])) return null;
    return round2(esNum(r[C.balance]) - (r[C.cur] === 'EUR' ? (esNum(r[C.amount]) || 0) : 0));
  }
  return null;
}

module.exports = {
  HEADER, C, looksLikeDegiro, openingBalance, parseDegiroCsv, parseLedger, serializeLedger, mergeLedger, deriveDegiro, balanceGaps,
  fingerprint, titleCase, esNum, dmyToIso,
};
