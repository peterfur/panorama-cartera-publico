/*
 * Panorama de Cartera — interfaz.
 *
 * Esta página solo PINTA y recoge lo que escribes. Todos los cálculos y el
 * guardado los hace el servidor local (server.js + lib/): aquí no se recalcula
 * ninguna cifra de la cartera.
 */
(async function(){
  "use strict";

  /* ---------------- comunicación con el servidor local ---------------- */
  async function api(method, url, body){
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error('No se puede contactar con la aplicación. ¿Sigue abierta la ventana del servidor?');
      err.code = 'server_down';
      throw err;
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* respuesta sin cuerpo */ }
    if (!res.ok){
      const info = (json && json.error) || {};
      // Una ruta que el servidor no conoce: está en marcha una versión anterior a los archivos de la carpeta.
      const stale = res.status === 404 && url.indexOf('/api/') === 0;
      const err = new Error(stale ? 'La aplicación que está en marcha es de una versión anterior. Cierra su ventana negra, vuelve a abrir iniciar.bat y recarga esta página.' : (info.message || ('Error ' + res.status)));
      err.code = info.code || 'http';
      err.field = info.field || null;
      throw err;
    }
    return json;
  }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function sg(v){ return v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); }
  const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  /** AAAA-MM-DD -> "2 oct 2026" */
  function isoLabel(iso){
    if (!iso) return '—';
    const [y,m,d] = String(iso).slice(0,10).split('-').map(Number);
    return `${d} ${MESES[m-1]} ${y}`;
  }
  /** AAAA-MM o AAAA-MM-DD -> "oct 2026" */
  function isoMonthLabel(iso){
    const [y,m] = String(iso).split('-').map(Number);
    return `${MESES[m-1]} ${y}`;
  }
  function $(id){ return document.getElementById(id); }
  function localIso(d){
    if (!(d instanceof Date) || isNaN(d)) return '';
    const p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }

  /* ---------------- tema claro / oscuro ---------------- */
  const THEME_KEY = 'cartera:theme';
  const themeListeners = [];
  const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
  const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function isDarkTheme(){
    const attr = document.documentElement.dataset.theme;
    if (attr === 'dark') return true;
    if (attr === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function syncThemeButton(){
    const btn = $('theme-toggle');
    if (!btn) return;
    const dark = isDarkTheme();
    btn.innerHTML = dark ? ICON_SUN : ICON_MOON;
    const lbl = dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
    btn.setAttribute('aria-label', lbl);
    btn.title = lbl;
  }
  (function initTheme(){
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
    } catch (e) { /* sin almacenamiento */ }
    syncThemeButton();
    const btn = $('theme-toggle');
    if (btn){
      btn.addEventListener('click', ()=>{
        const next = isDarkTheme() ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* da igual */ }
        syncThemeButton();
        themeListeners.forEach(fn=>fn());
      });
    }
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{
        syncThemeButton();
        themeListeners.forEach(fn=>fn());
      });
    } catch (e) { /* navegador antiguo */ }
  })();

  let PAYLOAD;
  try {
    PAYLOAD = await api('GET', '/api/portfolio');
  } catch (err) {
    document.body.classList.remove('is-loading');
    const box = $('fatal');
    box.style.display = 'flex';
    box.innerHTML = `<div class="fatal-card"><h2>No se han podido cargar los datos</h2><p>${esc(err.message)}</p><p class="footnote">Arranca la aplicación con <span class="mono">npm start</span> y vuelve a cargar esta página.</p></div>`;
    return;
  }
  const DATA = PAYLOAD.data, CONFIG = PAYLOAD.config, STATUS = PAYLOAD.status;
  const CHECKS = PAYLOAD.checks, CHECKS_SUMMARY = PAYLOAD.checksSummary;
  const SOURCES = DATA.sources || {};
  const { ibkr, dividends, degiro_open_positions, degiro_realized, monthly, combined, behavior } = DATA;
  // Qué cuentas tienen datos: la aplicación sirve con DEGIRO, con Interactive Brokers o con las dos.
  const HAS = STATUS.brokers || { degiro:true, ibkr:true };
  const NONE = !HAS.degiro && !HAS.ibkr;
  const BOTH = HAS.degiro && HAS.ibkr;

  /* ================= QUÉ SE ENSEÑA SEGÚN LAS CUENTAS CON DATOS ================= */
  (function(){
    const hide = (el)=>{ if (el) el.hidden = true; };
    document.querySelectorAll('[data-broker]').forEach(el=>{ if (!HAS[el.dataset.broker]) hide(el); });
    const nPositions = degiro_open_positions.length + ibkr.positions.length;
    const empty = {
      distribucion: !nPositions, evolucion: NONE, accounts: NONE, contributions: monthly.length < 2, holdings: !nPositions,
      dividends: !dividends.length, realized: !degiro_realized.length, behavior: !behavior.quarterly.length,
      irpf: NONE, checks: NONE, journal: NONE && !(DATA.journal || []).length,
    };
    Object.keys(empty).forEach(id=>{ if (empty[id]) hide(document.getElementById(id)); });
    document.querySelectorAll('.topnav-links a').forEach(a=>{
      const sec = document.getElementById(a.dataset.section);
      if (sec && sec.hidden) a.hidden = true;
    });
    const grid = document.querySelector('.accounts-grid');
    if (grid && !BOTH) grid.classList.add('single');
    if (NONE){
      // Instalación nueva: solo la bienvenida y el botón de importar.
      hide($('stat-row')); hide($('open-export-modal')); hide($('checks-pill')); hide($('topnav-checks'));
      document.querySelectorAll('.hero-link, .topnav-menu [data-open="open-export-modal"]').forEach(hide);
      $('welcome').hidden = false;
      $('welcome-import').addEventListener('click', ()=>$('open-import-modal').click());
    }
  })();

  /* ---------------- formatting helpers ---------------- */
  const nf2 = new Intl.NumberFormat('es-ES', { minimumFractionDigits:2, maximumFractionDigits:2, useGrouping:'always' });
  const nf0 = new Intl.NumberFormat('es-ES', { minimumFractionDigits:0, maximumFractionDigits:0, useGrouping:'always' });
  function eur(n, opts){
    if (n == null || !isFinite(n)) return '—';
    opts = opts || {};
    const sign = opts.forceSign && n > 0 ? '+' : '';
    return sign + nf2.format(n) + '\u00A0€';
  }
  function eurShort(n){
    const abs = Math.abs(n);
    if (abs >= 1000) return (n<0?'-':'') + nf0.format(Math.round(abs)) + '\u00A0€';
    return nf2.format(n) + '\u00A0€';
  }
  function num(n, d){ return new Intl.NumberFormat('es-ES', {minimumFractionDigits:d||0, maximumFractionDigits:d||0, useGrouping:'always'}).format(n); }
  function pct(n, d){ if (n == null || !isFinite(n)) return '—'; const sign = n>0?'+':''; return sign + n.toFixed(d==null?2:d).replace('.',',') + '\u00A0%'; }
  function monthLabel(m){
    const [y,mo] = m.split('-');
    const names = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    return names[parseInt(mo,10)-1] + ' ' + y.slice(2);
  }
  function el(tag, cls, html){
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function fmtDateEs(iso){
    // iso like DD-MM-YYYY
    const [d,m,y] = iso.split('-');
    const names = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    return d + ' ' + names[parseInt(m,10)-1] + ' ' + y;
  }

  const tooltip = document.getElementById('tooltip');
  function showTooltip(clientX, clientY, html){
    tooltip.innerHTML = html;
    tooltip.style.opacity = '1';
    const margin = 10;
    const w = tooltip.offsetWidth || 180;
    const h = tooltip.offsetHeight || 48;
    let left = clientX - w / 2;
    left = Math.max(margin, Math.min(window.innerWidth - w - margin, left));
    let top = clientY - h - 14;
    if (top < margin) top = Math.min(window.innerHeight - h - margin, clientY + 16);
    tooltip.style.left = Math.round(left) + 'px';
    tooltip.style.top = Math.round(top) + 'px';
  }
  function hideTooltip(){ tooltip.style.opacity = '0'; }

  /* ================= HERO STAT ROW ================= */
  (function(){
    const row = document.getElementById('stat-row');
    const tiles = [
      { label:'Valor total de la cartera', value: eur(combined.portfolio_value_total), sub: BOTH ? `hoy · IBKR ${eurShort(ibkr.nav_final)} + DEGIRO ${eurShort(combined.degiro_value_total)} en posiciones` : (HAS.degiro ? `hoy · ${eurShort(combined.degiro_value_total)} en posiciones y ${eurShort(combined.degiro_cash_wallet)} de efectivo` : `al ${isoLabel(ibkr.period_end)}, fecha del último informe`) },
      { label:'Aportaciones netas totales', value: eur(combined.total_contributions), sub: BOTH ? `IBKR ${eurShort(combined.ibkr_contributions)} · DEGIRO ${eurShort(combined.degiro_contributions)}` : 'ingresos menos retiradas' },
      { label:'Rendimiento total', value: eur(combined.portfolio_total_return,{forceSign:true}), sub: combined.portfolio_total_return_pct != null ? `${pct(combined.portfolio_total_return_pct,1)} sobre lo aportado` : 'capital recuperado (aportaciones netas ≤ 0)', pos: combined.portfolio_total_return>=0, neg: combined.portfolio_total_return<0 },
      { label:'Dividendos netos recibidos', value: eur(combined.total_div_net), custom:true },
    ];
    tiles.forEach((t,i)=>{
      const tile = el('div','stat-tile');
      tile.appendChild(el('div','stat-label', t.label));
      tile.appendChild(el('div','stat-value', t.value));
      if (t.custom){
        tile.appendChild(el('div','stat-sub', `bruto ${eurShort(ibkr.div_gross + combined.degiro_div_gross)} · retención ${eurShort(ibkr.div_tax + combined.degiro_div_tax)}`));
      } else {
        tile.appendChild(el('div','stat-sub' + (t.neg?' neg':'') + (t.pos?' pos':''), t.sub));
      }
      row.appendChild(tile);
    });
  })();

  /* ================= ACCOUNT CARDS ================= */
  (function(){
    const c = document.getElementById('ibkr-card');
    const sts = ibkr.statements || [];
    const fromStatements = sts.length > 0; // datos reconstruidos desde los informes importados
    const head = `
      <div class="acct-head">
        <span class="acct-swatch" style="background:var(--ibkr)"></span>
        <div>
          <div class="acct-name">Interactive Brokers</div>
          <div class="acct-meta">Cuenta ${esc(ibkr.account)} · ${fromStatements ? `${sts.length} ${sts.length === 1 ? 'informe' : 'informes'} · ` : 'extracto '}${isoLabel(ibkr.period_start)} – ${isoLabel(ibkr.period_end)}</div>
        </div>
      </div>`;
    if (!fromStatements){
      c.innerHTML = head + `
      <div class="acct-body">
        <div class="kv-grid">
          <div><div class="kv-label">Valor de la cuenta</div><div class="kv-value">${eur(ibkr.nav_final)}</div></div>
          <div><div class="kv-label">Rentabilidad ponderada / año</div><div class="kv-value ${sg(ibkr.twr_pct)}">${pct(ibkr.twr_pct,2)}</div></div>
          <div><div class="kv-label">Aportaciones netas</div><div class="kv-value">${eur(ibkr.contributions)}</div></div>
          <div><div class="kv-label">Resultado del periodo</div><div class="kv-value ${sg(ibkr.mtm_pl)}">${eur(ibkr.mtm_pl, {forceSign:true})}</div></div>
          <div><div class="kv-label">Acciones: coste → valor</div><div class="kv-value"><span class="nowrap">${eur(ibkr.stocks_cost)}</span> → <span class="nowrap">${eur(ibkr.stocks_value)}</span></div></div>
          <div><div class="kv-label">Plusvalía no realizada</div><div class="kv-value ${sg(ibkr.stocks_pl)}">${eur(ibkr.stocks_pl,{forceSign:true})}</div></div>
          <div><div class="kv-label">Dividendos netos</div><div class="kv-value pos">${eur(ibkr.div_net)}</div></div>
          <div><div class="kv-label">Comisiones</div><div class="kv-value neg">${eur(ibkr.fees)}</div></div>
          <div><div class="kv-label">Efectivo en cuenta</div><div class="kv-value">${eur(ibkr.cash_final)}</div></div>
          <div><div class="kv-label">Dividendo devengado pendiente</div><div class="kv-value">${eur(ibkr.accrued_div)}</div></div>
        </div>
        <p class="footnote">Cifras tal y como las calcula Interactive Brokers en su propio extracto de actividad; ya vienen convertidas a euros. Efectivo: ${eur(ibkr.cash_eur)} en EUR + ${num(ibkr.cash_usd,2)} USD. Importa los informes de actividad en CSV con «Importar extractos» para ponerlas al día.</p>
      </div>`;
      return;
    }
    const cash = Object.keys(ibkr.cash_by_cur || {}).filter(k=>Math.abs(ibkr.cash_by_cur[k]) >= 0.005).map(k=>`${nf2.format(ibkr.cash_by_cur[k])} ${k}`).join(' + ') || '0 EUR';
    const twr = sts.filter(x=>x.twr_pct != null).map(x=>`${pct(x.twr_pct,2)} (${isoLabel(x.start)} – ${isoLabel(x.end)})`).join(', ');
    const actions = (ibkr.corporate_actions || []).map(a=>`${esc(a.desc.replace(/^[^)]*\)\s*/, '').replace(/\s*\(.*$/, ''))} de ${esc((a.desc.match(/^([^(]+)\(/) || [,''])[1])} el ${isoLabel(a.date)}`).join('; ');
    c.innerHTML = head + `
      <div class="acct-body">
        <div class="kv-grid">
          <div><div class="kv-label">Valor de la cuenta</div><div class="kv-value">${eur(ibkr.nav_final)}</div></div>
          <div><div class="kv-label">Rentabilidad anualizada (TIR)</div><div class="kv-value ${sg(ibkr.xirr_pct)}">${ibkr.xirr_pct != null ? pct(ibkr.xirr_pct,2) : '—'}</div></div>
          <div><div class="kv-label">Aportaciones netas</div><div class="kv-value">${eur(ibkr.contributions)}</div></div>
          <div><div class="kv-label">Resultado total (histórico)</div><div class="kv-value ${sg(ibkr.result)}">${eur(ibkr.result, {forceSign:true})}</div></div>
          <div><div class="kv-label">Acciones: coste → valor</div><div class="kv-value"><span class="nowrap">${eur(ibkr.stocks_cost)}</span> → <span class="nowrap">${eur(ibkr.stocks_value)}</span></div></div>
          <div><div class="kv-label">Plusvalía no realizada</div><div class="kv-value ${sg(ibkr.stocks_pl)}">${eur(ibkr.stocks_pl,{forceSign:true})}</div></div>
          <div><div class="kv-label">Dividendos netos</div><div class="kv-value ${sg(ibkr.div_net)}">${eur(ibkr.div_net)}</div></div>
          <div><div class="kv-label">Comisiones</div><div class="kv-value ${sg(ibkr.fees)}">${eur(ibkr.fees)}</div></div>
          <div><div class="kv-label">P/L realizado histórico</div><div class="kv-value ${sg(ibkr.realized_pl)}">${eur(ibkr.realized_pl,{forceSign:true})}</div></div>
          <div><div class="kv-label">Efectivo en cuenta</div><div class="kv-value">${eur(ibkr.cash_final)}</div></div>
        </div>
        <p class="footnote"><b>Valor al ${isoLabel(ibkr.period_end)}</b>, fecha en que termina el último informe importado: posiciones, precios y efectivo (${esc(cash)}${Math.abs(ibkr.accrued_div) >= 0.005 ? `, más ${eur(ibkr.accrued_div)} de dividendo devengado` : ''}) son los de ese informe. Aportaciones, dividendos, comisiones y resultado realizado se suman operación a operación entre todos los informes, sin repetir lo que se solapa. El resultado total es el valor de la cuenta menos lo aportado, así que incluye también el efecto del tipo de cambio.</p>
        <p class="footnote" style="margin-top:8px;">La TIR la calcula la aplicación con el mismo método que la de DEGIRO, para que las dos sean comparables.${twr ? ` Rentabilidad ponderada por tiempo que da IBKR en cada informe: ${twr}.` : ''}${actions ? ` Operaciones corporativas: ${actions}.` : ''}</p>
      </div>`;
  })();

  (function(){
    const c = document.getElementById('degiro-card');
    c.innerHTML = `
      <div class="acct-head">
        <span class="acct-swatch" style="background:var(--degiro)"></span>
        <div>
          <div class="acct-name">DEGIRO</div>
          <div class="acct-meta">flatex Bank · historial ${isoLabel(combined.degiro_date_min)} – ${isoLabel(combined.degiro_date_max)}${combined.degiro_movements_count ? ` · ${num(combined.degiro_movements_count,0)} movimientos` : ''}</div>
        </div>
      </div>
      <div class="acct-body">
        <div class="kv-grid">
          <div><div class="kv-label">Valor de las posiciones <span class="approx-flag">hoy</span></div><div class="kv-value">${eur(combined.degiro_value_total)}</div></div>
          <div><div class="kv-label">Rentabilidad anualizada (TIR)</div><div class="kv-value ${sg(combined.degiro_xirr_pct)}">${pct(combined.degiro_xirr_pct,2)}</div></div>
          <div><div class="kv-label">Aportaciones netas</div><div class="kv-value">${eur(combined.degiro_contributions)}</div></div>
          <div><div class="kv-label">Resultado total (histórico)</div><div class="kv-value ${sg(combined.degiro_total_return)}">${eur(combined.degiro_total_return,{forceSign:true})}</div></div>
          <div><div class="kv-label">Posiciones: coste → valor</div><div class="kv-value"><span class="nowrap">${eur(combined.degiro_open_cost_total)}</span> → <span class="nowrap">${eur(combined.degiro_value_total)}</span></div></div>
          <div><div class="kv-label">Plusvalía no realizada</div><div class="kv-value ${sg(combined.degiro_unrealized_pl)}">${eur(combined.degiro_unrealized_pl,{forceSign:true})} <span class="approx-flag">(${pct(combined.degiro_unrealized_pct,1)})</span></div></div>
          <div><div class="kv-label">Dividendos netos</div><div class="kv-value ${sg(combined.degiro_div_net)}">${eur(combined.degiro_div_net)}${dividends.some(d=>d.account==='DEGIRO' && d.approx) ? ' <span class="approx-flag">≈</span>' : ''}</div></div>
          <div><div class="kv-label">Comisiones y costes</div><div class="kv-value neg">${eur(combined.degiro_fees)}</div></div>
          <div><div class="kv-label">P/L realizado histórico</div><div class="kv-value ${sg(combined.degiro_realized_total)}">${eur(combined.degiro_realized_total,{forceSign:true})}</div></div>
          <div><div class="kv-label">Interés cuenta de efectivo</div><div class="kv-value ${sg(combined.degiro_interest)}">${eur(combined.degiro_interest)}</div></div>
        </div>
        <p class="footnote"><b>Valor y rentabilidad al ${DATA.live_meta.fetched_date_long || DATA.live_meta.fetched_date}:</b> el extracto de DEGIRO no trae cotizaciones, así que el valor de las ${degiro_open_positions.length} posiciones se ha calculado con precios de mercado ${DATA.live_meta.manual ? 'introducidos manualmente por ti' : 'consultados en Alpha Vantage'} (detalle en la tabla de posiciones y al pie de página) — a diferencia del resto de la página, que sale íntegramente de tus documentos. La TIR es la rentabilidad anualizada equivalente considerando cuándo se hizo cada aportación (método TIR/XIRR)${ibkr.xirr_pct != null && (ibkr.statements || []).length ? ', el mismo método que en la tarjeta de Interactive Brokers' : ', la misma idea que la rentabilidad ponderada de IBKR pero con metodología distinta, así que no son directamente comparables cifra a cifra'}. Se recalcula cada vez que actualizas los precios o registras un movimiento, tomando como fecha de valoración el día de la última actualización de precios.</p>
        <p class="footnote" style="margin-top:8px;"><b>Efectivo en DEGIRO:</b> ${eur(combined.degiro_cash_wallet)} según el último saldo del extracto y los movimientos registrados después. ${combined.degiro_cash_wallet < -0.005 ? `Es un saldo deudor: se ha comprado por encima del efectivo disponible y DEGIRO cobra intereses por él (los ${eur(combined.degiro_interest)} de «Interés cuenta de efectivo»). El valor total de la cartera ya lo descuenta.` : 'El valor total de la cartera lo incluye.'}</p>
      </div>`;
  })();

  /* ================= TABLES ================= */

  // IBKR positions
  (function(){
    const t = document.getElementById('ibkr-positions-table');
    let thead = `<thead><tr>
      <th>Valor</th><th class="num">Cantidad</th><th class="num">Coste/ud.</th><th class="num">Coste total</th>
      <th class="num">Precio</th><th class="num">Valor</th><th class="num">Rent.</th><th class="num">P/L (EUR)</th>
    </tr></thead>`;
    let rows = ibkr.positions.map(p=>{
      const posCls = p.ret_pct>=0?'pos-val':'neg-val';
      return `<tr>
        <td><div class="row-name">${esc(p.sym)}</div><div class="row-sub">${esc(p.name)}</div></td>
        <td class="num">${num(p.qty, p.qty % 1 ? 4 : 0)}</td>
        <td class="num">${num(p.cost_u,2)} ${p.cur}</td>
        <td class="num">${num(p.cost_tot,2)} ${p.cur}</td>
        <td class="num">${num(p.price,2)} ${p.cur}</td>
        <td class="num">${num(p.value,2)} ${p.cur}</td>
        <td class="num ${posCls}">${pct(p.ret_pct,2)}</td>
        <td class="num ${posCls}">${eur(p.pl_eur,{forceSign:true})}</td>
      </tr>`;
    }).join('');
    t.innerHTML = thead + `<tbody>${rows}</tbody>`;
  })();

  // DEGIRO positions
  (function(){
    const t = document.getElementById('degiro-positions-table');
    let thead = `<thead><tr>
      <th>Valor</th><th class="num">Cantidad</th><th class="num">Coste total</th>
      <th class="num">Precio hoy</th><th class="num">Valor hoy</th><th class="num">Rent.</th><th class="num">P/L (EUR)</th>
    </tr></thead>`;
    let rows = degiro_open_positions.slice().sort((a,b)=>(b.live_value_eur||0)-(a.live_value_eur||0)).map(p=>{
      const hasLive = p.live_price_eur != null;
      const posCls = hasLive ? (p.live_pl_pct>=0?'pos-val':'neg-val') : '';
      return `<tr>
        <td><div class="row-name">${esc(p.name)}</div><div class="row-sub">${p.isin} · última operación registrada: ${p.last_price} ${p.last_price_cur} (${fmtDateEs(p.last_price_date)})</div></td>
        <td class="num">${num(p.qty,0)}</td>
        <td class="num">${eur(p.cost_total)}</td>
        <td class="num">${hasLive ? `${num(p.live_price,2)} ${p.live_price_cur}` : '—'}</td>
        <td class="num">${hasLive ? eur(p.live_value_eur) : '—'}</td>
        <td class="num ${posCls}">${hasLive ? pct(p.live_pl_pct,1) : '—'}</td>
        <td class="num ${posCls}">${hasLive ? eur(p.live_pl_eur,{forceSign:true}) : '—'}</td>
      </tr>`;
    }).join('');
    t.innerHTML = thead + `<tbody>${rows}</tbody>`;
  })();

  // Dividends
  (function(){
    const t = document.getElementById('dividends-table');
    let thead = `<thead><tr>
      <th>Cuenta</th><th>Valor</th><th class="num">Bruto</th><th class="num">Retención</th><th class="num">Neto</th>
    </tr></thead>`;
    let rows = dividends.map(d=>{
      const net = d.gross_eur + d.tax_eur;
      const chip = d.account==='IBKR' ? 'chip-ibkr' : 'chip-degiro';
      return `<tr>
        <td><span class="chip ${chip}">${d.account}</span></td>
        <td class="row-name">${esc(d.name)}</td>
        <td class="num">${d.approx?'≈ ':''}${eur(d.gross_eur)}</td>
        <td class="num neg-val">${d.approx?'≈ ':''}${eur(d.tax_eur)}</td>
        <td class="num pos-val">${d.approx?'≈ ':''}${eur(net)}</td>
      </tr>`;
    }).join('');
    t.innerHTML = thead + `<tbody>${rows}</tbody>`;
  })();

  // Realized
  (function(){
    const t = document.getElementById('realized-table');
    let thead = `<thead><tr><th>Valor</th><th class="num">Resultado realizado</th></tr></thead>`;
    let rows = degiro_realized.slice().reverse().map(r=>{
      const cls = r.pl>=0?'pos-val':'neg-val';
      return `<tr><td class="row-name">${esc(r.name)}</td><td class="num ${cls}">${eur(r.pl,{forceSign:true})}</td></tr>`;
    }).join('');
    t.innerHTML = thead + `<tbody>${rows}</tbody>`;
  })();

  /* ================= PRICE SOURCES FOOTNOTE ================= */
  (function(){
    const lm = DATA.live_meta || {};
    const dateLong = lm.fetched_date_long || lm.fetched_date || '';
    const isManual = !!lm.manual;

    const el2 = document.getElementById('price-sources');
    if (el2){
      el2.innerHTML = isManual
        ? `Precios introducidos manualmente por ti el ${dateLong}.`
        : degiro_open_positions.map(p=>`${esc(p.name)} — ${esc(p.live_src||'—')}`).join('; ') + '.';
    }
    const fxText = Object.keys(lm.fx || {}).filter(k=>k!=='EUR').map(k=>`${new Intl.NumberFormat('es-ES',{minimumFractionDigits:2, maximumFractionDigits:4}).format(lm.fx[k])} ${k}`).join(' · ');
    const headingEl = document.getElementById('price-sources-heading');
    if (headingEl){
      headingEl.textContent = `${isManual ? 'Precios de DEGIRO introducidos a mano' : 'Fuentes de precios de mercado (DEGIRO)'} — ${dateLong}`;
    }
    const fxNoteEl = document.getElementById('fx-note');
    if (fxNoteEl){
      fxNoteEl.textContent = `Tipos de cambio usados para pasar estos precios a euros (${dateLong}): 1 EUR = ${fxText}.`;
    }
    const closingEl = document.getElementById('footer-closing-note');
    if (closingEl){
      closingEl.textContent = `Movimientos de DEGIRO registrados hasta el ${isoLabel(combined.degiro_date_max)}; precios de mercado del ${dateLong}. Los datos están en ${STATUS.dataFile} dentro de la carpeta de la aplicación: cada guardado deja una copia de seguridad y, si la carpeta es un repositorio git, un commit.`;
    }
    const tableNoteEl = document.getElementById('degiro-table-note');
    if (tableNoteEl){
      tableNoteEl.innerHTML = isManual
        ? `<b>El extracto de DEGIRO no incluye valoración de posiciones</b> — el coste sí es exacto (suma real de los flujos de caja en euros de cada compra, con comisiones), pero «Precio hoy» y «Valor hoy» son precios que introdujiste tú el ${dateLong} (ver «Precios de DEGIRO introducidos a mano» al pie de página), no datos de tu extracto. Por eso esta tabla mezcla dos procedencias: trátala como una foto de ese momento, no como parte del histórico documental del resto de la página.`
        : `<b>El extracto de DEGIRO no incluye valoración de posiciones</b> — el coste sí es exacto (suma real de los flujos de caja en euros de cada compra, con comisiones), pero «Precio hoy» y «Valor hoy» son cotizaciones de mercado consultadas el ${dateLong} en Alpha Vantage o introducidas a mano (ver «Fuentes de precios» al pie de página), no datos de tu extracto. Por eso esta tabla mezcla dos procedencias: trátala como una foto de ese momento, no como parte del histórico documental del resto de la página.`;
    }
  })();

  /* ================= CHARTS ================= */
  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs){
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function cssVar(name){
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }

  /* ================= DISTRIBUCIÓN: rueda con el peso de cada valor ================= */
  // Una entrada por valor (ISIN), sumando las dos cuentas, todo en euros.
  function holdingsByIsin(){
    const fx = (DATA.live_meta && DATA.live_meta.fx) || {};
    const map = new Map();
    const add = (key, part) => {
      if (!map.has(key)){
        map.set(key, { key, isin: part.isin, name: part.name, cur: part.cur, value: 0, cost: 0, pl: 0, parts: [] });
      }
      const h = map.get(key);
      if (part.account === 'DEGIRO') h.name = part.name; // el nombre de DEGIRO es el más legible
      h.value += part.value; h.cost += part.cost; h.pl += part.pl;
      h.parts.push(part);
    };
    degiro_open_positions.forEach(p=>{
      add(p.isin, { account:'DEGIRO', isin:p.isin, name:p.name, qty:p.qty, price:p.live_price, cur:p.live_price_cur,
        value:p.live_value_eur || 0, cost:p.cost_total, pl:p.live_pl_eur || 0 });
    });
    // IBKR: valor en euros del propio informe; si no viene, con el tipo de cambio guardado y
    // ajustado para que la suma coincida con el valor de las acciones que da el informe.
    const ib = ibkr.positions.map(p=>{
      let value = p.value_eur;
      if (value == null){ const rate = p.cur === 'EUR' ? 1 : fx[p.cur]; value = rate ? p.value / rate : 0; }
      return { p, value };
    });
    const ibSum = ib.reduce((a,x)=>a + x.value, 0);
    const k = ibSum > 0 && ibkr.stocks_value > 0 && ib.some(x=>x.p.value_eur == null) ? ibkr.stocks_value / ibSum : 1;
    ib.forEach(({p, value})=>{
      const v = value * k;
      const pl = p.pl_eur || 0;
      add(p.isin || ('IBKR:' + p.sym), { account:'IBKR', isin:p.isin || p.sym, name:p.name, qty:p.qty, price:p.price, cur:p.cur,
        value:v, cost: p.cost_eur != null ? p.cost_eur : v - pl, pl });
    });
    const list = Array.from(map.values()).filter(h=>h.value > 0).sort((a,b)=>b.value - a.value);
    const total = list.reduce((a,h)=>a + h.value, 0);
    list.forEach(h=>{ h.share = total ? h.value / total * 100 : 0; h.plPct = h.cost ? h.pl / h.cost * 100 : 0; });
    return { list, total };
  }

  (function(){
    const svgEl = document.getElementById('donut');
    const center = document.getElementById('donut-center');
    const listEl = document.getElementById('dist-list');
    if (!svgEl || !listEl) return;
    const { list, total } = holdingsByIsin();
    if (!list.length){
      document.getElementById('distribucion').querySelector('.dist-card').innerHTML = '<p class="footnote">No hay posiciones abiertas.</p>';
      return;
    }

    // Ocho colores fijos (paleta validada para daltonismo en claro y oscuro). Del noveno al
    // decimosexto valor se repiten esos colores con rayas, para que cada valor tenga su sector;
    // a partir del decimoséptimo se agrupan en «Otros», que sigue desglosado en la lista.
    const SOLID = 8, MAX = 16;
    const named = list.length > MAX + 1 ? list.slice(0, MAX) : list.slice(0, MAX + 1);
    const rest = list.slice(named.length);
    const slices = named.map((h,i)=>{
      const k = (i % SOLID) + 1, hatched = i >= SOLID;
      return { h, k, hatched, color: hatched ? `url(#hatch-${k})` : `var(--series-${k})`,
        swatch: hatched ? `repeating-linear-gradient(45deg, var(--series-${k}) 0 3px, var(--card-bg-raised) 3px 5px)` : `var(--series-${k})`,
        share:h.share, value:h.value };
    });
    if (list.length === MAX + 1) slices.pop();
    if (rest.length || list.length === MAX + 1){
      const others = list.slice(slices.length);
      const v = others.reduce((a,h)=>a + h.value, 0);
      slices.push({ other:others, color:'var(--series-other)', swatch:'var(--series-other)', share: v / total * 100, value: v });
    }
    list.forEach(h=>{ const s = slices.find(x=>x.h === h || (x.other && x.other.includes(h))); h.slice = s; });

    const nMulti = list.filter(h=>h.parts.length > 1);
    document.getElementById('note-distribution').textContent =
      `${list.length} valores · ${eur(total)} en posiciones`;
    document.getElementById('dist-footnote').innerHTML =
      `Peso de cada valor sobre el valor de todas las posiciones${BOTH ? ' de las dos cuentas' : ''}, sin contar el efectivo. ` +
      (nMulti.length ? `${nMulti.map(h=>esc(h.name)).join(', ')} ${nMulti.length === 1 ? 'está' : 'están'} en las dos cuentas y aparece${nMulti.length === 1 ? '' : 'n'} una sola vez, sumado. ` : '') +
      [HAS.degiro ? `Precios de DEGIRO del ${esc(DATA.live_meta.fetched_date)}` : '', HAS.ibkr ? `${HAS.degiro ? 'los' : 'Precios'} de Interactive Brokers, del ${isoLabel(ibkr.period_end)}` : ''].filter(Boolean).join('; ') + `. Pasa el ratón (o toca) por la rueda o por la lista para ver el detalle de cada valor.`;

    /* ---- geometría ---- */
    const C = 160, R = 150, r = 96;
    const pt = (rad, a) => [C + rad * Math.cos(a), C + rad * Math.sin(a)];
    function arcPath(a0, a1){
      if (a1 - a0 >= Math.PI * 2 - 1e-6){ // un solo valor: anillo completo en dos mitades
        const m = a0 + Math.PI;
        return arcPath(a0, m) + ' ' + arcPath(m, a1);
      }
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0,y0] = pt(R,a0), [x1,y1] = pt(R,a1), [x2,y2] = pt(r,a1), [x3,y3] = pt(r,a0);
      return `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${r},${r} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
    }
    svgEl.innerHTML = '';
    svgEl.setAttribute('aria-label', 'Distribución de la cartera: ' + list.map(h=>`${h.name} ${nf2.format(h.share)} %`).join(', '));
    const defs = svg('defs', {});
    for (let k = 1; k <= SOLID; k++){
      const pat = svg('pattern', { id:`hatch-${k}`, patternUnits:'userSpaceOnUse', width:6, height:6, patternTransform:'rotate(45)' });
      pat.appendChild(svg('rect', { width:6, height:6, style:`fill:var(--series-${k})` }));
      pat.appendChild(svg('rect', { width:2.2, height:6, style:'fill:var(--card-bg-raised)' }));
      defs.appendChild(pat);
    }
    svgEl.appendChild(defs);
    const gSlices = svg('g', {});
    const gLabels = svg('g', { 'pointer-events':'none' });
    svgEl.appendChild(gSlices); svgEl.appendChild(gLabels);
    let a = -Math.PI / 2;
    slices.forEach((s)=>{
      const span = s.value / total * Math.PI * 2;
      s.a0 = a; s.a1 = a + span; s.mid = a + span / 2; a += span;
      s.path = svg('path', { d: arcPath(s.a0, s.a1), class:'donut-slice', style:`fill:${s.color}` });
      gSlices.appendChild(s.path);
      if (s.share >= 4.5 && !s.hatched && !s.other){
        const [lx, ly] = pt((R + r) / 2, s.mid);
        const t = svg('text', { x:lx.toFixed(1), y:ly.toFixed(1), class:'donut-pct', 'text-anchor':'middle', 'dominant-baseline':'central' });
        t.textContent = nf0.format(Math.round(s.share)) + ' %';
        s.label = t; gLabels.appendChild(t);
      }
    });
    // El texto de cada porcentaje, oscuro o blanco según el color real del sector (cambia en modo oscuro).
    function paintLabels(){
      slices.forEach(s=>{
        if (!s.label) return;
        const rgb = getComputedStyle(s.path).fill.match(/\d+(\.\d+)?/g);
        if (!rgb) return;
        const lin = rgb.slice(0,3).map(Number).map(v=>{ v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
        s.label.setAttribute('class', 'donut-pct ' + (L > 0.3 ? 'on-light' : 'on-dark'));
      });
    }
    paintLabels();
    themeListeners.push(paintLabels);

    /* ---- lista (hace de leyenda y de tabla) ---- */
    listEl.innerHTML = list.map((h,i)=>{
      const accounts = h.parts.map(p=>p.account).join(' + ');
      const qtyTxt = h.parts.length > 1
        ? h.parts.map(p=>`${num(p.qty, p.qty % 1 ? 4 : 0)} en ${p.account}`).join(' · ')
        : `${num(h.parts[0].qty, h.parts[0].qty % 1 ? 4 : 0)} títulos`;
      return `<li class="dist-row" tabindex="0" data-i="${i}">
        <span class="dist-swatch" style="background:${h.slice.swatch}"></span>
        <span class="dist-name"><span class="dist-title">${esc(h.name)}</span><span class="row-sub">${esc(accounts)} · ${qtyTxt}</span></span>
        <span class="dist-value">${eur(h.value)}</span>
        <span class="dist-share">${nf2.format(h.share)} %</span>
      </li>`;
    }).join('');
    const rows = Array.from(listEl.children);

    /* ---- centro y resaltado ---- */
    function centerDefault(){
      center.innerHTML = `<span class="dc-label">Valor de las posiciones</span><span class="dc-value">${eurShort(total)}</span><span class="dc-sub">${list.length} valores</span>`;
    }
    function centerFor(s){
      if (s.other){
        center.innerHTML = `<span class="dc-label">Otros ${s.other.length} valores</span><span class="dc-value">${nf2.format(s.share)} %</span><span class="dc-sub">${eurShort(s.value)}</span>`;
      } else {
        center.innerHTML = `<span class="dc-label">${esc(s.h.name)}</span><span class="dc-value">${nf2.format(s.share)} %</span><span class="dc-sub">${eurShort(s.value)}</span>`;
      }
    }
    function highlight(s, rowHolding){
      slices.forEach(x=>{
        const on = x === s;
        x.path.classList.toggle('is-dim', !!s && !on);
        x.path.classList.toggle('is-on', !!s && on);
        const off = on ? 7 : 0;
        x.path.setAttribute('transform', off ? `translate(${(Math.cos(x.mid) * off).toFixed(2)},${(Math.sin(x.mid) * off).toFixed(2)})` : '');
        if (x.label) x.label.setAttribute('transform', x.path.getAttribute('transform') || '');
      });
      rows.forEach((row,i)=>{
        const h = list[i];
        row.classList.toggle('is-on', !!s && (rowHolding ? h === rowHolding : h.slice === s));
      });
      if (s) centerFor(rowHolding ? { h: rowHolding, share: rowHolding.share, value: rowHolding.value } : s); else centerDefault();
    }

    function detailHtml(h){
      const lines = [`<b>${esc(h.name)}</b>`, `${nf2.format(h.share)} % de la cartera · ${eur(h.value)}`];
      h.parts.forEach(p=>{
        const pre = h.parts.length > 1 ? `${p.account}: ` : '';
        lines.push(`${pre}${num(p.qty, p.qty % 1 ? 4 : 0)} títulos a ${new Intl.NumberFormat('es-ES',{minimumFractionDigits:2, maximumFractionDigits:4}).format(p.price)} ${esc(p.cur)}${h.parts.length > 1 ? ` · ${eur(p.value)}` : ''}`);
      });
      lines.push(`Coste ${eur(h.cost)} · plusvalía ${eur(h.pl,{forceSign:true})} (${pct(h.plPct,1)})`);
      lines.push(`<span class="tt-sub">${esc(h.isin)}${h.parts.length === 1 ? ' · ' + h.parts[0].account : ''}</span>`);
      return lines.join('<br>');
    }
    function otherHtml(s){
      return [`<b>Otros ${s.other.length} valores</b>`, `${nf2.format(s.share)} % de la cartera · ${eur(s.value)}`]
        .concat(s.other.map(h=>`${esc(h.name)}: ${nf2.format(h.share)} %`)).join('<br>');
    }

    slices.forEach(s=>{
      s.path.addEventListener('mousemove', (ev)=>{
        highlight(s);
        showTooltip(ev.clientX, ev.clientY, s.other ? otherHtml(s) : detailHtml(s.h));
      });
      s.path.addEventListener('mouseleave', ()=>{ highlight(null); hideTooltip(); });
      // En pantallas táctiles no hay «ratón encima»: un toque muestra el detalle.
      s.path.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        highlight(s);
        showTooltip(ev.clientX, ev.clientY, s.other ? otherHtml(s) : detailHtml(s.h));
      });
    });
    document.addEventListener('click', (ev)=>{ if (!svgEl.contains(ev.target)){ hideTooltip(); if (!listEl.contains(ev.target)) highlight(null); } });
    rows.forEach((row,i)=>{
      const h = list[i];
      const on = ()=>highlight(h.slice, h);
      row.addEventListener('mouseenter', on);
      row.addEventListener('focus', on);
      row.addEventListener('mouseleave', ()=>highlight(null));
      row.addEventListener('blur', ()=>highlight(null));
      row.title = '';
    });
    centerDefault();
  })();

  /* ================= EVOLUCIÓN FRENTE A LOS ÍNDICES ================= */
  (function(){
    const body = document.getElementById('bench-body');
    if (!body) return;
    const B = PAYLOAD.benchmark;
    const BENCHES = CONFIG.benchmarks || [];
    const names = BENCHES.map(b=>b.name).join(' y ') || 'los índices';
    // Colores que no se confunden con el de tu cartera (verde): violeta, ámbar, azul, rosa.
    const SERIES_COLORS = ['var(--series-7)', 'var(--series-4)', 'var(--series-1)', 'var(--series-5)'];
    // Tramos: la misma gráfica, con zoom a ese periodo.
    const RANGES = [
      { id:'1D', short:'1 D', long:'Último día', days:1 },
      { id:'1S', short:'1 S', long:'Última semana', days:7 },
      { id:'1M', short:'1 M', long:'Último mes', months:1 },
      { id:'3M', short:'3 M', long:'Últimos 3 meses', months:3 },
      { id:'6M', short:'6 M', long:'Últimos 6 meses', months:6 },
      { id:'1A', short:'1 A', long:'Último año', months:12 },
      { id:'3A', short:'3 A', long:'Últimos 3 años', months:36 },
      { id:'TOTAL', short:'Total', long:'Desde la primera aportación' },
    ];
    const STORE_KEY = 'cartera:bench-range';
    let current = 'TOTAL';
    try { const v = localStorage.getItem(STORE_KEY); if (RANGES.some(r=>r.id === v)) current = v; } catch (e) { /* sin preferencia guardada */ }

    function refreshButton(label){
      return `<button type="button" class="btn-secondary" id="bench-refresh">${label}</button><span class="modal-status" id="bench-status"></span>`;
    }
    function wireRefresh(){
      const btn = document.getElementById('bench-refresh');
      if (!btn) return;
      btn.addEventListener('click', async ()=>{
        const st = document.getElementById('bench-status');
        btn.disabled = true; st.style.color = ''; st.textContent = 'Descargando el histórico de los índices…';
        try {
          const r = await api('POST', '/api/indices/refresh', {});
          reloadWithToast(r.saved);
        } catch (err){
          st.textContent = err.message; st.style.color = 'var(--critical)'; btn.disabled = false;
        }
      });
    }

    if (!B || B.error){
      body.innerHTML = `<div class="card bench-empty">
        <p>${B && B.error ? esc(B.error) : `Para comparar tu cartera con ${esc(names)} hace falta descargar una vez su histórico desde Alpha Vantage (unas ${BENCHES.length * 2 + 2} consultas de las 25 diarias del plan gratuito). Se guarda en tu carpeta y después funciona sin conexión.`}</p>
        <div class="bench-actions">${STATUS.hasApiKey ? refreshButton('↻ Descargar datos de los índices') : '<span class="row-sub">Primero configura tu clave de Alpha Vantage en «Actualizar precios».</span>'}</div>
      </div>`;
      wireRefresh();
      return;
    }

    const P = B.portfolio;
    const colorOf = (i)=>SERIES_COLORS[i % SERIES_COLORS.length];
    /* ---- tabla de comparación (siempre desde el principio) ---- */
    const round2c = (n)=>Math.round(n * 100) / 100;
    const rowFor = (label, swatch, v, gain, gainPct, x, diff, strong) => `<tr${strong ? ' class="bench-me"' : ''}>
        <td><span class="bench-swatch" style="${swatch}"></span>${label}</td>
        <td class="num">${eur(v)}</td>
        <td class="num ${sg(gain)}">${eur(gain,{forceSign:true})}</td>
        <td class="num ${sg(gainPct)}">${gainPct == null ? '—' : pct(gainPct,1)}</td>
        <td class="num ${sg(x)}">${x == null ? '—' : pct(x,1)}</td>
        <td class="num">${diff == null ? '<span class="row-sub">—</span>' : `<span class="${sg(diff)}">${eur(diff,{forceSign:true})}</span>`}</td>
      </tr>`;
    const meRow = rowFor('<b>Tu cartera</b>', 'background:var(--brand); border-radius:50%;', P.value, P.gain, P.gainPct, P.xirr, null, true);
    const bRows = B.series.map((s,i)=>rowFor(`${esc(s.name)} <span class="row-sub">(${esc(s.symbol)})</span>`, `background:${colorOf(i)}`,
      s.final, s.gain, s.gainPct, s.xirr, round2c(P.value - s.final), false)).join('');
    const verdict = B.series.map(s=>{
      const d = P.value - s.final;
      return Math.abs(d) < 0.5 ? `igual que ${esc(s.name)}` : `<b class="${sg(d)}">${eur(Math.abs(d))} ${d > 0 ? 'por delante' : 'por detrás'}</b> de ${esc(s.name)}`;
    });
    const verdictTxt = verdict.length > 1 ? verdict.slice(0, -1).join(', ') + ' y ' + verdict[verdict.length - 1] : verdict[0];

    body.innerHTML = `
      <div class="card bench-card">
        <p class="bench-verdict">Con las mismas aportaciones (${eur(P.contributed)} netos desde el ${isoLabel(B.start)}), tu cartera va ${verdictTxt}.</p>
        <div class="table-scroll"><table class="bench-table">
          <thead><tr><th></th><th class="num">Valor</th><th class="num">Ganancia</th><th class="num">Sobre lo aportado</th><th class="num">TIR anual</th><th class="num">Tu cartera frente al índice</th></tr></thead>
          <tbody>${meRow}${bRows}</tbody>
        </table></div>
      </div>
      <div class="chart-card" style="margin-top:14px;">
        <div class="bench-toolbar">
          <div class="type-tabs bench-tabs" role="group" aria-label="Periodo de la gráfica">
            ${RANGES.map(r=>`<button type="button" class="type-tab" data-range="${r.id}" title="${esc(r.long)}" aria-pressed="false">${r.short}</button>`).join('')}
          </div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-swatch" style="background:var(--brand); border-radius:50%; width:9px; height:9px;"></span>Tu cartera</span>
            ${B.series.map((s,i)=>`<span class="legend-item"><span class="legend-line" style="background:${colorOf(i)}"></span>${esc(s.name)}</span>`).join('')}
            <span class="legend-item legend-contrib"><span class="legend-line dashed"></span>Aportaciones netas</span>
          </div>
        </div>
        <p class="bench-range" id="bench-range"></p>
        <div class="chart-wrap" id="bench-chart"></div>
      </div>
      <div class="bench-foot">
        <span class="row-sub">Índices hasta el ${isoLabel(B.asOf)}${B.fetched ? ` · descargados el ${isoLabel(B.fetched)}` : ''}</span>
        ${STATUS.hasApiKey ? refreshButton('↻ Actualizar índices') : ''}
      </div>
      <p class="footnote">Cada línea de índice es lo que valdría tu dinero si cada aportación (y cada retirada) se hubiera hecho ese mismo día en un fondo que replica el índice: ${B.series.map(s=>`${esc(s.symbol)} para el ${esc(s.name)}`).join(' y ')}, con los dividendos reinvertidos y pasado a euros con el tipo de cambio de cada día. No incluye comisiones ni impuestos. La TIR tiene en cuenta cuándo entró cada euro, así que es la cifra más justa para comparar. <b>Tu cartera</b> tiene un punto por cada día en que actualizas (la aplicación guarda una foto de su valor en cada guardado), así que su línea se va completando sola; el de hoy usa ${[HAS.degiro ? `los precios de DEGIRO del ${esc(DATA.live_meta.fetched_date)}` : '', HAS.ibkr ? `el último informe de IBKR (${isoLabel(ibkr.period_end)})` : ''].filter(Boolean).join(' y ')}. Al elegir un periodo, todas las líneas empiezan en 0 € ese día y muestran lo que han ganado desde entonces sin contar lo aportado; el % es la rentabilidad del periodo (lo aportado a mitad de periodo cuenta solo por el tiempo que estuvo invertido). Para un día o una semana hacen falta los cierres diarios de los índices, que llegan con «Actualizar precios» y «Actualizar índices».</p>`;
    wireRefresh();

    body.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click', ()=>{
      current = btn.dataset.range;
      try { localStorage.setItem(STORE_KEY, current); } catch (e) { /* da igual */ }
      draw();
    }));

    /* ---- datos de la gráfica ---- */
    const DAY = 86400000;
    const t = (iso)=>Date.parse(iso + 'T00:00:00Z');
    const dates = B.dates.map(t);
    const hist = P.history.map(h=>({ t: t(h.date), date: h.date, value: h.value, contributions: h.contributions }));
    const tFirst = dates[0], tEnd = Math.max(dates[dates.length - 1], hist.length ? hist[hist.length - 1].t : 0);
    // Valor de una serie en un instante (interpolando entre cierres) y aportado en ese instante (escalón).
    function interp(values, tt){
      if (tt <= dates[0]) return values[0];
      for (let i = 1; i < dates.length; i++){
        if (dates[i] >= tt){ const f = (tt - dates[i-1]) / (dates[i] - dates[i-1]); return values[i-1] + (values[i] - values[i-1]) * f; }
      }
      return values[values.length - 1];
    }
    function contribAt(tt){ let v = B.contributions[0]; dates.forEach((d,i)=>{ if (d <= tt) v = B.contributions[i]; }); return v; }
    function rangeStart(r){
      if (!r.days && !r.months) return tFirst;
      if (r.id === '1D'){ const prev = dates.filter(d=>d < dates[dates.length - 1]); return prev.length ? prev[prev.length - 1] : tFirst; }
      if (r.days) return tEnd - r.days * DAY;
      const e = new Date(tEnd), s = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - r.months, e.getUTCDate()));
      if (s.getUTCDate() !== e.getUTCDate()) s.setUTCDate(0);
      return s.getTime();
    }
    function niceStep(raw){
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      return [1, 2, 2.5, 5, 10].map(k=>k * mag).find(v=>v >= raw);
    }
    const money = (v, step)=> Math.abs(v) < 1e-9 ? '0 €' : step >= 1000 ? (v / 1000).toFixed(step >= 10000 || v % 1000 === 0 ? 0 : 1).replace('.',',') + 'k €' : Math.round(v).toLocaleString('es-ES') + ' €';

    function legendContrib(show){ const el = body.querySelector('.legend-contrib'); if (el) el.hidden = !show; }

    /**
     * Líneas de ganancia de un periodo: cada una empieza en 0 € en el inicio y suma lo que
     * gana o pierde, descontando lo que entra o sale como aportación. El % es la
     * rentabilidad del periodo (Dietz modificado: lo aportado a mitad de periodo pesa la
     * parte del periodo en que estuvo invertido).
     */
    function gainLines(R, ws, we){
      const span = Math.max(we - ws, DAY);
      const dietz = (v0, flows, gain)=>{
        const denom = v0 + flows.reduce((a,[tt,f])=>a + f * Math.max(0, (we - tt) / span), 0);
        return denom > 0 ? gain / denom * 100 : null;
      };
      const out = [];
      const c0 = contribAt(ws);
      B.series.forEach((s,i)=>{
        const v0 = interp(s.values, ws);
        const pts = [[ws, 0]];
        const flows = [];
        let prevC = c0;
        dates.forEach((d,k)=>{
          if (d <= ws || d > we) return;
          pts.push([d, s.values[k] - v0 - (B.contributions[k] - c0)]);
          if (B.contributions[k] !== prevC){ flows.push([d, B.contributions[k] - prevC]); prevC = B.contributions[k]; }
        });
        const gain = pts[pts.length - 1][1];
        out.push({ name: s.name, color: colorOf(i), pts, gain, pct: dietz(v0, flows, gain) });
      });
      // Tu cartera: hace falta una foto en (o muy cerca de) el inicio del periodo.
      const tol = (R.days ? 1 : 4) * DAY;
      const h0 = hist.filter(h=>h.t <= ws + tol).pop();
      if (h0 && Math.abs(ws - h0.t) <= tol){
        const later = hist.filter(h=>h.t > h0.t && h.t <= we);
        if (later.length){
          const pts = [[h0.t, 0]].concat(later.map(h=>[h.t, h.value - h0.value - (h.contributions - h0.contributions)]));
          const flows = []; let prev = h0;
          later.forEach(h=>{ if (h.contributions !== prev.contributions) flows.push([h.t, h.contributions - prev.contributions]); prev = h; });
          const gain = pts[pts.length - 1][1];
          out.unshift({ name:'Tu cartera', color:'var(--brand)', me:true, pts, gain, pct: dietz(h0.value, flows, gain),
            note: h0.t < ws - DAY / 2 ? `(desde el ${isoLabel(h0.date)})` : '' });
        }
      }
      return out;
    }

    function drawGains(container, lines, ws, we){
      const W = 1100, H = 340, padL = 70, padR = 200, padT = 16, padB = 30;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const all = lines.flatMap(l=>l.pts.filter(p=>p[0] >= ws - DAY && p[0] <= we).map(p=>p[1])).concat([0]);
      let lo = Math.min(...all), hi = Math.max(...all);
      const pad = Math.max((hi - lo) * 0.08, 10);
      lo -= pad; hi += pad;
      const step = niceStep((hi - lo) / 4);
      lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
      const x = v => padL + (we === ws ? 0 : (v - ws) / (we - ws)) * plotW;
      const y = v => padT + plotH - (v - lo) / (hi - lo) * plotH;
      const s = svg('svg', { viewBox:`0 0 ${W} ${H}`, class:'chart', preserveAspectRatio:'none' });
      container.appendChild(s);
      const defs = svg('defs', {}); const cp = svg('clipPath', { id:'bench-clip-g' });
      cp.appendChild(svg('rect', { x:padL, y:padT - 8, width:plotW, height:plotH + 16 }));
      defs.appendChild(cp); s.appendChild(defs);
      for (let v = lo; v <= hi + step / 2; v += step){
        const yy = y(v), zero = Math.abs(v) < step / 2;
        s.appendChild(svg('line', { x1:padL, x2:padL + plotW, y1:yy, y2:yy, class: zero ? 'baseline' : 'gridline' }));
        const lab = svg('text', { x:padL - 8, y:yy + 4, class:'axis-label', 'text-anchor':'end' });
        lab.textContent = zero ? '0 €' : (v > 0 ? '+' : '−') + money(Math.abs(v), step);
        s.appendChild(lab);
      }
      dateTicks(s, ws, we, x, H, padT + plotH);
      const plot = svg('g', { 'clip-path':'url(#bench-clip-g)' });
      // Primero los índices y al final tu cartera, para que quede encima.
      lines.slice().reverse().forEach(l=>{
        let d = '';
        l.pts.forEach((p,j)=>{ d += (j ? ' L' : 'M') + `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`; });
        plot.appendChild(svg('path', { d, fill:'none', style:`stroke:${l.color}`, 'stroke-width': l.me ? 2.5 : 2, 'stroke-linejoin':'round', 'stroke-linecap':'round' }));
        if (l.me) l.pts.forEach((p,j)=>plot.appendChild(svg('circle', { cx:x(p[0]), cy:y(p[1]), r: j === l.pts.length - 1 ? 6 : 4, style:'fill:var(--brand); stroke:var(--card-bg-raised)', 'stroke-width':2 })));
      });
      s.appendChild(plot);
      const ends = lines.map(l=>({ y: y(l.gain), bold: !!l.me, text: `${l.name} · ${(l.gain >= 0 ? '+' : '−') + eurShort(Math.abs(l.gain))}${l.pct == null ? '' : ' (' + pct(l.pct,1) + ')'}` }));
      ends.sort((a,b)=>a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
      const overflow = ends.length ? ends[ends.length - 1].y - (padT + plotH) : 0;
      if (overflow > 0) ends.forEach(e=>{ e.y -= overflow; });
      ends.forEach(e=>{
        const lab = svg('text', { x: padL + plotW + 10, y: e.y + 4, class:'bar-label' + (e.bold ? ' bench-end-me' : '') });
        lab.textContent = e.text;
        s.appendChild(lab);
      });
      // Lectura al pasar el ratón.
      const grid = Array.from(new Set(lines.flatMap(l=>l.pts.map(p=>p[0])).filter(tt=>tt >= ws && tt <= we))).sort((a,b)=>a - b);
      const at = (l, tt)=>{ let v = null; l.pts.forEach(p=>{ if (p[0] <= tt + DAY / 2) v = p; }); return v; };
      const hover = svg('line', { class:'hover-line', y1:padT, y2:padT + plotH });
      s.appendChild(hover);
      const dots = lines.map(l=>{ const c = svg('circle', { r:4, class:'hover-dot', style:`fill:${l.color}` }); s.appendChild(c); return c; });
      const hit = svg('rect', { x:padL, y:padT, width:plotW, height:plotH, fill:'transparent' });
      s.appendChild(hit);
      hit.addEventListener('mousemove', (ev)=>{
        if (!grid.length) return;
        const rect = s.getBoundingClientRect();
        const tt = ws + ((ev.clientX - rect.left) * (W / rect.width) - padL) / plotW * (we - ws);
        let best = grid[0];
        grid.forEach(g=>{ if (Math.abs(g - tt) < Math.abs(best - tt)) best = g; });
        const xx = x(best);
        hover.setAttribute('x1', xx); hover.setAttribute('x2', xx); hover.style.opacity = 1;
        const out = [`<b>${isoLabel(new Date(best).toISOString().slice(0,10))}</b> <span style="opacity:.7">· desde el inicio del periodo</span>`];
        lines.forEach((l,k)=>{
          const p = l.me ? l.pts.find(q=>Math.abs(q[0] - best) <= DAY / 2) : at(l, best);
          if (!p){ dots[k].style.opacity = 0; return; }
          dots[k].setAttribute('cx', x(p[0])); dots[k].setAttribute('cy', y(p[1])); dots[k].style.opacity = 1;
          out.push(`${esc(l.name)}: ${eur(round2c(p[1]),{forceSign:true})}`);
        });
        showTooltip(ev.clientX, ev.clientY, out.join('<br>'));
      });
      hit.addEventListener('mouseleave', ()=>{ hover.style.opacity = 0; dots.forEach(c=>{ c.style.opacity = 0; }); hideTooltip(); });
    }

    // Fechas del eje, según la anchura del periodo.
    function dateTicks(s, ws, we, x, H, baseY){
      const spanDays = (we - ws) / DAY;
      const ticks = [];
      if (spanDays > 400){
        const d0 = new Date(ws), d1 = new Date(we);
        const months = spanDays > 1500 ? [0] : [0, 6];
        for (let yy = d0.getUTCFullYear(); yy <= d1.getUTCFullYear(); yy++) months.forEach(m=>{ const tt = Date.UTC(yy, m, 1); if (tt >= ws && tt <= we) ticks.push([tt, `${MESES[m]} ${String(yy).slice(2)}`]); });
      } else if (spanDays > 70){
        const d0 = new Date(ws);
        const every = spanDays > 200 ? 2 : 1;
        for (let k = 1; k <= 13; k++){ const tt = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1); if (tt > we) break; if ((k - 1) % every === 0){ const m = new Date(tt).getUTCMonth(); ticks.push([tt, `${MESES[m]}${m === 0 ? ' ' + String(new Date(tt).getUTCFullYear()).slice(2) : ''}`]); } }
      } else {
        const inside = dates.filter(d=>d >= ws && d <= we);
        const pick = inside.length <= 8 ? inside : [0,1,2,3,4].map(k=>inside[Math.round(k * (inside.length - 1) / 4)]);
        pick.forEach(tt=>{ const d = new Date(tt); ticks.push([tt, `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`]); });
      }
      ticks.forEach(([tt, txt])=>{
        const lab = svg('text', { x:x(tt), y:H - 8, class:'axis-label', 'text-anchor':'middle' });
        lab.textContent = txt;
        s.appendChild(lab);
        s.appendChild(svg('line', { x1:x(tt), x2:x(tt), y1:baseY, y2:baseY + 4, class:'baseline' }));
      });
    }

    function draw(){
      body.querySelectorAll('[data-range]').forEach(b=>{
        const on = b.dataset.range === current;
        b.classList.toggle('active', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      hideTooltip();
      const R = RANGES.find(r=>r.id === current);
      const container = document.getElementById('bench-chart');
      const info = document.getElementById('bench-range');
      container.innerHTML = '';
      let ws = Math.max(tFirst, rangeStart(R));
      const we = tEnd;
      const needsDaily = !!R.days;
      if (needsDaily && !(B.dailyFrom && t(B.dailyFrom) <= ws)){
        info.innerHTML = '';
        container.innerHTML = `<div class="bench-nodaily">Para ver ${R.id === '1D' ? 'un día' : 'una semana'} hacen falta los cierres diarios de los índices (hasta ahora solo hay semanales). Llegan solos con <b>Actualizar precios</b>, o pulsa <b>Actualizar índices</b> aquí abajo.</div>`;
        return;
      }

      /* ---- periodos: todo empieza en 0 € y se ve lo ganado desde el inicio, sin contar lo aportado ---- */
      if (R.id === 'TOTAL'){
        info.innerHTML = hist.length < 3
          ? `<span class="bench-range-label">Tu cartera tiene ${hist.length === 1 ? 'solo el punto de hoy' : 'solo ' + hist.length + ' puntos'} (el círculo verde de la derecha): las líneas son los índices. La tuya se irá dibujando con cada actualización.</span>`
          : '';
        legendContrib(true);
      } else {
        legendContrib(false);
        const lines = gainLines(R, ws, we);
        const chip = (l)=>`<span class="bench-chip${l.me ? ' me' : ''}">${l.me ? '<span class="legend-swatch" style="background:var(--brand); border-radius:50%; width:9px; height:9px;"></span>' : `<span class="legend-line" style="background:${l.color}"></span>`}${esc(l.name)} <b class="${sg(l.gain)}">${eur(round2c(l.gain),{forceSign:true})}</b> <span class="${sg(l.pct)}">${l.pct == null ? '' : '(' + pct(l.pct,1) + ')'}</span>${l.note ? ` <span class="row-sub">${l.note}</span>` : ''}</span>`;
        const mineMissing = !lines.some(l=>l.me);
        info.innerHTML = `<span class="bench-range-label">${esc(R.long)} · ${isoLabel(new Date(ws).toISOString().slice(0,10))} → ${isoLabel(new Date(we).toISOString().slice(0,10))} · ganancia desde el inicio del periodo, sin contar lo aportado:</span>`
          + (mineMissing ? `<span class="bench-chip me muted"><span class="legend-swatch" style="background:var(--brand); border-radius:50%; width:9px; height:9px;"></span>Tu cartera <span class="row-sub">— aún no hay una foto de esa fecha</span></span>` : '')
          + lines.map(chip).join('');
        drawGains(container, lines, ws, we);
        return;
      }

      /* ---- escalas ---- */
      const W = 1100, H = 340, padL = 64, padR = 150, padT = 16, padB = 30;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const inWin = (tt)=>tt >= ws && tt <= we;
      const visible = [];
      B.series.forEach(s=>{ visible.push(interp(s.values, ws)); s.values.forEach((v,i)=>{ if (inWin(dates[i])) visible.push(v); }); });
      visible.push(contribAt(ws)); B.contributions.forEach((v,i)=>{ if (inWin(dates[i])) visible.push(v); });
      hist.forEach(h=>{ if (inWin(h.t)) visible.push(h.value); });
      let lo = 0, hi = Math.max(...visible, 1) * 1.08;
      const step = niceStep((hi - lo) / 4);
      hi = Math.ceil(hi / step) * step;
      const x = v => padL + (we === ws ? 0 : (v - ws) / (we - ws)) * plotW;
      const y = v => padT + plotH - (v - lo) / (hi - lo) * plotH;
      const s = svg('svg', { viewBox:`0 0 ${W} ${H}`, class:'chart', preserveAspectRatio:'none' });
      container.appendChild(s);
      const clipId = 'bench-clip';
      const defs = svg('defs', {}); const cp = svg('clipPath', { id: clipId });
      cp.appendChild(svg('rect', { x:padL, y:padT - 8, width:plotW, height:plotH + 16 }));
      defs.appendChild(cp); s.appendChild(defs);
      const plot = svg('g', { 'clip-path':`url(#${clipId})` });

      for (let v = lo; v <= hi + step / 2; v += step){
        const yy = y(v);
        s.appendChild(svg('line', { x1:padL, x2:padL + plotW, y1:yy, y2:yy, class:'gridline' }));
        const lab = svg('text', { x:padL - 8, y:yy + 4, class:'axis-label', 'text-anchor':'end' });
        lab.textContent = money(v, step);
        s.appendChild(lab);
      }
      s.appendChild(svg('line', { x1:padL, x2:padL + plotW, y1:padT + plotH, y2:padT + plotH, class:'baseline' }));

      // Fechas del eje, según la anchura del periodo.
      const spanDays = (we - ws) / DAY;
      dateTicks(s, ws, we, x, H, padT + plotH);

      // Aportaciones (escalonada).
      let dC = '';
      B.contributions.forEach((v,i)=>{ dC += i === 0 ? `M${x(dates[0])},${y(v)}` : ` H${x(dates[i])} V${y(v)}`; });
      if (tEnd > dates[dates.length - 1]) dC += ` H${x(tEnd)}`;
      plot.appendChild(svg('path', { d:dC, fill:'none', style:'stroke:var(--ink-muted)', 'stroke-width':1.5, 'stroke-dasharray':'4 3' }));

      // Índices.
      const ends = [];
      B.series.forEach((ser,i)=>{
        let d = '';
        ser.values.forEach((v,j)=>{ d += (j ? ' L' : 'M') + `${x(dates[j]).toFixed(1)},${y(v).toFixed(1)}`; });
        plot.appendChild(svg('path', { d, fill:'none', style:`stroke:${colorOf(i)}`, 'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round' }));
        ends.push({ y: y(ser.final), text: `${ser.name} · ${eurShort(ser.final)}` });
      });

      // Tu cartera: fotos guardadas + hoy.
      if (hist.length > 1){
        let d = '';
        hist.forEach((h,j)=>{ d += (j ? ' L' : 'M') + `${x(h.t).toFixed(1)},${y(h.value).toFixed(1)}`; });
        plot.appendChild(svg('path', { d, fill:'none', style:'stroke:var(--brand)', 'stroke-width':2.5, 'stroke-linejoin':'round' }));
      }
      hist.forEach((h,j)=>{
        if (!inWin(h.t)) return;
        const last = j === hist.length - 1;
        plot.appendChild(svg('circle', { cx:x(h.t), cy:y(h.value), r: last ? 6 : 4, style:'fill:var(--brand); stroke:var(--card-bg-raised)', 'stroke-width':2 }));
      });
      s.appendChild(plot);
      const lastH = hist[hist.length - 1];
      ends.push({ y: y(lastH.value), text: `Tu cartera · ${eurShort(lastH.value)}`, bold:true });
      ends.push({ y: y(B.contributions[B.contributions.length - 1]), text: `Aportado · ${eurShort(B.contributions[B.contributions.length - 1])}` });
      ends.forEach(e=>{ e.y = Math.max(padT, Math.min(padT + plotH, e.y)); });
      ends.sort((a,b)=>a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
      const overflow = ends.length ? ends[ends.length - 1].y - (padT + plotH) : 0;
      if (overflow > 0) ends.forEach(e=>{ e.y -= overflow; });
      ends.forEach(e=>{
        const lab = svg('text', { x: padL + plotW + 10, y: e.y + 4, class:'bar-label' + (e.bold ? ' bench-end-me' : '') });
        lab.textContent = e.text;
        s.appendChild(lab);
      });

      // Lectura al pasar el ratón: el cierre más cercano dentro del periodo.
      const idxIn = dates.map((d,i)=>i).filter(i=>inWin(dates[i]));
      const hover = svg('line', { class:'hover-line', y1:padT, y2:padT + plotH });
      s.appendChild(hover);
      const dots = B.series.map((ser,i)=>{ const c = svg('circle', { r:4, class:'hover-dot', style:`fill:${colorOf(i)}` }); s.appendChild(c); return c; });
      const hit = svg('rect', { x:padL, y:padT, width:plotW, height:plotH, fill:'transparent' });
      s.appendChild(hit);
      hit.addEventListener('mousemove', (ev)=>{
        if (!idxIn.length) return;
        const rect = s.getBoundingClientRect();
        const tt = ws + ((ev.clientX - rect.left) * (W / rect.width) - padL) / plotW * (we - ws);
        let i = idxIn[0];
        idxIn.forEach(k=>{ if (Math.abs(dates[k] - tt) < Math.abs(dates[i] - tt)) i = k; });
        const xx = x(dates[i]);
        hover.setAttribute('x1', xx); hover.setAttribute('x2', xx); hover.style.opacity = 1;
        dots.forEach((c,k)=>{ c.setAttribute('cx', xx); c.setAttribute('cy', y(B.series[k].values[i])); c.style.opacity = 1; });
        const near = hist.find(h=>Math.abs(h.t - dates[i]) <= (spanDays > 70 ? 3.5 : 0.5) * DAY);
        const lines = [`<b>${isoLabel(B.dates[i])}</b>`, `Aportado: ${eur(B.contributions[i])}`]
          .concat(B.series.map(ser=>`${esc(ser.name)}: ${eur(ser.values[i])}${B.contributions[i] > 0 ? ` (${pct((ser.values[i] / B.contributions[i] - 1) * 100, 1)})` : ''}`));
        if (near) lines.push(`Tu cartera (${isoLabel(near.date)}): ${eur(near.value)}`);
        showTooltip(ev.clientX, ev.clientY, lines.join('<br>'));
      });
      hit.addEventListener('mouseleave', ()=>{ hover.style.opacity = 0; dots.forEach(c=>{ c.style.opacity = 0; }); hideTooltip(); });
    }
    draw();
  })();

  /* ---- Chart 1: cumulative contributions, stacked area ---- */
  (function(){
    const container = document.getElementById('contrib-chart');
    container.innerHTML = '';
    if (monthly.length < 2) return;
    const W = 1100, H = 320, padL = 54, padR = 16, padT = 18, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxVal = Math.max(...monthly.map(m=>m.cum_ibkr + m.cum_deg), 1) * 1.08;
    const n = monthly.length;
    const x = i => padL + (i/(n-1)) * plotW;
    const y = v => padT + plotH - (v/maxVal) * plotH;

    const s = svg('svg', {viewBox:`0 0 ${W} ${H}`, class:'chart', preserveAspectRatio:'none'});
    container.appendChild(s);

    // gridlines + y labels
    const gridSteps = 4;
    for (let i=0;i<=gridSteps;i++){
      const v = maxVal * i / gridSteps;
      const yy = y(v);
      s.appendChild(svg('line', {x1:padL, x2:W-padR, y1:yy, y2:yy, class:'gridline'}));
      const t = svg('text', {x:padL-8, y:yy+4, class:'axis-label', 'text-anchor':'end'});
      t.textContent = v>=1000 ? Math.round(v/1000)+'k €' : Math.round(v)+' €';
      s.appendChild(t);
    }
    s.appendChild(svg('line', {x1:padL, x2:W-padR, y1:padT+plotH, y2:padT+plotH, class:'baseline'}));

    // month labels (sparse)
    monthly.forEach((m,i)=>{
      if (i% Math.ceil(n/8) === 0 || i===n-1){
        const t = svg('text', {x:x(i), y:H-8, class:'axis-label', 'text-anchor':'middle'});
        t.textContent = monthLabel(m.month);
        s.appendChild(t);
      }
    });

    function areaPath(getVal){
      let d = `M ${x(0)} ${y(0)}`;
      monthly.forEach((m,i)=> d += ` L ${x(i)} ${y(getVal(m))}`);
      d += ` L ${x(n-1)} ${padT+plotH} L ${x(0)} ${padT+plotH} Z`;
      return d;
    }
    function linePath(getVal){
      let d = '';
      monthly.forEach((m,i)=> d += (i===0?'M':'L') + ` ${x(i)} ${y(getVal(m))}`);
      return d;
    }

    const degiroColor = 'var(--degiro)';
    const ibkrColor = 'var(--ibkr)';

    // base layer: DEGIRO cumulative
    s.appendChild(svg('path', {d:areaPath(m=>m.cum_deg), style:`fill:${degiroColor}`, opacity:0.16}));
    s.appendChild(svg('path', {d:linePath(m=>m.cum_deg), fill:'none', style:`stroke:${degiroColor}`, 'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round'}));
    // top layer: combined total (degiro+ibkr)
    s.appendChild(svg('path', {d:areaPath(m=>m.cum_deg+m.cum_ibkr), style:`fill:${ibkrColor}`, opacity:0.13}));
    s.appendChild(svg('path', {d:linePath(m=>m.cum_deg+m.cum_ibkr), fill:'none', style:`stroke:${ibkrColor}`, 'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round'}));

    // endpoint dots
    const lastI = n-1;
    s.appendChild(svg('circle', {cx:x(lastI), cy:y(monthly[lastI].cum_deg), r:3.5, style:`fill:${degiroColor}`}));
    s.appendChild(svg('circle', {cx:x(lastI), cy:y(monthly[lastI].cum_deg+monthly[lastI].cum_ibkr), r:3.5, style:`fill:${ibkrColor}`}));

    // hover interaction
    const hoverLine = svg('line', {class:'hover-line', y1:padT, y2:padT+plotH});
    const dot1 = svg('circle', {r:4, style:`fill:${degiroColor}`, class:'hover-dot'});
    const dot2 = svg('circle', {r:4, style:`fill:${ibkrColor}`, class:'hover-dot'});
    s.appendChild(hoverLine); s.appendChild(dot1); s.appendChild(dot2);

    const overlay = svg('rect', {x:padL, y:padT, width:plotW, height:plotH, fill:'transparent'});
    s.appendChild(overlay);
    overlay.addEventListener('mousemove', (ev)=>{
      const rect = s.getBoundingClientRect();
      const relX = (ev.clientX - rect.left) * (W/rect.width);
      let i = Math.round(((relX-padL)/plotW)*(n-1));
      i = Math.max(0, Math.min(n-1, i));
      const m = monthly[i];
      hoverLine.setAttribute('x1', x(i)); hoverLine.setAttribute('x2', x(i)); hoverLine.style.opacity=1;
      dot1.setAttribute('cx', x(i)); dot1.setAttribute('cy', y(m.cum_deg)); dot1.style.opacity=1;
      dot2.setAttribute('cx', x(i)); dot2.setAttribute('cy', y(m.cum_deg+m.cum_ibkr)); dot2.style.opacity=1;
      showTooltip(ev.clientX, ev.clientY,
        `<b>${isoMonthLabel(m.month)}</b><br/>Total acumulado: ${eur(m.cum_deg+m.cum_ibkr)}<br/>DEGIRO: ${eur(m.cum_deg)} · IBKR: ${eur(m.cum_ibkr)}`);
    });
    overlay.addEventListener('mouseleave', ()=>{ hoverLine.style.opacity=0; dot1.style.opacity=0; dot2.style.opacity=0; hideTooltip(); });
  })();

  /* ---- generic horizontal bar chart ---- */
  function renderHBarChart(container, items, opts){
    // items: [{label, value, sub, color}]
    opts = opts || {};
    container.innerHTML = ''; // defensive: never stack a second render on top of a prior one
    const rowH = opts.rowH || 24;
    const gap = opts.gap || 10;
    const W = 1100;
    const labelW = opts.labelW || 225;
    const padL = labelW + 12, padR = 130;
    const padT = 8, padB = 8;
    const n = items.length;
    const H = padT + padB + n*rowH + (n-1)*gap;
    const maxAbs = Math.max(...items.map(d=>Math.abs(d.value)), 1e-9);
    const zeroInData = opts.diverging;
    const s = svg('svg', {viewBox:`0 0 ${W} ${H}`, class:'chart'});
    container.appendChild(s);

    const plotW = W - padL - padR;
    const zeroX = zeroInData ? padL + plotW*0.5 : padL;
    const scale = zeroInData ? (plotW*0.5)/maxAbs : plotW/maxAbs;

    items.forEach((d,i)=>{
      const yy = padT + i*(rowH+gap);
      const barColor = d.color || 'var(--brand)';
      let bx, bw;
      if (zeroInData){
        bw = Math.abs(d.value)*scale;
        bx = d.value>=0 ? zeroX : zeroX - bw;
      } else {
        bx = padL; bw = Math.max(d.value*scale, 2);
      }
      const label = svg('text', {x: 4, y:yy+rowH/2+1, class:'bar-name', 'dominant-baseline':'middle'});
      label.textContent = d.label;
      s.appendChild(label);

      const rect = svg('rect', {x:bx, y:yy, width:Math.max(bw,2), height:rowH, rx:4, style:`fill:${barColor}`, opacity:0.88});
      s.appendChild(rect);

      const valText = svg('text', {x: W-padR+12, y:yy+rowH/2+1, class:'bar-label', 'dominant-baseline':'middle'});
      valText.textContent = d.valueLabel || eurShort(d.value);
      s.appendChild(valText);

      const hitArea = svg('rect', {x:0, y:yy - gap/2, width:W, height:rowH+gap, fill:'transparent'});
      s.appendChild(hitArea);
      hitArea.addEventListener('mousemove', (ev)=>{
        rect.setAttribute('opacity','1');
        showTooltip(ev.clientX, ev.clientY, `<b>${esc(d.fullLabel || d.label)}</b><br/>${d.tooltip || eur(d.value,{forceSign:zeroInData})}`);
      });
      hitArea.addEventListener('mouseleave', ()=>{ rect.setAttribute('opacity','0.88'); hideTooltip(); });
    });

    if (zeroInData){
      s.appendChild(svg('line', {x1:zeroX, x2:zeroX, y1:padT-4, y2:H-padB+4, class:'baseline'}));
    }
    return s;
  }

  /* ---- paired horizontal bar chart: cost vs current value ---- */
  function renderPairedBarChart(container, items, opts){
    opts = opts || {};
    container.innerHTML = ''; // defensive: never stack a second render on top of a prior one
    const barH = 11, barGap = 3, rowGap = 24;
    const rowH = barH*2 + barGap;
    const W = 1100, padL = 8, padR = 110, padT = 20, padB = 8;
    const n = items.length;
    const H = padT + padB + n*rowH + (n-1)*rowGap;
    const maxVal = Math.max(...items.map(d=>Math.max(d.cost, d.value||0)), 1e-9) * 1.05;
    const s = svg('svg', {viewBox:`0 0 ${W} ${H}`, class:'chart'});
    container.appendChild(s);
    const plotW = W - padL - padR;
    const scale = plotW/maxVal;
    const costColor = 'var(--hairline-strong)';
    const valColor = 'var(--degiro)';

    items.forEach((d,i)=>{
      const yy = padT + i*(rowH+rowGap);
      const label = svg('text', {x:padL, y:yy-6, class:'bar-name'});
      label.textContent = d.label;
      s.appendChild(label);

      const costW = Math.max(d.cost*scale, 2);
      s.appendChild(svg('rect', {x:padL, y:yy, width:costW, height:barH, rx:3, style:`fill:${costColor}`}));

      if (d.value != null){
        const valW = Math.max(d.value*scale, 2);
        const valColorFinal = d.value>=d.cost ? valColor : 'var(--critical)';
        s.appendChild(svg('rect', {x:padL, y:yy+barH+barGap, width:valW, height:barH, rx:3, style:`fill:${valColorFinal}`}));
      }

      const valText = svg('text', {x: W-padR+12, y:yy+barH+2, class:'bar-label', 'dominant-baseline':'middle'});
      valText.textContent = d.value!=null ? (d.value>=d.cost?'+':'') + pctStr((d.value-d.cost)/d.cost*100) : '—';
      s.appendChild(valText);

      const hitArea = svg('rect', {x:padL, y:yy-16, width:plotW+padR, height:rowH+18, fill:'transparent'});
      s.appendChild(hitArea);
      hitArea.addEventListener('mousemove', (ev)=>{
        showTooltip(ev.clientX, ev.clientY, d.tooltip);
      });
      hitArea.addEventListener('mouseleave', hideTooltip);
    });
    return s;
  }
  function pctStr(n){ return n.toFixed(1).replace('.',',') + '\u00A0%'; }

  /* ---- Chart 2: DEGIRO holdings, coste vs valor hoy ---- */
  (function(){
    const container = document.getElementById('degiro-holdings-chart');
    container.innerHTML = '';
    if (!degiro_open_positions.length){ container.innerHTML = '<p class="footnote">No hay posiciones abiertas en DEGIRO.</p>'; return; }
    const items = degiro_open_positions.slice().sort((a,b)=>(b.live_value_eur||b.cost_total)-(a.live_value_eur||a.cost_total)).map(p=>({
      label: p.name.length>48 ? p.name.slice(0,46)+'…' : p.name,
      cost: p.cost_total,
      value: p.live_value_eur!=null ? p.live_value_eur : null,
      tooltip: `<b>${esc(p.name)}</b><br/>Coste: ${eur(p.cost_total)}<br/>Valor hoy: ${p.live_value_eur!=null?eur(p.live_value_eur):'—'}${p.live_pl_pct!=null?` (${p.live_pl_pct>=0?'+':''}${nf2.format(p.live_pl_pct)}\u00A0%)`:''}`
    }));
    renderPairedBarChart(container, items);
  })();

  /* ---- Chart 3: dividends by holding (top 12) ---- */
  (function(){
    const container = document.getElementById('dividends-chart');
    container.innerHTML = '';
    if (!dividends.length) return;
    const top = dividends.slice(0, 12).map(d=>({
      label: d.name.length>28 ? d.name.slice(0,26)+'…' : d.name,
      fullLabel: d.name,
      value: d.gross_eur,
      color: d.account==='IBKR' ? 'var(--ibkr)' : 'var(--degiro)',
      valueLabel: (d.approx?'~':'') + eurShort(d.gross_eur),
      tooltip: `${d.account} · bruto ${d.approx?'≈ ':''}${eur(d.gross_eur)} · neto ${d.approx?'≈ ':''}${eur(d.gross_eur+d.tax_eur)}`
    }));
    renderHBarChart(container, top, {rowH:22, gap:9});
  })();

  /* ---- Chart 4: realized P&L diverging, top 14 by magnitude ---- */
  (function(){
    const container = document.getElementById('realized-chart');
    container.innerHTML = '';
    if (!degiro_realized.length) return;
    const sorted = degiro_realized.slice().sort((a,b)=>Math.abs(b.pl)-Math.abs(a.pl)).slice(0,14);
    sorted.sort((a,b)=>b.pl-a.pl);
    const items = sorted.map(r=>({
      label: r.name.length>28 ? r.name.slice(0,26)+'…' : r.name,
      fullLabel: r.name,
      value: r.pl,
      color: r.pl>=0 ? 'var(--good)' : 'var(--critical)',
      valueLabel: eur(r.pl, {forceSign:true}),
      tooltip: `Resultado realizado: ${eur(r.pl,{forceSign:true})}`
    }));
    renderHBarChart(container, items, {rowH:22, gap:9, diverging:true});
  })();

  /* ---- Chart 5: trading frequency by quarter (bars) + avg buy ticket (line) ---- */
  (function(){
    const container = document.getElementById('quarterly-chart');
    if (!container || !behavior || !behavior.quarterly.length) return;
    container.innerHTML = '';
    const q = behavior.quarterly;
    const W = 1100, H = 300, padL = 44, padR = 64, padT = 18, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = q.length;
    const bw = plotW/n;
    const maxTrades = Math.max(...q.map(d=>d.n_trades), 1) * 1.15;
    const maxTicket = Math.max(...q.map(d=>d.avg_buy_size), 1) * 1.15;
    const x = i => padL + i*bw;
    const yBar = v => padT + plotH - (v/maxTrades)*plotH;
    const yLine = v => padT + plotH - (v/maxTicket)*plotH;

    const s = svg('svg', {viewBox:`0 0 ${W} ${H}`, class:'chart'});
    container.appendChild(s);

    const gridSteps = 4;
    for (let i=0;i<=gridSteps;i++){
      const v = maxTrades*i/gridSteps;
      const vt = maxTicket*i/gridSteps;
      const yy = yBar(v);
      s.appendChild(svg('line', {x1:padL, x2:W-padR, y1:yy, y2:yy, class:'gridline'}));
      const t = svg('text', {x:padL-8, y:yy+4, class:'axis-label', 'text-anchor':'end'});
      t.textContent = Math.round(v);
      s.appendChild(t);
      const tr = svg('text', {x:W-padR+8, y:yy+4, class:'axis-label', 'text-anchor':'start', style:'fill:var(--brand)'});
      tr.textContent = vt >= 1000 ? (vt/1000).toFixed(1).replace('.',',') + 'k €' : Math.round(vt) + ' €';
      s.appendChild(tr);
    }
    s.appendChild(svg('line', {x1:padL, x2:W-padR, y1:padT+plotH, y2:padT+plotH, class:'baseline'}));

    const degiroColor = 'var(--degiro)';
    const brandColor = 'var(--brand)';

    q.forEach((d,i)=>{
      const bh = plotH - (yBar(d.n_trades)-padT);
      const rect = svg('rect', {x:x(i)+bw*0.18, y:yBar(d.n_trades), width:bw*0.64, height:Math.max(bh,1), rx:3, style:`fill:${degiroColor}`, opacity:0.8});
      s.appendChild(rect);
      const lbl = svg('text', {x:x(i)+bw/2, y:H-16, class:'axis-label', 'text-anchor':'middle'});
      const [qy, qq] = d.quarter.split('-');
      lbl.textContent = qq + ' \'' + qy.slice(2);
      s.appendChild(lbl);

      const hit = svg('rect', {x:x(i), y:padT, width:bw, height:plotH, fill:'transparent'});
      s.appendChild(hit);
      hit.addEventListener('mousemove', (ev)=>{
        rect.setAttribute('opacity','1');
        showTooltip(ev.clientX, ev.clientY,
          `<b>${d.quarter}</b><br/>${d.n_trades} operaciones (${d.n_buys} compras / ${d.n_sells} ventas)<br/>${d.tickers} valores distintos<br/>Ticket medio de compra: ${eur(d.avg_buy_size)}<br/>Capital movido: ${eur(d.capital)}`);
      });
      hit.addEventListener('mouseleave', ()=>{ rect.setAttribute('opacity','0.8'); hideTooltip(); });
    });

    // avg buy ticket line (secondary scale)
    let linePath = '';
    q.forEach((d,i)=>{ linePath += (i===0?'M':'L') + ` ${x(i)+bw/2} ${yLine(d.avg_buy_size)}`; });
    s.appendChild(svg('path', {d:linePath, fill:'none', style:`stroke:${brandColor}`, 'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round', opacity:0.85}));
    q.forEach((d,i)=>{
      s.appendChild(svg('circle', {cx:x(i)+bw/2, cy:yLine(d.avg_buy_size), r:3, style:`fill:${brandColor}`}));
    });
  })();

  /* ---- Behavior comparison cards ---- */
  (function(){
    if (!behavior) return;
    const eps = behavior.episodes;
    function summarize(list){
      const wins = list.filter(e=>e.pnl>0).length;
      const net = list.reduce((a,e)=>a+e.pnl,0);
      return { n:list.length, wr: list.length? wins/list.length*100 : 0, net };
    }
    // Corte temporal dinámico: últimos 12 meses frente al periodo anterior (o punto medio si el historial es más corto).
    const sortedClose = eps.map(e=>e.close.slice(0,10)).sort();
    let cutoff = '';
    if (sortedClose.length){
      const firstMs = Date.parse(sortedClose[0] + 'T00:00:00Z');
      const lastMs = Date.parse(sortedClose[sortedClose.length - 1] + 'T00:00:00Z');
      const yearBack = new Date(lastMs);
      yearBack.setUTCFullYear(yearBack.getUTCFullYear() - 1);
      const cutMs = yearBack.getTime() > firstMs ? yearBack.getTime() : Math.round((firstMs + lastMs) / 2);
      const cutDate = new Date(cutMs);
      cutoff = `${cutDate.getUTCFullYear()}-${String(cutDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
      const cutLabel = isoMonthLabel(cutoff);
      const et = $('cmp-early-title'), lt = $('cmp-late-title');
      if (et) et.textContent = `Antes de ${cutLabel}`;
      if (lt) lt.textContent = `Desde ${cutLabel}`;
    }
    const early = cutoff ? eps.filter(e=>e.close.slice(0,10) < cutoff) : [];
    const late = cutoff ? eps.filter(e=>e.close.slice(0,10) >= cutoff) : [];
    const fast = eps.filter(e=>e.holding_days<=14);
    const slow = eps.filter(e=>e.holding_days>14);

    function fill(prefix, stats){
      const nEl = document.getElementById(`cmp-${prefix}-n`);
      const wrEl = document.getElementById(`cmp-${prefix}-wr`);
      const netEl = document.getElementById(`cmp-${prefix}-net`);
      if (nEl) nEl.textContent = stats.n;
      if (wrEl) wrEl.textContent = num(stats.wr,0) + ' %';
      if (netEl){
        netEl.textContent = eur(stats.net,{forceSign:true});
        netEl.className = stats.net>=0 ? 'pos' : 'neg';
      }
    }
    fill('early', summarize(early));
    fill('late', summarize(late));
    fill('fast', summarize(fast));
    fill('slow', summarize(slow));
  })();

  /* ---- Chart 6: closed-episode scatter — holding days vs. close date ---- */
  (function(){
    const container = document.getElementById('episodes-chart');
    if (!container || !behavior || !behavior.episodes.length) return;
    container.innerHTML = '';
    const eps = behavior.episodes.slice().sort((a,b)=> a.close.localeCompare(b.close));
    const W = 1100, H = 340, padL = 50, padR = 20, padT = 16, padB = 30;
    const plotW = W-padL-padR, plotH = H-padT-padB;
    const dates = eps.map(e=>new Date(e.close).getTime());
    const minD = Math.min(...dates), maxD = Math.max(...dates);
    const spanD = maxD - minD;
    const maxHold = Math.max(...eps.map(e=>e.holding_days), 1) * 1.08;
    const maxAbsPnl = Math.max(...eps.map(e=>Math.abs(e.pnl)));
    const x = t => padL + (spanD ? ((t-minD)/spanD) : 0.5)*plotW;
    const y = v => padT + plotH - (v/maxHold)*plotH;

    const s = svg('svg', {viewBox:`0 0 ${W} ${H}`, class:'chart', preserveAspectRatio:'none'});
    container.appendChild(s);

    const gridSteps = 4;
    for (let i=0;i<=gridSteps;i++){
      const v = maxHold*i/gridSteps;
      const yy = y(v);
      s.appendChild(svg('line', {x1:padL, x2:W-padR, y1:yy, y2:yy, class:'gridline'}));
      const t = svg('text', {x:padL-8, y:yy+4, class:'axis-label', 'text-anchor':'end'});
      t.textContent = Math.round(v)+'d';
      s.appendChild(t);
    }
    s.appendChild(svg('line', {x1:padL, x2:W-padR, y1:padT+plotH, y2:padT+plotH, class:'baseline'}));

    // x axis year/quarter markers
    const shown = new Set();
    eps.forEach(e=>{
      const d = new Date(e.close);
      const key = d.getFullYear()+'-'+(d.getMonth()<6?'H1':'H2');
      if (!shown.has(key)){
        shown.add(key);
        const t = svg('text', {x:x(d.getTime()), y:H-10, class:'axis-label', 'text-anchor':'middle'});
        t.textContent = (d.getMonth()<6?'ene ':'jul ') + String(d.getFullYear()).slice(2);
        s.appendChild(t);
      }
    });

    const goodColor = 'var(--good)', critColor = 'var(--critical)';
    eps.forEach(e=>{
      const cx = x(new Date(e.close).getTime());
      const cy = y(e.holding_days);
      const r = 3 + Math.sqrt(Math.abs(e.pnl)/Math.max(maxAbsPnl,1e-9)) * 9;
      const color = e.pnl>=0 ? goodColor : critColor;
      const dot = svg('circle', {cx, cy, r, style:`fill:${color}; stroke:var(--card-bg-raised)`, opacity:0.75, 'stroke-width':1});
      s.appendChild(dot);
      dot.addEventListener('mousemove', (ev)=>{
        dot.setAttribute('opacity','1');
        showTooltip(ev.clientX, ev.clientY,
          `<b>${esc(e.name)}</b><br/>Abierta: ${e.open.slice(0,10)} · Cerrada: ${e.close.slice(0,10)}<br/>Duración: ${e.holding_days} días<br/>Resultado: ${eur(e.pnl,{forceSign:true})}`);
      });
      dot.addEventListener('mouseleave', ()=>{ dot.setAttribute('opacity','0.75'); hideTooltip(); });
    });
  })();

  /* ================= SIMULACIÓN FISCAL IRPF (ESPAÑA · FIFO Y REGLA 2 MESES) ================= */
  (function(){
    const body = $('irpf-body');
    if (!body) return;
    const IRPF = PAYLOAD.irpf;
    if (!IRPF || IRPF.error){
      body.innerHTML = `<div class="card"><p class="footnote" style="margin-top:0;">${esc((IRPF && IRPF.error) || 'No se ha podido calcular la simulación fiscal.')}</p></div>`;
      return;
    }
    if (!IRPF.hasData || !IRPF.years.length){
      body.innerHTML = `<div class="card"><p class="footnote" style="margin-top:0;">Importa los extractos CSV de DEGIRO y/o Interactive Brokers para calcular la simulación fiscal del IRPF (FIFO global por ISIN y regla antiaplicación de los 2 meses).</p></div>`;
      return;
    }

    // Precio orientativo actual en EUR por ISIN para pre-rellenar el simulador "¿Y si vendo hoy?".
    const livePriceEurByIsin = new Map();
    const fxMap = (DATA.live_meta && DATA.live_meta.fx) || {};
    degiro_open_positions.forEach(p=>{
      if (p.isin && p.live_price_eur > 0) livePriceEurByIsin.set(p.isin, p.live_price_eur);
    });
    ibkr.positions.forEach(p=>{
      if (!p.isin || livePriceEurByIsin.has(p.isin)) return;
      if (p.value_eur > 0 && p.qty > 0) livePriceEurByIsin.set(p.isin, p.value_eur / p.qty);
      else if (p.price > 0){
        const r = p.cur === 'EUR' ? 1 : fxMap[p.cur];
        if (r > 0) livePriceEurByIsin.set(p.isin, p.price / r);
      }
    });

    const yearsDesc = IRPF.years.slice().reverse();
    let selectedYear = yearsDesc[0].year;

    const alertsHtml = [];
    if (IRPF.activeWindows && IRPF.activeWindows.length){
      alertsHtml.push(`<div class="notice warn"><b>Ventana activa de la regla de los 2 meses (art. 33.5.f LIRPF):</b> si compras alguno de estos valores antes de la fecha indicada (en cualquier bróker), bloquearás la deducción de su pérdida en este ejercicio:<ul>${
        IRPF.activeWindows.map(w=>`<li><b>${esc(w.name)}</b> (<span class="mono">${esc(w.isin)}</span>) — venta con pérdida de <span class="neg-val">${eur(w.unblockedLoss)}</span> el ${isoLabel(w.saleDate)} · no recomprar hasta el <b>${isoLabel(w.untilDate)}</b></li>`).join('')
      }</ul></div>`);
    }
    if (IRPF.pendingBlocked && IRPF.pendingBlocked.length){
      alertsHtml.push(`<div class="notice warn"><b>Pérdidas bloqueadas pendientes de liberar: ${eur(IRPF.pendingBlockedTotal)}</b> (retenidas en lotes abiertos; se integrarán en el IRPF cuando vendas esos títulos):<ul>${
        IRPF.pendingBlocked.map(p=>`<li><b>${esc(p.name)}</b> (<span class="mono">${esc(p.isin)}</span>): ${eur(p.amount)} de la venta del ${isoLabel(p.originDate)} bloqueados por ${num(p.qty, p.qty % 1 ? 4 : 0)} títulos comprados el ${isoLabel(p.buyDate)} (${esc(p.buyAccount)})</li>`).join('')
      }</ul></div>`);
    }
    if (IRPF.warnings && IRPF.warnings.length){
      alertsHtml.push(`<div class="notice warn"><b>Avisos del cálculo fiscal</b><ul>${IRPF.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`);
    }

    const openPos = IRPF.openPositions || [];
    const simCardHtml = openPos.length ? `
      <div class="card irpf-sim-card">
        <h3 class="irpf-sim-title">Simulador rápido: «¿Y si vendo hoy?»</h3>
        <p class="footnote" style="margin-top:0;">Calcula la ganancia o pérdida exacta por <b>FIFO global</b> (lotes más antiguos primero), avisa si saltaría la <b>regla de los 2 meses</b> por compras recientes en cualquier cuenta y estima el impacto en tu cuota del IRPF del ejercicio.</p>
        <form id="irpf-sim-form" class="irpf-sim-grid" novalidate>
          <div class="field irpf-sim-isin">
            <label for="irpf-sim-isin">Valor en cartera (lotes FIFO)</label>
            <select id="irpf-sim-isin" name="isin">${openPos.map(p=>`<option value="${esc(p.isin)}">${esc(p.name)} (${esc(p.isin)}) — ${num(p.qty, p.qty % 1 ? 4 : 0)} tít.</option>`).join('')}</select>
          </div>
          <div class="field">
            <label for="irpf-sim-qty">Títulos <button type="button" class="link-btn" id="irpf-sim-all" style="text-transform:none;letter-spacing:0;margin-left:4px;">Todos</button></label>
            <input type="text" inputmode="decimal" id="irpf-sim-qty" name="qty" autocomplete="off">
          </div>
          <div class="field">
            <label for="irpf-sim-price">Precio venta (€/ud.)</label>
            <input type="text" inputmode="decimal" id="irpf-sim-price" name="price" autocomplete="off">
          </div>
          <div class="field">
            <label for="irpf-sim-fee">Comisión (€)</label>
            <input type="text" inputmode="decimal" id="irpf-sim-fee" name="fee" value="0" autocomplete="off">
          </div>
          <div class="field">
            <label for="irpf-sim-date">Fecha venta</label>
            <input type="date" id="irpf-sim-date" name="date" value="${esc(STATUS.today)}">
          </div>
          <button type="submit" class="btn-primary" id="irpf-sim-btn">Simular</button>
        </form>
        <div id="irpf-sim-result" class="irpf-sim-result"></div>
        <details class="irpf-details">
          <summary><span>Lotes abiertos en FIFO (${openPos.length} valores · coste fiscal ${eur(openPos.reduce((a,p)=>a + p.costEur, 0))})</span></summary>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Valor</th><th>ISIN</th><th class="num">Títulos</th><th class="num">Coste FIFO</th><th>Lotes de adquisición (orden de salida FIFO)</th></tr></thead>
              <tbody>${openPos.map(p=>`<tr>
                <td class="row-name">${esc(p.name)}</td>
                <td class="mono">${esc(p.isin)}</td>
                <td class="num">${num(p.qty, p.qty % 1 ? 4 : 0)}</td>
                <td class="num">${eur(p.costEur)}</td>
                <td class="row-sub">${p.lots.map(l=>`${isoLabel(l.date)} (${esc(l.account)}): ${num(l.qty, l.qty % 1 ? 4 : 0)} × ${eur(l.unitCostEur)}`).join(' · ')}</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </details>
      </div>` : '';

    body.innerHTML = `
      ${alertsHtml.length ? `<div class="irpf-alerts">${alertsHtml.join('')}</div>` : ''}
      <div class="card">
        <div class="irpf-head">
          <div class="type-tabs" id="irpf-year-tabs" role="tablist" aria-label="Ejercicio fiscal">
            ${yearsDesc.map(y=>`<button type="button" role="tab" class="type-tab${y.year === selectedYear ? ' active' : ''}" data-year="${y.year}" aria-selected="${y.year === selectedYear}">${y.year}</button>`).join('')}
          </div>
          <span class="row-sub">${esc(IRPF.regime)}</span>
        </div>
        <div id="irpf-year-view"></div>
      </div>
      ${simCardHtml}
      <p class="footnote"><b>Aviso orientativo (España · territorio común):</b> esta simulación aplica el método <b>FIFO global por ISIN</b> uniendo DEGIRO e Interactive Brokers (art. 37.2 LIRPF), la <b>regla antiaplicación de los 2 meses</b> sobre pérdidas (art. 33.5.f LIRPF), la compensación cruzada del <b>25 %</b> y el arrastre durante <b>4 ejercicios</b> (art. 49 LIRPF), y la escala del ahorro estatal + autonómica (2023–2024 hasta 28 %; desde 2025 hasta 30 %). Los intereses pagados por saldo deudor no son deducibles. No incluye rentas del ahorro externas a esta cartera ni normativa foral (País Vasco y Navarra) y no sustituye el asesoramiento fiscal ni los datos oficiales de la AEAT.</p>`;

    function renderYear(year){
      const y = IRPF.years.find(x=>x.year === year);
      const view = $('irpf-year-view');
      if (!y || !view) return;
      const topBracketNote = y.year >= 2025 ? 'Escala 2025+ (19 % – 30 %)' : 'Escala 2023–2024 (19 % – 28 %)';
      const carryNote = y.carryRemainingTotal > 0
        ? `Quedan ${eur(y.carryRemainingTotal)} de saldo negativo a compensar en los 4 ejercicios siguientes`
        : (y.carryUsedOnGpp + y.carryUsedOnRcm > 0 ? `Aplicados ${eur(y.carryUsedOnGpp + y.carryUsedOnRcm)} de pérdidas de años anteriores` : topBracketNote);

      const salesTable = y.sales.length ? `
        <div class="table-scroll">
          <table>
            <thead><tr>
              <th>Fecha</th><th>Cuenta</th><th>Valor</th><th class="num">Títulos</th>
              <th class="num">Transmisión</th><th class="num">Coste FIFO</th>
              <th class="num">Resultado FIFO</th><th>Regla 2 meses</th><th class="num">Computable</th>
            </tr></thead>
            <tbody>${y.sales.map(s=>{
              let badge = '<span class="irpf-badge ok">Computable</span>';
              if (s.blockedQty > 0){
                const detail = s.triggers.map(tr=>`${tr.relation} ${isoLabel(tr.date)} (${num(tr.qty, tr.qty % 1 ? 4 : 0)} tít.)`).join(', ');
                badge = `<span class="irpf-badge warn" title="${esc(detail)}">Bloqueada (${num(s.blockedQty, s.blockedQty % 1 ? 4 : 0)} tít.)</span><div class="row-sub">${esc(detail)}</div>`;
              } else if (s.gain >= 0){
                badge = '<span class="irpf-badge muted">Ganancia</span>';
              }
              return `<tr>
                <td class="num" style="text-align:left;">${isoLabel(s.date)}</td>
                <td><span class="chip ${s.account === 'IBKR' ? 'chip-ibkr' : 'chip-degiro'}">${esc(s.account)}</span></td>
                <td><div class="row-name">${esc(s.name)}</div><div class="row-sub mono">${esc(s.isin)}</div></td>
                <td class="num">${num(s.qty, s.qty % 1 ? 4 : 0)}</td>
                <td class="num">${s.approx ? '≈ ' : ''}${eur(s.txEur)}</td>
                <td class="num">${s.approx ? '≈ ' : ''}${eur(s.costEur)}</td>
                <td class="num ${sg(s.gain) ? sg(s.gain) + '-val' : ''}">${eur(s.gain, {forceSign:true})}</td>
                <td>${badge}</td>
                <td class="num ${sg(s.computableGain) ? sg(s.computableGain) + '-val' : ''}">${eur(s.computableGain, {forceSign:true})}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>` : '<p class="footnote">No hay ventas registradas en este ejercicio.</p>';

      const libsBlock = y.liberations.length ? `
        <p class="footnote" style="margin-top:6px;"><b>Pérdidas diferidas liberadas en ${y.year} (${eur(y.lossesLiberated)}):</b> al vender los títulos que originaron el bloqueo, estas pérdidas pasan a ser computables en este ejercicio.</p>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Valor</th><th>Venta origen</th><th>Compra bloqueante</th><th>Venta liberadora</th><th class="num">Títulos</th><th class="num">Pérdida liberada</th></tr></thead>
            <tbody>${y.liberations.map(l=>`<tr>
              <td class="row-name">${esc(l.name)}</td>
              <td>${isoLabel(l.originDate)}</td>
              <td>${isoLabel(l.buyDate)} (${esc(l.buyAccount)})</td>
              <td>${isoLabel(l.releaseDate)}</td>
              <td class="num">${num(l.qty, l.qty % 1 ? 4 : 0)}</td>
              <td class="num neg-val">${eur(l.amount)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>` : '';

      const bracketsTable = `
        <div class="table-scroll">
          <table>
            <thead><tr><th>Tramo Base del Ahorro (${y.year})</th><th class="num">Base en tramo</th><th class="num">Tipo</th><th class="num">Cuota</th></tr></thead>
            <tbody>${y.brackets.map(b=>`<tr>
              <td>${esc(b.label)}</td>
              <td class="num">${eur(b.base)}</td>
              <td class="num">${b.ratePct}\u00A0%</td>
              <td class="num">${eur(b.tax)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;

      const divsTable = y.dividends.length ? `
        <div class="table-scroll">
          <table>
            <thead><tr><th>Cuenta</th><th>Valor</th><th class="num">Dividendo bruto</th><th class="num">Retención origen</th></tr></thead>
            <tbody>${y.dividends.map(d=>`<tr>
              <td><span class="chip ${d.account === 'IBKR' ? 'chip-ibkr' : 'chip-degiro'}">${esc(d.account)}</span></td>
              <td class="row-name">${esc(d.name)}</td>
              <td class="num">${d.approx ? '≈ ' : ''}${eur(d.gross_eur)}</td>
              <td class="num neg-val">${eur(d.tax_eur)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>` : '';

      view.innerHTML = `
        <div class="irpf-kpis">
          <div class="irpf-kpi">
            <div class="irpf-kpi-label">Saldo GPP (FIFO · ${y.year})</div>
            <div class="irpf-kpi-val ${sg(y.gppYear)}">${eur(y.gppYear, {forceSign:true})}</div>
            <div class="irpf-kpi-sub">${y.salesCount} ${y.salesCount === 1 ? 'venta' : 'ventas'}${y.lossesBlocked ? ` · bloqueado 2m: ${eur(y.lossesBlocked)}` : ''}${y.lossesLiberated ? ` · liberado: ${eur(y.lossesLiberated)}` : ''}</div>
          </div>
          <div class="irpf-kpi">
            <div class="irpf-kpi-label">Rend. capital mobiliario</div>
            <div class="irpf-kpi-val">${eur(y.rcmNet)}</div>
            <div class="irpf-kpi-sub">Dividendos ${eur(y.divGross)}${y.interestIncome ? ` + int. ${eur(y.interestIncome)}` : ''} · ret. origen ${eur(y.divTaxForeign)}</div>
          </div>
          <div class="irpf-kpi">
            <div class="irpf-kpi-label">Base imponible del ahorro</div>
            <div class="irpf-kpi-val">${eur(y.baseAhorro)}</div>
            <div class="irpf-kpi-sub">${carryNote}</div>
          </div>
          <div class="irpf-kpi">
            <div class="irpf-kpi-label">Cuota estimada IRPF</div>
            <div class="irpf-kpi-val">${eur(y.cuotaNetaEst)}</div>
            <div class="irpf-kpi-sub">Íntegra ${eur(y.cuotaIntegra)} (${pct(y.effectivePct, 1).replace(/^\+/,'')}) · DDI est. −${eur(y.ddiEstimated)}</div>
          </div>
        </div>

        <div class="table-scroll">
          <table class="irpf-summary-table">
            <tbody>
              <tr><td>Ganancias patrimoniales (ventas con beneficio, FIFO)</td><td class="num pos-val">${eur(y.gains, {forceSign:true})}</td></tr>
              <tr><td>Pérdidas patrimoniales brutas (ventas con pérdida, FIFO)</td><td class="num ${y.lossesGross < 0 ? 'neg-val' : ''}">${eur(y.lossesGross, {forceSign:true})}</td></tr>
              ${y.lossesBlocked ? `<tr><td>Pérdidas diferidas por regla de los 2 meses (art. 33.5.f)</td><td class="num">${eur(-y.lossesBlocked, {forceSign:true})}</td></tr>` : ''}
              ${y.lossesLiberated ? `<tr><td>Pérdidas diferidas liberadas en ${y.year}</td><td class="num neg-val">${eur(y.lossesLiberated, {forceSign:true})}</td></tr>` : ''}
              <tr><td><b>Saldo neto de ganancias y pérdidas patrimoniales (GPP)</b></td><td class="num ${sg(y.gppYear) ? sg(y.gppYear) + '-val' : ''}"><b>${eur(y.gppYear, {forceSign:true})}</b></td></tr>
              ${y.carryAvailableStart ? `<tr class="irpf-sub"><td>Pérdidas pendientes de los 4 ejercicios anteriores (aplicadas: ${eur(y.carryUsedOnGpp + y.carryUsedOnRcm)})</td><td class="num">−${eur(y.carryUsedOnGpp + y.carryUsedOnRcm)}</td></tr>` : ''}
              <tr><td>Rendimientos del capital mobiliario (dividendos brutos${y.interestIncome ? ' + intereses cobrados' : ''})</td><td class="num">${eur(y.rcmNet)}</td></tr>
              ${y.crossOffset ? `<tr class="irpf-sub"><td>Compensación cruzada con saldo negativo de GPP (límite 25 % RCM, art. 49)</td><td class="num">−${eur(y.crossOffset)}</td></tr>` : ''}
              <tr class="irpf-total"><td>Base imponible del ahorro (${y.year})</td><td class="num">${eur(y.baseAhorro)}</td></tr>
              <tr><td>Cuota íntegra del ahorro (${topBracketNote} · tipo marginal ${y.marginalPct}\u00A0%)</td><td class="num">${eur(y.cuotaIntegra)}</td></tr>
              <tr class="irpf-sub"><td>Deducción orientativa por doble imposición internacional (art. 80 · tope estándar 15 % sobre ${eur(y.divTaxForeign)} retenidos)</td><td class="num">−${eur(y.ddiEstimated)}</td></tr>
              <tr class="irpf-total"><td>Cuota neta estimada a pagar en IRPF</td><td class="num">${eur(y.cuotaNetaEst)}</td></tr>
              ${y.carryRemainingTotal ? `<tr class="irpf-sub"><td>Saldo negativo de GPP pendiente para compensar en los 4 ejercicios siguientes (${y.carryRemainingEnd.map(c=>`${c.originYear}: ${eur(c.amount)} hasta ${c.expiresYear}`).join(' · ')})</td><td class="num">${eur(y.carryRemainingTotal)}</td></tr>` : ''}
              ${y.interestPaid < 0 ? `<tr class="irpf-sub"><td>Intereses pagados por saldo deudor (informativo: no deducibles en el IRPF español)</td><td class="num">${eur(y.interestPaid)}</td></tr>` : ''}
            </tbody>
          </table>
        </div>

        <details class="irpf-details" ${y.sales.some(s=>s.blockedQty > 0) ? 'open' : ''}>
          <summary><span>Detalle de ventas FIFO y regla de los 2 meses (${y.salesCount} ${y.salesCount === 1 ? 'venta' : 'ventas'})</span></summary>
          ${salesTable}
          ${libsBlock}
        </details>

        <details class="irpf-details">
          <summary><span>Tramos de la Base del Ahorro y dividendos del ejercicio (${y.year})</span></summary>
          ${bracketsTable}
          ${divsTable}
        </details>`;
    }

    $('irpf-year-tabs').addEventListener('click', (ev)=>{
      const btn = ev.target.closest('[data-year]');
      if (!btn) return;
      selectedYear = Number(btn.dataset.year);
      $('irpf-year-tabs').querySelectorAll('[data-year]').forEach(b=>{
        const on = Number(b.dataset.year) === selectedYear;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderYear(selectedYear);
    });
    renderYear(selectedYear);

    // Simulador interactivo "¿Y si vendo hoy?"
    const simForm = $('irpf-sim-form');
    if (simForm){
      const isinSel = $('irpf-sim-isin');
      const qtyInp = $('irpf-sim-qty');
      const priceInp = $('irpf-sim-price');
      const feeInp = $('irpf-sim-fee');
      const dateInp = $('irpf-sim-date');
      const resBox = $('irpf-sim-result');
      const fmtIn = (n, d) => (isFinite(n) ? String(Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).replace('.', ',') : '');

      function fillDefaults(){
        const p = openPos.find(x=>x.isin === isinSel.value);
        if (!p) return;
        qtyInp.value = fmtIn(p.qty, p.qty % 1 ? 4 : 0);
        const curPrice = livePriceEurByIsin.get(p.isin) || (p.costEur / p.qty);
        priceInp.value = fmtIn(curPrice, 2);
        resBox.innerHTML = '';
      }
      isinSel.addEventListener('change', fillDefaults);
      $('irpf-sim-all').addEventListener('click', ()=>{
        const p = openPos.find(x=>x.isin === isinSel.value);
        if (p) qtyInp.value = fmtIn(p.qty, p.qty % 1 ? 4 : 0);
      });
      fillDefaults();

      simForm.addEventListener('submit', async (ev)=>{
        ev.preventDefault();
        resBox.innerHTML = '<span class="row-sub">Calculando simulación FIFO…</span>';
        try {
          const qs = new URLSearchParams({
            isin: isinSel.value,
            qty: qtyInp.value.trim(),
            price_eur: priceInp.value.trim(),
            fee_eur: feeInp.value.trim() || '0',
            date: dateInp.value || STATUS.today,
          }).toString();
          const r = await api('GET', '/api/irpf/simulate?' + qs);
          const warn2m = r.blockedQty > 0
            ? `<div class="notice warn"><b>Saltaría la regla de los 2 meses:</b> ${num(r.blockedQty, r.blockedQty % 1 ? 4 : 0)} títulos quedarían bloqueados (${eur(r.blockedLoss)}) por compras recientes (${r.triggers.map(tr=>`${isoLabel(tr.date)} en ${esc(tr.account)}`).join(', ')}). Solo serían computables ahora <b>${eur(r.computableGain)}</b>.</div>`
            : (r.gain < 0 ? `<div class="notice ok"><b>Sin bloqueo actual por regla de los 2 meses:</b> la pérdida de ${eur(r.gain)} sería computable en ${r.year}, siempre que no recompres ${esc(r.name)} en los 2 meses siguientes.</div>` : '');
          const libMsg = r.liberatedNow < -0.005
            ? `<div class="notice ok"><b>Además liberarías ${eur(r.liberatedNow)}</b> de pérdidas diferidas retenidas en esos lotes.</div>` : '';
          resBox.innerHTML = `
            <div class="irpf-sim-box">
              <div class="irpf-sim-metrics">
                <div><div class="irpf-kpi-label">Transmisión neta</div><div class="irpf-kpi-val">${eur(r.txEur)}</div></div>
                <div><div class="irpf-kpi-label">Coste FIFO</div><div class="irpf-kpi-val">${eur(r.costEur)}</div></div>
                <div><div class="irpf-kpi-label">Resultado FIFO</div><div class="irpf-kpi-val ${sg(r.gain)}">${eur(r.gain, {forceSign:true})}</div></div>
                <div><div class="irpf-kpi-label">Impacto cuota ${r.year}</div><div class="irpf-kpi-val ${r.deltaCuotaNeta > 0 ? 'neg' : (r.deltaCuotaNeta < 0 ? 'pos' : '')}">${eur(r.deltaCuotaNeta, {forceSign:true})}</div><div class="irpf-kpi-sub">Base ahorro: ${eur(r.before.baseAhorro)} → ${eur(r.after.baseAhorro)}</div></div>
              </div>
              ${warn2m}${libMsg}
              <div class="row-sub" style="margin-top:8px;"><b>Lotes FIFO que saldrían:</b></div>
              <ul class="irpf-lots-list">${r.slices.map(sl=>`<li>${isoLabel(sl.buyDate)} (${esc(sl.buyAccount)}): ${num(sl.qty, sl.qty % 1 ? 4 : 0)} títulos · coste ${eur(sl.costEur)}</li>`).join('')}</ul>
            </div>`;
        } catch (err){
          resBox.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
        }
      });
    }
  })();

  /* ================= TEXTOS QUE DEPENDEN DE LOS DATOS ================= */
  (function(){
    if (CONFIG.titular) $('eyebrow-text').textContent = `${CONFIG.titular} · Cartera personal`;
    const nTrades = behavior.quarterly.reduce((a,q)=>a+q.n_trades, 0);
    const lastClose = behavior.episodes.map(e=>e.close).sort().pop();
    if (monthly.length) $('note-contrib').textContent = `${isoMonthLabel(monthly[0].month)} – ${isoMonthLabel(monthly[monthly.length - 1].month)} · suma de depósitos menos retiradas, mes a mes`;
    $('note-holdings').textContent = BOTH ? `${combined.open_positions_count} posiciones · ${ibkr.positions.length} en Interactive Brokers, ${degiro_open_positions.length} en DEGIRO` : `${combined.open_positions_count} posiciones`;
    if (!BOTH && !NONE) $('subtitle-brokers').innerHTML = `Vista de tu cuenta de <b>${HAS.degiro ? 'DEGIRO' : 'Interactive Brokers'}</b>`;
    $('note-realized').textContent = `${degiro_realized.length} valores con resultado realizado, de ${isoMonthLabel(combined.degiro_date_min)} a ${lastClose ? isoMonthLabel(lastClose) : '—'}`;
    $('note-behavior').textContent = `Solo DEGIRO · ${nTrades} operaciones, ${behavior.episodes.length} posiciones cerradas, ${isoMonthLabel(combined.degiro_date_min)} – ${isoMonthLabel(combined.degiro_date_max)}`;
    $('sources-text').innerHTML =
      (HAS.ibkr ? `<b>Interactive Brokers</b> — ${(ibkr.statements || []).length > 1 ? `${ibkr.statements.length} informes de actividad` : 'informe de actividad'} de la cuenta ${esc(ibkr.account)}, del ${isoLabel(ibkr.period_start)} al ${isoLabel(ibkr.period_end)}${ibkr.statement_generated ? `, generado el ${isoLabel(ibkr.statement_generated)}` : ''}.<br>` : '') +
      (HAS.degiro ? `<b>DEGIRO</b> — estado de cuenta, del ${isoLabel(combined.degiro_date_min)} al ${isoLabel(combined.degiro_date_max)}${combined.degiro_movements_count ? ` (${num(combined.degiro_movements_count,0)} movimientos)` : ''}.` : '') +
      (SOURCES.degiro || SOURCES.ibkr ? `<br>Los extractos importados se guardan, ya sin repetidos, en <span class="mono">data/</span>; todas las cifras se recalculan desde ellos.` : '');
  })();

  /* ================= ESTADO DE LA APLICACIÓN ================= */
  (function(){
    const git = STATUS.git || {};
    const parts = [];
    parts.push(`Datos en <span class="mono">${esc(STATUS.dataFile)}</span>`);
    if (HAS.degiro) parts.push(`DEGIRO hasta el ${isoLabel(combined.degiro_date_max)}`);
    if (HAS.ibkr) parts.push(`IBKR hasta el ${isoLabel(ibkr.period_end)}`);
    if (HAS.degiro && DATA.live_meta.fetched_date) parts.push(`precios del ${esc(DATA.live_meta.fetched_date)}`);
    if (git.repo){
      parts.push(git.hash
        ? `git <span class="mono">${esc(git.hash)}</span>${git.pending ? ' · cambios sin confirmar' : ''}${git.hasRemote ? '' : ' · sin remoto'}`
        : 'git: repositorio sin commits todavía');
    } else {
      parts.push('sin repositorio git (los cambios solo dejan copia de seguridad)');
    }
    parts.push(STATUS.hasApiKey ? 'Alpha Vantage: clave configurada' : 'Alpha Vantage: sin clave — precios a mano');
    $('app-status').innerHTML = parts.join(' <span class="sep">·</span> ');
    // Posiciones de DEGIRO que todavía no tienen precio de mercado (instalación nueva o valor recién comprado).
    const provisional = degiro_open_positions.filter(p=>/^Precio de la última operación/.test(p.live_src || ''));
    if (provisional.length){
      const n = $('price-notice');
      n.hidden = false;
      n.innerHTML = `<b>${provisional.length === 1 ? 'Una posición de DEGIRO está valorada' : provisional.length + ' posiciones de DEGIRO están valoradas'} al precio de su última compra o venta</b>, no al de hoy (el extracto no trae cotizaciones): el valor y la rentabilidad no son reales hasta que pulses «Actualizar precios».`;
    }

    const pill = $('checks-pill');
    const navPill = $('topnav-checks');
    const s = CHECKS_SUMMARY;
    if (s.errors){
      pill.className = 'status-pill bad';
      pill.textContent = `✗ ${s.errors} ${s.errors === 1 ? 'comprobación falla' : 'comprobaciones fallan'}`;
      if (navPill){ navPill.className = 'topnav-pill bad'; navPill.textContent = `✗ ${s.errors}`; navPill.title = pill.textContent; }
    } else if (s.warnings){
      pill.className = 'status-pill warn';
      pill.textContent = `⚠ ${s.passed} de ${s.total} comprobaciones · ${s.warnings} ${s.warnings === 1 ? 'aviso' : 'avisos'}`;
      if (navPill){ navPill.className = 'topnav-pill warn'; navPill.textContent = `⚠ ${s.warnings}`; navPill.title = pill.textContent; }
    } else {
      pill.className = 'status-pill ok';
      pill.textContent = `✓ ${s.total} comprobaciones correctas`;
      if (navPill){ navPill.className = 'topnav-pill ok'; navPill.textContent = `✓ ${s.total}`; navPill.title = pill.textContent; }
    }
  })();

  /* ================= COMPROBACIONES ================= */
  (function(){
    const s = CHECKS_SUMMARY;
    $('note-checks').textContent = s.errors
      ? `${s.errors} de ${s.total} no cuadran`
      : `${s.passed} de ${s.total} correctas${s.warnings ? ` · ${s.warnings} ${s.warnings === 1 ? 'aviso' : 'avisos'}` : ''}`;
    const groups = [];
    CHECKS.forEach(k=>{
      let g = groups.find(x=>x.name === k.group);
      if (!g){ g = { name:k.group, items:[] }; groups.push(g); }
      g.items.push(k);
    });
    function fmtVal(v, unit){
      if (v == null || !isFinite(v)) return '—';
      return unit === '%' ? nf2.format(v) + ' %' : nf2.format(v) + ' €';
    }
    const html = groups.map(g=>{
      const bad = g.items.filter(k=>!k.ok).length;
      const errs = g.items.filter(k=>!k.ok && k.level === 'error').length;
      const badgeCls = errs ? 'bad' : (bad ? 'warn' : 'ok');
      const rows = g.items.map(k=>{
        const state = k.ok ? 'ok' : (k.level === 'error' ? 'bad' : 'warn');
        const icon = k.ok ? '✓' : (k.level === 'error' ? '✗' : '⚠');
        let right = '';
        if (k.expected != null){
          right = k.ok
            ? `<span class="check-val">${fmtVal(k.actual, k.unit)}</span>`
            : `<span class="check-val">guardado ${fmtVal(k.actual, k.unit)} · recalculado ${fmtVal(k.expected, k.unit)} · diferencia ${fmtVal(k.diff, k.unit)}</span>`;
        }
        const note = (k.note && (!k.ok || k.level !== 'error')) ? `<div class="check-note">${esc(k.note)}</div>` : '';
        const detail = k.detail ? `<div class="check-note">${esc(k.detail)}</div>` : '';
        return `<li class="check ${state}"><span class="check-icon">${icon}</span><div class="check-text"><div>${esc(k.label)}</div>${detail}${note}</div>${right}</li>`;
      }).join('');
      return `<details class="check-group" ${bad ? 'open' : ''}><summary><span class="check-group-name">${esc(g.name)}</span><span class="check-group-count ${badgeCls}">${g.items.length - bad}/${g.items.length}</span></summary><ul>${rows}</ul></details>`;
    }).join('');
    $('checks-list').innerHTML = html;
  })();

  /* ================= HISTORIAL Y DESHACER ================= */
  (function(){
    const journal = (DATA.journal || []).slice().reverse();
    const KIND = { precios:'Precios', movimiento:'Movimiento', importacion:'Extractos' };
    $('note-journal').textContent = journal.length ? `${journal.length} ${journal.length === 1 ? 'cambio registrado' : 'cambios registrados'} desde esta aplicación` : 'Todavía no hay cambios hechos desde esta aplicación';
    const t = $('journal-table');
    if (!journal.length){
      t.innerHTML = `<tbody><tr><td class="row-sub">Aquí aparecerá cada actualización de precios y cada movimiento que registres, con su fecha.</td></tr></tbody>`;
    } else {
      const rows = journal.slice(0, 40).map(j=>{
        const when = new Date(j.ts);
        const whenTxt = isNaN(when) ? '' : when.toLocaleString('es-ES', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
        const tipo = j.kind === 'movimiento' ? (CONFIG.movementTypes[j.type] || 'Movimiento') : (KIND[j.kind] || j.kind);
        return `<tr><td class="num" style="text-align:left;">${esc(whenTxt)}</td><td><span class="chip chip-degiro">${esc(tipo)}</span></td><td>${esc(j.summary)}${j.date && j.date !== localIso(when) ? ` <span class="row-sub">· con fecha ${isoLabel(j.date)}</span>` : ''}${j.superseded ? ` <span class="row-sub">· sustituido por el extracto importado después</span>` : ''}</td></tr>`;
      }).join('');
      t.innerHTML = `<thead><tr><th>Guardado</th><th>Tipo</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody>`;
    }
    $('journal-note').innerHTML = `Cada guardado deja una copia del estado anterior en <span class="mono">data/backups/</span>${STATUS.git && STATUS.git.repo && STATUS.autoCommit ? ' y un commit en git con este mismo texto, así que el historial completo también está en <span class="mono">git log</span>' : ''}. «Deshacer» devuelve los datos al estado inmediatamente anterior al último guardado.`;

    const btn = $('undo-btn'), st = $('undo-status');
    if (!STATUS.canUndo){ btn.disabled = true; btn.title = 'No hay ningún cambio que deshacer'; }
    let armed = false, timer = null;
    btn.addEventListener('click', async ()=>{
      if (!armed){
        armed = true;
        btn.textContent = '¿Seguro? Pulsa otra vez para deshacer';
        timer = setTimeout(()=>{ armed = false; btn.textContent = '↶ Deshacer el último cambio'; }, 5000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true; st.textContent = 'Deshaciendo…'; st.style.color = '';
      try {
        const r = await api('POST', '/api/undo', {});
        reloadWithToast(r.saved);
      } catch (err){
        st.textContent = err.message; st.style.color = 'var(--critical)';
        btn.disabled = false; armed = false; btn.textContent = '↶ Deshacer el último cambio';
      }
    });
  })();

  /* ================= AVISO TRAS GUARDAR ================= */
  function reloadWithToast(saved){
    let msg = saved && saved.summary ? saved.summary : 'Guardado';
    const c = saved && saved.commit;
    if (c && c.done) msg += ` · commit ${c.hash}${c.pushed ? ' (subido a GitHub)' : ''}${c.pushError ? ' (no se pudo subir: ' + c.pushError + ')' : ''}`;
    try { sessionStorage.setItem('cartera:toast', msg); } catch (e) { /* sin almacenamiento: se recarga sin aviso */ }
    location.reload();
  }
  (function(){
    let msg = null;
    try { msg = sessionStorage.getItem('cartera:toast'); sessionStorage.removeItem('cartera:toast'); } catch (e) { /* nada */ }
    if (!msg) return;
    const t = $('toast');
    t.textContent = '✓ ' + msg;
    t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 7000);
  })();

  function parseNum(str){
    if (str == null) return NaN;
    return parseFloat(String(str).trim().replace(/\s/g,'').replace(',','.'));
  }
  function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
  function bindModal(overlay, closeFn){
    let lastFocus = null;
    const origClose = closeFn;
    const wrappedClose = () => {
      origClose();
      if (lastFocus && typeof lastFocus.focus === 'function'){ try { lastFocus.focus(); } catch (e) { /* ya no existe */ } }
      lastFocus = null;
    };
    const obs = new MutationObserver(()=>{
      if (overlay.style.display !== 'none' && !lastFocus) lastFocus = document.activeElement;
    });
    obs.observe(overlay, { attributes:true, attributeFilter:['style'] });
    overlay.addEventListener('mousedown', (ev)=>{ if (ev.target === overlay) wrappedClose(); });
    document.addEventListener('keydown', (ev)=>{ if (ev.key === 'Escape' && overlay.style.display !== 'none') wrappedClose(); });
  }

  /* ================= ACTUALIZAR PRECIOS (Alpha Vantage con tu clave + entrada manual) ================= */
  (function(){
    const overlay = $('price-modal-overlay');
    const openBtn = $('open-price-modal');
    const saveBtn = $('modal-save');
    const retryBtn = $('modal-retry');
    const statusEl = $('modal-status');
    const fxWrap = $('fx-inputs');
    const degWrap = $('degiro-price-inputs');

    const AV_MAP = CONFIG.symbols || {};
    const canAuto = !!STATUS.hasApiKey;
    const fxStored = DATA.live_meta.fx || {};
    // Para las posiciones con símbolo manda la divisa en la que cotiza ESE símbolo
    // (p. ej. un valor europeo consultado a través de su cotización en el Nasdaq en USD).
    function rowCur(p){ const av = canAuto && AV_MAP[p.isin]; return av ? av.cur : (p.live_price_cur || p.last_price_cur); }
    const FX_CURRENCIES = Array.from(new Set(Object.keys(fxStored).concat(degiro_open_positions.map(rowCur))))
      .filter(c=>c !== 'EUR').sort();
    const AUTO_FX = canAuto ? FX_CURRENCIES.filter(c=>(CONFIG.autoFx || []).includes(c)) : [];

    const manualNames = degiro_open_positions.filter(p=>!AV_MAP[p.isin]).map(p=>p.name);
    $('price-modal-intro').innerHTML = canAuto
      ? `El extracto de DEGIRO no trae cotizaciones, así que al abrir esta ventana la aplicación las busca en Alpha Vantage con tu clave (marcadas <span class="auto-badge">auto</span>). Algunas usan una cotización equivalente en otra bolsa donde cotiza el mismo valor.${manualNames.length ? ` Sin símbolo configurado y, por tanto, a mano: <b>${manualNames.map(esc).join(', ')}</b>.` : ''} El plan gratuito permite unas 25 consultas al día: si ves un ✗ por límite alcanzado, puedes completar a mano o reintentar más tarde (las respuestas ya obtenidas no vuelven a gastar cupo durante unos minutos). Al guardar se recalculan el valor, las plusvalías, los totales y la TIR. No afecta a Interactive Brokers.`
      : `No hay clave de Alpha Vantage configurada, así que los precios se introducen a mano: escribe la última cotización de cada valor en la divisa indicada y revisa los tipos de cambio. Al guardar se recalculan el valor, las plusvalías, los totales y la TIR. No afecta a Interactive Brokers.
         <span class="key-box"><b>¿Quieres que los busque sola?</b> Pide una clave gratuita en alphavantage.co/support/#api-key y pégala aquí. Se guarda solo en este ordenador (archivo <span class="mono">.env</span>, que no se sube a GitHub).
         <span class="key-row"><input type="password" id="av-key-input" placeholder="Clave de Alpha Vantage" autocomplete="off" spellcheck="false" aria-label="Clave de Alpha Vantage"><button type="button" class="btn-secondary" id="av-key-save">Guardar clave</button></span><span id="av-key-status" class="key-status"></span></span>`;
    const keyBtn = $('av-key-save');
    if (keyBtn){
      keyBtn.addEventListener('click', async ()=>{
        const st = $('av-key-status');
        st.style.color = ''; st.textContent = 'Guardando…'; keyBtn.disabled = true;
        try {
          await api('POST', '/api/apikey', { key: $('av-key-input').value.trim() });
          try { sessionStorage.setItem('cartera:toast', 'Clave guardada: pulsa «Actualizar precios» para buscarlos automáticamente'); } catch (e) { /* sin aviso */ }
          location.reload();
        } catch (err){
          st.textContent = err.message; st.style.color = 'var(--critical)'; keyBtn.disabled = false;
        }
      });
    }

    let autoFetchedIdx = new Set();
    let autoFetchedFx = new Set();
    let fetchInFlight = false;
    let runId = 0;

    function buildInputs(){
      fxWrap.innerHTML = '';
      FX_CURRENCIES.forEach(cur=>{
        const auto = AUTO_FX.includes(cur);
        const row = document.createElement('div');
        row.className = 'fx-row';
        row.innerHTML = `<label for="fx-${cur}">${cur}${auto ? ' <span class="auto-badge">auto</span>' : ''}</label>`;
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '0.0001'; inp.min = '0'; inp.id = 'fx-' + cur;
        inp.dataset.fx = cur;
        inp.value = fxStored[cur] != null ? fxStored[cur] : '';
        if (auto) inp.disabled = true;
        row.appendChild(inp);
        if (auto){
          const st = document.createElement('span');
          st.className = 'fetch-status'; st.dataset.fxStatus = cur;
          row.appendChild(st);
        }
        fxWrap.appendChild(row);
      });

      degWrap.innerHTML = '';
      degiro_open_positions.forEach((p,i)=>{
        const avInfo = canAuto ? AV_MAP[p.isin] : null;
        const knownCur = p.live_price_cur || p.last_price_cur;
        const cur = rowCur(p);
        // Solo se rellena con el último precio conocido si está en la MISMA divisa
        // que va a tener la casilla; si no, se deja vacía para que un fallo se vea.
        const price = (p.live_price != null ? p.live_price : p.last_price);
        const prefill = cur === knownCur ? price : null;
        const row = document.createElement('div');
        row.className = 'price-row';
        row.innerHTML = `<div class="price-row-name">${esc(p.name)} <span class="row-sub">${esc(cur)}</span>${avInfo ? ` <span class="auto-badge">auto · ${esc(avInfo.label || avInfo.symbol)}</span>` : ''}</div>`;
        const inputsWrap = document.createElement('div');
        inputsWrap.className = 'price-row-inputs';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '0.0001'; inp.min = '0';
        inp.setAttribute('aria-label', `Precio de ${p.name} en ${cur}`);
        inp.dataset.degIdx = i;
        inp.dataset.cur = cur;
        inp.value = prefill != null ? prefill : '';
        if (avInfo) inp.disabled = true;
        inputsWrap.appendChild(inp);
        if (avInfo){
          const st = document.createElement('span');
          st.className = 'fetch-status'; st.dataset.degStatus = i;
          inputsWrap.appendChild(st);
        }
        row.appendChild(inputsWrap);
        degWrap.appendChild(row);
      });
    }

    // Índices de referencia: se consulta su último cierre para que la gráfica de comparación
    // tenga los mismos días que tus valores. Solo se muestran; no entran en el guardado.
    const benchWrap = $('bench-price-inputs');
    const BENCH_LIST = canAuto ? (CONFIG.benchmarks || []) : [];
    function buildBenchRows(){
      benchWrap.innerHTML = '';
      $('bench-price-section').hidden = !BENCH_LIST.length;
      BENCH_LIST.forEach((b,i)=>{
        const row = document.createElement('div');
        row.className = 'price-row';
        row.innerHTML = `<div class="price-row-name">${esc(b.name)} <span class="row-sub">${esc(b.cur)}</span> <span class="auto-badge">auto · ${esc(b.symbol)}</span></div>
          <div class="price-row-inputs"><input type="number" disabled data-bench-idx="${i}" aria-label="Último cierre de ${esc(b.name)}"><span class="fetch-status" data-bench-status="${i}"></span></div>`;
        benchWrap.appendChild(row);
      });
    }

    function enableManual(inp){ if (inp && inp.dataset.benchIdx == null) inp.disabled = false; }
    function enableAllManual(){
      degWrap.querySelectorAll('input').forEach(enableManual);
      fxWrap.querySelectorAll('input').forEach(enableManual);
    }

    function classifyError(err){
      const code = err && err.code;
      const msg = (err && err.message) || 'error desconocido';
      if (code === 'network') return { abort:true, hint:msg, banner:'Sin conexión a internet — completa los precios a mano o pulsa «Reintentar automático» cuando vuelvas a tener conexión.' };
      if (code === 'rate_limited') return { abort:true, hint:msg, banner:'Se alcanzó el límite de consultas gratuitas de Alpha Vantage — completa a mano o reintenta más tarde.' };
      if (code === 'bad_key' || code === 'no_api_key') return { abort:true, hint:msg, banner:'Alpha Vantage no acepta la clave — revisa ALPHAVANTAGE_API_KEY en el archivo .env. Mientras tanto puedes completar a mano.' };
      if (code === 'server_down') return { abort:true, hint:msg, banner:msg };
      return { abort:false, hint:msg, banner:null };
    }

    function buildQueue(){
      const q = [];
      AUTO_FX.forEach(cur=>{
        q.push({
          statusEl: () => fxWrap.querySelector(`[data-fx-status="${cur}"]`),
          inputEl: () => fxWrap.querySelector(`input[data-fx="${cur}"]`),
          run: async () => { const r = await api('GET', '/api/fx?currency=' + encodeURIComponent(cur)); return { value:r.rate, cached:!!r.cached }; },
          onSuccess: () => autoFetchedFx.add(cur),
        });
      });
      degiro_open_positions.forEach((p,i)=>{
        const avInfo = AV_MAP[p.isin];
        if (!avInfo) return;
        q.push({
          statusEl: () => degWrap.querySelector(`[data-deg-status="${i}"]`),
          inputEl: () => degWrap.querySelector(`input[data-deg-idx="${i}"]`),
          run: async () => { const r = await api('GET', '/api/quote?symbol=' + encodeURIComponent(avInfo.symbol)); return { value:r.price, cached:!!r.cached }; },
          onSuccess: () => autoFetchedIdx.add(i),
        });
      });
      BENCH_LIST.forEach((b,i)=>{
        q.push({
          optional: true,
          statusEl: () => benchWrap.querySelector(`[data-bench-status="${i}"]`),
          inputEl: () => benchWrap.querySelector(`input[data-bench-idx="${i}"]`),
          run: async () => { const r = await api('GET', '/api/indices/daily?symbol=' + encodeURIComponent(b.symbol)); return { value:r.price, cached:!!r.cached }; },
          onSuccess: () => {},
        });
      });
      return q;
    }

    async function runAutoFetch(){
      if (fetchInFlight) return;
      autoFetchedIdx = new Set();
      autoFetchedFx = new Set();
      statusEl.style.color = '';
      if (!canAuto){
        statusEl.textContent = 'Sin clave de Alpha Vantage: introduce los precios a mano.';
        retryBtn.style.display = 'none';
        return;
      }
      fetchInFlight = true;
      retryBtn.disabled = true;
      const myRun = ++runId;
      statusEl.textContent = 'Buscando precios en Alpha Vantage…';
      const queue = buildQueue();
      const needed = queue.filter(it=>!it.optional).length;
      let ok = 0, fail = 0, optFail = 0, aborted = false, abortBanner = '';

      for (const item of queue){
        if (myRun !== runId) break; // la ventana se cerró y se volvió a abrir
        const st = item.statusEl();
        const inp = item.inputEl();
        if (aborted){
          if (st){ st.textContent = '—'; st.title = 'Omitido'; }
          enableManual(inp);
          continue;
        }
        if (st){ st.textContent = '⏳'; st.style.color = ''; }
        let cached = false;
        try {
          const r = await item.run();
          if (myRun !== runId) break;
          inp.value = r.value;
          cached = r.cached;
          item.onSuccess();
          if (st){ st.textContent = '✓'; st.style.color = 'var(--good)'; st.title = ''; }
          if (!item.optional) ok++;
        } catch(err){
          const c = classifyError(err);
          if (st){ st.textContent = '✗'; st.style.color = 'var(--critical)'; st.title = c.hint; }
          enableManual(inp);
          if (item.optional){ optFail++; if (c.abort) aborted = true; }
          else { fail++; if (c.abort){ aborted = true; abortBanner = c.banner; } }
        }
        if (!cached && !aborted) await sleep(CONFIG.delayMs || 1300);
      }
      if (myRun !== runId) return;

      const benchNote = optFail ? ' (Los índices de referencia no se han podido consultar: la gráfica de comparación se queda con sus últimos datos.)' : '';
      if (abortBanner){
        statusEl.textContent = `${abortBanner} (${ok} de ${needed} obtenidos automáticamente.)`;
        statusEl.style.color = 'var(--critical)';
      } else if (fail > 0){
        statusEl.textContent = `${ok} de ${needed} obtenidos automáticamente; ${fail} sin datos — complétalos a mano o reintenta.${benchNote}`;
      } else {
        statusEl.textContent = `${ok} precios y tipos de cambio obtenidos de Alpha Vantage. Revisa y pulsa «Recalcular y guardar».${benchNote}`;
        statusEl.style.color = 'var(--good)';
      }
      fetchInFlight = false;
      retryBtn.disabled = false;
    }

    function openModal(){
      buildInputs();
      buildBenchRows();
      statusEl.textContent = '';
      saveBtn.disabled = false;
      overlay.style.display = 'flex';
      runAutoFetch();
    }
    function closeModal(){ overlay.style.display = 'none'; runId++; fetchInFlight = false; retryBtn.disabled = false; }

    openBtn.addEventListener('click', openModal);
    $('modal-close').addEventListener('click', closeModal);
    $('modal-cancel').addEventListener('click', closeModal);
    retryBtn.addEventListener('click', runAutoFetch);
    bindModal(overlay, closeModal);

    saveBtn.addEventListener('click', async ()=>{
      const fx = {}, fxAuto = {};
      let hasError = false;
      fxWrap.querySelectorAll('input').forEach(inp=>{
        const v = parseNum(inp.value);
        if (!isFinite(v) || v <= 0){ hasError = true; inp.style.borderColor = 'var(--critical)'; }
        else { fx[inp.dataset.fx] = v; fxAuto[inp.dataset.fx] = autoFetchedFx.has(inp.dataset.fx); inp.style.borderColor = ''; }
      });
      const prices = [];
      degWrap.querySelectorAll('input').forEach(inp=>{
        const v = parseNum(inp.value);
        if (!isFinite(v) || v <= 0){ hasError = true; inp.style.borderColor = 'var(--critical)'; return; }
        inp.style.borderColor = '';
        const idx = parseInt(inp.dataset.degIdx, 10);
        const p = degiro_open_positions[idx];
        const auto = autoFetchedIdx.has(idx);
        prices.push({ id:p.id, isin:p.isin, price:v, cur:inp.dataset.cur, auto, symbol: auto ? (AV_MAP[p.isin] || {}).symbol : undefined });
      });
      if (hasError){
        statusEl.textContent = 'Revisa las casillas en rojo: deben ser números mayores que 0.';
        statusEl.style.color = 'var(--critical)';
        enableAllManual();
        return;
      }
      saveBtn.disabled = true;
      statusEl.style.color = '';
      statusEl.textContent = 'Guardando…';
      try {
        const r = await api('POST', '/api/prices', { fx, fx_auto: fxAuto, prices });
        reloadWithToast(r.saved);
      } catch (err){
        statusEl.textContent = 'No se pudo guardar: ' + err.message;
        statusEl.style.color = 'var(--critical)';
        saveBtn.disabled = false;
      }
    });
  })();

  /* ================= REGISTRAR MOVIMIENTO ================= */
  (function(){
    const overlay = $('mov-modal-overlay');
    const form = $('mov-form');
    const tabs = $('mov-types');
    const fieldsEl = $('mov-fields');
    const helpEl = $('mov-help');
    const previewEl = $('mov-preview');
    const statusEl = $('mov-status');
    const saveBtn = $('mov-save');
    const fx = DATA.live_meta.fx || {};
    const positions = degiro_open_positions.slice().sort((a,b)=>a.name.localeCompare(b.name));
    const NEW = '__nuevo__', OTHER = '__otro__';

    const TYPES = Object.keys(CONFIG.movementTypes).map(k=>[k, CONFIG.movementTypes[k]]);
    const HELP = {
      compra: 'Copia los datos de la operación tal como salen en el extracto de DEGIRO. El <b>importe en EUR</b> es lo que realmente salió de tu cuenta por los títulos, sin la comisión: si el valor cotiza en otra divisa, usa el importe ya convertido que muestra DEGIRO.',
      venta: 'El resultado se calcula por coste medio, igual que el resto del panel. El <b>importe en EUR</b> es lo que entró en tu cuenta por los títulos, antes de restar la comisión.',
      dividendo: 'Indica el bruto y la retención en euros tal como quedan tras la conversión de divisa del extracto. Si el valor ya tenía dividendos, se suma a su fila.',
      aportacion: 'Dinero que ingresas en DEGIRO desde tu banco. Cuenta para las aportaciones netas y para la TIR. Los traspasos internos entre DEGIRO y la cuenta de efectivo de flatex no son aportaciones.',
      retirada: 'Dinero que sacas de DEGIRO hacia tu banco. Resta de las aportaciones netas y cuenta para la TIR.',
      comision: 'Costes que no son de compraventa: conectividad con mercados, comisiones de ADR, depósitos instantáneos… Las comisiones de una compra o una venta se indican en la propia operación, no aquí.',
      interes: 'Intereses de la cuenta de efectivo: normalmente un cargo por saldo negativo.',
    };
    let current = TYPES[0][0];

    function input(name, label, o){
      o = o || {};
      const cls = 'field' + (o.full ? ' full' : '') + (o.cls ? ' ' + o.cls : '');
      let control;
      if (o.options){
        control = `<select name="${name}" id="mov-${name}">${o.options.map(([v,t])=>`<option value="${esc(v)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
      } else if (o.type === 'date'){
        control = `<input type="date" name="${name}" id="mov-${name}" value="${esc(o.value || '')}" max="${esc(STATUS.today)}"${coveredTo && name === 'fecha' ? ` min="${esc(coveredTo)}"` : ''}>`;
      } else if (o.type === 'text'){
        control = `<input type="text" name="${name}" id="mov-${name}" value="${esc(o.value || '')}" placeholder="${esc(o.placeholder || '')}" autocomplete="off"${o.maxlength ? ` maxlength="${o.maxlength}"` : ''}>`;
      } else {
        control = `<input type="text" inputmode="decimal" name="${name}" id="mov-${name}" value="${esc(o.value == null ? '' : o.value)}" placeholder="${esc(o.placeholder || '')}" autocomplete="off">`;
      }
      return `<div class="${cls}" data-field="${name}"><label for="mov-${name}">${label}</label>${control}${o.hint ? `<div class="field-hint">${o.hint}</div>` : ''}</div>`;
    }
    const get = (name) => { const e = form.elements[name]; return e ? e.value.trim() : ''; };
    const set = (name, v) => { const e = form.elements[name]; if (e) e.value = v; };
    const show = (name, on) => { const e = fieldsEl.querySelector(`[data-field="${name}"]`); if (e) e.style.display = on ? '' : 'none'; };
    const pkey = (p) => p.id || p.isin;
    const posByIsin = (code) => degiro_open_positions.find(p=>pkey(p) === code);
    const coveredTo = SOURCES.degiro ? SOURCES.degiro.date_max : null;
    const fmtInput = (n, d) => (isFinite(n) ? String(Math.round(n * Math.pow(10,d)) / Math.pow(10,d)).replace('.', ',') : '');

    function divNames(){
      const seen = new Map();
      positions.forEach(p=>seen.set(p.name.toLowerCase(), p.name));
      dividends.filter(d=>d.account === 'DEGIRO').forEach(d=>{ if (!seen.has(d.name.toLowerCase())) seen.set(d.name.toLowerCase(), d.name); });
      return Array.from(seen.values()).sort((a,b)=>a.localeCompare(b));
    }

    function renderFields(){
      const today = STATUS.today;
      const repeated = new Set(positions.map(p=>p.isin).filter((x,i,a)=>a.indexOf(x) !== i));
      const posOpts = positions.map(p=>[pkey(p), `${p.name}${repeated.has(p.isin) ? ` (línea en ${p.last_price_cur})` : ''} — ${num(p.qty, p.qty % 1 ? 4 : 0)} títulos`]);
      let h = '';
      if (current === 'compra'){
        h += input('fecha', 'Fecha de la operación', { type:'date', value:today });
        h += input('isin_sel', 'Valor', { options: posOpts.concat([[NEW, '＋ Valor nuevo…']]) });
        h += input('nombre', 'Nombre del valor', { type:'text', cls:'only-new', placeholder:'p. ej. Microsoft Corporation', maxlength:80 });
        h += input('isin', 'ISIN', { type:'text', cls:'only-new', placeholder:'12 caracteres', maxlength:12 });
        h += input('cantidad', 'Cantidad de títulos');
        h += input('precio', 'Precio por título');
        h += input('divisa', 'Divisa del precio', { type:'text', maxlength:3, placeholder:'EUR' });
        h += input('comision_eur', 'Comisión en EUR', { value:'0' });
        h += input('importe_eur', 'Importe en EUR (sin comisión)', { full:true, hint:'<span id="mov-importe-hint"></span>' });
        h += input('av_symbol', 'Símbolo en Alpha Vantage (opcional)', { type:'text', cls:'only-new', placeholder:'p. ej. MSFT', maxlength:15, hint:'Para que su precio se actualice solo. Si lo dejas vacío, se introduce a mano.' });
        h += input('av_cur', 'Divisa de ese símbolo', { type:'text', cls:'only-new', maxlength:3, placeholder:'USD' });
      } else if (current === 'venta'){
        if (!positions.length){ fieldsEl.innerHTML = '<p class="footnote">No hay posiciones abiertas que vender.</p>'; return; }
        h += input('fecha', 'Fecha de la operación', { type:'date', value:today });
        h += input('isin_sel', 'Valor', { options: posOpts });
        h += input('cantidad', 'Cantidad de títulos', { hint:'<button type="button" class="link-btn" id="mov-sell-all">Vender toda la posición</button>' });
        h += input('precio', 'Precio por título');
        h += input('divisa', 'Divisa del precio', { type:'text', maxlength:3 });
        h += input('importe_eur', 'Importe en EUR (antes de comisión)', { hint:'<span id="mov-importe-hint"></span>' });
        h += input('comision_eur', 'Comisión en EUR', { value:'0' });
        h += input('fecha_apertura', 'Fecha en que abriste la posición', { type:'date', hint:'Hace falta para el gráfico de días en cartera: el extracto original no guardó esta fecha.' });
      } else if (current === 'dividendo'){
        h += input('fecha', 'Fecha de pago', { type:'date', value:today });
        h += input('nombre_sel', 'Valor', { options: divNames().map(n=>[n,n]).concat([[OTHER, 'Otro valor…']]) });
        h += input('nombre_otro', 'Nombre del valor', { type:'text', maxlength:80 });
        h += input('divisa', 'Divisa del dividendo', { type:'text', maxlength:3 });
        h += input('bruto_nativo', 'Bruto en la divisa original');
        h += input('bruto_eur', 'Bruto en EUR', { hint:'<span id="mov-importe-hint"></span>' });
        h += input('retencion_eur', 'Retención en EUR', { value:'0' });
      } else if (current === 'aportacion' || current === 'retirada'){
        h += input('fecha', 'Fecha', { type:'date', value:today });
        h += input('importe', 'Importe en EUR');
      } else if (current === 'comision'){
        const cats = Object.keys(CONFIG.feeCategories).filter(k=>k !== 'trade').map(k=>[k, CONFIG.feeCategories[k]]);
        h += input('fecha', 'Fecha', { type:'date', value:today });
        h += input('categoria', 'Tipo de comisión', { options: cats });
        h += input('importe', 'Importe en EUR', { hint:'En positivo: se resta solo.' });
      } else if (current === 'interes'){
        h += input('fecha', 'Fecha', { type:'date', value:today });
        h += input('sentido', 'Sentido', { options: [['pagado','Pagado (cargo)'],['cobrado','Cobrado (abono)']] });
        h += input('importe', 'Importe en EUR', { hint:'En positivo.' });
      }
      fieldsEl.innerHTML = h;
      touched = {};
      syncSelection(true);
      update();
    }

    let touched = {};
    /** Ajusta lo que depende del valor elegido (campos visibles, divisa por defecto). */
    function syncSelection(resetCurrency){
      if (current === 'compra'){
        const isNew = get('isin_sel') === NEW;
        fieldsEl.querySelectorAll('.only-new').forEach(e=>{ e.style.display = isNew ? '' : 'none'; });
        if (resetCurrency){ const p = posByIsin(get('isin_sel')); set('divisa', isNew ? '' : (p ? p.last_price_cur : '')); }
      } else if (current === 'venta'){
        const p = posByIsin(get('isin_sel'));
        if (resetCurrency && p) set('divisa', p.last_price_cur);
      } else if (current === 'dividendo'){
        const other = get('nombre_sel') === OTHER;
        show('nombre_otro', other);
        if (resetCurrency){
          const name = get('nombre_sel').toLowerCase();
          const row = dividends.find(d=>d.account === 'DEGIRO' && d.name.toLowerCase() === name);
          const p = positions.find(x=>x.name.toLowerCase() === name);
          set('divisa', other ? '' : (row ? row.cur : (p ? p.last_price_cur : 'EUR')));
        }
      }
    }

    /** Sugerencias automáticas y vista previa. Solo orientativo: quien calcula es el servidor. */
    function update(){
      const cur = get('divisa').toUpperCase();
      const rate = cur === 'EUR' ? 1 : fx[cur];
      const hint = $('mov-importe-hint');
      let preview = '';

      if (current === 'compra' || current === 'venta'){
        const qty = parseNum(get('cantidad')), price = parseNum(get('precio'));
        if (!touched.importe_eur){
          set('importe_eur', (qty > 0 && price > 0 && rate > 0) ? fmtInput(qty * price / rate, 2) : '');
        }
        if (hint){
          const estimated = !touched.importe_eur && qty > 0 && price > 0;
          hint.textContent = !estimated || !cur || cur === 'EUR' ? ''
            : (rate > 0 ? `Estimado con 1 EUR = ${String(rate).replace('.', ',')} ${cur}: sustitúyelo por el importe real del extracto.`
            : `No hay tipo de cambio guardado para ${cur}: escribe el importe del extracto.`);
        }
        const importe = parseNum(get('importe_eur')), fee = parseNum(get('comision_eur')) || 0;
        const p = posByIsin(get('isin_sel'));
        if (current === 'compra' && importe > 0 && qty > 0){
          const newQty = (p ? p.qty : 0) + qty, newCost = (p ? p.cost_total : 0) + importe + fee;
          preview = `Coste de la operación <b>${eur(importe + fee)}</b> · la posición quedará en <b>${num(newQty, newQty % 1 ? 4 : 0)} títulos</b> con coste medio de <b>${eur(newCost / newQty)}</b> por título.`;
        }
        if (current === 'venta' && p){
          const full = qty > 0 && Math.abs(qty - p.qty) < 1e-9;
          show('fecha_apertura', full && !p.opened);
          if (importe > 0 && qty > 0 && qty <= p.qty + 1e-9){
            const pl = importe - fee - (full ? p.cost_total : p.cost_total * qty / p.qty);
            preview = `Resultado realizado <b class="${sg(pl)}">${eur(pl, {forceSign:true})}</b> sobre un coste medio de ${eur(p.cost_total / p.qty)} por título${full ? ' · <b>la posición queda cerrada</b>' : ` · quedarán ${num(p.qty - qty, (p.qty - qty) % 1 ? 4 : 0)} títulos`}.`;
          } else if (qty > p.qty + 1e-9){
            preview = `<span class="neg">Solo tienes ${num(p.qty, p.qty % 1 ? 4 : 0)} títulos.</span>`;
          }
        }
      } else if (current === 'dividendo'){
        const foreign = !!cur && cur !== 'EUR';
        show('bruto_nativo', foreign);
        const native = parseNum(get('bruto_nativo'));
        if (foreign && !touched.bruto_eur){
          set('bruto_eur', (native > 0 && rate > 0) ? fmtInput(native / rate, 2) : '');
        }
        if (hint){
          hint.textContent = (foreign && !touched.bruto_eur && rate > 0 && native > 0) ? `Estimado con 1 EUR = ${String(rate).replace('.', ',')} ${cur}: sustitúyelo por el importe convertido del extracto.` : '';
        }
        const gross = parseNum(get('bruto_eur')), tax = Math.abs(parseNum(get('retencion_eur')) || 0);
        if (gross > 0) preview = `Neto <b>${eur(gross - tax)}</b>${tax ? ` (retención del ${num(tax / gross * 100, 1)} %)` : ''}.`;
      } else if (current === 'aportacion' || current === 'retirada'){
        const v = parseNum(get('importe'));
        if (v > 0){
          const after = combined.degiro_contributions + (current === 'aportacion' ? v : -v);
          preview = `Aportaciones netas en DEGIRO: ${eur(combined.degiro_contributions)} → <b>${eur(after)}</b>.`;
        }
      }
      previewEl.innerHTML = preview;
      previewEl.style.display = preview ? '' : 'none';
    }

    function buildPayload(){
      const base = { tipo: current, fecha: get('fecha') };
      if (current === 'compra'){
        const isNew = get('isin_sel') === NEW;
        const p = { ...base, isin: isNew ? get('isin').toUpperCase() : get('isin_sel'), cantidad:get('cantidad'), precio:get('precio'), divisa:get('divisa').toUpperCase(), importe_eur:get('importe_eur'), comision_eur:get('comision_eur') };
        if (isNew){ p.nombre = get('nombre'); if (get('av_symbol')){ p.av_symbol = get('av_symbol').toUpperCase(); p.av_cur = (get('av_cur') || get('divisa')).toUpperCase(); } }
        return p;
      }
      if (current === 'venta'){
        const p = { ...base, isin:get('isin_sel'), cantidad:get('cantidad'), precio:get('precio'), divisa:get('divisa').toUpperCase(), importe_eur:get('importe_eur'), comision_eur:get('comision_eur') };
        if (get('fecha_apertura')) p.fecha_apertura = get('fecha_apertura');
        return p;
      }
      if (current === 'dividendo'){
        return { ...base, nombre: get('nombre_sel') === OTHER ? get('nombre_otro') : get('nombre_sel'), divisa:get('divisa').toUpperCase(), bruto_nativo:get('bruto_nativo'), bruto_eur:get('bruto_eur'), retencion_eur:get('retencion_eur') };
      }
      if (current === 'comision') return { ...base, categoria:get('categoria'), importe:get('importe') };
      if (current === 'interes') return { ...base, sentido:get('sentido'), importe:get('importe') };
      return { ...base, importe:get('importe') };
    }

    function renderTabs(){
      tabs.innerHTML = TYPES.map(([k,t])=>`<button type="button" role="tab" class="type-tab${k === current ? ' active' : ''}" data-type="${k}" aria-selected="${k === current}">${esc(t)}</button>`).join('');
      helpEl.innerHTML = (HELP[current] || '') + (coveredTo ? ` <b>Los extractos importados cubren hasta el ${isoLabel(coveredTo)}:</b> registra aquí solo lo posterior. Cuando importes un extracto que ya lo incluya, este apunte a mano se sustituye solo por el del extracto, sin duplicarse.` : '');
    }
    function markError(field){
      fieldsEl.querySelectorAll('.field.error').forEach(e=>e.classList.remove('error'));
      if (!field) return;
      const alias = { isin: get('isin_sel') === NEW ? 'isin' : 'isin_sel', nombre: current === 'dividendo' ? (get('nombre_sel') === OTHER ? 'nombre_otro' : 'nombre_sel') : 'nombre' };
      const e = fieldsEl.querySelector(`[data-field="${alias[field] || field}"]`);
      if (e){ e.classList.add('error'); const c = e.querySelector('input,select'); if (c) c.focus(); }
    }

    tabs.addEventListener('click', (ev)=>{
      const b = ev.target.closest('[data-type]');
      if (!b) return;
      current = b.dataset.type;
      statusEl.textContent = '';
      renderTabs(); renderFields();
    });
    fieldsEl.addEventListener('input', (ev)=>{
      const n = ev.target.name;
      if (n === 'importe_eur' || n === 'bruto_eur') touched[n] = ev.target.value.trim() !== '';
      if (!saveBtn.disabled && statusEl.textContent){ statusEl.textContent = ''; markError(null); }
      if (n === 'isin_sel' || n === 'nombre_sel') syncSelection(true);
      update();
    });
    fieldsEl.addEventListener('change', (ev)=>{ if (ev.target.name === 'isin_sel' || ev.target.name === 'nombre_sel'){ syncSelection(true); update(); } });
    fieldsEl.addEventListener('click', (ev)=>{
      if (ev.target.id !== 'mov-sell-all') return;
      const p = posByIsin(get('isin_sel'));
      if (p){ set('cantidad', String(p.qty).replace('.', ',')); update(); }
    });

    form.addEventListener('submit', async (ev)=>{
      ev.preventDefault();
      if (saveBtn.disabled) return;
      markError(null);
      saveBtn.disabled = true;
      statusEl.style.color = ''; statusEl.textContent = 'Guardando…';
      try {
        const r = await api('POST', '/api/movements', buildPayload());
        reloadWithToast(r.saved);
      } catch (err){
        statusEl.textContent = err.message;
        statusEl.style.color = 'var(--critical)';
        markError(err.field);
        saveBtn.disabled = false;
      }
    });

    function openModal(){
      statusEl.textContent = ''; saveBtn.disabled = false;
      renderTabs(); renderFields();
      overlay.style.display = 'flex';
      const first = fieldsEl.querySelector('input,select'); if (first) first.focus();
    }
    function closeModal(){ overlay.style.display = 'none'; }
    $('open-mov-modal').addEventListener('click', openModal);
    $('mov-close').addEventListener('click', closeModal);
    $('mov-cancel').addEventListener('click', closeModal);
    bindModal(overlay, closeModal);
  })();

  /* ================= IMPORTAR EXTRACTOS (DEGIRO e Interactive Brokers, en CSV) ================= */
  (function(){
    const overlay = $('import-modal-overlay');
    const input = $('import-files');
    const drop = $('import-drop');
    const previewEl = $('import-preview');
    const statusEl = $('import-status');
    const saveBtn = $('import-save');
    let files = [];   // [{ name, content }]
    let busy = false;

    function fmtRange(a, b){ return a === b ? isoLabel(a) : `${isoLabel(a)} – ${isoLabel(b)}`; }
    function delta(f){
      const d = f.after - f.before;
      if (Math.abs(d) < 0.005) return '<span class="row-sub">sin cambios</span>';
      return `<span class="${sg(d)}">${eur(d, {forceSign:true})}</span>`;
    }

    function render(p){
      const fileRows = p.files.map(f=>{
        const chip = f.broker === 'IBKR' ? 'chip-ibkr' : 'chip-degiro';
        const nuevo = f.added ? `<b>${f.added}</b> ${f.added === 1 ? 'apunte nuevo' : 'apuntes nuevos'}` : 'nada nuevo';
        const dup = f.duplicates ? ` · ${f.duplicates} ya ${f.duplicates === 1 ? 'estaba' : 'estaban'}` : '';
        return `<tr><td><span class="chip ${chip}">${esc(f.broker)}</span></td><td><div class="row-name">${esc(f.name)}</div><div class="row-sub">${fmtRange(f.from, f.to)}</div></td><td>${nuevo}<span class="row-sub">${dup}</span></td></tr>`;
      }).join('');
      let h = `<div class="table-scroll"><table class="import-table"><thead><tr><th>Bróker</th><th>Archivo</th><th>Contenido</th></tr></thead><tbody>${fileRows}</tbody></table></div>`;

      if (p.blocking.length){
        h += `<div class="notice bad"><b>No se puede importar todavía.</b><ul>${p.blocking.map(b=>`<li>${esc(b)}</li>`).join('')}</ul></div>`;
      } else if (p.nothingNew){
        h += `<div class="notice ok">Todo lo que traen estos archivos ya estaba importado: no hay nada que añadir.</div>`;
      }
      if (p.warnings.length){
        h += `<div class="notice warn"><b>Avisos</b><ul>${p.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`;
      }
      if (p.superseded.length){
        h += `<div class="notice warn"><b>${p.superseded.length === 1 ? 'Un movimiento registrado a mano queda' : p.superseded.length + ' movimientos registrados a mano quedan'} sustituido${p.superseded.length === 1 ? '' : 's'} por el extracto</b> (ya están dentro de sus fechas, así que no se duplican):<ul>${p.superseded.map(m=>`<li>${isoLabel(m.date)} — ${esc(m.summary)}</li>`).join('')}</ul></div>`;
      }
      if (!p.blocking.length && !p.nothingNew){
        const cover = [];
        if (p.degiro) cover.push(`DEGIRO del ${isoLabel(p.degiro.from)} al ${isoLabel(p.degiro.to)} (${num(p.degiro.rows,0)} movimientos)`);
        if (p.ibkr) cover.push(`IBKR del ${isoLabel(p.ibkr.from)} al ${isoLabel(p.ibkr.to)} (${p.ibkr.statements} ${p.ibkr.statements === 1 ? 'informe' : 'informes'})`);
        h += `<h4 class="import-h">Cómo quedan las cifras</h4><div class="table-scroll"><table class="import-table"><thead><tr><th></th><th class="num">Ahora</th><th class="num">Tras importar</th><th class="num">Cambio</th></tr></thead><tbody>` +
          p.figures.map(f=>`<tr><td>${esc(f.label)}</td><td class="num">${eur(f.before)}</td><td class="num">${eur(f.after)}</td><td class="num">${delta(f)}</td></tr>`).join('') +
          `<tr><td>Posiciones abiertas en DEGIRO</td><td class="num">${p.positions.before}</td><td class="num">${p.positions.after}</td><td class="num">${p.positions.after === p.positions.before ? '<span class="row-sub">sin cambios</span>' : (p.positions.after > p.positions.before ? '+' : '') + (p.positions.after - p.positions.before)}</td></tr>` +
          `</tbody></table></div><p class="footnote">Quedará cubierto: ${cover.join(' · ')}. Los precios de mercado de DEGIRO no vienen en ningún extracto: se mantienen los que hay guardados (${esc(DATA.live_meta.fetched_date)}); actualízalos después si quieres el valor al día.</p>`;
      }
      previewEl.innerHTML = h;
      saveBtn.disabled = !!(p.blocking.length || p.nothingNew);
    }

    async function preview(){
      if (!files.length || busy) return;
      busy = true; saveBtn.disabled = true;
      statusEl.style.color = ''; statusEl.textContent = 'Leyendo los extractos…';
      previewEl.innerHTML = '';
      try {
        const p = await api('POST', '/api/import/preview', { files });
        render(p);
        statusEl.textContent = '';
      } catch (err){
        statusEl.textContent = err.message; statusEl.style.color = 'var(--critical)';
      }
      busy = false;
    }

    async function take(list){
      const picked = Array.from(list || []);
      if (!picked.length) return;
      const tooBig = picked.find(f=>f.size > 8 * 1024 * 1024);
      if (tooBig){ statusEl.textContent = `${tooBig.name} es demasiado grande para ser un extracto.`; statusEl.style.color = 'var(--critical)'; return; }
      files = await Promise.all(picked.map(async f=>({ name: f.name, content: await f.text() })));
      drop.querySelector('.drop-title').textContent = files.length === 1 ? files[0].name : `${files.length} archivos elegidos`;
      drop.querySelector('.drop-sub').textContent = 'pulsa para elegir otros';
      preview();
    }

    input.addEventListener('change', ()=>take(input.files));
    ['dragenter','dragover'].forEach(t=>drop.addEventListener(t, (ev)=>{ ev.preventDefault(); drop.classList.add('over'); }));
    ['dragleave','drop'].forEach(t=>drop.addEventListener(t, (ev)=>{ ev.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (ev)=>take(ev.dataTransfer && ev.dataTransfer.files));

    saveBtn.addEventListener('click', async ()=>{
      if (busy || !files.length) return;
      busy = true; saveBtn.disabled = true;
      statusEl.style.color = ''; statusEl.textContent = 'Importando…';
      try {
        const r = await api('POST', '/api/import', { files });
        reloadWithToast(r.saved);
      } catch (err){
        statusEl.textContent = err.message; statusEl.style.color = 'var(--critical)';
        busy = false; saveBtn.disabled = false;
      }
    });

    function openModal(){
      files = []; input.value = ''; previewEl.innerHTML = ''; statusEl.textContent = ''; saveBtn.disabled = true;
      drop.querySelector('.drop-title').textContent = 'Elegir archivos CSV…';
      drop.querySelector('.drop-sub').textContent = 'o arrástralos aquí';
      overlay.style.display = 'flex';
    }
    function closeModal(){ overlay.style.display = 'none'; }
    $('open-import-modal').addEventListener('click', openModal);
    $('import-close').addEventListener('click', closeModal);
    $('import-cancel').addEventListener('click', closeModal);
    bindModal(overlay, closeModal);
  })();

  /* ================= EXPORTAR INFORME (HTML, PDF por impresión y texto) ================= */
  (function(){
    const overlay = $('export-modal-overlay');
    const statusEl = $('export-status');
    function reportUrl(format, download){
      return `/api/report?format=${format}&anon=${$('export-anon').checked ? 1 : 0}&trades=${$('export-trades').checked ? 1 : 0}${download ? '&download=1' : ''}`;
    }
    function say(text, bad){ statusEl.textContent = text; statusEl.style.color = bad ? 'var(--critical)' : ''; }
    function download(format){
      const a = document.createElement('a');
      a.href = reportUrl(format, true);
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
      say('Descargado: mira en tu carpeta de descargas.');
    }
    $('export-html').addEventListener('click', ()=>download('html'));
    $('export-md').addEventListener('click', ()=>download('md'));
    $('export-pdf').addEventListener('click', ()=>{
      // Se abre en una pestaña nueva y se lanza el cuadro de imprimir del navegador.
      const w = window.open(reportUrl('html', false), '_blank');
      if (!w){ say('El navegador ha bloqueado la pestaña nueva: permite las ventanas emergentes para esta página.', true); return; }
      w.addEventListener('load', ()=>{ try { w.focus(); w.print(); } catch (e) { /* se imprime a mano con Ctrl+P */ } });
      say('Informe abierto en otra pestaña: en el cuadro de imprimir elige «Guardar como PDF».');
    });
    $('export-copy').addEventListener('click', async ()=>{
      say('Copiando…');
      try {
        const res = await fetch(reportUrl('md', false));
        if (!res.ok) throw new Error(res.status === 404 ? 'La aplicación que está en marcha es de una versión anterior. Cierra su ventana negra y vuelve a abrir iniciar.bat.' : 'No se ha podido generar el informe.');
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        say(`Copiado (${num(text.length, 0)} caracteres): pégalo en el chat de la IA.`);
      } catch (err){
        say(err && err.name === 'NotAllowedError' ? 'El navegador no deja copiar: usa «Descargar».' : (err.message || 'No se ha podido copiar.'), true);
      }
    });
    function openModal(){ say(''); overlay.style.display = 'flex'; }
    function closeModal(){ overlay.style.display = 'none'; }
    $('open-export-modal').addEventListener('click', openModal);
    $('export-close').addEventListener('click', closeModal);
    $('export-cancel').addEventListener('click', closeModal);
    bindModal(overlay, closeModal);
  })();

  /* ================= MENÚ DE NAVEGACIÓN ================= */
  (function(){
    const nav = $('topnav');
    if (!nav) return;
    const links = Array.from(nav.querySelectorAll('.topnav-links a'));
    const navPill = $('topnav-checks');
    const bar = $('topnav-links');
    const jump = $('topnav-jump');
    const jumpLabel = $('topnav-jump-label');
    const jumpMenu = $('topnav-jump-menu');

    // Orden real de las secciones visibles en el documento (incluye Comprobaciones en la pastilla fija).
    const ORDER = [
      ['resumen', 'Resumen'], ['distribucion', 'Distribución'], ['evolucion', 'Evolución'],
      ['accounts', 'Cuentas'], ['contributions', 'Aportaciones'], ['holdings', 'Posiciones'],
      ['dividends', 'Dividendos'], ['realized', 'Realizado'], ['behavior', 'Operativa'],
      ['irpf', 'IRPF'], ['checks', 'Comprobaciones'], ['journal', 'Historial'],
    ];
    const entries = ORDER
      .map(([id, label])=>({ id, label, el: document.getElementById(id) }))
      .filter(s=>s.el && !s.el.hidden);

    if (jumpMenu){
      jumpMenu.innerHTML = entries.map(s=>`<a href="#${s.id}" role="menuitem" data-section="${s.id}">${esc(s.label)}</a>`).join('');
      jumpMenu.querySelectorAll('a').forEach(a=>a.addEventListener('click', ()=>{ if (jump) jump.open = false; }));
    }
    const jumpLinks = jumpMenu ? Array.from(jumpMenu.querySelectorAll('a')) : [];
    const allNavItems = links.concat(navPill ? [navPill] : [], jumpLinks);

    let current = null;
    function setActive(entry){
      if (!entry || entry === current) return;
      current = entry;
      if (jumpLabel) jumpLabel.textContent = entry.label;
      allNavItems.forEach(a=>{
        const on = a.dataset.section === entry.id;
        a.classList.toggle('is-active', on);
        if (on){
          a.setAttribute('aria-current', 'true');
          if (bar && bar.contains(a)){
            const l = a.offsetLeft - bar.offsetLeft, w = a.offsetWidth;
            if (l < bar.scrollLeft || l + w > bar.scrollLeft + bar.clientWidth) bar.scrollTo({ left: Math.max(0, l - 24) });
          }
        } else a.removeAttribute('aria-current');
      });
    }
    function update(){
      if (!entries.length) return;
      const offset = nav.offsetHeight + 48;
      let active = entries[0];
      entries.forEach(s=>{ if (s.el.getBoundingClientRect().top - offset <= 0) active = s; });
      // Al llegar al final de la página, la última sección.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) active = entries[entries.length - 1];
      setActive(active);
    }
    let ticking = false;
    window.addEventListener('scroll', ()=>{ if (!ticking){ ticking = true; requestAnimationFrame(()=>{ ticking = false; update(); }); } }, { passive:true });
    window.addEventListener('resize', update);
    update();
    // Si la página se abre con un enlace a una sección (#dividends…), ir a ella una vez pintado todo.
    if (location.hash){
      const target = document.getElementById(location.hash.slice(1));
      if (target) requestAnimationFrame(()=>{ target.scrollIntoView({ behavior:'instant', block:'start' }); update(); });
    }
    links.forEach(a=>a.addEventListener('click', ()=>{
      const hit = entries.find(s=>s.id === a.dataset.section);
      if (hit) setActive(hit);
    }));

    // Menú de acciones: abre las mismas ventanas que los botones de la cabecera.
    const actions = $('topnav-actions');
    actions.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click', ()=>{
      actions.open = false;
      const target = $(b.dataset.open);
      if (target) target.click();
    }));
    document.addEventListener('click', (ev)=>{
      if (actions.open && !actions.contains(ev.target)) actions.open = false;
      if (jump && jump.open && !jump.contains(ev.target)) jump.open = false;
    });
    document.addEventListener('keydown', (ev)=>{
      if (ev.key === 'Escape'){
        if (actions.open){ actions.open = false; actions.querySelector('summary').focus(); }
        if (jump && jump.open){ jump.open = false; jump.querySelector('summary').focus(); }
      }
    });
  })();

  document.body.classList.remove('is-loading');

})();
