// F&O module: end-of-day NSE derivatives data (descriptive only). Data: data/fno/*.json written by pipeline/fno.mjs. See docs/MODULES.md.
(function () {
  const RISK = "Futures and options carry a high risk of loss; most individual traders lose money (SEBI studies). End-of-day data, information only, not investment advice.";
  const MIN_OIV = 100;                                  // Rs crore of futures open interest: below this, OI % moves are mostly noise
  const S = { sum: null, lots: null, err: false, u: {}, ul: {}, q: "", lq: "", all: false, sym: null, exp: null, ready: false };
  const fname = s => s.replace(/[^A-Za-z0-9-]/g, c => "_" + c.charCodeAt(0).toString(16));   // same rule as pipeline/fno.mjs
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  let COL = {};

  const isN = x => typeof x === "number" && isFinite(x);
  const dash = "—";
  const cn = x => !isN(x) ? dash : Math.abs(x) >= 1e7 ? (x / 1e7).toFixed(2) + " Cr" : Math.abs(x) >= 1e5 ? (x / 1e5).toFixed(2) + " L" : Math.round(x).toLocaleString("en-IN");
  const sgn = x => !isN(x) ? dash : (x > 0 ? "+" : x < 0 ? "−" : "") + cn(Math.abs(x));
  const px = x => !isN(x) ? dash : x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctS = x => !isN(x) ? dash : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(2) + "%";
  const cls = x => !isN(x) || x === 0 ? "" : x > 0 ? "grn-t" : "red-t";
  const sp = (x, txt) => `<span class="${cls(x)}">${txt}</span>`;
  const dir = (a, noun) => !isN(a) ? null : (noun + (a > 0 ? " up" : a < 0 ? " down" : " unchanged"));
  const pvo = (pcp, oip) => { const a = dir(pcp, "price"), b = dir(oip, "OI"); return a && b ? a + ", " + b : dash; };
  const row = r => { const o = {}; for (let i = 0; i < r.length; i++) o[COL.keys[i]] = r[i]; return o; };
  const crore = x => !isN(x) ? dash : "₹" + x.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " Cr";

  function tb(heads, rows, extra) {
    return `<div class="tw"><table class="fo-t ${extra || ""}"><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</table></div>`;
  }
  const symBtn = (H, s) => `<button class="fo-sym" data-m="fno" data-act="und" data-s="${H.esc(s)}">${H.esc(s)}</button>`;
  const ym = d => d ? d.slice(0, 7) : "";

  function foot(H) {
    const m = S.sum?.meta; if (!m) return "";
    const old = m.tradeDate && Math.round((new Date(H.istDay()) - new Date(m.tradeDate)) / 864e5) > 5;
    return `<p class="fo-src mut">Source: NSE F&amp;O end-of-day bhavcopy and lot-size file, data as on ${H.esc(H.fmtD(m.tradeDate))}. OI and volume are in units (quantity), not lots.${old ? " <b>This data is more than 5 days old.</b>" : ""}</p>`;
  }
  const risk = H => `<div class="fo-risk" role="note"><b>Risk:</b> ${H.esc(RISK)}</div>`;
  function unavailable(H, title) {
    return H.head(title) + risk(H) + H.card("", S.err
      ? `<p>F&amp;O data could not be loaded. Please check your connection and try again.</p><button class="btn" data-m="fno" data-act="retry">Try again</button>`
      : '<p class="mut">Loading F&amp;O data…</p>');
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
    if (!S.ul[sym]) {
      S.ul[sym] = 1;
      fetch("data/fno/u/" + encodeURIComponent(fname(sym)) + ".json", { cache: "no-cache" }).then(r => { if (!r.ok) throw 0; return r.json(); })
        .then(j => { if (!j || !Array.isArray(j.x)) throw 0; S.u[sym] = j; H.render(); }).catch(() => { S.ul[sym] = 2; H.render(); });
    }
    return null;
  }
  function init(H) {
    if (S.ready) return; S.ready = true;
    S.sym = String(H.store.get("fo_sym", "NIFTY")); S.exp = H.store.get("fo_exp", null);
  }
  const pickExp = u => {
    const xs = u.x.filter(x => x.ch.length); if (!xs.length) return null;
    return (xs.find(x => x.e === S.exp) || xs.find(x => x.e > u.d) || xs[0]).e;
  };

  // ---------- Overview ----------
  function indexCard(H, r) {
    const f = r.fut != null;
    return `<button class="card fo-ic" data-m="fno" data-act="und" data-s="${H.esc(r.s)}" aria-label="Open ${H.esc(r.s)}">
      <div class="row"><b class="fo-nm">${H.esc(r.s)}</b><span class="mut sm">${isN(r.spot) ? "Index " + px(r.spot) : ""}</span></div>
      <div class="fo-kv"><span>Futures price${r.fexp ? " (" + H.esc(H.fmtD(r.fexp)) + ")" : ""}</span><b>${px(r.fut)} ${f ? sp(r.pcp, pctS(r.pcp)) : ""}</b></div>
      <div class="fo-kv"><span>Futures vs index</span><b>${sp(r.prem, pctS(r.prem))}</b></div>
      <div class="fo-kv"><span>Futures OI (all expiries)</span><b>${cn(r.oi)}</b></div>
      <div class="fo-kv"><span>Change in OI</span><b>${sp(r.doi, sgn(r.doi))} ${isN(r.oip) ? '<span class="mut">(' + pctS(r.oip) + ")</span>" : ""}</b></div>
      <div class="fo-kv"><span>PCR${r.oexp ? " (" + H.esc(H.fmtD(r.oexp)) + ")" : ""}</span><b>${isN(r.pcr) ? r.pcr.toFixed(2) : dash}</b></div>
      <div class="fo-kv"><span>Max pain</span><b>${isN(r.mp) ? px(r.mp).replace(/\.00$/, "") : dash}</b></div>
    </button>`;
  }
  const stockRows = (H, list) => list.map(r => [symBtn(H, r.s), px(r.fut), sp(r.pcp, pctS(r.pcp)), cn(r.oi), sp(r.oip, pctS(r.oip)), isN(r.lot) ? String(r.lot) : dash]);
  const STK_HEAD = ["Symbol", "Futures price", "Price chg", "Futures OI", "OI chg", "Lot"];

  function overview(H) {
    const order = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"];
    const idx = [...S.idx].sort((a, b) => { const ia = order.indexOf(a.s), ib = order.indexOf(b.s); return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.s.localeCompare(b.s); });
    const liquid = S.stk.filter(r => isN(r.oiv) && r.oiv >= MIN_OIV);
    const byOi = [...S.stk].filter(r => isN(r.oiv)).sort((a, b) => b.oiv - a.oiv).slice(0, 15);
    const byChg = [...liquid].filter(r => isN(r.oip)).sort((a, b) => Math.abs(b.oip) - Math.abs(a.oip)).slice(0, 15);
    return H.head("F&O") + risk(H) +
      `<div class="fo-grid">${idx.map(r => indexCard(H, r)).join("")}</div>` +
      H.card("Largest stock futures by open interest value", `<p class="mut sm">Ranked by futures OI × price, all expiries. Tap a symbol for expiries and the option chain.</p>` + tb(STK_HEAD, stockRows(H, byOi))) +
      H.card("Largest changes in futures OI", `<p class="mut sm">Stocks with futures OI of at least ₹${MIN_OIV} crore, ranked by the size of the OI change (increase or decrease) as a % of the previous day's OI.</p>` + tb(STK_HEAD, stockRows(H, byChg))) +
      H.card("What these numbers mean", `<ul class="lst fo-gl">
        <li><b>OI (open interest)</b>: contracts still open at the end of the day, in units. Change in OI is today's OI minus yesterday's.</li>
        <li><b>PCR (put-call ratio)</b>: total put OI ÷ total call OI for one expiry. It only describes how open interest is split.</li>
        <li><b>Max pain</b>: the strike at which the total payout of all open options (calls: spot above strike, puts: spot below strike, weighted by OI) would be smallest. It is a calculated number, not a forecast.</li>
        <li><b>Futures vs index</b>: (futures price − underlying price) ÷ underlying price.</li>
        <li><b>OI change %</b>: change in OI ÷ (OI − change in OI). <b>Price chg</b>: nearest-expiry futures close vs previous close.</li></ul>`) +
      foot(H);
  }

  // ---------- option chain (shared by Chain tab and the underlying page) ----------
  function chainHtml(H, u, ex) {
    const x = u.x.find(v => v.e === ex); if (!x || !x.ch.length) return '<p class="mut">No option contracts for this expiry.</p>';
    let ch = x.ch, atm = null;
    if (isN(u.spot)) { let best = Infinity; for (const r of ch) { const d = Math.abs(r[0] - u.spot); if (d < best) { best = d; atm = r[0]; } } }
    if (!S.all && atm !== null) { const i = ch.findIndex(r => r[0] === atm); ch = ch.slice(Math.max(0, i - 12), i + 13); }
    let mx = 0; for (const r of ch) mx = Math.max(mx, r[1] || 0, r[5] || 0);
    const bar = (v, side) => `<td class="fo-oi ${side}">${isN(v) && mx ? `<i style="width:${Math.max(1, Math.round(v / mx * 100))}%"></i>` : ""}<span>${cn(v)}</span></td>`;
    const rows = ch.map(r => {
      const k = r[0], itmC = isN(u.spot) && k < u.spot, itmP = isN(u.spot) && k > u.spot;
      const ceC = (itmC ? " fo-itm" : ""), peC = (itmP ? " fo-itm" : "");
      return `<tr class="${k === atm ? "fo-atm" : ""}">` +
        bar(r[1], "ce").replace('class="fo-oi ce', `class="fo-oi ce${ceC}`) +
        `<td class="${ceC}">${sp(r[2], sgn(r[2]))}</td><td class="${ceC}">${cn(r[3])}</td><td class="${ceC}">${px(r[4])}</td>` +
        `<td class="fo-k">${px(k).replace(/\.00$/, "")}</td>` +
        `<td class="${peC}">${px(r[8])}</td><td class="${peC}">${cn(r[7])}</td><td class="${peC}">${sp(r[6], sgn(r[6]))}</td>` +
        bar(r[5], "pe").replace('class="fo-oi pe', `class="fo-oi pe${peC}`) + "</tr>";
    });
    const total = x.ch.length, shown = ch.length;
    return `<div class="tw fo-chw"><table class="fo-t fo-chain"><tr><th colspan="4" class="fo-hce">CALLS (CE)</th><th></th><th colspan="4" class="fo-hpe">PUTS (PE)</th></tr>
      <tr><th>OI</th><th>OI chg</th><th>Volume</th><th>Last price</th><th>Strike</th><th>Last price</th><th>Volume</th><th>OI chg</th><th>OI</th></tr>${rows.join("")}</table></div>
      <p class="mut sm">Shaded cells are in the money (strike below the underlying price for calls, above it for puts); the highlighted row is the strike nearest to the underlying price${isN(u.spot) ? " (" + px(u.spot) + ")" : ""}. Bars compare OI within the rows shown. Last price shows "—" when the contract did not trade that day. Strikes with no OI and no trades are left out.</p>
      ${total > shown || S.all ? `<button class="btn ghost fo-all" data-m="fno" data-act="all">${S.all ? "Show only strikes near the price" : "Show all " + total + " strikes"}</button>` : ""}`;
  }
  function expSelect(H, u, id) {
    const xs = u.x.filter(v => v.ch.length), cur = pickExp(u);
    return `<label class="fo-lab">Expiry <select id="${id}" data-m="fno" data-f="exp">${xs.map(v => `<option value="${H.esc(v.e)}"${v.e === cur ? " selected" : ""}>${H.esc(H.fmtD(v.e))}</option>`).join("")}</select></label>`;
  }
  function expSummary(H, u, ex) {
    const x = u.x.find(v => v.e === ex); if (!x) return "";
    const kv = (a, b) => `<div class="fo-st"><span>${a}</span><b>${b}</b></div>`;
    return `<div class="fo-stats">${kv("Total call OI", cn(x.coi))}${kv("Total put OI", cn(x.poi))}${kv("PCR (put OI ÷ call OI)", isN(x.pcr) ? x.pcr.toFixed(2) : dash)}${kv("Max pain strike", isN(x.mp) ? px(x.mp).replace(/\.00$/, "") : dash)}${kv("Highest call OI strike", isN(x.hc) ? px(x.hc).replace(/\.00$/, "") : dash)}${kv("Highest put OI strike", isN(x.hp) ? px(x.hp).replace(/\.00$/, "") : dash)}</div>`;
  }

  // ---------- underlying page ----------
  function undPage(H, sym) {
    const title = H.head(H.esc(sym)) + risk(H);
    const u = getU(H, sym);
    if (!u) return title + H.card("", S.ul[sym] === 2 ? '<p>Data for this underlying could not be loaded.</p>' : '<p class="mut">Loading…</p>') + foot(H);
    const ex = pickExp(u), r = S.byS[sym] || {};
    const futs = u.x.filter(v => v.fut);
    const ft = futs.length ? tb(["Expiry", "Price", "Price chg", "vs underlying", "OI", "OI chg", "OI chg %", "Volume"], futs.map(v => [H.esc(H.fmtD(v.e)), px(v.fut.c), sp(v.fut.pcp, pctS(v.fut.pcp)), sp(v.fut.prem, pctS(v.fut.prem)), cn(v.fut.oi), sp(v.fut.doi, sgn(v.fut.doi)), sp(v.fut.oip, pctS(v.fut.oip)), cn(v.fut.v)])) : '<p class="mut">No futures contracts for this underlying.</p>';
    return title +
      `<div class="fo-stats">
        <div class="fo-st"><span>Underlying price</span><b>${px(u.spot)}</b></div>
        <div class="fo-st"><span>Lot size</span><b>${isN(u.lot) ? u.lot : dash}</b></div>
        <div class="fo-st"><span>Futures OI value</span><b>${crore(r.oiv)}</b></div>
        <div class="fo-st"><span>Price vs OI (futures)</span><b>${pvo(r.pcp, r.oip)}</b></div></div>` +
      H.card("Futures", ft) +
      H.card("Option chain", (ex ? expSelect(H, u, "fo-uexp") + expSummary(H, u, ex) + chainHtml(H, u, ex) : '<p class="mut">No option contracts for this underlying.</p>')) +
      H.card("How these are calculated", `<p class="mut sm">PCR = total put OI ÷ total call OI for the expiry. Max pain = the strike with the smallest total payout if the underlying settled there: Σ call OI × max(0, strike − K) + Σ put OI × max(0, K − strike) (lowest strike wins a tie). OI chg % = change ÷ (OI − change).</p>`) +
      foot(H);
  }

  // ---------- Chain tab ----------
  function chainTab(H) {
    const q = S.q.trim().toUpperCase();
    const hits = q ? S.rows.filter(r => r.s.includes(q)).sort((a, b) => (a.s.startsWith(q) ? 0 : 1) - (b.s.startsWith(q) ? 0 : 1) || a.s.localeCompare(b.s)).slice(0, 8) : [];
    let sym = S.byS[S.sym] ? S.sym : "NIFTY";
    const quick = ["NIFTY", "BANKNIFTY", "FINNIFTY"].map(s => `<button class="btn ${s === sym ? "" : "ghost"} fo-q" data-m="fno" data-act="pick" data-s="${s}">${s}</button>`).join("");
    let body = "";
    const u = getU(H, sym);
    if (!u) body = S.ul[sym] === 2 ? '<p>Data for this underlying could not be loaded.</p>' : '<p class="mut">Loading…</p>';
    else {
      const ex = pickExp(u);
      body = ex ? expSelect(H, u, "fo-exp") + expSummary(H, u, ex) + chainHtml(H, u, ex) : '<p class="mut">No option contracts for this underlying.</p>';
    }
    return H.head("Option chain") + risk(H) +
      H.card("", `<div class="fo-quick">${quick}</div>
        <input id="fo-search" type="search" placeholder="Search a symbol, e.g. RELIANCE" autocomplete="off" value="${H.esc(S.q)}" data-m="fno" data-f="q" aria-label="Search underlying">
        ${hits.length ? `<div class="fo-quick">${hits.map(r => `<button class="btn ghost fo-q" data-m="fno" data-act="pick" data-s="${H.esc(r.s)}">${H.esc(r.s)}</button>`).join("")}</div>` : q ? '<p class="mut sm">No F&amp;O underlying matches.</p>' : ""}`) +
      H.card(H.esc(sym) + (u && isN(u.spot) ? ` <span class="mut sm">Underlying ${px(u.spot)}${isN(u.lot) ? " · lot " + u.lot : ""}</span>` : ""), body +
        `<button class="linkbtn" data-m="fno" data-act="und" data-s="${H.esc(sym)}">Open ${H.esc(sym)} page with futures →</button>`) + foot(H);
  }

  // ---------- OI tab ----------
  function oiTab(H) {
    const ok = S.rows.filter(r => isN(r.oip) && isN(r.oiv) && r.oiv >= MIN_OIV);
    const up = [...ok].filter(r => r.oip > 0).sort((a, b) => b.oip - a.oip).slice(0, 15);
    const dn = [...ok].filter(r => r.oip < 0).sort((a, b) => a.oip - b.oip).slice(0, 15);
    const heads = ["Symbol", "Futures price", "Price chg", "OI chg %", "Futures OI", "Price vs OI"];
    const rw = list => list.map(r => [symBtn(H, r.s), px(r.fut), sp(r.pcp, pctS(r.pcp)), sp(r.oip, pctS(r.oip)), cn(r.oi), `<span class="fo-pvo">${pvo(r.pcp, r.oip)}</span>`]);
    return H.head("Open interest") + risk(H) +
      `<p class="mut sm fo-intro">Futures open interest summed over all expiries, for contracts with at least ₹${MIN_OIV} crore of OI. "Price vs OI" only states the direction of the two numbers (nearest-expiry futures price change, and total OI change); it is not an interpretation.</p>` +
      H.card("Biggest OI increases", up.length ? tb(heads, rw(up)) : '<p class="mut">No data.</p>') +
      H.card("Biggest OI decreases", dn.length ? tb(heads, rw(dn)) : '<p class="mut">No data.</p>') + foot(H);
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
    const rows = list.map(r => {
      const cols = S.lots ? lc[r[2]] : [[0]], a = cols[0] ? r[3][cols[0][0]] : null, b = cols[1] ? r[3][cols[1][0]] : null;
      const fr = S.byS[r[0]], val = isN(a) && fr && isN(fr.fut) ? a * fr.fut : null;
      return [symBtn(H, r[0]) + (r[2] === "I" ? ' <span class="pill fo-tag">Index</span>' : ""), `<span class="fo-name">${H.esc(r[1] || "")}</span>`, isN(a) ? String(a) : dash, isN(b) ? String(b) : dash, px(fr?.fut), isN(val) ? "₹" + cn(val) : dash];
    });
    return H.head("Lot sizes") + risk(H) +
      H.card("", `<input id="fo-lsearch" type="search" placeholder="Search symbol or name" autocomplete="off" value="${H.esc(S.lq)}" data-m="fno" data-f="lq" aria-label="Search lot sizes">
        <p class="mut sm">Trade date ${H.esc(H.fmtD(S.sum.meta.tradeDate))}. Contract value ≈ lot size × nearest-expiry futures price (the first lot-size month shown). ${list.length} underlying${list.length === 1 ? "" : "s"}.</p>` +
        (rows.length ? tb(["Symbol", "Name", `Lot ${H.esc(nice(cur) || "now")}`, `Lot ${H.esc(nice(nxt) || "next")}`, "Futures price", "Contract value"], rows) : '<p class="mut">No underlying matches.</p>')) +
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
      if (sub && sub.startsWith("und:")) return undPage(H, sub.slice(4));
      return ({ overview, chain: chainTab, oi: oiTab, lots: lotsTab }[tab] || overview)(H);
    },
    click(el, H) {
      const a = el.dataset.act, s = el.dataset.s;
      if (a === "retry") { loadAll(H); return true; }
      if (a === "und" && s) { S.sym = s; H.store.set("fo_sym", s); H.setSub("und:" + s); return true; }
      if (a === "pick" && s) { S.sym = s; S.q = ""; S.all = false; H.store.set("fo_sym", s); H.render(); return true; }
      if (a === "all") { S.all = !S.all; H.render(); return true; }
      return false;
    },
    input(el, H) { if (el.dataset.f === "q") { S.q = el.value; H.render(); } else if (el.dataset.f === "lq") { S.lq = el.value; H.render(); } },
    change(el, H) { if (el.dataset.f === "exp") { S.exp = el.value; H.store.set("fo_exp", el.value); H.render(); } },
  };
})();
