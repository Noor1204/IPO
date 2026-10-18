const $ = s => document.querySelector(s);
// logo images: show when loaded, remove when they fail (initials stay). Load/error do not bubble, so listen in the capture phase.
document.addEventListener("load", e => { if (e.target.tagName === "IMG" && e.target.closest(".logo")) e.target.classList.add("ok"); }, true);
document.addEventListener("error", e => { if (e.target.tagName === "IMG" && e.target.closest(".logo")) e.target.remove(); }, true);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const state = {
  loaded: false, error: "", meta: null, ipos: [],
  tab: "ipo", seg: "live", perf: null, showAll: false, main: true, sme: false, sort: "score", q: "", search: false, detail: null,
  cmp: store.get("cmp", []), watch: store.get("watch", []), alerts: store.get("alerts", { open: true, close: true, allot: false }),
  allotIpo: null, modal: null, toast: "", ack: false, report: null, reportTab: "docs"
};
// Factor weights (sum 100). Missing factors are dropped and the rest re-normalised.
const WEIGHTS = { financial: .25, gmp: .15, subscription: .20, valuation: .20, quality: .10, peers: .10 };
const FACTOR_LABEL = { financial: "Financials", gmp: "GMP", subscription: "Subscription", valuation: "Valuation", quality: "Business quality", peers: "Returns vs peers" };

// ---------- formatting ----------
const isNum = v => typeof v === "number" && isFinite(v);
const inr = n => isNum(n) ? Math.round(n).toLocaleString("en-IN") : "—";
const f2 = n => isNum(n) ? n.toFixed(2) : "—";
const cr = n => isNum(n) ? n.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—";
const pd = s => { const [y, m, d] = s.split("-"); return new Date(+y, m - 1, +d); };
const istDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());   // "2026-10-18"
let today = pd(istDay());
const dayDiff = s => s ? Math.round((pd(s) - today) / 864e5) : null;
const fmtD = s => s ? pd(s).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtS = s => s ? pd(s).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ---------- security: nothing from the data file may become markup or a script ----------
// Every string in the loaded data loses the characters that make tags and break out of attributes, and any javascript:/data: value is emptied.
// esc() is still used wherever text is placed in HTML; this is the second layer.
const cleanStr = s => {
  const t = s.replace(/[<>"]/g, c => c === "<" ? "‹" : c === ">" ? "›" : "”"), l = t.trim().toLowerCase();
  return l.startsWith("javascript:") || l.startsWith("vbscript:") || l.startsWith("data:") ? "" : t;
};
const clean = v => Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [cleanStr(k), clean(x)])) : typeof v === "string" ? cleanStr(v) : v;
const safeUrl = u => { const t = typeof u === "string" ? u.trim() : ""; return (t.startsWith("https://") || t.startsWith("http://") || t.startsWith("data/logos/")) && !t.includes(" ") && !t.includes("..") ? t : ""; };
const logoSrc = u => typeof u === "string" && u.startsWith("data/logos/") && !u.includes("..") && !u.includes(" ") ? u : "";
const byId = id => state.ipos.find(i => i.symbol === id);
const FU = i => i.verification?.status === "fail" ? null : i.fundamentals;   // data that failed verification against the offer document is not used
const last = a => Array.isArray(a) ? a[a.length - 1] : null;

// ---------- derived data ----------
const totalTimes = i => i.bids?.total?.times ?? i.demand?.timesSubscribed ?? null;
const gmpNow = i => i.gmp?.value ?? null;
const gmpPct = i => isNum(gmpNow(i)) && i.priceHigh ? gmpNow(i) / i.priceHigh * 100 : null;
const gmpTxt = i => isNum(gmpNow(i)) ? (isNum(gmpPct(i)) ? `₹${gmpNow(i)} (${gmpPct(i).toFixed(2)}%)` : `₹${gmpNow(i)}`) : "No GMP yet";
const lotsFor = i => { const one = i.lot * i.priceHigh; return { s: Math.ceil(200000 / one), b: Math.ceil(1000000 / one) }; };
const retailN = i => { const t = i.bids?.retail?.times; return isNum(t) ? (t > 1 ? Math.round(t) : 1) : null; };
const pe = i => { const f = FU(i); if (!f) return null; if (isNum(f.kpi?.pe_post_ipo)) return f.kpi.pe_post_ipo; const e = last(f.kpi?.eps_diluted); return isNum(e) && e > 0 && i.priceHigh ? i.priceHigh / e : null; };
const peerAvg = (i, k) => { const v = (FU(i)?.peers || []).map(p => p[k]).filter(x => isNum(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const cagr = a => { const v = (a || []).filter(isNum); return v.length >= 2 && v[0] > 0 && last(v) > 0 ? ((last(v) / v[0]) ** (1 / (v.length - 1)) - 1) * 100 : null; };
const clamp = n => Math.max(0, Math.min(100, n));

function factors(i) {
  const f = FU(i), out = {}, why = {};
  if (f?.financials?.revenue && f.financials.pat) {
    const fin = f.financials, g = cagr(fin.revenue), rev = last(fin.revenue), pat = last(fin.pat);
    const margin = isNum(rev) && rev > 0 && isNum(pat) ? pat / rev * 100 : null, ronw = last(f.kpi?.ronw);
    const de = isNum(last(f.kpi?.debt_equity)) ? last(f.kpi.debt_equity) : isNum(last(fin.borrowings)) && isNum(last(fin.net_worth)) && last(fin.net_worth) > 0 ? last(fin.borrowings) / last(fin.net_worth) : null;   // prefer the figure the offer document itself reports
    const patUp = fin.pat.length > 1 && last(fin.pat) > fin.pat[fin.pat.length - 2];
    let s = 0, n = 0; const add = (v, w) => { if (v !== null && v !== undefined) { s += v * w; n += w; } };
    add(g === null ? null : clamp(g * 2.5), 30); add(margin === null ? null : clamp(margin * 5), 25); add(isNum(ronw) ? clamp(ronw * 3) : null, 20);
    add(de === null ? null : clamp(100 - de * 40), 15); add(patUp ? 100 : 30, 10);
    if (n) { out.financial = Math.round(s / n); why.financial = [g !== null && `revenue CAGR ${g.toFixed(0)}%`, margin !== null && `PAT margin ${margin.toFixed(1)}%`, isNum(ronw) && `RoNW ${ronw}%`, de !== null && `debt/equity ${de.toFixed(2)}`].filter(Boolean).join(", "); }
  }
  if (isNum(gmpPct(i))) { const h = (i.gmp.history || []).map(x => x.gmp), tr = h.length > 1 ? Math.sign(last(h) - h[0]) * 8 : 0; out.gmp = Math.round(clamp(50 + gmpPct(i) * 2.2 + tr)); why.gmp = `GMP ₹${gmpNow(i)} (${gmpPct(i).toFixed(1)}%)`; }
  const t = totalTimes(i);
  if (isNum(t) && i.status !== "upcoming") { out.subscription = Math.round(clamp(35 + Math.log2(1 + t) * 11)); why.subscription = `${t.toFixed(2)}x subscribed`; }
  const p = pe(i), pa = peerAvg(i, "pe");
  if (p && pa) { out.valuation = Math.round(clamp(100 - (p / pa - .6) * 100)); why.valuation = `P/E ${p.toFixed(1)} vs peer avg ${pa.toFixed(1)}`; }
  if (f) {
    let s = 70; const n = [];
    const fi = f.issue || {}, tot = (fi.fresh_issue_cr || 0) + (fi.ofs_cr || 0);
    if (tot > 0 && isNum(fi.ofs_cr) && fi.ofs_cr / tot > .5) { s -= 15; n.push(`${Math.round(fi.ofs_cr / tot * 100)}% is Offer for Sale`); }
    const c = f.concentration || {}; if (isNum(c.top_customers_pct) && c.top_customers_pct > 60) { s -= 10; n.push(`top customers ${c.top_customers_pct}%`); }
    if (isNum(c.govt_share_pct) && c.govt_share_pct > 60) { s -= 5; n.push(`govt ${c.govt_share_pct}% of revenue`); }
    const hi = (f.risks || []).filter(r => r.severity === "high").length; if (hi) { s -= Math.min(16, hi * 4); n.push(`${hi} high-severity risk(s)`); }
    const cfo = last(f.financials?.operating_cash_flow); if (isNum(cfo) && cfo < 0) { s -= 15; n.push("negative operating cash flow"); }
    const ph = f.promoters?.holding_post_pct; if (isNum(ph)) { if (ph >= 60) { s += 10; n.push(`promoters hold ${ph}% post-issue`); } else if (ph < 35) { s -= 5; n.push(`promoter holding only ${ph}%`); } }
    out.quality = Math.round(clamp(s)); why.quality = n.join(", ") || "no major red flags in extracted data";
  }
  const cr_ = last(FU(i)?.kpi?.ronw), pr = peerAvg(i, "ronw");
  if (isNum(cr_) && pr) { out.peers = Math.round(clamp(50 + (cr_ - pr) * 2.5)); why.peers = `RoNW ${cr_}% vs peer avg ${pr.toFixed(1)}%`; }
  return { v: out, why };
}
function scoreOf(i) {
  const { v } = factors(i), keys = Object.keys(v), w = keys.reduce((a, k) => a + WEIGHTS[k], 0);
  const cov = Math.round(w * 100);
  if (cov < 50) return { score: null, coverage: cov };   // too little data to give a meaningful score
  return { score: Math.round(keys.reduce((a, k) => a + v[k] * WEIGHTS[k], 0) / w), coverage: Math.round(w * 100) };
}
const score = i => scoreOf(i).score;
const verdict = s => s === null ? { t: "Insufficient data", e: "❔", c: "gr" } : s >= 80 ? { t: "High score", e: "✅", c: "g" } : s >= 60 ? { t: "Moderate score", e: "⚠️", c: "y" } : { t: "Low score", e: "❌", c: "r" };
const col = s => s === null ? "var(--bd)" : s >= 80 ? "var(--ok)" : s >= 60 ? "var(--warn)" : "var(--bad)";
function reasons(i) {
  const { v, why } = factors(i), out = [];
  for (const k of Object.keys(v)) out.push(`${v[k] >= 70 ? "✅" : v[k] >= 50 ? "➖" : "⚠️"} ${FACTOR_LABEL[k]}: ${why[k]}`);
  const m = Object.keys(WEIGHTS).filter(k => !(k in v)).map(k => FACTOR_LABEL[k]);
  if (m.length) out.push(`ℹ️ Not scored (data unavailable): ${m.join(", ")}`);
  return out;
}

// ---------- shared UI ----------
const ring = (s, big) => `<div class="ring ${big ? "big" : ""} ${s === null || s === undefined ? "na" : ""}" ${s === null || s === undefined ? 'title="Score not available: the offer document has not been analysed yet"' : ""} style="background:conic-gradient(${col(s)} ${(s ?? 0) * 3.6}deg,var(--bd) 0)"><span>${s ?? "N/A"}</span></div>`;
const hue = s => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const logoText = i => /^IG-/.test(i.symbol) ? i.name.split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase() : i.symbol.slice(0, 3);   // IG-only entries have no exchange symbol
const logo = i => `<div class="logo" style="background:hsl(${hue(i.symbol)} 55% 42%)"><span>${esc(logoText(i))}</span>${logoSrc(i.logo) ? `<img src="${esc(logoSrc(i.logo))}" alt="" referrerpolicy="no-referrer">` : ""}</div>`;   // if the image fails to load it is removed and the initials show
// ---------- where an IPO is in its journey ----------
// bidding open -> (closing time passes) waiting for allotment -> allotment day -> waiting for listing -> listed
const IST_OFFSET = "+05:30";
const cutoffHM = i => {
  const m = String(i.upiCutoff || "").match(/up ?to ([0-9]{1,2})[:.]([0-9]{2}) *([ap])/i);   // "(upto 7:00 PM)" or "Upto 5.00 P.M."
  if (!m) return "17:00";                                                                     // NSE market timings: bidding ends at 5:00 PM
  let h = +m[1] % 12; if (m[3].toLowerCase() === "p") h += 12;
  return String(h).padStart(2, "0") + ":" + m[2];
};
const endAt = i => i.close ? new Date(i.close + "T" + cutoffHM(i) + ":00" + IST_OFFSET).getTime() : null;   // last moment to apply, in absolute time
const endLabel = i => { const [h, m] = cutoffHM(i).split(":").map(Number); return ((h + 11) % 12 + 1) + ":" + String(m).padStart(2, "0") + " " + (h >= 12 ? "PM" : "AM"); };
function phase(i, now = Date.now()) {
  if (i.status === "upcoming") return { k: "apply" };
  const end = endAt(i);
  if (i.status === "live" && (end === null || now < end)) return { k: "apply", end: end && i.close === isoLocal(today) ? end : null, tl: "Closes in", sub: "by " + endLabel(i) };
  if (i.listingPerf || (!i.allotment && !i.listing) || (i.listing && dayDiff(i.listing) < 0)) return { k: "listed" };
  const ex = i.datesExpected ? " (exp.)" : "";
  if (i.listing && dayDiff(i.listing) === 0) { const t = new Date(i.listing + "T10:00:00" + IST_OFFSET).getTime(); return { k: "listingToday", label: "🔔 Listing today", end: t > now ? t : null, tl: "Listing in", sub: "10:00 AM" }; }
  if (i.allotment && dayDiff(i.allotment) < 0) return { k: "listing", label: "📈 Listing on " + fmtD(i.listing) + ex, end: i.listing ? new Date(i.listing + "T10:00:00" + IST_OFFSET).getTime() : null, tl: "Listing in", sub: "10:00 AM" };
  if (i.allotment && dayDiff(i.allotment) === 0) return { k: "allotDay", label: "✅ Allotment day: check your status" };
  return { k: "wait", label: "⏳ Waiting for allotment" + (i.allotment ? " · " + fmtD(i.allotment) + ex : ""), end: i.allotment ? new Date(i.allotment + "T00:00:00" + IST_OFFSET).getTime() : null, tl: "Allotment day starts in", sub: i.allotment ? fmtD(i.allotment) + ex : "" };
}
const pad2 = n => String(n).padStart(2, "0");
const fmtCd = ms => { const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d > 0 ? d + "d " + pad2(h) + "h " + pad2(m) + "m " : h > 0 ? h + "h " + pad2(m) + "m " : m + "m ") + pad2(s % 60) + "s"; };
// the live countdown (numbers are updated every second by tick() at the end of this file)
const cdFor = i => { const p = phase(i); if (!p.end || p.end <= Date.now()) return ""; return `<div class="cd${p.k === "apply" ? (p.end - Date.now() < 3600e3 ? " urgent" : "") : " soft"}" data-end="${p.end}" data-k="${p.k}">⏱ ${p.tl} <b data-cdtxt>${fmtCd(p.end - Date.now())}</b>${p.sub ? ` <span>(${p.sub})</span>` : ""}</div>`; };
// the button (or the status that replaces it once bidding is over)
function actionBtn(i, wide) {
  const p = phase(i), w = wide ? ' style="width:100%"' : "";
  if (p.k === "apply") return `<button class="btn ${preApply(i) ? "pre" : ""}" data-apply="${i.symbol}"${w}>${applyLabel(i)}</button>`;
  if (p.k === "allotDay") return `<button class="btn allotbtn" data-allot-open="${i.symbol}"${w}>${p.label}</button>`;
  if (p.k === "listed") return "";
  return `<div class="phase ${p.k}">${p.label}</div>`;
}
function stLabel(i) {
  if (i.status !== "listed" && !i.close && !i.open) return `<span class="st gray">Dates not announced</span>`;
  if (i.status === "live" && !i.close) return `<span class="st red">● Open now</span>`;
  if (i.status === "upcoming" && !i.open) return `<span class="st blue">Upcoming</span>`;
  if (notOpenYet(i)) return `<span class="st blue" data-end="${opensAt(i)}" data-k="open">Opens today · 10:00 AM</span>`;
  if (i.status === "live" && i.close && dayDiff(i.close) === 0 && endAt(i) && Date.now() >= endAt(i)) return `<span class="st gray">Bidding closed</span>`;
  if (i.status === "live") { const d = dayDiff(i.close); return `<span class="st red">● ${d === 0 ? "Closes Today" : `Closes in ${d} day${d > 1 ? "s" : ""}`}</span>`; }
  if (i.status === "upcoming") { const o = dayDiff(i.open); return `<span class="st blue">Opens in ${o} day${o > 1 ? "s" : ""}</span>`; }
  return `<span class="st grn">Closed</span>`;
}
// Pre-apply: the IPO has not opened yet but the price band is out, so brokers/UPI apps let you place the bid in advance
const opensAt = i => i.open ? new Date(i.open + "T10:00:00" + IST_OFFSET).getTime() : null;
const notOpenYet = i => i.status === "live" && !!i.open && i.open === isoLocal(today) && Date.now() < opensAt(i);
const preApply = i => (i.status === "upcoming" || notOpenYet(i)) && isNum(i.priceHigh) && i.priceHigh > 0 && !!i.open;
const applyLabel = i => preApply(i) ? "Pre Apply" : "Apply";
// Broker / platform IPO pages: an IPO bid is placed through a broker or a UPI app, there is no single official site to apply on
const BROKERS = [["Zerodha", "https://zerodha.com/ipo"], ["Groww", "https://groww.in/ipo"], ["Upstox", "https://upstox.com/ipo/"], ["Angel One", "https://www.angelone.in/ipo"], ["5paisa", "https://www.5paisa.com/ipo"],
  ["ICICI Direct", "https://www.icicidirect.com/ipo"], ["HDFC Securities", "https://www.hdfcsec.com/ipo"], ["Kotak Neo", "https://www.kotakneo.com/ipo/"], ["Paytm Money", "https://www.paytmmoney.com/ipo"], ["Sharekhan", "https://www.sharekhan.com/ipo"]];
const price = i => isNum(i.priceLow) ? `₹${i.priceLow} - ₹${i.priceHigh}` : isNum(i.priceHigh) ? `₹${i.priceHigh}` : "—";
// Registrar allotment-status pages (public), matched by the registrar name NSE gives us
// [name part, address, kind]: "status" = the page where you enter your PAN / application number; "site" = the registrar's own website (find "IPO status" there)
const REGISTRARS = [["kfin", "https://ipostatus.kfintech.com/", "status"], ["link intime", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html", "status"], ["mufg", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html", "status"],
  ["skyline", "https://www.skylinerta.com/ipo.php", "status"], ["bigshare", "https://ipo.bigshareonline.com/IPO_Status.html", "status"], ["cameo", "https://ipostatus1.cameoindia.com/", "status"], ["purva", "https://www.purvashare.com/investor-service/ipo-query", "status"],
  ["maashitla", "https://maashitla.com/allotment-status", "status"], ["mas services", "https://www.masserv.com/", "site"], ["integrated", "https://www.integratedregistry.in/", "site"], ["beetal", "https://beetal.in/", "site"]];
const BSE_STATUS = "https://www.bseindia.com/investors/appli_check.aspx";
const registrarLink = i => { const n = (i.registrar?.name || "").toLowerCase(), r = REGISTRARS.find(([k]) => n.includes(k)); return r ? { url: r[1], kind: r[2] } : null; };
const fmtGain = p => isNum(p) ? `<span class="${p >= 0 ? "grn-t" : "red-t"}">${p >= 0 ? "+" : ""}${p.toFixed(1)}%</span>` : "—";
function listCard(i) {
  const sc = scoreOf(i), v = verdict(sc.score), t = totalTimes(i), g = gmpNow(i);
  return `<div class="card ipoc" data-open="${i.symbol}"><div class="row"><span class="pill">${i.board}</span>${stLabel(i)}</div>
  <div class="ipo-h">${logo(i)}<div style="flex:1"><h3>${esc(i.name)}</h3><div class="mut" style="margin-top:3px">Offer Date : ${fmtS(i.open)} to ${fmtD(i.close)}</div><div class="mut">Issue Size : ${isNum(i.issueSizeCr) ? "₹" + cr(i.issueSizeCr) + " Cr" : "—"}</div></div>
  <div style="text-align:center">${ring(sc.score)}<span class="badge ${v.c}" style="font-size:10px;margin-top:5px">${v.t}</span></div></div>
  <div class="g3"><div>Allotment ${i.datesExpected ? "(exp.)" : ""}<b>${fmtD(i.allotment)}</b></div><div>Offer Price<b>${price(i)}</b></div><div>Listing ${i.datesExpected ? "(exp.)" : ""}<b>${fmtD(i.listing)}</b></div></div>
  <div class="g3"><div>Lot size<b>${isNum(i.lot) ? i.lot + " Shares" : "—"}</b></div><div>${i.listingPerf ? "Day-1 gain" : "Subs"}<b>${i.listingPerf ? fmtGain(i.listingPerf.dayOpenGainPct) : isNum(t) ? f2(t) + "x" : "—"}</b></div>
  <div class="${isNum(g) ? (g >= 0 ? "grn-t" : "red-t") : "mut"}">GMP (Rumors)<b>${gmpTxt(i)}</b></div></div>
  ${cdFor(i)}<div class="acts"><button class="btn ghost" data-open="${i.symbol}">View</button><button class="btn ghost ai" data-open="${i.symbol}" data-jump="ai">✨ Ai</button>
  ${actionBtn(i)}</div></div>`;
}
const brand = () => `<div class="brand"><button class="menubtn" data-menu aria-label="Open menu">☰ Menu</button><img src="icons/logo.svg" alt="" width="28" height="28"><span>Trendy <b>IPO</b></span><button class="ib brefresh${state.refreshing ? " spin" : ""}" data-refresh aria-label="Refresh data" title="Refresh data">🔄</button></div>`;
const head = (title, extra = "") => `${brand()}<div class="top"><h1>${title}</h1>${extra}</div>`;
// GMP trend: one point per day, the last one is today. Hover (mouse) or touch/drag (phone) on the chart shows that day's date and rate.
let GCH = [];
function gmpDay(p, k, arr) {
  const prev = k > 0 ? arr[k - 1].gmp : null, d = prev === null ? null : p.gmp - prev;
  const when = p.date === istDay() ? "Today" : fmtD(p.date), wd = pd(p.date).toLocaleDateString("en-IN", { weekday: "short" });
  const chg = d === null ? "first record" : d === 0 ? "no change from the day before" : `<span class="${d > 0 ? "grn-t" : "red-t"}">${d > 0 ? "▲ up" : "▼ down"} ₹${Math.abs(d % 1 ? +d.toFixed(1) : d)}</span> from the day before`;
  return `<b>${when}</b> <span class="mut">(${wd}${p.date === istDay() ? ", " + fmtD(p.date) : ""})</span><br>GMP <b class="${p.gmp >= 0 ? "grn-t" : "red-t"}">₹${p.gmp}</b> · ${chg}`;
}
function gmpChart(hist) {
  const h = (hist || []).filter(x => x && isNum(x.gmp) && x.date).sort((a, b) => a.date < b.date ? -1 : 1);
  if (h.length < 2) return "";
  GCH = h;
  const W = 320, H = 150, L = 40, R = 12, T = 12, B = 26, v = h.map(x => x.gmp), mn = Math.min(...v), mx = Math.max(...v), pad = (mx - mn || Math.abs(mx) || 1) * .15;
  const lo = mn - pad, hi = mx + pad, X = k => L + k * (W - L - R) / (h.length - 1), Y = g => T + (hi - g) / (hi - lo) * (H - T - B);
  const up = last(v) >= v[0], c = up ? "var(--ok)" : "var(--bad)", pts = h.map((x, k) => `${X(k).toFixed(1)},${Y(x.gmp).toFixed(1)}`).join(" ");
  const ticks = [mx, (mx + mn) / 2, mn].filter((t, k, a) => a.indexOf(t) === k).map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--bd)" stroke-dasharray="3 4"/><text x="${L - 5}" y="${Y(t) + 3.5}" text-anchor="end" class="gax">₹${Math.round(t)}</text>`).join("");
  const dl = k => pd(h[k].date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const idx = [...new Set([0, Math.floor((h.length - 1) / 2), h.length - 1])];
  const xl = idx.map(k => `<text x="${X(k)}" y="${H - 7}" text-anchor="${k === 0 ? "start" : k === h.length - 1 ? "end" : "middle"}" class="gax">${k === h.length - 1 && h[k].date === istDay() ? "Today" : dl(k)}</text>`).join("");
  const dots = h.map((x, k) => `<circle class="gdot${k === h.length - 1 ? " on" : ""}" data-k="${k}" cx="${X(k)}" cy="${Y(x.gmp)}" r="${k === h.length - 1 ? 5 : 3.5}" fill="${c}"/>`).join("");
  return `<div class="gch" data-n="${h.length}" data-l="${L}" data-r="${R}" data-w="${W}"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="GMP trend by day">${ticks}<polyline fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" points="${pts}"/><line class="gcur" x1="${X(h.length - 1)}" x2="${X(h.length - 1)}" y1="${T}" y2="${H - B}"/>${dots}${xl}</svg>
  <div class="gread" aria-live="polite">${gmpDay(h[h.length - 1], h.length - 1, h)}</div><div class="mut sm">${h.length} days recorded · move your cursor or finger over the line to see any day</div></div>`;
}
function gmpPick(e) {
  const box = e.target.closest?.(".gch"); if (!box) return;
  const svg = box.querySelector("svg"), r = svg.getBoundingClientRect(), n = +box.dataset.n, W = +box.dataset.w, L = +box.dataset.l, Rr = +box.dataset.r;
  const x = (e.clientX - r.left) / r.width * W, k = Math.max(0, Math.min(n - 1, Math.round((x - L) / (W - L - Rr) * (n - 1)))), p = GCH[k];
  if (!p) return;
  box.querySelector(".gread").innerHTML = gmpDay(p, k, GCH);
  box.querySelectorAll(".gdot").forEach(d => d.classList.toggle("on", +d.dataset.k === k));
  const cur = box.querySelector(".gcur"), cx = L + k * (W - L - Rr) / (n - 1); cur.setAttribute("x1", cx); cur.setAttribute("x2", cx);
}
["pointermove", "pointerdown", "click"].forEach(t => document.addEventListener(t, gmpPick));
const tbl = (head, rows) => `<div class="tw"><table><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${c ?? "—"}</td>`).join("")}</tr>`).join("")}</table></div>`;
const card = (title, inner, id = "") => `<div class="card" ${id ? `id="${id}"` : ""}>${title ? `<h2>${title}</h2>` : ""}${inner}</div>`;

