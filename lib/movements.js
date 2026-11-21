'use strict';
/*
 * Registro de movimientos de DEGIRO.
 *
 * Cada función aplica UN movimiento sobre los datos primarios de la cartera
 * (posiciones, dividendos, aportaciones, comisiones...). El recálculo de todo
 * lo derivado lo hace después calc.recomputeDerived().
 *
 * Convenciones heredadas del panel original:
 *  - El coste de una posición incluye las comisiones de compra (coste medio).
 *  - Las comisiones de compraventa van a degiro_fees_breakdown.trade y NO se
 *    restan otra vez en el rendimiento: ya están dentro del coste / resultado.
 *  - Las comisiones que no son de compraventa (conectividad, ADR...) sí se
 *    restan aparte del rendimiento.
 *  - Aportaciones: importe negativo en degiro_cashflow_events = dinero que entra.
 */

const {
  UserError, round2, round4, isIsoDate, isoToMs, isoToDmy, dateLabels, quarterOf, todayIso,
  DAY_MS, FEE_CATEGORIES, recomputeDerived,
} = require('./calc');

const TYPES = {
  compra: 'Compra',
  venta: 'Venta',
  dividendo: 'Dividendo',
  aportacion: 'Aportación',
  retirada: 'Retirada',
  comision: 'Comisión',
  interes: 'Interés',
};

/* ---------- validación ---------- */

function num(v, field, label, opts) {
  opts = opts || {};
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).trim().replace(',', '.'));
  if (!isFinite(n)) throw new UserError(`${label}: falta un número válido.`, field);
  if (opts.positive && !(n > 0)) throw new UserError(`${label}: debe ser mayor que 0.`, field);
  if (opts.nonNegative && n < 0) throw new UserError(`${label}: no puede ser negativo.`, field);
  if (opts.nonZero && n === 0) throw new UserError(`${label}: no puede ser 0.`, field);
  return n;
}
function date(v, field, label) {
  if (v == null || String(v).trim() === '') throw new UserError(`${label}: falta la fecha.`, field);
  if (!isIsoDate(v)) throw new UserError(`${label}: fecha no válida (formato AAAA-MM-DD).`, field);
  if (isoToMs(v) > isoToMs(todayIso()) + DAY_MS) throw new UserError(`${label}: la fecha está en el futuro.`, field);
  if (v < '2000-01-01') throw new UserError(`${label}: fecha demasiado antigua.`, field);
  return v;
}
function text(v, field, label, max) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw new UserError(`${label}: no puede estar vacío.`, field);
  if (s.length > (max || 80)) throw new UserError(`${label}: demasiado largo.`, field);
  return s;
}
function currency(v, field) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) throw new UserError('Divisa: usa el código de 3 letras (EUR, USD, SEK...).', field);
  return s;
}
function isin(v, field) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) throw new UserError('ISIN: debe tener 12 caracteres (p. ej. US02079K3059).', field);
  return s;
}

/* ---------- utilidades sobre los datos ---------- */

/** Busca una posición por su identificador (ISIN:divisa de la línea) o por ISIN + divisa de línea. */
function findPosition(data, ref, cur) {
  const list = data.degiro_open_positions;
  const exact = list.find((p) => p.id && p.id === ref);
  if (exact) return exact;
  if (cur) {
    const byLine = list.find((p) => p.id === `${ref}:${cur}`);
    if (byLine) return byLine;
    return list.find((p) => !p.id && p.isin === ref && p.last_price_cur === cur) || null;
  }
  return list.find((p) => p.isin === ref) || null;
}

