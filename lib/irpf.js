'use strict';
/*
 * Simulación fiscal del IRPF (España — territorio común).
 *
 * Calcula, a partir de los libros de extractos (DEGIRO + Interactive Brokers) y
 * de los movimientos manuales aún no cubiertos por extracto:
 *  - Ganancias y pérdidas patrimoniales por método FIFO global por ISIN
 *    (art. 37.2 LIRPF — valores homogéneos uniendo todas las cuentas/divisas).
 *  - Regla antiaplicación de los 2 meses (art. 33.5.f LIRPF): bloqueo
 *    proporcional de pérdidas si existen compras homogéneas en los ±2 meses que
 *    permanecen en cartera o se realizan después, y liberación posterior al
 *    transmitir los títulos que originaron el bloqueo.
 *  - Rendimientos del capital mobiliario (dividendos brutos, intereses cobrados
 *    y préstamo de valores) y retenciones soportadas en origen.
 *  - Integración y compensación en la Base Imponible del Ahorro (art. 49 LIRPF):
 *    compensación cruzada hasta el 25 % y arrastre de saldos negativos durante
 *    los 4 ejercicios siguientes.
 *  - Cuota íntegra por tramos del ahorro (territorio común: 2023–2024 hasta 28 %;
 *    desde 2025 hasta 30 %) y estimación orientativa de deducción por doble
 *    imposición internacional (art. 80 LIRPF, límite estándar 15 %).
 *
 * Es una herramienta orientativa y no sustituye el asesoramiento fiscal ni los
 * datos oficiales de la Agencia Tributaria (AEAT).
 */

const { round2, round4, isIsoDate, isoToMs, todayIso, UserError } = require('./calc');
const degiro = require('./degiro');

/**
 * Suma o resta meses calendario (cómputo de fecha a fecha, art. 5 Código Civil).
 * Si el mes destino tiene menos días (p. ej. 31 dic + 2 meses), ajusta al último día del mes.
 */
function addMonthsIso(iso, months) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/** Escala estatal + autonómica (territorio común) de la Base Imponible del Ahorro. */
function savingsBrackets(year) {
  const topRate = year >= 2025 ? 0.30 : 0.28;
  return [
    { from: 0, to: 6000, width: 6000, rate: 0.19, label: 'Hasta 6.000 €' },
    { from: 6000, to: 50000, width: 44000, rate: 0.21, label: '6.000 € – 50.000 €' },
    { from: 50000, to: 200000, width: 150000, rate: 0.23, label: '50.000 € – 200.000 €' },
    { from: 200000, to: 300000, width: 100000, rate: 0.27, label: '200.000 € – 300.000 €' },
    { from: 300000, to: Infinity, width: Infinity, rate: topRate, label: 'Más de 300.000 €' },
  ];
}

function calcSavingsTax(base, year) {
  const positive = Math.max(0, round2(base || 0));
  const defs = savingsBrackets(year);
  let left = positive;
  let tax = 0;
  let marginal = defs[0].rate;
  const brackets = [];
  for (const b of defs) {
    const slice = left > 0 ? Math.min(left, b.width) : 0;
    const sliceTax = round2(slice * b.rate);
    if (slice > 0) marginal = b.rate;
    brackets.push({ label: b.label, base: round2(slice), ratePct: Math.round(b.rate * 100), tax: sliceTax });
    tax = round2(tax + sliceTax);
    left = round2(left - slice);
  }
  return {
    tax,
    brackets,
    effectivePct: positive > 0 ? round2(tax / positive * 100) : 0,
    marginalPct: Math.round(marginal * 100),
  };
}

/** Extrae eventos de desdoblamiento (splits) de las acciones corporativas de IBKR. */
function parseSplits(ibkrLedger) {
  const out = [];
  const actions = (ibkrLedger && ibkrLedger.events && ibkrLedger.events.actions) || [];
  actions.forEach((a) => {
    const m = /\(([A-Z0-9]{12})\)\s+Desdoblamiento\s+(\d+(?:\.\d+)?)\s+para\s+(\d+(?:\.\d+)?)/i.exec(a.desc || '');
    if (!m || !a.date) return;
    const num = parseFloat(m[2]), den = parseFloat(m[3]);
    if (num > 0 && den > 0) {
      out.push({ date: a.date, isin: m[1], factor: num / den, account: 'IBKR', desc: a.desc });
    }
  });
  return out;
}

/**
 * Normaliza todas las operaciones, dividendos e intereses de DEGIRO, IBKR y
 * movimientos manuales activos en una línea temporal unificada en EUR.
 */
