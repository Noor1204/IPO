// F&O module: end-of-day NSE derivatives data (descriptive only). Data: data/fno/*.json written by pipeline/fno.mjs. See docs/MODULES.md.
(function () {
  const RISK = "Futures and options carry a high risk of loss; most individual traders lose money (SEBI studies). End-of-day data, information only, not investment advice.";
  const MIN_OIV = 100;                                  // Rs crore of futures open interest: below this, OI % moves are mostly noise
  const S = { sum: null, lots: null, err: false, u: {}, ul: {}, h: {}, hl: {}, q: "", lq: "", all: false, sym: null, exp: null, ready: false, mode: "fut", oim: "oi", gl: false };
  const fname = s => s.replace(/[^A-Za-z0-9-]/g, c => "_" + c.charCodeAt(0).toString(16));   // same rule as pipeline/fno.mjs
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const IDX_ORDER = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"];
  let COL = {};

  const isN = x => typeof x === "number" && isFinite(x);
  const dash = "—";
  const cn = x => !isN(x) ? dash : Math.abs(x) >= 1e7 ? (x / 1e7).toFixed(2) + " Cr" : Math.abs(x) >= 1e5 ? (x / 1e5).toFixed(2) + " L" : Math.round(x).toLocaleString("en-IN");
  const sgn = x => !isN(x) ? dash : (x > 0 ? "+" : x < 0 ? "−" : "") + cn(Math.abs(x));
  const px = x => !isN(x) ? dash : x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const strike = x => px(x).replace(/\.00$/, "");
  const pctS = x => !isN(x) ? dash : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(2) + "%";
  const cls = x => !isN(x) || x === 0 ? "" : x > 0 ? "grn-t" : "red-t";
  const sp = (x, txt) => `<span class="${cls(x)}">${txt}</span>`;
  const dir = (a, noun) => !isN(a) ? null : (noun + (a > 0 ? " up" : a < 0 ? " down" : " unchanged"));
  const pvo = (pcp, oip) => { const a = dir(pcp, "price"), b = dir(oip, "OI"); return a && b ? a + ", " + b : dash; };
  const row = r => { const o = {}; for (let i = 0; i < r.length; i++) o[COL.keys[i]] = r[i]; return o; };
  const crore = x => !isN(x) ? dash : "₹" + x.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " Cr";
  const ym = d => d ? d.slice(0, 7) : "";
  const iso = d => { const s = String(d); return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8); };
  const dm = d => { const s = String(d); return +s.slice(6, 8) + " " + MONTHS[+s.slice(4, 6) - 1].charAt(0) + MONTHS[+s.slice(4, 6) - 1].slice(1).toLowerCase(); };
  const TC = () => window.TrendyCharts;

  function tb(heads, rows, extra) {
    return `<div class="tw"><table class="fo-t ${extra || ""}"><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</table></div>`;
  }
  const ico = (H, n) => H.ic ? H.ic(n) : "";
  const SKEL = `<div class="skel fo-skel" role="status" aria-label="Loading"><div class="skel-line w50"></div><div class="skel-row"></div><div class="skel-row"></div><div class="skel-row"></div></div>`;
  const SKEL_CHART = `<div class="card fo-skc" role="status" aria-label="Loading chart"><div class="skel-line w40"></div><div class="skel-block fo-skb"></div></div>`;

  function foot(H) {
    const m = S.sum?.meta; if (!m) return "";
    const old = m.tradeDate && Math.round((new Date(H.istDay()) - new Date(m.tradeDate)) / 864e5) > 5;
    return `<p class="fo-src mut">Source: NSE F&amp;O end-of-day bhavcopy and lot-size file, data as on ${H.esc(H.fmtD(m.tradeDate))}. OI and volume are in units (quantity), not lots.${old ? " <b>This data is more than 5 days old.</b>" : ""}</p>`;
  }
  const risk = H => `<div class="fo-risk" role="note">${ico(H, "alert-triangle")}<span><b>Risk:</b> ${H.esc(RISK)}</span></div>`;
  const errBox = (H, msg, act, s) => `<div class="card fo-err" role="alert"><p><b>${msg}</b></p><button class="btn" data-m="fno" data-act="${act}"${s ? ` data-s="${H.esc(s)}"` : ""}>${ico(H, "refresh")} Retry</button></div>`;
  function unavailable(H, title) {
    return H.head(title) + risk(H) + (S.err ? errBox(H, "F&amp;O data could not be loaded. Please check your connection and try again.", "retry") : SKEL + SKEL_CHART);
  }

  // ---------- data ----------
  function loadAll(H) {
    S.err = false;
    Promise.all([
      fetch("data/fno/summary.json", { cache: "no-cache" }).then(r => { if (!r.ok) throw 0; return r.json(); }),
      fetch("data/fno/lots.json", { cache: "no-cache" }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([s, l]) => {
      if (!s || !Array.isArray(s.rows) || !Array.isArray(s.cols)) throw 0;
      COL = { keys: s.cols }; S.sum = s; S.lots = l; S.byS = {};
      S.rows = s.rows.map(row); for (const r of S.rows) S.byS[r.s] = r;
      S.idx = S.rows.filter(r => r.t === "I"); S.stk = S.rows.filter(r => r.t === "S");
      H.render();
    }).catch(() => { S.err = true; H.render(); });
  }
  function getU(H, sym) {
    if (S.u[sym]) return S.u[sym];
    if (S.ul[sym] !== 1 && S.ul[sym] !== 2) {
      S.ul[sym] = 1;
      fetch("data/fno/u/" + encodeURIComponent(fname(sym)) + ".json", { cache: "no-cache" }).then(r => { if (!r.ok) throw 0; return r.json(); })
        .then(j => { if (!j || !Array.isArray(j.x)) throw 0; S.u[sym] = j; H.render(); }).catch(() => { S.ul[sym] = 2; H.render(); });
    }
    return null;
  }
  // history file: returns parsed object or null (state in S.hl: 1 loading, 2 failed)
  function getH(H, sym, quiet) {
    if (S.h[sym]) return S.h[sym];
    if (S.hl[sym] !== 1 && S.hl[sym] !== 2) {
      S.hl[sym] = 1;
      fetch("data/fno/h/" + encodeURIComponent(fname(sym)) + ".json", { cache: "no-cache" }).then(r => { if (!r.ok) throw 0; return r.json(); })
        .then(j => { if (!j || !Array.isArray(j.days) || !j.days.length) throw 0; S.h[sym] = j; H.render(); }).catch(() => { S.hl[sym] = 2; H.render(); });
    }
    return null;
  }
  function init(H) {
    if (S.ready) return; S.ready = true;
    S.sym = String(H.store.get("fo_sym", "NIFTY")); S.exp = H.store.get("fo_exp", null);
    const m = H.store.get("fo_mode", "fut"); S.mode = m === "spot" || m === "live" ? m : "fut";
    S.oim = H.store.get("fo_oim", "oi") === "chg" ? "chg" : "oi";
  }
  const pickExp = u => {
    const xs = u.x.filter(x => x.ch.length); if (!xs.length) return null;
    return (xs.find(x => x.e === S.exp) || xs.find(x => x.e > u.d) || xs[0]).e;
  };

  // ---------- small visuals ----------
  const last = a => { for (let i = a.length - 1; i >= 0; i--) if (isN(a[i])) return a[i]; return null; };
  function spark(vals) {
    const v = (vals || []).filter(isN); if (v.length < 2) return '<span class="fo-sp0" aria-hidden="true"></span>';
    const mn = Math.min(...v), mx = Math.max(...v), rg = mx - mn || 1, W = 100, Hh = 30;
    const pts = v.map((y, i) => (i / (v.length - 1) * W).toFixed(1) + "," + (Hh - 3 - (y - mn) / rg * (Hh - 6)).toFixed(1));
    const up = v[v.length - 1] >= v[0];
    return `<svg class="fo-spk ${up ? "up" : "dn"}" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-hidden="true"><polygon class="fa" points="0,${Hh} ${pts.join(" ")} ${W},${Hh}"/><polyline points="${pts.join(" ")}"/></svg>`;
  }
  const dayChg = h => { if (!h) return null; const s = h.spot.filter(isN); return s.length >= 2 ? (s[s.length - 1] / s[s.length - 2] - 1) * 100 : null; };
  const miniBar = (w, tone) => `<span class="fo-mb ${tone || ""}"><i style="width:${Math.max(2, Math.min(100, Math.round(w)))}%"></i></span>`;
  const tile = (a, b, c) => `<div class="bt fo-tl"><span>${a}</span><b>${b}</b>${c ? `<em>${c}</em>` : ""}</div>`;

  // ---------- Overview ----------
  function indexCard(H, r) {
    const h = S.h[r.s], chg = dayChg(h);
    const sp30 = h ? h.spot.slice(-30) : null;
    return `<button class="card fo-ic" data-m="fno" data-act="und" data-s="${H.esc(r.s)}" aria-label="Open ${H.esc(r.s)}">
      <div class="row"><b class="fo-nm">${H.esc(r.s)}</b>${ico(H, "chevron-right")}</div>
      <div class="fo-px">${px(r.spot)}</div>
      <div class="fo-ch ${cls(chg)}">${isN(chg) ? pctS(chg) + ' <span class="mut">day</span>' : '<span class="mut">day change ' + dash + "</span>"}</div>
      <div class="fo-sprow">${h ? spark(sp30) : '<span class="skel-line fo-spsk"></span>'}</div>
      <div class="fo-kvs">
        <div><span>PCR</span><b>${isN(r.pcr) ? r.pcr.toFixed(2) : dash}</b></div>
        <div><span>Max pain</span><b>${isN(r.mp) ? strike(r.mp) : dash}</b></div>
        <div><span>Futures OI chg</span><b>${sp(r.oip, pctS(r.oip))}</b></div>
      </div></button>`;
  }
  function rankRow(H, r, main, mainCls, w, tone) {
    return `<button class="fo-lr" data-m="fno" data-act="und" data-s="${H.esc(r.s)}" aria-label="Open ${H.esc(r.s)}">
      <span class="fo-l1"><b>${H.esc(r.s)}</b><span class="mut">${px(r.fut)}${isN(r.pcp) ? " · " + sp(r.pcp, pctS(r.pcp)) : ""}</span></span>
      <span class="fo-l2"><b class="${mainCls || ""}">${main}</b><span class="mut">OI ${cn(r.oi)}${isN(r.lot) ? " · lot " + r.lot : ""}</span></span>
      ${miniBar(w, tone)}</button>`;
  }
  function overview(H) {
    const idx = S.idx.filter(r => IDX_ORDER.includes(r.s)).sort((a, b) => IDX_ORDER.indexOf(a.s) - IDX_ORDER.indexOf(b.s));
    for (const r of idx) getH(H, r.s);
    const liquid = S.stk.filter(r => isN(r.oiv) && r.oiv >= MIN_OIV);
    const byOi = [...S.stk].filter(r => isN(r.oiv)).sort((a, b) => b.oiv - a.oiv).slice(0, 15);
    const byChg = [...liquid].filter(r => isN(r.oip)).sort((a, b) => Math.abs(b.oip) - Math.abs(a.oip)).slice(0, 15);
    const mo = byOi.length ? byOi[0].oiv : 1, mc = byChg.length ? Math.abs(byChg[0].oip) : 1;
    const tot = S.stk.reduce((a, r) => a + (isN(r.oiv) ? r.oiv : 0), 0);
    return H.head("F&O") + risk(H) +
      `<h2 class="fo-h2">${ico(H, "chart-line")} Indices</h2><div class="fo-grid">${idx.map(r => indexCard(H, r)).join("")}</div>` +
      H.card(ico(H, "building-bank") + " Largest stock futures by OI value", `<p class="mut sm">Ranked by futures OI × price, all expiries. Bar = share of the largest in this list${tot ? "; the 15 shown hold " + (byOi.reduce((a, r) => a + r.oiv, 0) / tot * 100).toFixed(0) + "% of all stock-futures OI value" : ""}. Tap a row for charts and the option chain.</p><div class="fo-list">${byOi.map(r => rankRow(H, r, crore(r.oiv), "", r.oiv / mo * 100)).join("")}</div>`) +
      H.card(ico(H, "arrows-exchange") + " Largest changes in futures OI", `<p class="mut sm">Stocks with futures OI of at least ₹${MIN_OIV} crore, ranked by the size of the OI change (increase or decrease) as a % of the previous day's OI.</p><div class="fo-list">${byChg.map(r => rankRow(H, r, pctS(r.oip), cls(r.oip), Math.abs(r.oip) / mc * 100, r.oip < 0 ? "dn" : "up")).join("")}</div>`) +
      glossary(H) + foot(H);
  }
  function glossary(H) {
    return `<div class="card fo-gcard"><button class="fo-gbtn" data-m="fno" data-act="gl" aria-expanded="${S.gl}"><span>${ico(H, "info-circle")} What these numbers mean</span>${ico(H, "chevron-down").replace("class=\"ic\"", S.gl ? "class=\"ic fo-flip\"" : "class=\"ic\"")}</button>` +
      (S.gl ? `<ul class="lst fo-gl">
        <li><b>OI (open interest)</b>: contracts still open at the end of the day, in units. Change in OI is today's OI minus yesterday's.</li>
        <li><b>PCR (put-call ratio)</b>: total put OI ÷ total call OI for one expiry. It only describes how open interest is split.</li>
        <li><b>Max pain</b>: the strike at which the total payout of all open options (calls: spot above strike, puts: spot below strike, weighted by OI) would be smallest. It is a calculated number, not a forecast.</li>
        <li><b>Futures vs index</b>: (futures price − underlying price) ÷ underlying price.</li>
        <li><b>OI change %</b>: change in OI ÷ (OI − change in OI). <b>Price chg</b>: nearest-expiry futures close vs previous close.</li></ul>` : "") + `</div>`;
  }

  // ---------- option chain table + strike bars (Chain tab and underlying page) ----------
  function atmOf(u, x) {
    if (isN(x.atm)) return x.atm;
    if (!isN(u.spot)) return null;
    let best = Infinity, a = null; for (const r of x.ch) { const d = Math.abs(r[0] - u.spot); if (d < best) { best = d; a = r[0]; } } return a;
  }
  function sliceChain(u, x) {
    let ch = x.ch; const atm = atmOf(u, x);
    if (!S.all && atm !== null) { const i = ch.findIndex(r => r[0] === atm); if (i >= 0) ch = ch.slice(Math.max(0, i - 12), i + 13); }
    return { ch, atm };
  }
  function chainHtml(H, u, ex) {
    const x = u.x.find(v => v.e === ex); if (!x || !x.ch.length) return '<p class="mut">No option contracts for this expiry.</p>';
    const { ch, atm } = sliceChain(u, x);
    let mx = 0; for (const r of ch) mx = Math.max(mx, r[1] || 0, r[5] || 0);
    const bar = (v, side, extra) => `<td class="fo-oi ${side}${extra}">${isN(v) && mx ? `<i style="width:${Math.max(1, Math.round(v / mx * 100))}%"></i>` : ""}<span>${cn(v)}</span></td>`;
    const rows = ch.map(r => {
      const k = r[0], itmC = isN(u.spot) && k < u.spot, itmP = isN(u.spot) && k > u.spot;
      const ceC = (itmC ? " fo-itm" : ""), peC = (itmP ? " fo-itm" : "");
      return `<tr class="${k === atm ? "fo-atm" : ""}">` + bar(r[1], "ce", ceC) +
        `<td class="${ceC}">${sp(r[2], sgn(r[2]))}</td><td class="${ceC}">${cn(r[3])}</td><td class="${ceC}">${px(r[4])}</td>` +
        `<td class="fo-k">${strike(k)}</td>` +
        `<td class="${peC}">${px(r[8])}</td><td class="${peC}">${cn(r[7])}</td><td class="${peC}">${sp(r[6], sgn(r[6]))}</td>` + bar(r[5], "pe", peC) + "</tr>";
    });
    const total = x.ch.length, shown = ch.length;
    return `<div class="tw fo-chw"><table class="fo-t fo-chain"><tr><th colspan="4" class="fo-hce">CALLS (CE)</th><th></th><th colspan="4" class="fo-hpe">PUTS (PE)</th></tr>
      <tr><th>OI</th><th>OI chg</th><th>Volume</th><th>Last price</th><th>Strike</th><th>Last price</th><th>Volume</th><th>OI chg</th><th>OI</th></tr>${rows.join("")}</table></div>
      <p class="mut sm">Shaded cells are in the money (strike below the underlying price for calls, above it for puts); the highlighted row is the strike nearest to the underlying price${isN(u.spot) ? " (" + px(u.spot) + ")" : ""}. Bars compare OI within the rows shown. Last price shows "—" when the contract did not trade that day. Strikes with no OI and no trades are left out.</p>
      ${total > shown || S.all ? `<button class="btn ghost fo-all" data-m="fno" data-act="all">${S.all ? "Show only strikes near the price" : "Show all " + total + " strikes"}</button>` : ""}`;
  }
  // bars chart mount for one expiry; returns the placeholder html
  function strikeBars(H, u, ex, key) {
    const x = u.x.find(v => v.e === ex), T = TC(); if (!x || !x.ch.length || !T) return "";
    const { ch, atm } = sliceChain(u, x);
    const cats = ch.map(r => r[0]);
    let cv, pv, title, sub;
    if (S.oim === "chg" && Array.isArray(x.oic)) {
      const m = new Map(x.oic.map(r => [r[0], r])); cv = cats.map(k => Math.max(0, (m.get(k) || [])[1] || 0)); pv = cats.map(k => Math.max(0, (m.get(k) || [])[2] || 0));
      title = "OI added by strike"; sub = "Increases only; decreases are in the table";
    } else { cv = ch.map(r => r[1] || 0); pv = ch.map(r => r[5] || 0); title = "OI by strike"; sub = "Open interest, units"; }
    T.configure(key, { title: title + " · " + H.fmtD(ex), categories: cats, series: [{ name: S.oim === "chg" ? "Call OI added" : "Call OI", values: cv }, { name: S.oim === "chg" ? "Put OI added" : "Put OI", values: pv }], marker: atm != null ? atm : undefined, markerLabel: "ATM", categoryLabel: "Strike ", height: 280 });
    return `<div data-tc="bars" data-tc-key="${H.esc(key)}" class="fo-mount"></div><p class="mut sm">${sub}. Dashed line = strike nearest the underlying price${isN(u.spot) ? " (" + px(u.spot) + ")" : ""}.</p>`;
  }
  const oimSeg = () => `<div class="seg fo-seg" role="group" aria-label="Bar chart data"><button data-m="fno" data-act="oim" data-v="oi" class="${S.oim === "oi" ? "on" : ""}">OI</button><button data-m="fno" data-act="oim" data-v="chg" class="${S.oim === "chg" ? "on" : ""}">Change in OI</button></div>`;
  function expSelect(H, u, id) {
    const xs = u.x.filter(v => v.ch.length), cur = pickExp(u);
    return `<label class="fo-lab">Expiry <select id="${id}" data-m="fno" data-f="exp">${xs.map(v => `<option value="${H.esc(v.e)}"${v.e === cur ? " selected" : ""}>${H.esc(H.fmtD(v.e))}</option>`).join("")}</select></label>`;
  }
  function expTiles(H, u, ex, r) {
    const x = u.x.find(v => v.e === ex); if (!x) return "";
    return `<div class="bento fo-bento">${tile("PCR (put ÷ call OI)", isN(x.pcr) ? x.pcr.toFixed(2) : dash)}${tile("Max pain strike", isN(x.mp) ? strike(x.mp) : dash)}${tile("Highest call OI strike", isN(x.hc) ? strike(x.hc) : dash)}${tile("Highest put OI strike", isN(x.hp) ? strike(x.hp) : dash)}${tile("Total call OI / put OI", cn(x.coi) + " / " + cn(x.poi))}${tile("Futures OI (all expiries)", cn(r && r.oi))}${tile("Futures OI change", sp(r && r.doi, sgn(r && r.doi)))}${tile("Futures OI change %", sp(r && r.oip, pctS(r && r.oip)))}</div>`;
  }
  const chainBlock = (H, u, ex, key, r) => expSelect(H, u, key + "-sel") + expTiles(H, u, ex, r) + `<div class="fo-ctl"><span class="mut sm">Bars</span>${oimSeg()}</div>` + strikeBars(H, u, ex, key) + `<h3 class="fo-h3">Option chain</h3>` + chainHtml(H, u, ex);

  // ---------- underlying page ----------
  function priceSection(H, sym, h, kind) {
    const T = TC();
    const seg = `<div class="seg fo-seg fo-modeseg" role="group" aria-label="Chart source">${[["fut", "Futures"], ["spot", "Spot line"], ["live", "Live"]].map(m => `<button data-m="fno" data-act="mode" data-v="${m[0]}" class="${S.mode === m[0] ? "on" : ""}">${m[1]}</button>`).join("")}</div>`;
    let body = "";
    if (!T) body = '<div class="card"><p class="mut">The chart library could not be loaded.</p></div>';
    else if (S.mode === "live") {
      const sy = T.tvSymbol(kind, sym), emb = sy ? T.liveEmbed(sy, { title: sym + " live chart" }) : "";
      body = `<div class="card fo-livec"><div class="fo-live" data-sym="${H.esc(sy || "")}">${emb || '<p class="mut">A live chart is not available for this symbol.</p>'}</div><p class="mut sm">Live chart by TradingView (third-party, may be delayed). It is not part of the end-of-day data below.</p></div>`;
    } else if (!h) body = S.hl[sym] === 2 ? errBox(H, "Price history for this underlying could not be loaded.", "retryh", sym) : SKEL_CHART;
    else {
      const n = h.days.length, rows = [];
      for (let i = 0; i < n; i++) {
        if (S.mode === "fut") { if (isN(h.c[i])) rows.push([iso(h.days[i]), h.o[i], h.h[i], h.l[i], h.c[i], h.v[i]]); }
        else if (isN(h.spot[i])) rows.push([iso(h.days[i]), null, null, null, h.spot[i], null]);
      }
      const rolls = (h.roll || []).filter(d => d > h.days[0]).map(dm);
      const sub = S.mode === "fut" ? "Near-month futures, end of day" + (rolls.length ? " · contract rolls: " + rolls.join(", ") : "") : "Underlying price, end of day";
      T.configure("fo-und-" + sym, { data: rows, type: S.mode === "fut" ? "candles" : "line", ranges: ["1M", "3M", "All"], range: "3M", volume: S.mode === "fut", ma: false, currency: "₹", title: sym, subtitle: sub, height: 300 });
      body = `<div data-tc="price" data-tc-key="fo-und-${H.esc(sym)}" class="fo-mount"></div><p class="mut sm">Futures candles follow the near-month contract; it rolls to the next expiry on the expiry day, so a small gap can appear at a roll.</p>`;
    }
    return `<div class="fo-chartsec">${seg}${body}</div>`;
  }
  function trendSection(H, sym, h) {
    const T = TC(); if (!T || !h) return "";
    const ser = (arr) => h.days.map((d, i) => [iso(d), arr[i]]).filter(p => isN(p[1]));
    T.configure("fo-oi-" + sym, { title: "Futures OI and price", subtitle: "All-expiry futures OI (left), near-month futures close (right)", height: 260, ranges: ["1M", "3M", "All"], range: "All",
      series: [{ name: "Futures OI", data: ser(h.oi), axis: "left", fill: true, color: "#818cf8", format: cn }, { name: "Futures close", data: ser(h.c), axis: "right", color: "#f59e0b", format: px }] });
    T.configure("fo-pcr-" + sym, { title: "PCR trend", subtitle: "Put OI ÷ call OI: all expiries and nearest expiry", height: 240, ranges: ["1M", "3M", "All"], range: "All", baseline: 1,
      series: [{ name: "PCR all expiries", data: ser(h.pcr), axis: "left", color: "#818cf8", format: v => v.toFixed(2) }, { name: "PCR nearest expiry", data: ser(h.pcrn), axis: "left", color: "#f59e0b", format: v => v.toFixed(2) }] });
    return `<div class="fo-two"><div data-tc="line" data-tc-key="fo-oi-${H.esc(sym)}" class="fo-mount"></div><div data-tc="line" data-tc-key="fo-pcr-${H.esc(sym)}" class="fo-mount"></div></div>`;
  }
  function undPage(H, sym) {
    const head = H.head(H.esc(sym)) + risk(H);
    const u = getU(H, sym), h = getH(H, sym);
    if (!u) return head + (S.ul[sym] === 2 ? errBox(H, "Data for this underlying could not be loaded.", "retryu", sym) : SKEL + SKEL_CHART) + foot(H);
    const ex = pickExp(u), r = S.byS[sym] || {}, isIdx = r.t === "I" || u.t === "I";
    const futs = u.x.filter(v => v.fut), nf = futs[0] && futs[0].fut;
    const chg = dayChg(h), spot = isN(u.spot) ? u.spot : (h ? last(h.spot) : null);
    const ft = futs.length ? tb(["Expiry", "Price", "Price chg", "vs underlying", "OI", "OI chg", "OI chg %", "Volume"], futs.map(v => [H.esc(H.fmtD(v.e)), px(v.fut.c), sp(v.fut.pcp, pctS(v.fut.pcp)), sp(v.fut.prem, pctS(v.fut.prem)), cn(v.fut.oi), sp(v.fut.doi, sgn(v.fut.doi)), sp(v.fut.oip, pctS(v.fut.oip)), cn(v.fut.v)])) : '<p class="mut">No futures contracts for this underlying.</p>';
    const hero = `<div class="card hero fo-hero ${isN(chg) ? (chg < 0 ? "dn" : "up") : ""}">
      <div class="row"><div><div class="fo-hn">${H.esc(sym)}</div><div class="mut sm">${isIdx ? "Index" : "Stock"} · F&amp;O underlying · data as on ${H.esc(H.fmtD(u.d))}</div></div><span class="pill fo-tag">${isIdx ? "Index" : "Stock"}</span></div>
      <div class="fo-hp"><b class="fo-hpx">${px(spot)}</b><span class="fo-hc ${cls(chg)}">${isN(chg) ? pctS(chg) : dash}</span><span class="mut sm">${isIdx ? "index level" : "price"} · day change</span></div>
      <div class="bento fo-bento"><div class="bt"><span>Near-month futures</span><b>${nf ? px(nf.c) : dash}</b><em>${nf ? sp(nf.pcp, pctS(nf.pcp)) + " day" : ""}</em></div>
        <div class="bt"><span>Lot size</span><b>${isN(u.lot) ? u.lot : dash}</b></div>
        <div class="bt"><span>Contract value</span><b>${isN(u.lot) && nf ? "₹" + cn(u.lot * nf.c) : dash}</b><em>lot × futures price</em></div>
        <div class="bt"><span>Futures OI value</span><b>${crore(r.oiv)}</b><em>${pvo(r.pcp, r.oip)}</em></div></div>
      ${futs.length ? `<div class="chips fo-exps" aria-label="Futures expiries"><span class="mut sm">Expiries</span>${futs.map(v => `<span class="chipb fo-ex">${H.esc(H.fmtD(v.e))}</span>`).join("")}</div>` : ""}</div>`;
    const kind = isIdx ? "index" : "stock";
    const html = head + hero + priceSection(H, sym, h, kind) + trendSection(H, sym, h) +
      H.card(ico(H, "chart-bar") + " Option chain", ex ? chainBlock(H, u, ex, "fo-bars-" + sym, r) : '<p class="mut">No option contracts for this underlying.</p>') +
      H.card(ico(H, "list-details") + " Futures", ft) +
      H.card(ico(H, "notes") + " How these are calculated", `<p class="mut sm">PCR = total put OI ÷ total call OI for the expiry. Max pain = the strike with the smallest total payout if the underlying settled there: Σ call OI × max(0, strike − K) + Σ put OI × max(0, K − strike) (lowest strike wins a tie). OI chg % = change ÷ (OI − change).</p>`) + foot(H);
    return html;
  }

  // ---------- Chain tab ----------
  function chainTab(H) {
    const q = S.q.trim().toUpperCase();
    const hits = q ? S.rows.filter(r => r.s.includes(q)).sort((a, b) => (a.s.startsWith(q) ? 0 : 1) - (b.s.startsWith(q) ? 0 : 1) || a.s.localeCompare(b.s)).slice(0, 8) : [];
    const sym = S.byS[S.sym] ? S.sym : "NIFTY";
    const base = ["NIFTY", "BANKNIFTY", "FINNIFTY"]; if (!base.includes(sym)) base.push(sym);
    const quick = base.map(s => `<button class="fo-q ${s === sym ? "on" : ""}" data-m="fno" data-act="pick" data-s="${H.esc(s)}">${H.esc(s)}</button>`).join("");
    let body = "";
    const u = getU(H, sym);
    if (!u) body = S.ul[sym] === 2 ? errBox(H, "Data for this underlying could not be loaded.", "retryu", sym) : SKEL + SKEL_CHART;
    else { const ex = pickExp(u); body = ex ? chainBlock(H, u, ex, "fo-cbars", S.byS[sym]) : '<p class="mut">No option contracts for this underlying.</p>'; }
    return H.head("Option chain") + risk(H) +
      H.card("", `<input id="fo-search" type="search" placeholder="Search a symbol, e.g. RELIANCE" autocomplete="off" value="${H.esc(S.q)}" data-m="fno" data-f="q" aria-label="Search underlying">
        <div class="fo-quick">${quick}</div>
        ${hits.length ? `<div class="fo-quick fo-hits">${hits.map(r => `<button class="fo-q" data-m="fno" data-act="pick" data-s="${H.esc(r.s)}">${H.esc(r.s)}</button>`).join("")}</div>` : q ? '<p class="mut sm">No F&amp;O underlying matches.</p>' : ""}`) +
      H.card(H.esc(sym) + (u && isN(u.spot) ? ` <span class="mut sm">Underlying ${px(u.spot)}${isN(u.lot) ? " · lot " + u.lot : ""}</span>` : ""), body +
        `<button class="btn ghost fo-open" data-m="fno" data-act="und" data-s="${H.esc(sym)}">Open ${H.esc(sym)} page with charts and futures ${ico(H, "chevron-right")}</button>`) + foot(H);
  }

  // ---------- OI tab ----------
  function oiTab(H) {
    const ok = S.rows.filter(r => isN(r.oip) && isN(r.oiv) && r.oiv >= MIN_OIV);
    const up = [...ok].filter(r => r.oip > 0).sort((a, b) => b.oip - a.oip).slice(0, 15);
    const dn = [...ok].filter(r => r.oip < 0).sort((a, b) => a.oip - b.oip).slice(0, 15);
    const list = (a, tone) => { const m = a.length ? Math.abs(a[0].oip) : 1; return `<div class="fo-list">${a.map(r => `<button class="fo-lr" data-m="fno" data-act="und" data-s="${H.esc(r.s)}" aria-label="Open ${H.esc(r.s)}">
      <span class="fo-l1"><b>${H.esc(r.s)}</b><span class="mut">${px(r.fut)} · ${sp(r.pcp, pctS(r.pcp))}</span></span>
      <span class="fo-l2"><b class="${cls(r.oip)}">${pctS(r.oip)}</b><span class="mut">OI ${cn(r.oi)}</span></span>
      <span class="fo-l3 mut sm">${pvo(r.pcp, r.oip)}</span>${miniBar(Math.abs(r.oip) / m * 100, tone)}</button>`).join("")}</div>`; };
    return H.head("Open interest") + risk(H) +
      `<p class="mut sm fo-intro">Futures open interest summed over all expiries, for contracts with at least ₹${MIN_OIV} crore of OI. "Price vs OI" only states the direction of the two numbers (nearest-expiry futures price change, and total OI change); it is not an interpretation.</p>` +
      H.card(ico(H, "trending-up") + " Biggest OI increases", up.length ? list(up, "up") : '<p class="mut">No data.</p>') +
      H.card(ico(H, "trending-down") + " Biggest OI decreases", dn.length ? list(dn, "dn") : '<p class="mut">No data.</p>') + foot(H);
  }

  // ---------- Lots tab ----------
  function lotCols() {
    const l = S.lots, td = S.sum.meta.tradeDate; if (!l) return null;
    const pick = k => { const ms = l.months[k] || []; const out = []; for (let i = 0; i < ms.length && out.length < 2; i++) { const m = /^([A-Z]{3})-(\d{2})$/.exec(ms[i]); if (!m) continue; const key = "20" + m[2] + "-" + String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0"); if (key >= ym(td)) out.push([i, ms[i]]); } return out; };
    return { I: pick("I"), S: pick("S") };
  }
  function lotsTab(H) {
    const q = S.lq.trim().toUpperCase(), lc = lotCols();
    const nice = m => m ? m.replace(/^([A-Z])([A-Z]{2})-(\d{2})$/, (a, b, c, d) => b + c.toLowerCase() + " 20" + d) : "";
    const cur = lc?.S[0]?.[1], nxt = lc?.S[1]?.[1];
    let list = (S.lots ? S.lots.rows : S.rows.map(r => [r.s, "", r.t, [r.lot]]));
    if (q) list = list.filter(r => r[0].includes(q) || (r[1] || "").toUpperCase().includes(q));
    list = [...list].sort((a, b) => (a[2] === b[2] ? 0 : a[2] === "I" ? -1 : 1) || a[0].localeCompare(b[0]));
    const shown = list.slice(0, 80);
    for (const r of shown.slice(0, 40)) getH(H, r[0]);
    const items = shown.map(r => {
      const cols = S.lots ? lc[r[2]] : [[0]], a = cols[0] ? r[3][cols[0][0]] : null, b = cols[1] ? r[3][cols[1][0]] : null;
      const fr = S.byS[r[0]], val = isN(a) && fr && isN(fr.fut) ? a * fr.fut : null, h = S.h[r[0]];
      return `<button class="fo-lr fo-lotr" data-m="fno" data-act="und" data-s="${H.esc(r[0])}" aria-label="Open ${H.esc(r[0])}">
        <span class="fo-l1"><b>${H.esc(r[0])}${r[2] === "I" ? ' <span class="pill fo-tag">Index</span>' : ""}</b><span class="mut fo-nmx">${H.esc(r[1] || "")}</span></span>
        <span class="fo-l2"><b>Lot ${isN(a) ? a : dash}</b><span class="mut">${nxt ? H.esc(nice(nxt)) + ": " + (isN(b) ? b : dash) : ""}</span></span>
        <span class="fo-l4"><span>≈ ${isN(val) ? "₹" + cn(val) : dash}<em class="mut"> per lot</em></span>${h ? spark(h.spot.slice(-30)) : '<span class="fo-sp0"></span>'}</span></button>`;
    });
    return H.head("Lot sizes") + risk(H) +
      H.card("", `<input id="fo-lsearch" type="search" placeholder="Search symbol or name" autocomplete="off" value="${H.esc(S.lq)}" data-m="fno" data-f="lq" aria-label="Search lot sizes">
        <p class="mut sm">Trade date ${H.esc(H.fmtD(S.sum.meta.tradeDate))}. Lot shown for ${H.esc(nice(cur) || "the current month")}; contract value ≈ lot size × nearest-expiry futures price. Sparkline = underlying price, last 30 trading days. ${list.length} underlying${list.length === 1 ? "" : "s"}${list.length > shown.length ? " (first " + shown.length + " shown, search to narrow)" : ""}.</p>`) +
      (items.length ? `<div class="fo-list">${items.join("")}</div>` : '<div class="card"><p class="mut">No underlying matches.</p></div>') +
      (S.lots ? "" : '<p class="mut sm">The lot-size file is not available; lot sizes shown come from the bhavcopy.</p>') + foot(H);
  }

  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.fno = {
    id: "fno", label: "F&O", icon: "⚖️",
    tabs: [["overview", "Overview"], ["chain", "Chain"], ["oi", "OI"], ["lots", "Lots"]],
    load(H) { init(H); loadAll(H); },
    render(tab, sub, H) {
      init(H);
      if (!S.sum) return unavailable(H, "F&O");
      let html;
      if (sub && sub.startsWith("und:")) html = undPage(H, sub.slice(4));
      else html = ({ overview, chain: chainTab, oi: oiTab, lots: lotsTab }[tab] || overview)(H);
      if (window.TrendyCharts && html.indexOf("data-tc=") >= 0) { const go = () => { try { TrendyCharts.auto(document); } catch (e) { console.warn(e); } }; requestAnimationFrame(go); setTimeout(go, 120); }
      if (window.TrendyCharts && html.indexOf("fo-live") >= 0) setTimeout(() => { try { document.querySelectorAll(".fo-live").forEach(e => TrendyCharts.liveEmbedInit(e)); } catch (e) {} }, 150);
      return html;
    },
    click(el, H) {
      const a = el.dataset.act, s = el.dataset.s, v = el.dataset.v;
      if (a === "retry") { S.err = false; loadAll(H); H.render(); return true; }
      if (a === "retryu" && s) { delete S.ul[s]; H.render(); return true; }
      if (a === "retryh" && s) { delete S.hl[s]; H.render(); return true; }
      if (a === "und" && s) { S.sym = s; H.store.set("fo_sym", s); H.setSub("und:" + s); return true; }
      if (a === "pick" && s) { S.sym = s; S.q = ""; S.all = false; H.store.set("fo_sym", s); H.render(); return true; }
      if (a === "all") { S.all = !S.all; H.render(); return true; }
      if (a === "gl") { S.gl = !S.gl; H.render(); return true; }
      if (a === "mode" && v) { S.mode = v; H.store.set("fo_mode", v); H.render(); return true; }
      if (a === "oim" && v) { S.oim = v === "chg" ? "chg" : "oi"; H.store.set("fo_oim", S.oim); H.render(); return true; }
      return false;
    },
    input(el, H) { if (el.dataset.f === "q") { S.q = el.value; H.render(); } else if (el.dataset.f === "lq") { S.lq = el.value; H.render(); } },
    change(el, H) { if (el.dataset.f === "exp") { S.exp = el.value; H.store.set("fo_exp", el.value); H.render(); } },
  };
})();