function quarterRow(data, iso) {
  const key = quarterOf(iso);
  let q = data.behavior.quarterly.find((x) => x.quarter === key);
  if (!q) {
    // Trimestre nuevo: aquí sí podemos llevar la lista exacta de valores operados.
    q = { quarter: key, n_trades: 0, n_buys: 0, n_sells: 0, tickers: 0, capital: 0, avg_buy_size: 0, isins: [] };
    data.behavior.quarterly.push(q);
  }
  return q;
}
function touchQuarterTicker(q, code) {
  // En los trimestres que venían del extracto original no se guardó qué valores
  // se operaron, así que ahí "tickers" no se puede actualizar con exactitud.
  if (!Array.isArray(q.isins)) return;
  if (!q.isins.includes(code)) { q.isins.push(code); q.tickers = q.isins.length; }
}
function bumpDateMax(data, iso) {
  if (iso > data.combined.degiro_date_max) data.combined.degiro_date_max = iso;
  data.combined.degiro_movements_count = (data.combined.degiro_movements_count || 0) + 1;
}
function addTradeFee(data, fee) {
  if (!fee) return;
  const c = data.combined;
  c.degiro_fees_breakdown.trade = round2(c.degiro_fees_breakdown.trade - fee);
  c.total_fees = round2(c.total_fees - fee);
}
function moveCash(data, amount) {
  data.combined.degiro_cash_wallet = round2(data.combined.degiro_cash_wallet + amount);
}
function monthRow(data, iso) {
  const key = iso.slice(0, 7);
  let m = data.monthly.find((x) => x.month === key);
  if (!m) {
    m = { month: key, ibkr: 0, degiro: 0, cum_ibkr: 0, cum_deg: 0, cum_total: 0 };
    data.monthly.push(m);
  }
  return m;
}
function fmtEur(n) {
  return new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + ' €';
}
function fmtQty(n) { return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 }).format(n); }
function fmtPrice(n, cur) { return new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(n) + ' ' + cur; }

/* ---------- compra ---------- */

function applyCompra(data, m, ctx) {
  const fecha = date(m.fecha, 'fecha', 'Fecha');
  const ref = String(m.isin || '').trim();
  const refParts = ref.includes(':') ? ref.split(':') : null;
  const code = isin(refParts ? refParts[0] : ref, 'isin');
  const qty = num(m.cantidad, 'cantidad', 'Cantidad', { positive: true });
  const price = num(m.precio, 'precio', 'Precio', { positive: true });
  const cur = currency(m.divisa, 'divisa');
  const importe = num(m.importe_eur, 'importe_eur', 'Importe en EUR', { positive: true });
  const fee = num(m.comision_eur == null || m.comision_eur === '' ? 0 : m.comision_eur, 'comision_eur', 'Comisión', { nonNegative: true });
  let p = findPosition(data, refParts ? `${code}:${refParts[1].toUpperCase()}` : code, cur);
  const fx = data.live_meta.fx;

  const isNew = !p;
  if (isNew) {
    const name = text(m.nombre, 'nombre', 'Nombre del valor');
    if (cur !== 'EUR' && !(fx[cur] > 0)) {
      // Divisa nueva en la cartera: tipo de cambio implícito de la propia operación.
      fx[cur] = round4((qty * price) / importe);
    }
    p = {
      id: `${code}:${cur}`, name, isin: code, qty: 0, cost_total: 0, cost_avg: 0,
      last_price: price, last_price_cur: cur, last_price_date: isoToDmy(fecha),
      live_price: price, live_price_cur: cur,
      live_src: `Precio de compra del ${dateLabels(fecha).short}`,
      opened: fecha, episode_realized: 0,
    };
    data.degiro_open_positions.push(p);
    if (ctx && m.av_symbol) {
      const sym = String(m.av_symbol).trim().toUpperCase();
      if (!/^[A-Z0-9.\-]{1,15}$/.test(sym)) throw new UserError('Símbolo de Alpha Vantage no válido.', 'av_symbol');
      const symCur = m.av_cur ? currency(m.av_cur, 'av_cur') : cur;
      if (symCur !== 'EUR' && !(fx[symCur] > 0)) throw new UserError(`No hay tipo de cambio guardado para ${symCur}; deja el símbolo vacío y añádelo después en config.json.`, 'av_cur');
      ctx.newSymbols[code] = { symbol: sym, cur: symCur, label: sym };
    }
  }
  p.qty = round4(p.qty + qty);
  p.cost_total = round2(p.cost_total + importe + fee);
  p.last_price = price; p.last_price_cur = cur; p.last_price_date = isoToDmy(fecha);

  addTradeFee(data, fee);
  moveCash(data, -(importe + fee));
  const q = quarterRow(data, fecha);
  q.n_buys += 1; q.capital = round2(q.capital + importe);
  touchQuarterTicker(q, code);
  bumpDateMax(data, fecha);

  return `Compra de ${fmtQty(qty)} × ${p.name} a ${fmtPrice(price, cur)} (${fmtEur(importe + fee)} con comisión)${isNew ? ' — posición nueva' : ''}`;
}