function collectTaxEvents(data, ledgers) {
  ledgers = ledgers || {};
  const degiroRows = ledgers.degiroRows || [];
  const ibkrLedger = ledgers.ibkrLedger || null;
  const fxFallback = (data && data.live_meta && data.live_meta.fx) || {};
  const warnings = [];
  const trades = [];
  const dividends = [];
  const interests = [];
  const splits = parseSplits(ibkrLedger);
  let seq = 0;

  // 1. DEGIRO (desde el libro completo)
  if (degiroRows.length) {
    const d = degiro.deriveDegiro(degiroRows, data);
    (d.trades || []).forEach((t) => {
      trades.push({
        seq: ++seq,
        date: t.date,
        time: t.time || '00:00',
        account: 'DEGIRO',
        side: t.side,
        isin: t.isin,
        name: t.name,
        qty: t.qty,
        cur: t.cur,
        eur: round2(Math.abs(t.eur)),
        fee: round2(Math.abs(t.fee || 0)),
        approx: false,
      });
    });
    (d.dividendEvents || []).forEach((ev) => {
      dividends.push({
        date: ev.date,
        account: 'DEGIRO',
        name: ev.name,
        isin: ev.isin || '',
        cur: ev.cur || 'EUR',
        gross_eur: round2(ev.gross_eur || 0),
        tax_eur: round2(ev.tax_eur || 0),
        approx: !!ev.approx,
      });
    });
    (d.interestEvents || []).forEach((ev) => {
      interests.push({ date: ev.date, account: 'DEGIRO', kind: ev.kind, amount_eur: round2(ev.amount_eur || 0) });
    });
  }

  // 2. Interactive Brokers (desde el libro de informes)
  if (ibkrLedger && ibkrLedger.events) {
    const byIsin = {};
    (ibkrLedger.statements || []).forEach((s) => {
      Object.keys(s.instruments || {}).forEach((sym) => {
        const ins = s.instruments[sym];
        if (ins && ins.isin) byIsin[ins.isin] = ins;
      });
    });
    const ev = ibkrLedger.events;
    let ibkrApproxUsed = false;
    (ev.trades || []).forEach((t) => {
      const qty = Math.abs(Number(t.qty) || 0);
      if (!(qty > 0)) return;
      const side = t.qty >= 0 ? 'compra' : 'venta';
      const cur = t.cur || 'EUR';
      const feeEur = round2(Math.abs(Number(t.fee_eur) || 0));
      let eur = null;
      let approx = false;
      if (cur === 'EUR') {
        eur = Math.abs(Number(t.proceeds) || 0);
      } else if (t.proceeds_eur != null && isFinite(t.proceeds_eur)) {
        eur = Math.abs(Number(t.proceeds_eur));
      } else if (t.fee && t.fee_eur) {
        // Proporción exacta del propio informe de IBKR para esa divisa.
        eur = Math.abs(Number(t.proceeds) || 0) * Math.abs(Number(t.fee_eur) / Number(t.fee));
      } else if (t.realized && t.realized_eur) {
        eur = Math.abs(Number(t.proceeds) || 0) * Math.abs(Number(t.realized_eur) / Number(t.realized));
      } else if (fxFallback[cur] > 0) {
        eur = Math.abs(Number(t.proceeds) || 0) / fxFallback[cur];
        approx = true;
        ibkrApproxUsed = true;
      }
      if (eur == null) {
        warnings.push(`Operación de IBKR (${t.symbol}, ${t.date}) en ${cur} sin tipo de cambio disponible: omitida en la simulación fiscal.`);
        return;
      }
      const ins = byIsin[t.id];
      const name = ins ? degiro.titleCase(ins.name || t.symbol) : t.symbol;
      trades.push({
        seq: ++seq,
        date: t.date,
        time: (t.time || '00:00:00').slice(0, 8),
        account: 'IBKR',
        side,
        isin: t.id || t.symbol,
        name,
        qty: round4(qty),
        cur,
        eur: round2(eur),
        fee: feeEur,
        approx,
      });
    });
    if (ibkrApproxUsed) {
      warnings.push('Alguna operación de IBKR en divisa sin cambio implícito en el informe se ha convertido con el tipo de cambio guardado en la aplicación.');
    }
    (ev.dividends || []).forEach((d) => {
      const ins = byIsin[d.isin];
      dividends.push({
        date: d.date,
        account: 'IBKR',
        name: ins ? degiro.titleCase(ins.name) : (d.symbol || d.desc || 'IBKR'),
        isin: d.isin || '',
        cur: d.cur || 'EUR',
        gross_eur: round2(d.eur || 0),
        tax_eur: 0,
        approx: false,
      });
    });
    (ev.withholding || []).forEach((w) => {
      const ins = byIsin[w.isin];
      dividends.push({
        date: w.date,
        account: 'IBKR',
        name: ins ? degiro.titleCase(ins.name) : (w.symbol || w.desc || 'IBKR'),
        isin: w.isin || '',
        cur: w.cur || 'EUR',
        gross_eur: 0,
        tax_eur: round2(w.eur || 0),
        approx: false,
      });
    });
  }

  // 3. Movimientos manuales aún no sustituidos por extracto
  const parseEs = (v) => parseFloat(String(v == null ? '' : v).trim().replace(',', '.'));
  const nameByIsin = new Map();
  trades.forEach((t) => { if (t.isin && t.name) nameByIsin.set(t.isin, t.name); });
  ((data && data.degiro_open_positions) || []).forEach((p) => { if (p.isin && p.name) nameByIsin.set(p.isin, p.name); });

  ((data && data.journal) || []).forEach((j) => {
    if (j.kind !== 'movimiento' || j.superseded || !j.payload) return;
    const m = j.payload;
    if (!m.fecha) return;
    if (m.tipo === 'compra' || m.tipo === 'venta') {
      const rawIsin = String(m.isin || '').trim();
      const code = rawIsin.includes(':') ? rawIsin.split(':')[0] : rawIsin;
      const qty = parseEs(m.cantidad);
      const eur = parseEs(m.importe_eur);
      const fee = parseEs(m.comision_eur) || 0;
      if (!(qty > 0) || !(eur > 0) || !code) return;
      trades.push({
        seq: ++seq,
        date: m.fecha,
        time: '23:59',
        account: 'DEGIRO (manual)',
        side: m.tipo,
        isin: code.toUpperCase(),
        name: m.nombre || nameByIsin.get(code.toUpperCase()) || code.toUpperCase(),
        qty: round4(qty),
        cur: (m.divisa || 'EUR').toUpperCase(),
        eur: round2(eur),
        fee: round2(Math.abs(fee)),
        approx: false,
      });
    } else if (m.tipo === 'dividendo') {
      const gross = parseEs(m.bruto_eur);
      const taxAbs = Math.abs(parseEs(m.retencion_eur) || 0);
      if (gross > 0) {
        dividends.push({
          date: m.fecha,
          account: 'DEGIRO (manual)',
          name: m.nombre || 'Dividendo',
          isin: '',
          cur: (m.divisa || 'EUR').toUpperCase(),
          gross_eur: round2(gross),
          tax_eur: taxAbs ? -round2(taxAbs) : 0,
          approx: false,
        });
      }
    } else if (m.tipo === 'interes') {
      const imp = parseEs(m.importe);
      if (imp > 0) {
        interests.push({
          date: m.fecha,
          account: 'DEGIRO (manual)',
          kind: 'interest',
          amount_eur: m.sentido === 'cobrado' ? round2(imp) : -round2(imp),
        });
      }
    }
  });

  // Orden cronológico: por fecha, luego splits antes de operaciones del día, luego hora y secuencia.
  trades.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.seq - b.seq);
  return { trades, dividends, interests, splits, warnings };
}