// ---------- screens ----------
// ---------- dashboard extras: insights, this week's calendar, recent listings ----------
const shortName = n => n.replace(/[ ]+(Limited|Ltd|Ltd[.])$/i, "");
function insights() {
  const open = state.ipos.filter(i => i.status === "live" && boardOk(i));
  const best = (arr, f) => arr.filter(i => isNum(f(i))).sort((x, y) => f(y) - f(x))[0];
  const g = best(open, gmpPct), s = best(open.filter(i => i.status === "live"), totalTimes), sc = best(open, score), closingNow = open.filter(isClosingToday);
  const card = (icon, label, value, sub, cls, sym) => `<div class="ins${sym ? " ipoc" : ""}" ${sym ? `data-open="${sym}"` : ""}><div class="insl"><i>${icon}</i>${label}</div><b class="${cls}">${value}</b><div class="mut sm insn">${sub}</div></div>`;
  const cards = [
    g && card("🚀", "Highest GMP", "₹" + gmpNow(g), `${esc(shortName(g.name))} · ${gmpPct(g).toFixed(0)}%`, gmpNow(g) >= 0 ? "grn-t" : "red-t", g.symbol),
    s && card("🔥", "Most subscribed", f2(totalTimes(s)) + "x", esc(shortName(s.name)), "", s.symbol),
    sc && card("⭐", "Top score", score(sc) + "/100", esc(shortName(sc.name)), "", sc.symbol),
    card("⏰", "Closing today", String(closingNow.length), closingNow.length ? closingNow.map(i => esc(shortName(i.name))).join(", ") : "No IPO closes today", closingNow.length ? "red-t" : "")
  ].filter(Boolean);
  return `<div class="insights">${cards.join("")}</div>`;
}
// everything that happens in the next 7 days: opens, closes, allotment, listing
function calendarCard(status, days) {
  const ev = [];
  for (const i of state.ipos) {
    if (!boardOk(i) || i.status !== status) continue;
    for (const [k, label, cls] of [["open", "Opens", "c-open"], ["close", "Closes", "c-close"], ["allotment", "Allotment", "c-allot"], ["listing", "Listing", "c-list"]]) {
      const d = i[k], n = dayDiff(d);
      if (d && n !== null && n >= 0 && n <= days && (k !== "open" || i.status === "upcoming")) ev.push({ d, n, label, cls, i, est: i.datesExpected && (k === "allotment" || k === "listing") });
    }
  }
  ev.sort((x, y) => x.d.localeCompare(y.d) || x.label.localeCompare(y.label));
  const rows = ev.slice(0, 12).map(e => {
    const dt = pd(e.d);
    return `<div class="calrow ipoc" data-open="${e.i.symbol}"><div class="calday"><b>${dt.getDate()}</b><span>${dt.toLocaleString("en-IN", { month: "short" })}</span></div>
      ${logo(e.i)}<div class="calmain"><div class="calname">${esc(shortName(e.i.name))}</div><div class="mut sm">${e.n === 0 ? "Today" : e.n === 1 ? "Tomorrow" : dt.toLocaleDateString("en-IN", { weekday: "long" })}</div></div><span class="calchip ${e.cls}">${e.label}${e.est ? " (exp.)" : ""}</span></div>`;
  }).join("");
  return `<div class="card dcard"><h2>📅 ${status === "live" ? "Live IPOs" : "Upcoming IPOs"} · next ${days} days</h2>${rows || `<p class="mut sm">No events in the next ${days} days.</p>`}</div>`;
}
// day-1 gain of the latest listings, drawn to one scale
function recentCard() {
  const gain = i => i.listingPerf?.dayOpenGainPct;
  const all = state.ipos.filter(i => i.status === "listed" && isNum(gain(i)) && boardOk(i));
  const rows = all.slice().sort((x, y) => (y.listing || "").localeCompare(x.listing || "")).slice(0, 8);
  if (!rows.length) return "";
  const mx = Math.max(...rows.map(i => Math.abs(gain(i))), 1), up = all.filter(i => gain(i) >= 0).length, avg = all.reduce((s, i) => s + gain(i), 0) / all.length;
  return `<div class="card dcard"><h2>📊 Recent listings · Day-1</h2><p class="mut sm" style="margin:-4px 0 10px">${up} of ${all.length} listed in gain · average ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%</p>
    ${rows.map(i => { const v = gain(i); return `<div class="brow ipoc" data-open="${i.symbol}"><span class="bn">${esc(shortName(i.name))}</span><span class="btrack"><i class="${v >= 0 ? "up" : "dn"}" style="width:${Math.max(3, Math.abs(v) / mx * 100)}%"></i></span><b class="${v >= 0 ? "grn-t" : "red-t"}">${v >= 0 ? "+" : ""}${v.toFixed(1)}%</b></div>`; }).join("")}
    <p class="mut sm" style="margin:10px 0 0">Gain at the first trade vs issue price (Yahoo Finance).</p></div>`;
}