/* ---------- venta ---------- */

function applyVenta(data, m) {
  const fecha = date(m.fecha, 'fecha', 'Fecha');
  const ref = String(m.isin || '').trim();
  const curHint = typeof m.divisa === 'string' && /^[A-Za-z]{3}$/.test(m.divisa.trim()) ? m.divisa.trim().toUpperCase() : null;
  const p = findPosition(data, ref, curHint) || findPosition(data, ref);
  if (!p) { isin(ref.includes(':') ? ref.split(':')[0] : ref, 'isin'); throw new UserError('No hay ninguna posición abierta con ese ISIN.', 'isin'); }
  const code = p.isin;
  const qty = num(m.cantidad, 'cantidad', 'Cantidad', { positive: true });
  if (qty > p.qty + 1e-9) throw new UserError(`Cantidad: solo tienes ${fmtQty(p.qty)} títulos de ${p.name}.`, 'cantidad');
  const price = num(m.precio, 'precio', 'Precio', { positive: true });
  const cur = currency(m.divisa, 'divisa');
  const importe = num(m.importe_eur, 'importe_eur', 'Importe en EUR', { positive: true });
  const fee = num(m.comision_eur == null || m.comision_eur === '' ? 0 : m.comision_eur, 'comision_eur', 'Comisión', { nonNegative: true });

  const full = Math.abs(qty - p.qty) < 1e-9;
  let opened = p.opened;
  if (full && !opened) {
    // Posiciones que venían del extracto original: no se guardó cuándo se abrieron.
    opened = date(m.fecha_apertura, 'fecha_apertura', 'Fecha de apertura de la posición');
  }
  if (full && opened > fecha) throw new UserError('La fecha de apertura no puede ser posterior a la venta.', 'fecha_apertura');

  const costRemoved = full ? p.cost_total : round2(p.cost_total * qty / p.qty);
  const pl = round2(importe - fee - costRemoved);

  // Resultado realizado: una fila por valor.
  let r = data.degiro_realized.find((x) => x.isin === code);
  if (!r) { r = { name: p.name, isin: code, pl: 0 }; data.degiro_realized.push(r); }
  r.pl = round2(r.pl + pl);

  const episodePl = round2((p.episode_realized || 0) + pl);
  if (full) {
    data.degiro_open_positions.splice(data.degiro_open_positions.indexOf(p), 1);
    data.behavior.episodes.push({
      isin: code, name: p.name.toUpperCase(),
      open: opened + 'T00:00:00', close: fecha + 'T00:00:00',
      holding_days: Math.round((isoToMs(fecha) - isoToMs(opened)) / DAY_MS),
      pnl: episodePl,
    });
  } else {
    p.qty = round4(p.qty - qty);
    p.cost_total = round2(p.cost_total - costRemoved);
    p.episode_realized = episodePl;
    p.last_price = price; p.last_price_cur = cur; p.last_price_date = isoToDmy(fecha);
  }

  addTradeFee(data, fee);
  moveCash(data, importe - fee);
  const q = quarterRow(data, fecha);
  q.n_sells += 1;
  touchQuarterTicker(q, code);
  bumpDateMax(data, fecha);

  const sign = pl >= 0 ? '+' : '';
  return `Venta de ${fmtQty(qty)} × ${p.name} a ${fmtPrice(price, cur)} — resultado ${sign}${fmtEur(pl)}${full ? ' (posición cerrada)' : ''}`;
}