/**
 * Ejecuta el motor FIFO global por ISIN + regla antiaplicación de los 2 meses
 * sobre una lista de operaciones, dividendos, intereses y splits.
 */
function runIrpfEngine(input, opts) {
  opts = opts || {};
  const today = opts.today || todayIso();
  const warnings = (input.warnings || []).slice();
  const trades = (input.trades || []).slice().sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || (a.seq || 0) - (b.seq || 0));
  const splits = (input.splits || []).slice().sort((a, b) => a.date.localeCompare(b.date));

  // Construye la línea temporal combinando splits y operaciones.
  const timeline = [];
  splits.forEach((sp, i) => timeline.push({ kind: 'split', date: sp.date, order: 0, idx: i, data: sp }));
  trades.forEach((tr, i) => timeline.push({ kind: 'trade', date: tr.date, order: 1, idx: i, data: tr }));
  timeline.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.idx - b.idx);

  const lotsByIsin = new Map();   // isin -> lista de lotes (todos, con `remaining` actualizado)
  const allLots = [];
  const sales = [];
  let lotSeq = 0;

  // Paso 1: Ejecutar FIFO cronológico y registrar cada venta con la foto exacta de los lotes
  // previos que permanecen abiertos justo después de la venta.
  timeline.forEach((ev) => {
    if (ev.kind === 'split') {
      const sp = ev.data;
      const list = lotsByIsin.get(sp.isin) || [];
      list.forEach((lot) => {
        if (lot.remaining > 1e-9 && (!sp.account || lot.account === sp.account)) {
          lot.remaining = round4(lot.remaining * sp.factor);
          lot.origQty = round4(lot.origQty * sp.factor);
          lot.unitCost = lot.acqTotal / lot.origQty;
          lot.splitFactor = (lot.splitFactor || 1) * sp.factor;
        }
      });
      return;
    }

    const t = ev.data;
    if (!lotsByIsin.has(t.isin)) lotsByIsin.set(t.isin, []);
    const queue = lotsByIsin.get(t.isin);

    if (t.side === 'compra') {
      const acqTotal = round2(t.eur + t.fee);
      const lot = {
        lotId: ++lotSeq,
        timelineIdx: ev.idx,
        date: t.date,
        time: t.time || '',
        account: t.account,
        isin: t.isin,
        name: t.name,
        cur: t.cur,
        origQty: t.qty,
        remaining: t.qty,
        acqTotal,
        unitCost: acqTotal / t.qty,
        approx: !!t.approx,
        consumptions: [], // [{ saleIdx, qty }] para rastrear liberaciones posteriores
      };
      queue.push(lot);
      allLots.push(lot);
      return;
    }

    // Venta: consumo FIFO
    const txTotal = round2(t.eur - t.fee);
    let need = t.qty;
    let costSum = 0;
    const slices = [];
    const saleIdx = sales.length;

    for (const lot of queue) {
      if (need <= 1e-9) break;
      if (lot.remaining <= 1e-9) continue;
      const take = Math.min(lot.remaining, need);
      const isLastOfLot = Math.abs(take - lot.remaining) < 1e-7;
      // Si se consume entero el lote, evita acumular céntimos sueltos por redondeo.
      const consumedSoFar = lot.consumptions.reduce((a, c) => a + c.costEur, 0);
      const sliceCost = isLastOfLot ? round2(lot.acqTotal - consumedSoFar) : round2(take * lot.unitCost);
      lot.remaining = isLastOfLot ? 0 : round4(lot.remaining - take);
      lot.consumptions.push({ saleIdx, date: t.date, year: Number(t.date.slice(0, 4)), qty: round4(take), costEur: sliceCost });
      slices.push({
        lotId: lot.lotId,
        buyDate: lot.date,
        buyAccount: lot.account,
        qty: round4(take),
        costEur: sliceCost,
      });
      costSum += sliceCost;
      need = round4(need - take);
    }

    if (need > 1e-4) {
      warnings.push(`Venta de ${t.name} (${t.isin}) el ${t.date}: faltan ${need} títulos en compras previas para completar el FIFO.`);
    }

    const costEur = round2(costSum);
    const gain = round2(txTotal - costEur);

    // Foto de los lotes previos (mismo ISIN) comprados en [date - 2 meses, date] que SIGUEN en cartera tras esta venta.
    const winStart = addMonthsIso(t.date, -2);
    const winEnd = addMonthsIso(t.date, 2);
    const priorRemaining = queue
      .filter((l) => l.date >= winStart && l.date <= t.date && l.remaining > 1e-9)
      .map((l) => ({ lot: l, qtyAfterSale: l.remaining }));

    sales.push({
      saleIdx,
      timelineIdx: ev.idx,
      date: t.date,
      year: Number(t.date.slice(0, 4)),
      account: t.account,
      isin: t.isin,
      name: t.name,
      qty: t.qty,
      txEur: txTotal,
      feeEur: t.fee,
      costEur,
      gain,
      slices,
      winStart,
      winEnd,
      priorRemaining,
      blockedQty: 0,
      blockedLoss: 0,
      computableGain: gain,
      triggers: [],
      approx: !!t.approx || slices.some((s) => {
        const l = allLots.find((x) => x.lotId === s.lotId);
        return l && l.approx;
      }),
      isHypothetical: !!t.isHypothetical,
    });
  });

  // Paso 2: Aplicar la regla antiaplicación de los 2 meses (art. 33.5.f LIRPF) a las ventas con pérdida
  // y rastrear cuándo se libera cada pérdida bloqueada al venderse los lotes que causaron el bloqueo.
  const lotBlockCap = new Map(); // lotId -> capacidad restante de títulos que aún no han bloqueado otra pérdida
  allLots.forEach((l) => lotBlockCap.set(l.lotId, l.origQty));

  const liberations = []; // [{ originSaleIdx, originDate, originYear, isin, name, releaseDate, releaseYear, qty, amount }]
  const pendingBlocked = []; // pérdidas todavía bloqueadas en lotes abiertos hoy

  sales.forEach((sale) => {
    if (!(sale.gain < -0.005)) return;

    // (A) Compras previas en [winStart, sale.date] que permanecen en cartera tras la venta.
    const candidates = [];
    sale.priorRemaining.forEach(({ lot, qtyAfterSale }) => {
      const cap = Math.min(qtyAfterSale, lotBlockCap.get(lot.lotId) || 0);
      if (cap > 1e-9) candidates.push({ lot, avail: cap, relation: 'anterior' });
    });

    // (B) Compras posteriores en [sale.date, winEnd] (después de esta venta en la línea temporal).
    const sameIsinLots = lotsByIsin.get(sale.isin) || [];
    sameIsinLots.forEach((lot) => {
      if (lot.timelineIdx <= sale.timelineIdx) return;
      if (lot.date < sale.date || lot.date > sale.winEnd) return;
      const cap = lotBlockCap.get(lot.lotId) || 0;
      if (cap > 1e-9) candidates.push({ lot, avail: cap, relation: 'posterior' });
    });

    let leftToBlock = sale.qty;
    let totalBlockedQty = 0;
    const linked = [];

    for (const c of candidates) {
      if (leftToBlock <= 1e-9) break;
      const use = Math.min(leftToBlock, c.avail);
      lotBlockCap.set(c.lot.lotId, round4((lotBlockCap.get(c.lot.lotId) || 0) - use));
      leftToBlock = round4(leftToBlock - use);
      totalBlockedQty = round4(totalBlockedQty + use);
      const lossShare = round2(sale.gain * (use / sale.qty));
      linked.push({ lot: c.lot, qty: use, loss: lossShare, relation: c.relation });
      sale.triggers.push({
        lotId: c.lot.lotId,
        date: c.lot.date,
        account: c.lot.account,
        qty: round4(use),
        relation: c.relation,
      });
    }

    if (totalBlockedQty <= 1e-9) return;

    const blockedLoss = Math.abs(totalBlockedQty - sale.qty) < 1e-6
      ? sale.gain
      : round2(sale.gain * (totalBlockedQty / sale.qty));
    sale.blockedQty = round4(totalBlockedQty);
    sale.blockedLoss = blockedLoss; // negativo
    sale.computableGain = round2(sale.gain - blockedLoss);

    // Rastrear liberaciones: cuando el lote que causó el bloqueo se consume en ventas POSTERIORES a `sale`.
    linked.forEach((lk) => {
      let pendingQty = lk.qty;
      let pendingLoss = lk.loss;
      const laterConsumptions = lk.lot.consumptions.filter((co) => co.saleIdx > sale.saleIdx);
      for (const co of laterConsumptions) {
        if (pendingQty <= 1e-9) break;
        const relQty = Math.min(pendingQty, co.qty);
        const isAll = Math.abs(relQty - pendingQty) < 1e-6;
        const relLoss = isAll ? pendingLoss : round2(lk.loss * (relQty / lk.qty));
        liberations.push({
          originSaleIdx: sale.saleIdx,
          originDate: sale.date,
          originYear: sale.year,
          isin: sale.isin,
          name: sale.name,
          buyDate: lk.lot.date,
          buyAccount: lk.lot.account,
          releaseSaleIdx: co.saleIdx,
          releaseDate: co.date,
          releaseYear: co.year,
          qty: round4(relQty),
          amount: relLoss, // negativo (pérdida que pasa a ser computable en releaseYear)
        });
        pendingQty = round4(pendingQty - relQty);
        pendingLoss = round2(pendingLoss - relLoss);
      }
      if (pendingQty > 1e-6 && Math.abs(pendingLoss) > 0.005) {
        pendingBlocked.push({
          originDate: sale.date,
          originYear: sale.year,
          isin: sale.isin,
          name: sale.name,
          buyDate: lk.lot.date,
          buyAccount: lk.lot.account,
          qty: round4(pendingQty),
          amount: pendingLoss,
          relation: lk.relation,
        });
      }
    });
  });

  // Paso 3: Alertas activas hoy (ventas con pérdida en los últimos 2 meses cuya ventana sigue abierta).
  const activeWindows = [];
  sales.forEach((sale) => {
    if (sale.isHypothetical) return;
    if (!(sale.gain < -0.005)) return;
    if (sale.winEnd < today) return;
    const remainingUnblocked = round2(sale.computableGain);
    if (remainingUnblocked < -0.005) {
      activeWindows.push({
        isin: sale.isin,
        name: sale.name,
        saleDate: sale.date,
        untilDate: sale.winEnd,
        unblockedLoss: remainingUnblocked,
        unblockedQty: round4(sale.qty - sale.blockedQty),
      });
    }
  });

  // Paso 4: Agregar por ejercicio fiscal (año natural) con compensación 25 % y arrastre 4 años (art. 49 LIRPF).
  const yearSet = new Set();
  sales.forEach((s) => yearSet.add(s.year));
  liberations.forEach((l) => yearSet.add(l.releaseYear));
  (input.dividends || []).forEach((d) => { if (d.date) yearSet.add(Number(d.date.slice(0, 4))); });
  (input.interests || []).forEach((it) => { if (it.date) yearSet.add(Number(it.date.slice(0, 4))); });

  const yearsList = Array.from(yearSet).filter((y) => y >= 2000 && y <= 2100).sort((a, b) => a - b);
  const carryQueue = []; // [{ originYear, expiresYear, remaining }] (en positivo = pérdida pendiente de compensar)
  const byYear = [];

  yearsList.forEach((year) => {
    const ySales = sales.filter((s) => s.year === year);
    const yLibs = liberations.filter((l) => l.releaseYear === year);
    const yDivs = (input.dividends || []).filter((d) => d.date && Number(d.date.slice(0, 4)) === year);
    const yInts = (input.interests || []).filter((it) => it.date && Number(it.date.slice(0, 4)) === year);

    const gains = round2(ySales.filter((s) => s.gain > 0).reduce((a, s) => a + s.gain, 0));
    const lossesGross = round2(ySales.filter((s) => s.gain < 0).reduce((a, s) => a + s.gain, 0));
    const lossesBlocked = round2(ySales.reduce((a, s) => a + (s.blockedLoss || 0), 0));
    const lossesLiberated = round2(yLibs.reduce((a, l) => a + l.amount, 0));
    const gppYear = round2(gains + (lossesGross - lossesBlocked) + lossesLiberated);

    const divGross = round2(yDivs.reduce((a, d) => a + (d.gross_eur || 0), 0));
    const divTaxRaw = round2(yDivs.reduce((a, d) => a + (d.tax_eur || 0), 0)); // negativo en extractos
    const divTaxForeign = round2(Math.abs(divTaxRaw));
    const interestIncome = round2(yInts.filter((i) => i.amount_eur > 0).reduce((a, i) => a + i.amount_eur, 0));
    const interestPaid = round2(yInts.filter((i) => i.amount_eur < 0).reduce((a, i) => a + i.amount_eur, 0));
    const rcmNet = round2(divGross + interestIncome);

    // Descartar arrastres caducados (> 4 ejercicios).
    const activeCarryBefore = carryQueue.filter((c) => c.expiresYear >= year && c.remaining > 0.005);
    const carryAvailableStart = round2(activeCarryBefore.reduce((a, c) => a + c.remaining, 0));

    let gppAfterCarry = gppYear;
    let carryUsedOnGpp = 0;
    if (gppAfterCarry > 0) {
      for (const c of activeCarryBefore) {
        if (gppAfterCarry <= 0.005) break;
        const use = Math.min(gppAfterCarry, c.remaining);
        c.remaining = round2(c.remaining - use);
        gppAfterCarry = round2(gppAfterCarry - use);
        carryUsedOnGpp = round2(carryUsedOnGpp + use);
      }
    }

    // Compensación cruzada del 25 % de RCM con saldo negativo de GPP (del año y/o de los 4 años anteriores).
    let crossCap = rcmNet > 0 ? round2(rcmNet * 0.25) : 0;
    let crossOffset = 0;
    let newLossToCarry = 0;

    if (gppAfterCarry < 0) {
      const neg = Math.abs(gppAfterCarry);
      const use = Math.min(neg, crossCap);
      crossOffset = round2(crossOffset + use);
      crossCap = round2(crossCap - use);
      newLossToCarry = round2(neg - use);
      gppAfterCarry = 0;
    }

    let carryUsedOnRcm = 0;
    if (crossCap > 0.005) {
      for (const c of activeCarryBefore) {
        if (crossCap <= 0.005) break;
        if (c.remaining <= 0.005) continue;
        const use = Math.min(crossCap, c.remaining);
        c.remaining = round2(c.remaining - use);
        crossCap = round2(crossCap - use);
        crossOffset = round2(crossOffset + use);
        carryUsedOnRcm = round2(carryUsedOnRcm + use);
      }
    }

    if (newLossToCarry > 0.005) {
      carryQueue.push({ originYear: year, expiresYear: year + 4, remaining: newLossToCarry });
    }

    const rcmAfterOffset = round2(Math.max(0, rcmNet - crossOffset));
    const gppTaxable = round2(Math.max(0, gppAfterCarry));
    const baseAhorro = round2(rcmAfterOffset + gppTaxable);
    const taxCalc = calcSavingsTax(baseAhorro, year);

    // Estimación orientativa de deducción por doble imposición internacional (art. 80 LIRPF):
    // menor entre retención soportada (con tope estándar 15 % convenio) y tipo medio efectivo sobre el dividendo.
    const foreignCap15 = round2(Math.min(divTaxForeign, divGross * 0.15));
    const ddiByRate = baseAhorro > 0 ? round2(Math.min(divGross, rcmAfterOffset) * (taxCalc.tax / baseAhorro)) : 0;
    const ddiEstimated = round2(Math.min(foreignCap15, ddiByRate));
    const cuotaNetaEst = round2(Math.max(0, taxCalc.tax - ddiEstimated));

    const carryRemainingEnd = carryQueue
      .filter((c) => c.expiresYear > year && c.remaining > 0.005)
      .map((c) => ({ originYear: c.originYear, expiresYear: c.expiresYear, amount: c.remaining }));

    // Agrupar dividendos del año por valor y cuenta para transparencia.
    const divMap = new Map();
    yDivs.forEach((d) => {
      const k = `${d.account}|${d.isin || d.name}`;
      if (!divMap.has(k)) divMap.set(k, { account: d.account, name: d.name, isin: d.isin, gross_eur: 0, tax_eur: 0, approx: false });
      const row = divMap.get(k);
      row.gross_eur = round2(row.gross_eur + (d.gross_eur || 0));
      row.tax_eur = round2(row.tax_eur + (d.tax_eur || 0));
      if (d.approx) row.approx = true;
    });
    const divRows = Array.from(divMap.values()).filter((r) => r.gross_eur > 0).sort((a, b) => b.gross_eur - a.gross_eur);

    byYear.push({
      year,
      salesCount: ySales.length,
      gains,
      lossesGross,
      lossesBlocked,
      lossesLiberated,
      gppYear,
      carryAvailableStart,
      carryUsedOnGpp,
      carryUsedOnRcm,
      crossOffset,
      gppTaxable,
      divGross,
      divTaxForeign,
      interestIncome,
      interestPaid,
      rcmNet,
      rcmAfterOffset,
      baseAhorro,
      cuotaIntegra: taxCalc.tax,
      effectivePct: taxCalc.effectivePct,
      marginalPct: taxCalc.marginalPct,
      brackets: taxCalc.brackets,
      ddiEstimated,
      cuotaNetaEst,
      carryRemainingEnd,
      carryRemainingTotal: round2(carryRemainingEnd.reduce((a, c) => a + c.amount, 0)),
      sales: ySales.map((s) => ({
        date: s.date,
        account: s.account,
        isin: s.isin,
        name: s.name,
        qty: s.qty,
        txEur: s.txEur,
        feeEur: s.feeEur,
        costEur: s.costEur,
        gain: s.gain,
        blockedQty: s.blockedQty,
        blockedLoss: s.blockedLoss,
        computableGain: s.computableGain,
        triggers: s.triggers,
        slices: s.slices,
        approx: s.approx,
      })),
      liberations: yLibs,
      dividends: divRows,
    });
  });

  // Paso 5: Lotes abiertos actuales por ISIN (cartera fiscal FIFO).
  const openMap = new Map();
  allLots.forEach((l) => {
    if (l.remaining <= 1e-6) return;
    const remCost = round2(l.remaining * l.unitCost);
    if (!openMap.has(l.isin)) {
      openMap.set(l.isin, { isin: l.isin, name: l.name, qty: 0, costEur: 0, lots: [] });
    }
    const g = openMap.get(l.isin);
    g.name = l.name;
    g.qty = round4(g.qty + l.remaining);
    g.costEur = round2(g.costEur + remCost);
    g.lots.push({
      lotId: l.lotId,
      date: l.date,
      account: l.account,
      qty: round4(l.remaining),
      costEur: remCost,
      unitCostEur: round4(l.unitCost),
      approx: l.approx,
    });
  });
  const openPositions = Array.from(openMap.values()).sort((a, b) => b.costEur - a.costEur);

  return {
    regime: 'España · IRPF territorio común (Base del Ahorro)',
    asOf: today,
    years: byYear,
    pendingBlocked,
    pendingBlockedTotal: round2(pendingBlocked.reduce((a, p) => a + p.amount, 0)),
    activeWindows,
    openPositions,
    warnings,
    hasData: trades.length > 0 || (input.dividends || []).length > 0,
  };
}