function ipoTab() {
  const pool = state.ipos.filter(boardOk), gainOf = i => i.listingPerf?.dayOpenGainPct;
  const isGain = i => isNum(gainOf(i)) && gainOf(i) >= 0, isLoss = i => isNum(gainOf(i)) && gainOf(i) < 0;
  const cnt = { live: pool.filter(i => i.status === "live").length, upcoming: pool.filter(i => i.status === "upcoming").length, listed: pool.filter(i => i.status === "listed").length,
    gain: pool.filter(i => i.status === "listed" && isGain(i)).length, loss: pool.filter(i => i.status === "listed" && isLoss(i)).length };
  const active = state.seg === "listed" && state.perf ? state.perf : state.seg;
  let list = pool.filter(i => i.status === state.seg);
  if (state.seg === "listed" && state.perf) list = list.filter(state.perf === "gain" ? isGain : isLoss);
  if (state.q) list = list.filter(i => i.name.toLowerCase().includes(state.q.toLowerCase()));
  const nn = (a, b) => (b ?? -1e9) - (a ?? -1e9);
  const sorters = { score: (a, b) => nn(score(a), score(b)), gmp: (a, b) => nn(gmpPct(a), gmpPct(b)), subs: (a, b) => nn(totalTimes(a), totalTimes(b)), date: (a, b) => (a.open || "").localeCompare(b.open || "") };
  list.sort(sorters[state.sort]);
  const closingToday = state.seg === "live" ? list.filter(isClosingToday) : [];
  if (closingToday.length) list = list.filter(i => !isClosingToday(i));   // shown in their own block above
  const cand = state.ipos.filter(i => i.status === state.seg && score(i) !== null && boardOk(i)), top = cand.sort((a, b) => score(b) - score(a))[0];
  const shown = state.seg === "listed" && !state.showAll && !state.q ? list.slice(0, 12) : list;
  const stat = ([k, l, c]) => `<button class="stat ${active === k ? "on" : ""}" data-stat="${k}"><span>${l}</span><b class="${c}">${cnt[k]}</b></button>`;
  return `${head('Live Subscription <sup style="color:var(--bad);font-size:11px">New</sup>', `<button class="ib" data-search>🔍</button><button class="ib" data-tab="settings">🔔</button>`)}
  ${state.search ? `<input id="q" placeholder="Search IPO" value="${esc(state.q)}">` : ""}
  <div class="stats">${[["live", "Open IPOs", ""], ["upcoming", "Upcoming IPOs", ""], ["listed", "Closed IPOs", ""], ["gain", "Listed in gains", "grn-t"], ["loss", "Listed in loss", "red-t"]].map(stat).join("")}</div>
  <div class="seg">${["live", "upcoming", "listed"].map(s => `<button data-seg="${s}" class="${state.seg === s ? "on" : ""}">${s === "listed" ? "Closed" : s[0].toUpperCase() + s.slice(1)}</button>`).join("")}</div>
  <div class="opts"><label><input type="checkbox" data-board="main" ${state.main ? "checked" : ""}> MainBoard</label><label><input type="checkbox" data-board="sme" ${state.sme ? "checked" : ""}> SME</label><span class="sp"></span>
  <select id="sort" style="width:auto;margin:0;padding:6px"><option value="score" ${state.sort === "score" ? "selected" : ""}>Sort: Score</option><option value="gmp" ${state.sort === "gmp" ? "selected" : ""}>Sort: GMP %</option><option value="subs" ${state.sort === "subs" ? "selected" : ""}>Sort: Subscription</option><option value="date" ${state.sort === "date" ? "selected" : ""}>Sort: Open date</option></select></div>
  ${top && state.seg !== "listed" && !state.q ? `<div class="note" style="margin:0 0 12px">🏆 <b>Highest score:</b> ${esc(top.name)} — ${score(top)}/100 (${verdict(score(top)).t})</div>` : ""}
  ${state.seg === "live" && !state.q ? insights() : ""}
  ${state.seg === "listed" && !state.q ? `<div class="two">${recentCard()}</div>` : ""}
  ${state.seg === "listed" ? outcomes() : ""}
  ${closingBlock(closingToday)}
  ${state.seg === "upcoming" ? upDashboard() : (shown.length ? `<div class="cards">${shown.map(listCard).join("")}</div>` : (closingToday.length ? "" : '<p class="mut" style="text-align:center;margin-top:40px">No IPOs in this category.</p>'))}
  ${shown.length < list.length ? `<button class="btn ghost morebtn" data-more>Show all ${list.length}</button>` : ""}
  ${state.seg === "upcoming" && !state.q ? `<div class="two">${calendarCard("upcoming", 14)}</div>` : ""}
  ${state.seg === "upcoming" ? gmpNote() + filingsBlock() : ""}
  <p class="disc">Live data: NSE India, SEBI, RHP documents; GMP from ipowatch.in + investorgain.com (unofficial). Updated ${state.meta ? new Date(state.meta.generatedAt).toLocaleString("en-IN") : "—"}. Not investment advice.</p>`;
}