/* ---------- dividendo ---------- */

function applyDividendo(data, m) {
  const fecha = date(m.fecha, 'fecha', 'Fecha');
  const name = text(m.nombre, 'nombre', 'Valor');
  const cur = currency(m.divisa, 'divisa');
  const grossEur = num(m.bruto_eur, 'bruto_eur', 'Bruto en EUR', { positive: true });
  const grossNative = cur === 'EUR' ? grossEur : num(m.bruto_nativo, 'bruto_nativo', `Bruto en ${cur}`, { positive: true });
  const taxAbs = Math.abs(num(m.retencion_eur == null || m.retencion_eur === '' ? 0 : m.retencion_eur, 'retencion_eur', 'Retención'));
  if (taxAbs > grossEur) throw new UserError('La retención no puede ser mayor que el bruto.', 'retencion_eur');
  const tax = taxAbs ? -round2(taxAbs) : 0;

  const key = name.toLowerCase();
  let row = data.dividends.find((d) => d.account === 'DEGIRO' && d.name.toLowerCase() === key);
  if (!row) {
    row = { account: 'DEGIRO', name, cur, gross_native: 0, gross_eur: 0, tax_eur: 0, approx: cur !== 'EUR' };
    data.dividends.push(row);
  } else if (row.cur !== cur) {
    throw new UserError(`${row.name} tiene sus dividendos anteriores en ${row.cur}; indica el bruto en esa divisa.`, 'divisa');
  }
  row.gross_native = round2(row.gross_native + grossNative);
  row.gross_eur = round2(row.gross_eur + grossEur);
  row.tax_eur = round2(row.tax_eur + tax);

  const c = data.combined;
  c.degiro_div_gross = round2(c.degiro_div_gross + grossEur);
  c.degiro_div_tax = round2(c.degiro_div_tax + tax);
  moveCash(data, grossEur + tax);
  bumpDateMax(data, fecha);
  return `Dividendo de ${row.name}: ${fmtEur(grossEur)} brutos, ${fmtEur(round2(grossEur + tax))} netos`;
}

/* ---------- aportación / retirada ---------- */

function applyAportacion(data, m, sign) {
  const fecha = date(m.fecha, 'fecha', 'Fecha');
  const importe = round2(num(m.importe, 'importe', 'Importe', { positive: true }));
  const c = data.combined;
  if (sign > 0) c.degiro_deposits_gross = round2(c.degiro_deposits_gross + importe);
  else c.degiro_withdrawals = round2(c.degiro_withdrawals - importe);
  data.degiro_cashflow_events.push([fecha, -sign * importe]);
  data.degiro_cashflow_events.sort((a, b) => a[0].localeCompare(b[0]));
  const row = monthRow(data, fecha);
  row.degiro = round2(row.degiro + sign * importe);
  moveCash(data, sign * importe);
  bumpDateMax(data, fecha);
  return sign > 0 ? `Aportación de ${fmtEur(importe)}` : `Retirada de ${fmtEur(importe)}`;
}

/* ---------- comisión (no de compraventa) e interés ---------- */

function applyComision(data, m) {
  const fecha = date(m.fecha, 'fecha', 'Fecha');
  const cat = String(m.categoria || '');
  if (!FEE_CATEGORIES[cat] || cat === 'trade') throw new UserError('Elige el tipo de comisión.', 'categoria');
  const importe = round2(num(m.importe, 'importe', 'Importe', { positive: true }));
  const c = data.combined;
  c.degiro_fees_breakdown[cat] = round2((c.degiro_fees_breakdown[cat] || 0) - importe);
  c.total_fees = round2(c.total_fees - importe);
  moveCash(data, -importe);
  bumpDateMax(data, fecha);
  return `${FEE_CATEGORIES[cat]}: −${fmtEur(importe)}`;
}