/** Calcula la simulación fiscal completa a partir de los datos actuales y los libros. */
function computeIrpf(data, ledgers, opts) {
  const events = collectTaxEvents(data, ledgers);
  return runIrpfEngine(events, opts);
}

/**
 * Simula una venta hipotética ("¿y si vendo hoy?") aplicando FIFO global,
 * regla de los 2 meses e impacto exacto en la cuota del IRPF del ejercicio.
 */
function simulateSale(data, ledgers, params, opts) {
  opts = opts || {};
  const today = opts.today || todayIso();
  const isin = String((params && params.isin) || '').trim().toUpperCase();
  const qty = Number(params && params.qty);
  const priceEur = Number(params && params.priceEur);
  const feeEur = Number((params && params.feeEur) || 0);
  const date = (params && params.date) || today;

  if (!isin) throw new UserError('Elige un valor para simular la venta.', 'isin');
  if (!isFinite(qty) || !(qty > 0)) throw new UserError('La cantidad debe ser mayor que 0.', 'qty');
  if (!isFinite(priceEur) || !(priceEur > 0)) throw new UserError('El precio de venta en euros debe ser mayor que 0.', 'priceEur');
  if (!isFinite(feeEur) || feeEur < 0) throw new UserError('La comisión no puede ser negativa.', 'feeEur');
  if (!isIsoDate(date)) throw new UserError('Fecha de venta no válida (AAAA-MM-DD).', 'date');

  const events = collectTaxEvents(data, ledgers);
  const before = runIrpfEngine(events, { today });
  const open = before.openPositions.find((p) => p.isin === isin);
  if (!open) throw new UserError('No hay lotes abiertos en FIFO para ese ISIN.', 'isin');
  if (qty > open.qty + 1e-6) {
    throw new UserError(`Solo tienes ${open.qty} títulos abiertos de ${open.name} en FIFO.`, 'qty');
  }

  const simEvents = {
    trades: events.trades.concat([{
      seq: 999999,
      date,
      time: '23:59:59',
      account: 'Simulación',
      side: 'venta',
      isin,
      name: open.name,
      qty: round4(qty),
      cur: 'EUR',
      eur: round2(qty * priceEur),
      fee: round2(feeEur),
      approx: false,
      isHypothetical: true,
    }]),
    dividends: events.dividends,
    interests: events.interests,
    splits: events.splits,
    warnings: [],
  };
  const after = runIrpfEngine(simEvents, { today });
  const year = Number(date.slice(0, 4));
  const yBefore = before.years.find((y) => y.year === year) || {
    year, gppYear: 0, baseAhorro: 0, cuotaIntegra: 0, cuotaNetaEst: 0, marginalPct: 19,
  };
  const yAfter = after.years.find((y) => y.year === year);
  const simSale = yAfter.sales[yAfter.sales.length - 1];

  // Liberaciones adicionales provocadas por esta venta hipotética.
  const libsBefore = (yBefore.liberations || []).length;
  const newLibs = (yAfter.liberations || []).slice(libsBefore);
  const liberatedNow = round2(newLibs.reduce((a, l) => a + l.amount, 0));

  return {
    isin,
    name: open.name,
    date,
    qty: round4(qty),
    priceEur: round4(priceEur),
    feeEur: round2(feeEur),
    txEur: simSale.txEur,
    costEur: simSale.costEur,
    gain: simSale.gain,
    blockedQty: simSale.blockedQty,
    blockedLoss: simSale.blockedLoss,
    computableGain: simSale.computableGain,
    liberatedNow,
    newLiberations: newLibs,
    triggers: simSale.triggers,
    slices: simSale.slices,
    year,
    before: {
      gppYear: yBefore.gppYear,
      baseAhorro: yBefore.baseAhorro,
      cuotaIntegra: yBefore.cuotaIntegra,
      cuotaNetaEst: yBefore.cuotaNetaEst,
    },
    after: {
      gppYear: yAfter.gppYear,
      baseAhorro: yAfter.baseAhorro,
      cuotaIntegra: yAfter.cuotaIntegra,
      cuotaNetaEst: yAfter.cuotaNetaEst,
      marginalPct: yAfter.marginalPct,
    },
    deltaBase: round2(yAfter.baseAhorro - yBefore.baseAhorro),
    deltaCuota: round2(yAfter.cuotaIntegra - yBefore.cuotaIntegra),
    deltaCuotaNeta: round2(yAfter.cuotaNetaEst - yBefore.cuotaNetaEst),
  };
}

module.exports = {
  addMonthsIso,
  savingsBrackets,
  calcSavingsTax,
  collectTaxEvents,
  runIrpfEngine,
  computeIrpf,
  simulateSale,
};
