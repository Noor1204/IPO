// Stocks module (end-of-day NSE data). Written against docs/MODULES.md.
// Data: data/stocks/{meta,movers,index,list}.json and data/stocks/d/<first letter>.json (details + close history), made by pipeline/stocks.mjs.
(function () {
  const BASE = "data/stocks/";
  const S = { meta: null, movers: null, index: null, list: null, listBy: null, status: "idle", listStatus: "idle", chunks: {}, chunkStatus: {},
    k: "gain", shown: 20, q: "", range: "3M", allIdx: false };
  let CH = null;                                         // current chart points
  let HH = null;                                         // host api (kept for async renders)
  const DISC = "Prices are end-of-day (or delayed). Information only, not investment advice.";
  const LISTS = [["gain", "Gainers"], ["loss", "Losers"], ["active", "Most active"], ["deliv", "Highest delivery %"], ["hi", "52-week high"], ["lo", "52-week low"]];
  const NOTE = {
    gain: "Biggest one-day rise among stocks that traded at least ₹2 crore.",
    loss: "Biggest one-day fall among stocks that traded at least ₹2 crore.",
    active: "Highest traded value (price × quantity) of the day.",
    deliv: "Share of traded quantity that was taken for delivery (not squared off the same day), stocks with ₹2 crore+ traded.",
    hi: "Stocks closing within 3% of their 52-week high (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
    lo: "Stocks closing within 3% of their 52-week low (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
  };
  const FEATURED = ["nifty 50", "nifty bank", "nifty it", "nifty next 50", "nifty midcap 100", "nifty smallcap 100", "nifty financial services", "india vix"];
  const isNum = x => typeof x === "number" && isFinite(x);
  const nf = (x, d) => isNum(x) ? x.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
  const px = x => nf(x, 2);
  const rs = x => isNum(x) ? "₹" + px(x) : "—";
  const crore = lacs => isNum(lacs) ? "₹" + nf(lacs / 100, lacs >= 1e4 ? 0 : 2) + " Cr" : "—";
  const cls = x => isNum(x) ? (x > 0 ? "grn-t" : x < 0 ? "red-t" : "") : "";
  const arrow = x => isNum(x) ? (x > 0 ? "▲" : x < 0 ? "▼" : "") : "";
  const pct = x => isNum(x) ? (x > 0 ? "+" : "") + nf(x, 2) + "%" : "—";
  const chgTxt = (d, p) => isNum(d) || isNum(p) ? `<span class="${cls(isNum(p) ? p : d)}">${arrow(isNum(p) ? p : d)} ${isNum(d) ? (d > 0 ? "+" : "") + px(d) : "—"} (${pct(p)})</span>` : "—";
  const symOk = s => typeof s === "string" && /^[A-Z0-9&_.$-]{1,20}$/.test(s);
  const chunkKey = s => /^[A-Z]/.test(s) ? s[0] : "0";

  // ---------- data loading ----------
  async function getJson(file, v) {
    const r = await fetch(BASE + file + (v ? "?v=" + encodeURIComponent(v) : ""), { cache: v ? "default" : "no-cache" });
    if (!r.ok) throw new Error(file + " " + r.status);
    return r.json();
  }
  async function loadCore(H) {
    S.status = "loading";
    try {
      const meta = await getJson("meta.json");
      if (!meta || typeof meta.tradeDate !== "string") throw new Error("bad meta");
      const v = meta.generatedAt;
      const [movers, index] = await Promise.all([getJson("movers.json", v), getJson("index.json", v).catch(() => null)]);
      if (!movers || !movers.gain) throw new Error("bad movers");
      Object.assign(S, { meta, movers, index, status: "ok" });
    } catch (e) { console.warn("stocks data", e); S.status = "fail"; }
    H.render();
  }
  async function ensureList(H) {
    if (S.list || S.listStatus === "loading" || !S.meta) return;
    S.listStatus = "loading";
    try {
      const j = await getJson("list.json", S.meta.generatedAt);
      if (!Array.isArray(j.rows)) throw new Error("bad list");
      S.list = j; S.listBy = new Map(j.rows.map(r => [r[0], r])); S.listStatus = "ok";
      S.lc = j.rows.map(r => r[1].toLowerCase());
    } catch (e) { console.warn("stocks list", e); S.listStatus = "fail"; }
    H.render();
  }
  async function ensureChunk(sym, H) {
    const k = chunkKey(sym);
    if (S.chunks[k] || S.chunkStatus[k] === "loading" || !S.meta) return;
    S.chunkStatus[k] = "loading";
    try { const j = await getJson("d/" + k + ".json", S.meta.generatedAt); if (!j || !j.s || !Array.isArray(j.d)) throw new Error("bad chunk"); S.chunks[k] = j; S.chunkStatus[k] = "ok"; }
    catch (e) { console.warn("stocks chunk", e); S.chunkStatus[k] = "fail"; }
    H.render();
  }

  // ---------- small pieces ----------
  const stale = () => {
    if (!S.meta || !HH) return "";
    const days = (Date.parse(HH.istDay() + "T00:00:00Z") - Date.parse(S.meta.tradeDate + "T00:00:00Z")) / 864e5;
    return days > 4 ? `<div class="note st-note">The latest data available is from ${HH.esc(HH.fmtD(S.meta.tradeDate))}. The market may have been closed, or the daily update is delayed.</div>` : "";
  };
  const foot = H => `<p class="mut sm st-foot">${H.esc(DISC)}${S.meta ? " Trade date: " + H.esc(H.fmtD(S.meta.tradeDate)) + ". Source: NSE India end-of-day files." : ""}</p>`;
  const state = (H, what) => S.status === "loading" || S.status === "idle"
    ? H.head("Stocks") + H.card("", '<p class="mut">Loading market data…</p>')
    : H.head("Stocks") + H.card("", `<p><b>Stocks data is not available right now.</b></p><p class="mut">Check your internet connection and try again. ${what || ""}</p><button class="btn" data-m="stocks" data-act="retry">Try again</button>`) + `<p class="mut sm st-foot">${H.esc(DISC)}</p>`;
  const rowBtn = (H, sym, name, price, chg, extra, ser) =>
    `<button class="st-row" data-m="stocks" data-act="open" data-sym="${H.esc(sym)}"><span class="st-nm"><b>${H.esc(sym)}</b>${ser && ser !== "EQ" ? ` <i class="st-tag">${H.esc(ser)}</i>` : ""}<small>${H.esc(name || "")}</small></span><span class="st-px">${px(price)}</span><span class="st-ch ${cls(chg)}">${arrow(chg)} ${pct(chg)}</span>${extra === undefined ? "" : `<span class="st-ex">${extra}</span>`}</button>`;
  const mv = (H, rows, n, extra) => rows.slice(0, n).map(r => rowBtn(H, r[0], r[1], r[2], r[3], extra ? extra(r) : undefined)).join("");
  const star = (sym, on) => `<button class="st-star${on ? " on" : ""}" data-m="stocks" data-act="star" data-sym="${sym}" aria-pressed="${on}" aria-label="${on ? "Remove from watchlist" : "Add to watchlist"}">${on ? "★" : "☆"}</button>`;
  const watched = H => { const w = H.store.get("st_watch", []); return Array.isArray(w) ? w.filter(symOk) : []; };

  // ---------- Market ----------
  function market(H) {
    const m = S.movers, ix = S.index;
    let idx = "";
    if (ix && Array.isArray(ix.rows) && ix.rows.length) {
      const by = new Map(ix.rows.map(r => [String(r[0]).toLowerCase(), r]));
      const cards = FEATURED.map(k => by.get(k)).filter(Boolean).map(r =>
        `<div class="st-ix"><span class="mut">${H.esc(r[0])}</span><b>${px(r[1])}</b><span class="${/vix/i.test(r[0]) ? "" : cls(r[3])}">${arrow(r[3])} ${isNum(r[2]) ? (r[2] > 0 ? "+" : "") + px(r[2]) : "—"} (${pct(r[3])})</span></div>`).join("");
      const all = S.allIdx ? H.tbl(["Index", "Close", "Change %"], ix.rows.map(r => [H.esc(r[0]), px(r[1]), `<span class="${cls(r[3])}">${pct(r[3])}</span>`])) : "";
      idx = H.card("Indices", `<div class="st-ixg">${cards || '<p class="mut">—</p>'}</div>
        <button class="linkbtn" data-m="stocks" data-act="allidx">${S.allIdx ? "Hide all indices" : "Show all " + ix.rows.length + " indices"}</button>${all}
        <p class="mut sm st-foot">Closing levels as on ${H.esc(H.fmtD(ix.date))}. Source: NSE India. BSE Sensex is not included.</p>`);
    } else idx = H.card("Indices", '<p class="mut">Index data is not available right now.</p>');
    const tab = (title, rows, key, extra) => H.card(title, rows.length ? `<div class="st-list">${mv(H, rows, 8, extra)}</div><button class="linkbtn" data-m="stocks" data-act="seeall" data-k="${key}">See all →</button>` : '<p class="mut">—</p>');
    const dist = (word) => r => isNum(r[6]) ? nf(r[6], 1) + "% " + word : "—";
    return H.head("Stocks") + stale() +
      `<div class="st-grid">${idx}
      ${tab("Top gainers", m.gain, "gain")}
      ${tab("Top losers", m.loss, "loss")}
      ${tab("Most active (by value)", m.active, "active", r => crore(r[4] * 100))}
      ${tab("Near 52-week high", m.hi, "hi", dist("below high"))}
      ${tab("Near 52-week low", m.lo, "lo", dist("above low"))}</div>` + foot(H);
  }

  // ---------- Movers ----------
  function movers(H) {
    const m = S.movers, k = LISTS.some(l => l[0] === S.k) ? S.k : "gain", rows = Array.isArray(m[k]) ? m[k] : [];
    const extra = k === "deliv" ? r => (isNum(r[5]) ? nf(r[5], 1) + "% delivery" : "—")
      : k === "hi" ? r => (isNum(r[6]) ? nf(r[6], 1) + "% below high" : "—")
      : k === "lo" ? r => (isNum(r[6]) ? nf(r[6], 1) + "% above low" : "—")
      : r => crore(r[4] * 100);
    const sw = LISTS.map(([id, l]) => `<button class="${id === k ? "on" : ""}" data-m="stocks" data-act="list" data-k="${id}">${l}</button>`).join("");
    const body = rows.length ? `<div class="st-list">${mv(H, rows, S.shown, extra)}</div>${rows.length > S.shown ? `<button class="btn ghost st-more" data-m="stocks" data-act="more">Show more (${rows.length - S.shown} more)</button>` : ""}` : '<p class="mut">No stocks in this list for the latest trade date.</p>';
    return H.head("Stocks") + stale() + `<div class="st-sw" role="group" aria-label="List">${sw}</div>` + H.card(H.esc(LISTS.find(l => l[0] === k)[1]), `<p class="mut sm">${H.esc(NOTE[k])}</p>${body}`) + foot(H);
  }

  // ---------- Search ----------
  function match(q) {
    const t = q.trim().toLowerCase(); if (!t || !S.list) return [];
    const out = [];
    S.list.rows.forEach((r, i) => {
      const s = r[0].toLowerCase(), n = S.lc[i];
      const rank = s === t ? 0 : s.startsWith(t) ? 1 : n.startsWith(t) ? 2 : s.includes(t) ? 3 : (" " + n).includes(" " + t) ? 4 : n.includes(t) ? 5 : -1;
      if (rank >= 0) out.push([rank, r]);
    });
    return out.sort((a, b) => a[0] - b[0] || (b[1][6] || 0) - (a[1][6] || 0));
  }
  function search(H) {
    ensureList(H);
    let body;
    if (S.listStatus === "fail") body = '<p class="mut">The stock list could not be loaded. Check your connection and try again.</p><button class="btn" data-m="stocks" data-act="retrylist">Try again</button>';
    else if (!S.list) body = '<p class="mut">Loading the stock list…</p>';
    else if (!S.q.trim()) body = `<p class="mut">Type a stock symbol or company name (for example RELIANCE, Tata, bank). ${S.list.rows.length} NSE stocks are listed.</p>`;
    else {
      const all = match(S.q), res = all.slice(0, 50);
      body = res.length ? `<p class="mut sm">${all.length} match${all.length === 1 ? "" : "es"}${all.length > 50 ? ", showing the first 50. Type more letters to narrow down." : ""}</p><div class="st-list">${res.map(([, r]) => rowBtn(H, r[0], r[1], r[3], r[4], undefined, r[2])).join("")}</div>` : '<p class="mut">No stock matches that search.</p>';
    }
    return H.head("Stocks") + stale() + H.card("", `<input id="st-q" type="search" data-m="stocks" placeholder="Search symbol or company" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search stocks" value="${H.esc(S.q)}" maxlength="40">${body}`) + foot(H);
  }

  // ---------- Watchlist ----------
  function watch(H) {
    ensureList(H);
    const w = watched(H);
    let body;
    if (!w.length) body = `<p><b>Your watchlist is empty.</b></p><p class="mut">Open any stock and tap the ☆ star to follow it here. The list is saved on this device only.</p><button class="btn" data-m="stocks" data-act="gosearch">Search stocks</button>`;
    else if (S.listStatus === "fail") body = '<p class="mut">Prices could not be loaded.</p>';
    else if (!S.list) body = '<p class="mut">Loading prices…</p>';
    else body = `<div class="st-list">${w.map(sym => {
      const r = S.listBy.get(sym);
      return `<div class="st-wrow">${r ? rowBtn(H, r[0], r[1], r[3], r[4], undefined, r[2]) : rowBtn(H, sym, "Not in the latest data", null, null)}<button class="st-x" data-m="stocks" data-act="unstar" data-sym="${H.esc(sym)}" aria-label="Remove ${H.esc(sym)} from watchlist">✕</button></div>`;
    }).join("")}</div>`;
    return H.head("Stocks") + stale() + H.card("Watchlist" + (w.length ? " (" + w.length + ")" : ""), body) + foot(H);
  }

  // ---------- Stock page ----------
  const RANGES = [["1M", 21], ["3M", 63], ["6M", 126], ["1Y", 252]];
  function chart(H, dates, hist) {
    const all = []; hist.forEach((v, i) => { if (isNum(v) && v > 0) all.push({ d: dates[i], v }); });
    if (all.length < 5) { CH = null; return '<p class="mut">A price chart is not available for this stock (history is kept for the most traded stocks only).</p>'; }
    const avail = RANGES.filter(r => r[1] <= all.length * 1.1);
    const btns = avail.map(r => [r[0], r[1]]);
    if (!avail.length || all.length > avail[avail.length - 1][1] * 1.1) btns.push(["All", all.length]);
    const sel = btns.find(b => b[0] === S.range) || btns[Math.min(1, btns.length - 1)];
    const p = CH = all.slice(-sel[1]).filter(x => x), n = p.length;
    const W = 320, Ht = 160, L = 46, R = 10, T = 12, B = 24, v = p.map(x => x.v), mn = Math.min(...v), mx = Math.max(...v), pad = (mx - mn || mx * .02 || 1) * .12, lo = mn - pad, hi = mx + pad;
    const X = k => L + k * (W - L - R) / (n - 1), Y = g => T + (hi - g) / (hi - lo) * (Ht - T - B);
    const up = v[n - 1] >= v[0], c = up ? "var(--ok)" : "var(--bad)";
    const pts = p.map((x, k) => X(k).toFixed(1) + "," + Y(x.v).toFixed(1)).join(" ");
    const ticks = [mx, (mx + mn) / 2, mn].map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}" stroke="var(--bd)" stroke-dasharray="3 4"/><text x="${L - 5}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end" class="st-ax">${nf(t, t >= 1000 ? 0 : 1)}</text>`).join("");
    const dl = k => H.fmtD(p[k].d).replace(/ \d{4}$/, "");
    const xl = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].map(k => `<text x="${X(k).toFixed(1)}" y="${Ht - 7}" text-anchor="${k === 0 ? "start" : k === n - 1 ? "end" : "middle"}" class="st-ax">${H.esc(dl(k))}</text>`).join("");
    const rd = k => `<b>${H.esc(H.fmtD(p[k].d))}</b> · Close <b>${rs(p[k].v)}</b>${k > 0 ? ` · <span class="${cls(p[k].v - p[0].v)}">${pct((p[k].v / p[0].v - 1) * 100)}</span> since ${H.esc(dl(0))}` : ""}`;
    return `<div class="st-rg" role="group" aria-label="Chart range">${btns.map(b => `<button class="${b[0] === sel[0] ? "on" : ""}" data-m="stocks" data-act="range" data-r="${b[0]}">${b[0]}</button>`).join("")}</div>
    <div class="st-chart" data-n="${n}" data-l="${L}" data-r="${R}" data-w="${W}"><svg viewBox="0 0 ${W} ${Ht}" width="100%" role="img" aria-label="Closing price, last ${n} trading days">${ticks}<polyline fill="none" stroke="${c}" stroke-width="2.2" stroke-linejoin="round" points="${pts}"/><line class="st-cur" x1="${X(n - 1).toFixed(1)}" x2="${X(n - 1).toFixed(1)}" y1="${T}" y2="${Ht - B}"/><circle class="st-dot" cx="${X(n - 1).toFixed(1)}" cy="${Y(v[n - 1]).toFixed(1)}" r="4.5" fill="${c}"/>${xl}</svg>
    <div class="st-read" aria-live="polite">${rd(n - 1)}</div><div class="mut sm">${n} trading days · closing prices, adjusted for splits and bonus issues · move your cursor or finger over the line</div></div>`;
  }
  function pick(e) {
    const box = e.target.closest && e.target.closest(".st-chart"); if (!box || !CH) return;
    const svg = box.querySelector("svg"), r = svg.getBoundingClientRect(), n = +box.dataset.n, W = +box.dataset.w, L = +box.dataset.l, Rr = +box.dataset.r;
    if (!r.width || n < 2 || n !== CH.length) return;
    const x = (e.clientX - r.left) / r.width * W, k = Math.max(0, Math.min(n - 1, Math.round((x - L) / (W - L - Rr) * (n - 1)))), p = CH[k];
    const esc = HH ? HH.esc : s => s, fd = HH ? HH.fmtD : s => s, d0 = fd(CH[0].d).replace(/ \d{4}$/, "");
    box.querySelector(".st-read").innerHTML = `<b>${esc(fd(p.d))}</b> · Close <b>${rs(p.v)}</b>${k > 0 ? ` · <span class="${cls(p.v - CH[0].v)}">${pct((p.v / CH[0].v - 1) * 100)}</span> since ${esc(d0)}` : ""}`;
    const cx = L + k * (W - L - Rr) / (n - 1), cur = box.querySelector(".st-cur"), dot = box.querySelector(".st-dot");
    cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); dot.setAttribute("cx", cx);
    const T = 12, B = 24, Ht = 160, v = CH.map(q => q.v), mn = Math.min(...v), mx = Math.max(...v), pad = (mx - mn || mx * .02 || 1) * .12, lo = mn - pad, hi = mx + pad;
    dot.setAttribute("cy", T + (hi - p.v) / (hi - lo) * (Ht - T - B));
  }
  ["pointermove", "pointerdown", "click"].forEach(t => document.addEventListener(t, pick));

  function stockPage(sym, H) {
    if (!symOk(sym)) return H.head("Stock") + H.card("", '<p class="mut">This stock could not be found.</p>');
    ensureChunk(sym, H);
    const k = chunkKey(sym), ck = S.chunks[k];
    if (!ck) return H.head(H.esc(sym)) + H.card("", S.chunkStatus[k] === "fail" ? `<p class="mut">The data for this stock could not be loaded. Check your connection and try again.</p><button class="btn" data-m="stocks" data-act="retrychunk" data-sym="${H.esc(sym)}">Try again</button>` : '<p class="mut">Loading…</p>') + foot(H);
    const d = ck.s[sym];
    if (!d) return H.head(H.esc(sym)) + H.card("", '<p class="mut">This symbol is not in the latest NSE data (it may be suspended, delisted or renamed).</p>') + foot(H);
    const [name, isin, ser, open, high, low, prev, close, vol, valL, trades, dq, dp, w52h, w52hd, w52l, w52ld, listed, fv, hist] = d;
    const chg = isNum(close) && isNum(prev) ? close - prev : null, chgP = chg !== null && prev > 0 ? chg / prev * 100 : null;
    const on = watched(H).includes(sym);
    const stat = (l, v) => `<div class="st-stat"><span>${l}</span><b>${v}</b></div>`;
    let rng = '<p class="mut">52-week range is not available for this stock.</p>';
    if (isNum(w52h) && isNum(w52l) && w52h > w52l && isNum(close)) {
      const pos = Math.max(0, Math.min(100, (close - w52l) / (w52h - w52l) * 100));
      rng = `<div class="st-52"><div class="row"><span>${rs(w52l)}<small class="mut"> ${H.esc(H.fmtD(w52ld))}</small></span><span class="st-r52">${rs(w52h)}<small class="mut"> ${H.esc(H.fmtD(w52hd))}</small></span></div>
        <div class="st-bar" role="img" aria-label="Price is ${Math.round(pos)} percent of the way from the 52-week low to the high"><i style="left:${pos.toFixed(1)}%"></i></div>
        <div class="row mut sm"><span>52-week low</span><span>${nf(pos, 0)}% of the range</span><span>52-week high</span></div></div>`;
    } else if (isNum(w52h) || isNum(w52l)) rng = `<div class="st-stats">${stat("52-week high", rs(w52h))}${stat("52-week low", rs(w52l))}</div>`;
    const url = H.safeUrl("https://www.nseindia.com/get-quotes/equity?symbol=" + encodeURIComponent(sym));
    return H.head(H.esc(sym)) + stale() +
      `<div class="st-page"><div class="card"><div class="row st-top"><div class="st-name"><h2>${H.esc(name || sym)}</h2><span class="mut">${H.esc(sym)} · NSE ${H.esc(ser || "—")}${isin ? " · " + H.esc(isin) : ""}</span></div>${star(H.esc(sym), on)}</div>
        <div class="st-big"><b>${rs(close)}</b><span>${chgTxt(chg, chgP)}</span></div>
        <p class="mut sm">Closing price on ${H.esc(H.fmtD(ck.tradeDate))}. Change is against the previous close of ${rs(prev)}.</p>
        <div class="st-stats">${stat("Open", rs(open))}${stat("High", rs(high))}${stat("Low", rs(low))}${stat("Previous close", rs(prev))}${stat("Volume", isNum(vol) ? nf(vol, 0) : "—")}${stat("Traded value", crore(valL))}${stat("Delivery %", isNum(dp) ? nf(dp, 2) + "%" : "—")}${stat("Trades", isNum(trades) ? nf(trades, 0) : "—")}${stat("Face value", isNum(fv) ? rs(fv) : "—")}${stat("Listed on", listed ? H.esc(H.fmtD(listed)) : "—")}</div></div>
      ${H.card("52-week range", rng + '<p class="mut sm">Adjusted for splits and bonus issues.</p>')}
      ${H.card("Price chart", Array.isArray(hist) ? chart(H, ck.d, hist) : (CH = null, '<p class="mut">A price chart is not available for this stock (history is kept for the most traded stocks only).</p>'))}
      ${H.card("Official page", `<p class="mut sm">Live quote, announcements and financials on the NSE website.</p>${url ? `<a class="btn ghost st-link" href="${H.esc(url)}" target="_blank" rel="noopener noreferrer">Open on NSE India ↗</a>` : ""}`)}</div>` + foot(H);
  }

  // ---------- module ----------
  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.stocks = {
    id: "stocks", label: "Stocks", icon: "📈",
    tabs: [["market", "Market"], ["movers", "Movers"], ["watch", "Watchlist"], ["search", "Search"]],
    load(H) { HH = H; loadCore(H); },
    render(tab, sub, H) {
      HH = H;
      try {
        if (typeof sub === "string" && sub.startsWith("stock:")) { if (S.status !== "ok") return state(H, ""); return stockPage(sub.slice(6), H); }
        if (S.status !== "ok") return state(H, "");
        if (tab === "movers") return movers(H);
        if (tab === "watch") return watch(H);
        if (tab === "search") return search(H);
        return market(H);
      } catch (e) { console.error(e); return H.head("Stocks") + H.card("", '<p class="mut">This screen could not be shown. Please try again.</p>'); }
    },
    click(el, H) {
      HH = H;
      const a = el.dataset.act, sym = el.dataset.sym;
      if (a === "open" && symOk(sym)) { H.setSub("stock:" + sym); return true; }
      if (a === "star" && symOk(sym)) {
        const w = watched(H), i = w.indexOf(sym);
        if (i >= 0) { w.splice(i, 1); H.store.set("st_watch", w); H.toast("Removed from watchlist"); }
        else if (w.length >= 100) H.toast("Watchlist is full (100 stocks)");
        else { w.push(sym); H.store.set("st_watch", w); H.toast("Added to watchlist"); }
        return true;
      }
      if (a === "unstar" && symOk(sym)) { H.store.set("st_watch", watched(H).filter(s => s !== sym)); H.render(); return true; }
      if (a === "list") { S.k = el.dataset.k; S.shown = 20; H.render(); return true; }
      if (a === "more") { S.shown = 50; H.render(); return true; }
      if (a === "seeall") { S.k = el.dataset.k; S.shown = 20; H.go("stocks", "movers"); return true; }
      if (a === "allidx") { S.allIdx = !S.allIdx; H.render(); return true; }
      if (a === "range") { S.range = el.dataset.r; H.render(); return true; }
      if (a === "gosearch") { H.go("stocks", "search"); return true; }
      if (a === "retry") { loadCore(H); return true; }
      if (a === "retrylist") { S.listStatus = "idle"; ensureList(H); return true; }
      if (a === "retrychunk" && symOk(sym)) { S.chunkStatus[chunkKey(sym)] = "idle"; ensureChunk(sym, H); return true; }
      return false;
    },
    input(el, H) { if (el.id === "st-q") { S.q = el.value.slice(0, 40); H.render(); } },
  };
})();
