// Mutual Fund module (Funds / Compare / SIP / Watchlist). See docs/MODULES.md, docs/DESIGN.md, docs/CHARTS.md.
// Data: data/mf/*.json from pipeline/mf.mjs (AMFI). Per-fund NAV history: https://api.mfapi.in/mf/<code> (community mirror of AMFI), fetched in the browser.
(function () {
  "use strict";
  const DISC = "Mutual fund investments are subject to market risks. Information only, not investment advice.";
  const PAGE = 40, MAXCMP = 3;
  const CHIPS = [["all", "All"], ["large", "Large Cap"], ["mid", "Mid Cap"], ["small", "Small Cap"], ["flexi", "Flexi Cap"], ["multi", "Multi Cap"], ["elss", "ELSS"], ["eqother", "Other Equity"], ["index", "Index"], ["debt", "Debt"], ["hybrid", "Hybrid"], ["other", "Other"]];
  const SORTS = [["r3", "3Y return"], ["r1", "1Y return"], ["r5", "5Y return"], ["name", "Name (A-Z)"]];
  const PL = { r1: "1Y", r3: "3Y", r5: "5Y", r6: "6M" };
  const FR = ["1M", "6M", "1Y", "3Y", "5Y", "All"], CR = ["6M", "1Y", "3Y", "5Y"];
  const UP = "#10b981", DN = "#f43f5e", PAL = ["#6366f1", "#f59e0b", "#10b981"];
  const M = {
    data: null, status: "idle",              // idle | load | ok | err
    q: "", cq: "", n: PAGE, store: null, H: null,
    watch: [], cmp: [], f: { plan: 0, cat: "all", sort: "r3" },
    sip: { mode: "sip", amt: "10000", rate: "12", yrs: "10", step: "0", lamt: "100000", lrate: "12", lyrs: "10", from: null },
  };
  const HS = {};                       // mfapi history cache: code -> {st:"load"|"ok"|"err", pts:[[iso, nav]...]}
  const CH = { range: "1Y", mode: "nav", crange: "1Y" };
  const peersMemo = new Map();
  let tq = null;

  const num = v => typeof v === "number" && isFinite(v);
  const pct = v => num(v) ? (v > 0 ? "+" : "") + v.toFixed(2) + "%" : "—";
  const rc = v => num(v) ? (v > 0 ? "grn-t" : v < 0 ? "red-t" : "") : "mut";
  const fmtNav = n => num(n) ? n.toFixed(4).replace(/0{1,2}$/, "") : "—";
  const rs = n => num(n) ? "₹" + Math.round(n).toLocaleString("en-IN") : "—";
  const rs2 = n => num(n) ? "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const short = n => !num(n) ? "—" : Math.abs(n) >= 1e7 ? "₹" + +(n / 1e7).toFixed(2) + " Cr" : Math.abs(n) >= 1e5 ? "₹" + +(n / 1e5).toFixed(2) + " L" : "₹" + Math.round(n).toLocaleString("en-IN");
  const shortAx = n => !num(n) ? "—" : Math.abs(n) >= 1e7 ? "₹" + +(n / 1e7).toFixed(1) + "Cr" : Math.abs(n) >= 1e5 ? "₹" + +(n / 1e5).toFixed(1) + "L" : Math.abs(n) >= 1e3 ? "₹" + +(n / 1e3).toFixed(1) + "K" : "₹" + Math.round(n);
  const ic = n => '<svg class="ic" aria-hidden="true"><use href="#ti-' + n + '"/></svg>';
  const planName = p => p ? "Regular" : "Direct";
  const isWatch = c => M.watch.includes(c), isCmp = c => M.cmp.includes(c);
  const TC = () => window.TrendyCharts;

  // ---------- data ----------
  function init(H) {
    if (M.store) return;
    M.store = H.store;
    const arr = k => { const a = H.store.get(k, []); return Array.isArray(a) ? a.filter(x => Number.isInteger(x)) : []; };
    M.watch = arr("mf_watch"); M.cmp = arr("mf_cmp").slice(0, MAXCMP);
    const f = H.store.get("mf_f", null);
    if (f && typeof f === "object") {
      if (f.plan === 0 || f.plan === 1) M.f.plan = f.plan;
      if (CHIPS.some(c => c[0] === f.cat)) M.f.cat = f.cat;
      if (SORTS.some(s => s[0] === f.sort)) M.f.sort = f.sort;
    }
    const s = H.store.get("mf_sip", null);
    if (s && typeof s === "object") {
      for (const k of ["amt", "rate", "yrs", "step", "lamt", "lrate", "lyrs"]) if (typeof s[k] === "string" && s[k].length < 14) M.sip[k] = s[k];
      if (s.mode === "sip" || s.mode === "lump") M.sip.mode = s.mode;
      if (s.from && typeof s.from === "object" && Number.isInteger(s.from.code) && typeof s.from.name === "string" && typeof s.from.label === "string" && num(s.from.rate)) M.sip.from = { code: s.from.code, name: s.from.name.slice(0, 120), label: s.from.label.slice(0, 4), rate: s.from.rate };
    }
  }
  const saveF = () => M.store.set("mf_f", M.f);
  const saveSip = () => M.store.set("mf_sip", M.sip);

  async function loadData(H) {
    if (M.status === "load") return;
    M.status = "load"; H.render();
    try {
      const j = async u => { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };
      const idx = await j("data/mf/index.json");
      if (!idx || !idx.meta || !Array.isArray(idx.files) || !Array.isArray(idx.amcs) || !Array.isArray(idx.cats)) throw new Error("bad index");
      const parts = await Promise.all(idx.files.filter(f => /^rows-[a-z]+\.json$/.test(f)).map(f => j("data/mf/" + f)));
      const rows = [], by = new Map();
      for (const p of parts) for (const r of (p && p.rows) || []) {
        if (!Array.isArray(r) || !Number.isInteger(r[0]) || typeof r[1] !== "string") continue;
        const c = idx.cats[r[4]] || ["Other", "other"];
        const o = { c: r[0], n: r[1], amc: idx.amcs[r[2]] || "", p: r[3] === 1 ? 1 : 0, cat: c[0], key: c[1], nav: num(r[5]) ? r[5] : null, d: r[6], r6: num(r[7]) ? r[7] : null, r1: num(r[8]) ? r[8] : null, r3: num(r[9]) ? r[9] : null, r5: num(r[10]) ? r[10] : null };
        o.s = (o.n + " " + o.amc).toLowerCase();
        rows.push(o); by.set(o.c, o);
      }
      if (!rows.length) throw new Error("no rows");
      M.data = { meta: idx.meta, rows, by }; M.status = "ok"; peersMemo.clear();
    } catch (e) { console.warn("mf load failed", e); M.status = "err"; }
    H.render();
  }

  // ---------- mfapi NAV history ----------
  const MS = iso => Date.parse(iso + "T00:00:00Z");
  function cleanSeries(j) {
    const m = new Map();
    for (const x of ((j && j.data) || [])) {
      const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(x && x.date || ""), v = parseFloat(x && x.nav);
      if (d && isFinite(v) && v > 0) m.set(d[3] + "-" + d[2] + "-" + d[1], v);
    }
    return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  }
  function ensureHist(code, H, force) {
    const cur = HS[code];
    if (cur && !force) return cur;
    if (cur && cur.st === "load") return cur;
    const h = HS[code] = { st: "load", pts: null };
    fetch("https://api.mfapi.in/mf/" + code + "?src=trendy", {   // the bare /mf/<code> URL comes back from mfapi's cache without CORS headers (the browser then blocks it); with a query string it is sent with them
      signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined })
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(j => { const pts = cleanSeries(j); if (pts.length < 2) throw new Error("no history"); h.pts = pts; h.st = "ok"; })
      .catch(e => { console.warn("mf history failed", code, e); h.st = "err"; })
      .then(() => { const sub = H.sub; if (sub === "fund:" + code || (!sub && H.state && H.state.tab === "mf:compare" && M.cmp.includes(code))) H.render(); });
    return h;
  }
  function rangeStart(lastIso, r) {
    if (r === "All") return null;
    const d = new Date(MS(lastIso)), mo = { "1M": 1, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60 }[r] || 12;
    d.setUTCMonth(d.getUTCMonth() - mo); return d.toISOString().slice(0, 10);
  }
  const covers = (pts, r) => r === "All" || pts[0][0] <= new Date(MS(rangeStart(pts[pts.length - 1][0], r)) + 7 * 864e5).toISOString().slice(0, 10);
  const sliceRange = (pts, r) => { const s = rangeStart(pts[pts.length - 1][0], r); const a = s ? pts.filter(p => p[0] >= s) : pts; return a.length >= 2 ? a : pts.slice(-2); };
  const atOrBefore = (pts, iso) => { let lo = 0, hi = pts.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] <= iso) { r = m; lo = m + 1; } else hi = m - 1; } return r < 0 ? null : pts[r]; };

  // ---------- category stats (from the loaded rows only) ----------
  function peers(f) {
    const k = f.p + "|" + f.cat;
    let a = peersMemo.get(k);
    if (!a) { a = M.data.rows.filter(x => x.p === f.p && x.cat === f.cat); peersMemo.set(k, a); }
    return a;
  }
  function catStats(f) {
    const ps = peers(f), out = { n: ps.length, avg: {}, cnt: {}, rank: {} };
    for (const k of ["r6", "r1", "r3", "r5"]) {
      const v = ps.map(x => x[k]).filter(num);
      out.cnt[k] = v.length; out.avg[k] = v.length >= 5 ? v.reduce((s, x) => s + x, 0) / v.length : null;
      if (k !== "r6" && v.length >= 10 && num(f[k])) { // rank 1 = best. top = smallest X so that the fund is within the top X% (rank / N); bottom = smallest Y so that it is within the bottom Y% (funds at or below it / N)
        const rank = 1 + v.filter(x => x > f[k]).length, below = v.filter(x => x <= f[k]).length;
        out.rank[k] = { rank, n: v.length, top: Math.max(1, Math.ceil(rank / v.length * 100)), bottom: Math.max(1, Math.ceil(below / v.length * 100)), below }; }
    }
    return out;
  }

  // ---------- small pieces ----------
  const navDate = H => M.data && M.data.meta && M.data.meta.navDate ? H.fmtD(M.data.meta.navDate) : "";
  function foot(H, extra) {
    const d = navDate(H);
    return '<div class="mf-foot"><p class="mf-disc">' + H.esc(DISC) + '</p><p class="mut sm mf-src">Source: AMFI' + (d ? ", NAV as on " + H.esc(d) : "") + ". Returns are computed from AMFI NAVs (6M and 1Y absolute, 3Y and 5Y annualised). Past performance does not indicate future returns." + (extra || "") + "</p></div>";
  }
  const wrap = h => '<div class="mf-wrap">' + h + "</div>";
  function skelRows(n) { let s = ""; for (let i = 0; i < n; i++) s += '<div class="skel-row mf-skel"></div>'; return s; }
  function noData(H) {
    if (M.status === "load" || M.status === "idle") return '<div class="skel">' + skelRows(5) + "</div>";
    return '<div class="card mf-err"><b>Fund data could not be loaded right now.</b><p class="mut">Check your connection and try again.</p><button class="btn" data-m="mf" data-act="retry">' + ic("refresh") + " Try again</button></div>";
  }
  const retsBar = (v, cap) => '<i class="mf-rb"><u class="' + (num(v) && v < 0 ? "neg" : "pos") + '" style="width:' + (num(v) ? Math.max(3, Math.min(100, Math.abs(v) / cap * 100)).toFixed(0) : 0) + '%"></u></i>';
  function p90(list, k) { const v = list.map(f => f[k]).filter(num).map(Math.abs).sort((a, b) => a - b); return v.length ? Math.max(5, v[Math.floor(v.length * 0.9)]) : 10; }

  const qToks = q => String(q || "").toLowerCase().split(/\s+/).filter(Boolean);       // the search matches every word, so every word is marked
  function row(f, H, mode, caps, hq) {
    const star = isWatch(f.c), cm = isCmp(f.c), hh = (t) => hq && hq.length && H.hl ? H.hl(t, hq) : H.esc(t);
    caps = caps || { r1: 30, r3: 30, r5: 30 };
    return '<div class="mf-row"><button class="mf-main" data-m="mf" data-act="open" data-c="' + f.c + '" aria-label="Open ' + H.esc(f.n) + '">' +
      '<b class="mf-nm">' + hh(f.n) + "</b>" +
      '<span class="mf-sub">' + hh(f.amc) + '</span><span class="mf-tags"><span class="mf-cat">' + hh(f.cat) + '</span><span class="mf-plan">' + planName(f.p) + "</span></span>" +
      '<span class="mf-nav">NAV <b>₹' + fmtNav(f.nav) + "</b> · " + H.esc(H.fmtD(f.d)) + "</span>" +
      '<span class="mf-rets">' + [["1Y", "r1"], ["3Y", "r3"], ["5Y", "r5"]].map(([l, k]) => '<span class="mf-r"><em>' + l + '</em><b class="' + rc(f[k]) + '">' + pct(f[k]) + "</b>" + retsBar(f[k], caps[k]) + "</span>").join("") + "</span></button>" +
      '<div class="mf-acts"><button class="mf-ib mf-star' + (star ? " on" : "") + '" data-m="mf" data-act="star" data-c="' + f.c + '" aria-pressed="' + star + '" aria-label="' + (star ? "Remove from watchlist" : "Add to watchlist") + '" title="Watchlist">' + ic("star") + "</button>" +
      '<button class="mf-ib mf-cb' + (cm ? " on" : "") + '" data-m="mf" data-act="cmp" data-c="' + f.c + '" aria-pressed="' + cm + '" aria-label="' + (cm ? "Remove from compare" : "Add to compare") + '" title="Compare">' + ic(cm ? "check" : "arrows-exchange") + "</button></div>" +
      (mode === "watch" ? '<button class="mf-rm" data-m="mf" data-act="star" data-c="' + f.c + '">' + ic("x") + " Remove from watchlist</button>" : "") + "</div>";
  }

  // ---------- Funds tab ----------
  function filtered() {
    const toks = M.q.toLowerCase().split(/\s+/).filter(Boolean), k = M.f.sort;
    let a = M.data.rows.filter(f => f.p === M.f.plan && (M.f.cat === "all" || f.key === M.f.cat) && toks.every(t => f.s.includes(t))), hidden = 0;
    if (k === "name") a.sort((x, y) => x.n.localeCompare(y.n));
    else { const w = a.filter(f => num(f[k])); hidden = a.length - w.length; a = w.sort((x, y) => y[k] - x[k] || x.n.localeCompare(y.n)); }
    return { list: a, hidden };
  }
  function funds(H) {
    let h = H.head("Mutual Fund");
    if (!M.data) return wrap(h + noData(H) + foot(H));
    const { list, hidden } = filtered(), shown = list.slice(0, M.n), k = M.f.sort;
    h += '<div class="card mf-bar">' +
      '<input id="mf-q" type="search" data-m="mf" data-f="q" placeholder="Search fund or AMC" value="' + H.esc(M.q) + '" autocomplete="off" aria-label="Search funds">' +
      '<div class="mf-seg" role="group" aria-label="Plan">' + [0, 1].map(p => '<button data-m="mf" data-act="plan" data-v="' + p + '" class="' + (M.f.plan === p ? "on" : "") + '">' + planName(p) + " plan</button>").join("") + "</div>" +
      '<div class="mf-chips" role="group" aria-label="Category">' + CHIPS.map(([c, l]) => '<button data-m="mf" data-act="cat" data-v="' + c + '" class="mf-chip' + (M.f.cat === c ? " on" : "") + '">' + H.esc(l) + "</button>").join("") + "</div>" +
      '<div class="mf-sortrow"><label class="mf-sortl" for="mf-sort">Sort by</label><select id="mf-sort" data-m="mf" data-f="sort" aria-label="Sort funds">' + SORTS.map(([c, l]) => '<option value="' + c + '"' + (k === c ? " selected" : "") + ">" + H.esc(l) + "</option>").join("") + "</select></div></div>";
    if (M.cmp.length) h += '<div class="mf-cmpbar"><span><b>' + M.cmp.length + "</b> of " + MAXCMP + ' selected to compare</span><button class="btn sm" data-m="mf" data-act="gocmp">Open Compare</button></div>';
    h += '<p class="mf-count">' + list.length.toLocaleString("en-IN") + " " + planName(M.f.plan).toLowerCase() + " plan fund" + (list.length === 1 ? "" : "s") + (M.q ? " matching “" + H.esc(M.q) + "”" : "") + (k !== "name" ? " · best " + PL[k] + " first" : "") + "</p>";
    if (hidden > 0) h += '<div class="note mf-note-hid">' + ic("info-circle") + "<span>" + hidden.toLocaleString("en-IN") + " newer fund" + (hidden === 1 ? "" : "s") + " with less than " + PL[k].replace("Y", " year") + (PL[k] === "1Y" ? "" : "s") + " of history " + (hidden === 1 ? "is" : "are") + " not ranked here. Sort by Name (A-Z) to see every fund.</span></div>";
    if (!list.length) h += '<div class="card mf-empty">' + ic("search") + "<b>No funds match</b><p class=\"mut\">Try a shorter search, another category, or the other plan" + (hidden ? ", or sort by Name to include new funds" : "") + '.</p><button class="btn ghost" data-m="mf" data-act="reset">Clear search and filters</button></div>';
    else { const caps = { r1: p90(list, "r1"), r3: p90(list, "r3"), r5: p90(list, "r5") }; h += shown.map(f => row(f, H, null, caps, qToks(M.q))).join(""); }
    if (list.length > shown.length) h += '<button class="btn ghost mf-more" data-m="mf" data-act="more">Show more (' + (list.length - shown.length).toLocaleString("en-IN") + " left)</button>";
    return wrap(h + foot(H));
  }

  // ---------- Fund page ----------
  function fundPage(code, H) {
    const f = M.data && M.data.by.get(code), T = H.head("Fund details");
    if (!M.data) return wrap(T + noData(H) + foot(H));
    if (!f) return wrap(T + '<div class="card mf-empty">' + ic("search") + "<b>Fund not found</b><p class=\"mut\">This fund is not in the current data.</p></div>" + foot(H));
    const hs = ensureHist(code, H);
    const star = isWatch(code), cm = isCmp(code);
    let dayHtml = "";
    if (hs.st === "ok") {
      const a = hs.pts, l = a[a.length - 1], p = a[a.length - 2];
      if (l[0] === f.d && p) { const ch = (l[1] / p[1] - 1) * 100; dayHtml = '<span class="mf-day ' + (ch >= 0 ? "up" : "dn") + '">' + pct(ch) + ' <em>1D</em></span>'; }
    }
    let h = T;
    h += '<div class="card hero mf-hero"><div class="mf-hd"><div class="mf-hdt"><h2 class="mf-fn">' + H.esc(f.n) + '</h2><div class="mf-amc">' + H.esc(f.amc) + '</div><div class="mf-tags"><span class="mf-cat">' + H.esc(f.cat) + '</span><span class="mf-plan">' + planName(f.p) + ' plan</span><span class="mf-plan">Growth</span></div></div>' +
      '<button class="mf-ib mf-star big' + (star ? " on" : "") + '" data-m="mf" data-act="star" data-c="' + code + '" aria-pressed="' + star + '" aria-label="' + (star ? "Remove from watchlist" : "Add to watchlist") + '">' + ic("star") + "</button></div>" +
      '<div class="mf-navbig"><div><span class="mf-lbl">NAV</span><b>₹' + fmtNav(f.nav) + "</b></div>" + dayHtml + '<span class="mf-asof">as on ' + H.esc(H.fmtD(f.d)) + "</span></div>" +
      '<div class="mf-btns"><button class="btn ghost" data-m="mf" data-act="cmp" data-c="' + code + '">' + ic(cm ? "check" : "arrows-exchange") + (cm ? " In Compare" : " Compare") + '</button><button class="btn" data-m="mf" data-act="sipfrom" data-c="' + code + '">' + ic("coins") + " Start SIP</button></div>" +
      '<p class="mf-fine">The SIP calculator opens with this fund\'s past ' + (num(f.r3) ? "3-year" : num(f.r5) ? "5-year" : "") + " return as its assumption. That is past performance, not a forecast.</p></div>";
    h += navPanel(code, f, hs, H);
    h += returnsStrip(f);
    h += catBlock(f, H);
    h += '<div class="card"><h2>Scheme details</h2>' + H.tbl(["Item", "Value"], [["AMFI scheme code", String(code)], ["AMC", H.esc(f.amc)], ["Category (AMFI)", H.esc(f.cat)], ["Plan / option", planName(f.p) + " / Growth"]]) + "</div>";
    return wrap(h + foot(H, " NAV chart data: api.mfapi.in (a community mirror of AMFI NAVs)."));
  }
  function returnsStrip(f) {
    const t = (l, k, ty) => '<div class="mf-rt ' + (num(f[k]) ? (f[k] >= 0 ? "t-up" : "t-dn") : "") + '"><span>' + l + '</span><b class="' + rc(f[k]) + '">' + pct(f[k]) + "</b><em>" + ty + "</em></div>";
    return '<div class="card"><h2>Returns</h2><div class="mf-rstrip">' + t("6 months", "r6", "absolute") + t("1 year", "r1", "absolute") + t("3 years", "r3", "CAGR / year") + t("5 years", "r5", "CAGR / year") + '</div><p class="mut sm mf-n">“—” means this fund has no NAV that far back. Past performance is not a forecast.</p></div>';
  }
  function catBlock(f, H) {
    const s = catStats(f); if (s.n < 5) return "";
    const rows = ["r6", "r1", "r3", "r5"].map(k => {
      const a = s.avg[k], v = f[k], d = num(v) && num(a) ? v - a : null;
      return '<div class="mf-cmprow"><span class="mf-pl">' + PL[k] + '<em>' + (s.cnt[k] >= 5 ? s.cnt[k] + " funds" : "too few") + '</em></span><b class="' + rc(v) + '">' + pct(v) + '</b><b class="mut">' + (num(a) ? pct(a) : "—") + '</b><b class="' + rc(d) + '">' + (num(d) ? (d > 0 ? "+" : "") + d.toFixed(2) + " pts" : "—") + "</b></div>";
    }).join("");
    const rk = ["r1", "r3", "r5"].filter(k => s.rank[k]).map(k => { const r = s.rank[k]; return '<div class="mf-rank"><div class="mf-rk-t"><b>' + (r.top <= 50 ? "Top " + r.top : "Bottom " + r.bottom) + "%</b><span> of " + r.n + " funds over " + PL[k] + '</span></div><i class="mf-rkb"><u style="width:' + Math.max(4, Math.round(r.below / r.n * 100)) + '%"></u></i><em>Rank ' + r.rank + " of " + r.n + "</em></div>"; }).join("");
    return '<div class="card"><h2>Versus its category</h2><p class="mut sm mf-n">Average of all ' + s.n + " " + planName(f.p).toLowerCase() + " plan funds in <b>" + H.esc(f.cat) + '</b> in the AMFI data (' + H.esc(navDate(H)) + ").</p>" +
      '<div class="mf-cmphd"><span></span><span>This fund</span><span>Category avg</span><span>Difference</span></div>' + rows +
      (rk ? '<h3 class="mf-h3">Rank in category</h3><div class="mf-ranks">' + rk + '</div><p class="mut sm mf-n">Rank by return among funds with that return. Past ranking can change.</p>' : '<p class="mut sm mf-n">Ranking is shown when at least 10 funds in the category have that return.</p>') + "</div>";
  }

  // NAV chart panel (TrendyCharts.line mounted through configure + auto)
  function navPanel(code, f, hs, H) {
    let h = '<div class="card mf-chartc"><h2>NAV history</h2>';
    if (hs.st === "load") return h + '<div class="skel"><div class="skel-block mf-skel-ch"></div></div></div>';
    if (hs.st === "err") return h + '<div class="mf-err"><b>The NAV chart could not be loaded.</b><p class="mut">The history service (api.mfapi.in) did not respond. Returns above are not affected.</p><button class="btn" data-m="mf" data-act="chartretry" data-c="' + code + '">' + ic("refresh") + " Retry</button></div></div>";
    const all = hs.pts, av = FR.filter(r => r === "All" || covers(all, r));
    let rg = CH.range; if (!av.includes(rg)) rg = av.includes("1Y") ? "1Y" : "All";
    const pts = sliceRange(all, rg), growth = CH.mode === "growth", v0 = pts[0][1], v1 = pts[pts.length - 1][1];
    const up = v1 >= v0, chg = (v1 / v0 - 1) * 100;
    const data = growth ? pts.map(p => [p[0], 10000 * p[1] / v0]) : pts;
    const fmt = growth ? (v => rs(v)) : (v => rs2(v));
    TC() && TC().configure("mf-nav-" + code, { subtitle: growth ? "₹10,000 invested on " + H.fmtD(pts[0][0]) + " (same series, rebased)" : "Daily NAV, Growth option", height: 260, series: [{ name: growth ? "Value" : "NAV", data, fill: true, color: up ? UP : DN, format: fmt }] });
    h += '<div class="mf-modes" role="group" aria-label="Chart type"><button data-m="mf" data-act="mode" data-v="nav" class="' + (!growth ? "on" : "") + '">NAV</button><button data-m="mf" data-act="mode" data-v="growth" class="' + (growth ? "on" : "") + '">Growth of ₹10,000</button></div>' +
      '<div class="mf-rng" role="group" aria-label="Chart range">' + av.map(r => '<button data-m="mf" data-act="range" data-v="' + r + '" class="' + (rg === r ? "on" : "") + '">' + r + "</button>").join("") + "</div>" +
      '<div class="mf-chh"><b class="mf-chv">' + (growth ? rs(10000 * v1 / v0) : "₹" + fmtNav(v1)) + '</b><span class="mf-chg ' + (up ? "up" : "dn") + '">' + pct(chg) + '</span><span class="mut sm">' + (rg === "All" ? "since " + H.esc(H.fmtD(pts[0][0])) : "over " + rg) + "</span></div>" +
      '<div data-tc="line" data-tc-key="mf-nav-' + code + '" class="mf-chart"></div>' +
      '<p class="mut sm mf-n">' + (rg !== "All" && all[0][0] > rangeStart(all[all.length - 1][0], rg) ? "History is shorter than " + rg + ". " : "") + (growth ? "Hypothetical one-time investment at the start of the range; ignores taxes and exit load. " : "") + "Touch or hover the chart to read any day (" + pts.length.toLocaleString("en-IN") + " data points).</p></div>";
    return h;
  }

  // ---------- Compare ----------
  function compare(H) {
    let h = H.head("Compare funds");
    if (!M.data) return wrap(h + noData(H) + foot(H));
    const sel = M.cmp.map(c => M.data.by.get(c)).filter(Boolean);
    const toks = M.cq.toLowerCase().split(/\s+/).filter(Boolean);
    h += '<div class="card"><h2>Add a fund (' + sel.length + " of " + MAXCMP + ")</h2>" +
      (sel.length >= MAXCMP ? '<p class="mut">You have 3 funds. Remove one to add another.</p>' :
        '<input id="mf-cq" type="search" data-m="mf" data-f="cq" placeholder="Search fund or AMC" value="' + H.esc(M.cq) + '" autocomplete="off" aria-label="Search funds to compare">' +
        (toks.length ? (() => { const r = M.data.rows.filter(f => !isCmp(f.c) && toks.every(t => f.s.includes(t))).sort((a, b) => a.p - b.p || a.n.localeCompare(b.n)).slice(0, 8);
          return r.length ? r.map(f => '<div class="mf-pick"><span><b>' + H.hl(f.n, toks) + '</b><span class="mut sm mf-pk">' + H.hl(f.amc, toks) + " · " + H.hl(f.cat, toks) + " · " + planName(f.p) + '</span></span><button class="btn sm" data-m="mf" data-act="cmpadd" data-c="' + f.c + '">Add</button></div>').join("") : '<p class="mut sm">No funds match.</p>'; })() : '<p class="mut sm">Type a name to find funds, or tap the compare icon on any fund in the Funds tab.</p>')) + "</div>";
    if (!sel.length) return wrap(h + '<div class="card mf-empty">' + ic("arrows-exchange") + "<b>Nothing to compare yet</b><p class=\"mut\">Add up to 3 funds to see NAV, category, returns and a performance chart side by side.</p><button class=\"btn\" data-m=\"mf\" data-act=\"gofunds\">Browse funds</button></div>" + foot(H));
    const best = k => { const v = sel.map(f => f[k]).filter(num); return v.length > 1 ? Math.max(...v) : null; };
    const bs = { r6: best("r6"), r1: best("r1"), r3: best("r3"), r5: best("r5") };
    const cell = (k, f) => '<td class="' + (num(f[k]) && f[k] === bs[k] ? "mf-best" : "") + '"><b class="' + rc(f[k]) + '">' + pct(f[k]) + "</b></td>";
    const th = (f, i) => '<th><span class="mf-sw" style="background:' + PAL[i] + '"></span><button class="mf-x" data-m="mf" data-act="cmprm" data-c="' + f.c + '" aria-label="Remove ' + H.esc(f.n) + '">' + ic("x") + '</button><button class="mf-fl" data-m="mf" data-act="open" data-c="' + f.c + '">' + H.esc(f.n) + "</button></th>";
    const tr = (l, fn) => '<tr><th class="mf-rl">' + l + "</th>" + sel.map(fn).join("") + "</tr>";
    h += cmpChart(sel, H);
    h += '<div class="card"><h2>Side by side</h2><div class="tw"><table class="mf-ct"><tr><th class="mf-rl"></th>' + sel.map(th).join("") + "</tr>" +
      tr("AMC", f => "<td>" + H.esc(f.amc) + "</td>") + tr("Category", f => "<td>" + H.esc(f.cat) + "</td>") + tr("Plan", f => "<td>" + planName(f.p) + "</td>") +
      tr("NAV", f => "<td><b>₹" + fmtNav(f.nav) + '</b><br><span class="mut sm">' + H.esc(H.fmtD(f.d)) + "</span></td>") +
      tr("6M (abs.)", f => cell("r6", f)) + tr("1Y (abs.)", f => cell("r1", f)) + tr("3Y (CAGR)", f => cell("r3", f)) + tr("5Y (CAGR)", f => cell("r5", f)) + "</table></div>" +
      '<p class="mut sm mf-n">The highlighted cell is the highest value in that row. Comparing funds of the same category and plan gives the fairest picture.</p></div>';
    return wrap(h + foot(H, " Chart: api.mfapi.in."));
  }
  function cmpChart(sel, H) {
    let h = '<div class="card mf-chartc"><h2>Performance, rebased to 100</h2><div class="mf-rng" role="group" aria-label="Chart range">' + CR.map(r => '<button data-m="mf" data-act="crange" data-v="' + r + '" class="' + (CH.crange === r ? "on" : "") + '">' + r + "</button>").join("") + "</div>";
    const hs = sel.map(f => ensureHist(f.c, H));
    if (hs.some(x => x.st === "load")) return h + '<div class="skel"><div class="skel-block mf-skel-ch"></div></div></div>';
    const ok = sel.map((f, i) => [f, i, hs[i]]).filter(x => x[2].st === "ok"), bad = sel.map((f, i) => [f, i, hs[i]]).filter(x => x[2].st === "err");
    let note = "";
    if (bad.length) note += '<div class="mf-err mf-errs"><b>History not available for ' + bad.map(x => H.esc(x[0].n)).join(", ") + '.</b><button class="btn ghost sm" data-m="mf" data-act="cmpretry">' + ic("refresh") + " Retry</button></div>";
    if (!ok.length) return h + note + "</div>";
    const last = ok.map(x => x[2].pts[x[2].pts.length - 1][0]).sort()[0];
    const s = rangeStart(last, CH.crange), firsts = ok.map(x => x[2].pts[0][0]).sort().pop();
    let d0 = s && s > firsts ? s : firsts; const shorter = s && firsts > s;
    const series = ok.map(([f, i, h2]) => {
      const pts = h2.pts, b = atOrBefore(pts, d0) || pts[0], base = b[1];
      const d = [[d0, 100]]; for (const p of pts) if (p[0] > d0 && p[0] <= last) d.push([p[0], 100 * p[1] / base]);
      return { name: (f.n.length > 30 ? f.n.slice(0, 29) + "…" : f.n) + "", data: d, color: PAL[i], format: v => v.toFixed(1) };
    });
    TC() && TC().configure("mf-cmp", { subtitle: "Each fund set to 100 on " + H.fmtD(d0), height: 280, baseline: 100, series });
    const sum = ok.map(([f, i]) => { const d = series[ok.findIndex(x => x[1] === i)].data, v = d[d.length - 1][1] - 100; return '<span class="mf-leg"><i style="background:' + PAL[i] + '"></i>' + H.esc(f.n.length > 26 ? f.n.slice(0, 25) + "…" : f.n) + ' <b class="' + rc(v) + '">' + pct(v) + "</b></span>"; }).join("");
    return h + note + '<div class="mf-legs">' + sum + '</div><div data-tc="line" data-tc-key="mf-cmp" class="mf-chart"></div><p class="mut sm mf-n">' + (shorter ? "The newest fund started on " + H.esc(H.fmtD(firsts)) + ", so all funds are compared from that common date. " : "Common start date: " + H.esc(H.fmtD(d0)) + ". ") + "Absolute change over the period (not annualised). Past performance is not a forecast.</p></div>";
  }

  // ---------- SIP + lumpsum ----------
  function pn(s) { const t = String(s == null ? "" : s).replace(/[^0-9.\-]/g, ""); const v = parseFloat(t); return isFinite(v) ? v : null; }
  // Monthly SIP, optional annual step-up. Instalment paid at the start of each month; monthly rate i = (1+r)^(1/12)-1.
  function calcSip(P, r, y, s) {
    if (P == null || r == null || y == null || P < 0 || y <= 0) return null;
    s = s || 0; const n = Math.round(y * 12), i = Math.pow(1 + r / 100, 1 / 12) - 1;
    let v = 0, inv = 0, last = P; const iv = [0], vv = [0];
    for (let m = 0; m < n; m++) { const pay = P * Math.pow(1 + s / 100, Math.floor(m / 12)); last = pay; v = (v + pay) * (1 + i); inv += pay; iv.push(inv); vv.push(v); }
    return isFinite(v) ? { inv, fv: v, iv, vv, n, last } : null;
  }
  function calcLump(A, r, y) {
    if (A == null || r == null || y == null || A < 0 || y <= 0) return null;
    const n = Math.round(y * 12), iv = [], vv = []; for (let m = 0; m <= n; m++) { iv.push(A); vv.push(A * Math.pow(1 + r / 100, m / 12)); }
    return isFinite(vv[n]) ? { inv: A, fv: vv[n], iv, vv, n } : null;
  }
  const valid = (v, lo, hi) => v != null && v >= lo && v <= hi;
  function sipCalc() { const P = pn(M.sip.amt), r = pn(M.sip.rate), y = pn(M.sip.yrs), st = pn(M.sip.step) || 0; return valid(P, 0, 1e8) && valid(r, -50, 60) && valid(y, 1, 50) && valid(st, 0, 50) ? calcSip(P, r, y, st) : null; }
  function lumpCalc() { const A = pn(M.sip.lamt), r = pn(M.sip.lrate), y = pn(M.sip.lyrs); return valid(A, 0, 1e10) && valid(r, -50, 60) && valid(y, 1, 50) ? calcLump(A, r, y) : null; }
  function tilesHtml(c, mode) {
    if (!c) return '<div class="note mf-bad">' + ic("alert-triangle") + "<span>" + (mode === "sip" ? "Use a monthly amount up to ₹10 crore, a return between −50% and 60%, 1 to 50 years and a step-up of 0 to 50%." : "Use an amount up to ₹1,000 crore, a return between −50% and 60%, and 1 to 50 years.") + "</span></div>";
    const g = c.fv - c.inv, gp = c.inv > 0 ? g / c.inv * 100 : null;
    return '<div class="mf-big"><span>Estimated value</span><b>' + rs(c.fv) + "</b><em>" + short(c.fv) + '</em></div><div class="mf-tiles"><div class="mf-tile"><span>Amount invested</span><b>' + rs(c.inv) + "</b><em>" + short(c.inv) + '</em></div><div class="mf-tile ' + (g >= 0 ? "t-up" : "t-dn") + '"><span>Estimated gain</span><b class="' + rc(g) + '">' + (g < 0 ? "−" : "") + rs(Math.abs(g)) + "</b><em>" + (gp == null ? "" : pct(gp)) + "</em></div>" +
      (mode === "sip" && c.last > 0 && pn(M.sip.step) > 0 ? '<div class="mf-tile"><span>Final-year monthly SIP</span><b>' + rs(c.last) + "</b><em>after step-ups</em></div>" : "") + "</div>";
  }
  function growthOpts(c, mode, H) {
    if (!c) return { title: "Growth", series: [] };
    const t = (H || M.H).istDay(), y = +t.slice(0, 4), mo = +t.slice(5, 7) - 1, day = i => new Date(Date.UTC(y, mo + i, 1)).toISOString().slice(0, 10);
    const step = Math.max(1, Math.ceil(c.n / 240)), idx = []; for (let m = 0; m <= c.n; m += step) idx.push(m); if (idx[idx.length - 1] !== c.n) idx.push(c.n);
    return { title: "Growth over time", subtitle: "Month by month from today (axis: years from the start). Illustrative, not guaranteed.", height: 260, yearAxis: day(0), series: [
      { name: "Estimated value", data: idx.map(m => [day(m), c.vv[m]]), color: "#6366f1", fill: true, format: v => short(v) },
      { name: "Invested", data: idx.map(m => [day(m), c.iv[m]]), color: "#f59e0b", format: v => short(v) }] };
  }
  const chartKey = () => M.sip.mode === "lump" ? "mf-lump" : "mf-sipg";
  function field(label, f, id, unit, rmin, rmax, step) {
    const val = M.sip[f], v = pn(val);
    return '<div class="mf-fld"><label for="' + id + '">' + label + '</label><div class="mf-in"><input id="' + id + '" type="text" inputmode="decimal" data-m="mf" data-sip="' + f + '" value="' + String(val).replace(/[^0-9.\-]/g, "") + '" autocomplete="off"><span>' + unit + '</span></div><input type="range" data-m="mf" data-sip="' + f + '" min="' + rmin + '" max="' + rmax + '" step="' + step + '" value="' + (v == null ? rmin : Math.min(rmax, Math.max(rmin, v))) + '" aria-label="' + label + ' slider"></div>';
  }
  function sip(H) {
    let h = H.head("SIP calculator");
    const fr = M.sip.from, lump = M.sip.mode === "lump";
    if (fr) h += '<div class="card mf-pre"><b>Return pre-filled from ' + H.esc(fr.name) + '</b><p class="mut">Its past ' + H.esc(fr.label) + " annualised return (" + H.esc(pct(fr.rate)) + ') is used as the assumed return. This is past performance, not a forecast; change it freely.</p><button class="btn ghost sm" data-m="mf" data-act="sipclr">Clear</button></div>';
    h += '<div class="mf-modes" role="group" aria-label="Calculator"><button data-m="mf" data-act="simode" data-v="sip" class="' + (!lump ? "on" : "") + '">Monthly SIP</button><button data-m="mf" data-act="simode" data-v="lump" class="' + (lump ? "on" : "") + '">Lumpsum</button></div>';
    const c = lump ? lumpCalc() : sipCalc();
    TC() && TC().configure(chartKey(), growthOpts(c, lump ? "lump" : "sip", H));
    if (!lump) h += '<div class="card"><h2>Monthly SIP</h2>' + field("Monthly amount", "amt", "mf-sip-amt", "₹", 500, 200000, 500) + field("Expected return (per year)", "rate", "mf-sip-rate", "%", 0, 30, 0.5) + field("Time period", "yrs", "mf-sip-yrs", "years", 1, 40, 1) + field("Yearly step-up (0 = flat SIP)", "step", "mf-sip-step", "%", 0, 25, 1) + "</div>";
    else h += '<div class="card"><h2>Lumpsum</h2>' + field("Amount invested once", "lamt", "mf-lump-amt", "₹", 10000, 5000000, 10000) + field("Expected return (per year)", "lrate", "mf-lump-rate", "%", 0, 30, 0.5) + field("Time period", "lyrs", "mf-lump-yrs", "years", 1, 40, 1) + "</div>";
    h += '<div class="card mf-resc"><div id="mf-out">' + tilesHtml(c, lump ? "lump" : "sip") + '</div><div class="mf-chartw"><div data-tc="line" data-tc-key="' + chartKey() + '" class="mf-chart"></div></div>' +
      '<p class="mut sm mf-n">' + (lump ? "Estimated value = A × (1+r)^years." : "Estimated value after n months = Σ instalment × (1+i)^(months remaining), with i = (1+r)^(1/12) − 1 and each instalment paid at the start of the month. With no step-up this equals P × [((1+i)^n − 1) ÷ i] × (1+i). A yearly step-up raises the instalment by the chosen % at the start of each year.") + "</p></div>";
    h += '<div class="note mf-ill">' + ic("info-circle") + "<span><b>Illustrative, not guaranteed.</b> Actual returns vary and can be negative. The calculation ignores taxes, exit load, expense ratio changes and market ups and downs.</span></div>";
    return wrap(h + foot(H));
  }

  // ---------- Watchlist ----------
  function watch(H) {
    let h = H.head("Watchlist");
    if (!M.data) return wrap(h + noData(H) + foot(H));
    const list = M.watch.map(c => M.data.by.get(c)).filter(Boolean);
    if (!list.length) h += '<div class="card mf-empty">' + ic("star") + "<b>Your watchlist is empty</b><p class=\"mut\">Tap the star on any fund to keep it here with its NAV and returns.</p><button class=\"btn\" data-m=\"mf\" data-act=\"gofunds\">Browse funds</button></div>";
    else { const caps = { r1: p90(list, "r1"), r3: p90(list, "r3"), r5: p90(list, "r5") }; h += '<p class="mf-count">' + list.length + " fund" + (list.length === 1 ? "" : "s") + " saved on this device</p>" + list.map(f => row(f, H, "watch", caps)).join(""); }
    return wrap(h + foot(H));
  }

  // ---------- module ----------
  function toggle(arr, c, max, H) {
    const k = arr.indexOf(c);
    if (k >= 0) arr.splice(k, 1); else if (max && arr.length >= max) { H.toast("You can compare up to " + max + " funds"); return false; } else arr.push(c);
    return true;
  }
  function liveSip(H) {
    const lump = M.sip.mode === "lump", c = lump ? lumpCalc() : sipCalc(), out = document.getElementById("mf-out");
    if (out) out.innerHTML = tilesHtml(c, lump ? "lump" : "sip");
    if (TC()) { TC().configure(chartKey(), growthOpts(c, lump ? "lump" : "sip", H)); mountSoon(); }
  }
  function mountSoon() { if (!TC()) return; const go = () => TC().auto(document); requestAnimationFrame(go); setTimeout(go, 60); setTimeout(go, 300); }
  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.mf = {
    id: "mf", label: "Mutual Fund", icon: "💼",
    tabs: [["funds", "Funds"], ["compare", "Compare"], ["sip", "SIP"], ["watch", "Watchlist"]],
    load(H) { init(H); M.H = H; loadData(H); },
    render(tab, sub, H) {
      init(H); M.H = H;
      if (M.status === "idle") loadData(H);
      let html;
      if (sub && /^fund:\d+$/.test(sub)) html = fundPage(+sub.slice(5), H);
      else html = ({ funds, compare, sip, watch }[tab] || funds)(H);
      mountSoon();
      return html;
    },
    click(el, H) {
      init(H); M.H = H;
      const d = el.dataset, c = +d.c, a = d.act;
      if (a === "open") { H.setSub("fund:" + c); return true; }
      if (a === "star") { if (toggle(M.watch, c, 0, H)) { H.store.set("mf_watch", M.watch); H.render(); } return true; }
      if (a === "cmp" || a === "cmpadd") { if (toggle(M.cmp, c, MAXCMP, H)) { H.store.set("mf_cmp", M.cmp); if (a === "cmpadd") M.cq = ""; H.render(); } return true; }
      if (a === "cmprm") { toggle(M.cmp, c, 0, H); H.store.set("mf_cmp", M.cmp); H.render(); return true; }
      if (a === "plan") { M.f.plan = +d.v === 1 ? 1 : 0; M.n = PAGE; saveF(); H.render(); return true; }
      if (a === "cat") { M.f.cat = d.v; M.n = PAGE; saveF(); H.render(); return true; }
      if (a === "more") { M.n += PAGE; H.render(); return true; }
      if (a === "reset") { M.q = ""; M.f.cat = "all"; M.n = PAGE; saveF(); H.render(); return true; }
      if (a === "retry") { M.status = "idle"; loadData(H); return true; }
      if (a === "gocmp") { H.go("mf", "compare"); return true; }
      if (a === "gofunds") { H.go("mf", "funds"); return true; }
      if (a === "range") { if (FR.includes(d.v)) CH.range = d.v; H.render(); return true; }
      if (a === "mode") { CH.mode = d.v === "growth" ? "growth" : "nav"; H.render(); return true; }
      if (a === "crange") { if (CR.includes(d.v)) CH.crange = d.v; H.render(); return true; }
      if (a === "chartretry") { ensureHist(c, H, true); H.render(); return true; }
      if (a === "cmpretry") { M.cmp.forEach(x => { if (HS[x] && HS[x].st === "err") ensureHist(x, H, true); }); H.render(); return true; }
      if (a === "simode") { M.sip.mode = d.v === "lump" ? "lump" : "sip"; saveSip(); H.render(); return true; }
      if (a === "sipfrom") {
        const f = M.data && M.data.by.get(c); if (!f) return true;
        const lab = num(f.r3) ? "3Y" : num(f.r5) ? "5Y" : null, v = lab === "3Y" ? f.r3 : lab === "5Y" ? f.r5 : null;
        if (lab) { const s = String(Math.round(v * 10) / 10); M.sip.rate = s; M.sip.lrate = s; M.sip.from = { code: c, name: f.n, label: lab, rate: Math.round(v * 10) / 10 }; }
        else { M.sip.from = null; H.toast("This fund has no 3Y/5Y return, using your own assumption"); }
        saveSip(); H.go("mf", "sip"); return true;
      }
      if (a === "sipclr") { M.sip.from = null; saveSip(); H.render(); return true; }
      return false;
    },
    input(el, H) {
      init(H); M.H = H;
      const f = el.dataset.f;
      if (f === "q" || f === "cq") {
        if (f === "q") { M.q = el.value; M.n = PAGE; } else M.cq = el.value;
        const arrive = el.dataset.arrive === "1"; delete el.dataset.arrive;        // set by the shell when the text was filled in from the global search ("See all")
        clearTimeout(tq); tq = setTimeout(() => { H.render(); if (arrive && f === "q" && H.flash) setTimeout(() => H.flash(".mf-row"), 60); }, 160); return;
      }
      const s = el.dataset.sip; if (!s) return;
      M.sip[s] = el.value.slice(0, 13); saveSip();
      for (const o of document.querySelectorAll('[data-sip="' + s + '"]')) if (o !== el) o.value = el.value;   // box and slider stay in step, no re-render so focus stays
      liveSip(H);
    },
    change(el, H) {
      init(H);
      if (el.dataset.f === "sort" && SORTS.some(s => s[0] === el.value)) { M.f.sort = el.value; M.n = PAGE; saveF(); H.render(); }
    },
  };
})();
