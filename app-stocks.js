// Stocks module (end-of-day NSE data). Written against docs/MODULES.md, docs/DESIGN.md and docs/CHARTS.md.
// Data (made by pipeline/stocks.mjs, see its header and data/stocks/h/README.txt):
//   meta.json, movers.json, index.json, list.json, d/<letter>.json (details + close history + stats),
//   h/<SYMBOL>.json (OHLCV of the 800 most traded stocks), idx/<slug>.json + idx/index.json (index OHLC history).
// Pages: tabs market / movers / watch / search; H.setSub keys "stock:<SYM>" and "idx:<slug>". Persistence keys: st_watch, st_recent.
(function () {
  const BASE = "data/stocks/";
  const S = { meta: null, movers: null, index: null, idxList: null, idxBy: null, list: null, listBy: null, lc: null, status: "idle", listStatus: "idle",
    chunks: {}, chunkStatus: {}, hist: {}, idxH: {}, cfg: {}, cv: null, ivLoad: "", ivSig: 0, ct: { range: "6M", type: "candles", sma20: false, sma50: false },
    k: "gain", shown: 50, q: "", caps: null, fii: null, dcap: { gain: "L", loss: "L", vol: "L" }, mcap: "A",
    mmode: null, mq: "", hideLow: false, arrive: false, cur: null, vc: null };
  let HH = null;                                         // host api (kept for async renders)
  const DISC = "Prices are end-of-day or a delayed snapshot, not real-time. Information only, not investment advice.";
  const LISTS = [["gain", "Gainers"], ["loss", "Losers"], ["active", "Most active"], ["vol", "By volume"], ["deliv", "Delivery %"], ["hi", "52W high"], ["lo", "52W low"]];
  const NOTE = {
    gain: "Biggest one-day rise among stocks that traded at least ₹2 crore.",
    loss: "Biggest one-day fall among stocks that traded at least ₹2 crore.",
    active: "Highest traded value (price × quantity) of the day.",
    vol: "Highest traded quantity (number of shares) of the day.",
    deliv: "Share of traded quantity taken for delivery (not squared off the same day), stocks with ₹2 crore+ traded.",
    hi: "Stocks closing within 3% of their 52-week high (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
    lo: "Stocks closing within 3% of their 52-week low (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
  };
  const NOTE_LIVE = {
    gain: "Biggest rise against the previous close so far, among the stocks in the live snapshot.",
    loss: "Biggest fall against the previous close so far, among the stocks in the live snapshot.",
    active: "Highest traded value (price × quantity) so far, among the stocks in the live snapshot.",
    vol: "Highest traded quantity (number of shares) so far, among the stocks in the live snapshot.",
    hi: "Stocks trading within 3% of their 52-week high as published by NSE, closest first, ₹2 crore+ traded.",
    lo: "Stocks trading within 3% of their 52-week low as published by NSE, closest first, ₹2 crore+ traded.",
  };
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
      const [caps, fii] = await Promise.all([getJson("caps.json", v).catch(() => null), getJson("fiidii.json", v).catch(() => null)]);
      if (caps && ["L", "M", "S"].every(k => Array.isArray(caps[k]) && caps[k].length > 20 && caps[k].every(symOk))) S.caps = { u: typeof caps.u === "string" ? caps.u : "", L: new Set(caps.L), M: new Set(caps.M), S: new Set(caps.S) };
      if (fii && Array.isArray(fii.rows)) { const rows = fii.rows.filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(r.d) && ["fb", "fs", "fn", "db", "ds", "dn"].every(k => isNum(r[k]))); if (rows.length) S.fii = { u: fii.u, rows }; }
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

  // one rich stock row (symbol, name, price, change pill, sub line, star)
  function stockRow(H, o) {
    const on = o.on === undefined ? watched(H).includes(o.sym) : o.on;
    const hs = o.q ? H.hl(o.sym, o.q) : H.esc(o.sym), hn = o.q ? H.hl(o.name || "", o.q) : H.esc(o.name || "");
    return `<div class="st-r"><button class="st-rm" data-m="stocks" data-act="open" data-sym="${H.esc(o.sym)}" aria-label="Open ${H.esc(o.sym)}">${avatar(o.sym)}
      <span class="st-id"><b>${hs}${o.tag && o.tag !== "EQ" ? ` <i class="st-tag">${H.esc(o.tag)}</i>` : ""}</b><small>${hn}</small></span>
      <span class="st-pv"><b>${px(o.price)}</b>${pill(o.chg)}</span>
      ${o.sub ? `<span class="st-sub">${o.sub}</span>` : ""}</button>${o.remove ? `<button class="st-x" data-m="stocks" data-act="unstar" data-sym="${H.esc(o.sym)}" aria-label="Remove ${H.esc(o.sym)} from watchlist">${ic("x")}</button>` : star(H, o.sym, on)}</div>`;
  }
  const moverRows = (H, rows, n, sub) => rows.slice(0, n).map(r => {
    const l = S.listBy && S.listBy.get(r[0]);
    return stockRow(H, { sym: r[0], name: r[1], price: r[2], chg: r[3], sub: sub ? sub(r, l) : "" });
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
  // ---------- intraday chart (our own snapshots, docs/LIVE.md; TradingView's free widgets do not serve NSE/BSE) ----------
  const IV_MIN = 3, IV_UP = "#10b981", IV_DN = "#f43f5e", IV_FLAT = "#6366f1";
  const IV_EMPTY = "Intraday data builds up during market hours; check back in a few minutes.";
  // sync: today's series of one stock symbol / index name from live.js (null when absent, < 2 points or not from the snapshot's day) -> {s, n, pc, ref, last, at, day, cur}
  function ivData(name, pc, cur) {
    const t = TL(), s = t && t.series ? t.series(name) : null; if (!s) return null;
    const ok = isNum(pc) && pc > 0;
    return { s, n: s.p.length, pc: ok ? pc : null, ref: ok ? pc : s.p[0], last: s.p[s.p.length - 1], at: s.t[s.t.length - 1].slice(11), day: s.day, cur };
  }
  function ensureIvCfg(H, key, title, d) {
    const TC = window.TrendyCharts, sig = [key, d.n, d.at, d.last, d.pc, d.day].join("|");
    let c = S.cfg[key];
    if (!c || c.sig !== sig) {
      const col = d.last > d.ref ? IV_UP : d.last < d.ref ? IV_DN : IV_FLAT, when = d.day !== H.istDay() ? H.fmtD(d.day) + " · " : "";
      c = S.cfg[key] = { sig, title, subtitle: "Intraday · " + when + d.n + " snapshots, about every 2 minutes · last " + d.at + " IST · NSE website data, delayed", height: window.innerWidth <= 640 ? 240 : 300,
        session: true, timeOnly: true, keepHover: true, baseline: d.pc === null ? undefined : d.pc, baselineLabel: "Prev close",
        series: [{ name: "Price", data: d.s.t.map((t, i) => [t, d.s.p[i]]), fill: true, color: col,
          readout: v => d.cur + px(v) + (d.pc ? " (" + pct((v / d.pc - 1) * 100) + " vs prev close)" : "") }] };
    }
    TC.configure(key, c); return c;
  }
  // first request of the intraday file for this page (live.js then keeps it fresh and notifies); one re-render when it arrives
  function ensureIv(H) {
    const t = TL(); if (!t || !t.intraday || S.ivLoad) return;
    S.ivLoad = "loading";
    t.intraday().then(() => {
      S.ivLoad = "done";
      const a = document.activeElement, sub = HH && HH.sub;
      if (a && a !== document.body && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest && a.closest("#app")) return;
      if (HH && typeof sub === "string" && (sub.startsWith("stock:") || sub.startsWith("idx:"))) HH.render();
    });
  }
  // the body under the Intraday view: a region, so a snapshot only swaps it when it flips between the message and the chart (the chart itself is updated in place)
  function ivBody(H, p) {
    const d = ivData(p.iv.name, p.iv.pc, p.iv.cur);
    if (!window.TrendyCharts) return '<p class="mut">The chart could not be loaded.</p>';
    if (!d || d.n < IV_MIN) return `<div class="st-msg"><p><b>${IV_EMPTY}</b></p><p class="mut sm">The Daily chart stays available.</p></div>`;
    ensureIvCfg(H, p.iv.key, p.iv.name, d);
    return `<div data-tc="line" data-tc-key="${H.esc(p.iv.key)}"></div>`;
  }
  const liveSt = () => { const t = TL(), s = t && t.status ? t.status().state : ""; return s === "live" || s === "stale"; };
  function chartCard(H, key, p) {
    // p: {st, rows, prev, h52, l52, title, sub, note, closeOnly, retry:{act,attrs}, iv:{name, pc, cur, key} | undefined}
    const TC = window.TrendyCharts, iv = p.iv && TC && TL() && liveOn() ? p.iv : null;
    let view = "daily";
    if (iv) {
      ensureIv(H);
      const d = ivData(iv.name, iv.pc, iv.cur);
      view = S.cv || (S.ivLoad === "loading" && liveSt() ? "wait" : d && d.n >= IV_MIN && liveSt() ? "intraday" : "daily");
    }
    S.ivSig = iv ? 1 : 0;
    const btn = (v, label) => `<button class="${view === v ? "on" : ""}" data-m="stocks" data-act="view" data-v="${v}" aria-pressed="${view === v}">${ic(v === "daily" ? "chart-line" : "bolt")} ${label}</button>`;
    const seg = iv ? `<div class="st-seg" role="group" aria-label="Chart view">${btn("daily", "Daily")}${btn("intraday", "Intraday")}</div>` : "";
    let body;
    if (view === "wait") body = '<div class="skel-block st-chsk"></div><div class="skel-line w60"></div>';
    else if (view === "intraday") body = `<div class="st-iv">${reg("iv-body", () => ivBody(H, p))}</div><p class="mut sm st-cn">Not a tick chart: points are our snapshots. The dashed line is the previous close.</p>`;
    else if (!TC) body = '<p class="mut">The chart could not be loaded.</p>';
    else if (p.st === "loading") body = '<div class="skel-block st-chsk"></div><div class="skel-line w60"></div>';
    else if (p.st === "fail") body = retryBox("The price history could not be loaded.", p.retry.act, p.retry.attrs);
    else if (p.st !== "ok" || !p.rows || p.rows.length < 2) body = `<div class="st-msg"><p><b>Price chart is not available for this stock yet.</b></p><p class="mut sm">End-of-day history is kept for the most traded stocks only.</p></div>`;
    else {
      ensureCfg(key, p);
      body = `<div data-tc="price" data-tc-key="${H.esc(key)}"></div><p class="mut sm st-cn">${p.note ? H.esc(p.note) + " " : ""}Drag or touch the chart for a crosshair. Ctrl + scroll zooms.</p>`;
    }
    return `<div class="card st-chart"><div class="st-ch-h"><h2>${ic("chart-bar")} ${view === "intraday" ? "Intraday chart" : "Price chart"}</h2>${seg}</div>${body}</div>`;
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
  const srcLabel = (H, L) => L ? `${snapTag(HH)} · ${L.n} stocks in the live snapshot that traded at least ₹${MINV} crore` : `End of day, ${H.esc(H.fmtD((S.movers && S.movers.tradeDate) || eodDay()))} · all NSE stocks that traded at least ₹${MINV} crore`;

  // ---------- caps + lists (dashboard and Movers) ----------
  // Every list uses one row shape: [0 symbol, 1 name, 2 price, 3 chg %, 4 traded value (Rs crore), 5 delivery % | null, 6 distance % | null, 7 volume, 8 chg in rupees, 9 series | null, 10 % below 52W high (live), 11 % above 52W low (live)]
  const CAPN = { L: "Large", M: "Mid", S: "Small", A: "All" };
  const CAPD = { L: "NIFTY 100", M: "NIFTY MIDCAP 150", S: "NIFTY SMALLCAP 250" };
  const CAPK = ["gain", "loss", "active", "vol"];
  const TITLES = { gain: "Top gainers", loss: "Top losers", active: "Most active (traded value)", vol: "Most traded by volume", deliv: "Delivery %", hi: "52-week high", lo: "52-week low" };
  const PAGE0 = 50, PAGE1 = 100, LOWTV = 0.1;                      // rows shown first / added per step; traded value (Rs crore) under which a stock is tagged "illiquid" (Rs 10 lakh)
  const MAINS = { EQ: 1, BE: 1, BZ: 1 };                           // main-board series of list.json (SME series SM / ST are not listed)
  const r2 = x => Math.round(x * 100) / 100;
  const shortName = n => String(n || "").replace(/\s+(limited|ltd\.?)$/i, "");
  const UC = { eodSrc: null, eod: null, liveSrc: null, liveNm: null, live: null, lists: { live: {}, eod: {} } };   // universes + sorted lists, rebuilt when their source changes
  function uniEod() {
    if (!S.list) return null;
    if (UC.eodSrc !== S.list) {
      UC.eodSrc = S.list; UC.lists.eod = {};
      UC.eod = S.list.rows.filter(r => MAINS[r[2]] && !/-(RE|Wd|Nd)$/.test(String(r[0])) && isNum(r[3]) && isNum(r[4])).map(r => [r[0], r[1], r[3], r[4], isNum(r[6]) ? r[6] : null, null, null, isNum(r[5]) ? r[5] : null, isNum(r[7]) ? r2(r[3] - r[7]) : null, r[2], null, null]);
    }
    return UC.eod;
  }
  function uniLive() {
    const m = snap(); if (!m) return null;
    if (UC.liveSrc !== m || UC.liveNm !== S.listBy) {
      const ci = {}; m.cols.forEach((c, i) => { ci[c] = i; });
      UC.liveSrc = m; UC.liveNm = S.listBy; UC.lists.live = {};
      UC.live = m.stocks.filter(r => isNum(r[ci.c]) && isNum(r[ci.p])).map(r => {
        const c = r[ci.c], l = S.listBy && S.listBy.get(r[ci.s]), wh = r[ci.wh], wl = r[ci.wl];
        return [r[ci.s], l ? l[1] : r[ci.s], c, r[ci.p], isNum(r[ci.tv]) ? r[ci.tv] : null, null, null, isNum(r[ci.v]) ? r[ci.v] : null, isNum(r[ci.ch]) ? r[ci.ch] : isNum(r[ci.pc]) ? r2(c - r[ci.pc]) : null, l ? l[2] : null,
          isNum(wh) && wh > 0 ? Math.max(0, (wh - c) / wh * 100) : null, isNum(wl) && wl > 0 ? Math.max(0, (c - wl) / wl * 100) : null];
      });
    }
    return UC.live;
  }
  // the full, sorted list of one kind: {rows, live, n (stocks in the universe)} | {pend:true} | {fail:true}. minTv (Rs crore) drops thinly traded stocks (0 = keep all). Cached per source.
  function listOf(kind, mode, cap, minTv) {
    const tvv = r => isNum(r[4]) ? r[4] : 0, tie = (x, y) => tvv(y) - tvv(x) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
    if (mode === "eod" && (kind === "hi" || kind === "lo" || kind === "deliv")) {           // end-of-day lists that need 52-week / delivery data: the pipeline's own top lists
      const rows = ((S.movers && S.movers[kind]) || []).map(r => { const l = S.listBy && S.listBy.get(r[0]); return [r[0], r[1], r[2], r[3], r[4], isNum(r[5]) ? r[5] : null, isNum(r[6]) ? r[6] : null, l && isNum(l[5]) ? l[5] : null, l && isNum(l[7]) ? r2(r[2] - l[7]) : null, l ? l[2] : null, null, null]; });
      return { rows, n: rows.length };
    }
    let base;
    if (mode === "live") { base = uniLive(); if (!base) return { rows: [], pend: true, live: true }; }
    else { if (S.listStatus === "fail") return { rows: [], fail: true }; base = uniEod(); if (!base) return { rows: [], pend: true }; }
    const set = cap !== "A" && S.caps ? S.caps[cap] : null;
    if (cap !== "A" && !set) return { rows: [], fail: true };
    const key = kind + "|" + cap + "|" + minTv, cache = UC.lists[mode];
    if (cache[key]) return cache[key];
    let a = base.filter(r => (!set || set.has(r[0])) && (!minTv || (isNum(r[4]) && r[4] >= minTv)));
    if (kind === "gain") a = a.filter(r => r[3] > 0).sort((x, y) => y[3] - x[3] || tie(x, y));
    else if (kind === "loss") a = a.filter(r => r[3] < 0).sort((x, y) => x[3] - y[3] || tie(x, y));
    else if (kind === "vol") a = a.filter(r => isNum(r[7])).sort((x, y) => y[7] - x[7] || tie(x, y));
    else if (kind === "active") a = a.filter(r => isNum(r[4])).sort(tie);
    else { const di = kind === "hi" ? 10 : 11; a = a.filter(r => isNum(r[di]) && r[di] <= 3 && isNum(r[4]) && r[4] >= MINV).map(r => { const c = r.slice(); c[6] = r[di]; return c; }).sort((x, y) => x[6] - y[6] || tie(x, y)); }
    return (cache[key] = { rows: a, live: mode === "live", n: base.length });
  }
  const dashMode = () => liveOn() ? "live" : "eod";

  // ---------- Market (dashboard: plain cards and lists, no charts) ----------
  const IDX_ORDER = ["nifty-50", "nifty-bank", "nifty-financial-services", "nifty-midcap-select", "india-vix", "nifty-it", "nifty-next-50", "nifty-500"];
  const IDX_SHORT = { "nifty-financial-services": "Fin Nifty", "nifty-midcap-select": "Midcap Select" };
  const idxName = r => IDX_SHORT[r[0]] || r[1].replace(/^NIFTY/i, "Nifty");
  const chgTxt = (chg, p) => `${isNum(chg) ? sgn(chg) + " " : ""}(${pct(p)})`;
  const idxCardsHtml = H => {
    const lv = liveOn();
    const cards = IDX_ORDER.map(s => S.idxBy && S.idxBy.get(s)).filter(Boolean).map(r => {
      const vix = r[0] === "india-vix", L = lix(r[1]), live = !!(L && isNum(L.last)), v = live ? L.last : r[2], pts = live ? L.chg : r[3], pc = live ? L.pct : r[4];
      return `<button class="st-ixc" data-m="stocks" data-act="openidx" data-slug="${H.esc(r[0])}" aria-label="Open ${H.esc(r[1])}">
        <span class="st-ixn">${H.esc(idxName(r))}${lv && !live ? ' <i class="st-tag">EOD</i>' : ""}</span><b>${px(v)}</b><span class="st-ixv ${vix ? "" : cls(pc)}">${chgTxt(pts, pc)}</span></button>`;
    }).join("");
    if (S.idxList && cards) {
      return `<div class="card st-dsec"><div class="st-ch-h"><h2>${ic("chart-bar")} Indices</h2><button class="linkbtn st-lk" data-m="stocks" data-act="allidx">All indices ${ic("chevron-right")}</button></div>
        <div class="st-hr">${cards}</div>
        <p class="mut sm st-foot">${lv ? snapTag(H) + ". An index missing from the snapshot shows its end-of-day level, marked EOD." : "Closing levels from NSE India, " + H.esc(H.fmtD(S.idxList.date)) + "."} BSE Sensex is not available.</p></div>`;
    }
    if (S.idxList === null && S.status === "ok") return `<div class="card">${S.index && Array.isArray(S.index.rows) ? "<h2>Indices</h2>" + H.tbl(["Index", "Close", "Change %"], S.index.rows.slice(0, 12).map(r => [H.esc(r[0]), px(r[1]), `<span class="${cls(r[3])}">${pct(r[3])}</span>`])) : '<p class="mut">Index data is not available right now.</p>'}</div>`;
    return "";
  };
  const fiiDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "UTC" }) : "—";
  const cr2 = x => isNum(x) ? (x > 0 ? "+" : x < 0 ? "-" : "") + "₹" + nf(Math.abs(x), 2) + " Cr" : "—";
  const fiiHtml = H => {
    const rows = S.fii && S.fii.rows; if (!rows || !rows.length) return "";
    return `<div class="card st-dsec"><div class="st-ch-h"><h2>${ic("building-bank")} Net FII &amp; DII</h2><button class="linkbtn st-lk" data-m="stocks" data-act="fiidii">View more ${ic("chevron-right")}</button></div>
      <div class="st-hr st-hr-fii">${rows.slice(0, 4).map(r => `<div class="st-fc"><span class="st-fd">${H.esc(fiiDate(r.d))}</span>
        <span class="st-fl">Net FII</span><b class="${cls(r.fn)}">${cr2(r.fn)}</b><span class="st-fl">Net DII</span><b class="${cls(r.dn)}">${cr2(r.dn)}</b></div>`).join("")}</div>
      <p class="mut sm st-foot">Cash market, provisional data published by NSE after market hours.</p></div>`;
  };
  const stockCard = (H, r, kind) => `<button class="st-scd" data-m="stocks" data-act="open" data-sym="${H.esc(r[0])}" aria-label="Open ${H.esc(r[0])}">${avatar(r[0])}
    <span class="st-scn">${H.esc(shortName(r[1]) || r[0])}</span><b>${rs(r[2])}</b><span class="st-scv ${cls(r[3])}">${isNum(r[8]) ? sgn(r[8]) + " " : ""}(${pct(r[3])})</span>${kind === "vol" ? `<small class="mut">Vol ${units(r[7])}</small>` : ""}</button>`;
  const skelRow = () => `<div class="st-hr" aria-hidden="true">${Array.from({ length: 5 }, () => '<div class="st-scd st-scsk"><div class="skel-block" style="height:38px;width:38px;border-radius:12px"></div><div class="skel-line w80"></div><div class="skel-line w50"></div></div>').join("")}</div>`;
  const capChips = (kind, cap) => `<div class="st-cp" role="group" aria-label="Market cap">${["L", "M", "S"].map(c => `<button class="${c === cap ? "on" : ""}" data-m="stocks" data-act="dcap" data-k="${kind}" data-c="${c}" aria-pressed="${c === cap}">${CAPN[c]}</button>`).join("")}</div>`;
  const DICON = { gain: "trending-up", loss: "trending-down", vol: "flame" };
  function dashSec(H, kind) {
    const cap = S.caps ? (S.dcap[kind] || "L") : "A", res = listOf(kind, dashMode(), cap, cap === "A" ? MINV : 0);
    const body = res.fail ? retryBox("This list could not be loaded.", "retrylist") : res.pend ? skelRow()
      : res.rows.length ? `<div class="st-hr">${res.rows.slice(0, 5).map(r => stockCard(H, r, kind)).join("")}</div>` : '<div class="st-msg"><p><b>No stocks in this list right now.</b></p></div>';
    return `<div class="card st-dsec"><div class="st-ch-h"><h2>${ic(DICON[kind])} ${TITLES[kind]}</h2><button class="linkbtn st-lk" data-m="stocks" data-act="seemore" data-k="${kind}" data-c="${cap}">See more ${ic("chevron-right")}</button></div>
      ${S.caps ? capChips(kind, cap) : ""}${body}</div>`;
  }
  function plainSec(H, kind) {
    const L = moverSrc(H), m = L || S.movers, rows = Array.isArray(m[kind]) ? m[kind] : [];
    const sub = r => isNum(r[6]) ? nf(r[6], 1) + "% " + (kind === "hi" ? "below high" : "above low") : "";
    return `<div class="card st-dsec"><div class="st-ch-h"><h2>${ic(kind === "hi" ? "trophy" : "target")} Near 52-week ${kind === "hi" ? "high" : "low"}</h2><button class="linkbtn st-lk" data-m="stocks" data-act="seemore" data-k="${kind}" data-c="A">See more ${ic("chevron-right")}</button></div>
      ${rows.length ? `<div class="st-list">${moverRows(H, rows, 5, sub)}</div>` : '<p class="mut">—</p>'}</div>`;
  }
  function market(H) {
    ensureList(H);
    return H.head("Stocks") + stale() + reg("mk-bar", () => barHtml("Index values and movers"), barSig) +
      `<div class="st-grid">${reg("mk-idx", () => idxCardsHtml(H))}${reg("mk-fii", () => fiiHtml(H))}${reg("mk-gain", () => dashSec(H, "gain"))}${reg("mk-loss", () => dashSec(H, "loss"))}${reg("mk-vol", () => dashSec(H, "vol"))}
      <div class="st-g2">${reg("mk-hi", () => plainSec(H, "hi"))}${reg("mk-lo", () => plainSec(H, "lo"))}</div></div>` +
      foot(H, S.caps ? ` Large, Mid and Small are the constituents of ${CAPD.L}, ${CAPD.M} and ${CAPD.S} (NSE, as of ${H.esc(H.fmtD(S.caps.u))}); stocks outside these three lists are not shown in these rows (see "See more" for all stocks).` : "");
  }

  // ---------- sub pages: all indices, FII / DII history ----------
  const allIdxCard = H => {
    const lv = liveOn(), all = S.idxList ? S.idxList.rows : [];
    if (!all.length) return `<div class="card"><p class="mut">Index data is not available right now.</p></div>`;
    const list = all.map(r => { const L = lix(r[1]), live = !!(L && isNum(L.last)); return `<button class="st-ixr" data-m="stocks" data-act="openidx" data-slug="${H.esc(r[0])}"><span class="st-ixrn">${H.esc(r[1])}${lv && !live ? ' <i class="st-tag">EOD</i>' : ""}</span><b>${px(live ? L.last : r[2])}</b>${pill(live ? L.pct : r[4])}</button>`; }).join("");
    return `<div class="card"><div class="st-ch-h"><h2>${ic("chart-bar")} All indices</h2><span class="mut sm">${all.length} indices · ${lv ? snapTag(H) : "End of day, " + H.esc(H.fmtD(S.idxList.date))}</span></div><div class="st-ixl">${list}</div></div>`;
  };
  function indicesPage(H) {
    return H.head("All indices") + stale() + reg("ix-bar", () => barHtml("Index values"), barSig) + reg("ix-all", () => allIdxCard(H)) +
      `<p class="mut sm st-foot">${lv0() ? "Levels from the live snapshot of NSE's public website data; an index missing from it shows its end-of-day level, marked EOD." : "Closing levels from NSE India."} BSE Sensex and Bankex are not available. ${H.esc(DISC)}</p>`;
  }
  const lv0 = () => liveOn();
  function fiiPage(H) {
    const rows = S.fii && S.fii.rows ? S.fii.rows.slice(0, 30) : [];
    const n = x => isNum(x) ? nf(x, 2) : "—", c = x => `<span class="${cls(x)}">${isNum(x) ? (x > 0 ? "+" : "") + nf(x, 2) : "—"}</span>`;
    const body = rows.length ? H.tbl(["Date", "FII buy", "FII sell", "FII net", "DII buy", "DII sell", "DII net"], rows.map(r => [H.esc(H.fmtD(r.d)), n(r.fb), n(r.fs), c(r.fn), n(r.db), n(r.ds), c(r.dn)]))
      : '<div class="st-msg"><p><b>No FII / DII data yet.</b></p></div>';
    return H.head("FII &amp; DII") + stale() + `<div class="card"><div class="st-ch-h"><h2>${ic("building-bank")} Net FII &amp; DII</h2><span class="mut sm">${rows.length} day${rows.length === 1 ? "" : "s"} · ₹ crore</span></div>${body}</div>
      <p class="mut sm st-foot">Provisional data published by NSE after market hours; cash market, ₹ crore. FII = foreign institutional / portfolio investors, DII = domestic institutional investors. Net = buy value minus sell value. The list grows by one day each trading day (NSE publishes only the latest day). ${H.esc(DISC)}</p>`;
  }

  // ---------- Movers ----------
  // Layout: list switch (Gainers, Losers ...) -> one card: title, search box (kept outside every region so typing never loses focus), [mv-ctl] mode + cap chips + toggle,
  // [mv-info] coverage line + count, [mv-list] best match + the first PAGE0 rows, more rows are appended to the DOM as the user scrolls (no full re-render).
  // A snapshot only patches the regions (see livePatch), the search text and the scroll position stay.
  const NOTE2 = { gain: "Every stock that rose, the biggest % rise first.", loss: "Every stock that fell, the biggest % fall first.", active: "Highest traded value (price × quantity) first.", vol: "Highest traded quantity (number of shares) first." };
  const effMode = k => k === "deliv" ? "eod" : S.mmode === "eod" ? "eod" : liveOn() ? "live" : "eod";
  const COVER = { "NIFTY 500": "Nifty 500", "SECURITIES IN F&O": "F&O", "NIFTY SMALLCAP 500": "Smallcap 500", "NIFTY IPO": "recent IPOs" };
  const coverTxt = m => {
    const c = m && m.meta && m.meta.cover, ls = c && Array.isArray(c.lists) ? c.lists.map(x => COVER[x] || String(x)) : ["Nifty 500", "F&O"];
    return ls.join(" + ") + (c && c.movers ? " + the market's top movers" : "");
  };
  const lc = x => String(x).toLowerCase();
  function bestMatch(uni, t) {                                   // an exact symbol, else the most traded stock whose name starts with the text
    let best = null;
    for (const r of uni) if (lc(r[0]) === t) return r;
    for (const r of uni) if (lc(r[1]).startsWith(t) && (!best || (isNum(r[4]) ? r[4] : 0) > (isNum(best[4]) ? best[4] : 0))) best = r;
    return best;
  }
  function mvView() {
    const k = LISTS.some(l => l[0] === S.k) ? S.k : "gain", mode = effMode(k), cap = S.caps && CAPK.includes(k) ? S.mcap : "A", minTv = CAPK.includes(k) && S.hideLow ? LOWTV : 0;
    const res = listOf(k, mode, cap, minTv), q = S.mq.trim(), t = lc(q);
    if (S.vc && S.vc.res === res && S.vc.t === t) return S.vc;
    let rows = res.rows, best = null, bestIn = true;
    if (t && !res.pend && !res.fail) {
      rows = res.rows.filter(r => lc(r[0]).includes(t) || lc(r[1]).includes(t));
      const uni = mode === "live" ? uniLive() : uniEod();
      best = uni ? bestMatch(uni, t) : null;
      if (best) { bestIn = res.rows.some(r => r[0] === best[0]); rows = rows.filter(r => r[0] !== best[0]); }
    }
    return (S.vc = { k, mode, cap, minTv, res, q, t, rows, best, bestIn });
  }
  const rsChg = x => isNum(x) ? (x > 0 ? "+" : x < 0 ? "-" : "") + "₹" + nf(Math.abs(x), 2) : "";
  function mvRow(H, r, k, q, wl) {
    const parts = [];
    if (k === "deliv") parts.push("Delivery " + (isNum(r[5]) ? nf(r[5], 1) + "%" : "—"));
    else if (k === "hi") parts.push(isNum(r[6]) ? nf(r[6], 1) + "% below 52W high" : "—");
    else if (k === "lo") parts.push(isNum(r[6]) ? nf(r[6], 1) + "% above 52W low" : "—");
    else if (isNum(r[8])) parts.push(`<b class="${cls(r[3])}">${rsChg(r[8])}</b>`);
    parts.push("Vol " + units(r[7])); parts.push("Value " + croreC(r[4]));
    const ill = isNum(r[4]) && r[4] < LOWTV ? ' <i class="st-tag st-ill" title="Less than ₹10 lakh traded: the % move can come from a few small trades">illiquid</i>' : "";
    return stockRow(H, { sym: r[0], name: r[1], price: r[2], chg: r[3], tag: r[9], q, on: wl.has(r[0]), sub: parts.join(" · ") + ill });
  }
  function mvRows(H, v, from, to) {
    const wl = new Set(watched(H)); let h = "";
    for (let i = from; i < to; i++) h += mvRow(H, v.rows[i], v.k, v.q, wl);
    return h;
  }
  const mvStamp = v => { const m = snap(); return (v.mode === "live" && m ? m.meta.fetchedAt : S.meta ? S.meta.generatedAt || S.meta.tradeDate : "") + "|" + (S.list ? 1 : 0); };
  const mvSig = v => [v.k, v.mode, v.cap, v.minTv, v.t, S.shown, v.rows.length, v.best ? v.best[0] : "", v.res.pend ? 1 : 0, v.res.fail ? 1 : 0, mvStamp(v)].join("|");
  const moreBtn = left => `<button class="btn ghost st-more" id="st-more" data-m="stocks" data-act="more">Show ${Math.min(PAGE1, left)} more <span class="mut">· ${nf(left, 0)} left</span></button><p class="mut sm st-auto">More rows also load by themselves as you scroll.</p>`;
  function mvListHtml(H, v) {
    if (v.res.fail) return retryBox("The stock list could not be loaded.", "retrylist");
    if (v.res.pend) return skelRows(6);
    S.cur = v;
    const n = Math.min(S.shown, v.rows.length);
    let h = "";
    if (v.best) h += `<div class="st-best"><p class="st-bl">${ic("target")} Best match${v.bestIn ? "" : " · not in this list right now"}</p>${mvRow(H, v.best, v.k, v.q, new Set(watched(H)))}</div>`;
    if (!v.rows.length && !v.best) return `<div class="st-msg"><p><b>${v.t ? "No stock matches “" + H.esc(v.q) + "” in this list." : "No stocks in this list."}</b></p><p class="mut sm">${v.t ? "Check the spelling, or look in all NSE stocks with the Search tab." : "Nothing matched for the latest " + (v.mode === "live" ? "snapshot" : "trade date") + "."}</p>${v.t ? `<button class="btn sm" data-m="stocks" data-act="gosearch">${ic("search")} Search all stocks</button>` : ""}</div>`;
    h += `<div class="st-list st-mvl">${mvRows(H, v, 0, n)}</div>`;
    return h + (v.rows.length > n ? moreBtn(v.rows.length - n) : "");
  }
  // appends the next rows to the list that is on screen (scroll near the end, or the button); the region signature is kept in step so a snapshot does not undo it
  function appendMore() {
    const v = S.cur, list = document.querySelector('#app [data-lvr="mv-list"] .st-mvl'), btn = document.getElementById("st-more");
    if (!v || !list || !btn || !HH || S.shown >= v.rows.length) return;
    const from = Math.min(S.shown, v.rows.length), to = Math.min(from + PAGE1, v.rows.length);
    list.insertAdjacentHTML("beforeend", mvRows(HH, v, from, to));
    S.shown = to;
    if (to >= v.rows.length) { const a = btn.nextElementSibling; if (a && a.classList.contains("st-auto")) a.remove(); btn.remove(); }
    else btn.innerHTML = `Show ${Math.min(PAGE1, v.rows.length - to)} more <span class="mut">· ${nf(v.rows.length - to, 0)} left</span>`;
    RG["mv-list"] = mvSig(v);
    autoMoreSoon();
  }
  let amT = 0;
  function autoMoreSoon() { if (amT) return; amT = setTimeout(() => { amT = 0; const b = document.getElementById("st-more"); if (b && b.getBoundingClientRect().top < (window.innerHeight || document.documentElement.clientHeight) + 900) appendMore(); }, 40); }
  window.addEventListener("scroll", () => { if (document.getElementById("st-more")) autoMoreSoon(); }, { passive: true });
  function mvCtl(H, v) {
    const liveOK = liveOn() && v.k !== "deliv", sb = (id, label, icon, off) => `<button class="${v.mode === id ? "on" : ""}" data-m="stocks" data-act="mmode" data-v="${id}" aria-pressed="${v.mode === id}"${off ? " disabled" : ""}>${ic(icon)} ${label}</button>`;
    const seg = `<div class="st-seg st-mode" role="group" aria-label="Data source">${sb("live", "Live", "bolt", !liveOK)}${sb("eod", "Last close", "clock", false)}</div>`;
    const hint = liveOK ? "" : `<p class="mut sm st-mh">${v.k === "deliv" ? "Delivery % exists only for the last close." : "The live snapshot is not available right now (market closed or data unavailable), so the last close is shown."}</p>`;
    const chips = S.caps && CAPK.includes(v.k) ? `<div class="st-cp st-cp-m" role="group" aria-label="Market cap">${["A", "L", "M", "S"].map(c => `<button class="${c === v.cap ? "on" : ""}" data-m="stocks" data-act="mcap" data-c="${c}" aria-pressed="${c === v.cap}">${CAPN[c]}</button>`).join("")}</div>` : "";
    const tg = CAPK.includes(v.k) ? `<button class="st-tg${S.hideLow ? " on" : ""}" data-m="stocks" data-act="hidelow" aria-pressed="${S.hideLow}">${ic(S.hideLow ? "check" : "plus")} Hide very low volume</button>` : "";
    return `<div class="st-mrow">${seg}${tg}</div>${hint}${chips}`;
  }
  const mvCtlSig = v => [v.mode, v.k, liveOn() ? 1 : 0, v.cap, S.hideLow ? 1 : 0, S.caps ? 1 : 0].join("|");
  function mvInfo(H, v) {
    const L = v.mode === "live" ? snap() : null, ls = S.list && uniEod();
    const cover = v.res.pend || v.res.fail ? "" : L ? `Live · ${nf(v.res.n, 0)} stocks: ${H.esc(coverTxt(L))} · ${snapTag(H)}`
      : `Last close · ${H.esc(H.fmtD((S.meta && S.meta.tradeDate) || eodDay()))} · ` + (v.k === "hi" || v.k === "lo" || v.k === "deliv" ? `the ${v.res.n} stocks of NSE with the most ₹2 crore+ turnover that match` : `all ${ls ? nf(ls.length, 0) : ""} NSE main-board stocks (EQ, BE and BZ series; SME stocks are not included)`);
    const total = v.rows.length + (v.best && v.bestIn ? 1 : 0), all = v.res.rows.length;
    const count = v.res.pend || v.res.fail ? "" : v.t ? `${nf(total, 0)} of ${nf(all, 0)}` : `${nf(all, 0)} stocks`;
    const note = NOTE2[v.k] || (L ? NOTE_LIVE[v.k] : null) || NOTE[v.k];
    const capNote = CAPK.includes(v.k) && S.caps && v.cap !== "A" ? ` ${CAPN[v.cap]} cap: constituents of ${CAPD[v.cap]} (NSE, as of ${H.esc(H.fmtD(S.caps.u))}).` : "";
    const ill = CAPK.includes(v.k) ? ` <i class="st-tag st-ill">illiquid</i> = under ₹10 lakh traded.` : "";
    return `<div class="st-ch-h st-mh2"><h2>${H.esc(TITLES[v.k])}</h2><span class="mut sm">${count}</span></div>${cover ? `<p class="tl-sec">${cover}</p>` : ""}<p class="mut sm st-note2">${H.esc(note)}${capNote}${ill}</p>`;
  }
  const mvBar = (H, v) => v.mode === "eod" && liveOn() ? eodPill("Last close, " + eodTxt()) : barHtml("Gainers, losers, most active and 52-week lists");
  const mvBarSig = v => barSig() + "|" + v.mode;
  function movers(H) {
    ensureList(H);
    const v = mvView(), k = v.k;
    const sw = LISTS.map(([id, l]) => `<button class="${id === k ? "on" : ""}" data-m="stocks" data-act="list" data-k="${id}" aria-pressed="${id === k}">${l}</button>`).join("");
    return H.head("Stocks") + stale() + reg("mv-bar", () => mvBar(H, v), () => mvBarSig(v)) + `<div class="st-sw" role="group" aria-label="List">${sw}</div>` +
      `<div class="card st-mvc"><label class="st-sin">${ic("search")}<input id="st-mq" type="search" data-m="stocks" placeholder="Search in this list: symbol or company" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search in this list" value="${H.esc(S.mq)}" maxlength="40"></label>` +
      reg("mv-ctl", () => mvCtl(H, v), () => mvCtlSig(v)) + reg("mv-info", () => mvInfo(H, v)) + reg("mv-list", () => mvListHtml(H, v), () => mvSig(v)) + `</div>` + foot(H);
  }
  // typing in the Movers search box: only the info and list regions change (focus, caret and scroll stay)
  function mvTyped(H) {
    S.shown = PAGE0; const v = mvView();
    setReg("mv-info", () => mvInfo(H, v)); setReg("mv-list", () => mvListHtml(H, v), () => mvSig(v));
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
      if (S.arrive && res.length) { S.arrive = false; setTimeout(() => HH && HH.flash && HH.flash(".st-sc .st-r"), 80); }
      body = res.length ? `<p class="mut sm st-cnt">${all.length} match${all.length === 1 ? "" : "es"}${all.length > 50 ? ", showing the first 50. Type more letters to narrow down." : ""}</p><div class="st-list">${res.map(([, r]) =>
        stockRow(H, { sym: r[0], name: r[1], price: r[3], chg: r[4], tag: r[2], q: S.q.trim(), sub: `Value ${croreC(r[6])} · Vol ${units(r[5])}` })).join("")}</div>`
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
        return r ? stockRow(H, { sym: r[0], name: r[1], price: r[3], chg: r[4], tag: r[2], sub: `Value ${croreC(r[6])} · Vol ${units(r[5])}`, remove: true })
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
    if (hs.st === "ok") cp = { st: "ok", rows: hs.rows, note: "Adjusted for splits and bonus issues." };
    else if (hs.st === "none" && Array.isArray(closes) && closes.length >= 5) {
      const ds = ck.d.slice(-closes.length), rows = [];
      closes.forEach((v, i) => { if (isNum(v) && v > 0 && ds[i]) rows.push([ds[i], null, null, null, v, null]); });
      cp = { st: rows.length >= 5 ? "ok" : "none", rows, closeOnly: true, note: "Closing prices only (open, high, low and volume are not kept for this stock)." };
    } else cp = { st: hs.st === "loading" ? "loading" : hs.st === "fail" ? "fail" : "none" };
    Object.assign(cp, { prev: c.prev, h52: c.w52h, l52: c.w52l, title: sym, sub: "NSE · end of day", retry: { act: "retryhist", attrs: ` data-sym="${H.esc(sym)}"` } });
    const q0 = lq(sym); if (q0 && isNum(q0.c)) cp.iv = { name: sym, pc: q0.pc, cur: "₹", key: "st-iv-" + sym };
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
    const cp = { st: hs.st === "ok" && c.n >= 2 ? "ok" : hs.st, rows, prev: prevR ? prevR[4] : null, h52: c.h52, l52: c.l52, title: name, sub: "NSE index · end of day", currency: "",
      retry: { act: "retryidx", attrs: ` data-slug="${H.esc(slug)}"` }, note: hs.st === "ok" && !hs.hasVol ? "Index volume is not published by NSE for this index." : "" };
    const L0 = lix(name); if (L0 && isNum(L0.last)) cp.iv = { name: L0.name, pc: L0.pc, cur: "", key: "st-iv-idx-" + slug };
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
  // intraday chart on the open page: the Daily/Intraday control appears or disappears with the snapshot (one re-render); otherwise only the region body is
  // re-evaluated (identical HTML = untouched DOM) and the chart is updated in place through configure() + auto()
  function ivPatch(H, cp) {
    const want = cp.iv && window.TrendyCharts && liveOn() ? 1 : 0;
    if (want !== S.ivSig) {
      const a = document.activeElement;
      if (!(a && a !== document.body && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.closest && a.closest("#app"))) H.render();
      return;
    }
    if (want && document.querySelector('#app [data-lvr="iv-body"]')) { setReg("iv-body", () => ivBody(H, cp)); mount(); }
  }
  function livePatch(H) {
    HH = H;
    if (S.status !== "ok") return;
    const sub = H.sub, tab = H.tab;
    if (typeof sub === "string" && sub.startsWith("stock:")) {
      const sym = sub.slice(6), c = symOk(sym) && stockCtx(sym); if (!c) return;
      setReg("sp-hero", () => stockHero(H, c)); setReg("sp-det", () => stockDet(H, c)); setReg("sp-stats", () => stockStats(H, c));
      const cp = stockChartP(H, c); if (cp.st === "ok" && window.TrendyCharts) { ensureCfg("st-" + sym, cp); mount(); }
      ivPatch(H, cp);
    } else if (typeof sub === "string" && sub.startsWith("idx:")) {
      const slug = sub.slice(4); if (!slugOk(slug)) return;
      const c = indexCtx(slug); if (!c.row && c.hs.st !== "ok") return;
      setReg("ix-hero", () => indexHero(H, c)); setReg("ix-det", () => indexDet(H, c)); setReg("ix-mov", () => indexMovers(H));
      const cp = indexChartP(H, c, slug); if (cp.st === "ok" && window.TrendyCharts) { ensureCfg("st-idx-" + slug, cp); mount(); }
      ivPatch(H, cp);
    } else if (sub === "indices") {
      setReg("ix-bar", () => barHtml("Index values"), barSig); setReg("ix-all", () => allIdxCard(H));
    } else if (tab === "movers") {
      const y = window.scrollY, v = mvView();
      setReg("mv-bar", () => mvBar(H, v), () => mvBarSig(v)); setReg("mv-ctl", () => mvCtl(H, v), () => mvCtlSig(v)); setReg("mv-info", () => mvInfo(H, v)); setReg("mv-list", () => mvListHtml(H, v), () => mvSig(v));
      if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);                 // a swapped list keeps the reader's place
    } else if (tab === "market" || !tab) {
      setReg("mk-bar", () => barHtml("Index values and movers"), barSig); setReg("mk-idx", () => idxCardsHtml(H));
      ["gain", "loss", "vol"].forEach(k => setReg("mk-" + k, () => dashSec(H, k))); ["hi", "lo"].forEach(k => setReg("mk-" + k, () => plainSec(H, k)));
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
    S.cv = null; H.setSub("stock:" + sym);
  }
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter" || !e.target || (e.target.id !== "st-q" && e.target.id !== "st-mq")) return;
    const b = document.querySelector("#app .st-best .st-rm") || document.querySelector("#app .st-r .st-rm"); if (b) b.click();
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
        if (sub === "indices") return indicesPage(H);
        if (sub === "fiidii") return fiiPage(H);
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
      if (a === "openidx" && (slugOk(el.dataset.slug))) { S.cv = null; H.setSub("idx:" + el.dataset.slug); return true; }
      if (a === "star" && symOk(sym)) {
        const w = watched(H), i = w.indexOf(sym);
        if (i >= 0) { w.splice(i, 1); H.store.set("st_watch", w); H.toast("Removed from watchlist"); setStars(sym, false); }
        else if (w.length >= 100) H.toast("Watchlist is full (100 stocks)");
        else { w.push(sym); H.store.set("st_watch", w); H.toast("Added to watchlist"); setStars(sym, true); }
        return true;
      }
      if (a === "unstar" && symOk(sym)) { H.store.set("st_watch", watched(H).filter(s => s !== sym)); H.render(); return true; }
      if (a === "list" && LISTS.some(l => l[0] === el.dataset.k)) { S.k = el.dataset.k; S.shown = PAGE0; H.render(); return true; }
      if (a === "more") { appendMore(); return true; }
      if (a === "mmode" && (el.dataset.v === "live" || el.dataset.v === "eod")) { S.mmode = el.dataset.v; S.shown = PAGE0; H.render(); return true; }
      if (a === "hidelow") { S.hideLow = !S.hideLow; S.shown = PAGE0; H.render(); return true; }
      if (a === "seeall" && LISTS.some(l => l[0] === el.dataset.k)) { S.k = el.dataset.k; S.shown = PAGE0; S.mq = ""; S.mmode = null; H.go("stocks", "movers"); return true; }
      if (a === "allidx") { H.setSub("indices"); return true; }
      if (a === "fiidii") { H.setSub("fiidii"); return true; }
      if (a === "dcap" && ["gain", "loss", "vol"].includes(el.dataset.k) && ["L", "M", "S"].includes(el.dataset.c)) { const k = el.dataset.k; S.dcap[k] = el.dataset.c; setReg("mk-" + k, () => dashSec(H, k)); return true; }
      if (a === "mcap" && ["A", "L", "M", "S"].includes(el.dataset.c)) { S.mcap = el.dataset.c; S.shown = PAGE0; H.render(); return true; }
      if (a === "seemore" && LISTS.some(l => l[0] === el.dataset.k)) { S.k = el.dataset.k; S.shown = PAGE0; S.mq = ""; S.mmode = null; if (CAPK.includes(S.k)) S.mcap = ["L", "M", "S"].includes(el.dataset.c) ? el.dataset.c : "A"; H.go("stocks", "movers"); return true; }
      if (a === "view") { S.cv = el.dataset.v === "intraday" ? "intraday" : "daily"; H.render(); return true; }
      if (a === "gosearch") { H.go("stocks", "search"); return true; }
      if (a === "recentclear") { H.store.set("st_recent", []); H.render(); return true; }
      if (a === "retry") { loadCore(H); return true; }
      if (a === "retrylist") { S.listStatus = "idle"; ensureList(H); H.render(); return true; }
      if (a === "retrychunk" && symOk(sym)) { S.chunkStatus[chunkKey(sym)] = "idle"; ensureChunk(sym, H); H.render(); return true; }
      if (a === "retryhist" && symOk(sym)) { delete S.hist[sym]; ensureHist(sym, H); H.render(); return true; }
      if (a === "retryidx" && slugOk(el.dataset.slug)) { delete S.idxH[el.dataset.slug]; ensureIdxH(el.dataset.slug, H); H.render(); return true; }
      return false;
    },
    input(el, H) {
      HH = H;
      if (el.dataset.arrive === "1") { S.arrive = true; delete el.dataset.arrive; }           // filled in from the global search ("See all in Stocks")
      if (el.id === "st-q") { S.q = el.value.slice(0, 40); H.render(); }
      else if (el.id === "st-mq") { S.mq = el.value.slice(0, 40); mvTyped(H); }
    },
  };
})();