// How close did our GMP and our score come to the real day-1 open? Built only from stored data (GMP history, Yahoo day-1 open, the score formula).
// GMP: the last reading on or before listing day, as % of the issue price, compared with the actual day-1 gain. Close = within 5 points, Near = within 10.
// Score: 60+ means "expects no loss on day 1" (open at or above the issue price), below 60 means "expects a loss"; matched when the real day-1 open agrees.
function listingMatch(i) {
  const lp = i.listingPerf; if (!lp || !isNum(lp.dayOpenGainPct)) return null;
  const actual = lp.dayOpenGainPct;
  const h = (i.gmp?.history || []).filter(x => isNum(x.gmp) && (!lp.listDate || x.date <= lp.listDate));
  const g = h.length ? h[h.length - 1].gmp : null, gmpP = isNum(g) && i.priceHigh > 0 ? g / i.priceHigh * 100 : null;
  const err = gmpP === null ? null : actual - gmpP, a = err === null ? null : Math.abs(err);
  const s = score(i);
  return { actual, gmp: g, gmpP, err, gmpHit: a === null ? null : a <= 5 ? "close" : a <= 10 ? "near" : "miss", score: s, scoreHit: s === null ? null : (s >= 60) === (actual >= 0) };
}
const GMP_HIT = { close: `<span class="grn-t">✅ Close</span>`, near: `<span style="color:var(--warn)">⚠️ Near</span>`, miss: `<span class="red-t">❌ Missed</span>` };
const fmtPts = e => isNum(e) ? `<span class="${Math.abs(e) <= 5 ? "grn-t" : Math.abs(e) <= 10 ? "" : "red-t"}">${e >= 0 ? "+" : ""}${e.toFixed(1)} pts</span>` : "—";
const SCORE_HIT = h => h === null ? "—" : h ? `<span class="grn-t">✅ Matched</span>` : `<span class="red-t">❌ Not matched</span>`;
// Closed tab: how did our GMP and score compare with what actually happened on listing?
function outcomes() {
  const rows = state.ipos.map(i => ({ i, m: listingMatch(i) })).filter(r => r.m && (r.m.gmpP !== null || r.m.score !== null)).sort((a, b) => (b.i.listing || "").localeCompare(a.i.listing || ""));
  if (rows.length < 2) return "";
  const g = rows.filter(r => r.m.gmpHit), s = rows.filter(r => r.m.scoreHit !== null);
  const close = g.filter(r => r.m.gmpHit === "close").length, near = g.filter(r => r.m.gmpHit === "near").length;
  const avg = g.length ? g.reduce((a, r) => a + Math.abs(r.m.err), 0) / g.length : null, hit = s.filter(r => r.m.scoreHit).length;
  const sum = `<div class="stats" style="margin:0 0 10px">${g.length ? `<div class="stat" style="cursor:default"><b>${close}/${g.length}</b><span>GMP close (within 5 pts)</span></div><div class="stat" style="cursor:default"><b>${close + near}/${g.length}</b><span>GMP within 10 pts</span></div><div class="stat" style="cursor:default"><b>${avg.toFixed(1)} pts</b><span>Average GMP miss</span></div>` : ""}${s.length ? `<div class="stat" style="cursor:default"><b>${hit}/${s.length}</b><span>Score matched the outcome</span></div>` : ""}</div>`;
  return card("📊 GMP & score vs actual listing", sum + tbl(["IPO", "Score", "GMP at listing", "Actual day-1 open", "GMP vs actual", "Score"], rows.map(({ i, m }) => [esc(i.name), m.score ?? "—", m.gmpP === null ? "—" : `₹${m.gmp} ${fmtGain(m.gmpP)}`, fmtGain(m.actual), m.gmpHit ? `${fmtPts(m.err)} ${GMP_HIT[m.gmpHit]}` : "—", SCORE_HIT(m.scoreHit)])) +
    `<p class="mut sm"><b>GMP</b> = last grey-market reading on or before listing day, as % of the issue price. "GMP vs actual" = actual day-1 gain minus the GMP % (✅ within 5 points, ⚠️ within 10). <b>Score</b> 60+ expects no loss (day-1 open at or above the issue price), below 60 expects a loss; "Matched" means the real day-1 open agreed. Day-1 open is from Yahoo Finance and can differ slightly from the exchange's discovered listing price. GMP is rumour data; this is information, not investment advice.</p>`);
}
// SEBI DRHP / RHP filings = companies that have filed but not announced a price band yet
// Dashboard: every IPO that has not opened yet, soonest first, with its current GMP
const gmpNote = () => `<div class="note sm" style="margin:10px 0 12px"><b>${lang() === "hi" ? "GMP क्या है?" : "What is GMP?"}</b><br>${TEXT.gmpInfo[lang()]}${langBtn()}</div>`;
const boardOk = i => (state.main && i.board === "Mainboard") || (state.sme && i.board === "SME");
const upList = () => state.ipos.filter(i => i.status === "upcoming" && boardOk(i)).sort((a, b) => (a.open || "9999").localeCompare(b.open || "9999"));
// lowest / highest GMP seen so far (InvestorGain gives the range, otherwise the spread between sources)
function gmpSeen(i) {
  const s = i.gmp?.sources || [], lo = s.map(x => x.seenLow).filter(isNum), hi = s.map(x => x.seenHigh).filter(isNum);
  return lo.length ? [Math.min(...lo), Math.max(...hi)] : (i.gmp && i.gmp.min !== i.gmp.max ? [i.gmp.min, i.gmp.max] : null);
}
// ---- IPOs whose bidding ends today: last chance, shown first on the Live tab
const isoLocal = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const isClosingToday = i => i.status === "live" && i.close === isoLocal(today) && (endAt(i) === null || Date.now() < endAt(i));
function closeRow(i) {
  const t = totalTimes(i), g = gmpNow(i), N = retailN(i), sc = scoreOf(i);
  const gcls = isNum(g) ? (g >= 0 ? "grn-t" : "red-t") : "mut";
  return `<div class="uprow closing" data-open="${i.symbol}">
    <div class="datebox"><b>${isNum(t) ? (t >= 100 ? Math.round(t) : t.toFixed(t >= 10 ? 1 : 2)) + "x" : "—"}</b><span>SUBS</span><em>total</em></div>
    ${logo(i)}<div class="upmain"><div class="upname">${esc(i.name)}</div>
      <div class="mut sm"><span class="pill sm">${i.board}</span> ${isNum(i.priceHigh) && i.priceHigh > 0 ? price(i) : "Price —"}${isNum(i.lot) ? " · Lot " + i.lot : ""}${isNum(i.lot) && i.priceHigh ? " · ₹" + inr(i.lot * i.priceHigh) : ""}</div>
      <div class="mut sm">${N !== null && isNum(i.bids?.retail?.times) ? "Retail " + f2(i.bids.retail.times) + "x (≈1 in " + N + ")" : "Retail subscription —"}${sc.score !== null ? " · Score " + sc.score : ""}</div>
      <div class="dots sm">${(() => { const e = endAt(i); return e && e > Date.now() ? `<span class="wait cdline${e - Date.now() < 3600e3 ? " urgent" : ""}" data-end="${e}">⏱ Closes in <b data-cdtxt>${fmtCd(e - Date.now())}</b> (by ${endLabel(i)})</span>` : `<span class="wait">Last day · allotment ${i.allotment ? fmtS(i.allotment) : "—"}</span>`; })()}</div></div>
    <div class="upgmp">${isNum(g) ? `<div class="gmpnum ${gcls}">₹${g}</div><div class="mut sm">GMP${isNum(gmpPct(i)) ? " " + gmpPct(i).toFixed(0) + "%" : ""}</div>` : `<div class="mut sm" style="text-align:right">No GMP<br>yet</div>`}</div></div>`;
}
function closingBlock(list) {
  if (!list.length) return "";
  return `<div class="closebox"><h2 style="margin:0 0 4px;color:var(--bad)">🔥 Closing today (${list.length})</h2><p class="mut sm" style="margin:0 0 10px">Last day to apply. Bidding usually ends at 5:00 PM for MainBoard (SME may end earlier): apply through your broker/UPI app well before the cut-off.</p><div class="cards">${list.map(closeRow).join("")}</div></div>`;
}
// compact row: date box | name, price, dates | GMP. Tap opens the details.
function upRow(i) {
  const n = dayDiff(i.open), g = gmpNow(i), hasPrice = isNum(i.priceHigh) && i.priceHigh > 0, sc = scoreOf(i);
  const minInv = isNum(i.lot) && hasPrice ? i.lot * i.priceHigh : null;
  const docOk = (i.documents || []).some(d => /prospectus|rhp|zip from (nse|bse)/i.test(d.label)) || !!i.fundamentals;
  const d = i.open ? pd(i.open) : null;
  const when = n === null ? "Date TBA" : n <= 0 ? "Opens today" : n === 1 ? "Opens tomorrow" : `in ${n} days`;
  const gcls = isNum(g) ? (g >= 0 ? "grn-t" : "red-t") : "mut";
  return `<div class="uprow" data-open="${i.symbol}">
    <div class="datebox">${d ? `<b>${d.getDate()}</b><span>${d.toLocaleString("en-IN", { month: "short" }).toUpperCase()}</span>` : "<b>TBA</b>"}<em>${when}</em></div>
    ${logo(i)}<div class="upmain"><div class="upname">${esc(i.name)}</div>
      <div class="mut sm"><span class="pill sm">${i.board}</span> ${hasPrice ? price(i) : "Price band awaited"}${isNum(i.lot) ? " · Lot " + i.lot : ""}${minInv ? " · ₹" + inr(minInv) : ""}</div>
      <div class="mut sm">Closes ${i.close ? fmtS(i.close) : "—"} · Listing ${i.listing ? fmtS(i.listing) + (i.datesExpected ? "*" : "") : "—"}${isNum(i.issueSizeCr) ? " · ₹" + cr(i.issueSizeCr) + " Cr" : ""}</div>
      <div class="dots sm"><span class="${hasPrice ? "ok" : "wait"}">● Price band</span><span class="${docOk ? "ok" : "wait"}">● Offer doc</span>${preApply(i) ? `<span class="prea">✔ Pre-apply open</span>` : ""}${sc.score !== null ? `<span class="ok">● Score ${sc.score}</span>` : ""}</div></div>
    <div class="upgmp">${isNum(g) ? `<div class="gmpnum ${gcls}">₹${g}</div><div class="mut sm">GMP${isNum(gmpPct(i)) ? " " + gmpPct(i).toFixed(0) + "%" : ""}</div>` : `<div class="mut sm" style="text-align:right">No GMP<br>yet</div>`}</div>
  </div>`;
}
// summary + grouped list: this week / next week / later / date not announced
function upDashboard() {
  const ups = upList();
  if (!ups.length) return `<p class="mut" style="text-align:center;margin-top:30px">No upcoming IPOs right now.</p>`;
  const wk = ups.filter(i => { const n = dayDiff(i.open); return n !== null && n <= 7; }).length;
  const top = ups.filter(i => isNum(gmpNow(i))).sort((a, b) => gmpNow(b) - gmpNow(a))[0];
  const groups = [["This week", i => { const n = dayDiff(i.open); return n !== null && n <= 7; }], ["Next week", i => { const n = dayDiff(i.open); return n !== null && n > 7 && n <= 14; }], ["Later", i => { const n = dayDiff(i.open); return n !== null && n > 14; }], ["Dates not announced", i => dayDiff(i.open) === null]];
  return `<div class="tiles" style="margin-bottom:12px"><div class="tile ut ut1"><i>📅</i>Upcoming<b>${ups.length}</b></div><div class="tile ut ut2"><i>⏰</i>Opening in 7 days<b>${wk}</b></div><div class="tile ut ut3"><i>🚀</i>Highest GMP<b>${top ? "₹" + gmpNow(top) : "—"}</b><span class="mut sm">${top ? esc(top.name.split(" ").slice(0, 2).join(" ")) : ""}</span></div></div>` +
    groups.map(([t, f], gi) => { const l = ups.filter(f); return l.length ? `<h2 class="grp gp${gi}">${t} (${l.length})</h2><div class="cards">${l.map(upRow).join("")}</div>` : ""; }).join("") +
    `<p class="mut sm">* Allotment/listing dates are estimates until the issuer confirms them.</p>`;
}
const TYPE_LABEL = { DRHP: "Draft prospectus", UDRHP: "Updated draft", Addendum: "Addendum", Abridged: "Abridged draft", Other: "Filing" };
// "OSWAL CABLES LIMITED" -> "Oswal Cables Limited"; names already in proper capitals are kept; initials and vowel-less acronyms stay capital ("PM CONA" -> "PM Cona")
const SMALL_WORDS = new Set(["and", "of", "the", "in", "for", "to", "on", "at", "by", "a", "an"]);
const niceName = n => {
  const t = String(n).trim().replace(/\s+/g, " ");
  if (t !== t.toUpperCase()) return t;
  return t.split(" ").map((w, k) => {
    const lw = w.toLowerCase(), letters = lw.replace(/[^a-z]/g, "");
    if (k > 0 && SMALL_WORDS.has(lw)) return lw;
    if (letters.length === 1 || (letters.length >= 2 && letters.length <= 4 && !/[aeiouy]/.test(letters)) || /^([a-z]\.)+[a-z]?\.?$/.test(lw)) return w.toUpperCase();
    return lw.replace(/(^|[^a-z'])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  }).join(" ");
};
// Companies that filed a draft/red-herring document with SEBI but have no IPO dates or price band yet
function filingRow(f) {
  const d = pd(f.date), ago = -dayDiff(f.date), g = f.gmp;
  return `<a class="uprow" href="${esc(safeUrl(f.url) || "#")}" target="_blank" rel="noopener noreferrer">
    <div class="datebox"><em style="margin:0 0 2px">FILED</em><b>${d.getDate()}</b><span>${d.toLocaleString("en-IN", { month: "short" }).toUpperCase()}</span></div>
    ${logo({ symbol: "IG-" + f.company, name: niceName(f.company), logo: f.logo })}<div class="upmain"><div class="upname">${esc(niceName(f.company))}</div>
      <div class="mut sm"><span class="pill sm">${esc(TYPE_LABEL[f.type] || f.type)}</span> ${ago <= 0 ? "today" : ago === 1 ? "yesterday" : ago + " days ago"}</div>
      <div class="mut sm">${f.open ? "Opens " + fmtS(f.open) + (f.close ? " – " + fmtS(f.close) : "") : "Dates, price band & size not announced"}</div>
      <div class="dots sm"><span class="wait">● Price band</span><span class="wait">● Dates</span><span class="ok">● SEBI document</span></div></div>
    <div class="upgmp">${isNum(g) ? `<div class="gmpnum ${g >= 0 ? "grn-t" : "red-t"}">₹${g}</div><div class="mut sm">GMP</div>` : `<div class="mut sm">No GMP<br>yet</div>`}<div class="sm" style="color:var(--pri);margin-top:4px">SEBI ↗</div></div></a>`;
}
function filingsBlock() {
  const all = (state.meta?.filings || []).slice().sort((x, y) => y.date.localeCompare(x.date));
  if (!all.length) return "";
  const week = all.filter(f => -dayDiff(f.date) <= 7), earlier = all.filter(f => -dayDiff(f.date) > 7), withGmp = all.filter(f => isNum(f.gmp)).length;
  return `<h2 style="margin:26px 0 4px">📋 To be announced <span class="mut sm">(filed with SEBI)</span></h2>
  <p class="mut sm" style="margin:0 0 10px">These companies have filed for an IPO but have not announced dates or a price band yet. Filing does not mean the IPO will happen soon.</p>
  <div class="tiles" style="margin-bottom:10px"><div class="tile ut ut1"><i>📋</i>Total<b>${all.length}</b></div><div class="tile ut ut2"><i>🆕</i>Filed last 7 days<b>${week.length}</b></div><div class="tile ut ut3"><i>📈</i>With GMP<b>${withGmp}</b></div></div>
  ${week.length ? `<h3 style="margin:12px 0 8px;font-size:13px" class="mut">Filed in the last 7 days</h3><div class="cards">${week.map(filingRow).join("")}</div>` : ""}
  ${earlier.length ? `<h3 style="margin:12px 0 8px;font-size:13px" class="mut">Earlier filings</h3><div class="cards">${earlier.map(filingRow).join("")}</div>` : ""}`;
}
const tlRow = (label, d, est) => [label, d ? `${fmtD(d)}${est ? " (exp.)" : ""}` : "—"];

// ---------- documents + full report ----------
const reportCard = i => `<div class="card"><button class="btn" data-report="${i.symbol}" style="width:100%">📄 Full company report</button><p class="mut sm" style="margin:8px 0 0">All documents (read or download) and the complete data for this company.</p></div>`;
const docIcon = d => d.kind === "pdf" || d.kind === "pdf-link" ? "📕" : d.kind === "link" ? "🔗" : d.kind === "zip" ? "🗜️" : "📄";
function docRow(d) {
  if (!safeUrl(d.url)) return "";                                  // a link that is not a normal web address is not shown
  const url = esc(safeUrl(d.url)), meta = [d.source, d.kind === "pdf" || d.kind === "pdf-link" ? "PDF" : d.kind === "zip" ? "ZIP" : null, d.sizeMB ? d.sizeMB + " MB" : null].filter(Boolean).join(" · ");
  const btns = d.kind === "pdf-link"
    ? `<a class="btn sm" href="${url}" target="_blank" rel="noopener noreferrer">Read</a><a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer">Download</a>`
    : d.hosted && d.kind === "pdf"
    ? `<a class="btn sm" href="${url}" target="_blank" rel="noopener noreferrer">Read</a><a class="btn sm ghost" href="${url}" download>Download</a>`
    : d.kind === "link" ? `<a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer">Open ↗</a>`
    : `<a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer" download>Download</a>`;
  return `<div class="docrow"><div class="docinfo"><b>${docIcon(d)} ${esc(d.label)}</b><div class="mut sm">${esc(meta)}</div></div><div class="docbtns">${btns}</div></div>`;
}
// all documents of an IPO, grouped; each hosted PDF can be read (opens in the browser's PDF viewer) or downloaded
function docsPanel(i) {
  const groups = {};
  for (const d of i.documents || []) (groups[d.group || "Other"] ||= []).push(d);
  const html = Object.entries(groups).map(([g, list]) => card(esc(g), list.map(docRow).join(""))).join("");
  return (html || card("📁 Documents", `<p class="mut sm">No documents published for this IPO yet.</p>`)) +
    `<p class="mut sm">Every file opens on the official NSE, BSE or SEBI website (nothing is stored in this app). Some NSE files come as a ZIP that your device unzips.</p>`;
}
// every field we hold for this IPO, for the full report
function rawRows(i) {
  const b = i.bids || {}, t = i.timeline || {}, R = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== "" && !(typeof v === "number" && !isFinite(v))) R.push([k, typeof v === "string" ? esc(v) : v]); };
  add("NSE symbol", i.symbol); add("Board", i.board); add("Status", i.status); add("Issue type", i.issueType);
  add("Price band", price(i)); add("Lot size", i.lot); add("Face value", i.faceValue); add("Issue size (₹ Cr)", i.issueSizeCr); add("Issue size (shares)", isNum(i.issueShares) ? inr(i.issueShares) : null);
  add("Max retail application (₹)", i.maxRetailAmount); add("Issue size details (NSE)", i.issueDetail); add("UPI cut-off (NSE)", i.upiCutoff);
  for (const [k, l] of [["open", "Opens"], ["close", "Closes"], ["allotment", "Allotment"], ["refund", "Refund"], ["demat", "Demat credit"], ["listing", "Listing"]]) add(l, t[k] ? fmtD(t[k]) + (i.datesExpected && k !== "open" && k !== "close" ? " (exp.)" : "") : null);
  for (const [k, l] of [["qib", "QIB"], ["nii", "NII"], ["bnii", "bNII"], ["snii", "sNII"], ["retail", "Retail"], ["employee", "Employees"], ["total", "Total"]]) if (b[k]) add(`Subscription — ${l}`, `${inr(b[k].offered)} offered · ${inr(b[k].bid)} bid · ${f2(b[k].times)}x`);
  if (i.gmp) { add("GMP (average)", `₹${i.gmp.value}`); add("GMP sources", i.gmp.sources.map(s => `${s.source} ₹${s.gmp}`).join(" · ")); add("GMP rating", i.gmp.rating ? "🔥".repeat(i.gmp.rating) : null); }
  add("Anchor book", i.anchor === true ? "Yes" : i.anchor === false ? "No" : null);
  add("Registrar", i.registrar?.name); add("Registrar address", i.registrar?.address); add("Registrar contact", i.registrar?.contact); add("Lead managers", i.leadManagers); add("Sponsor bank", i.sponsorBank);
  if (i.listingPerf) { add("Day-1 open", `₹${f2(i.listingPerf.dayOpen)} (${i.listingPerf.dayOpenGainPct}%)`); add("Last price", `₹${f2(i.listingPerf.ltp)} (${i.listingPerf.ltpGainPct}%)`); }
  if (i.verification) add("Data verification", `${i.verification.status.toUpperCase()}: ${i.verification.checked - i.verification.notFound} of ${i.verification.checked} extracted figures found in the ${i.verification.sourceDoc || "offer document"}${i.verification.issues?.length ? "; notes: " + i.verification.issues.join(" | ") : ""}`);
  const fz = FU(i); if (fz?.notes) add("Extraction notes (technical)", fz.notes);
  const sc = scoreOf(i); add("Trendy IPO score", sc.score === null ? "Insufficient data" : `${sc.score}/100 (${sc.coverage}% data coverage)`);
  add("Data fetched", i.fetchedAt ? new Date(i.fetchedAt).toLocaleString("en-IN") : null);
  return R;
}
function reportView() {
  const i = byId(state.report), tab = state.reportTab;
  const head = `<div class="noprint row" style="margin-bottom:10px"><button class="ib" data-report-close>←</button><b>${esc(i.name)}</b><span></span></div>
  <div class="seg noprint"><button data-rtab="docs" class="${tab === "docs" ? "on" : ""}">📁 Documents</button><button data-rtab="data" class="${tab === "data" ? "on" : ""}">📊 Company data</button></div>`;
  if (tab === "docs") return `<div class="report">${head}${docsPanel(i)}</div>`;
  const saved = state.detail; state.detail = i.symbol; const body = detail(true); state.detail = saved;
  return `<div class="report">${head}
  <div class="noprint row" style="margin-bottom:12px"><button class="btn" data-print>🖨 Print / Save as PDF</button></div>
  <div class="rep-head"><h1>${esc(i.name)}</h1><div class="mut sm">${i.board} · ${esc(i.symbol)} · Report generated ${new Date().toLocaleString("en-IN")} · Data as of ${state.meta ? new Date(state.meta.generatedAt).toLocaleString("en-IN") : "—"}</div></div>
  ${body}
  ${card("All data fields", tbl(["Field", "Value"], rawRows(i)))}
  ${card("Disclaimer / अस्वीकरण", `<p class="sm">${TEXT.disclaimer.en}</p><hr><p class="sm">${TEXT.disclaimer.hi}</p>`)}</div>`;
}


function detail(forReport = false) {
  const i = byId(state.detail), sc = scoreOf(i), v = verdict(sc.score), f = FU(i), b = i.bids || {}, g = gmpNow(i), L = isNum(i.lot) && isNum(i.priceHigh) && i.lot > 0 && i.priceHigh > 0 ? lotsFor(i) : null;
  const inW = state.watch.includes(i.symbol), t = totalTimes(i), N = retailN(i), { v: fv } = factors(i);
  const risk = N === null ? null : N > 10 ? ["LOW ALLOTMENT CHANCE", "r"] : N > 3 ? ["MODERATE ALLOTMENT CHANCE", "y"] : ["GOOD ALLOTMENT CHANCE", "g"];
  const pr = i.priceHigh, F = f?.financials || {}, K = f?.kpi || {}, per = f?.periods || [], rv = a => Array.isArray(a) ? [...a].reverse() : [];
  const fr = (label, a) => [label, ...rv(a).concat([null, null, null]).slice(0, per.length).map(x => isNum(x) ? cr(x) : "—")];
  const rows = [["QIB", b.qib], ["NII (total)", b.nii], ["NII > ₹10L (bNII)", b.bnii], ["NII ₹2-10L (sNII)", b.snii], ["Retail", b.retail], ["Employees", b.employee]].filter(r => r[1] && isNum(r[1].offered) && r[1].offered > 0);
  const anyBid = isNum(t);
  const dwRows = (i.subHistory || []).map(h => [fmtD(h.date), isNum(h.qib) ? f2(h.qib) + "x" : "—", isNum(h.nii) ? f2(h.nii) + "x" : "—", isNum(h.retail) ? f2(h.retail) + "x" : "—", `<b>${f2(h.total)}x</b>`]);
  const gh = (i.gmp?.history || []).map(x => x.gmp);
  const pa = peerAvg(i, "pe"), p = pe(i), iss = f?.issue || {};
  const tot = (iss.fresh_issue_cr || 0) + (iss.ofs_cr || 0);
  return `<div class="top"><button class="ib" data-back>←</button><h1>${esc(i.name)}</h1><button class="ib" data-share>⤴</button></div>
  <div class="dgrid"><div class="card"><div class="row"><span class="pill">${i.board}</span>${stLabel(i)}</div>
  <div class="ipo-h">${logo(i)}<div><h3>${esc(i.name)}</h3><div class="mut">Offer Date : ${fmtS(i.open)} to ${fmtD(i.close)}</div><div class="mut">Issue Size : ${isNum(i.issueSizeCr) ? "₹" + cr(i.issueSizeCr) + " Cr" : "—"}</div></div></div>
  <div class="tiles"><div class="tile">Offer Price<b>${price(i)}</b></div><div class="tile">Lot size<b>${isNum(i.lot) ? i.lot + " Shares" : "—"}</b></div><div class="tile">Subscription<b>${isNum(t) ? f2(t) + "x" : "—"}</b></div>
  <div class="tile">Allotment ${i.datesExpected ? "(exp.)" : ""}<b>${fmtD(i.allotment)}</b></div><div class="tile">Listing ${i.datesExpected ? "(exp.)" : ""}<b>${fmtD(i.listing)}</b></div><div class="tile">${cdFor(i)}${actionBtn(i, true)}</div></div>
  <div class="row"><button class="btn ghost" data-watch="${i.symbol}">${inW ? "★ Watching" : "☆ Watchlist"}</button><button class="btn" data-cmp="${i.symbol}">${state.cmp.includes(i.symbol) ? "✓ In compare" : "+ Compare"}</button></div></div>

  <div class="card"><div class="tiles"><button class="tile k" data-jump="fin"><div class="v" style="font-size:26px">📒</div>Company Financials</button>
  <button class="tile k" data-jump="gmp"><div class="v ${isNum(g) ? (g >= 0 ? "grn-t" : "red-t") : ""}">${isNum(g) ? (isNum(gmpPct(i)) ? `₹${g}<br>(${gmpPct(i).toFixed(2)}%)` : `₹${g}`) : "NA"}</div>GMP (Rumors)</button>
  <button class="tile k" data-jump="subs"><div class="v" style="font-size:18px">${isNum(t) ? f2(t) + "x" : "—"}</div>Subscription</button></div>
  ${isNum(g) && L ? `<div class="gl"><div class="row"><span>GMP x Lots (RETAIL)*</span><b>₹ ${inr(g * i.lot)}</b></div><div class="row"><span>GMP x Lots (sHNI)*</span><b>₹ ${inr(g * i.lot * L.s)}</b></div><div class="row"><span>GMP x Lots (bHNI)*</span><b>₹ ${inr(g * i.lot * L.b)}</b></div></div>` : ""}</div>

  <div class="card" id="ai"><h2>⭐ Trendy IPO Score</h2><div class="row"><div style="text-align:center">${ring(sc.score, true)}<div style="margin-top:8px"><span class="badge ${v.c}">${v.t} ${v.e}</span></div></div>
  <div style="flex:1">${Object.keys(WEIGHTS).map(n => `<div style="margin:5px 0"><div class="row mut sm"><span>${FACTOR_LABEL[n]} (${WEIGHTS[n] * 100}%)</span><b>${fv[n] ?? "N/A"}</b></div><div class="bar"><i style="width:${fv[n] ?? 0}%;background:${col(fv[n] ?? null)}"></i></div></div>`).join("")}</div></div>
  <div class="note"><b>🧠 Analysis (${sc.coverage}% of score weight had data)</b><ul style="margin:6px 0 0;padding-left:18px">${reasons(i).map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>
  <p class="mut sm" style="margin-bottom:0">Every factor is calculated from NSE data, the RHP and GMP; factors without data are left out and the rest are re-weighted. Indicative only.</p></div>

  <div class="card" id="gmp"><h2>GMP Trend</h2>${gh.length > 1 ? gmpChart(i.gmp.history) : `<p class="mut sm">Trend chart fills in as the pipeline records GMP each day (${gh.length} snapshot so far).</p>`}
  ${i.gmp ? `<div class="row sm"><span class="mut">Average of ${i.gmp.sources.length} source${i.gmp.sources.length > 1 ? "s" : ""}${i.gmp.rating ? " · rating " + "🔥".repeat(i.gmp.rating) : ""}</span><b>${isNum(pr) ? "Est. listing ₹" + f2(pr + g) : ""}</b></div>
  <div class="sm" style="margin-top:6px">${i.gmp.sources.map(s => `${esc(s.source)}: <b>₹${s.gmp}</b>`).join(" · ")}${i.gmp.sources.length > 1 && i.gmp.min !== i.gmp.max ? ` <span class="mut">(range ₹${i.gmp.min}–₹${i.gmp.max})</span>` : ""}</div>
  <div class="mut sm">Updated ${esc(i.gmp.updated || "—")}</div>` : `<p class="mut sm">No GMP published for this IPO yet.</p>`}
  <div class="note gr">Exp. Premium is derived from market rumors and internet sources. It does not reflect the actual IPO listing price or value. Review the RHP and consult a financial advisor.</div></div>

  ${i.listingPerf ? card("📈 Listing performance", tbl(["", ""], [["Issue price", `₹${pr}`], ["Day-1 open (" + i.listingPerf.exchange + ")", `₹${f2(i.listingPerf.dayOpen)} ${fmtGain(i.listingPerf.dayOpenGainPct)}`], ["Last price (" + fmtS(i.listingPerf.asOf) + ")", `₹${f2(i.listingPerf.ltp)} ${fmtGain(i.listingPerf.ltpGainPct)}`], ["Our score was", sc.score ?? "N/A"]].concat((m => m ? [["Our GMP at listing", m.gmpP === null ? "—" : `₹${m.gmp} ${fmtGain(m.gmpP)}`], ["GMP vs actual day-1 open", m.gmpHit ? `${fmtPts(m.err)} ${GMP_HIT[m.gmpHit]}` : "—"], ["Score vs outcome", SCORE_HIT(m.scoreHit)]] : [])(listingMatch(i)))).replace(/<tr><th><\/th><th><\/th><\/tr>/, "") + `<p class="mut sm">Source: Yahoo Finance (may differ slightly from the exchange's discovered listing price).</p>`) : ""}

  ${card("IPO Timeline", tbl(["", ""], [tlRow("Opens", i.timeline?.open), tlRow("Closes", i.timeline?.close), tlRow("Allotment finalised", i.timeline?.allotment, i.datesExpected), tlRow("Refund initiated", i.timeline?.refund, i.datesExpected), tlRow("Shares credited to demat", i.timeline?.demat, i.datesExpected), tlRow("Listing", i.timeline?.listing, i.datesExpected)]).replace(/<tr><th><\/th><th><\/th><\/tr>/, "") + `<p class="mut sm">${i.datesExpected ? "Estimated from the close date (T+1 allotment, T+2 refund/demat, T+3 listing); holidays can move these." : "Dates announced by the issuer/exchange."}</p>`)}

  ${(i.checks || []).length ? card("", (i.checks.some(c => !c.ok) ? `<div class="note" style="margin:0">⚠️ <b>Sources disagree:</b> ${i.checks.filter(c => !c.ok).map(c => `${esc(c.field)}: NSE ${esc(c.nse)} vs InvestorGain ${esc(c.other)}`).join("; ")}</div>` : `<span class="mut sm">✔ NSE and InvestorGain agree on ${i.checks.length} checks (issue size, lot, cap price, dates).</span>`)) : ""}

  ${N !== null && anyBid ? card("", `<div class="alot">👥 ≈ 1 in ${N} retail allotment</div><span class="chip ${risk[1]}">${risk[0]}</span><p class="sm">Based on retail subscription of ${f2(b.retail.times)}x (by shares). Approximately 1 in ${N} retail applications may receive an allotment if demand holds.</p><div class="note">ⓘ The final allotment is decided by the registrar's computerised lottery.</div>`) : ""}

  ${card("Subscription Detail (No. of Shares)", anyBid && (rows.length || b.total?.bid > 0) ? tbl(["Category", "Offered", "Bid for", "Times"], [...rows.map(r => [r[0], inr(r[1].offered), inr(r[1].bid), f2(r[1].times)]), ...(b.total ? [["<b>Total</b>", inr(b.total.offered), inr(b.total.bid), `<b>${f2(b.total.times)}</b>`]] : [])]) + `<p class="mut sm">${/^as on/i.test(i.demand?.asOn || "") ? "" : "As on "}${esc(i.demand?.asOn || "—")} (NSE).</p>${rows.length ? "" : '<p class="mut sm">NSE no longer publishes the category-wise split for this finished issue. The total bids and times subscribed are NSE\'s final figures.</p>'}` : `<p class="mut">Subscription data appears once the issue opens (${fmtD(i.open)}).</p>`, "subs")}
  ${dwRows.length ? card("Day Wise Subscription (snapshots)", tbl(["Date", "QIB", "NII", "Retail", "Total"], dwRows)) : ""}
  ${i.demand?.byPrice ? card("Cumulative Demand by Price (NSE)", tbl(["Price (₹)", "Cumulative qty"], Object.entries(i.demand.byPrice).map(([k, x]) => [esc(k), esc(x)]))) : ""}
  ${L ? card("Lot(s) Distribution", tbl(["Category", "Lot(s)", "Qty", "Amount"], [["RETAIL", 1, inr(i.lot), inr(i.lot * pr)], ["sHNI (from ₹2L)", L.s, inr(L.s * i.lot), inr(L.s * i.lot * pr)], ["bHNI (from ₹10L)", L.b, inr(L.b * i.lot), inr(L.b * i.lot * pr)]])) : ""}

  ${f ? `
  ${card("Key Performance Indicator", tbl(["KPI", ...rv(per)], [fr("ROCE (%)", K.roce), fr("RoNW (%)", K.ronw), fr("ROE (%)", K.roe), fr("EPS basic (₹)", K.eps_basic), fr("EPS diluted (₹)", K.eps_diluted), fr("PAT margin (%)", K.pat_margin), fr("EBITDA margin (%)", K.ebitda_margin), fr("Debt/Equity", K.debt_equity), ...(K.other || []).map(o => [`${esc(o.name)} (${esc(o.unit)})`, ...rv(o.values)])].map(r => r.map((c, k) => k ? (c === "—" ? c : c) : c))) + `<p class="mut sm">NAV/share: ${isNum(K.nav_per_share) ? "₹" + K.nav_per_share : "—"} · P/E post-IPO: ${isNum(p) ? p.toFixed(2) : "—"} · Pre-IPO P/E: ${isNum(K.pe_pre_ipo) ? K.pe_pre_ipo : "—"}</p>`, "fin")}
  ${card("Company Financials", tbl(["Period Ended", ...rv(per)], [fr("Total assets", F.total_assets), fr("Revenue", F.revenue), fr("EBITDA", F.ebitda), fr("Profit before tax", F.pbt), fr("Profit after tax", F.pat), fr("Net worth", F.net_worth), fr("Reserves", F.reserves), fr("Total borrowing", F.borrowings), fr("Cash & bank", F.cash_and_bank), fr("Operating cash flow", F.operating_cash_flow)]) + `<div class="mut sm" style="text-align:right;margin-top:6px">₹ crore · ${esc(f.basis || "")} · restated, per RHP</div>`)}
  ${(f.peers || []).length ? card("Peer Comparison", tbl(["Company", "P/E", "CMP (₹)", "EPS (₹)", "NAV (₹)", "RoNW %"], [[`<b>${esc(i.name)}</b>`, isNum(p) ? p.toFixed(2) : "—", pr, last(K.eps_diluted) ?? "—", K.nav_per_share ?? "—", last(K.ronw) ?? "—"], ...f.peers.map(x => [esc(x.name), x.pe ?? "—", x.cmp ?? "—", x.eps_diluted ?? x.eps_basic ?? "—", x.nav ?? "—", x.ronw ?? "—"])]) + (pa && p ? `<p class="mut sm">Peer avg P/E ${pa.toFixed(1)} → IPO at ${p < pa ? "a discount" : "a premium"} of ${Math.abs((p / pa - 1) * 100).toFixed(0)}%.</p>` : "")) : ""}
  ${card("Issue Details", tbl(["", ""], [["Issue size", isNum(i.issueSizeCr) ? `₹${cr(i.issueSizeCr)} Cr (${inr(i.issueShares)} shares)` : "—"], ["Fresh issue", isNum(iss.fresh_issue_cr) ? `₹${cr(iss.fresh_issue_cr)} Cr` : "—"], ["Offer for sale", isNum(iss.ofs_cr) ? `₹${cr(iss.ofs_cr)} Cr` : iss.ofs_shares === 0 ? "-" : "—"], ["Face value", isNum(i.faceValue) ? `₹${i.faceValue}` : "—"], ["Issue type", esc(i.issueType || "—")], ["Shares pre-issue", inr(iss.pre_issue_shares)], ["Shares post-issue", inr(iss.post_issue_shares)], ["Reservation", iss.reservation_pct ? Object.entries(iss.reservation_pct).filter(([, x]) => isNum(x)).map(([k, x]) => `${esc(k)} ${x}%`).join(" · ") : "—"]]).replace(/<tr><th><\/th><th><\/th><\/tr>/, ""))}
  ${(iss.objects || []).length ? card("Objects of the Issue", tbl(["Purpose", "₹ Cr"], iss.objects.map(o => [esc(o.purpose), o.amount_cr ?? "—"]))) : ""}
  ${card("About Company", `<p class="sub">${esc(f.about)}</p><div class="mut sm">${[f.headquarters && "HQ: " + esc(f.headquarters), f.founded_year && "Founded: " + f.founded_year, isNum(f.order_book_cr) && "Order book: ₹" + cr(f.order_book_cr) + " Cr"].filter(Boolean).join(" · ")}</div>`)}
  ${f.promoters?.names?.length ? card("Promoters", `<p class="sm">${f.promoters.names.map(esc).join(", ")}</p><div class="mut sm">Holding pre-issue ${f.promoters.holding_pre_pct ?? "—"}% → post-issue ${f.promoters.holding_post_pct ?? "—"}%</div>${f.promoters.background ? `<p class="sm">${esc(f.promoters.background)}</p>` : ""}`) : ""}
  ${(f.strengths || []).length ? card("Strength Factor", `<ul class="lst">${f.strengths.map(x => `<li>• ${esc(x)}</li>`).join("")}</ul>`) : ""}
  ${(f.risks || []).length ? card("Risk Factor", `<ul class="lst">${f.risks.map(x => `<li>${x.severity === "high" ? "🔴" : x.severity === "medium" ? "🟠" : "🟡"} <b>${esc(x.title)}</b><br><span class="mut">${esc(x.detail)}</span></li>`).join("")}</ul>`) : ""}
  ${f.notes ? `<p class="mut sm">ℹ️ A few figures could not be read clearly from the offer document and are left blank (—).</p>` : ""}` : card("Company fundamentals", `<p class="mut">${i.verification?.status === "fail" ? "The figures extracted from the offer document failed our automatic verification and are hidden until they are re-checked." : esc(i.sourceNote || "") || "Company figures have not been extracted from the offer document yet (the pipeline does this once the document is available and extraction has run)."}</p>`)}

  ${forReport ? "" : reportCard(i)}
  ${card("Registrar", `<b>${esc(i.registrar.name || "—")}</b><div class="sm" style="margin-top:6px">${esc(i.registrar.address || "")}<br>${esc(i.registrar.contact || "")}</div>`)}
  ${i.leadManagers ? card("Lead Manager(s)", `<span class="sm">${esc(i.leadManagers)}</span><div class="mut sm" style="margin-top:6px">Sponsor bank: ${esc(i.sponsorBank || "—")}</div>`) : ""}
  </div><p class="disc">Source: NSE India + RHP. Dates marked (exp.) are estimated from the closing date (T+1 allotment, T+3 listing) and may shift for holidays. Score is indicative, not investment advice.</p>`;
}

function compare() {
  state.cmp = state.cmp.filter(byId);                                  // forget IPOs that are no longer in the data
  const sel = state.cmp.map(byId).filter(Boolean);
  const picker = state.cmp.length < 3 ? `<select id="pick"><option value="">+ Add IPO to compare (max 3)</option>${state.ipos.filter(i => !state.cmp.includes(i.symbol) && i.status !== "listed").map(i => `<option value="${i.symbol}">${esc(i.name)}</option>`).join("")}</select>` : "";
  if (sel.length < 2) return `${head("Compare")}<div class="note" style="margin:0 0 12px">⚖️ Pick 2–3 IPOs to compare side by side. Green = best value, red = weakest.</div>${sel.map(listCard).join("")}${picker}`;
  const pat = i => last(FU(i)?.financials?.pat);
  // [group, label, number-or-null, formatter, which direction is better]
  const M = [
    ["⭐ Score", "Trendy IPO score", i => score(i), v => v + "/100", "high"],
    ["📈 Market", "GMP today", i => gmpNow(i), (v, i) => "₹" + v + (isNum(gmpPct(i)) ? " (" + gmpPct(i).toFixed(0) + "%)" : ""), "high"],
    ["📈 Market", "Subscription", i => totalTimes(i), v => f2(v) + "x", "high"],
    ["📈 Market", "Retail allotment", i => retailN(i), v => "1 in " + v, "low"],
    ["📒 Financials", "Revenue growth (CAGR)", i => cagr(FU(i)?.financials?.revenue), v => v.toFixed(0) + "%", "high"],
    ["📒 Financials", "Profit (₹ Cr)", pat, v => cr(v), "high"],
    ["📒 Financials", "Return on net worth", i => last(FU(i)?.kpi?.ronw), v => v + "%", "high"],
    ["📒 Financials", "P/E (lower = cheaper)", i => pe(i), v => v.toFixed(1), "low"],
    ["💰 Entry", "Issue size", i => i.issueSizeCr, v => "₹" + cr(v) + " Cr", null],
    ["💰 Entry", "Minimum investment", i => isNum(i.lot) && i.priceHigh > 0 ? i.lot * i.priceHigh : null, v => "₹" + inr(v), "low"],
  ];
  const cols = "grid-template-columns:96px repeat(" + sel.length + ",minmax(0,1fr))";
  const head1 = `<div class="cmprow" style="${cols}"><div></div>${sel.map(i => { const sc = scoreOf(i), v = verdict(sc.score); return `<div class="cmphead" style="border-top-color:hsl(${hue(i.symbol)} 60% 45%)"><button class="cmpx" data-cmp="${i.symbol}" title="Remove">✕</button>${logo(i)}<div class="cmpname">${esc(i.name.replace(/ Limited$/, ""))}</div><span class="pill sm">${i.board}</span>${ring(sc.score)}<span class="badge ${v.c}" style="font-size:10px">${v.t}</span></div>`; }).join("")}</div>`;
  let lastGroup = "", body = "";
  for (const [grp, label, get, fmt, dir] of M) {
    const vals = sel.map(i => { const v = get(i); return isNum(v) ? v : null; }), nums = vals.filter(v => v !== null);
    const hi = nums.length ? Math.max(...nums) : null, lo = nums.length ? Math.min(...nums) : null, differ = nums.length >= 2 && hi !== lo;
    if (grp !== lastGroup) { body += `<div class="cmpgroup">${grp}</div>`; lastGroup = grp; }
    body += `<div class="cmprow" style="${cols}"><div class="cmplabel">${label}</div>${sel.map((i, k) => {
      const v = vals[k]; if (v === null) return `<div class="cmpcell mut">—</div>`;
      const best = differ && dir && v === (dir === "high" ? hi : lo), worst = differ && dir && v === (dir === "high" ? lo : hi);
      const w = dir === "high" && hi > 0 ? Math.max(6, Math.round(v / hi * 100)) : 0;
      return `<div class="cmpcell ${best ? "best" : worst ? "worst" : ""}">${fmt(v, i)}${best ? " ✔" : ""}${w ? `<i class="cmpbar" style="width:${w}%"></i>` : ""}</div>`;
    }).join("")}</div>`;
  }
  // who wins what
  const win = (label, get, dir) => { const c = sel.map(i => [i, get(i)]).filter(x => isNum(x[1])); if (c.length < 2) return ""; const v = dir === "high" ? Math.max(...c.map(x => x[1])) : Math.min(...c.map(x => x[1])); const w = c.find(x => x[1] === v)[0]; return `<span class="winchip" style="background:hsl(${hue(w.symbol)} 60% 94%);border-color:hsl(${hue(w.symbol)} 55% 70%)">${label}: <b>${esc(w.name.split(" ").slice(0, 2).join(" "))}</b></span>`; };
  const wins = [win("🏆 Highest score", i => score(i), "high"), win("📈 Highest GMP", i => gmpNow(i), "high"), win("🔥 Most subscribed", i => totalTimes(i), "high"), win("💸 Cheapest P/E", i => pe(i), "low"), win("🧾 Lowest entry", i => isNum(i.lot) && i.priceHigh > 0 ? i.lot * i.priceHigh : null, "low")].filter(Boolean);
  return `${head("Compare")}<div class="cmp tw">${head1}${body}</div>
  ${wins.length ? `<div class="chips" style="margin:12px 0">${wins.join("")}</div>` : ""}${picker}
  <p class="mut sm">Green ✔ = best of the selected IPOs on that row, red = weakest. A highlight is only a comparison of these IPOs, not advice.</p>`;
}
function allotment() {
  const list = state.ipos.filter(i => i.status === "listed" || (i.status === "live" && i.close && dayDiff(i.close) <= 0));
  const sel = byId(state.allotIpo) || list[0];
  return `${head("Allotment Status")}<div class="card"><p class="mut">Select the IPO, then check on the registrar's official page using your PAN or application number.</p>
  <select id="allotSel">${list.map(i => `<option value="${i.symbol}" ${sel && sel.symbol === i.symbol ? "selected" : ""}>${esc(i.name)} (${fmtS(i.allotment)})</option>`).join("")}</select>
  ${sel ? `<div class="note"><b>Registrar:</b> ${esc(sel.registrar.name || "—")}<br>Allotment date: ${fmtD(sel.allotment)} ${sel.datesExpected ? "(expected)" : ""}<br>${esc(sel.registrar.contact || "")}</div>
  ${(r => r ? `<a class="btn" style="display:block;text-align:center;text-decoration:none;margin-top:10px" href="${r.url}" target="_blank" rel="noopener noreferrer">${r.kind === "status" ? "Check allotment status ↗" : "Open the registrar's website ↗"}</a>${r.kind === "status" ? "" : '<p class="mut sm">Look for "IPO status" or "allotment" on their site.</p>'}` : `<p class="mut sm">The registrar's status page is not known for this IPO. If it is listed on BSE you can check here:</p><a class="btn ghost" style="display:block;text-align:center;text-decoration:none" href="${BSE_STATUS}" target="_blank" rel="noopener noreferrer">BSE: application status ↗</a>`)(registrarLink(sel))}` : '<p class="mut">No IPOs awaiting allotment.</p>'}</div>
  <div class="note">Allotment is decided by the registrar's computerised lottery. Use the registrar's official website or the NSE/BSE allotment pages.</div>`;
}
function unlisted() { return `${head("Unlisted Shares")}<div class="card"><p class="mut">No reliable automatic source for unlisted (pre-IPO) prices is connected yet, so nothing is shown rather than showing guesses.</p></div>`; }
function settings() {
  const A = state.alerts, w = state.watch.map(byId).filter(Boolean);
  return `${head("Settings")}<div class="card"><h2>🔔 Alerts</h2>${[["open", "IPO opening"], ["close", "Closing day reminder"], ["allot", "Allotment result"]].map(([k, l]) => `<div class="row" style="padding:8px 0"><span>${l}</span><input type="checkbox" data-alert="${k}" ${A[k] ? "checked" : ""}></div>`).join("")}<p class="mut sm">Saved locally. Push notifications need a backend.</p></div>
  <div class="card"><h2>⭐ Watchlist</h2>${w.map(i => `<div class="row" style="padding:8px 0"><div><b>${esc(i.name)}</b><div class="mut">${stLabel(i).replace(/<[^>]+>/g, "")}</div></div><button class="btn ghost" style="flex:none" data-open="${i.symbol}">View</button></div>`).join("") || '<p class="mut">Star an IPO from its detail page.</p>'}</div>
  <div class="card"><h2>Data sources</h2><ul class="lst sm">${(state.meta?.sources || []).map(s => `<li>${esc(s.name || s)}${s.fetchedAt ? `<div class="mut">updated ${new Date(s.fetchedAt).toLocaleString("en-IN")}</div>` : ""}</li>`).join("")}<li>Generated: ${state.meta ? new Date(state.meta.generatedAt).toLocaleString("en-IN") : "—"}</li></ul></div>`;
}

// ---------- anonymous usage counting (analytics.js; off until a GoatCounter code is set) ----------
// Only which screen or button was used is recorded: no names, no personal data.
function trackClick(t, d) {
  const T = window.trendyTrack; if (!T) return;
  const nm = id => byId(id)?.name || id;
  if (d.open) T("ipo/" + d.open, "IPO opened: " + nm(d.open));
  else if (d.apply) T("apply/" + d.apply, "Apply clicked: " + nm(d.apply));
  else if (d.report) T("report/" + d.report, "Full report: " + nm(d.report));
  else if (d.tab) T("tab/" + d.tab, "Tab: " + d.tab);
  else if (d.seg) T("list/" + d.seg, "List: " + d.seg);
  else if (d.stat) T("list/" + d.stat, "List: " + d.stat);
  else if (d.pill) T("filter/" + d.pill, "Filter: " + d.pill);
  else if (d.cmp) T("compare/add", "Compare: add or remove");
  else if (d.watch) T("watchlist", "Watchlist: add or remove");
  else if (d.lang) T("language/" + d.lang, "Language: " + d.lang);
  else if (t.hasAttribute("data-refresh")) T("refresh", "Refresh data");
  else if (t.hasAttribute("data-share")) T("share", "Share");
  else if (t.hasAttribute("data-search")) T("search", "Search");
}
document.addEventListener("click", e => { const a = e.target.closest("a[data-track]"); if (a && window.trendyTrack) window.trendyTrack(a.dataset.track, "Broker link: " + a.dataset.track.split("/")[1]); });

// ---------- disclaimer ----------
// English by default; the "Translate to Hindi" button swaps the same message to Hindi (choice is remembered)
const TEXT = {
  gmpInfo: {
    en: "GMP (Grey Market Premium) is the unofficial extra amount people are willing to pay for an IPO share in the grey market before it lists. It is rumour-based, is not guaranteed, can change every day, and says nothing certain about the listing price.",
    hi: "GMP (ग्रे मार्केट प्रीमियम) वह अनौपचारिक अतिरिक्त रकम है जो लोग लिस्टिंग से पहले ग्रे मार्केट में IPO के शेयर के लिए देने को तैयार होते हैं। यह अफ़वाह पर आधारित है, इसकी कोई गारंटी नहीं, यह रोज़ बदल सकता है और लिस्टिंग भाव के बारे में पक्का कुछ नहीं बताता।",
  },
  disclaimerTitle: { en: "⚠️ Disclaimer", hi: "⚠️ अस्वीकरण" },
  disclaimer: {
    en: `This app is for <b>information only</b> and is <b>not investment advice</b>. We are not a SEBI-registered adviser or research analyst.
The score is a formula output, <b>not a recommendation to buy, sell or apply</b>. GMP is <b>unofficial rumour data</b>.
Data may be delayed, incomplete or wrong. Investing in IPOs involves <b>risk of loss</b>; read the RHP yourself and consult a licensed adviser. Use at your own risk.`,
    hi: `Trendy IPO सिर्फ़ <b>जानकारी</b> के लिए है, <b>निवेश सलाह नहीं</b>। हम SEBI-रजिस्टर्ड निवेश सलाहकार या रिसर्च एनालिस्ट नहीं हैं।
स्कोर NSE, RHP और GMP के डेटा से बना एक ऑटोमैटिक फ़ॉर्मूला है — यह <b>खरीदने, बेचने या अप्लाई करने की सलाह नहीं</b> है। GMP <b>अफ़वाह (अनौपचारिक)</b> डेटा है और सही न भी हो सकता है।
डेटा देर से आया, अधूरा या ग़लत हो सकता है। IPO में <b>पैसा डूबने का जोखिम</b> है। निवेश से पहले RHP ख़ुद पढ़ें और अपने लाइसेंस-प्राप्त सलाहकार से पूछें। इसे अपने जोखिम पर इस्तेमाल करें।`,
  },
  privacy: {
    en: "Trendy IPO counts anonymous visits and which screens and buttons are used, so the app can be improved. No names, phone numbers, accounts or cookies are collected, and no IP address is stored by the counter. Browsers set to Do Not Track are not counted. If you write a review, your rating, text and the optional name are kept by the admin and shown publicly only after approval; please do not write personal details.",
    hi: "Trendy IPO सिर्फ़ बिना नाम की गिनती करता है कि कितने लोग आए और कौन सी स्क्रीन या बटन इस्तेमाल हुए, ताकि ऐप बेहतर बन सके। नाम, फ़ोन नंबर, अकाउंट या कुकी नहीं ली जातीं, और काउंटर कोई IP एड्रेस सेव नहीं करता। 'Do Not Track' वाले ब्राउज़र गिने नहीं जाते। अगर आप रिव्यू लिखते हैं तो आपकी रेटिंग, टेक्स्ट और वैकल्पिक नाम एडमिन के पास रहते हैं और मंज़ूरी के बाद ही सबको दिखते हैं; कृपया निजी जानकारी न लिखें।",
  },
  aboutTitle: { en: "About", hi: "ऐप के बारे में" },
  about: {
    en: `<b>Trendy IPO</b> — IPO information in one place: dates, price band, subscription (QIB / NII / retail), GMP, company numbers (from the RHP), risks, allotment links and a data-based 0–100 score. Data comes from official sources such as NSE, SEBI and the RHP; GMP is unofficial. Developed by Zynora Technology (Noor).`,
    hi: `<b>Trendy IPO</b> — IPO की जानकारी एक जगह: तारीखें, प्राइस बैंड, सब्सक्रिप्शन (QIB / NII / रिटेल), GMP, कंपनी के आँकड़े (RHP से), जोखिम, अलॉटमेंट लिंक और डेटा पर आधारित 0–100 स्कोर। डेटा NSE, SEBI और RHP जैसे आधिकारिक स्रोतों से आता है; GMP अनौपचारिक है। Zynora Technology (Noor) द्वारा विकसित।`,
  },
};
const lang = () => store.get("lang", "en") === "hi" ? "hi" : "en";
const langBtn = () => lang() === "en" ? `<button class="linkbtn" data-lang="hi">🌐 Translate to Hindi / हिंदी में पढ़ें</button>` : `<button class="linkbtn" data-lang="en">🌐 Show in English / अंग्रेज़ी में पढ़ें</button>`;
const disclaimer = () => `<b>${TEXT.disclaimerTitle[lang()]}</b><br>${TEXT.disclaimer[lang()]}<br>${langBtn()}`;
const about = () => `<p class="sm" style="margin:0">${TEXT.about[lang()]}</p>${langBtn()}`;
const credit = () => `<div class="credit">Developed by <b>Zynora Technology</b> (Noor)<span>© 2026 Zynora Technology. All rights reserved.</span></div>`;
// If the data file stops being refreshed, say so on every screen instead of quietly showing old numbers.
const STALE_HOURS = 8;
const staleBar = () => {
  const h = state.meta?.generatedAt ? (Date.now() - new Date(state.meta.generatedAt).getTime()) / 3600e3 : 0;
  if (!(h > STALE_HOURS)) return "";
  const age = h >= 48 ? Math.floor(h / 24) + " days" : Math.floor(h) + " hours", ageHi = h >= 48 ? Math.floor(h / 24) + " दिन" : Math.floor(h) + " घंटे";
  return `<div class="stale" data-refresh style="cursor:pointer">⚠️ Data is ${age} old: live updates may have stopped. Tap to refresh. <span>डेटा ${ageHi} पुराना है।</span></div>`;
};
const acked = () => state.ack;   // shown on every app open, gone after the user taps "I understand" (not remembered)

// ---------- left side bar (About, Compare, Settings) + About page ----------
// Laptop: always visible on the left. Phone: opens from the "☰ About" button at the top and closes again after a choice.
const SIDE = [["about", "ℹ️", "About"], ["general", "🧰", "General"], ["share", "🔗", "Share"], ["help", "🛟", "Help & Support"], ["compare", "⚖️", "Compare"], ["settings", "⚙️", "Settings"]];
const sideMenu = () => `<div class="dim" data-drawer-close></div><aside class="drawer" aria-label="Menu">
  <div class="dhead"><img src="icons/logo.svg" alt="" width="40" height="40"><div><b>Trendy <span>IPO</span></b><div class="mut sm">Menu</div></div><button class="ib dclose" data-drawer-close aria-label="Close">✕</button></div>
  <div class="dnav">${SIDE.map(([k, ic, l]) => `<button data-tab="${k}" class="${state.tab === k && !state.detail && !state.report ? "on" : ""}"><b>${ic}</b>${l}</button>`).join("")}</div>
  <div class="dfoot sm mut">Developed by <b>Zynora Technology</b> (Noor)<br>© 2026 Zynora Technology</div></aside>`;
// ---------- About page: menu of General / Share / Help & Support, each row opens its own page ----------
state.sub = null;
state.applied = store.get("applied", []);
state.pan = store.get("pan", "");
state.theme = store.get("theme", null);                                   // "dark" | "light" | null = follow the phone
const isDark = () => state.theme ? state.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
const applyTheme = () => { if (state.theme) document.documentElement.dataset.theme = state.theme; else delete document.documentElement.dataset.theme; };
applyTheme();
const APP_URL = () => location.origin + location.pathname.replace(/index\.html$/, "");

const mrow = (ic, label, sub, extra = "") => `<button class="mrow" data-sub="${sub}"><span class="mic">${ic}</span><span class="mlb">${label}${extra}</span><span class="mgo">›</span></button>`;
const msec = (title, rows) => `<div class="msec"><h3>${title}</h3>${rows}</div>`;
const subPage = (title, inner) => `${head(title, `<button class="btn ghost" data-sub="" style="flex:none;width:auto;padding:6px 14px">← Back</button>`)}<div class="subpg">${inner}</div>`;

// notifications built from the live data (no server): opening soon, closing, allotment, listing
function notifList() {
  const out = [], when = n => n === 0 ? "today" : n === 1 ? "tomorrow" : n > 0 ? `in ${n} days` : n === -1 ? "yesterday" : `${-n} days ago`;
  for (const i of state.ipos) {
    const nm = esc(shortName(i.name)), o = dayDiff(i.open), c = dayDiff(i.close), a = dayDiff(i.allotment), l = dayDiff(i.listing);
    if (o !== null && o >= 0 && o <= 3) out.push([o, "🟢", `<b>${nm}</b> opens ${when(o)}`, i.symbol]);
    if (c !== null && c >= 0 && c <= 1 && (o === null || o <= 0)) out.push([c, "⏰", `<b>${nm}</b> closes ${when(c)}`, i.symbol]);
    if (a !== null && a >= -1 && a <= 1) out.push([a, "📋", `<b>${nm}</b> allotment ${a === 0 ? "is today" : a < 0 ? "was " + when(a) : "is " + when(a)}`, i.symbol]);
    if (l !== null && l >= -1 && l <= 1) out.push([l, "🔔", `<b>${nm}</b> ${l < 0 ? "listed " + when(l) : "lists " + when(l)}`, i.symbol]);
  }
  return out.sort((x, y) => Math.abs(x[0]) - Math.abs(y[0]));
}
const FAQ = [
  ["What is an IPO?", "An Initial Public Offering is when a company sells its shares to the public for the first time, so that the shares can then be bought and sold on the stock exchange."],
  ["What is GMP?", "Grey Market Premium is the unofficial extra price people are ready to pay for an IPO share before it lists. It is only a rumour-based indication and can be wrong."],
  ["How is the score calculated?", "The 0–100 score is a formula on public data: financials from the offer document, GMP, subscription, valuation, business quality and peers. It is an indication, not advice."],
  ["How do I apply for an IPO?", "Open your broker or UPI app, go to the IPO section, pick the issue and category, enter lots and your UPI ID, then approve the mandate in your UPI app before the closing time."],
  ["How do I check allotment?", "Open the Allotment tab, choose the IPO and go to the registrar's website. Enter your PAN or application number there. Allotment is usually announced one to two days after the issue closes."],
  ["What is ASBA?", "Application Supported by Blocked Amount. Your money stays in your bank account and is only blocked while the application is open. If you do not get shares, it is released."],
  ["What do QIB, NII and Retail mean?", "Qualified Institutional Buyers, Non-Institutional Investors (big individuals) and Retail investors (applying up to ₹2 lakh). Each category has its own quota and subscription count."],
  ["Is the data live?", "The data refreshes automatically from NSE, BSE and SEBI. Pull down on your phone, or press Refresh, to load the latest. GMP is unofficial."],
  ["Does Trendy IPO give investment advice?", "No. Everything here is information only. Please read the RHP and decide for yourself."]
];
const TERMS = ["Trendy IPO is an information tool. It is not a SEBI-registered investment adviser or research analyst and does not recommend buying, selling or applying for any security.",
  "Data comes from public sources (NSE, BSE, SEBI, offer documents, InvestorGain, ipowatch, Yahoo Finance). It may be delayed, incomplete or wrong. GMP is unofficial and based on market rumours.",
  "The 0–100 score is a formula on public data. It is an indication only and is not a prediction of listing gains.",
  "Investing in IPOs and shares involves risk, including the loss of your money. Read the RHP and take your own decision or consult a licensed adviser.",
  "Zynora Technology does not accept any liability for loss arising from use of this app or its data. Links to third-party sites (brokers, registrars, exchanges) are for convenience; we do not control them.",
  "By using the app you accept these terms. They may change from time to time; continued use means you accept the latest version."];

function subContent(k) {
  const A = state.alerts;
  if (k === "applied") {
    const mine = state.applied.map(byId).filter(Boolean), rest = state.ipos.filter(i => !state.applied.includes(i.symbol) && (i.status === "live" || i.status === "upcoming" || (dayDiff(i.close) !== null && dayDiff(i.close) >= -10)));
    const line = (i, on) => `<div class="row" style="padding:9px 0"><div style="min-width:0"><b>${esc(shortName(i.name))}</b><div class="mut sm">${stLabel(i).replace(/<[^>]+>/g, "")}</div></div><div style="display:flex;gap:6px;flex:none">${on ? `<button class="btn ghost" style="width:auto;padding:6px 10px" data-allot-open="${esc(i.symbol)}">Allotment</button>` : ""}<button class="btn ${on ? "ghost" : ""}" style="width:auto;padding:6px 12px" data-applied="${esc(i.symbol)}">${on ? "Remove" : "I applied"}</button></div></div>`;
    return subPage("Applied IPO", card("Your applied IPOs", mine.map(i => line(i, true)).join("") || `<p class="mut sm" style="margin:0">Nothing marked yet. Mark an IPO below after you apply, to keep track of it. Saved only on this device.</p>`) + card("Mark an IPO as applied", rest.map(i => line(i, false)).join("") || `<p class="mut sm" style="margin:0">No open or recent IPOs.</p>`));
  }
  if (k === "asba") {
    const forms = i => (i.documents || []).filter(d => d.group === "Application forms & centres" && safeUrl(d.url));
    const pick = (i, re) => forms(i).find(d => re.test(d.label));
    const list = state.ipos.filter(i => ["live", "upcoming"].includes(i.status) && forms(i).length).sort((a, b) => (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1) || String(a.open).localeCompare(String(b.open)));
    const btn = (d, ic, txt, hint) => d ? `<a class="asbtn" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" data-track="link/asba"><span class="asic">${ic}</span><span><b>${txt}</b><small>${hint}</small></span><span class="mgo">↓</span></a>` : "";
    const tile = (ic, t, d) => `<div class="astile"><span>${ic}</span><b>${t}</b><small>${d}</small></div>`;
    const hero = `<div class="ashero"><div class="ashi">📄</div><div><h2>ASBA</h2><p>Application Supported by Blocked Amount. Your money stays in <b>your own bank account</b> and is only blocked while the IPO application is open. If you do not get shares, it is released automatically.</p></div></div>`;
    const ways = card("Three ways to apply", `<div class="astiles">${tile("📱", "UPI", "Broker app → IPO → enter UPI ID → approve the request. Fastest.")}${tile("🏦", "Net banking", "Your bank's IPO / ASBA section. Money is blocked in your account.")}${tile("🧾", "Physical form", "Fill the ASBA form and give it to your bank branch or a bidding centre.")}</div>`);
    const steps = card("How to apply (UPI)", `<ol class="assteps"><li>Keep the full amount in your bank account (lot price × lots).</li><li>Open your broker or UPI app and go to <b>IPO</b>.</li><li>Choose the issue, the category (Retail / SME) and the number of lots.</li><li>Enter your UPI ID and submit.</li><li>Open your UPI app and <b>approve the mandate</b> before the closing time. Without this the application is not placed.</li></ol>`);
    const per = card("Application forms by IPO", `<p class="mut sm" style="margin-top:0">Official files published on the exchange for each current and upcoming IPO. They are ZIP files: open them after download.</p>` + (list.map(i => `<div class="asipo"><div class="ashead">${logo(i)}<div style="min-width:0"><b>${esc(shortName(i.name))}</b><div class="mut sm">${stLabel(i).replace(/<[^>]+>/g, "")}${i.close ? " · closes " + fmtD(i.close) : ""}</div></div></div><div class="asbtns">${btn(pick(i, /application form/i), "📄", "Application form", "ASBA form · ZIP")}${btn(pick(i, /bidding centres/i), "📍", "Bidding centres", "list of centres · ZIP")}</div></div>`).join("") || `<p class="mut sm" style="margin:0">No forms are published yet for current IPOs. They appear here automatically as soon as the exchange publishes them.</p>`));
    const tips = card("Good to know", `<ul class="alist"><li>Only one application per PAN per IPO.</li><li>Do not apply on the last day in the last hour — UPI approvals can fail.</li><li>The blocked amount is released after allotment, for shares you did not get.</li></ul>`);
    return subPage("Download ASBA Form", hero + ways + steps + per + tips);
  }
  if (k === "pan") {
    const p = state.pan;
    return subPage("Add PAN Number", card("Your PAN", `<p class="sm" style="margin-top:0">Save your PAN here so you can copy it quickly when you check allotment on the registrar's site. <b>It stays only on this phone/browser</b> and is never sent to us or anyone else.</p>
      ${p ? `<div class="row" style="padding:8px 0"><div><div class="mut sm">Saved PAN</div><b style="letter-spacing:1.5px">${esc(p.slice(0, 5) + "••••" + p.slice(9))}</b></div><div style="display:flex;gap:6px"><button class="btn" style="width:auto;padding:6px 12px" data-pancopy>Copy</button><button class="btn ghost" style="width:auto;padding:6px 12px" data-pandel>Remove</button></div></div>` : ""}
      <label class="mut sm" for="pan-in" style="display:block;margin:10px 0 4px">${p ? "Change PAN" : "Enter PAN"}</label><input id="pan-in" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE1234F" style="text-transform:uppercase;letter-spacing:2px"><button class="btn" data-pansave style="width:100%;margin-top:10px">Save PAN</button>`));
  }
  if (k === "notif") {
    const n = notifList();
    return subPage("Notifications", card("Latest updates", n.map(([, ic, t, s]) => `<button class="nrow" data-open="${esc(s)}"><span>${ic}</span><span>${t}</span><span class="mgo">›</span></button>`).join("") || `<p class="mut sm" style="margin:0">Nothing new right now. You will see IPOs opening, closing, allotment and listing here.</p>`) +
      `<p class="mut sm">This list is made from the live data each time you open the app.</p>`);
  }
  if (k === "nsettings") {
    return subPage("Notification Settings", card("🔔 Alerts", [["open", "IPO opening"], ["close", "Closing day reminder"], ["allot", "Allotment result"]].map(([x, l]) => `<div class="row" style="padding:8px 0"><span>${l}</span><input type="checkbox" data-alert="${x}" ${A[x] ? "checked" : ""}></div>`).join("") + `<p class="mut sm">Saved on this device. The Notifications page shows these events from the live data.</p>`));
  }
  if (k === "rate") {
    const r = state.rate = store.get("rate", 0);
    return subPage("Rate App", card("How do you like Trendy IPO?", `<div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button class="starb${n <= r ? " on" : ""}" data-rate="${n}" aria-label="${n} star">★</button>`).join("")}</div><p class="mut sm" style="text-align:center;margin:8px 0 0">${r ? `Thank you! You rated ${r} / 5.` : "Tap a star."}</p>`) +
      card("Tell us more", `<p class="sm" style="margin:0">Found a problem or have an idea? <a class="linkbtn" href="https://github.com/Noor1204/IPO/issues/new" target="_blank" rel="noopener noreferrer">Write to us here</a>.</p>`));
  }
  if (k === "support") {
    return subPage("Support", card("Need help?", `<p class="sm" style="margin-top:0">Check the <button class="linkbtn" data-sub="faq">FAQs</button> first. If something is wrong with the data or the app, tell us and we will fix it.</p><a class="btn" style="display:block;text-align:center;text-decoration:none" href="https://github.com/Noor1204/IPO/issues/new" target="_blank" rel="noopener noreferrer">Report a problem / ask a question</a><p class="mut sm" style="margin-bottom:0">When reporting, please write the IPO name and what looked wrong.</p>`) + card("Developer", `<p class="sm" style="margin:0"><b>Zynora Technology</b> (Noor)<br><span class="mut">© 2026 Zynora Technology. All rights reserved.</span></p>`));
  }
  if (k === "us") return subPage("About Us", usCards());
  if (k === "terms") return subPage("Terms & Condition", card("", `<ol class="alist" style="padding-left:20px">${TERMS.map(t => `<li>${esc(t)}</li>`).join("")}</ol>`));
  if (k === "privacy") {
    return subPage("Privacy Policy", card("", `<p class="sm" style="margin-top:0">${TEXT.privacy[lang()]}</p>${langBtn()}`) + card("What is stored on your device", `<ul class="alist"><li>Watchlist, compare list, alerts, applied IPOs, language, theme and (if you add it) your PAN — in this browser only.</li><li>Nothing like that is sent to a server.</li></ul>`));
  }
  if (k === "faq") return subPage("FAQs", card("", FAQ.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p class="sm">${esc(a)}</p></details>`).join("")));
  return null;
}
const usCards = () => card(TEXT.aboutTitle[lang()], about()) + card("Where the data comes from", `<ul class="alist"><li><b>NSE, BSE, SEBI</b> — issue details, dates, subscription, offer documents</li><li><b>Offer documents (RHP)</b> — company financials used for the score</li><li><b>InvestorGain, ipowatch</b> — GMP (unofficial grey-market rumours)</li><li><b>Yahoo Finance</b> — listing-day prices</li></ul><p class="mut sm" style="margin-bottom:0">Last refreshed: ${state.meta ? new Date(state.meta.generatedAt).toLocaleString("en-IN") : "—"}</p>`) + card("Developer", `<p class="sm" style="margin:0"><b>Zynora Technology</b> (Noor)<br><span class="mut">© 2026 Zynora Technology. All rights reserved.</span></p>`);
// About, General, Share and Help & Support are separate screens in the side bar; General / Share / Help list their rows, each row opens its own page
function aboutPage() { return `${head("About")}<div class="subpg">${usCards()}</div>`; }
function sectionPage(tab) {
  const sp = state.sub && subContent(state.sub);
  if (sp) return sp;
  state.sub = null;
  if (tab === "general") {
    const unread = notifList().length;
    return `${head("General")}<div class="aboutmenu">${msec("General", mrow("✅", "Applied IPO", "applied", state.applied.length ? `<small>${state.applied.length}</small>` : "") + mrow("📄", "Download ASBA Form", "asba") + mrow("🪪", "Add PAN Number", "pan", state.pan ? `<small>saved</small>` : "") + mrow("🔔", "Notifications", "notif", unread ? `<small>${unread}</small>` : "") + mrow("⚙️", "Notification Settings", "nsettings") +
      `<a class="mrow" href="https://news.google.com/search?q=IPO%20India&hl=en-IN&gl=IN&ceid=IN:en" target="_blank" rel="noopener noreferrer" data-track="link/news"><span class="mic">📰</span><span class="mlb">News</span><span class="mgo">↗</span></a>` +
      `<label class="mrow"><span class="mic">🌓</span><span class="mlb">Enable Dark Mode</span><input type="checkbox" class="switch" data-theme-toggle ${isDark() ? "checked" : ""} aria-label="Dark mode"></label>`)}</div>`;
  }
  if (tab === "share") return `${head("Share")}<div class="aboutmenu">${msec("Share", `<button class="mrow" data-appshare><span class="mic">🔗</span><span class="mlb">Share App</span><span class="mgo">›</span></button>` + mrow("⭐", "Rate App", "rate"))}</div>`;
  return `${head("Help & Support")}<div class="aboutmenu">${msec("Help & Support", mrow("💬", "Support", "support") + mrow("📋", "Terms & Condition", "terms") + mrow("🔒", "Privacy Policy", "privacy") + mrow("❓", "FAQs", "faq"))}</div>`;
}
async function shareApp() {
  const data = { title: "Trendy IPO", text: "Live IPO tracker: subscription, GMP trend, score and allotment links.", url: APP_URL() };
  try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(data.url); toast("Link copied. Paste it to share."); } catch { toast(data.url); }
}
function aboutClick(t) {
  const a = t.dataset;
  if (t.hasAttribute("data-appshare")) { shareApp(); return true; }
  if ("sub" in a) { state.sub = a.sub || null; render(); scrollTo(0, 0); return true; }
  if (a.applied) { const k = state.applied.indexOf(a.applied); k < 0 ? state.applied.push(a.applied) : state.applied.splice(k, 1); store.set("applied", state.applied); render(); return true; }
  if (a.rate) { state.rate = +a.rate; store.set("rate", state.rate); if (window.trendyTrack) window.trendyTrack("rate/" + a.rate, "Rated " + a.rate); render(); return true; }
  if (t.hasAttribute("data-pansave")) { const v = (document.getElementById("pan-in")?.value || "").trim().toUpperCase(); if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) { toast("PAN looks wrong. Format: ABCDE1234F"); return true; } state.pan = v; store.set("pan", v); toast("PAN saved on this device"); return true; }
  if (t.hasAttribute("data-pandel")) { state.pan = ""; store.set("pan", ""); render(); return true; }
  if (t.hasAttribute("data-pancopy")) { navigator.clipboard?.writeText(state.pan).then(() => toast("PAN copied"), () => toast("Could not copy")); return true; }
  return false;
}
document.addEventListener("change", e => { if (e.target.matches?.("[data-theme-toggle]")) { state.theme = e.target.checked ? "dark" : "light"; store.set("theme", state.theme); applyTheme(); } });
// ---------- render & events ----------
function render() {
  if (!state.loaded) { $("#app").innerHTML = `<p class="mut" style="margin-top:40px;text-align:center">${state.error ? esc(state.error) : "Loading IPO data…"}</p>`; return; }
  const screens = { ipo: ipoTab, compare, allot: allotment, unlisted, settings, about: aboutPage, general: () => sectionPage("general"), share: () => sectionPage("share"), help: () => sectionPage("help") };
  if (state.detail && !byId(state.detail)) state.detail = null;           // an IPO that is no longer in the data
  if (state.report && !byId(state.report)) state.report = null;
  if (state.modal && !byId(state.modal)) state.modal = null;
  const ae = document.activeElement, keep = ae && ae.id && ae !== document.body ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  $("#app").dataset.view = state.report ? "report" : state.detail ? "detail" : state.tab;
  $("#app").innerHTML = staleBar() + (state.report ? reportView() : state.detail ? detail() : screens[state.tab]()) + credit() +
    (acked() ? "" : `<div class="modal"><div class="card"><div class="sm">${disclaimer()}</div><button class="btn" data-ack style="width:100%;margin-top:12px">${lang() === "hi" ? "मैं समझ गया" : "I understand"}</button></div></div>`) +
    (state.modal ? (() => { const i = byId(state.modal); return `<div class="modal" data-close><div class="card"><h3>${preApply(i) ? "Pre-apply for" : "Apply for"} ${esc(i.name)}</h3><p class="sm">Open your broker app or UPI app → IPO section → choose <b>${esc(i.name)}</b>.</p>${preApply(i) ? `<p class="sm">The price band is out, so many brokers let you <b>pre-apply</b> now: your bid is placed in advance and goes in when the IPO opens${i.open ? " on <b>" + fmtD(i.open) + "</b>" : ""}. Availability depends on your broker.</p>` : ""}<ul class="sm"><li>Price: ₹${i.priceHigh} (cut-off)</li><li>Min. lot: ${i.lot} shares = ₹${inr(i.lot * i.priceHigh)}</li><li>Closes: ${fmtD(i.close)}</li></ul><a class="btn ${preApply(i) ? "pre" : ""}" style="display:block;margin:12px 0 10px;text-decoration:none;text-align:center" href="https://groww.in/ipo" data-track="broker/Groww" target="_blank" rel="noopener noreferrer">${preApply(i) ? "Pre Apply" : "Apply"} on Groww ↗</a><div class="sm" style="margin:0 0 6px"><b>Other brokers</b> <span class="mut">(opens their IPO page; log in with your own account)</span></div><div class="brokers">${BROKERS.filter(b => b[0] !== "Groww").map(([n, u]) => `<a class="chipb" data-track="broker/${esc(n)}" href="${u}" target="_blank" rel="noopener noreferrer">${n} ↗</a>`).join("")}</div><p class="mut sm" style="margin:8px 0 12px">You can also apply from the IPO section of UPI apps such as PhonePe, Google Pay or Paytm. Trendy IPO never asks for your login, UPI PIN or bank details.</p><button class="btn" data-close style="width:100%">Got it</button></div></div>`; })() : "") +
    (state.toast ? `<div class="toast">${state.toast}</div>` : "");
  if (keep) { const n = document.getElementById(keep.id); if (n && n !== document.activeElement) { n.focus({ preventScroll: true }); try { if (keep.s != null) n.setSelectionRange(keep.s, keep.e); } catch {} } }
  const side = $("#side"); side.innerHTML = sideMenu(); side.classList.toggle("open", !!state.drawer);
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", !state.detail && (b.dataset.tab === state.tab || (b.hasAttribute("data-menu") && (state.drawer || state.tab === "compare" || state.tab === "settings")))));
  const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); q.oninput = e => { state.q = e.target.value; render(); }; }
  const sel = (id, fn) => { const e = $(id); if (e) e.onchange = ev => fn(ev.target.value); };
  sel("#pick", v => { if (v) { state.cmp.push(v); store.set("cmp", state.cmp); render(); } });
  sel("#sort", v => { state.sort = v; render(); });
  sel("#allotSel", v => { state.allotIpo = v; render(); });
  pushView();
}
let toastTimer = null;
function toast(m) { state.toast = m; render(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { state.toast = ""; render(); }, 1800); }
document.addEventListener("click", e => {
  const t = e.target.closest("[data-open],[data-back],[data-tab],[data-seg],[data-watch],[data-cmp],[data-apply],[data-close],[data-jump],[data-search],[data-share],[data-toast],[data-ack],[data-lang],[data-report],[data-report-close],[data-print],[data-rtab],[data-more-filings],[data-pill],[data-stat],[data-more],[data-goto],[data-refresh],[data-star],[data-menu],[data-drawer-close],[data-sub],[data-applied],[data-appshare],[data-rate],[data-pansave],[data-pandel],[data-pancopy],[data-allot-open]"); if (!t) return;
  trackClick(t, t.dataset);
  if (t.hasAttribute("data-refresh")) { loadData(true); return; }
  if (t.hasAttribute("data-menu")) { state.drawer = !state.drawer; render(); return; }
  if (t.hasAttribute("data-drawer-close")) { state.drawer = false; render(); return; }
  if (aboutClick(t)) return;
  if (t.dataset.allotOpen) { state.allotIpo = t.dataset.allotOpen; state.tab = "allot"; state.detail = null; render(); scrollTo(0, 0); return; }
  if (t.hasAttribute("data-more-filings")) { state.allFilings = !state.allFilings; return render(); }
  if (t.dataset.report) { state.report = t.dataset.report; state.reportTab = "docs"; render(); scrollTo(0, 0); return; }
  if (t.dataset.rtab) { state.reportTab = t.dataset.rtab; render(); scrollTo(0, 0); return; }
  if (t.hasAttribute("data-report-close")) { goBack(); return; }
  if (t.hasAttribute("data-print")) { window.print(); return; }
  if (t.hasAttribute("data-lang")) { store.set("lang", t.dataset.lang); return render(); }
  if (t.hasAttribute("data-ack")) { state.ack = true; return render(); }
  if (t.hasAttribute("data-close") && e.target.closest(".card") && !t.matches("button")) return;
  const d = t.dataset;
  if (d.pill) { state.main = d.pill !== "sme"; state.sme = d.pill !== "main"; return render(); }
  if (d.stat) { const pf = d.stat === "gain" || d.stat === "loss"; state.seg = pf ? "listed" : d.stat; state.perf = pf ? d.stat : null; state.showAll = false; return render(); }
  if (t.hasAttribute("data-more")) { state.showAll = true; return render(); }
  if (d.goto) { state.seg = d.goto; state.perf = null; render(); scrollTo(0, 0); return; }
  if (d.open) { const pend = d.jump; state.detail = d.open; render(); scrollTo(0, 0); if (pend) document.getElementById(pend)?.scrollIntoView(); return; }
  if (d.jump) { document.getElementById(d.jump)?.scrollIntoView({ behavior: "smooth" }); return; }
  if (t.hasAttribute("data-back")) { goBack(); return; }
  else if (d.tab) { state.tab = d.tab; state.detail = null; state.report = null; state.drawer = false; state.sub = null; }
  else if (d.seg) { state.seg = d.seg; state.perf = null; state.showAll = false; }
  else if (t.hasAttribute("data-search")) { state.search = !state.search; if (!state.search) state.q = ""; }
  else if (d.watch) { const k = state.watch.indexOf(d.watch); k < 0 ? state.watch.push(d.watch) : state.watch.splice(k, 1); store.set("watch", state.watch); }
  else if (d.cmp) { const k = state.cmp.indexOf(d.cmp); if (k >= 0) state.cmp.splice(k, 1); else if (state.cmp.length < 3) state.cmp.push(d.cmp); store.set("cmp", state.cmp); }
  else if (d.apply) { const i = byId(d.apply); if (phase(i).k !== "apply") return toast("Bidding is closed for this IPO"); state.modal = i.symbol; }
  else if (t.hasAttribute("data-close")) { goBack(); return; }
  else if (t.hasAttribute("data-share")) { const i = byId(state.detail), txt = `${i.name} — Trendy IPO score ${score(i) ?? "N/A"}/100 (${verdict(score(i)).t})`; if (navigator.share) navigator.share({ text: txt }).catch(() => {}); else { try { navigator.clipboard.writeText(txt); } catch {} return toast("Copied to clipboard"); } return; }
  else if (d.toast) return toast(d.toast);
  render();
});
document.addEventListener("change", e => {
  const d = e.target.dataset;
  if (d.alert) { state.alerts[d.alert] = e.target.checked; store.set("alerts", state.alerts); }
  else if (d.board) { state[d.board] = e.target.checked; if (!state.main && !state.sme) state.main = true; render(); }
});
// status is recomputed from today's date so a stale data file never shows a closed IPO as live
const withStatus = i => ({ ...i, status: i.close && dayDiff(i.close) < 0 ? "listed" : i.open && dayDiff(i.open) > 0 ? "upcoming" : i.status === "listed" ? "listed" : "live" });
// ---------- the phone's Back button ----------
// Opening an IPO, a full report or the Apply popup adds one history step; Back then closes it. Switching tabs and report tabs do not add steps.
const levelKey = () => [state.detail || "", state.report || "", state.modal || ""].join("|");
let navLevel = levelKey();
const histState = () => ({ tab: state.tab, level: levelKey(), rtab: state.reportTab });
try { history.replaceState(histState(), ""); } catch {}
function pushView() {
  const lv = levelKey();
  try {
    if (lv !== navLevel) { navLevel = lv; history.pushState(histState(), ""); }
    else { const h = history.state || {}; if (h.tab !== state.tab || h.rtab !== state.reportTab) history.replaceState(histState(), ""); }
  } catch {}
}
window.addEventListener("popstate", e => {
  const s = e.state; if (!s || typeof s.level !== "string") return;
  const [detail, report, modal] = s.level.split("|");
  navLevel = s.level; state.tab = s.tab || "ipo"; state.detail = detail || null; state.report = report || null; state.modal = modal || null; if (s.rtab) state.reportTab = s.rtab;
  render(); window.scrollTo(0, 0);
});
// the on-screen back / close buttons use the same history, so the Back button and the arrow always agree
function goBack() {
  const before = levelKey();
  try { history.back(); } catch {}
  setTimeout(() => { if (levelKey() === before) { if (state.modal) state.modal = null; else if (state.report) state.report = null; else state.detail = null; render(); } }, 250);   // if the browser could not go back, close it directly
}
let loadingData = false, lastLoad = 0;
async function loadData(manual) {
  if (loadingData) return;
  loadingData = true; if (manual) { state.refreshing = true; render(); }
  const first = !state.loaded;
  try {
    const r = await fetch("data/ipos.json?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const j = clean(await r.json()), changed = state.meta?.generatedAt !== j.generatedAt;
    lastLoad = Date.now();
    if (changed || first) {
      state.meta = j;
      // status is recomputed from today's date so a stale data file never shows a closed IPO as live
      state.ipos = j.ipos.map(withStatus);
      state.loaded = true; state.error = "";
      if (first && !j.ipos.some(i => i.status === "live")) state.seg = "upcoming";
    }
    state.refreshing = false; loadingData = false;
    if (manual) toast(changed ? "Data updated" : "You already have the latest data"); else if (changed || first) render();
  } catch (e) {
    state.refreshing = false; loadingData = false;
    if (first) { state.error = "Could not load data/ipos.json. Check your internet connection and try again. (" + e.message + ")"; render(); }
    else if (manual) toast("Could not refresh: check your internet connection");
    else render();
  }
}
render();
loadData(false);
setInterval(() => { if (document.visibilityState === "visible") loadData(false); }, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastLoad > 5 * 60 * 1000) loadData(false); });

