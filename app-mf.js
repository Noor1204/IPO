// Mutual Fund module (Funds / Compare / SIP / Watchlist). See docs/MODULES.md. Data: data/mf/*.json from pipeline/mf.mjs (AMFI).
(function () {
  "use strict";
  const DISC = "Mutual fund investments are subject to market risks. Information only, not investment advice.";
  const PAGE = 50, MAXCMP = 3;
  const CHIPS = [["all", "All"], ["large", "Large Cap"], ["mid", "Mid Cap"], ["small", "Small Cap"], ["flexi", "Flexi Cap"], ["multi", "Multi Cap"], ["elss", "ELSS"], ["eqother", "Other Equity"], ["index", "Index"], ["debt", "Debt"], ["hybrid", "Hybrid"], ["other", "Other"]];
  const SORTS = [["r3", "3Y return"], ["r1", "1Y return"], ["r5", "5Y return"], ["r6", "6M return"], ["name", "Name (A-Z)"]];
  const M = {
    data: null, status: "idle",              // idle | load | ok | err
    q: "", cq: "", n: PAGE, store: null, prefilled: false,
    watch: [], cmp: [], f: { plan: 0, cat: "all", sort: "r3" },
    sip: { amt: "5000", rate: "12", yrs: "10", lamt: "100000", lrate: "12", lyrs: "10", from: null },
  };
  const CH = { cache: {}, st: {}, range: "1Y", view: null };
  let tq = null;

  const num = v => typeof v === "number" && isFinite(v);
  const pct = v => num(v) ? (v > 0 ? "+" : "") + v.toFixed(2) + "%" : "—";
  const rc = v => num(v) ? (v > 0 ? "grn-t" : v < 0 ? "red-t" : "") : "mut";
  const fmtNav = n => num(n) ? n.toFixed(4).replace(/0{1,2}$/, "") : "—";
  const rs = n => num(n) ? "₹" + Math.round(n).toLocaleString("en-IN") : "—";

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
    if (s && typeof s === "object") for (const k of ["amt", "rate", "yrs", "lamt", "lrate", "lyrs"]) if (typeof s[k] === "string" && s[k].length < 14) M.sip[k] = s[k];
    if (s && s.from && typeof s.from === "object" && Number.isInteger(s.from.code) && typeof s.from.name === "string" && typeof s.from.label === "string" && num(s.from.rate)) M.sip.from = { code: s.from.code, name: s.from.name.slice(0, 120), label: s.from.label.slice(0, 4), rate: s.from.rate };
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
      M.data = { meta: idx.meta, rows, by }; M.status = "ok";
    } catch (e) { console.warn("mf load failed", e); M.status = "err"; }
    H.render();
  }

  // ---------- small pieces ----------
  const navDate = H => M.data && M.data.meta && M.data.meta.navDate ? H.fmtD(M.data.meta.navDate) : "";
  function foot(H) {
    const d = navDate(H);
    return '<p class="mut sm mf-disc">' + H.esc(DISC) + '</p><p class="mut sm mf-src">Source: AMFI' + (d ? ", NAV as on " + H.esc(d) : "") + ". Returns are computed from AMFI NAVs (6M and 1Y absolute, 3Y and 5Y annualised). Past performance does not indicate future returns.</p>";
  }
  const wrap = h => '<div class="mf-wrap">' + h + "</div>";
  function noData(H) {
    if (M.status === "load" || M.status === "idle") return H.card("", '<p class="mut">Loading fund data…</p>');
    return H.card("", '<p class="mut">Fund data could not be loaded right now. Check your connection and try again.</p><button class="btn" data-m="mf" data-act="retry" style="width:100%;margin-top:10px">Try again</button>');
  }
  const planName = p => p ? "Regular" : "Direct";
  const isWatch = c => M.watch.includes(c), isCmp = c => M.cmp.includes(c);

  function row(f, H, mode) {
    const star = isWatch(f.c);
    return '<div class="mf-row"><button class="mf-main" data-m="mf" data-act="open" data-c="' + f.c + '">' +
      '<b class="mf-nm">' + H.esc(f.n) + "</b>" +
      '<span class="mf-sub">' + H.esc(f.amc) + " · " + H.esc(f.cat) + ' · <span class="pill sm">' + planName(f.p) + "</span></span>" +
      '<span class="mf-nav">NAV ₹' + fmtNav(f.nav) + " · " + H.esc(H.fmtD(f.d)) + "</span>" +
      '<span class="mf-rets">' + [["1Y", f.r1], ["3Y", f.r3], ["5Y", f.r5]].map(([l, v]) => '<i><em>' + l + '</em><b class="' + rc(v) + '">' + pct(v) + "</b></i>").join("") + "</span></button>" +
      '<div class="mf-acts"><button class="mf-star' + (star ? " on" : "") + '" data-m="mf" data-act="star" data-c="' + f.c + '" aria-pressed="' + star + '" aria-label="' + (star ? "Remove from watchlist" : "Add to watchlist") + '">' + (star ? "★" : "☆") + "</button>" +
      '<button class="mf-cb' + (isCmp(f.c) ? " on" : "") + '" data-m="mf" data-act="cmp" data-c="' + f.c + '" aria-pressed="' + isCmp(f.c) + '">' + (isCmp(f.c) ? "✓ Compare" : "+ Compare") + "</button>" +
      (mode === "watch" ? '<button class="mf-rm" data-m="mf" data-act="star" data-c="' + f.c + '">Remove</button>' : "") + "</div></div>";
  }

  // ---------- Funds tab ----------
  function filtered() {
    const toks = M.q.toLowerCase().split(/\s+/).filter(Boolean);
    let a = M.data.rows.filter(f => f.p === M.f.plan && (M.f.cat === "all" || f.key === M.f.cat) && toks.every(t => f.s.includes(t)));
    const k = M.f.sort;
    if (k === "name") a.sort((x, y) => x.n.localeCompare(y.n));
    else a.sort((x, y) => (num(y[k]) ? y[k] : -1e9) - (num(x[k]) ? x[k] : -1e9) || x.n.localeCompare(y.n));
    return a;
  }
  function funds(H) {
    let h = H.head("Mutual Fund");
    if (!M.data) return wrap(h + noData(H) + foot(H));
    const list = filtered(), shown = list.slice(0, M.n);
    h += '<div class="card mf-bar">' +
      '<input id="mf-q" type="search" data-m="mf" data-f="q" placeholder="Search fund or AMC, e.g. flexi cap, HDFC" value="' + H.esc(M.q) + '" autocomplete="off" aria-label="Search funds">' +
      '<div class="mf-seg" role="group" aria-label="Plan">' + [0, 1].map(p => '<button data-m="mf" data-act="plan" data-v="' + p + '" class="' + (M.f.plan === p ? "on" : "") + '">' + planName(p) + "</button>").join("") + "</div>" +
      '<div class="mf-chips" role="group" aria-label="Category">' + CHIPS.map(([k, l]) => '<button data-m="mf" data-act="cat" data-v="' + k + '" class="mf-chip' + (M.f.cat === k ? " on" : "") + '">' + H.esc(l) + "</button>").join("") + "</div>" +
      '<label class="mf-sortl mut sm" for="mf-sort">Sort by</label><select id="mf-sort" data-m="mf" data-f="sort">' + SORTS.map(([k, l]) => '<option value="' + k + '"' + (M.f.sort === k ? " selected" : "") + ">" + H.esc(l) + "</option>").join("") + "</select></div>";
    if (M.cmp.length) h += '<div class="mf-cmpbar"><span><b>' + M.cmp.length + "</b> of " + MAXCMP + ' selected to compare</span><button class="btn sm" data-m="mf" data-act="gocmp">Open Compare</button></div>';
    h += '<p class="mut sm mf-count">' + list.length.toLocaleString("en-IN") + " " + planName(M.f.plan).toLowerCase() + " plan fund" + (list.length === 1 ? "" : "s") + (M.q ? " matching “" + H.esc(M.q) + "”" : "") + "</p>";
    if (!list.length) h += H.card("", '<p class="mut">No funds match. Try a shorter search, another category, or the other plan.</p>');
    else h += shown.map(f => row(f, H)).join("");
    if (list.length > shown.length) h += '<button class="btn ghost mf-more" data-m="mf" data-act="more">Show more (' + (list.length - shown.length).toLocaleString("en-IN") + " left)</button>";
    return wrap(h + foot(H));
  }

  // ---------- Fund page ----------
  function fundPage(code, H) {
    const f = M.data && M.data.by.get(code);
    if (!M.data) return wrap(H.head("Fund") + noData(H) + foot(H));
    if (!f) return wrap(H.head("Fund") + H.card("", '<p class="mut">This fund is not in the current data.</p>') + foot(H));
    ensureChart(code, H);
    const star = isWatch(code), cm = isCmp(code);
    let h = H.head(H.esc(f.n));
    h += H.card("", '<div class="mf-hd"><div><div class="mut sm">' + H.esc(f.amc) + '</div><div class="mut sm">' + H.esc(f.cat) + ' · <span class="pill sm">' + planName(f.p) + ' plan</span> · Growth</div></div>' +
      '<button class="mf-star big' + (star ? " on" : "") + '" data-m="mf" data-act="star" data-c="' + code + '" aria-pressed="' + star + '" aria-label="' + (star ? "Remove from watchlist" : "Add to watchlist") + '">' + (star ? "★" : "☆") + "</button></div>" +
      '<div class="mf-navbig"><span class="mut sm">NAV</span><b>₹' + fmtNav(f.nav) + '</b><span class="mut sm">as on ' + H.esc(H.fmtD(f.d)) + "</span></div>" +
      '<div class="row mf-btns"><button class="btn ghost" data-m="mf" data-act="cmp" data-c="' + code + '">' + (cm ? "✓ In Compare" : "+ Compare") + '</button><button class="btn" data-m="mf" data-act="sipfrom" data-c="' + code + '">Start SIP calculator</button></div>' +
      '<p class="mut sm" style="margin:8px 0 0">The SIP calculator opens with this fund\'s past ' + (num(f.r3) ? "3-year" : num(f.r5) ? "5-year" : "") + ' return filled in as an assumption. Past performance is not a forecast.</p>');
    const td = (l, v, t) => [l, '<b class="' + rc(v) + '">' + pct(v) + "</b>", t];
    h += H.card("Returns", H.tbl(["Period", "Return", "Type"], [td("6 months", f.r6, "Absolute"), td("1 year", f.r1, "Absolute"), td("3 years", f.r3, "Annualised (CAGR)"), td("5 years", f.r5, "Annualised (CAGR)")]) +
      '<p class="mut sm" style="margin:8px 0 0">Past returns up to ' + H.esc(H.fmtD(M.data.meta.navDate)) + ". “—” means this fund has no NAV that far back.</p>");
    h += H.card("NAV history", chartHtml(code, f, H));
    h += H.card("Scheme details", H.tbl(["Item", "Value"], [["AMFI scheme code", String(code)], ["AMC", H.esc(f.amc)], ["Category (AMFI)", H.esc(f.cat)], ["Plan / option", planName(f.p) + " / Growth"]]));
    return wrap(h + foot(H));
  }

  // ---------- NAV chart (api.mfapi.in, community mirror of AMFI data) ----------
  function ensureChart(code, H) {
    if (CH.st[code]) return;
    CH.st[code] = "load";
    fetch("https://api.mfapi.in/mf/" + code, { signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined })
      .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(j => {
        const pts = ((j && j.data) || []).map(x => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(x && x.date || ""); const v = parseFloat(x && x.nav); return m && v > 0 && isFinite(v) ? [m[3] + "-" + m[2] + "-" + m[1], v] : null; }).filter(Boolean).sort((a, b) => a[0] < b[0] ? -1 : 1);
        if (pts.length < 2) throw new Error("no history");
        CH.cache[code] = pts; CH.st[code] = "ok";
      })
      .catch(e => { console.warn("mf chart failed", e); CH.st[code] = "err"; })
      .then(() => { if (H.sub === "fund:" + code) H.render(); });
  }
  const MS = iso => Date.parse(iso + "T00:00:00Z");
  function rangeStart(lastIso, r) {
    if (r === "All") return null;
    const d = new Date(MS(lastIso)), mo = { "1M": 1, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60 }[r] || 12;
    d.setUTCMonth(d.getUTCMonth() - mo); return d.toISOString().slice(0, 10);
  }
  function chartHtml(code, f, H) {
    const st = CH.st[code];
    if (st === "load" || !st) return '<p class="mut">Loading NAV history…</p>';
    if (st === "err") return '<p class="mut">The NAV chart could not be loaded right now (the history service did not respond). The returns above are not affected.</p><button class="btn ghost" data-m="mf" data-act="chartretry" data-c="' + code + '" style="margin-top:8px">Try again</button>';
    const all = CH.cache[code], last = all[all.length - 1][0], st0 = rangeStart(last, CH.range);
    let pts = st0 ? all.filter(p => p[0] >= st0) : all;
    if (pts.length < 2) pts = all.slice(-2);
    const short = st0 && all[0][0] > st0;
    if (pts.length > 260) { const step = Math.ceil(pts.length / 260), o = []; for (let i = 0; i < pts.length; i += step) o.push(pts[i]); if (o[o.length - 1] !== pts[pts.length - 1]) o.push(pts[pts.length - 1]); pts = o; }
    const W = 320, Ht = 170, L = 46, R = 12, T = 12, B = 26, v = pts.map(p => p[1]), mn = Math.min(...v), mx = Math.max(...v), pad = (mx - mn || mx * 0.02 || 1) * 0.12, lo = mn - pad, hi = mx + pad;
    const t0 = MS(pts[0][0]), t1 = MS(pts[pts.length - 1][0]), X = t => L + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - L - R), Y = n => T + (hi - n) / (hi - lo) * (Ht - T - B);
    const up = v[v.length - 1] >= v[0], col = up ? "var(--ok)" : "var(--bad)";
    const poly = pts.map(p => X(MS(p[0])).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(" ");
    const dec = hi > 200 ? 0 : hi > 20 ? 1 : 2;
    const ticks = [mx, (mx + mn) / 2, mn].map(t => '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '" stroke="var(--bd)" stroke-dasharray="3 4"/><text x="' + (L - 5) + '" y="' + (Y(t) + 3.5).toFixed(1) + '" text-anchor="end" class="mf-ax">₹' + t.toFixed(dec) + "</text>").join("");
    const lab = iso => { const d = new Date(MS(iso)); return (t1 - t0 > 400 * 864e5) ? d.toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }) : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }); };
    const mid = pts[Math.floor(pts.length / 2)][0];
    const xl = [[pts[0][0], "start"], [mid, "middle"], [pts[pts.length - 1][0], "end"]].map(([d, a]) => '<text x="' + X(MS(d)).toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="' + a + '" class="mf-ax">' + lab(d) + "</text>").join("");
    CH.view = { code, pts, W, L, R, T, B, Ht, lo, hi, t0, t1 };
    const lp = pts[pts.length - 1];
    const rng = ["1M", "6M", "1Y", "3Y", "5Y", "All"].map(r => '<button data-m="mf" data-act="range" data-v="' + r + '" class="' + (CH.range === r ? "on" : "") + '">' + r + "</button>").join("");
    return '<div class="mf-rng" role="group" aria-label="Chart range">' + rng + "</div>" +
      '<div class="mf-ch" data-code="' + code + '"><svg viewBox="0 0 ' + W + " " + Ht + '" width="100%" role="img" aria-label="NAV history chart">' + ticks +
      '<polyline fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linejoin="round" points="' + poly + '"/>' +
      '<line class="mf-cur" x1="' + X(t1).toFixed(1) + '" x2="' + X(t1).toFixed(1) + '" y1="' + T + '" y2="' + (Ht - B) + '"/><circle class="mf-dot" cx="' + X(t1).toFixed(1) + '" cy="' + Y(lp[1]).toFixed(1) + '" r="5" fill="' + col + '"/>' + xl + "</svg>" +
      '<div class="mf-read" aria-live="polite">' + readout(lp, pts[0], H) + "</div></div>" +
      '<p class="mut sm" style="margin:6px 0 0">' + (short ? "This fund's history is shorter than " + H.esc(CH.range) + ", showing everything available. " : "") + "Move your cursor or finger over the line to see any day. NAV history from api.mfapi.in (a community mirror of AMFI data).</p>";
  }
  function readout(p, first, H) {
    const ch = (p[1] / first[1] - 1) * 100;
    return "<b>" + H.esc(H.fmtD(p[0])) + "</b> · NAV ₹" + fmtNav(p[1]) + ' · <span class="' + rc(ch) + '">' + pct(ch) + "</span> <span class=\"mut\">since " + H.esc(H.fmtD(first[0])) + "</span>";
  }
  function chartPick(e, H) {
    const box = e.target.closest && e.target.closest(".mf-ch"), V = CH.view; if (!box || !V || String(V.code) !== box.dataset.code) return;
    const svg = box.querySelector("svg"), r = svg.getBoundingClientRect(); if (!r.width) return;
    const x = (e.clientX - r.left) / r.width * V.W, t = V.t0 + (x - V.L) / (V.W - V.L - V.R) * (V.t1 - V.t0);
    let a = 0, b = V.pts.length - 1;
    while (a < b) { const m = (a + b) >> 1; MS(V.pts[m][0]) < t ? a = m + 1 : b = m; }
    if (a > 0 && Math.abs(MS(V.pts[a - 1][0]) - t) < Math.abs(MS(V.pts[a][0]) - t)) a--;
    const p = V.pts[a], cx = V.L + (V.t1 === V.t0 ? 0 : (MS(p[0]) - V.t0) / (V.t1 - V.t0)) * (V.W - V.L - V.R), cy = V.T + (V.hi - p[1]) / (V.hi - V.lo) * (V.Ht - V.T - V.B);
    const cur = box.querySelector(".mf-cur"), dot = box.querySelector(".mf-dot");
    cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); dot.setAttribute("cx", cx); dot.setAttribute("cy", cy);
    box.querySelector(".mf-read").innerHTML = readout(p, V.pts[0], H);
  }
  ["pointermove", "pointerdown"].forEach(t => document.addEventListener(t, e => { try { chartPick(e, M.H || fakeH()); } catch (err) { /* ignore */ } }));
  function fakeH() { return { esc: s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])), fmtD: s => s ? new Date(s + "T00:00:00Z").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—" }; }

  // ---------- Compare ----------
  function compare(H) {
    let h = H.head("Compare funds");
    if (!M.data) return wrap(h + noData(H) + foot(H));
    const sel = M.cmp.map(c => M.data.by.get(c)).filter(Boolean);
    const toks = M.cq.toLowerCase().split(/\s+/).filter(Boolean);
    h += '<div class="card"><h2>Add a fund (' + sel.length + " of " + MAXCMP + ")</h2>" +
      (sel.length >= MAXCMP ? '<p class="mut sm">You have 3 funds. Remove one to add another.</p>' :
        '<input id="mf-cq" type="search" data-m="mf" data-f="cq" placeholder="Search fund or AMC" value="' + H.esc(M.cq) + '" autocomplete="off" aria-label="Search funds to compare">' +
        (toks.length ? (() => { const r = M.data.rows.filter(f => !isCmp(f.c) && toks.every(t => f.s.includes(t))).sort((a, b) => a.p - b.p || a.n.localeCompare(b.n)).slice(0, 8);
          return r.length ? r.map(f => '<div class="row mf-pick"><span><b>' + H.esc(f.n) + '</b><br><span class="mut sm">' + H.esc(f.amc) + " · " + H.esc(f.cat) + " · " + planName(f.p) + '</span></span><button class="btn sm" data-m="mf" data-act="cmpadd" data-c="' + f.c + '">Add</button></div>').join("") : '<p class="mut sm">No funds match.</p>'; })() : '<p class="mut sm">Type a name to find funds. You can also tick “+ Compare” on any fund in the Funds tab.</p>')) + "</div>";
    if (!sel.length) return wrap(h + H.card("", '<p class="mut">No funds selected yet. Add up to 3 funds to see their NAV, category and returns side by side.</p>') + foot(H));
    const best = k => { const v = sel.map(f => f[k]).filter(num); return v.length > 1 ? Math.max(...v) : null; };
    const bs = { r6: best("r6"), r1: best("r1"), r3: best("r3"), r5: best("r5") };
    const cell = (k, f) => '<td class="' + (num(f[k]) && f[k] === bs[k] ? "mf-best" : "") + '"><b class="' + rc(f[k]) + '">' + pct(f[k]) + "</b></td>";
    const th = f => '<th><button class="mf-x" data-m="mf" data-act="cmprm" data-c="' + f.c + '" aria-label="Remove ' + H.esc(f.n) + '">✕</button><a href="#" class="mf-fl" data-m="mf" data-act="open" data-c="' + f.c + '">' + H.esc(f.n) + "</a></th>";
    const tr = (l, fn) => "<tr><th class=\"mf-rl\">" + l + "</th>" + sel.map(fn).join("") + "</tr>";
    h += '<div class="card"><div class="tw"><table class="mf-ct"><tr><th class="mf-rl"></th>' + sel.map(th).join("") + "</tr>" +
      tr("AMC", f => "<td>" + H.esc(f.amc) + "</td>") + tr("Category", f => "<td>" + H.esc(f.cat) + "</td>") + tr("Plan", f => "<td>" + planName(f.p) + "</td>") +
      tr("NAV", f => "<td><b>₹" + fmtNav(f.nav) + '</b><br><span class="mut sm">' + H.esc(H.fmtD(f.d)) + "</span></td>") +
      tr("6M (abs.)", f => cell("r6", f)) + tr("1Y (abs.)", f => cell("r1", f)) + tr("3Y (CAGR)", f => cell("r3", f)) + tr("5Y (CAGR)", f => cell("r5", f)) + "</table></div>" +
      '<p class="mut sm" style="margin:8px 0 0">The highlighted cell is the highest value in that row. Comparing funds from the same category and plan gives the fairest picture. Past performance does not indicate future returns.</p></div>';
    return wrap(h + foot(H));
  }

  // ---------- SIP + lumpsum ----------
  function pn(s) { const t = String(s == null ? "" : s).replace(/[^0-9.\-]/g, ""); const v = parseFloat(t); return isFinite(v) ? v : null; }
  function calcSip(P, r, y) {  // future value of an annuity due, monthly rate (1+r)^(1/12)-1
    if (P == null || r == null || y == null || P < 0 || y <= 0) return null;
    const n = Math.round(y * 12), i = Math.pow(1 + r / 100, 1 / 12) - 1;
    const fv = Math.abs(i) < 1e-12 ? P * n : P * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
    return isFinite(fv) ? { inv: P * n, fv } : null;
  }
  function calcLump(A, r, y) { if (A == null || r == null || y == null || A < 0 || y <= 0) return null; const fv = A * Math.pow(1 + r / 100, y); return isFinite(fv) ? { inv: A, fv } : null; }
  function outHtml(c, bad) {
    if (!c) return '<p class="mut sm">' + (bad || "Enter valid numbers to see the estimate.") + "</p>";
    const g = c.fv - c.inv, gp = c.inv > 0 ? g / c.inv * 100 : null;
    return '<div class="mf-stats"><div class="mf-stat"><span>Amount invested</span><b>' + rs(c.inv) + '</b></div><div class="mf-stat"><span>Estimated value</span><b>' + rs(c.fv) + '</b></div><div class="mf-stat"><span>Estimated gain</span><b class="' + rc(g) + '">' + (g < 0 ? "−" : "") + rs(Math.abs(g)) + '</b><span>' + (gp == null ? "" : pct(gp)) + "</span></div></div>";
  }
  const valid = (v, lo, hi) => v != null && v >= lo && v <= hi;
  function sipOut() { const P = pn(M.sip.amt), r = pn(M.sip.rate), y = pn(M.sip.yrs); return valid(P, 0, 1e8) && valid(r, -50, 60) && valid(y, 1, 50) ? outHtml(calcSip(P, r, y)) : outHtml(null, "Use a monthly amount up to ₹10 crore, a return between −50% and 60%, and 1 to 50 years."); }
  function lumpOut() { const A = pn(M.sip.lamt), r = pn(M.sip.lrate), y = pn(M.sip.lyrs); return valid(A, 0, 1e10) && valid(r, -50, 60) && valid(y, 1, 50) ? outHtml(calcLump(A, r, y)) : outHtml(null, "Use an amount up to ₹1,000 crore, a return between −50% and 60%, and 1 to 50 years."); }
  function field(label, f, id, unit, rmin, rmax, step) {
    const val = M.sip[f];
    return '<div class="mf-fld"><label for="' + id + '">' + label + '</label><div class="mf-in"><input id="' + id + '" type="text" inputmode="decimal" data-m="mf" data-sip="' + f + '" value="' + String(val).replace(/[^0-9.\-]/g, "") + '" autocomplete="off"><span class="mut">' + unit + '</span></div><input type="range" data-m="mf" data-sip="' + f + '" min="' + rmin + '" max="' + rmax + '" step="' + step + '" value="' + (pn(val) == null ? rmin : pn(val)) + '" aria-label="' + label + ' slider"></div>';
  }
  function sip(H) {
    let h = H.head("SIP calculator");
    const fr = M.sip.from;
    if (fr) h += '<div class="card mf-pre"><b>Return pre-filled from ' + H.esc(fr.name) + '</b><p class="mut sm" style="margin:4px 0 8px">Its past ' + H.esc(fr.label) + " annualised return (" + H.esc(pct(fr.rate)) + ') is used as the assumed return below. This is past performance, not a forecast; change it freely.</p><button class="btn ghost sm" data-m="mf" data-act="sipclr">Clear</button></div>';
    h += '<div class="card"><h2>Monthly SIP</h2>' + field("Monthly amount", "amt", "mf-sip-amt", "₹", 500, 100000, 500) + field("Expected return (per year)", "rate", "mf-sip-rate", "%", 0, 30, 0.5) + field("Time period", "yrs", "mf-sip-yrs", "years", 1, 40, 1) +
      '<div id="mf-sip-out">' + sipOut() + '</div><p class="mut sm mf-note">Estimated value = P × [((1+i)^n − 1) ÷ i] × (1+i), where P is the monthly amount, i = (1+r)^(1/12) − 1 is the monthly rate, n is the number of months, and each instalment is paid at the start of the month.</p></div>';
    h += '<div class="card"><h2>Lumpsum</h2>' + field("Amount invested once", "lamt", "mf-lump-amt", "₹", 10000, 1000000, 10000) + field("Expected return (per year)", "lrate", "mf-lump-rate", "%", 0, 30, 0.5) + field("Time period", "lyrs", "mf-lump-yrs", "years", 1, 40, 1) +
      '<div id="mf-lump-out">' + lumpOut() + '</div><p class="mut sm mf-note">Estimated value = A × (1+r)^years.</p></div>';
    h += '<p class="mut sm mf-disc">Illustrative only. These are not guaranteed returns: actual returns vary and can be negative. The calculation ignores taxes, exit load, expense-ratio changes and market ups and downs.</p>';
    return wrap(h + foot(H));
  }

  // ---------- Watchlist ----------
  function watch(H) {
    let h = H.head("Watchlist");
    if (!M.data) return wrap(h + noData(H) + foot(H));
    const list = M.watch.map(c => M.data.by.get(c)).filter(Boolean);
    if (!list.length) h += H.card("", '<p class="mut">Your watchlist is empty. Tap the ☆ star on any fund in the Funds tab to keep it here.</p><button class="btn" data-m="mf" data-act="gofunds" style="width:100%;margin-top:10px">Browse funds</button>');
    else h += '<p class="mut sm mf-count">' + list.length + " fund" + (list.length === 1 ? "" : "s") + " saved on this device</p>" + list.map(f => row(f, H, "watch")).join("");
    return wrap(h + foot(H));
  }

  // ---------- module ----------
  function toggle(arr, c, max, H, what) {
    const k = arr.indexOf(c);
    if (k >= 0) arr.splice(k, 1); else if (max && arr.length >= max) { H.toast("You can compare up to " + max + " funds"); return false; } else arr.push(c);
    return true;
  }
  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.mf = {
    id: "mf", label: "Mutual Fund", icon: "💼",
    tabs: [["funds", "Funds"], ["compare", "Compare"], ["sip", "SIP"], ["watch", "Watchlist"]],
    load(H) { init(H); M.H = H; loadData(H); },
    render(tab, sub, H) {
      init(H); M.H = H;
      if (M.status === "idle") loadData(H);
      if (sub && /^fund:\d+$/.test(sub)) return fundPage(+sub.slice(5), H);
      return ({ funds, compare, sip, watch }[tab] || funds)(H);
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
      if (a === "retry") { M.status = "idle"; loadData(H); return true; }
      if (a === "gocmp") { H.go("mf", "compare"); return true; }
      if (a === "gofunds") { H.go("mf", "funds"); return true; }
      if (a === "range") { CH.range = d.v; H.render(); return true; }
      if (a === "chartretry") { delete CH.st[c]; ensureChart(c, H); H.render(); return true; }
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
        clearTimeout(tq); tq = setTimeout(() => H.render(), 160); return;
      }
      const s = el.dataset.sip; if (!s) return;
      M.sip[s] = el.value.slice(0, 13); saveSip();
      for (const o of document.querySelectorAll('[data-sip="' + s + '"]')) if (o !== el) o.value = el.value;   // keep the box and slider in step, no re-render so focus stays
      if (el.type === "range") for (const o of document.querySelectorAll('input[type=text][data-sip="' + s + '"]')) o.value = el.value;
      const sipField = ["amt", "rate", "yrs"].includes(s);
      const out = document.getElementById(sipField ? "mf-sip-out" : "mf-lump-out"); if (out) out.innerHTML = sipField ? sipOut() : lumpOut();
    },
    change(el, H) {
      init(H);
      if (el.dataset.f === "sort" && SORTS.some(s => s[0] === el.value)) { M.f.sort = el.value; M.n = PAGE; saveF(); H.render(); }
    },
  };
})();
