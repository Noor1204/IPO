// Stocks module (end-of-day NSE data). Written against docs/MODULES.md, docs/DESIGN.md and docs/CHARTS.md.
// Data (made by pipeline/stocks.mjs, see its header and data/stocks/h/README.txt):
//   meta.json, movers.json, index.json, list.json, d/<letter>.json (details + close history + stats),
//   h/<SYMBOL>.json (OHLCV of the 800 most traded stocks), idx/<slug>.json + idx/index.json (index OHLC history).
// Pages: tabs market / movers / watch / search; H.setSub keys "stock:<SYM>" and "idx:<slug>". Persistence keys: st_watch, st_recent.
(function () {
  const BASE = "data/stocks/";
  const S = { meta: null, movers: null, index: null, idxList: null, idxBy: null, list: null, listBy: null, lc: null, status: "idle", listStatus: "idle",
    chunks: {}, chunkStatus: {}, hist: {}, idxH: {}, cfg: {}, view: "chart", ct: { range: "6M", type: "candles", sma20: false, sma50: false },
    k: "gain", shown: 20, q: "", allIdx: false, idxSt: "idle" };
  let HH = null;                                         // host api (kept for async renders)
  const DISC = "Prices are end-of-day or a delayed snapshot, not real-time. Information only, not investment advice.";
  const LISTS = [["gain", "Gainers"], ["loss", "Losers"], ["active", "Most active"], ["deliv", "Delivery %"], ["hi", "52W high"], ["lo", "52W low"]];
  const NOTE = {
    gain: "Biggest one-day rise among stocks that traded at least ₹2 crore.",
    loss: "Biggest one-day fall among stocks that traded at least ₹2 crore.",
    active: "Highest traded value (price × quantity) of the day.",
    deliv: "Share of traded quantity taken for delivery (not squared off the same day), stocks with ₹2 crore+ traded.",
    hi: "Stocks closing within 3% of their 52-week high (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
    lo: "Stocks closing within 3% of their 52-week low (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
  };
  const NOTE_LIVE = {
    gain: "Biggest rise against the previous close so far, among NIFTY 500 and F&O stocks that traded at least ₹2 crore.",
    loss: "Biggest fall against the previous close so far, among NIFTY 500 and F&O stocks that traded at least ₹2 crore.",
    active: "Highest traded value (price × quantity) so far, among NIFTY 500 and F&O stocks.",
    hi: "Stocks trading within 3% of their 52-week high as published by NSE, closest first, ₹2 crore+ traded.",
    lo: "Stocks trading within 3% of their 52-week low as published by NSE, closest first, ₹2 crore+ traded.",
  };
  const FEATURED = ["nifty-50", "nifty-bank", "india-vix", "nifty-it", "nifty-next-50", "nifty-midcap-100", "nifty-smallcap-100", "nifty-financial-services"];
  const TV_IDX = { "nifty-50": "NIFTY 50", "nifty-bank": "NIFTY BANK" };        // indices with a known TradingView symbol
  const isNum = x => typeof x === "number" && isFinite(x);
  const nf = (x, d) => isNum(x) ? x.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—";
  const px = x => nf(x, 2);
  const rs = x => isNum(x) ? "₹" + px(x) : "—";
  const crore = lacs => isNum(lacs) ? "₹" + nf(lacs / 100, lacs >= 1e4 ? 0 : 2) + " Cr" : "—";
  const croreC = cr => isNum(cr) ? "₹" + nf(cr, cr >= 100 ? 0 : 2) + " Cr" : "—";
  const dir = x => isNum(x) ? (x > 0 ? "up" : x < 0 ? "dn" : "flat") : "flat";
  const cls = x => isNum(x) ? (x > 0 ? "grn-t" : x < 0 ? "red-t" : "") : "";
  const arrow = x => isNum(x) ? (x > 0 ? "▲" : x < 0 ? "▼" : "") : "";
  const pct = x => isNum(x) ? (x > 0 ? "+" : "") + nf(x, 2) + "%" : "—";
  const sgn = (x, d) => isNum(x) ? (x > 0 ? "+" : "") + nf(x, d === undefined ? 2 : d) : "—";
  const units = v => !isNum(v) ? "—" : v >= 1e7 ? nf(v / 1e7, 2) + " Cr" : v >= 1e5 ? nf(v / 1e5, 2) + " L" : v >= 1e3 ? nf(v / 1e3, 1) + " K" : nf(v, 0);
  const symOk = s => typeof s === "string" && /^[A-Z0-9&_.$-]{1,20}$/.test(s);
  const slugOk = s => typeof s === "string" && /^[a-z0-9-]{1,90}$/.test(s);
  const chunkKey = s => /^[A-Z]/.test(s) ? s[0] : "0";
  const hue = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
  const ini = s => String(s).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  const ic = (n, c) => HH && HH.ic ? HH.ic(n, c) : "";

  // ---------- decoder: compact h/idx file -> [[YYYY-MM-DD, o, h, l, c, v], ...] ----------
  function decodeHist(j) {
    try {
      const n = j && j.c && j.c.length, p = j && j.p;
      if (!n || !(p > 0) || !j.g || j.g.length !== n || !j.od || j.od.length !== n || !j.hd || j.hd.length !== n || !j.ld || j.ld.length !== n || (j.v && j.v.length !== n)) return null;
      const d = String(j.t); let ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
      const rows = [];
      for (let i = 0; i < n; i++) {
        ms += j.g[i] * 864e5;
        const C = j.c[i];
        rows.push([new Date(ms).toISOString().slice(0, 10), (C + j.od[i]) / p, (C + j.hd[i]) / p, (C - j.ld[i]) / p, C / p, j.v && isNum(j.v[i]) ? j.v[i] : null]);
      }
      return rows;
    } catch (e) { return null; }
  }
  const dIso = n => { const s = String(n); return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8); };

  // ---------- data loading ----------
  async function getJson(file, v) {
    const r = await fetch(BASE + file + (v ? "?v=" + encodeURIComponent(v) : ""), { cache: v ? "default" : "no-cache" });
    if (!r.ok) { const e = new Error(file + " " + r.status); e.status = r.status; throw e; }
    return r.json();
  }
  const gen = () => S.meta && S.meta.generatedAt;
  async function loadCore(H) {
    S.status = "loading";
    try {
      const meta = await getJson("meta.json");
      if (!meta || typeof meta.tradeDate !== "string") throw new Error("bad meta");
      const v = meta.generatedAt;
      const [movers, index, il] = await Promise.all([getJson("movers.json", v), getJson("index.json", v).catch(() => null), getJson("idx/index.json", v).catch(() => null)]);
      if (!movers || !movers.gain) throw new Error("bad movers");
      Object.assign(S, { meta, movers, index, status: "ok" });
      if (il && Array.isArray(il.rows)) { S.idxList = il; S.idxBy = new Map(il.rows.map(r => [r[0], r])); }
    } catch (e) { console.warn("stocks data", e); S.status = "fail"; }
    H.render();
  }
  async function ensureList(H) {
    if (S.list || S.listStatus === "loading" || !S.meta) return;
    S.listStatus = "loading";
    try {
      const j = await getJson("list.json", gen());
      if (!Array.isArray(j.rows)) throw new Error("bad list");
      S.list = j; S.listBy = new Map(j.rows.map(r => [r[0], r])); S.listStatus = "ok";
      S.lc = j.rows.map(r => r[1].toLowerCase());
    } catch (e) { console.warn("stocks list", e); S.listStatus = "fail"; }
    H.render();
  }
  async function ensureChunk(sym, H) {
    const k = chunkKey(sym);
    if (S.chunks[k] || S.chunkStatus[k] === "loading" || S.chunkStatus[k] === "fail" || !S.meta) return;
    S.chunkStatus[k] = "loading";
    try { const j = await getJson("d/" + k + ".json", gen()); if (!j || !j.s || !Array.isArray(j.d)) throw new Error("bad chunk"); S.chunks[k] = j; S.chunkStatus[k] = "ok"; }
    catch (e) { console.warn("stocks chunk", e); S.chunkStatus[k] = "fail"; }
    H.render();
  }
  async function ensureHist(sym, H, quiet) {
    const cur = S.hist[sym]; if (cur || !S.meta) return;
    S.hist[sym] = { st: "loading" };
    try {
      const j = await getJson("h/" + encodeURIComponent(sym) + ".json", gen());
      const rows = decodeHist(j); if (!rows) throw new Error("bad history");
      S.hist[sym] = { st: "ok", rows, adj: Array.isArray(j.adj) ? j.adj.filter(a => Array.isArray(a) && a.length === 2).map(a => [dIso(a[0]), a[1]]) : [] };
    } catch (e) { S.hist[sym] = e && e.status === 404 ? { st: "none" } : (console.warn("stocks hist", sym, e), { st: "fail" }); }
    if (!quiet) H.render();
  }
  async function ensureIdxH(slug, H, quiet) {
    if (S.idxH[slug] || !S.meta) return;
    S.idxH[slug] = { st: "loading" };
    try {
      const j = await getJson("idx/" + encodeURIComponent(slug) + ".json", gen());
      const rows = decodeHist(j); if (!rows) throw new Error("bad index history");
      S.idxH[slug] = { st: "ok", rows, nm: j.nm || slug, hasVol: !!j.v && rows.some(r => r[5] > 0) };
    } catch (e) { S.idxH[slug] = e && e.status === 404 ? { st: "none" } : (console.warn("stocks idx", slug, e), { st: "fail" }); }
    if (!quiet) H.render();
  }

  // ---------- small pieces ----------
  const stale = () => {
    if (!S.meta || !HH) return "";
    const days = (Date.parse(HH.istDay() + "T00:00:00Z") - Date.parse(S.meta.tradeDate + "T00:00:00Z")) / 864e5;
    return days > 4 ? `<div class="note st-note">${ic("clock")}<span>The latest data available is from ${HH.esc(HH.fmtD(S.meta.tradeDate))}. The market may have been closed, or the daily update is delayed.</span></div>` : "";
  };
  const foot = (H, extra) => `<p class="mut sm st-foot">${H.esc(DISC)}${S.meta ? " Trade date: " + H.esc(H.fmtD(S.meta.tradeDate)) + ". Source: NSE India end-of-day files; live values come from NSE's public website data (delayed snapshot)." : ""}${extra || ""}</p>`;
  const skelRows = n => Array.from({ length: n }, () => '<div class="skel-row st-skr"></div>').join("");
  const skelCard = (h) => `<div class="card st-skc"><div class="skel-line w50"></div><div class="skel-line w80"></div><div class="skel-block" style="height:${h || 96}px"></div></div>`;
  const state = H => S.status === "loading" || S.status === "idle"
    ? H.head("Stocks") + `<div class="st-grid">${skelCard(110)}${skelCard(110)}</div>`
    : H.head("Stocks") + `<div class="card st-err"><p><b>Stocks data is not available right now.</b></p><p class="mut">Check your internet connection and try again.</p><button class="btn" data-m="stocks" data-act="retry">${ic("refresh")} Try again</button></div>` + `<p class="mut sm st-foot">${H.esc(DISC)}</p>`;
  const watched = H => { const w = H.store.get("st_watch", []); return Array.isArray(w) ? w.filter(symOk) : []; };
  const recents = H => { const w = H.store.get("st_recent", []); return Array.isArray(w) ? w.filter(symOk).slice(0, 8) : []; };
  const star = (H, sym, on) => `<button class="st-star${on ? " on" : ""}" data-m="stocks" data-act="star" data-sym="${H.esc(sym)}" aria-pressed="${on}" aria-label="${on ? "Remove " + H.esc(sym) + " from watchlist" : "Add " + H.esc(sym) + " to watchlist"}">${ic("star")}</button>`;
  const pill = (chg, withArrow) => `<span class="st-pill ${dir(chg)}">${withArrow === false ? "" : arrow(chg) + " "}${pct(chg)}</span>`;
  const avatar = (sym, big) => `<span class="st-av${big ? " lg" : ""}" style="--h:${hue(sym)}" aria-hidden="true">${ini(sym)}</span>`;
  const retryBox = (msg, act, attrs) => `<div class="st-msg"><p><b>${msg}</b></p><p class="mut sm">Check your connection and try again.</p><button class="btn sm" data-m="stocks" data-act="${act}"${attrs || ""}>${ic("refresh")} Retry</button></div>`;

  // sparkline from an array of numbers (already trimmed); no fetching here
  function spark(a, w, h, flat) {
    a = (a || []).filter(isNum); if (a.length < 3) return "";
    w = w || 84; h = h || 30;
    const mn = Math.min(...a), mx = Math.max(...a), rg = mx - mn || 1, n = a.length;
    const pts = a.map((v, i) => (i * (w - 2) / (n - 1) + 1).toFixed(1) + "," + (h - 3 - (v - mn) / rg * (h - 6)).toFixed(1));
    const up = a[n - 1] >= a[0];
    return `<svg class="st-sp ${flat ? "flat" : up ? "up" : "dn"}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polygon points="1,${h} ${pts.join(" ")} ${w - 1},${h}"/><polyline points="${pts.join(" ")}"/></svg>`;
  }
  // last N closes for a stock, only from data already in memory
  function cachedCloses(sym, n) {
    const h = S.hist[sym]; if (h && h.st === "ok") return h.rows.slice(-n).map(r => r[4]);
    const ck = S.chunks[chunkKey(sym)], d = ck && ck.s && ck.s[sym];
    if (d && Array.isArray(d[19])) return d[19].slice(-n);
    return null;
  }

  // one rich stock row (symbol, name, price, change pill, sub line, star)
  function stockRow(H, o) {
    const sp = spark(o.spark, o.sp2 ? 110 : 64, 28), on = o.on === undefined ? watched(H).includes(o.sym) : o.on;
    return `<div class="st-r"><button class="st-rm" data-m="stocks" data-act="open" data-sym="${H.esc(o.sym)}" aria-label="Open ${H.esc(o.sym)}">${avatar(o.sym)}
      <span class="st-id"><b>${H.esc(o.sym)}${o.tag && o.tag !== "EQ" ? ` <i class="st-tag">${H.esc(o.tag)}</i>` : ""}</b><small>${H.esc(o.name || "")}</small></span>
      ${sp && !o.sp2 ? `<span class="st-spw">${sp}</span>` : ""}
      <span class="st-pv"><b>${px(o.price)}</b>${pill(o.chg)}</span>
      ${o.sub ? `<span class="st-sub">${o.sub}</span>` : ""}${sp && o.sp2 ? `<span class="st-spw r2">${sp}</span>` : ""}</button>${o.remove ? `<button class="st-x" data-m="stocks" data-act="unstar" data-sym="${H.esc(o.sym)}" aria-label="Remove ${H.esc(o.sym)} from watchlist">${ic("x")}</button>` : star(H, o.sym, on)}</div>`;
  }
  const moverRows = (H, rows, n, sub, withSpark) => rows.slice(0, n).map(r => {
    const l = S.listBy && S.listBy.get(r[0]);
    return stockRow(H, { sym: r[0], name: r[1], price: r[2], chg: r[3], sub: sub ? sub(r, l) : "", spark: withSpark ? cachedCloses(r[0], 20) : null });
  }).join("");
  const subValue = (r, l) => { const v = isNum(r[7]) ? r[7] : l && isNum(l[5]) ? l[5] : null; return `Value ${croreC(r[4])}${isNum(v) ? " · Vol " + units(v) : ""}`; };

  // ---------- chart card (shared by stock and index pages) ----------
  function ensureCfg(key, p) {
    const TC = window.TrendyCharts, last = p.rows[p.rows.length - 1], sig = [key, p.rows.length, last[0], last[4], last[2], last[3], p.prev, p.h52, p.l52, p.sub, p.closeOnly ? 1 : 0].join("|");
    let c = S.cfg[key];
    if (!c || c.sig !== sig) {
      c = S.cfg[key] = { sig, data: p.rows, type: p.closeOnly ? "line" : S.ct.type, range: S.ct.range, ranges: ["1M", "3M", "6M", "1Y", "All"], volume: true,
        ma: { sma20: S.ct.sma20, sma50: S.ct.sma50 }, prevClose: isNum(p.prev) ? p.prev : undefined, high52: isNum(p.h52) ? p.h52 : undefined, low52: isNum(p.l52) ? p.l52 : undefined,
        currency: p.currency === "" ? "" : "₹", title: p.title, subtitle: p.sub, height: window.innerWidth <= 640 ? 240 : 300 };
    }
    TC.configure(key, c); return c;
  }
  function chartCard(H, key, p) {
    // p: {st, rows, prev, h52, l52, title, sub, live, liveTitle, note, closeOnly, retry:{act,attrs}}
    const TC = window.TrendyCharts;
    const live = p.live && TC ? TC.liveEmbed(p.live, { title: p.liveTitle, height: 440 }) : "";
    const view = S.view === "live" && live ? "live" : "chart";
    const seg = live ? `<div class="st-seg" role="group" aria-label="Chart view"><button class="${view === "chart" ? "on" : ""}" data-m="stocks" data-act="view" data-v="chart" aria-pressed="${view === "chart"}">${ic("chart-line")} Chart</button><button class="${view === "live" ? "on" : ""}" data-m="stocks" data-act="view" data-v="live" aria-pressed="${view === "live"}">${ic("bolt")} Live</button></div>` : "";
    let body;
    if (view === "live") body = `<div class="st-live">${live}</div><p class="mut sm st-cn">Intraday chart by TradingView, delayed. It is not part of the end-of-day data below.</p>`;
    else if (!TC) body = '<p class="mut">The chart could not be loaded.</p>';
    else if (p.st === "loading") body = '<div class="skel-block st-chsk"></div><div class="skel-line w60"></div>';
    else if (p.st === "fail") body = retryBox("The price history could not be loaded.", p.retry.act, p.retry.attrs);
    else if (p.st !== "ok" || !p.rows || p.rows.length < 2) body = `<div class="st-msg"><p><b>Price chart is not available for this stock yet.</b></p><p class="mut sm">End-of-day history is kept for the most traded stocks only.${live ? " Use Live to see the TradingView chart." : ""}</p>${live ? `<button class="btn sm" data-m="stocks" data-act="view" data-v="live">${ic("bolt")} Show live chart</button>` : ""}</div>`;
    else {
      ensureCfg(key, p);
      body = `<div data-tc="price" data-tc-key="${H.esc(key)}"></div><p class="mut sm st-cn">${p.note ? H.esc(p.note) + " " : ""}Drag or touch the chart for a crosshair. Ctrl + scroll zooms.</p>`;
    }
    return `<div class="card st-chart"><div class="st-ch-h"><h2>${ic("chart-bar")} Price chart</h2>${seg}</div>${body}</div>`;
  }
  // remember the user's range / type / SMA choice so the chart keeps it across the app's re-renders
  document.addEventListener("click", e => {
    const b = e.target && e.target.closest && e.target.closest("[data-tc-key] .tcx-chip"); if (!b) return;
    const box = b.closest("[data-tc-key]"), key = box && box.getAttribute("data-tc-key"); if (!key || key.indexOf("st-") !== 0) return;
    setTimeout(() => {
      const c = S.cfg[key]; if (!c) return;
      const r = box.querySelector('[data-r][aria-pressed="true"]'); if (r) S.ct.range = c.range = r.getAttribute("data-r");
      const types = { Candles: "candles", Line: "line", Area: "area" };
      box.querySelectorAll(".tcx-head .tcx-chip").forEach(x => { if (x.getAttribute("aria-pressed") === "true" && types[x.textContent.trim()] && !c.sig.endsWith("|1")) S.ct.type = c.type = types[x.textContent.trim()]; });
      box.querySelectorAll(".tcx-bar .tcx-chip:not([data-r])").forEach(x => { const t = x.textContent.trim(), on = x.getAttribute("aria-pressed") === "true"; if (t === "SMA 20") S.ct.sma20 = c.ma.sma20 = on; if (t === "SMA 50") S.ct.sma50 = c.ma.sma50 = on; });
    }, 0);
  });
  const mount = () => { if (!window.TrendyCharts) return; const f = () => window.TrendyCharts.auto(document); requestAnimationFrame(f); setTimeout(f, 150); };

  // return % from a rows array [[date,o,h,l,c,v]] for calendar offsets
  function retFrom(rows, days) {
    const n = rows.length; if (n < 2) return null;
    const last = rows[n - 1], t = Date.parse(last[0] + "T00:00:00Z") - days * 864e5;
    if (Date.parse(rows[0][0] + "T00:00:00Z") > t + 5 * 864e5) return null;
    let i = n - 1; while (i > 0 && Date.parse(rows[i][0] + "T00:00:00Z") > t) i--;
    return rows[i][4] > 0 ? (last[4] / rows[i][4] - 1) * 100 : null;
  }
  const perfStrip = (H, vals, date) => `<div class="card st-perf-c"><h2>${ic("trending-up")} Performance${date ? ` <span class="st-hl">end of day, ${H.esc(H.fmtD(date))}</span>` : ""}</h2><div class="st-perf">${[["1W", 0], ["1M", 1], ["3M", 2], ["6M", 3], ["1Y", 4]].map(([l, i]) =>
    `<div class="st-pf ${dir(vals[i])}"><span>${l}</span><b>${isNum(vals[i]) ? pct(vals[i]) : "—"}</b></div>`).join("")}</div></div>`;
  function rangeBar(H, lo, hi, cur, loD, hiD, label) {
    if (!(isNum(lo) && isNum(hi) && hi > lo && isNum(cur))) return "";
    const pos = Math.max(0, Math.min(100, (cur - lo) / (hi - lo) * 100));
    return `<div class="st-52"><div class="st-52h"><b>52-week range</b><span class="mut">${nf(pos, 0)}% of the range</span></div>
      <div class="st-bar" role="img" aria-label="Price is ${Math.round(pos)} percent of the way from the 52-week low to the high"><i style="left:${pos.toFixed(1)}%"></i></div>
      <div class="st-52l"><span><b>${label ? label(lo) : rs(lo)}</b>${loD ? `<small class="mut"> ${H.esc(H.fmtD(loD))}</small>` : ""}</span><span class="st-rt"><b>${label ? label(hi) : rs(hi)}</b>${hiD ? `<small class="mut"> ${H.esc(H.fmtD(hiD))}</small>` : ""}</span></div></div>`;
  }

  // ---------- live snapshot helpers (live.js, docs/LIVE.md) ----------
  // A "region" is a block whose HTML depends on the live snapshot: <div data-lvr="name">. livePatch() swaps only regions whose content really changed, so a
  // snapshot never re-renders the page (no chart re-mount, no focus loss, no flicker).
  const TL = () => window.TrendyLive || null;
  const snap = () => { const t = TL(); return t && t.peek ? t.peek() : null; };
  const eodDay = () => [S.meta && S.meta.tradeDate, S.movers && S.movers.tradeDate].filter(x => typeof x === "string").sort().pop() || "";
  const liveOn = () => { const t = TL(); return !!(t && t.usable && snap() && t.usable(eodDay())); };    // a snapshot exists and is not older than the end-of-day data
  const lq = sym => { const t = TL(); return t && liveOn() ? t.quote(sym) : null; };
  const lix = name => { const t = TL(); return t && liveOn() ? t.index(name) : null; };
  const snapTag = H => { const t = TL(), m = snap(), d = t && t.asOnDay(); return m && d ? "Snapshot " + H.esc(H.fmtD(d)) + ", " + H.esc(String(m.meta.asOn).slice(11, 16)) + " IST" : "Snapshot"; };   // when the numbers are from
  const eodTxt = () => HH && eodDay() ? HH.fmtD(eodDay()) : "";
  const barHtml = what => { const t = TL(); return t ? t.bar({ what, eod: eodTxt(), fresh: !snap() || liveOn() }) : ""; };
  const barSig = () => { const t = TL(); return t ? t.status().state + "|" + (!snap() || liveOn()) : ""; };
  const eodPill = msg => `<span class="tl-pill tl-closed" data-tl-static="1"><span class="tl-dot" aria-hidden="true"></span>${HH.esc(msg)}</span>`;
  const RG = {};
  const reg = (name, build, sigFn) => { const html = build(); RG[name] = sigFn ? sigFn() : html; return `<div data-lvr="${name}">${html}</div>`; };
  function setReg(name, build, sigFn) {
    const el = document.querySelector('#app [data-lvr="' + name + '"]'); if (!el) return;
    let sig, html;
    if (sigFn) { sig = sigFn(); if (RG[name] === sig) return; html = build(); } else { html = build(); sig = html; if (RG[name] === sig) return; }
    RG[name] = sig; el.innerHTML = html;
  }
  // live movers: same liquidity filter (traded value >= MINV crore) and same definitions as the end-of-day lists, from the snapshot's stock rows
  const MINV = 2;
  let LL = { at: null, v: null };
  function liveLists() {
    const m = snap(); if (!m) return null;
    if (LL.at === m) return LL.v;
    const ci = {}; m.cols.forEach((c, i) => { ci[c] = i; });
    const nm = s => { const l = S.listBy && S.listBy.get(s); return l ? l[1] : ""; };
    const ok = m.stocks.filter(r => isNum(r[ci.tv]) && r[ci.tv] >= MINV && isNum(r[ci.p]) && isNum(r[ci.c]));
    const row = (r, dist) => [r[ci.s], nm(r[ci.s]), r[ci.c], r[ci.p], r[ci.tv], null, dist, r[ci.v]];
    const byTv = (a, b) => b[ci.tv] - a[ci.tv];
    const out = {
      gain: ok.filter(r => r[ci.p] > 0).sort((a, b) => b[ci.p] - a[ci.p] || byTv(a, b)).slice(0, 100).map(r => row(r)),
      loss: ok.filter(r => r[ci.p] < 0).sort((a, b) => a[ci.p] - b[ci.p] || byTv(a, b)).slice(0, 100).map(r => row(r)),
      active: [...ok].sort(byTv).slice(0, 100).map(r => row(r)),
      hi: ok.filter(r => isNum(r[ci.wh]) && r[ci.wh] > 0).map(r => [r, Math.max(0, (r[ci.wh] - r[ci.c]) / r[ci.wh] * 100)]).filter(x => x[1] <= 3).sort((a, b) => a[1] - b[1] || byTv(a[0], b[0])).slice(0, 100).map(x => row(x[0], x[1])),
      lo: ok.filter(r => isNum(r[ci.wl]) && r[ci.wl] > 0).map(r => [r, Math.max(0, (r[ci.c] - r[ci.wl]) / r[ci.wl] * 100)]).filter(x => x[1] <= 3).sort((a, b) => a[1] - b[1] || byTv(a[0], b[0])).slice(0, 100).map(x => row(x[0], x[1])),
      n: ok.length,
    };
    LL = { at: m, v: out }; return out;
  }
  const moverSrc = H => liveOn() ? liveLists() : null;
  const srcLabel = (H, L) => L ? `${snapTag(HH)} · ${L.n} stocks of NIFTY 500 and the F&O list that traded at least ₹${MINV} crore` : `End of day, ${H.esc(H.fmtD((S.movers && S.movers.tradeDate) || eodDay()))} · all NSE stocks that traded at least ₹${MINV} crore`;

  // ---------- Market ----------
  const idxCardsHtml = H => {
    const lv = liveOn();
    const cards = FEATURED.map(s => S.idxBy && S.idxBy.get(s)).filter(Boolean).map(r => {
      const h = S.idxH[r[0]], vix = r[0] === "india-vix", closes = h && h.st === "ok" ? h.rows.slice(-30).map(x => x[4]) : null;
      const L = lix(r[1]), live = !!(L && isNum(L.last)), v = live ? L.last : r[2], pts = live ? L.chg : r[3], pc = live ? L.pct : r[4];
      return `<button class="st-ixc ${vix ? "flat" : dir(pc)}" data-m="stocks" data-act="openidx" data-slug="${H.esc(r[0])}" aria-label="Open ${H.esc(r[1])}">
        <span class="st-ixn">${H.esc(r[1].replace(/^NIFTY/i, "Nifty"))}${lv && !live ? ' <i class="st-tag">EOD</i>' : ""}</span><b>${px(v)}</b><span class="st-ixv ${vix ? "" : cls(pc)}">${arrow(pc)} ${sgn(pts)} · ${pct(pc)}</span>
        ${closes ? spark(closes, 120, 34, vix) : '<span class="st-spph"></span>'}</button>`;
    }).join("");
    const sensex = `<button class="st-ixc flat st-live-t" data-m="stocks" data-act="openidx" data-slug="sensex"><span class="st-ixn">BSE Sensex</span><b>Live chart</b><span class="st-ixv mut">${ic("bolt")} TradingView only</span><span class="st-spph"></span></button>`;
    if (S.idxList && cards) {
      const all = S.idxList.rows;
      const list = all.map(r => { const L = lix(r[1]), live = !!(L && isNum(L.last)); return `<button class="st-ixr" data-m="stocks" data-act="openidx" data-slug="${H.esc(r[0])}"><span class="st-ixrn">${H.esc(r[1])}${lv && !live ? ' <i class="st-tag">EOD</i>' : ""}</span><b>${px(live ? L.last : r[2])}</b>${pill(live ? L.pct : r[4])}</button>`; }).join("");
      return `<div class="card"><div class="st-ch-h"><h2>${ic("chart-bar")} Indices</h2><span class="mut sm">${lv ? snapTag(H) : "End of day, " + H.esc(H.fmtD(S.idxList.date))}</span></div>
        <div class="st-ixg">${cards}${sensex}</div>
        <button class="linkbtn st-lk" data-m="stocks" data-act="allidx" aria-expanded="${S.allIdx}">${S.allIdx ? "Hide all indices" : "Show all " + all.length + " indices"} ${ic(S.allIdx ? "minus" : "plus")}</button>
        ${S.allIdx ? `<div class="st-ixl">${list}</div>` : ""}
        <p class="mut sm st-foot">${lv ? "Index levels from the live snapshot of NSE's public website data; an index missing from it shows its end-of-day level, marked EOD." : "Closing levels from NSE India."} BSE Sensex data is not available here; use its live chart.</p></div>`;
    }
    if (S.idxList === null && S.status === "ok") return `<div class="card">${S.index && Array.isArray(S.index.rows) ? "<h2>Indices</h2>" + H.tbl(["Index", "Close", "Change %"], S.index.rows.slice(0, 12).map(r => [H.esc(r[0]), px(r[1]), `<span class="${cls(r[3])}">${pct(r[3])}</span>`])) : '<p class="mut">Index data is not available right now.</p>'}</div>`;
    return "";
  };
  const adHtml = H => {
    if (!liveOn()) return "";
    const rows = ["NIFTY 50", "NIFTY 500"].map(n => {
      const L = lix(n); if (!L || !isNum(L.adv) || !isNum(L.dec) || L.adv + L.dec <= 0) return "";
      const t = L.adv + L.dec, a = L.adv / t * 100;
      return `<div class="st-ad"><div class="st-adh"><b>${H.esc(n.replace("NIFTY", "Nifty"))}</b><span><b class="grn-t">${nf(L.adv, 0)}</b> advancing · <b class="red-t">${nf(L.dec, 0)}</b> declining</span></div>
        <div class="st-adb" role="img" aria-label="${nf(L.adv, 0)} advancing and ${nf(L.dec, 0)} declining"><i style="width:${a.toFixed(1)}%"></i><u style="width:${(100 - a).toFixed(1)}%"></u></div></div>`;
    }).join("");
    return rows ? `<div class="card"><div class="st-ch-h"><h2>${ic("arrows-exchange")} Advances / Declines</h2><span class="mut sm">${snapTag(H)}</span></div>${rows}<p class="mut sm st-foot">Stocks of the index that are up or down against the previous close; unchanged stocks are not counted.</p></div>` : "";
  };
  const miniCard = (H, title, icon, rows, key, sub) => `<div class="card st-mini"><div class="st-ch-h"><h2>${ic(icon)} ${title}</h2><button class="linkbtn" data-m="stocks" data-act="seeall" data-k="${key}">See all ${ic("chevron-right")}</button></div>${rows.length ? `<div class="st-list">${moverRows(H, rows, 5, sub, true)}</div>` : '<p class="mut">—</p>'}</div>`;
  const marketMovers = H => {
    const L = moverSrc(H), m = L || S.movers, dist = word => r => isNum(r[6]) ? nf(r[6], 1) + "% " + word : "—";
    return `<p class="tl-sec">${srcLabel(H, L)}</p><div class="st-g3">${miniCard(H, "Top gainers", "trending-up", m.gain, "gain", subValue)}${miniCard(H, "Top losers", "trending-down", m.loss, "loss", subValue)}${miniCard(H, "Most active", "flame", m.active, "active", subValue)}</div>
      <div class="st-g2">${miniCard(H, "Near 52-week high", "trophy", m.hi, "hi", dist("below high"))}${miniCard(H, "Near 52-week low", "target", m.lo, "lo", dist("above low"))}</div>`;
  };
  function market(H) {
    ensureList(H);
    if (!S.idxLoadedKick) { S.idxLoadedKick = true; Promise.all(FEATURED.map(s => ensureIdxH(s, H, true))).then(() => H.render()); }
    return H.head("Stocks") + stale() + reg("mk-bar", () => barHtml("Index values and movers"), barSig) +
      `<div class="st-grid">${reg("mk-idx", () => idxCardsHtml(H))}${reg("mk-ad", () => adHtml(H))}${reg("mk-mov", () => marketMovers(H))}</div>` + foot(H);
  }

  // ---------- Movers ----------
  const moversCard = (H, k) => {
    const L = k === "deliv" ? null : moverSrc(H), m = L || S.movers, rows = Array.isArray(m[k]) ? m[k] : [];
    const sub = (r, l) => k === "deliv" ? `Delivery ${isNum(r[5]) ? nf(r[5], 1) + "%" : "—"} · ${subValue(r, l)}`
      : k === "hi" ? `${isNum(r[6]) ? nf(r[6], 1) + "% below 52W high" : "—"} · ${subValue(r, l)}`
      : k === "lo" ? `${isNum(r[6]) ? nf(r[6], 1) + "% above 52W low" : "—"} · ${subValue(r, l)}`
      : subValue(r, l);
    const shown = Math.min(S.shown, rows.length);
    const body = rows.length ? `<div class="st-list">${moverRows(H, rows, shown, sub, true)}</div>${rows.length > shown ? `<button class="btn ghost st-more" data-m="stocks" data-act="more">Show more (${rows.length - shown} more)</button>` : ""}` : `<div class="st-msg"><p><b>No stocks in this list.</b></p><p class="mut sm">Nothing matched for the latest ${L ? "snapshot" : "trade date"}.</p></div>`;
    const note = L ? NOTE_LIVE[k] : NOTE[k];
    return `<div class="card"><div class="st-ch-h"><h2>${H.esc(LISTS.find(l => l[0] === k)[1])}</h2><span class="mut sm">${rows.length} stocks</span></div><p class="tl-sec">${srcLabel(H, L)}</p><p class="mut sm st-note2">${H.esc(note)}</p>${body}</div>`;
  };
  function movers(H) {
    ensureList(H);
    const k = LISTS.some(l => l[0] === S.k) ? S.k : "gain";
    const sw = LISTS.map(([id, l]) => `<button class="${id === k ? "on" : ""}" data-m="stocks" data-act="list" data-k="${id}" aria-pressed="${id === k}">${l}</button>`).join("");
    return H.head("Stocks") + stale() + reg("mv-bar", () => barHtml("Gainers, losers, most active and 52-week lists"), barSig) + `<div class="st-sw" role="group" aria-label="List">${sw}</div>` +
      reg("mv-list", () => moversCard(H, k)) + foot(H);
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
  function popular() {
    if (S.list) return S.list.rows.filter(r => r[2] === "EQ" && isNum(r[6])).sort((a, b) => b[6] - a[6]).slice(0, 12).map(r => r[0]);
    return S.movers ? S.movers.active.slice(0, 12).map(r => r[0]) : [];
  }
  function search(H) {
    ensureList(H);
    let body;
    const rec = recents(H);
    if (S.listStatus === "fail") body = retryBox("The stock list could not be loaded.", "retrylist");
    else if (!S.list) body = skelRows(4);
    else if (!S.q.trim()) {
      const pop = popular(), chip = s => `<button class="st-chip btn-chip" data-m="stocks" data-act="open" data-sym="${H.esc(s)}">${avatar(s)}<span>${H.esc(s)}</span></button>`;
      body = (rec.length ? `<div class="st-sec"><div class="st-ch-h"><h3>Recent</h3><button class="linkbtn" data-m="stocks" data-act="recentclear">Clear</button></div><div class="st-chips">${rec.map(chip).join("")}</div></div>` : "") +
        `<div class="st-sec"><h3>Popular today</h3><div class="st-chips">${pop.map(chip).join("")}</div></div><p class="mut sm">Type a stock symbol or company name (for example RELIANCE, Tata, bank). ${S.list.rows.length} NSE stocks are listed.</p>`;
    } else {
      const all = match(S.q), res = all.slice(0, 50);
      body = res.length ? `<p class="mut sm st-cnt">${all.length} match${all.length === 1 ? "" : "es"}${all.length > 50 ? ", showing the first 50. Type more letters to narrow down." : ""}</p><div class="st-list">${res.map(([, r]) =>
        stockRow(H, { sym: r[0], name: r[1], price: r[3], chg: r[4], tag: r[2], sub: `Value ${croreC(r[6])} · Vol ${units(r[5])}`, spark: cachedCloses(r[0], 20) })).join("")}</div>`
        : `<div class="st-msg"><p><b>No stock matches that search.</b></p><p class="mut sm">Try the stock symbol or fewer letters.</p></div>`;
    }
    return H.head("Stocks") + stale() + `<div class="card st-sc"><label class="st-sin">${ic("search")}<input id="st-q" type="search" data-m="stocks" placeholder="Search symbol or company" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search stocks" value="${H.esc(S.q)}" maxlength="40"></label>${body}</div>` + foot(H);
  }

  // ---------- Watchlist ----------
  function watch(H) {
    ensureList(H);
    const w = watched(H);
    let body;
    if (!w.length) body = `<div class="st-empty">${ic("star")}<p><b>Your watchlist is empty</b></p><p class="mut">Open any stock and tap the star to follow it here. The list is saved on this device only.</p><button class="btn" data-m="stocks" data-act="gosearch">${ic("search")} Search stocks</button></div>`;
    else if (S.listStatus === "fail") body = retryBox("Prices could not be loaded.", "retrylist");
    else if (!S.list) body = skelRows(Math.min(w.length, 5));
    else {
      const need = w.slice(0, 20).filter(s => !S.hist[s]);
      if (need.length) Promise.all(need.map(s => ensureHist(s, H, true))).then(() => H.render());
      body = `<div class="st-list">${w.map(sym => {
        const r = S.listBy.get(sym);
        return r ? stockRow(H, { sym: r[0], name: r[1], price: r[3], chg: r[4], tag: r[2], sub: `Value ${croreC(r[6])} · Vol ${units(r[5])}`, spark: cachedCloses(sym, 30), sp2: true, remove: true })
          : stockRow(H, { sym, name: "Not in the latest data", price: null, chg: null, remove: true });
      }).join("")}</div>`;
    }
    return H.head("Stocks") + stale() + `<div class="card"><div class="st-ch-h"><h2>${ic("star")} Watchlist${w.length ? " (" + w.length + ")" : ""}</h2></div>${body}</div>` + foot(H);
  }

  // ---------- Stock page ----------
  // Layout (phones): compact header (name, price, change, status) -> chart -> details -> performance -> stats. Wide screens: header + details left, chart right.
  function stockCtx(sym) {
    const ck = S.chunks[chunkKey(sym)], d = ck && ck.s && ck.s[sym]; if (!d) return null;
    const [name, isin, ser, open, high, low, prev, close, vol, valL, trades, , dp, w52h, w52hd, w52l, w52ld, listed, fv, closes, stats] = d;
    return { sym, ck, name, isin, ser, open, high, low, prev, close, vol, valL, trades, dp, w52h, w52hd, w52l, w52ld, listed, fv, closes, st: Array.isArray(stats) ? stats : [], hs: S.hist[sym] || { st: "loading" } };
  }
  // which status pill goes with the numbers on screen: the live one only when live numbers are shown
  const pillFor = (H, shownLive) => {
    const t = TL();
    if (!t) return eodPill("End-of-day data, " + eodTxt());
    if (shownLive || !snap()) return t.badge();
    return eodPill(liveOn() ? "Not in the live snapshot · end of day, " + eodTxt() : "End of day, " + eodTxt() + " · the live snapshot is older");
  };
  const tileH = (l, v) => `<div class="bt"><span>${l}</span><b>${v}</b></div>`;
  function stockHero(H, c) {
    const q = lq(c.sym), live = !!(q && isNum(q.c)), on = watched(H).includes(c.sym);
    const price = live ? q.c : c.close;
    const chg = live ? (isNum(q.ch) ? q.ch : null) : (isNum(c.close) && isNum(c.prev) ? c.close - c.prev : null);
    const chgP = live ? (isNum(q.p) ? q.p : null) : (chg !== null && c.prev > 0 ? chg / c.prev * 100 : null);
    return `<div class="card st-hero st-compact ${isNum(chg) ? (chg > 0 ? "t-up" : chg < 0 ? "t-dn" : "") : ""}">
      <div class="st-hh">${avatar(c.sym, true)}<div class="st-hid"><h2>${H.esc(c.name || c.sym)}</h2><span class="st-sym mut">${H.esc(c.sym)} · NSE ${H.esc(c.ser || "—")}</span></div>${star(H, c.sym, on)}</div>
      <div class="st-hp"><b>${rs(price)}</b><span class="st-pill big ${dir(chg)}">${arrow(chg)} ${sgn(chg)} (${pct(chgP)})</span></div>
      <div class="st-hs">${pillFor(H, live)}</div></div>`;
  }
  function stockDet(H, c) {
    const q = lq(c.sym), live = !!(q && isNum(q.c)), hs = c.hs;
    const chips = `<div class="st-chips"><span class="st-chip">${H.esc(c.sym)}</span><span class="st-chip">NSE · ${H.esc(c.ser || "—")}</span>${isNum(c.st[7]) ? `<span class="st-chip">${ic("award")} #${nf(c.st[7], 0)} by turnover (end of day)</span>` : ""}</div>`;
    const adj = hs.st === "ok" && hs.adj.length ? `<div class="st-chips st-adj">${hs.adj.slice(-3).map(a => `<span class="st-chip warn" title="Prices and volumes before this date are adjusted">${ic("scale")} Adjusted for split/bonus on ${H.esc(H.fmtD(a[0]))}</span>`).join("")}</div>` : "";
    let tiles, range, note, title, tag;
    if (live) {
      title = "Latest trading"; tag = snapTag(H);
      tiles = tileH("Open", rs(q.o)) + tileH("High", rs(q.h)) + tileH("Low", rs(q.l)) + tileH("Prev close", rs(q.pc)) + tileH("Volume", isNum(q.v) ? nf(q.v, 0) : "—") + tileH("Traded value", croreC(q.tv));
      range = rangeBar(H, q.wl, q.wh, q.c) || (isNum(q.wh) || isNum(q.wl) ? `<div class="bento">${tileH("52-week high", rs(q.wh))}${tileH("52-week low", rs(q.wl))}</div>` : '<p class="mut sm">52-week range is not available for this stock.</p>');
      note = `Prices from the live snapshot${q.t ? " (quote time " + H.esc(q.t) + " IST)" : ""}. Change is against the previous close. Delivery %, trades, averages and history below are end-of-day.`;
    } else {
      title = "Day's trading"; tag = "End of day, " + H.esc(H.fmtD(c.ck.tradeDate));
      tiles = tileH("Open", rs(c.open)) + tileH("High", rs(c.high)) + tileH("Low", rs(c.low)) + tileH("Prev close", rs(c.prev)) + tileH("Volume", isNum(c.vol) ? nf(c.vol, 0) : "—") + tileH("Traded value", crore(c.valL)) + tileH("Delivery %", isNum(c.dp) ? nf(c.dp, 2) + "%" : "—") + tileH("Trades", isNum(c.trades) ? nf(c.trades, 0) : "—");
      range = rangeBar(H, c.w52l, c.w52h, c.close, c.w52ld, c.w52hd) || (isNum(c.w52h) || isNum(c.w52l) ? `<div class="bento">${tileH("52-week high", rs(c.w52h))}${tileH("52-week low", rs(c.w52l))}</div>` : '<p class="mut sm">52-week range is not available for this stock.</p>');
      note = `Close on ${H.esc(H.fmtD(c.ck.tradeDate))}. Change is against the previous close.`;
    }
    return `<div class="card st-det"><div class="st-ch-h"><h2>${ic("list-details")} ${title}</h2><span class="mut sm">${tag}</span></div>${chips}${adj}<div class="bento st-b4">${tiles}</div>${range}<p class="mut sm st-cn">${note}</p></div>`;
  }
  function stockStats(H, c) {
    const live = !!lq(c.sym), st = c.st, avgV = st[6];
    const dh = isNum(c.w52h) && isNum(c.close) && c.w52h > 0 ? (c.close / c.w52h - 1) * 100 : null, dl = isNum(c.w52l) && isNum(c.close) && c.w52l > 0 ? (c.close / c.w52l - 1) * 100 : null;
    const t52 = live ? "" : tileH("52W high", rs(c.w52h) + (isNum(dh) ? `<em>${nf(Math.abs(dh), 1)}% ${dh < 0 ? "below" : "from"} high</em>` : "")) + tileH("52W low", rs(c.w52l) + (isNum(dl) ? `<em>${nf(dl, 1)}% above low</em>` : ""));
    const extra = live ? tileH("Trades", isNum(c.trades) ? nf(c.trades, 0) : "—") + tileH("Series", H.esc(c.ser || "—")) : "";
    return `<div class="card"><h2>${ic("list-details")} Stats <span class="st-hl">end of day, ${H.esc(H.fmtD(c.ck.tradeDate))}</span></h2><div class="bento st-b4">${tileH("Avg volume (20D)", isNum(avgV) ? nf(avgV, 0) : "—")}${t52}${tileH("Delivery %", isNum(c.dp) ? nf(c.dp, 2) + "%" : "—")}${extra}
      ${tileH("ISIN", c.isin ? H.esc(c.isin) : "—")}${tileH("Face value", isNum(c.fv) ? rs(c.fv) : "—")}${tileH("Listed on", c.listed ? H.esc(H.fmtD(c.listed)) : "—")}${tileH("Turnover rank", isNum(st[7]) ? "#" + nf(st[7], 0) : "—")}</div></div>`;
  }
  // today's partial candle from a live row ({o,h,l,c,v}); only when every price is valid and consistent, and only for a day after the last candle
  function partialRow(rows, q, day) {
    if (!q || !day || !rows.length) return null;
    const last = rows[rows.length - 1]; if (!(day > last[0])) return null;
    const { o, h, l, c } = q;
    if (![o, h, l, c].every(x => isNum(x) && x > 0)) return null;
    if (h < Math.max(o, c) || l > Math.min(o, c)) return null;
    return [day, o, h, l, c, isNum(q.v) && q.v >= 0 ? q.v : null];
  }
  function liveRows(H, rows, q, day, label) {            // -> {rows, sub, pc, h52, l52} or null
    const t = TL(); if (!q || !t) return null;
    const row = partialRow(rows, q, day); if (!row) return null;
    return { rows: rows.concat([row]), sub: "NSE · end of day · last bar: " + (day === H.istDay() ? "today" : H.fmtD(day)) + ", live snapshot", pc: isNum(q.pc) && q.pc > 0 ? q.pc : null, h52: q[label[0]], l52: q[label[1]] };
  }
  function stockChartP(H, c) {
    const { sym, hs, closes, ck } = c;
    let cp;
    const tv = window.TrendyCharts ? window.TrendyCharts.tvSymbol("stock", sym) : "";
    if (hs.st === "ok") cp = { st: "ok", rows: hs.rows, note: "Adjusted for splits and bonus issues." };
    else if (hs.st === "none" && Array.isArray(closes) && closes.length >= 5) {
      const ds = ck.d.slice(-closes.length), rows = [];
      closes.forEach((v, i) => { if (isNum(v) && v > 0 && ds[i]) rows.push([ds[i], null, null, null, v, null]); });
      cp = { st: rows.length >= 5 ? "ok" : "none", rows, closeOnly: true, note: "Closing prices only (open, high, low and volume are not kept for this stock)." };
    } else cp = { st: hs.st === "loading" ? "loading" : hs.st === "fail" ? "fail" : "none" };
    Object.assign(cp, { prev: c.prev, h52: c.w52h, l52: c.w52l, title: sym, sub: "NSE · end of day", live: tv, liveTitle: "Live chart for " + sym, retry: { act: "retryhist", attrs: ` data-sym="${H.esc(sym)}"` } });
    if (cp.st === "ok" && !cp.closeOnly) {
      const lr = liveRows(H, cp.rows, lq(sym), TL() && TL().asOnDay(), ["wh", "wl"]);
      if (lr) { cp.rows = lr.rows; cp.sub = lr.sub; if (lr.pc) cp.prev = lr.pc; if (isNum(lr.h52)) cp.h52 = lr.h52; if (isNum(lr.l52)) cp.l52 = lr.l52; cp.note = "Adjusted for splits and bonus issues. The last bar is built from the live snapshot (open, high, low and last price so far)."; }
    }
    return cp;
  }
  function stockPage(sym, H) {
    if (!symOk(sym)) return H.head("Stock") + `<div class="card"><div class="st-msg"><p><b>This stock could not be found.</b></p></div></div>`;
    ensureChunk(sym, H);
    const k = chunkKey(sym), ck = S.chunks[k];
    if (!ck) return H.head(H.esc(sym)) + (S.chunkStatus[k] === "fail" ? `<div class="card">${retryBox("The data for this stock could not be loaded.", "retrychunk", ` data-sym="${H.esc(sym)}"`)}</div>`
      : `<div class="st-page">${skelCard(150)}${skelCard(260)}</div>`) + foot(H);
    if (!ck.s[sym]) return H.head(H.esc(sym)) + `<div class="card"><div class="st-msg"><p><b>This symbol is not in the latest NSE data.</b></p><p class="mut sm">It may be suspended, delisted or renamed.</p></div></div>` + foot(H);
    ensureHist(sym, H);
    const c = stockCtx(sym), cp = stockChartP(H, c);
    mount();
    const url = H.safeUrl("https://www.nseindia.com/get-quotes/equity?symbol=" + encodeURIComponent(sym));
    return H.head(H.esc(sym)) + stale() +
      `<div class="st-page st-split">${reg("sp-hero", () => stockHero(H, c))}${chartCard(H, "st-" + sym, cp)}${reg("sp-det", () => stockDet(H, c))}${perfStrip(H, c.st, ck.tradeDate)}${reg("sp-stats", () => stockStats(H, c))}
      <div class="card st-lnk"><p class="mut sm">Live quote, announcements and financials on the NSE website.</p>${url ? `<a class="btn ghost" href="${H.esc(url)}" target="_blank" rel="noopener noreferrer">${ic("external-link")} Open on NSE India</a>` : ""}</div></div>` +
      foot(H, " Prices adjusted for splits and bonus issues.");
  }

  // ---------- Index page ----------
  function indexCtx(slug) {
    const row = S.idxBy && S.idxBy.get(slug), hs = S.idxH[slug] || { st: "loading" };
    const name = (row && row[1]) || (hs.st === "ok" && hs.nm) || slug;
    const rows = hs.st === "ok" ? hs.rows : [], n = rows.length, last = n ? rows[n - 1] : null, prevR = n > 1 ? rows[n - 2] : null;
    const lk = String(name).toLowerCase(), full = S.index && Array.isArray(S.index.rows) ? S.index.rows.find(r => String(r[0]).toLowerCase() === lk) : null;   // [name, close, points, chg, open, high, low, pe]
    let h52 = null, l52 = null, hd = null, ld = null;
    if (n) {
      const cut = Date.parse(last[0] + "T00:00:00Z") - 365 * 864e5;
      rows.forEach(r => { if (Date.parse(r[0] + "T00:00:00Z") >= cut) { if (h52 === null || r[2] > h52) { h52 = r[2]; hd = r[0]; } if (l52 === null || r[3] < l52) { l52 = r[3]; ld = r[0]; } } });
    }
    return { slug, row, hs, name, rows, n, last, prevR, full, h52, l52, hd, ld, vix: slug === "india-vix" };
  }
  function indexHero(H, c) {
    const { row, last, prevR, name, vix } = c, L = lix(name), live = !!(L && isNum(L.last));
    const close = live ? L.last : row ? row[2] : last ? last[4] : null, pts = live ? L.chg : row ? row[3] : last && prevR ? last[4] - prevR[4] : null, chgP = live ? L.pct : row ? row[4] : last && prevR ? (last[4] / prevR[4] - 1) * 100 : null;
    const tone = vix ? "" : dir(chgP) === "up" ? "t-up" : dir(chgP) === "dn" ? "t-dn" : "";
    return `<div class="card st-hero st-compact ${tone}">
      <div class="st-hh">${avatar(name, true)}<div class="st-hid"><h2>${H.esc(name)}</h2><span class="st-sym mut">NSE index</span></div></div>
      <div class="st-hp"><b>${px(close)}</b><span class="st-pill big ${vix ? "flat" : dir(chgP)}">${arrow(chgP)} ${sgn(pts)} (${pct(chgP)})</span></div>
      <div class="st-hs">${pillFor(H, live)}</div></div>`;
  }
  function indexDet(H, c) {
    const { row, last, full, name } = c, L = lix(name), live = !!(L && isNum(L.last)), date = row ? row[5] : last && last[0];
    let tiles, range, note, title, tag;
    if (live) {
      title = "Latest trading"; tag = snapTag(H);
      tiles = tileH("Open", px(L.o)) + tileH("High", px(L.h)) + tileH("Low", px(L.l)) + tileH("Prev close", px(L.pc)) + tileH("P/E", isNum(L.pe) ? nf(L.pe, 2) : "—") + tileH("Advances / declines", isNum(L.adv) && isNum(L.dec) ? nf(L.adv, 0) + " / " + nf(L.dec, 0) : "—");
      range = rangeBar(H, L.yl, L.yh, L.last, null, null, px) || "";
      note = "Levels from the live snapshot. Change is against the previous close. Performance below is from end-of-day closing levels.";
    } else {
      title = "Day's trading"; tag = "End of day" + (date ? ", " + H.esc(H.fmtD(date)) : "");
      tiles = tileH("Open", full ? px(full[4]) : last ? px(last[1]) : "—") + tileH("High", full ? px(full[5]) : last ? px(last[2]) : "—") + tileH("Low", full ? px(full[6]) : last ? px(last[3]) : "—") + tileH("P/E", full && isNum(full[7]) ? nf(full[7], 2) : "—");
      range = rangeBar(H, c.l52, c.h52, row ? row[2] : last ? last[4] : null, c.ld, c.hd, px) || "";
      note = `Closing level on ${date ? H.esc(H.fmtD(date)) : "—"}.`;
    }
    return `<div class="card st-det"><div class="st-ch-h"><h2>${ic("list-details")} ${title}</h2><span class="mut sm">${tag}</span></div><div class="bento st-b4">${tiles}</div>${range}<p class="mut sm st-cn">${note}</p></div>`;
  }
  function indexChartP(H, c, slug) {
    const { hs, rows, prevR, name } = c;
    const tvName = TV_IDX[slug], tv = tvName && window.TrendyCharts ? window.TrendyCharts.tvSymbol("index", tvName) : "";
    const cp = { st: hs.st === "ok" && c.n >= 2 ? "ok" : hs.st, rows, prev: prevR ? prevR[4] : null, h52: c.h52, l52: c.l52, title: name, sub: "NSE index · end of day", currency: "", live: tv, liveTitle: "Live chart for " + name,
      retry: { act: "retryidx", attrs: ` data-slug="${H.esc(slug)}"` }, note: hs.st === "ok" && !hs.hasVol ? "Index volume is not published by NSE for this index." : "" };
    if (cp.st === "ok") {
      const L = lix(name), t = TL(), lr = L && t ? liveRows(H, rows, { o: L.o, h: L.h, l: L.l, c: L.last, pc: L.pc, v: null, wh: L.yh, wl: L.yl }, t.asOnDay(), ["wh", "wl"]) : null;
      if (lr) { cp.rows = lr.rows; cp.sub = lr.sub.replace("NSE · end of day", "NSE index · end of day"); if (lr.pc) cp.prev = lr.pc; if (isNum(lr.h52)) cp.h52 = lr.h52; if (isNum(lr.l52)) cp.l52 = lr.l52; cp.note = (cp.note ? cp.note + " " : "") + "The last bar is built from the live snapshot."; }
    }
    return cp;
  }
  function indexMovers(H) {
    const L = moverSrc(H), m = L || S.movers, mini = (title, icon, list, sub) => `<div class="card st-mini"><h2>${ic(icon)} ${title}</h2><div class="st-list">${moverRows(H, list, 5, sub, true)}</div></div>`;
    return `<p class="tl-sec st-sechd">Across all stocks, not only this index · ${srcLabel(H, L)}</p><div class="st-g2">${mini("Top gainers", "trending-up", m.gain, subValue)}${mini("Top losers", "trending-down", m.loss, subValue)}</div>
      <div class="st-g2">${mini("Near 52-week high", "trophy", m.hi, r => isNum(r[6]) ? nf(r[6], 1) + "% below high" : "—")}${mini("Near 52-week low", "target", m.lo, r => isNum(r[6]) ? nf(r[6], 1) + "% above low" : "—")}</div>`;
  }
  function indexPage(slug, H) {
    if (slug === "sensex") {
      const TC = window.TrendyCharts, tv = TC ? TC.liveEmbed("BSE:SENSEX", { title: "Live chart for BSE Sensex", height: 460 }) : "";
      mount();
      return H.head("BSE Sensex") + `<div class="st-page"><div class="card st-hero"><div class="st-hh">${avatar("BSE", true)}<div class="st-hid"><h2>BSE Sensex</h2><div class="st-chips"><span class="st-chip">${ic("bolt")} Live chart only</span></div></div></div>
        <p class="mut sm">End-of-day Sensex data is not part of this app. The chart below is a delayed intraday chart by TradingView.</p></div>
        <div class="card st-chart"><div class="st-ch-h"><h2>${ic("chart-bar")} Live chart</h2></div>${tv ? `<div class="st-live">${tv}</div>` : '<p class="mut">The live chart is not available.</p>'}</div></div>` + foot(H);
    }
    if (!slugOk(slug)) return H.head("Index") + `<div class="card"><div class="st-msg"><p><b>This index could not be found.</b></p></div></div>`;
    ensureIdxH(slug, H);
    const row = S.idxBy && S.idxBy.get(slug), hs = S.idxH[slug] || { st: "loading" };
    if (S.idxBy && !row && hs.st !== "ok") return H.head("Index") + `<div class="card"><div class="st-msg"><p><b>This index is not in the data.</b></p></div></div>` + foot(H);
    const c = indexCtx(slug);
    if (!row && hs.st === "loading") return H.head(H.esc(c.name)) + `<div class="st-page">${skelCard(130)}${skelCard(260)}</div>` + foot(H);
    const cp = indexChartP(H, c, slug);
    mount();
    const rets = [7, 30, 91, 182, 365].map(dd => c.n ? retFrom(c.rows, dd) : null), pdate = c.row ? c.row[5] : c.last && c.last[0];
    return H.head(H.esc(c.name)) + stale() + `<div class="st-page st-split st-ix">${reg("ix-hero", () => indexHero(H, c))}${chartCard(H, "st-idx-" + slug, cp)}${reg("ix-det", () => indexDet(H, c))}${c.n ? perfStrip(H, rets, pdate) : ""}
      ${reg("ix-mov", () => indexMovers(H))}</div>` +
      foot(H, " Index history source: NSE index closing files. BSE Sensex is not included.");
  }

  // ---------- live patch (called by the shell when a snapshot changed or the status changed) ----------
  function livePatch(H) {
    HH = H;
    if (S.status !== "ok") return;
    const sub = H.sub, tab = H.tab;
    if (typeof sub === "string" && sub.startsWith("stock:")) {
      const sym = sub.slice(6), c = symOk(sym) && stockCtx(sym); if (!c) return;
      setReg("sp-hero", () => stockHero(H, c)); setReg("sp-det", () => stockDet(H, c)); setReg("sp-stats", () => stockStats(H, c));
      const cp = stockChartP(H, c); if (cp.st === "ok" && window.TrendyCharts) { ensureCfg("st-" + sym, cp); mount(); }
    } else if (typeof sub === "string" && sub.startsWith("idx:")) {
      const slug = sub.slice(4); if (slug === "sensex" || !slugOk(slug)) return;
      const c = indexCtx(slug); if (!c.row && c.hs.st !== "ok") return;
      setReg("ix-hero", () => indexHero(H, c)); setReg("ix-det", () => indexDet(H, c)); setReg("ix-mov", () => indexMovers(H));
      const cp = indexChartP(H, c, slug); if (cp.st === "ok" && window.TrendyCharts) { ensureCfg("st-idx-" + slug, cp); mount(); }
    } else if (tab === "movers") {
      const k = LISTS.some(l => l[0] === S.k) ? S.k : "gain";
      setReg("mv-bar", () => barHtml("Gainers, losers, most active and 52-week lists"), barSig); setReg("mv-list", () => moversCard(H, k));
    } else if (tab === "market" || !tab) {
      setReg("mk-bar", () => barHtml("Index values and movers"), barSig); setReg("mk-idx", () => idxCardsHtml(H)); setReg("mk-ad", () => adHtml(H)); setReg("mk-mov", () => marketMovers(H));
    }
  }

  // ---------- module ----------
  function setStars(sym, on) {
    document.querySelectorAll('.st-star[data-sym="' + (window.CSS && CSS.escape ? CSS.escape(sym) : sym) + '"]').forEach(b => {
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); b.setAttribute("aria-label", (on ? "Remove " : "Add ") + sym + (on ? " from watchlist" : " to watchlist"));
    });
  }
  function openStock(H, sym) {
    const r = recents(H).filter(s => s !== sym); r.unshift(sym); H.store.set("st_recent", r.slice(0, 8));
    S.view = "chart"; H.setSub("stock:" + sym);
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target || e.target.id !== "st-q") return;
    const b = document.querySelector("#app .st-r .st-rm"); if (b) b.click();
  });

  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.stocks = {
    id: "stocks", label: "Stocks", icon: "📈",
    tabs: [["market", "Market"], ["movers", "Movers"], ["watch", "Watchlist"], ["search", "Search"]],
    decode: decodeHist,
    livePatch,
    load(H) { HH = H; loadCore(H); },
    render(tab, sub, H) {
      HH = H;
      try {
        if (S.status !== "ok") return state(H);
        if (typeof sub === "string" && sub.startsWith("stock:")) return stockPage(sub.slice(6), H);
        if (typeof sub === "string" && sub.startsWith("idx:")) return indexPage(sub.slice(4), H);
        if (tab === "movers") return movers(H);
        if (tab === "watch") return watch(H);
        if (tab === "search") return search(H);
        return market(H);
      } catch (e) { console.error(e); return H.head("Stocks") + `<div class="card"><div class="st-msg"><p><b>This screen could not be shown.</b></p><button class="btn sm" data-m="stocks" data-act="retry">Try again</button></div></div>`; }
    },
    click(el, H) {
      HH = H;
      const a = el.dataset.act, sym = el.dataset.sym;
      if (a === "open" && symOk(sym)) { openStock(H, sym); return true; }
      if (a === "openidx" && (slugOk(el.dataset.slug))) { S.view = "chart"; H.setSub("idx:" + el.dataset.slug); return true; }
      if (a === "star" && symOk(sym)) {
        const w = watched(H), i = w.indexOf(sym);
        if (i >= 0) { w.splice(i, 1); H.store.set("st_watch", w); H.toast("Removed from watchlist"); setStars(sym, false); }
        else if (w.length >= 100) H.toast("Watchlist is full (100 stocks)");
        else { w.push(sym); H.store.set("st_watch", w); H.toast("Added to watchlist"); setStars(sym, true); }
        return true;
      }
      if (a === "unstar" && symOk(sym)) { H.store.set("st_watch", watched(H).filter(s => s !== sym)); H.render(); return true; }
      if (a === "list" && LISTS.some(l => l[0] === el.dataset.k)) { S.k = el.dataset.k; S.shown = 20; H.render(); return true; }
      if (a === "more") { S.shown = 100; H.render(); return true; }
      if (a === "seeall" && LISTS.some(l => l[0] === el.dataset.k)) { S.k = el.dataset.k; S.shown = 20; H.go("stocks", "movers"); return true; }
      if (a === "allidx") { S.allIdx = !S.allIdx; H.render(); return true; }
      if (a === "view") { S.view = el.dataset.v === "live" ? "live" : "chart"; H.render(); return true; }
      if (a === "gosearch") { H.go("stocks", "search"); return true; }
      if (a === "recentclear") { H.store.set("st_recent", []); H.render(); return true; }
      if (a === "retry") { S.idxLoadedKick = false; loadCore(H); return true; }
      if (a === "retrylist") { S.listStatus = "idle"; ensureList(H); H.render(); return true; }
      if (a === "retrychunk" && symOk(sym)) { S.chunkStatus[chunkKey(sym)] = "idle"; ensureChunk(sym, H); H.render(); return true; }
      if (a === "retryhist" && symOk(sym)) { delete S.hist[sym]; ensureHist(sym, H); H.render(); return true; }
      if (a === "retryidx" && slugOk(el.dataset.slug)) { delete S.idxH[el.dataset.slug]; ensureIdxH(el.dataset.slug, H); H.render(); return true; }
      return false;
    },
    input(el, H) { if (el.id === "st-q") { S.q = el.value.slice(0, 40); H.render(); } },
  };
})();