// ---------- pull to refresh ----------
(() => {
  let y0 = null, dy = 0, bar = null;
  const hide = () => { if (bar) bar.classList.remove("show"); };
  document.addEventListener("touchstart", e => { y0 = window.scrollY <= 0 && e.touches.length === 1 && !document.querySelector(".modal") ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  document.addEventListener("touchmove", e => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy < 10) return hide();
    if (!bar) { bar = document.createElement("div"); bar.id = "ptr"; document.body.appendChild(bar); }
    bar.textContent = dy > 70 ? "Release to refresh" : "Pull down to refresh"; bar.classList.add("show");
  }, { passive: true });
  const done = () => { const go = y0 !== null && dy > 70; y0 = null; dy = 0; if (!go) return hide(); bar.textContent = "Refreshing…"; bar.classList.add("show"); loadData(true).finally(hide); navigator.serviceWorker?.getRegistration().then(r => r && r.update()).catch(() => {}); };   // also looks for a new version of the app
  document.addEventListener("touchend", done, { passive: true });
  document.addEventListener("touchcancel", () => { y0 = null; dy = 0; hide(); }, { passive: true });
})();

// ---------- once a second: countdowns, the closing moment, and midnight ----------
const firedEnds = new Set();   // each closing / allotment / listing moment redraws the screen once
function tick() {
  const dayNow = istDay();
  if (dayNow !== isoLocal(today)) { today = pd(dayNow); if (state.loaded) state.ipos = state.ipos.map(withStatus); render(); return; }   // a new day began while the app was open
  let redraw = false;
  document.querySelectorAll("[data-end]").forEach(el => {
    const ms = +el.dataset.end - Date.now();
    if (ms <= 0) { if (!firedEnds.has(el.dataset.end)) { firedEnds.add(el.dataset.end); redraw = true; } return; }                                                      // bidding just closed: swap the button for the new status
    const b = el.querySelector("[data-cdtxt]"); if (b) b.textContent = fmtCd(ms);
    if (!el.dataset.k || el.dataset.k === "apply") el.classList.toggle("urgent", ms < 3600e3);
  });
  if (redraw) render();
}
setInterval(tick, 1000);

document.addEventListener("keydown", e => { if (e.key === "Escape" && state.drawer) { state.drawer = false; render(); } });
