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
  const DISC = "Prices are end-of-day (or delayed). Information only, not investment advice.";
  const LISTS = [["gain", "Gainers"], ["loss", "Losers"], ["active", "Most active"], ["deliv", "Delivery %"], ["hi", "52W high"], ["lo", "52W low"]];
  const NOTE = {
    gain: "Biggest one-day rise among stocks that traded at least ₹2 crore.",
    loss: "Biggest one-day fall among stocks that traded at least ₹2 crore.",
    active: "Highest traded value (price × quantity) of the day.",
    deliv: "Share of traded quantity taken for delivery (not squared off the same day), stocks with ₹2 crore+ traded.",
    hi: "Stocks closing within 3% of their 52-week high (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
    lo: "Stocks closing within 3% of their 52-week low (adjusted for splits and bonus), closest first, ₹2 crore+ traded.",
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
  const foot = (H, extra) => `<p class="mut sm st-foot">${H.esc(DISC)}${S.meta ? " Trade date: " + H.esc(H.fmtD(S.meta.tradeDate)) + ". Source: NSE India end-of-day files." : ""}${extra || ""}</p>`;
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
  const subValue = (r, l) => `Value ${croreC(r[4])}${l && isNum(l[5]) ? " · Vol " + units(l[5]) : ""}`;

  // ---------- chart card (shared by stock and index pages) ----------
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
      const last = p.rows[p.rows.length - 1], sig = [key, p.rows.length, last[0], last[4], p.prev, p.h52, p.l52, p.closeOnly ? 1 : 0].join("|");
      let c = S.cfg[key];
      if (!c || c.sig !== sig) {
        c = S.cfg[key] = { sig, data: p.rows, type: p.closeOnly ? "line" : S.ct.type, range: S.ct.range, ranges: ["1M", "3M", "6M", "1Y", "All"], volume: true,
          ma: { sma20: S.ct.sma20, sma50: S.ct.sma50 }, prevClose: isNum(p.prev) ? p.prev : undefined, high52: isNum(p.h52) ? p.h52 : undefined, low52: isNum(p.l52) ? p.l52 : undefined,
          currency: p.currency === "" ? "" : "₹", title: p.title, subtitle: p.sub, height: 300 };
      }
      TC.configure(key, c);
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
  const perfStrip = (H, vals) => `<div class="card st-perf-c"><h2>${ic("trending-up")} Performance</h2><div class="st-perf">${[["1W", 0], ["1M", 1], ["3M", 2], ["6M", 3], ["1Y", 4]].map(([l, i]) =>
    `<div class="st-pf ${dir(vals[i])}"><span>${l}</span><b>${isNum(vals[i]) ? pct(vals[i]) : "—"}</b></div>`).join("")}</div></div>`;
  function rangeBar(H, lo, hi, cur, loD, hiD, label) {
    if (!(isNum(lo) && isNum(hi) && hi > lo && isNum(cur))) return "";
    const pos = Math.max(0, Math.min(100, (cur - lo) / (hi - lo) * 100));
    return `<div class="st-52"><div class="st-52h"><b>52-week range</b><span class="mut">${nf(pos, 0)}% of the range</span></div>
      <div class="st-bar" role="img" aria-label="Price is ${Math.round(pos)} percent of the way from the 52-week low to the high"><i style="left:${pos.toFixed(1)}%"></i></div>
      <div class="st-52l"><span><b>${label ? label(lo) : rs(lo)}</b>${loD ? `<small class="mut"> ${H.esc(H.fmtD(loD))}</small>` : ""}</span><span class="st-rt"><b>${label ? label(hi) : rs(hi)}</b>${hiD ? `<small class="mut"> ${H.esc(H.fmtD(hiD))}</small>` : ""}</span></div></div>`;
  }

  // ---------- Market ----------
  function market(H) {
    const m = S.movers;
    ensureList(H);
    if (!S.idxLoadedKick) { S.idxLoadedKick = true; Promise.all(FEATURED.map(s => ensureIdxH(s, H, true))).then(() => H.render()); }
    let idx = "";
    const cards = FEATURED.map(s => S.idxBy && S.idxBy.get(s)).filter(Boolean).map(r => {
      const h = S.idxH[r[0]], vix = r[0] === "india-vix", closes = h && h.st === "ok" ? h.rows.slice(-30).map(x => x[4]) : null;
      return `<button class="st-ixc ${vix ? "flat" : dir(r[4])}" data-m="stocks" data-act="openidx" data-slug="${H.esc(r[0])}" aria-label="Open ${H.esc(r[1])}">
        <span class="st-ixn">${H.esc(r[1].replace(/^NIFTY/i, "Nifty"))}</span><b>${px(r[2])}</b><span class="st-ixv ${vix ? "" : cls(r[4])}">${arrow(r[4])} ${sgn(r[3])} · ${pct(r[4])}</span>
        ${closes ? spark(closes, 120, 34, vix) : '<span class="st-spph"></span>'}</button>`;
    }).join("");
    const sensex = `<button class="st-ixc flat st-live-t" data-m="stocks" data-act="openidx" data-slug="sensex"><span class="st-ixn">BSE Sensex</span><b>Live chart</b><span class="st-ixv mut">${ic("bolt")} TradingView only</span><span class="st-spph"></span></button>`;
    if (S.idxList && cards) {
      const all = S.idxList.rows, shown = S.allIdx ? all : all.slice(0, 0);
      idx = `<div class="card"><div class="st-ch-h"><h2>${ic("chart-bar")} Indices</h2><span class="mut sm">As on ${H.esc(H.fmtD(S.idxList.date))}</span></div>
        <div class="st-ixg">${cards}${sensex}</div>
        <button class="linkbtn st-lk" data-m="stocks" data-act="allidx" aria-expanded="${S.allIdx}">${S.allIdx ? "Hide all indices" : "Show all " + all.length + " indices"} ${ic(S.allIdx ? "minus" : "plus")}</button>
        ${S.allIdx ? `<div class="st-ixl">${shown.length ? "" : all.map(r => `<button class="st-ixr" data-m="stocks" data-act="openidx" data-slug="${H.esc(r[0])}"><span class="st-ixrn">${H.esc(r[1])}</span><b>${px(r[2])}</b>${pill(r[4])}</button>`).join("")}</div>` : ""}
        <p class="mut sm st-foot">Closing levels from NSE India. BSE Sensex end-of-day data is not available here; use its live chart.</p></div>`;
    } else if (S.idxList === null && S.status === "ok") idx = `<div class="card">${S.index && Array.isArray(S.index.rows) ? "<h2>Indices</h2>" + H.tbl(["Index", "Close", "Change %"], S.index.rows.slice(0, 12).map(r => [H.esc(r[0]), px(r[1]), `<span class="${cls(r[3])}">${pct(r[3])}</span>`])) : '<p class="mut">Index data is not available right now.</p>'}</div>`;
    const mini = (title, icon, rows, key, sub) => `<div class="card st-mini"><div class="st-ch-h"><h2>${ic(icon)} ${title}</h2><button class="linkbtn" data-m="stocks" data-act="seeall" data-k="${key}">See all ${ic("chevron-right")}</button></div>${rows.length ? `<div class="st-list">${moverRows(H, rows, 5, sub, true)}</div>` : '<p class="mut">—</p>'}</div>`;
    const dist = word => (r) => isNum(r[6]) ? nf(r[6], 1) + "% " + word : "—";
    return H.head("Stocks") + stale() +
      `<div class="st-grid">${idx}
      <div class="st-g3">${mini("Top gainers", "trending-up", m.gain, "gain", subValue)}${mini("Top losers", "trending-down", m.loss, "loss", subValue)}${mini("Most active", "flame", m.active, "active", subValue)}</div>
      <div class="st-g2">${mini("Near 52-week high", "trophy", m.hi, "hi", dist("below high"))}${mini("Near 52-week low", "target", m.lo, "lo", dist("above low"))}</div></div>` + foot(H);
  }

  // ---------- Movers ----------
  function movers(H) {
    ensureList(H);
    const m = S.movers, k = LISTS.some(l => l[0] === S.k) ? S.k : "gain", rows = Array.isArray(m[k]) ? m[k] : [];
    const sub = (r, l) => k === "deliv" ? `Delivery ${isNum(r[5]) ? nf(r[5], 1) + "%" : "—"} · ${subValue(r, l)}`
      : k === "hi" ? `${isNum(r[6]) ? nf(r[6], 1) + "% below 52W high" : "—"} · ${subValue(r, l)}`
      : k === "lo" ? `${isNum(r[6]) ? nf(r[6], 1) + "% above 52W low" : "—"} · ${subValue(r, l)}`
      : subValue(r, l);
    const sw = LISTS.map(([id, l]) => `<button class="${id === k ? "on" : ""}" data-m="stocks" data-act="list" data-k="${id}" aria-pressed="${id === k}">${l}</button>`).join("");
    const shown = Math.min(S.shown, rows.length);
    const body = rows.length ? `<div class="st-list">${moverRows(H, rows, shown, sub, true)}</div>${rows.length > shown ? `<button class="btn ghost st-more" data-m="stocks" data-act="more">Show more (${rows.length - shown} more)</button>` : ""}` : `<div class="st-msg"><p><b>No stocks in this list.</b></p><p class="mut sm">Nothing matched for the latest trade date.</p></div>`;
    return H.head("Stocks") + stale() + `<div class="st-sw" role="group" aria-label="List">${sw}</div>` +
      `<div class="card"><div class="st-ch-h"><h2>${H.esc(LISTS.find(l => l[0] === k)[1])}</h2><span class="mut sm">${rows.length} stocks</span></div><p class="mut sm st-note2">${H.esc(NOTE[k])}</p>${body}</div>` + foot(H);
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
  function stockPage(sym, H) {
    if (!symOk(sym)) return H.head("Stock") + `<div class="card"><div class="st-msg"><p><b>This stock could not be found.</b></p></div></div>`;
    ensureChunk(sym, H);
    const k = chunkKey(sym), ck = S.chunks[k];
    if (!ck) return H.head(H.esc(sym)) + (S.chunkStatus[k] === "fail" ? `<div class="card">${retryBox("The data for this stock could not be loaded.", "retrychunk", ` data-sym="${H.esc(sym)}"`)}</div>`
      : `<div class="st-page">${skelCard(150)}${skelCard(260)}</div>`) + foot(H);
    const d = ck.s[sym];
    if (!d) return H.head(H.esc(sym)) + `<div class="card"><div class="st-msg"><p><b>This symbol is not in the latest NSE data.</b></p><p class="mut sm">It may be suspended, delisted or renamed.</p></div></div>` + foot(H);
    ensureHist(sym, H);
    const [name, isin, ser, open, high, low, prev, close, vol, valL, trades, , dp, w52h, w52hd, w52l, w52ld, listed, fv, closes, stats] = d;
    const st = Array.isArray(stats) ? stats : [];
    const chg = isNum(close) && isNum(prev) ? close - prev : null, chgP = chg !== null && prev > 0 ? chg / prev * 100 : null;
    const on = watched(H).includes(sym), hs = S.hist[sym] || { st: "loading" };
    const tile = (l, v) => `<div class="bt"><span>${l}</span><b>${v}</b></div>`;
    const adj = hs.st === "ok" && hs.adj.length ? `<div class="st-chips st-adj">${hs.adj.slice(-3).map(a => `<span class="st-chip warn" title="Prices and volumes before this date are adjusted">${ic("scale")} Adjusted for split/bonus on ${H.esc(H.fmtD(a[0]))}</span>`).join("")}</div>` : "";
    const url = H.safeUrl("https://www.nseindia.com/get-quotes/equity?symbol=" + encodeURIComponent(sym));
    const hero = `<div class="card st-hero ${isNum(chg) ? (chg > 0 ? "t-up" : chg < 0 ? "t-dn" : "") : ""}">
      <div class="st-hh">${avatar(sym, true)}<div class="st-hid"><h2>${H.esc(name || sym)}</h2><div class="st-chips"><span class="st-chip">${H.esc(sym)}</span><span class="st-chip">NSE · ${H.esc(ser || "—")}</span>${isNum(st[7]) ? `<span class="st-chip">${ic("award")} #${nf(st[7], 0)} by turnover</span>` : ""}</div></div>${star(H, sym, on)}</div>
      <div class="st-hp"><b>${rs(close)}</b><span class="st-pill big ${dir(chg)}">${arrow(chg)} ${sgn(chg)} (${pct(chgP)})</span></div>
      <p class="mut sm">Close on ${H.esc(H.fmtD(ck.tradeDate))}. Change is against the previous close.</p>${adj}
      <div class="bento st-b4">${tile("Open", rs(open))}${tile("High", rs(high))}${tile("Low", rs(low))}${tile("Prev close", rs(prev))}
        ${tile("Volume", isNum(vol) ? nf(vol, 0) : "—")}${tile("Traded value", crore(valL))}${tile("Delivery %", isNum(dp) ? nf(dp, 2) + "%" : "—")}${tile("Trades", isNum(trades) ? nf(trades, 0) : "—")}</div>
      ${rangeBar(H, w52l, w52h, close, w52ld, w52hd) || (isNum(w52h) || isNum(w52l) ? `<div class="bento">${tile("52-week high", rs(w52h))}${tile("52-week low", rs(w52l))}</div>` : '<p class="mut sm">52-week range is not available for this stock.</p>')}</div>`;

    // chart data: full OHLCV when the h file exists, else the close history of the d file, else nothing
    let cp;
    const tv = window.TrendyCharts ? window.TrendyCharts.tvSymbol("stock", sym) : "";
    if (hs.st === "ok") cp = { st: "ok", rows: hs.rows, note: "Adjusted for splits and bonus issues." + (hs.adj.length ? "" : "") };
    else if (hs.st === "none" && Array.isArray(closes) && closes.length >= 5) {
      const ds = ck.d.slice(-closes.length), rows = [];
      closes.forEach((c, i) => { if (isNum(c) && c > 0 && ds[i]) rows.push([ds[i], null, null, null, c, null]); });
      cp = { st: rows.length >= 5 ? "ok" : "none", rows, closeOnly: true, note: "Closing prices only (open, high, low and volume are not kept for this stock)." };
    } else cp = { st: hs.st === "loading" ? "loading" : hs.st === "fail" ? "fail" : "none" };
    Object.assign(cp, { prev, h52: w52h, l52: w52l, title: sym, sub: "NSE · end of day", live: tv, liveTitle: "Live chart for " + sym, retry: { act: "retryhist", attrs: ` data-sym="${H.esc(sym)}"` } });
    mount();

    const avgV = st[6], dh = isNum(w52h) && isNum(close) && w52h > 0 ? (close / w52h - 1) * 100 : null, dl = isNum(w52l) && isNum(close) && w52l > 0 ? (close / w52l - 1) * 100 : null;
    const stats4 = `<div class="card"><h2>${ic("list-details")} Stats</h2><div class="bento st-b4">${tile("Avg volume (20D)", isNum(avgV) ? nf(avgV, 0) : "—")}${tile("52W high", rs(w52h) + (isNum(dh) ? `<em>${nf(Math.abs(dh), 1)}% ${dh < 0 ? "below" : "from"} high</em>` : ""))}
      ${tile("52W low", rs(w52l) + (isNum(dl) ? `<em>${nf(dl, 1)}% above low</em>` : ""))}${tile("Delivery %", isNum(dp) ? nf(dp, 2) + "%" : "—")}
      ${tile("ISIN", isin ? H.esc(isin) : "—")}${tile("Face value", isNum(fv) ? rs(fv) : "—")}${tile("Listed on", listed ? H.esc(H.fmtD(listed)) : "—")}${tile("Turnover rank", isNum(st[7]) ? "#" + nf(st[7], 0) : "—")}</div></div>`;
    return H.head(H.esc(sym)) + stale() +
      `<div class="st-page st-split">${hero}${chartCard(H, "st-" + sym, cp)}${perfStrip(H, st)}${stats4}
      <div class="card st-lnk"><p class="mut sm">Live quote, announcements and financials on the NSE website.</p>${url ? `<a class="btn ghost" href="${H.esc(url)}" target="_blank" rel="noopener noreferrer">${ic("external-link")} Open on NSE India</a>` : ""}</div></div>` +
      foot(H, " Prices adjusted for splits and bonus issues.");
  }

  // ---------- Index page ----------
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
    const name = (row && row[1]) || (hs.st === "ok" && hs.nm) || slug;
    if (!row && hs.st === "loading") return H.head(H.esc(name)) + `<div class="st-page">${skelCard(130)}${skelCard(260)}</div>` + foot(H);
    const rows = hs.st === "ok" ? hs.rows : [], n = rows.length, last = n ? rows[n - 1] : null, prevR = n > 1 ? rows[n - 2] : null;
    const close = row ? row[2] : last ? last[4] : null, pts = row ? row[3] : last && prevR ? last[4] - prevR[4] : null, chgP = row ? row[4] : last && prevR ? (last[4] / prevR[4] - 1) * 100 : null;
    const date = row ? row[5] : last && last[0];
    const lk = String(name).toLowerCase(), full = S.index && Array.isArray(S.index.rows) ? S.index.rows.find(r => String(r[0]).toLowerCase() === lk) : null;   // [name, close, points, chg, open, high, low, pe]
    const vix = slug === "india-vix";
    const tile = (l, v) => `<div class="bt"><span>${l}</span><b>${v}</b></div>`;
    let h52 = null, l52 = null, hd = null, ld = null;
    if (n) {
      const cut = Date.parse(last[0] + "T00:00:00Z") - 365 * 864e5;
      rows.forEach(r => { if (Date.parse(r[0] + "T00:00:00Z") >= cut) { if (h52 === null || r[2] > h52) { h52 = r[2]; hd = r[0]; } if (l52 === null || r[3] < l52) { l52 = r[3]; ld = r[0]; } } });
    }
    const hero = `<div class="card st-hero ${vix ? "" : dir(chgP) === "up" ? "t-up" : dir(chgP) === "dn" ? "t-dn" : ""}">
      <div class="st-hh">${avatar(name, true)}<div class="st-hid"><h2>${H.esc(name)}</h2><div class="st-chips"><span class="st-chip">NSE index</span>${date ? `<span class="st-chip">${ic("calendar")} ${H.esc(H.fmtD(date))}</span>` : ""}</div></div></div>
      <div class="st-hp"><b>${px(close)}</b><span class="st-pill big ${vix ? "flat" : dir(chgP)}">${arrow(chgP)} ${sgn(pts)} (${pct(chgP)})</span></div>
      <p class="mut sm">Closing level on ${date ? H.esc(H.fmtD(date)) : "—"}.</p>
      <div class="bento st-b4">${tile("Open", full ? px(full[4]) : last ? px(last[1]) : "—")}${tile("High", full ? px(full[5]) : last ? px(last[2]) : "—")}${tile("Low", full ? px(full[6]) : last ? px(last[3]) : "—")}${tile("P/E", full && isNum(full[7]) ? nf(full[7], 2) : "—")}</div>
      ${rangeBar(H, l52, h52, close, ld, hd, px) || ""}</div>`;
    const tvName = TV_IDX[slug], tv = tvName && window.TrendyCharts ? window.TrendyCharts.tvSymbol("index", tvName) : "";
    const cp = { st: hs.st === "ok" && n >= 2 ? "ok" : hs.st, rows, prev: prevR ? prevR[4] : null, h52, l52, title: name, sub: "NSE index · end of day", currency: "", live: tv, liveTitle: "Live chart for " + name,
      retry: { act: "retryidx", attrs: ` data-slug="${H.esc(slug)}"` }, note: hs.st === "ok" && !hs.hasVol ? "Index volume is not published by NSE for this index." : "" };
    mount();
    const rets = [7, 30, 91, 182, 365].map(dd => n ? retFrom(rows, dd) : null);
    const m = S.movers, mini = (title, icon, list, sub) => `<div class="card st-mini"><h2>${ic(icon)} ${title}</h2><div class="st-list">${moverRows(H, list, 5, sub, true)}</div></div>`;
    return H.head(H.esc(name)) + stale() + `<div class="st-page st-split st-ix">${hero}${chartCard(H, "st-idx-" + slug, cp)}${n ? perfStrip(H, rets) : ""}
      <p class="mut sm st-sechd">Across all NSE stocks today (not only this index)</p><div class="st-g2">${mini("Top gainers", "trending-up", m.gain, subValue)}${mini("Top losers", "trending-down", m.loss, subValue)}</div>
      <div class="st-g2">${mini("Near 52-week high", "trophy", m.hi, r => isNum(r[6]) ? nf(r[6], 1) + "% below high" : "—")}${mini("Near 52-week low", "target", m.lo, r => isNum(r[6]) ? nf(r[6], 1) + "% above low" : "—")}</div></div>` +
      foot(H, " Index history source: NSE index closing files. BSE Sensex is not included.");
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