function applyInteres(data, m) {
  const fecha = date(m.fecha, 'fecha', 'Fecha');
  const importe = round2(num(m.importe, 'importe', 'Importe', { positive: true }));
  const cobrado = m.sentido === 'cobrado';
  const delta = cobrado ? importe : -importe;
  data.combined.degiro_interest = round2(data.combined.degiro_interest + delta);
  moveCash(data, delta);
  bumpDateMax(data, fecha);
  return cobrado ? `Interés cobrado: +${fmtEur(importe)}` : `Interés pagado: −${fmtEur(importe)}`;
}

/* ---------- entrada única ---------- */

/**
 * Aplica un movimiento y recalcula. Devuelve { summary, newSymbols }.
 * Si algo no cuadra lanza UserError y los datos NO deben guardarse
 * (el servidor trabaja siempre sobre una copia).
 */
function applyMovement(data, mov) {
  if (!mov || typeof mov !== 'object') throw new UserError('Movimiento vacío.');
  const ctx = { newSymbols: {} };
  let summary;
  switch (mov.tipo) {
    case 'compra': summary = applyCompra(data, mov, ctx); break;
    case 'venta': summary = applyVenta(data, mov); break;
    case 'dividendo': summary = applyDividendo(data, mov); break;
    case 'aportacion': summary = applyAportacion(data, mov, +1); break;
    case 'retirada': summary = applyAportacion(data, mov, -1); break;
    case 'comision': summary = applyComision(data, mov); break;
    case 'interes': summary = applyInteres(data, mov); break;
    default: throw new UserError('Tipo de movimiento desconocido.', 'tipo');
  }
  recomputeDerived(data);
  return { summary, newSymbols: ctx.newSymbols };
}

/**
 * Actualización de precios: { fx: {USD: 1.12, ...}, prices: [{isin, price, cur, auto, symbol}] }.
 */
function applyPrices(data, body, today) {
  if (!body || typeof body !== 'object') throw new UserError('Petición vacía.');
  const iso = today || todayIso();
  const labels = dateLabels(iso);
  const fx = Object.assign({}, data.live_meta.fx, { EUR: 1 });
  Object.keys(body.fx || {}).forEach((cur) => {
    const c = currency(cur, 'fx');
    if (c === 'EUR') return;
    fx[c] = num(body.fx[cur], 'fx:' + c, `Tipo de cambio ${c}`, { positive: true });
  });
  const list = Array.isArray(body.prices) ? body.prices : [];
  const byIsin = new Map();
  list.forEach((x) => { if (x.id) byIsin.set(String(x.id), x); if (x.isin && !byIsin.has(String(x.isin))) byIsin.set(String(x.isin), x); });
  let anyAuto = Object.keys(body.fx_auto || {}).some((k) => body.fx_auto[k]);
  data.degiro_open_positions.forEach((p) => {
    const x = (p.id && byIsin.get(p.id)) || byIsin.get(p.isin);
    if (!x) throw new UserError(`Falta el precio de ${p.name}.`, 'price:' + p.isin);
    const cur = currency(x.cur, 'price:' + p.isin);
    if (cur !== 'EUR' && !(fx[cur] > 0)) throw new UserError(`Falta el tipo de cambio de ${cur}.`, 'fx:' + cur);
    p.live_price = num(x.price, 'price:' + p.isin, `Precio de ${p.name}`, { positive: true });
    p.live_price_cur = cur;
    if (x.auto) {
      anyAuto = true;
      p.live_src = `Alpha Vantage (${String(x.symbol || '').slice(0, 20)}), ${labels.short}`;
    } else {
      p.live_src = `Precio introducido manualmente el ${labels.short}`;
    }
  });
  data.live_meta.fx = fx;
  data.live_meta.fetched_date = labels.short;
  data.live_meta.fetched_date_long = labels.long;
  data.live_meta.valuation_iso = iso;
  data.live_meta.manual = !anyAuto;
  recomputeDerived(data);
  return { summary: `Precios actualizados (${anyAuto ? 'Alpha Vantage' : 'a mano'}) — valor DEGIRO ${fmtEur(data.combined.degiro_value_total)}` };
}

module.exports = { TYPES, applyMovement, applyPrices, fmtEur };
