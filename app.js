const $ = s => document.querySelector(s);
// one icon set: Tabler outline icons as an inline sprite in index.html (<symbol id="ti-name">)
const ic = (name, cls = "") => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#ti-${name}"/></svg>`;
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
// hl(text, query): escaped HTML of text with every case-insensitive match of the query wrapped in <mark class="hl">. The query may also be an array of terms
// (all of them are marked). No RegExp is built from user input: matches are found with indexOf on a length-preserving lower-case copy, text is escaped piece by piece.
const lowSame = t => { let o = ""; for (let k = 0; k < t.length; k++) { const c = t[k], l = c.toLowerCase(); o += l.length === 1 ? l : c; } return o; };   // same length as t, so indexes carry over
function hl(text, query) {
  text = String(text ?? "");
  const terms = (Array.isArray(query) ? query : [query]).map(x => String(x ?? "").trim()).filter(Boolean).slice(0, 6);
  if (!terms.length || !text) return esc(text);
  const lt = lowSame(text), spans = [];
  for (const t of terms) { const lq = lowSame(t); let i = 0, p; while ((p = lt.indexOf(lq, i)) >= 0) { spans.push([p, p + lq.length]); i = p + lq.length; } }
  if (!spans.length) return esc(text);
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "", at = 0;
  for (const [a, b] of spans) { if (b <= at) continue; const from = Math.max(a, at); out += esc(text.slice(at, from)) + '<mark class="hl">' + esc(text.slice(from, b)) + "</mark>"; at = b; }
  return out + esc(text.slice(at));
}
// scroll the first element matching sel (inside #app) to the middle of the screen and flash it once (no flash when the user prefers reduced motion)
function flashFirst(sel) {
  const el = document.querySelector("#app " + sel); if (!el) return false;
  const reduced = matchMedia("(prefers-reduced-motion:reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  if (!reduced) { el.classList.remove("hl-flash"); void el.offsetWidth; el.classList.add("hl-flash"); el.addEventListener("animationend", () => el.classList.remove("hl-flash"), { once: true }); }
  return true;
}
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
const subNow = i => { const t = i.bids?.total?.times ?? i.demand?.timesSubscribed ?? null; return isNum(t) ? f2(t) + "x" : i.status === "upcoming" ? "Not open yet" : i.status === "live" ? "Awaiting bids" : "—"; };
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
const verdict = s => s === null ? { t: "Insufficient data", e: "", c: "gr" } : s >= 80 ? { t: "High score", e: "", c: "g" } : s >= 60 ? { t: "Moderate score", e: "", c: "y" } : { t: "Low score", e: "", c: "r" };
const col = s => s === null ? "var(--bd)" : s >= 80 ? "var(--ok)" : s >= 60 ? "var(--warn)" : "var(--bad)";
function reasons(i) {
  const { v, why } = factors(i), out = [];
  for (const k of Object.keys(v)) out.push([v[k] >= 70 ? "good" : v[k] >= 50 ? "mid" : "low", `${FACTOR_LABEL[k]}: ${why[k]}`]);
  const m = Object.keys(WEIGHTS).filter(k => !(k in v)).map(k => FACTOR_LABEL[k]);
  if (m.length) out.push(["info", `Not scored (data unavailable): ${m.join(", ")}`]);
  return out;
}

// ---------- shared UI ----------
const ring = (s, big) => `<div class="ring ${big ? "big" : ""} ${s === null || s === undefined ? "na" : ""}" ${s === null || s === undefined ? 'title="Score not available: the offer document has not been analysed yet"' : ""} style="--rc:${col(s)};--rp:${(s ?? 0) * 3.6}deg"><span>${s ?? "N/A"}</span></div>`;
const hue = s => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
const logoText = i => /^IG-/.test(i.symbol) ? i.name.split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase() : i.symbol.slice(0, 3);   // IG-only entries have no exchange symbol
const logo = i => `<div class="logo" style="background:hsl(${hue(i.symbol)} 55% 31%)"><span>${esc(logoText(i))}</span>${logoSrc(i.logo) ? `<img src="${esc(logoSrc(i.logo))}" alt="" referrerpolicy="no-referrer">` : ""}</div>`;   // if the image fails to load it is removed and the initials show
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
  if (i.status === "live" && (end === null || now < end)) return { k: "apply", end: end && i.close === isoLocal(today) ? end : null, tl: "Closes in", sub: endLabel(i) };
  if (i.listingPerf || (!i.allotment && !i.listing) || (i.listing && dayDiff(i.listing) < 0)) return { k: "listed" };
  const ex = i.datesExpected ? " (exp.)" : "";
  if (i.listing && dayDiff(i.listing) === 0) { const t = new Date(i.listing + "T10:00:00" + IST_OFFSET).getTime(); return { k: "listingToday", label: ic("bell-ringing") + " Listing today", end: t > now ? t : null, tl: "Listing in", sub: "10:00 AM" }; }
  if (i.allotment && dayDiff(i.allotment) < 0) return { k: "listing", label: ic("trending-up") + " Listing on " + fmtD(i.listing) + ex, end: i.listing ? new Date(i.listing + "T10:00:00" + IST_OFFSET).getTime() : null, tl: "Listing in", sub: "10:00 AM" };
  if (i.allotment && dayDiff(i.allotment) === 0) return { k: "allotDay", label: ic("circle-check") + " Allotment day: check your status" };
  return { k: "wait", label: ic("hourglass") + " Waiting for allotment" + (i.allotment ? " · " + fmtD(i.allotment) + ex : ""), end: i.allotment ? new Date(i.allotment + "T00:00:00" + IST_OFFSET).getTime() : null, tl: "Allotment day starts in", sub: i.allotment ? fmtD(i.allotment) + ex : "" };
}
const pad2 = n => String(n).padStart(2, "0");
const fmtCd = ms => { const s = Math.max(0, Math.floor(ms / 1000)), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d > 0 ? d + "d " + pad2(h) + "h " + pad2(m) + "m " : h > 0 ? h + "h " + pad2(m) + "m " : m + "m ") + pad2(s % 60) + "s"; };
// the live countdown (numbers are updated every second by tick() at the end of this file)
const cdFor = i => { const p = phase(i); if (!p.end || p.end <= Date.now()) return ""; return `<div class="cd${p.k === "apply" ? (p.end - Date.now() < 3600e3 ? " urgent" : "") : " soft"}" data-end="${p.end}" data-k="${p.k}">${ic("clock")} ${p.tl} <b data-cdtxt>${fmtCd(p.end - Date.now())}</b>${p.sub ? ` <span class="cdsub">· ${p.sub}</span>` : ""}</div>`; };
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
  if (i.status === "live" && !i.close) return `<span class="st red"><i class="dot"></i>Open now</span>`;
  if (i.status === "upcoming" && !i.open) return `<span class="st blue">Upcoming</span>`;
  if (notOpenYet(i)) return `<span class="st blue" data-end="${opensAt(i)}" data-k="open">Opens today · 10:00 AM</span>`;
  if (i.status === "live" && i.close && dayDiff(i.close) === 0 && endAt(i) && Date.now() >= endAt(i)) return `<span class="st gray">Bidding closed</span>`;
  if (i.status === "live") { const d = dayDiff(i.close); return `<span class="st red"><i class="dot"></i>${d === 0 ? "Closes Today" : `Closes in ${d} day${d > 1 ? "s" : ""}`}</span>`; }
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
const px = n => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const price = i => isNum(i.priceLow) && isNum(i.priceHigh) ? `₹${px(i.priceLow)} – ₹${px(i.priceHigh)}` : isNum(i.priceHigh) ? `₹${px(i.priceHigh)}` : "—";
// Registrar allotment-status pages (public), matched by the registrar name NSE gives us
// [name part, address, kind]: "status" = the page where you enter your PAN / application number; "site" = the registrar's own website (find "IPO status" there)
const REGISTRARS = [["kfin", "https://ipostatus.kfintech.com/", "status"], ["link intime", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html", "status"], ["mufg", "https://in.mpms.mufg.com/Initial_Offer/public-issues.html", "status"],
  ["skyline", "https://www.skylinerta.com/ipo.php", "status"], ["bigshare", "https://ipo.bigshareonline.com/IPO_Status.html", "status"], ["cameo", "https://ipostatus1.cameoindia.com/", "status"], ["purva", "https://www.purvashare.com/investor-service/ipo-query", "status"],
  ["maashitla", "https://maashitla.com/allotment-status", "status"], ["mas services", "https://www.masserv.com/", "site"], ["integrated", "https://www.integratedregistry.in/", "site"], ["beetal", "https://beetal.in/", "site"]];
const BSE_STATUS = "https://www.bseindia.com/investors/appli_check.aspx";
const registrarLink = i => { const n = (i.registrar?.name || "").toLowerCase(), r = REGISTRARS.find(([k]) => n.includes(k)); return r ? { url: r[1], kind: r[2] } : null; };
const fmtGain = p => isNum(p) ? `<span class="${p >= 0 ? "grn-t" : "red-t"}">${p >= 0 ? "+" : ""}${p.toFixed(1)}%</span>` : "—";
function subBar(i) {
  const t = totalTimes(i);
  if (!isNum(t)) return "";
  return `<div class="sbar" title="Subscription ${f2(t)}x"><i style="width:${Math.max(3, Math.min(100, t / 10 * 100))}%"></i></div>`;
}
function listCard(i) {
  const sc = scoreOf(i), v = verdict(sc.score), t = totalTimes(i), g = gmpNow(i);
  const gcls = isNum(g) ? (g >= 0 ? "grn-t" : "red-t") : "mut";
  const tone = i.listingPerf && isNum(i.listingPerf.dayOpenGainPct) ? (i.listingPerf.dayOpenGainPct >= 0 ? " t-up" : " t-dn") : isNum(g) ? (g > 0 ? " t-up" : g < 0 ? " t-dn" : "") : "";
  return `<div class="card ipoc${tone}" data-open="${i.symbol}"><div class="ipoc-top">${logo(i)}<div class="ipoc-id"><h3>${state.q ? hl(i.name, state.q) : esc(i.name)}</h3><div class="ipoc-meta"><span class="pill">${esc(i.board)}</span>${stLabel(i)}</div></div>
  <div class="ipoc-score">${ring(sc.score)}<span class="badge ${v.c}">${v.t}</span></div></div>
  <div class="kv3"><div><span>Price band</span><b>${price(i)}</b></div><div><span>Lot size</span><b>${isNum(i.lot) ? i.lot + " sh" : "—"}</b></div><div><span>Issue size</span><b>${isNum(i.issueSizeCr) ? "₹" + cr(i.issueSizeCr) + " Cr" : "—"}</b></div></div>
  <div class="ipoc-sub"><div><div class="row sm"><span class="mut">${i.listingPerf ? "Day-1 gain" : "Subscribed"}</span><b>${i.listingPerf ? fmtGain(i.listingPerf.dayOpenGainPct) : isNum(t) ? f2(t) + "x" : "—"}</b></div>${i.listingPerf ? "" : subBar(i)}</div>
  <div class="ipoc-gmp"><span class="mut sm">GMP (rumour)</span><b class="${gcls}">${gmpTxt(i)}</b></div></div>
  <div class="mut sm ipoc-dates">${fmtS(i.open)} to ${fmtD(i.close)} · Listing ${fmtD(i.listing)}${i.datesExpected ? " (exp.)" : ""}</div>
  ${cdFor(i)}<div class="acts"><button class="btn ghost" data-open="${i.symbol}">View</button><button class="btn ghost ai" data-open="${i.symbol}" data-jump="ai" aria-label="Open score">${ic("sparkles")} Score</button>
  ${actionBtn(i)}</div></div>`;
}
const bellDot = () => unreadCount() ? '<i class="bdot"></i>' : "";
const brand = () => `<header class="brand"><div class="brand-row"><span class="logomark"><img src="icons/logo.svg" alt="" width="34" height="34"></span><span class="wm">Trendy <b>IPO</b></span><span class="sp"></span><button class="ib sq" data-bell aria-label="Notifications">${ic("bell")}${bellDot()}</button><button class="ib sq menubtn" data-menu aria-label="Open menu">${ic("menu-2")}</button></div>
<button class="gsearch" data-gsearch aria-label="Search IPOs, stocks and funds">${ic("search")}<span>Search IPOs, stocks, funds</span></button></header>`;
const backBtn = () => "";
const head = (title, extra = "") => `${brand()}<div class="top">${state.tab !== "ipo" || state.seg !== "live" ? backBtn() : ""}<h1>${title}</h1>${extra}</div>${modStrip()}`;
// GMP trend: one point per day, the last one is today. Hover (mouse) or touch/drag (phone) on the chart shows that day's date and rate.
let GCH = [];
function gmpDay(p, k, arr) {
  const prev = k > 0 ? arr[k - 1].gmp : null, d = prev === null ? null : p.gmp - prev;
  const when = p.date === istDay() ? "Today" : fmtD(p.date), wd = pd(p.date).toLocaleDateString("en-IN", { weekday: "short" });
  const chg = d === null ? "first record" : d === 0 ? "no change from the day before" : `<span class="${d > 0 ? "grn-t" : "red-t"}">${d > 0 ? "up" : "down"} ₹${Math.abs(d % 1 ? +d.toFixed(1) : d)}</span> from the day before`;
  return `<b>${when}</b> <span class="mut">(${wd}${p.date === istDay() ? ", " + fmtD(p.date) : ""})</span><br>GMP <b class="${p.gmp >= 0 ? "grn-t" : "red-t"}">₹${p.gmp}</b> · ${chg}`;
}
function smoothPath(p) {
  if (p.length < 2) return "";
  let d = "M" + p[0][0].toFixed(1) + "," + p[0][1].toFixed(1);
  for (let k = 0; k < p.length - 1; k++) {
    const p0 = p[k - 1] || p[k], p1 = p[k], p2 = p[k + 1], p3 = p[k + 2] || p2, t = 0.18;
    d += "C" + (p1[0] + (p2[0] - p0[0]) * t).toFixed(1) + "," + (p1[1] + (p2[1] - p0[1]) * t).toFixed(1) + " " + (p2[0] - (p3[0] - p1[0]) * t).toFixed(1) + "," + (p2[1] - (p3[1] - p1[1]) * t).toFixed(1) + " " + p2[0].toFixed(1) + "," + p2[1].toFixed(1);
  }
  return d;
}
function gmpChart(hist) {
  const h = (hist || []).filter(x => x && isNum(x.gmp) && x.date).sort((a, b) => a.date < b.date ? -1 : 1);
  if (h.length < 2) return "";
  GCH = h;
  const W = 320, H = 160, L = 40, R = 12, T = 12, B = 26, v = h.map(x => x.gmp), mn = Math.min(...v), mx = Math.max(...v), pad = (mx - mn || Math.abs(mx) || 1) * .15;
  const lo = mn - pad, hi = mx + pad, X = k => L + k * (W - L - R) / (h.length - 1), Y = g => T + (hi - g) / (hi - lo) * (H - T - B);
  const up = last(v) >= v[0], c = up ? "var(--ok)" : "var(--bad)", P = h.map((x, k) => [X(k), Y(x.gmp)]), line = smoothPath(P);
  const area = line + "L" + X(h.length - 1).toFixed(1) + "," + (H - B) + "L" + X(0).toFixed(1) + "," + (H - B) + "Z";
  const ticks = [mx, (mx + mn) / 2, mn].filter((t, k, a) => a.indexOf(t) === k).map(t => `<line x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" class="ggrid"/><text x="${L - 5}" y="${Y(t) + 3.5}" text-anchor="end" class="gax">₹${Math.round(t)}</text>`).join("");
  const dl = k => pd(h[k].date).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const idx = [...new Set([0, Math.floor((h.length - 1) / 2), h.length - 1])];
  const xl = idx.map(k => `<text x="${X(k)}" y="${H - 7}" text-anchor="${k === 0 ? "start" : k === h.length - 1 ? "end" : "middle"}" class="gax">${k === h.length - 1 && h[k].date === istDay() ? "Today" : dl(k)}</text>`).join("");
  const dots = h.map((x, k) => `<circle class="gdot${k === h.length - 1 ? " on" : ""}" data-k="${k}" cx="${X(k)}" cy="${Y(x.gmp)}" r="${k === h.length - 1 ? 5 : 3.2}" fill="${c}"/>`).join("");
  return `<div class="gch" data-n="${h.length}" data-l="${L}" data-r="${R}" data-w="${W}"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="GMP trend by day"><defs><linearGradient id="gfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c};stop-opacity:.38"/><stop offset="1" style="stop-color:${c};stop-opacity:0"/></linearGradient></defs>${ticks}<path d="${area}" fill="url(#gfill)" class="garea"/><path d="${line}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" class="gline"/><line class="gcur" x1="${X(h.length - 1)}" x2="${X(h.length - 1)}" y1="${T}" y2="${H - B}"/>${dots}${xl}</svg>
  <div class="gread" aria-live="polite">${gmpDay(h[h.length - 1], h.length - 1, h)}</div><div class="mut sm">${h.length} days recorded · move your cursor or finger over the chart to see any day</div></div>`;
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
    g && card(ic("rocket"), "Highest GMP", "₹" + gmpNow(g), `${esc(shortName(g.name))} · ${gmpPct(g).toFixed(0)}%`, gmpNow(g) >= 0 ? "grn-t" : "red-t", g.symbol),
    s && card(ic("flame"), "Most subscribed", f2(totalTimes(s)) + "x", esc(shortName(s.name)), "", s.symbol),
    sc && card(ic("trophy"), "Top score", score(sc) + "/100", esc(shortName(sc.name)), "", sc.symbol),
    card(ic("clock"), "Closing today", String(closingNow.length), closingNow.length ? ["Mainboard", "SME"].map(b => { const g = closingNow.filter(i => (i.board === "SME" ? "SME" : "Mainboard") === b); return g.length ? `<div class="bdline"><span class="bd ${b === "SME" ? "sme" : "main"}">${b} · ${g.length}</span> ${g.map(i => esc(shortName(i.name))).join(", ")}</div>` : ""; }).join("") : "No IPO closes today", closingNow.length ? "red-t" : "")
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
  return `<div class="card dcard"><h2>${ic("calendar-event")} ${status === "live" ? "Live IPOs" : "Upcoming IPOs"} · next ${days} days</h2>${rows || `<p class="mut sm">No events in the next ${days} days.</p>`}</div>`;
}
// day-1 gain of the latest listings, drawn to one scale
function recentCard() {
  const gain = i => i.listingPerf?.dayOpenGainPct;
  const all = state.ipos.filter(i => i.status === "listed" && isNum(gain(i)) && boardOk(i));
  const rows = all.slice().sort((x, y) => (y.listing || "").localeCompare(x.listing || "")).slice(0, 8);
  if (!rows.length) return "";
  const mx = Math.max(...rows.map(i => Math.abs(gain(i))), 1), up = all.filter(i => gain(i) >= 0).length, avg = all.reduce((s, i) => s + gain(i), 0) / all.length;
  return `<div class="card dcard"><h2>${ic("chart-bar")} Recent listings · Day-1</h2><p class="mut sm" style="margin:-4px 0 10px">${up} of ${all.length} listed in gain · average ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%</p>
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
  if (state.q) list = list.filter(i => (i.name + " " + i.symbol).toLowerCase().includes(state.q.trim().toLowerCase()));
  const nn = (a, b) => (b ?? -1e9) - (a ?? -1e9);
  const sorters = { score: (a, b) => nn(score(a), score(b)), gmp: (a, b) => nn(gmpPct(a), gmpPct(b)), subs: (a, b) => nn(totalTimes(a), totalTimes(b)), date: (a, b) => (a.open || "").localeCompare(b.open || "") };
  list.sort(sorters[state.sort]);
  const closingToday = state.seg === "live" ? list.filter(isClosingToday) : [];
  if (closingToday.length) list = list.filter(i => !isClosingToday(i));   // shown in their own block above
  const cand = state.ipos.filter(i => i.status === state.seg && score(i) !== null && boardOk(i)), top = cand.sort((a, b) => score(b) - score(a))[0];
  const shown = state.seg === "listed" && !state.showAll && !state.q ? list.slice(0, 12) : list;
  const stat = ([k, l, c]) => `<button class="stat ${active === k ? "on" : ""}" data-stat="${k}"><span>${l}</span><b class="${c} cu" data-cu="stat-${k}" data-to="${cnt[k]}">${cnt[k]}</b></button>`;
  return `${head('Live Subscription')}
  ${state.q ? `<input id="q" placeholder="Filter IPOs" value="${esc(state.q)}">` : ""}
  <div class="stats" role="group" aria-label="IPO lists">${[["live", "Open IPOs", ""], ["upcoming", "Upcoming IPOs", ""], ["listed", "Closed IPOs", ""], ["gain", "Listed in gains", "grn-t"], ["loss", "Listed in loss", "red-t"]].map(stat).join("")}</div>
  <div class="opts"><label class="chk"><input type="checkbox" data-board="main" ${state.main ? "checked" : ""}> MainBoard</label><label class="chk"><input type="checkbox" data-board="sme" ${state.sme ? "checked" : ""}> SME</label><span class="sp"></span>
  <select id="sort" aria-label="Sort" class="sortsel"><option value="score" ${state.sort === "score" ? "selected" : ""}>Sort: Score</option><option value="gmp" ${state.sort === "gmp" ? "selected" : ""}>Sort: GMP %</option><option value="subs" ${state.sort === "subs" ? "selected" : ""}>Sort: Subscription</option><option value="date" ${state.sort === "date" ? "selected" : ""}>Sort: Open date</option></select></div>
  ${top && state.seg !== "listed" && !state.q ? `<div class="note topnote">${ic("trophy")}<span><b>Highest score:</b> ${esc(top.name)} — ${score(top)}/100 (${verdict(score(top)).t})</span></div>` : ""}
  ${state.seg === "live" && !state.q ? insights() : ""}
  ${state.seg === "listed" && !state.q ? `<div class="two">${recentCard()}</div>` : ""}
  ${state.seg === "listed" ? outcomes() : ""}
  ${closingBlock(closingToday)}
  ${state.seg === "upcoming" ? upDashboard() : (shown.length ? `<div class="cards">${shown.map(listCard).join("")}</div>` : (closingToday.length ? "" : '<p class="mut empty">No IPOs in this category.</p>'))}
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
const GMP_HIT = { close: `<span class="grn-t">${ic("circle-check")} Close</span>`, near: `<span class="warn-t">${ic("alert-triangle")} Near</span>`, miss: `<span class="red-t">${ic("x")} Missed</span>` };
const fmtPts = e => isNum(e) ? `<span class="${Math.abs(e) <= 5 ? "grn-t" : Math.abs(e) <= 10 ? "" : "red-t"}">${e >= 0 ? "+" : ""}${e.toFixed(1)} pts</span>` : "—";
const SCORE_HIT = h => h === null ? "—" : h ? `<span class="grn-t">${ic("circle-check")} Matched</span>` : `<span class="red-t">${ic("x")} Not matched</span>`;
// Closed tab: how did our GMP and score compare with what actually happened on listing?
function outcomes() {
  const rows = state.ipos.map(i => ({ i, m: listingMatch(i) })).filter(r => r.m && (r.m.gmpP !== null || r.m.score !== null)).sort((a, b) => (b.i.listing || "").localeCompare(a.i.listing || ""));
  if (rows.length < 2) return "";
  const g = rows.filter(r => r.m.gmpHit), s = rows.filter(r => r.m.scoreHit !== null);
  const close = g.filter(r => r.m.gmpHit === "close").length, near = g.filter(r => r.m.gmpHit === "near").length;
  const avg = g.length ? g.reduce((a, r) => a + Math.abs(r.m.err), 0) / g.length : null, hit = s.filter(r => r.m.scoreHit).length;
  const sum = `<div class="stats" style="margin:0 0 10px">${g.length ? `<div class="stat" style="cursor:default"><b>${close}/${g.length}</b><span>GMP close (within 5 pts)</span></div><div class="stat" style="cursor:default"><b>${close + near}/${g.length}</b><span>GMP within 10 pts</span></div><div class="stat" style="cursor:default"><b>${avg.toFixed(1)} pts</b><span>Average GMP miss</span></div>` : ""}${s.length ? `<div class="stat" style="cursor:default"><b>${hit}/${s.length}</b><span>Score matched the outcome</span></div>` : ""}</div>`;
  return card(ic("chart-bar") + " GMP & score vs actual listing", sum + tbl(["IPO", "Score", "GMP at listing", "Actual day-1 open", "GMP vs actual", "Score"], rows.map(({ i, m }) => [esc(i.name), m.score ?? "—", m.gmpP === null ? "—" : `₹${m.gmp} ${fmtGain(m.gmpP)}`, fmtGain(m.actual), m.gmpHit ? `${fmtPts(m.err)} ${GMP_HIT[m.gmpHit]}` : "—", SCORE_HIT(m.scoreHit)])) +
    `<p class="mut sm"><b>GMP</b> = last grey-market reading on or before listing day, as % of the issue price. "GMP vs actual" = actual day-1 gain minus the GMP % (green = within 5 points, amber = within 10). <b>Score</b> 60+ expects no loss (day-1 open at or above the issue price), below 60 expects a loss; "Matched" means the real day-1 open agreed. Day-1 open is from Yahoo Finance and can differ slightly from the exchange's discovered listing price. GMP is rumour data; this is information, not investment advice.</p>`);
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
      <div class="dots sm">${(() => { const e = endAt(i); return e && e > Date.now() ? `<span class="wait cdline${e - Date.now() < 3600e3 ? " urgent" : ""}" data-end="${e}">${ic("clock")} Closes in <b data-cdtxt>${fmtCd(e - Date.now())}</b> <span class="cdsub">· ${endLabel(i)}</span></span>` : `<span class="wait">Last day · allotment ${i.allotment ? fmtS(i.allotment) : "—"}</span>`; })()}</div></div>
    <div class="upgmp">${isNum(g) ? `<div class="gmpnum ${gcls}">₹${g}</div><div class="gmplbl ${gcls}">GMP${isNum(gmpPct(i)) ? " " + gmpPct(i).toFixed(0) + "%" : ""}</div>` : `<div class="mut sm" style="text-align:right">No GMP<br>yet</div>`}</div></div>`;
}
function closingBlock(list) {
  if (!list.length) return "";
  return `<div class="closebox"><h2 class="closeh">${ic("flame")} Closing today (${list.length})</h2><p class="mut sm closep">Last day to apply. Bidding usually ends at 5:00 PM for MainBoard (SME may end earlier): apply through your broker/UPI app well before the cut-off.</p><div class="cards">${list.map(closeRow).join("")}</div></div>`;
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
      <div class="dots sm"><span class="${hasPrice ? "ok" : "wait"}"><i class="dot"></i>Price band</span><span class="${docOk ? "ok" : "wait"}"><i class="dot"></i>Offer doc</span>${preApply(i) ? `<span class="prea">${ic("check")} Pre-apply open</span>` : ""}${sc.score !== null ? `<span class="ok"><i class="dot"></i>Score ${sc.score}</span>` : ""}</div></div>
    <div class="upgmp">${isNum(g) ? `<div class="gmpnum ${gcls}">₹${g}</div><div class="gmplbl ${gcls}">GMP${isNum(gmpPct(i)) ? " " + gmpPct(i).toFixed(0) + "%" : ""}</div>` : `<div class="mut sm" style="text-align:right">No GMP<br>yet</div>`}</div>
  </div>`;
}
// summary + grouped list: this week / next week / later / date not announced
function upDashboard() {
  const ups = upList();
  if (!ups.length) return `<p class="mut" style="text-align:center;margin-top:30px">No upcoming IPOs right now.</p>`;
  const wk = ups.filter(i => { const n = dayDiff(i.open); return n !== null && n <= 7; }).length;
  const top = ups.filter(i => isNum(gmpNow(i))).sort((a, b) => gmpNow(b) - gmpNow(a))[0];
  const groups = [["This week", i => { const n = dayDiff(i.open); return n !== null && n <= 7; }], ["Next week", i => { const n = dayDiff(i.open); return n !== null && n > 7 && n <= 14; }], ["Later", i => { const n = dayDiff(i.open); return n !== null && n > 14; }], ["Dates not announced", i => dayDiff(i.open) === null]];
  return `<div class="tiles ut-tiles"><div class="tile ut ut1"><i>${ic("calendar")}</i>Upcoming<b>${ups.length}</b></div><div class="tile ut ut2"><i>${ic("clock")}</i>Opening in 7 days<b>${wk}</b></div><div class="tile ut ut3"><i>${ic("rocket")}</i>Highest GMP<b>${top ? "₹" + gmpNow(top) : "—"}</b><span class="mut sm">${top ? esc(top.name.split(" ").slice(0, 2).join(" ")) : ""}</span></div></div>` +
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
      <div class="dots sm"><span class="wait"><i class="dot"></i>Price band</span><span class="wait"><i class="dot"></i>Dates</span><span class="ok"><i class="dot"></i>SEBI document</span></div></div>
    <div class="upgmp">${isNum(g) ? `<div class="gmpnum ${g >= 0 ? "grn-t" : "red-t"}">₹${g}</div><div class="gmplbl ${g >= 0 ? "grn-t" : "red-t"}">GMP</div>` : `<div class="mut sm">No GMP<br>yet</div>`}<div class="sm" style="color:var(--pri);margin-top:4px">SEBI ${ic("external-link")}</div></div></a>`;
}
function filingsBlock() {
  const all = (state.meta?.filings || []).slice().sort((x, y) => y.date.localeCompare(x.date));
  if (!all.length) return "";
  const week = all.filter(f => -dayDiff(f.date) <= 7), earlier = all.filter(f => -dayDiff(f.date) > 7), withGmp = all.filter(f => isNum(f.gmp)).length;
  return `<h2 class="secth">${ic("clipboard-list")} To be announced <span class="mut sm">(filed with SEBI)</span></h2>
  <p class="mut sm" style="margin:0 0 10px">These companies have filed for an IPO but have not announced dates or a price band yet. Filing does not mean the IPO will happen soon.</p>
  <div class="tiles ut-tiles"><div class="tile ut ut1"><i>${ic("clipboard-list")}</i>Total<b>${all.length}</b></div><div class="tile ut ut2"><i>${ic("sparkles")}</i>Filed last 7 days<b>${week.length}</b></div><div class="tile ut ut3"><i>${ic("trending-up")}</i>With GMP<b>${withGmp}</b></div></div>
  ${week.length ? `<h3 class="subh mut">Filed in the last 7 days</h3><div class="cards">${week.map(filingRow).join("")}</div>` : ""}
  ${earlier.length ? `<h3 class="subh mut">Earlier filings</h3><div class="cards">${earlier.map(filingRow).join("")}</div>` : ""}`;
}
const tlRow = (label, d, est) => [label, d ? `${fmtD(d)}${est ? " (exp.)" : ""}` : "—"];

// ---------- documents + full report ----------
const reportCard = i => `<div class="card"><button class="btn wide" data-report="${i.symbol}">${ic("file-text")} Full company report</button><p class="mut sm" style="margin:8px 0 0">All documents (read or download) and the complete data for this company.</p></div>`;
const docIcon = d => ic(d.kind === "pdf" || d.kind === "pdf-link" ? "file-text" : d.kind === "link" ? "link" : d.kind === "zip" ? "file-zip" : "file-text");
function docRow(d) {
  if (!safeUrl(d.url)) return "";                                  // a link that is not a normal web address is not shown
  const url = esc(safeUrl(d.url)), meta = [d.source, d.kind === "pdf" || d.kind === "pdf-link" ? "PDF" : d.kind === "zip" ? "ZIP" : null, d.sizeMB ? d.sizeMB + " MB" : null].filter(Boolean).join(" · ");
  const btns = d.kind === "pdf-link"
    ? `<a class="btn sm" href="${url}" target="_blank" rel="noopener noreferrer">Read</a><a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer">Download</a>`
    : d.hosted && d.kind === "pdf"
    ? `<a class="btn sm" href="${url}" target="_blank" rel="noopener noreferrer">Read</a><a class="btn sm ghost" href="${url}" download>Download</a>`
    : d.kind === "link" ? `<a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer">Open ${ic("external-link")}</a>`
    : `<a class="btn sm ghost" href="${url}" target="_blank" rel="noopener noreferrer" download>Download</a>`;
  return `<div class="docrow"><div class="docinfo"><b>${docIcon(d)} ${esc(d.label)}</b><div class="mut sm">${esc(meta)}</div></div><div class="docbtns">${btns}</div></div>`;
}
// all documents of an IPO, grouped; each hosted PDF can be read (opens in the browser's PDF viewer) or downloaded
function docsPanel(i) {
  const groups = {};
  for (const d of i.documents || []) (groups[d.group || "Other"] ||= []).push(d);
  const html = Object.entries(groups).map(([g, list]) => card(esc(g), list.map(docRow).join(""))).join("");
  return (html || card("Documents", `<p class="mut sm">No documents published for this IPO yet.</p>`)) +
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
  for (const [k, l] of [["qib", "QIB"], ["nii", "NII"], ["bnii", "bNII"], ["snii", "sNII"], ["retail", "Retail"], ["employee", "Employees"], ["shareholders", "Shareholders"], ["total", "Total"]]) if (b[k]) add(`Subscription — ${l}`, `${inr(b[k].offered)} offered · ${inr(b[k].bid)} bid · ${f2(b[k].times)}x`);
  if (i.gmp) { add("GMP (average)", `₹${i.gmp.value}`); add("GMP sources", i.gmp.sources.map(s => `${s.source} ₹${s.gmp}`).join(" · ")); add("GMP rating", i.gmp.rating ? i.gmp.rating + " / 5" : null); }
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
  const head = `<div class="noprint row repbar">${backBtn("data-report-close")}<b>${esc(i.name)}</b><span></span></div>
  <div class="seg noprint"><button data-rtab="docs" class="${tab === "docs" ? "on" : ""}">${ic("file-text")} Documents</button><button data-rtab="data" class="${tab === "data" ? "on" : ""}">${ic("chart-bar")} Company data</button></div>`;
  if (tab === "docs") return `<div class="report">${head}${docsPanel(i)}</div>`;
  const saved = state.detail; state.detail = i.symbol; const body = detail(true); state.detail = saved;
  return `<div class="report">${head}
  <div class="noprint row" style="margin-bottom:12px"><button class="btn" data-print>${ic("printer")} Print / Save as PDF</button></div>
  <div class="rep-head"><h1>${esc(i.name)}</h1><div class="mut sm">${i.board} · ${esc(i.symbol)} · Report generated ${new Date().toLocaleString("en-IN")} · Data as of ${state.meta ? new Date(state.meta.generatedAt).toLocaleString("en-IN") : "—"}</div></div>
  ${body}
  ${card("All data fields", tbl(["Field", "Value"], rawRows(i)))}
  ${card("Disclaimer / अस्वीकरण", `<p class="sm">${TEXT.disclaimer.en}</p><hr><p class="sm">${TEXT.disclaimer.hi}</p>`)}</div>`;
}


// ---------- IPO detail building blocks (new data fields: applyAs, anchorSummary, contacts, bids.*) ----------
const rupee = n => isNum(n) ? "₹" + inr(n) : "—";
const subsAsOnTxt = i => {
  if (!i.subsAsOn) return "";
  const d = new Date(i.subsAsOn); if (isNaN(d)) return "";
  const t = d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) + " IST";
  return `As of ${esc(t)}${i.subsAsOnSource ? " (" + esc(i.subsAsOnSource) + ")" : ""}`;
};
function subscriptionCard(i, anyBid) {
  const b = i.bids || {};
  const defs = [["QIB", "qib", 0], ["NII (total)", "nii", 0], ["bNII (above ₹10L)", "bnii", 1], ["sNII (₹2L to ₹10L)", "snii", 1], ["Retail", "retail", 0], ["Employees", "employee", 0], ["Shareholders", "shareholders", 0], ["Market maker", "marketMaker", 0], ["Anchor", "anchor", 0]];
  const rows = defs.filter(([, k]) => b[k] && (isNum(b[k].offered) && b[k].offered > 0 || isNum(b[k].bid) && b[k].bid > 0));
  if (!anyBid || (!rows.length && !(b.total?.bid > 0))) return `<p class="mut">Subscription data appears once the issue opens (${fmtD(i.open)}).</p>`;
  const mx = Math.max(1, ...rows.filter(([, k]) => k !== "marketMaker" && k !== "anchor").map(([, k]) => isNum(b[k].times) ? b[k].times : 0), isNum(b.total?.times) ? b.total.times : 0);
  const one = (label, x, sub, strong) => {
    const t = x.times, w = isNum(t) ? Math.max(2, Math.min(100, t / mx * 100)) : 0;
    const meta = [isNum(x.bid) ? `Bid ${inr(x.bid)} sh` : null, isNum(x.offered) ? `Offered ${inr(x.offered)} sh` : null, isNum(x.applications) ? `${inr(x.applications)} applications` : null].filter(Boolean).join(" · ");
    return `<div class="sr${sub ? " subr" : ""}${strong ? " strong" : ""}"><div class="sr-h"><span>${label}</span><b class="num">${isNum(t) ? f2(t) + "x" : "—"}</b></div><div class="bar"><i style="width:${w}%"></i></div>${meta ? `<div class="sr-m">${meta}</div>` : ""}</div>`;
  };
  const html = rows.map(([l, k, s]) => one(l, b[k], s, false)).join("") + (b.total ? one("Total", b.total, 0, true) : "");
  const mm = b.marketMaker ? `<p class="mut sm">Market maker portion is excluded from NII and Total.</p>` : "";
  const asOn = subsAsOnTxt(i) || (i.demand?.asOn ? esc((/^as on/i.test(i.demand.asOn) ? "" : "As on ") + i.demand.asOn) + " (NSE)" : i.fetchedAt ? "Data fetched " + esc(new Date(i.fetchedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })) + " IST (NSE)" : "");
  const noSplit = rows.length ? "" : '<p class="mut sm">NSE no longer publishes the category-wise split for this finished issue. The total bids and times subscribed are NSE\'s final figures.</p>';
  return `<div class="srs">${html}</div>${mm}${noSplit}${asOn ? `<p class="mut sm asof">${asOn}</p>` : ""}`;
}
function applyAsCard(i, minInv, minLots) {
  const A = (i.applyAs || []).filter(a => a && a.category);
  if (!A.length && !isNum(minInv)) return "";
  const pb = a => isNum(a.priceLow) && isNum(a.priceHigh) ? `₹${px(a.priceLow)} – ₹${px(a.priceHigh)}` : isNum(a.priceHigh) ? `₹${px(a.priceHigh)}` : "—";
  const kv = (l, v) => `<div><span>${l}</span><b class="num">${v}</b></div>`;
  const t = A.length ? `<div class="aas">${A.map(a => `<div class="aa"><div class="aa-h"><b>${esc(a.category)}</b>${a.note ? `<span class="mut sm">${esc(a.note)}</span>` : ""}</div><div class="aa-g">${kv("Price band", pb(a))}${kv("Lot", isNum(a.lot) ? inr(a.lot) + " sh" : "—")}${kv("Min amount", rupee(a.minAmount))}${kv("Max amount", rupee(a.maxAmount))}</div></div>`).join("")}</div>` : "";
  return card(ic("coins") + " Apply as", (isNum(minInv) ? `<div class="mininv"><span>Minimum investment</span><b class="num">${rupee(minInv)}</b><em>${minLots} lot${minLots > 1 ? "s" : ""}${isNum(i.lot) ? " · " + inr(i.lot * minLots) + " shares" : ""}</em></div>` : "") + t);
}
function anchorCard(i) {
  const a = i.anchorSummary; if (!a) return "";
  const parts = [isNum(a.totalAmountCr) ? bentoT("Amount raised", "₹" + cr(a.totalAmountCr) + " Cr") : "", isNum(a.totalShares) ? bentoT("Shares allotted", inr(a.totalShares)) : "", isNum(a.price) ? bentoT("Anchor price", "₹" + cr(a.price)) : "", a.bidDate ? bentoT("Bid date", fmtD(a.bidDate)) : ""].join("");
  if (!parts) return "";
  return card(ic("building-bank") + " Anchor investors", `<div class="bento">${parts}</div><p class="mut sm">Anchor investors bid a day before the issue opens; their shares have a lock-in period.</p>`);
}
const bentoT = (l, v) => `<div class="bt"><span>${l}</span><b>${v}</b></div>`;
// strict formats: anything else is shown as plain text, never as a link
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63}){1,4}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,18}[0-9]$/;
const mailTo = e => typeof e === "string" && EMAIL_RE.test(e.trim()) ? `<a href="mailto:${esc(e.trim())}">${esc(e.trim())}</a>` : e ? esc(e) : "";
const telLinks = p => typeof p !== "string" ? "" : p.split(/[\/;,]/).map(x => x.trim()).filter(Boolean).map(x => PHONE_RE.test(x) ? `<a href="tel:${esc(x.replace(/[^0-9+]/g, ""))}">${esc(x)}</a>` : esc(x)).join(" · ");
const siteLink = u => { const s = safeUrl(u); if (!s || !/^https?:\/\//.test(s)) return ""; let h = s; try { h = new URL(s).hostname.replace(/^www\./, ""); } catch {} return `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(h)} ${ic("external-link")}</a>`; };
function contactsCard(i) {
  const c = i.contacts?.company || {}, r = i.contacts?.registrar || {};
  const line = (ico, v) => v ? `<div class="ct-l">${ic(ico)}<span>${v}</span></div>` : "";
  const blk = (title, name, x) => {
    const inner = line("building", name ? `<b>${esc(name)}</b>` : "") + line("map-pin", x.address ? esc(x.address) : "") + line("user-check", x.contactPerson ? esc(x.contactPerson) : "") + line("phone", telLinks(x.phone)) + line("mail", mailTo(x.email)) + line("world", siteLink(x.website));
    return inner ? `<div class="ct"><h3>${title}</h3>${inner}</div>` : "";
  };
  const html = blk("Company", "", c) + blk("Registrar", r.name || i.registrar?.name, r);
  if (!html) return card("Registrar", `<b>${esc(i.registrar?.name || "—")}</b><div class="sm" style="margin-top:6px">${esc(i.registrar?.address || "")}<br>${esc(i.registrar?.contact || "")}</div>`);
  return card(ic("phone") + " Contacts", `<div class="ctgrid">${html}</div>${i.contacts?.source ? `<p class="mut sm">Source: ${esc(i.contacts.source)}</p>` : ""}`);
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
  const minInv = isNum(i.minInvestment) ? i.minInvestment : (isNum(i.lot) && i.lot > 0 && isNum(pr) && pr > 0 ? i.lot * pr : null);
  const minLots = isNum(i.minInvestmentLots) ? i.minInvestmentLots : 1;
  const bt = (l, v, s = "", cls = "") => `<div class="bt ${cls}"><span>${l}</span><b>${v}</b>${s ? `<em>${s}</em>` : ""}</div>`;
  const tlItems = [["Opens", i.timeline?.open, false], ["Closes", i.timeline?.close, false], ["Allotment finalised", i.timeline?.allotment, i.datesExpected], ["Refund initiated", i.timeline?.refund, i.datesExpected], ["Shares credited to demat", i.timeline?.demat, i.datesExpected], ["Listing", i.timeline?.listing, i.datesExpected]];
  const tl = `<ol class="tl">${tlItems.map(([l, d, est]) => { const n = d ? dayDiff(d) : null; return `<li class="${n === null ? "" : n < 0 ? "done" : n === 0 ? "now" : ""}"><i></i><div><b>${l}</b><span>${d ? fmtD(d) + (est ? " (exp.)" : "") : "—"}</span></div></li>`; }).join("")}</ol>`;
  return `<div class="top">${backBtn()}<h1>${esc(i.name)}</h1><button class="ib pillb" data-share aria-label="${onWebsite() ? "Copy link" : "Share"}">${ic(onWebsite() ? "copy" : "share-3")}<span>${onWebsite() ? "Copy link" : "Share"}</span></button></div>
  <div class="dgrid"><section class="card hero"><div class="hero-top">${logo(i)}<div class="hero-id"><h3>${esc(i.name)}</h3><div class="ipoc-meta"><span class="pill">${esc(i.board)}</span>${stLabel(i)}</div><div class="mut sm">${fmtS(i.open)} to ${fmtD(i.close)}</div></div></div>
  ${cdFor(i)}
  <div class="bento">${bt("Price band", price(i))}${bt("Lot / Min invest", isNum(i.lot) ? `${i.lot} sh${minInv ? " · ₹" + inr(minInv) : ""}` : "—")}${bt("Issue size", isNum(i.issueSizeCr) ? "₹" + cr(i.issueSizeCr) + " Cr" : "—")}${bt("Listing" + (i.datesExpected ? " (exp.)" : ""), fmtD(i.listing))}</div>
  <div class="cta">${actionBtn(i, true)}</div>
  <div class="cta2"><button class="btn ghost" data-watch="${i.symbol}">${ic("star", inW ? "fill" : "")} ${inW ? "Watching" : "Watchlist"}</button><button class="btn ghost" data-cmp="${i.symbol}">${ic(state.cmp.includes(i.symbol) ? "check" : "scale")} ${state.cmp.includes(i.symbol) ? "In compare" : "Compare"}</button></div></section>

  <div class="card"><div class="tiles keyt"><button class="tile k" data-jump="fin"><div class="v">${ic("report-money")}</div>Financials</button>
  <button class="tile k" data-jump="gmp"><div class="v num ${isNum(g) ? (g >= 0 ? "grn-t" : "red-t") : ""}">${isNum(g) ? "₹" + g : "NA"}</div>${isNum(g) && isNum(gmpPct(i)) ? `<small class="${g >= 0 ? "grn-t" : "red-t"}">${gmpPct(i).toFixed(2)}%</small>` : ""}GMP (rumour)</button>
  <button class="tile k" data-jump="subs"><div class="v num">${subNow(i)}</div>Subscription</button></div>
  ${isNum(g) && L ? `<div class="gl"><div class="row"><span>GMP x Lots (RETAIL)*</span><b>₹ ${inr(g * i.lot)}</b></div><div class="row"><span>GMP x Lots (sHNI)*</span><b>₹ ${inr(g * i.lot * L.s)}</b></div><div class="row"><span>GMP x Lots (bHNI)*</span><b>₹ ${inr(g * i.lot * L.b)}</b></div></div>` : ""}</div>

  <div class="card" id="subs"><h2>${ic("chart-bar")} Subscription</h2>${subscriptionCard(i, anyBid)}</div>

  <div class="card" id="ai"><h2>${ic("trophy")} Trendy IPO Score</h2><div class="scorebox"><div class="scorering">${ring(sc.score, true)}<span class="badge ${v.c}">${v.t}</span></div>
  <div class="factors">${Object.keys(WEIGHTS).map(n => `<div class="factor"><div class="row"><span>${FACTOR_LABEL[n]} <small class="mut">${WEIGHTS[n] * 100}%</small></span><b class="num">${fv[n] ?? "N/A"}</b></div><div class="bar"><i style="width:${fv[n] ?? 0}%;background:${col(fv[n] ?? null)}"></i></div></div>`).join("")}</div></div>
  <div class="note"><b>${ic("sparkles")} Analysis (${sc.coverage}% of score weight had data)</b><ul class="reasons">${reasons(i).map(([k, r]) => `<li class="${k}">${ic(k === "good" ? "circle-check" : k === "mid" ? "minus" : k === "low" ? "alert-triangle" : "info-circle")}<span>${esc(r)}</span></li>`).join("")}</ul></div>
  <p class="mut sm">Every factor is calculated from NSE data, the RHP and GMP; factors without data are left out and the rest are re-weighted. Indicative only.</p></div>

  <div class="card" id="gmp"><h2>${ic("trending-up")} GMP Trend</h2>${gh.length > 1 ? gmpChart(i.gmp.history) : `<p class="mut sm">Trend chart fills in as the pipeline records GMP each day (${gh.length} snapshot so far).</p>`}
  ${i.gmp ? `<div class="row sm gmpmeta"><span class="mut">Average of ${i.gmp.sources.length} source${i.gmp.sources.length > 1 ? "s" : ""}${i.gmp.rating ? " · rating " + i.gmp.rating + "/5" : ""}</span><b>${isNum(pr) ? "Est. listing ₹" + f2(pr + g) : ""}</b></div>
  <div class="sm gmpsrc">${i.gmp.sources.map(s => `${esc(s.source)}: <b>₹${s.gmp}</b>`).join(" · ")}${i.gmp.sources.length > 1 && i.gmp.min !== i.gmp.max ? ` <span class="mut">(range ₹${i.gmp.min}–₹${i.gmp.max})</span>` : ""}</div>
  <div class="mut sm">Updated ${esc(i.gmp.updated || "—")}</div>` : `<p class="mut sm">No GMP published for this IPO yet.</p>`}
  <div class="note gr">Exp. Premium is derived from market rumors and internet sources. It does not reflect the actual IPO listing price or value. Review the RHP and consult a financial advisor.</div></div>

  ${applyAsCard(i, minInv, minLots)}
  ${anchorCard(i)}

  ${i.listingPerf ? card(ic("trending-up") + " Listing performance", tbl(["", ""], [["Issue price", `₹${pr}`], ["Day-1 open (" + esc(i.listingPerf.exchange) + ")", `₹${f2(i.listingPerf.dayOpen)} ${fmtGain(i.listingPerf.dayOpenGainPct)}`], ["Last price (" + fmtS(i.listingPerf.asOf) + ")", `₹${f2(i.listingPerf.ltp)} ${fmtGain(i.listingPerf.ltpGainPct)}`], ["Our score was", sc.score ?? "N/A"]].concat((m => m ? [["Our GMP at listing", m.gmpP === null ? "—" : `₹${m.gmp} ${fmtGain(m.gmpP)}`], ["GMP vs actual day-1 open", m.gmpHit ? `${fmtPts(m.err)} ${GMP_HIT[m.gmpHit]}` : "—"], ["Score vs outcome", SCORE_HIT(m.scoreHit)]] : [])(listingMatch(i)))).replace(/<tr><th><\/th><th><\/th><\/tr>/, "") + `<p class="mut sm">Source: Yahoo Finance (may differ slightly from the exchange's discovered listing price).</p>`) : ""}

  ${card(ic("calendar-event") + " IPO Timeline", tl + `<p class="mut sm">${i.datesExpected ? "Estimated from the close date (T+1 allotment, T+2 refund/demat, T+3 listing); holidays can move these." : "Dates announced by the issuer/exchange."}</p>`)}

  ${(i.checks || []).length ? card("", (i.checks.some(c => !c.ok) ? `<div class="note warnb">${ic("alert-triangle")}<span><b>Sources disagree:</b> ${i.checks.filter(c => !c.ok).map(c => `${esc(c.field)}: NSE ${esc(c.nse)} vs InvestorGain ${esc(c.other)}`).join("; ")}</span></div>` : `<span class="mut sm okline">${ic("check")} NSE and InvestorGain agree on ${i.checks.length} checks (issue size, lot, cap price, dates).</span>`)) : ""}

  ${N !== null && anyBid ? card("", `<div class="alot">${ic("users")} ≈ 1 in ${N} retail allotment</div><span class="chip ${risk[1]}">${risk[0]}</span><p class="sm">Based on retail subscription of ${f2(b.retail.times)}x (by shares). Approximately 1 in ${N} retail applications may receive an allotment if demand holds.</p><div class="note">${ic("info-circle")} The final allotment is decided by the registrar's computerised lottery.</div>`) : ""}

  ${dwRows.length ? card("Day Wise Subscription (snapshots)", tbl(["Date", "QIB", "NII", "Retail", "Total"], dwRows)) : ""}
  ${i.demand?.byPrice ? card("Cumulative Demand by Price (NSE)", tbl(["Price (₹)", "Cumulative qty"], Object.entries(i.demand.byPrice).map(([k, x]) => [esc(k), esc(x)]))) : ""}
  ${L ? card("Lot(s) Distribution", tbl(["Category", "Lot(s)", "Qty", "Amount"], [["RETAIL", 1, inr(i.lot), inr(i.lot * pr)], ["sHNI (from ₹2L)", L.s, inr(L.s * i.lot), inr(L.s * i.lot * pr)], ["bHNI (from ₹10L)", L.b, inr(L.b * i.lot), inr(L.b * i.lot * pr)]])) : ""}

  ${f ? `
  ${card("Key Performance Indicator", tbl(["KPI", ...rv(per)], [fr("ROCE (%)", K.roce), fr("RoNW (%)", K.ronw), fr("ROE (%)", K.roe), fr("EPS basic (₹)", K.eps_basic), fr("EPS diluted (₹)", K.eps_diluted), fr("PAT margin (%)", K.pat_margin), fr("EBITDA margin (%)", K.ebitda_margin), fr("Debt/Equity", K.debt_equity), ...(K.other || []).map(o => [`${esc(o.name)} (${esc(o.unit)})`, ...rv(o.values)])].map(r => r.map((c, k) => k ? (c === "—" ? c : c) : c))) + `<p class="mut sm">NAV/share: ${isNum(K.nav_per_share) ? "₹" + K.nav_per_share : "—"} · P/E post-IPO: ${isNum(p) ? p.toFixed(2) : "—"} · Pre-IPO P/E: ${isNum(K.pe_pre_ipo) ? K.pe_pre_ipo : "—"}</p>`, "fin")}
  ${card(ic("report-money") + " Company Financials", tbl(["Period Ended", ...rv(per)], [fr("Total assets", F.total_assets), fr("Revenue", F.revenue), fr("EBITDA", F.ebitda), fr("Profit before tax", F.pbt), fr("Profit after tax", F.pat), fr("Net worth", F.net_worth), fr("Reserves", F.reserves), fr("Total borrowing", F.borrowings), fr("Cash & bank", F.cash_and_bank), fr("Operating cash flow", F.operating_cash_flow)]) + `<div class="mut sm" style="text-align:right;margin-top:6px">₹ crore · ${esc(f.basis || "")} · restated, per RHP</div>`)}
  ${(f.peers || []).length ? card("Peer Comparison", tbl(["Company", "P/E", "CMP (₹)", "EPS (₹)", "NAV (₹)", "RoNW %"], [[`<b>${esc(i.name)}</b>`, isNum(p) ? p.toFixed(2) : "—", pr, last(K.eps_diluted) ?? "—", K.nav_per_share ?? "—", last(K.ronw) ?? "—"], ...f.peers.map(x => [esc(x.name), x.pe ?? "—", x.cmp ?? "—", x.eps_diluted ?? x.eps_basic ?? "—", x.nav ?? "—", x.ronw ?? "—"])]) + (pa && p ? `<p class="mut sm">Peer avg P/E ${pa.toFixed(1)} → IPO at ${p < pa ? "a discount" : "a premium"} of ${Math.abs((p / pa - 1) * 100).toFixed(0)}%.</p>` : "")) : ""}
  ${card("Issue Details", tbl(["", ""], [["Issue size", isNum(i.issueSizeCr) ? `₹${cr(i.issueSizeCr)} Cr (${inr(i.issueShares)} shares)` : "—"], ["Fresh issue", isNum(iss.fresh_issue_cr) ? `₹${cr(iss.fresh_issue_cr)} Cr` : "—"], ["Offer for sale", isNum(iss.ofs_cr) ? `₹${cr(iss.ofs_cr)} Cr` : iss.ofs_shares === 0 ? "-" : "—"], ["Face value", isNum(i.faceValue) ? `₹${i.faceValue}` : "—"], ["Issue type", esc(i.issueType || "—")], ["Shares pre-issue", inr(iss.pre_issue_shares)], ["Shares post-issue", inr(iss.post_issue_shares)], ["Reservation", iss.reservation_pct ? Object.entries(iss.reservation_pct).filter(([, x]) => isNum(x)).map(([k, x]) => `${esc(k)} ${x}%`).join(" · ") : "—"]]).replace(/<tr><th><\/th><th><\/th><\/tr>/, ""))}
  ${(iss.objects || []).length ? card("Objects of the Issue", tbl(["Purpose", "₹ Cr"], iss.objects.map(o => [esc(o.purpose), o.amount_cr ?? "—"]))) : ""}
  ${card("About Company", `<p class="sub">${esc(f.about)}</p><div class="mut sm">${[f.headquarters && "HQ: " + esc(f.headquarters), f.founded_year && "Founded: " + f.founded_year, isNum(f.order_book_cr) && "Order book: ₹" + cr(f.order_book_cr) + " Cr"].filter(Boolean).join(" · ")}</div>`)}
  ${f.promoters?.names?.length ? card("Promoters", `<p class="sm">${f.promoters.names.map(esc).join(", ")}</p><div class="mut sm">Holding pre-issue ${f.promoters.holding_pre_pct ?? "—"}% → post-issue ${f.promoters.holding_post_pct ?? "—"}%</div>${f.promoters.background ? `<p class="sm">${esc(f.promoters.background)}</p>` : ""}`) : ""}
  ${(f.strengths || []).length ? card("Strength Factor", `<ul class="lst">${f.strengths.map(x => `<li class="str">${ic("check")} <span>${esc(x)}</span></li>`).join("")}</ul>`) : ""}
  ${(f.risks || []).length ? card("Risk Factor", `<ul class="lst">${f.risks.map(x => `<li><i class="sev ${x.severity === "high" ? "h" : x.severity === "medium" ? "m" : "l"}"></i> <b>${esc(x.title)}</b><br><span class="mut">${esc(x.detail)}</span></li>`).join("")}</ul>`) : ""}
  ${f.notes ? `<p class="mut sm">${ic("info-circle")} A few figures could not be read clearly from the offer document and are left blank (—).</p>` : ""}` : card("Company fundamentals", `<p class="mut">${i.verification?.status === "fail" ? "The figures extracted from the offer document failed our automatic verification and are hidden until they are re-checked." : esc(i.sourceNote || "") || "Company figures have not been extracted from the offer document yet (the pipeline does this once the document is available and extraction has run)."}</p>`)}

  ${forReport ? "" : reportCard(i)}
  ${contactsCard(i)}
  ${i.leadManagers ? card("Lead Manager(s)", `<span class="sm">${esc(i.leadManagers)}</span><div class="mut sm" style="margin-top:6px">Sponsor bank: ${esc(i.sponsorBank || "—")}</div>`) : ""}
  </div><p class="disc">Source: NSE India + RHP. Dates marked (exp.) are estimated from the closing date (T+1 allotment, T+3 listing) and may shift for holidays. Score is indicative, not investment advice.</p>`;
}

function compare() {
  state.cmp = state.cmp.filter(byId);                                  // forget IPOs that are no longer in the data
  const sel = state.cmp.map(byId).filter(Boolean);
  const picker = state.cmp.length < 3 ? `<select id="pick"><option value="">+ Add IPO to compare (max 3)</option>${state.ipos.filter(i => !state.cmp.includes(i.symbol) && i.status !== "listed").map(i => `<option value="${i.symbol}">${esc(i.name)}</option>`).join("")}</select>` : "";
  if (sel.length < 2) return `${head("Compare")}<div class="note topnote">${ic("scale")}<span>Pick 2–3 IPOs to compare side by side. Green = best value, red = weakest.</span></div>${sel.map(listCard).join("")}${picker}`;
  const pat = i => last(FU(i)?.financials?.pat);
  // [group, label, number-or-null, formatter, which direction is better]
  const M = [
    ["Score", "Trendy IPO score", i => score(i), v => v + "/100", "high"],
    ["Market", "GMP today", i => gmpNow(i), (v, i) => "₹" + v + (isNum(gmpPct(i)) ? " (" + gmpPct(i).toFixed(0) + "%)" : ""), "high"],
    ["Market", "Subscription", i => totalTimes(i), v => f2(v) + "x", "high"],
    ["Market", "Retail allotment", i => retailN(i), v => "1 in " + v, "low"],
    ["Financials", "Revenue growth (CAGR)", i => cagr(FU(i)?.financials?.revenue), v => v.toFixed(0) + "%", "high"],
    ["Financials", "Profit (₹ Cr)", pat, v => cr(v), "high"],
    ["Financials", "Return on net worth", i => last(FU(i)?.kpi?.ronw), v => v + "%", "high"],
    ["Financials", "P/E (lower = cheaper)", i => pe(i), v => v.toFixed(1), "low"],
    ["Entry", "Issue size", i => i.issueSizeCr, v => "₹" + cr(v) + " Cr", null],
    ["Entry", "Minimum investment", i => isNum(i.lot) && i.priceHigh > 0 ? i.lot * i.priceHigh : null, v => "₹" + inr(v), "low"],
  ];
  const cols = "grid-template-columns:96px repeat(" + sel.length + ",minmax(0,1fr))";
  const head1 = `<div class="cmprow" style="${cols}"><div></div>${sel.map(i => { const sc = scoreOf(i), v = verdict(sc.score); return `<div class="cmphead" style="border-top-color:hsl(${hue(i.symbol)} 60% 45%)"><button class="cmpx" data-cmp="${i.symbol}" title="Remove" aria-label="Remove">${ic("x")}</button>${logo(i)}<div class="cmpname">${esc(i.name.replace(/ Limited$/, ""))}</div><span class="pill sm">${i.board}</span>${ring(sc.score)}<span class="badge ${v.c}" style="font-size:10px">${v.t}</span></div>`; }).join("")}</div>`;
  let lastGroup = "", body = "";
  for (const [grp, label, get, fmt, dir] of M) {
    const vals = sel.map(i => { const v = get(i); return isNum(v) ? v : null; }), nums = vals.filter(v => v !== null);
    const hi = nums.length ? Math.max(...nums) : null, lo = nums.length ? Math.min(...nums) : null, differ = nums.length >= 2 && hi !== lo;
    if (grp !== lastGroup) { body += `<div class="cmpgroup">${grp}</div>`; lastGroup = grp; }
    body += `<div class="cmprow" style="${cols}"><div class="cmplabel">${label}</div>${sel.map((i, k) => {
      const v = vals[k]; if (v === null) return `<div class="cmpcell mut">—</div>`;
      const best = differ && dir && v === (dir === "high" ? hi : lo), worst = differ && dir && v === (dir === "high" ? lo : hi);
      const w = dir === "high" && hi > 0 ? Math.max(6, Math.round(v / hi * 100)) : 0;
      return `<div class="cmpcell ${best ? "best" : worst ? "worst" : ""}">${fmt(v, i)}${best ? ic("check", "bestic") : ""}${w ? `<i class="cmpbar" style="width:${w}%"></i>` : ""}</div>`;
    }).join("")}</div>`;
  }
  // who wins what
  const win = (label, get, dir) => { const c = sel.map(i => [i, get(i)]).filter(x => isNum(x[1])); if (c.length < 2) return ""; const v = dir === "high" ? Math.max(...c.map(x => x[1])) : Math.min(...c.map(x => x[1])); const w = c.find(x => x[1] === v)[0]; return `<span class="winchip" style="--wh:${hue(w.symbol)}">${label}: <b>${esc(w.name.split(" ").slice(0, 2).join(" "))}</b></span>`; };
  const wins = [win("Highest score", i => score(i), "high"), win("Highest GMP", i => gmpNow(i), "high"), win("Most subscribed", i => totalTimes(i), "high"), win("Cheapest P/E", i => pe(i), "low"), win("Lowest entry", i => isNum(i.lot) && i.priceHigh > 0 ? i.lot * i.priceHigh : null, "low")].filter(Boolean);
  return `${head("Compare")}<div class="cmp tw">${head1}${body}</div>
  ${wins.length ? `<div class="chips">${wins.join("")}</div>` : ""}${picker}
  <p class="mut sm">Green tick = best of the selected IPOs on that row, red = weakest. A highlight is only a comparison of these IPOs, not advice.</p>`;
}
function allotment() {
  const list = state.ipos.filter(i => i.status === "listed" || (i.status === "live" && i.close && dayDiff(i.close) <= 0));
  const sel = byId(state.allotIpo) || list[0];
  return `${head("Allotment Status")}<div class="card"><p class="mut">Select the IPO, then check on the registrar's official page using your PAN or application number.</p>
  <select id="allotSel">${list.map(i => `<option value="${i.symbol}" ${sel && sel.symbol === i.symbol ? "selected" : ""}>${esc(i.name)} (${fmtS(i.allotment)})</option>`).join("")}</select>
  ${sel ? `<div class="note"><b>Registrar:</b> ${esc(sel.registrar.name || "—")}<br>Allotment date: ${fmtD(sel.allotment)} ${sel.datesExpected ? "(expected)" : ""}<br>${esc(sel.registrar.contact || "")}</div>
  ${(r => r ? `<a class="btn wide" href="${r.url}" target="_blank" rel="noopener noreferrer">${r.kind === "status" ? "Check allotment status" : "Open the registrar's website"} ${ic("external-link")}</a>${r.kind === "status" ? "" : '<p class="mut sm">Look for "IPO status" or "allotment" on their site.</p>'}` : `<p class="mut sm">The registrar's status page is not known for this IPO. If it is listed on BSE you can check here:</p><a class="btn ghost wide" href="${BSE_STATUS}" target="_blank" rel="noopener noreferrer">BSE: application status ${ic("external-link")}</a>`)(registrarLink(sel))}` : '<p class="mut">No IPOs awaiting allotment.</p>'}</div>
  <div class="note">Allotment is decided by the registrar's computerised lottery. Use the registrar's official website or the NSE/BSE allotment pages.</div>`;
}
function unlisted() { return `${head("Unlisted Shares")}<div class="card"><p class="mut">No reliable automatic source for unlisted (pre-IPO) prices is connected yet, so nothing is shown rather than showing guesses.</p></div>`; }
function settings() {
  const A = state.alerts, w = state.watch.map(byId).filter(Boolean);
  return `${head("Settings")}<div class="card"><h2>${ic("bell")} Alerts</h2>${[["open", "IPO opening"], ["close", "Closing day reminder"], ["allot", "Allotment result"]].map(([k, l]) => `<div class="row" style="padding:8px 0"><span>${l}</span><input type="checkbox" data-alert="${k}" ${A[k] ? "checked" : ""}></div>`).join("")}<p class="mut sm">Saved locally. Push notifications need a backend.</p></div>
  <div class="card"><h2>${ic("star")} Watchlist</h2>${w.map(i => `<div class="row" style="padding:8px 0"><div><b>${esc(i.name)}</b><div class="mut">${stLabel(i).replace(/<[^>]+>/g, "")}</div></div><button class="btn ghost" style="flex:none" data-open="${i.symbol}">View</button></div>`).join("") || '<p class="mut">Star an IPO from its detail page.</p>'}</div>
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
  disclaimerTitle: { en: "Disclaimer", hi: "अस्वीकरण" },
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
const langBtn = () => lang() === "en" ? `<button class="linkbtn" data-lang="hi">${ic("language")} Translate to Hindi / हिंदी में पढ़ें</button>` : `<button class="linkbtn" data-lang="en">${ic("language")} Show in English / अंग्रेज़ी में पढ़ें</button>`;
const disclaimer = () => `<b>${TEXT.disclaimerTitle[lang()]}</b><br>${TEXT.disclaimer[lang()]}<br>${langBtn()}`;
const about = () => `<p class="sm" style="margin:0">${TEXT.about[lang()]}</p>${langBtn()}`;
const credit = () => `<div class="credit">Developed by <b>Zynora Technology</b> (Noor)<span>© 2026 Zynora Technology. All rights reserved.</span></div>`;
// If the data file stops being refreshed, say so on every screen instead of quietly showing old numbers.
const STALE_HOURS = 8;
const staleBar = () => {
  const h = state.meta?.generatedAt ? (Date.now() - new Date(state.meta.generatedAt).getTime()) / 3600e3 : 0;
  if (!(h > STALE_HOURS)) return "";
  const age = h >= 48 ? Math.floor(h / 24) + " days" : Math.floor(h) + " hours", ageHi = h >= 48 ? Math.floor(h / 24) + " दिन" : Math.floor(h) + " घंटे";
  return `<div class="stale" data-refresh style="cursor:pointer">${ic("alert-triangle")} Data is ${age} old: live updates may have stopped. Tap to refresh. <span>डेटा ${ageHi} पुराना है।</span></div>`;
};
const acked = () => state.ack;   // shown on every app open, gone after the user taps "I understand" (not remembered)

// ---------- left side bar (About, Compare, Settings) + About page ----------
// Laptop: always visible on the left. Phone: opens from the "☰ About" button at the top and closes again after a choice.
const SIDE = [["about", "info-circle", "About"], ["general", "tools", "General"], ["share", "link", "Share"], ["help", "lifebuoy", "Help & Support"], ["compare", "scale", "Compare"], ["settings", "settings", "Settings"]];
const sideMenu = () => `<div class="dim" data-drawer-close></div><aside class="drawer" aria-label="Menu">
  <div class="dhead"><img src="icons/logo.svg" alt="" width="40" height="40"><div><b>Trendy <span>IPO</span></b><div class="mut sm">Menu</div></div><button class="ib dclose" data-drawer-close aria-label="Close">${ic("x")}</button></div>
  <div class="dnav">${SIDE.map(([k, icn, l]) => `<button data-tab="${k}" class="${state.tab === k && !state.detail && !state.report ? "on" : ""}">${ic(icn)}<span>${l}</span></button>`).join("")}</div>
  <div class="dfoot sm mut">Developed by <b>Zynora Technology</b> (Noor)<br>© 2026 Zynora Technology</div></aside>`;
// ---------- About page: menu of General / Share / Help & Support, each row opens its own page ----------
state.sub = null;
state.applied = store.get("applied", []);
state.pan = store.get("pan", "");
state.theme = store.get("theme", null);                                   // "dark" | "light" | null = follow the phone
const isDark = () => state.theme ? state.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
const applyTheme = () => { if (state.theme) document.documentElement.dataset.theme = state.theme; else delete document.documentElement.dataset.theme; };
applyTheme();
const onWebsite = () => matchMedia("(min-width: 960px)").matches;
matchMedia("(min-width: 960px)").addEventListener?.("change", () => { if (state.loaded) render(); });
const APP_URL = () => location.origin + location.pathname.replace(/index\.html$/, "");

const mrow = (icn, label, sub, extra = "") => `<button class="mrow" data-sub="${sub}"><span class="mic">${ic(icn)}</span><span class="mlb">${label}${extra}</span><span class="mgo">${ic("chevron-right")}</span></button>`;
const msec = (title, rows) => `<div class="msec"><h3>${title}</h3>${rows}</div>`;
const subPage = (title, inner) => `${head(title)}<div class="subpg">${inner}</div>`;

// notifications built from the live data (no server): opening soon, closing, allotment, listing
const nRead = () => store.get("nread", []);
const unreadCount = () => { const r = nRead(); return notifList().filter(x => !r.includes(x[4])).length; };
function notifList() {
  const out = [], when = n => n === 0 ? "today" : n === 1 ? "tomorrow" : n > 0 ? `in ${n} days` : n === -1 ? "yesterday" : `${-n} days ago`;
  for (const i of state.ipos) {
    const nm = esc(shortName(i.name)), o = dayDiff(i.open), c = dayDiff(i.close), a = dayDiff(i.allotment), l = dayDiff(i.listing);
    if (o !== null && o >= 0 && o <= 3) out.push([o, "player-play", `<b>${nm}</b> opens ${when(o)}`, i.symbol, i.symbol + "|open|" + i.open]);
    if (c !== null && c >= 0 && c <= 1 && (o === null || o <= 0)) out.push([c, "clock", `<b>${nm}</b> closes ${when(c)}`, i.symbol, i.symbol + "|close|" + i.close]);
    if (a !== null && a >= -1 && a <= 1) out.push([a, "clipboard-list", `<b>${nm}</b> allotment ${a === 0 ? "is today" : a < 0 ? "was " + when(a) : "is " + when(a)}`, i.symbol, i.symbol + "|allot|" + i.allotment]);
    if (l !== null && l >= -1 && l <= 1) out.push([l, "bell-ringing", `<b>${nm}</b> ${l < 0 ? "listed " + when(l) : "lists " + when(l)}`, i.symbol, i.symbol + "|list|" + i.listing]);
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
    const btn = (d, icn, txt, hint) => d ? `<a class="asbtn" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" data-track="link/asba"><span class="asic">${ic(icn)}</span><span><b>${txt}</b><small>${hint}</small></span><span class="mgo">${ic("file-download")}</span></a>` : "";
    const tile = (icn, t, d) => `<div class="astile"><span>${ic(icn)}</span><b>${t}</b><small>${d}</small></div>`;
    const hero = `<div class="ashero"><div class="ashi">${ic("file-text")}</div><div><h2>ASBA</h2><p>Application Supported by Blocked Amount. Your money stays in <b>your own bank account</b> and is only blocked while the IPO application is open. If you do not get shares, it is released automatically.</p></div></div>`;
    const ways = card("Three ways to apply", `<div class="astiles">${tile("device-mobile", "UPI", "Broker app → IPO → enter UPI ID → approve the request. Fastest.")}${tile("building-bank", "Net banking", "Your bank's IPO / ASBA section. Money is blocked in your account.")}${tile("receipt-2", "Physical form", "Fill the ASBA form and give it to your bank branch or a bidding centre.")}</div>`);
    const steps = card("How to apply (UPI)", `<ol class="assteps"><li>Keep the full amount in your bank account (lot price × lots).</li><li>Open your broker or UPI app and go to <b>IPO</b>.</li><li>Choose the issue, the category (Retail / SME) and the number of lots.</li><li>Enter your UPI ID and submit.</li><li>Open your UPI app and <b>approve the mandate</b> before the closing time. Without this the application is not placed.</li></ol>`);
    const per = card("Application forms by IPO", `<p class="mut sm" style="margin-top:0">Official files published on the exchange for each current and upcoming IPO. They are ZIP files: open them after download.</p>` + (list.map(i => `<div class="asipo"><div class="ashead">${logo(i)}<div style="min-width:0"><b>${esc(shortName(i.name))}</b><div class="mut sm">${stLabel(i).replace(/<[^>]+>/g, "")}${i.close ? " · closes " + fmtD(i.close) : ""}</div></div></div><div class="asbtns">${btn(pick(i, /application form/i), "file-text", "Application form", "ASBA form · ZIP")}${btn(pick(i, /bidding centres/i), "map-pin", "Bidding centres", "list of centres · ZIP")}</div></div>`).join("") || `<p class="mut sm" style="margin:0">No forms are published yet for current IPOs. They appear here automatically as soon as the exchange publishes them.</p>`));
    const tips = card("Good to know", `<ul class="alist"><li>Only one application per PAN per IPO.</li><li>Do not apply on the last day in the last hour — UPI approvals can fail.</li><li>The blocked amount is released after allotment, for shares you did not get.</li></ul>`);
    return subPage("Download ASBA Form", hero + ways + steps + per + tips);
  }
  if (k === "pan") {
    const p = state.pan;
    return subPage("Add PAN Number", card("Your PAN", `<p class="sm" style="margin-top:0">Save your PAN here so it is kept ready for allotment checks. <b>It stays only on this phone/browser</b> and is never sent to us or anyone else.</p>
      ${p ? `<div class="row" style="padding:8px 0"><div><div class="mut sm">Saved PAN</div><b style="letter-spacing:1.5px">${esc(p.slice(0, 5) + "••••" + p.slice(9))}</b></div><div style="display:flex;gap:6px"><button class="btn ghost" style="width:auto;padding:6px 12px" data-pandel>Remove</button></div></div>` : ""}
      <label class="mut sm" for="pan-in" style="display:block;margin:10px 0 4px">${p ? "Change PAN" : "Enter PAN"}</label><input id="pan-in" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE1234F" style="text-transform:uppercase;letter-spacing:2px"><button class="btn" data-pansave style="width:100%;margin-top:10px">Save PAN</button>`));
  }
  if (k === "notif") {
    const n = notifList(), rd = nRead(), left = n.filter(x => !rd.includes(x[4])).length;
    return subPage("Notifications", card(`Latest updates${left ? ` <span class="nbadge">${left} new</span>` : ""}`, (n.length ? `<button class="btn ${left ? "" : "ghost"} nall" data-nreadall ${left ? "" : "disabled"}>${ic("check")} ${left ? "Mark all as read" : "All read"}</button>` : "") + n.map(([, icn, t, s, key]) => `<button class="nrow${rd.includes(key) ? " read" : ""}" data-open="${esc(s)}" data-nkey="${esc(key)}"><span class="nic">${ic(icn)}</span><span>${t}</span>${rd.includes(key) ? "" : `<i class="ndot"></i>`}<span class="mgo">${ic("chevron-right")}</span></button>`).join("") || `<p class="mut sm" style="margin:0">Nothing new right now. You will see IPOs opening, closing, allotment and listing here.</p>`) +
      `<p class="mut sm">This list is made from the live data each time you open the app.</p>`);
  }
  if (k === "nsettings") {
    return subPage("Notification Settings", card(ic("bell") + " Alerts", [["open", "IPO opening"], ["close", "Closing day reminder"], ["allot", "Allotment result"]].map(([x, l]) => `<div class="row" style="padding:8px 0"><span>${l}</span><input type="checkbox" data-alert="${x}" ${A[x] ? "checked" : ""}></div>`).join("") + `<p class="mut sm">Saved on this device. The Notifications page shows these events from the live data.</p>`));
  }
  if (k === "rate") {
    const r = state.rate = store.get("rate", 0);
    return subPage("Rate App", card("How do you like Trendy IPO?", `<div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button class="starb${n <= r ? " on" : ""}" data-rate="${n}" aria-label="${n} star">${ic("star")}</button>`).join("")}</div><p class="mut sm" style="text-align:center;margin:8px 0 0">${r ? `Thank you! You rated ${r} / 5.` : "Tap a star."}</p>`) +
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
    const unread = unreadCount();
    return `${head("General")}<div class="aboutmenu">${msec("General", mrow("circle-check", "Applied IPO", "applied", state.applied.length ? `<small>${state.applied.length}</small>` : "") + mrow("file-download", "Download ASBA Form", "asba") + mrow("id", "Add PAN Number", "pan", state.pan ? `<small>saved</small>` : "") + mrow("bell", "Notifications", "notif", unread ? `<small>${unread}</small>` : "") + mrow("settings", "Notification Settings", "nsettings") +
      `<a class="mrow" href="https://news.google.com/search?q=IPO%20India&hl=en-IN&gl=IN&ceid=IN:en" target="_blank" rel="noopener noreferrer" data-track="link/news"><span class="mic">${ic("news")}</span><span class="mlb">News</span><span class="mgo">${ic("external-link")}</span></a>` +
      `<label class="mrow"><span class="mic">${ic("sun-moon")}</span><span class="mlb">Enable Dark Mode</span><input type="checkbox" class="switch" data-theme-toggle ${isDark() ? "checked" : ""} aria-label="Dark mode"></label>`)}</div>`;
  }
  if (tab === "share") return `${head("Share")}<div class="aboutmenu">${msec("Share", `<button class="mrow" data-appshare><span class="mic">${ic("link")}</span><span class="mlb">${onWebsite() ? "Copy App Link" : "Share App"}</span><span class="mgo">${ic("chevron-right")}</span></button>` + mrow("star", "Rate App", "rate"))}</div>`;
  return `${head("Help & Support")}<div class="aboutmenu">${msec("Help & Support", mrow("message", "Support", "support") + mrow("clipboard-list", "Terms & Condition", "terms") + mrow("lock", "Privacy Policy", "privacy") + mrow("help-circle", "FAQs", "faq"))}</div>`;
}
// copies text; falls back to a hidden textarea where the Clipboard API is blocked (older browsers, http pages)
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try { const a = document.createElement("textarea"); a.value = t; a.setAttribute("readonly", ""); a.style.cssText = "position:fixed;opacity:0;top:0"; document.body.appendChild(a); a.select(); const ok = document.execCommand("copy"); a.remove(); return ok; } catch { return false; }
}
async function shareIpo() {
  const i = byId(state.detail); if (!i) return;
  const txt = `${i.name} — Trendy IPO score ${score(i) ?? "N/A"}/100 (${verdict(score(i)).t})`, url = APP_URL();
  if (!onWebsite() && navigator.share) { try { await navigator.share({ title: "Trendy IPO", text: txt, url }); } catch {} return; }
  toast(await copyText(txt + "\n" + url) ? "Link copied" : "Could not copy. Select the address bar and copy it.");
}
async function shareApp() {
  if (onWebsite()) { toast(await copyText(APP_URL()) ? "Link copied. Paste it to share." : APP_URL()); return; }
  const data = { title: "Trendy IPO", text: "Live IPO tracker: subscription, GMP trend, score and allotment links.", url: APP_URL() };
  try { if (navigator.share) { await navigator.share(data); return; } } catch (e) { if (e && e.name === "AbortError") return; }
  toast(await copyText(data.url) ? "Link copied. Paste it to share." : data.url);
}
function aboutClick(t) {
  const a = t.dataset;
  if (t.hasAttribute("data-appshare")) { shareApp(); return true; }
  if (t.hasAttribute("data-nreadall")) { store.set("nread", [...new Set([...nRead(), ...notifList().map(x => x[4])])].slice(-300)); render(); toast("All notifications marked as read"); return true; }
  if (a.nkey) { const r = nRead(); if (!r.includes(a.nkey)) store.set("nread", [...r, a.nkey].slice(-300)); return false; }
  if ("sub" in a) { state.sub = a.sub || null; render(); scrollTo(0, 0); return true; }
  if (a.applied) { const k = state.applied.indexOf(a.applied); k < 0 ? state.applied.push(a.applied) : state.applied.splice(k, 1); store.set("applied", state.applied); render(); return true; }
  if (a.rate) { state.rate = +a.rate; store.set("rate", state.rate); if (window.trendyTrack) window.trendyTrack("rate/" + a.rate, "Rated " + a.rate); render(); return true; }
  if (t.hasAttribute("data-pansave")) { const v = (document.getElementById("pan-in")?.value || "").trim().toUpperCase(); if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) { toast("PAN looks wrong. Format: ABCDE1234F"); return true; } state.pan = v; store.set("pan", v); toast("PAN saved on this device"); return true; }
  if (t.hasAttribute("data-pandel")) { state.pan = ""; store.set("pan", ""); render(); return true; }
  return false;
}
document.addEventListener("change", e => { if (e.target.matches?.("[data-theme-toggle]")) { state.theme = e.target.checked ? "dark" : "light"; store.set("theme", state.theme); const h = document.documentElement; h.classList.add("themefade"); applyTheme(); setTimeout(() => h.classList.remove("themefade"), 600); } });
// ---------- modules: IPO (built in), Stocks, Mutual Fund (each in its own app-<name>.js, see docs/MODULES.md) ----------
// The bottom bar picks the module, the tab strip under the title picks the screen inside it. Module screens use state.tab = "<module>:<tab>";
// a module's detail pages use state.sub, so the phone's Back button and the Back arrow work in every module.
window.TrendyModules = window.TrendyModules || {};
state.mod = "ipo";
const modLoaded = {};
const MOD_LAST = store.get("modLast", {});
const MODS = ["ipo", "stocks", "mf"];   // a removed module (an old saved "fno" key, an old history step "fno:...") falls back to the IPO home
for (const k of Object.keys(MOD_LAST)) if (!MODS.includes(k)) delete MOD_LAST[k];
const fixTab = t => typeof t === "string" && t.includes(":") && !MODS.includes(t.split(":")[0]) ? "ipo" : t;
const IPO_TABS = [["live", "Live"], ["upcoming", "Upcoming"], ["listed", "Closed"], ["allot", "Allotment"], ["unlisted", "Unlisted"]];
function modOf(tab) { return tab === "ipo" || tab === "allot" || tab === "unlisted" ? "ipo" : typeof tab === "string" && tab.includes(":") ? (MODS.includes(tab.split(":")[0]) ? tab.split(":")[0] : "ipo") : null; }
function modTabs(m) { return m === "ipo" ? IPO_TABS : (window.TrendyModules[m]?.tabs || []); }
function modStrip() {
  const m = modOf(state.tab); if (!m || state.sub || state.detail || state.report) return "";
  const on = m === "ipo" ? (state.tab === "ipo" ? state.seg : state.tab) : state.tab.split(":")[1];
  return '<div class="mtabs" role="tablist">' + modTabs(m).map(([k, l]) => '<button role="tab" data-mtab="' + m + ":" + k + '" class="' + (k === on ? "on" : "") + '">' + l + "</button>").join("") + "</div>";
}
function goTab(m, k) {
  if (!MODS.includes(m)) { m = "ipo"; k = null; }
  const tabs = modTabs(m); if (!tabs.length) return;
  if (!k || !tabs.some(t => t[0] === k)) k = tabs.some(t => t[0] === MOD_LAST[m]) ? MOD_LAST[m] : tabs[0][0];
  if (m === "ipo") { if (k === "allot" || k === "unlisted") state.tab = k; else { state.tab = "ipo"; if (state.seg !== k) { state.seg = k; state.perf = null; state.showAll = false; } } }
  else state.tab = m + ":" + k;
  state.mod = m; MOD_LAST[m] = k; store.set("modLast", MOD_LAST);
  state.detail = null; state.report = null; state.sub = null; state.modal = null; state.drawer = false;
  render(); scrollTo(0, 0);
}
function hostApi() {
  return { state, esc, hl, flash: flashFirst, card, tbl, store, toast, isNum, f2, inr, safeUrl, head, fmtD, render, istDay, ic,
    setSub(k) { state.sub = k || null; render(); scrollTo(0, 0); }, back: goBack, go: goTab,
    get sub() { return state.sub; }, get tab() { return String(state.tab).split(":")[1] || ""; } };
}
function modScreen() {
  const m = modOf(state.tab), mod = m && window.TrendyModules[m];
  if (!mod) return head("Coming soon") + card("", '<p class="mut">This section is not available yet.</p>');
  let html; try { html = mod.render(String(state.tab).split(":")[1], state.sub, hostApi()); } catch (e) { console.error(e); html = head(mod.label) + card("", '<p class="mut">This screen could not be shown. Please try again.</p>'); }
  return html;
}
function modClick(t) {
  const a = t.dataset;
  if (a.mod) { goTab(a.mod, null); return true; }
  if (a.mtab) { const [m, k] = a.mtab.split(":"); goTab(m, k); return true; }
  if (a.m) { const mod = window.TrendyModules[a.m]; try { return !!(mod && mod.click && mod.click(t, hostApi())); } catch (e) { console.error(e); return true; } }
  return false;
}
for (const ev of ["input", "change"]) document.addEventListener(ev, e => {
  const el = e.target.closest?.("[data-m]"); if (!el) return;
  const mod = window.TrendyModules[el.dataset.m]; try { mod && mod[ev] && mod[ev](el, hostApi()); } catch (err) { console.error(err); }
});
// ---------- global search (IPOs + stocks + mutual funds) ----------
const SR = { q: "", stocks: null, sSt: "idle", mf: null, mSt: "idle" };
const SYM_RE = /^[A-Z0-9&_.$-]{1,20}$/;
const srRecent = () => { const r = store.get("recentSearches", []); return Array.isArray(r) ? r.filter(x => typeof x === "string").slice(0, 6) : []; };
const srSave = q => { q = q.trim(); if (q.length < 2) return; store.set("recentSearches", [q, ...srRecent().filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 6)); };
async function srLoadStocks() {
  if (SR.sSt !== "idle") return; SR.sSt = "loading";
  try {
    const r = await fetch("data/stocks/list.json", { cache: "no-cache" }); if (!r.ok) throw new Error(r.status);
    const j = await r.json(); if (!Array.isArray(j.rows)) throw new Error("bad");
    SR.stocks = j.rows.filter(x => Array.isArray(x) && typeof x[0] === "string" && SYM_RE.test(x[0])).map(x => ({ s: x[0], n: String(x[1] || ""), ln: String(x[1] || "").toLowerCase(), ls: x[0].toLowerCase(), close: x[3], chg: x[4], v: x[6] || 0 }));
    SR.sSt = "ok";
  } catch (e) { SR.sSt = "fail"; }
  srUpdate();
}
async function srLoadMf() {
  if (SR.mSt !== "idle") return; SR.mSt = "loading";
  try {
    const j = async u => { const r = await fetch(u, { cache: "no-cache" }); if (!r.ok) throw new Error(u); return r.json(); };
    const idx = await j("data/mf/index.json");
    const parts = await Promise.all((idx.files || []).filter(f => /^rows-[a-z]+\.json$/.test(f)).map(f => j("data/mf/" + f)));
    const rows = [];
    for (const p of parts) for (const r of (p && p.rows) || []) { if (!Array.isArray(r) || !Number.isInteger(r[0]) || typeof r[1] !== "string") continue; rows.push({ c: r[0], n: r[1], amc: idx.amcs?.[r[2]] || "", p: r[3] === 1 ? 1 : 0, cat: idx.cats?.[r[4]]?.[0] || "", s: (r[1] + " " + (idx.amcs?.[r[2]] || "")).toLowerCase() }); }
    SR.mf = rows; SR.mSt = "ok";
  } catch (e) { SR.mSt = "fail"; }
  srUpdate();
}
function srMatches(q) {
  const t = q.trim().toLowerCase(), out = { ipo: [], stock: [], fund: [], n: { ipo: 0, stock: 0, fund: 0 } };
  if (!t) return out;
  const ip = state.ipos.filter(i => (i.name + " " + i.symbol).toLowerCase().includes(t)).sort((a, b) => (b.status === "live") - (a.status === "live") || (b.open || "").localeCompare(a.open || ""));
  out.ipo = ip.slice(0, 5); out.n.ipo = ip.length;
  if (SR.stocks) {
    const m = [];
    for (const r of SR.stocks) { const rank = r.ls === t ? 0 : r.ls.startsWith(t) ? 1 : r.ln.startsWith(t) ? 2 : r.ls.includes(t) ? 3 : (" " + r.ln).includes(" " + t) ? 4 : r.ln.includes(t) ? 5 : -1; if (rank >= 0) m.push([rank, r]); }
    m.sort((a, b) => a[0] - b[0] || b[1].v - a[1].v); out.stock = m.slice(0, 5).map(x => x[1]); out.n.stock = m.length;
  }
  if (SR.mf) {
    const toks = t.split(/\s+/).filter(Boolean), m = SR.mf.filter(f => toks.every(k => f.s.includes(k)));
    m.sort((a, b) => a.p - b.p || (a.n.toLowerCase().startsWith(t) ? 0 : 1) - (b.n.toLowerCase().startsWith(t) ? 0 : 1) || a.n.length - b.n.length);
    out.fund = m.slice(0, 5); out.n.fund = m.length;
  }
  return out;
}
function srResults() {
  const q = SR.q.trim();
  if (!q) {
    const rec = srRecent();
    return `<div class="sr-empty">${ic("search")}<p>Search IPOs, NSE stocks and mutual funds in one place.</p></div>` + (rec.length ? `<div class="sr-recent"><div class="row"><h3>Recent</h3><button class="linkbtn" data-sclear>Clear</button></div><div class="chips">${rec.map(r => `<button class="chipb" data-srecent="${esc(r)}">${ic("history")} ${esc(r)}</button>`).join("")}</div></div>` : "");
  }
  const m = srMatches(q), fq = q.toLowerCase().split(/s+/).filter(Boolean);       // funds match on every word, so every word is marked
  const grp = (title, key, items, rowFn, seeAll, loading, failed) => {
    if (!items.length && !loading && !failed) return "";
    return `<section class="sr-grp"><div class="row"><h3>${title}</h3>${m.n[key] > 5 ? `<button class="linkbtn" data-sall="${seeAll}">See all ${m.n[key]} in ${title}</button>` : ""}</div>${items.length ? items.map(rowFn).join("") : failed ? `<p class="mut sm">Could not load this list. Check your connection.</p>` : `<div class="skel-row"></div><div class="skel-row"></div>`}</section>`;
  };
  const ipoRow = i => `<button class="sres" data-sres="ipo" data-id="${esc(i.symbol)}">${logo(i)}<span class="sres-m"><b>${hl(i.name, q)}</b><small>${esc(i.board)} · ${i.status === "live" ? "Open now" : i.status === "upcoming" ? "Upcoming" : "Closed"}${isNum(i.priceHigh) ? " · " + price(i) : ""}</small></span>${ic("chevron-right")}</button>`;
  const stRow = s => `<button class="sres" data-sres="stock" data-id="${esc(s.s)}"><span class="sres-ic">${esc(s.s.slice(0, 2))}</span><span class="sres-m"><b>${hl(s.s, q)}</b><small>${hl(s.n, q)}</small></span><span class="sres-r num"><b>${isNum(s.close) ? "₹" + s.close.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</b><small class="${isNum(s.chg) ? (s.chg >= 0 ? "grn-t" : "red-t") : ""}">${isNum(s.chg) ? (s.chg > 0 ? "+" : "") + s.chg.toFixed(2) + "%" : "—"}</small></span></button>`;
  const fRow = f => `<button class="sres" data-sres="fund" data-id="${f.c}"><span class="sres-ic">${ic("wallet")}</span><span class="sres-m"><b>${hl(f.n, fq)}</b><small>${hl(f.amc, fq)} · ${esc(f.cat)} · ${f.p ? "Regular" : "Direct"}</small></span>${ic("chevron-right")}</button>`;
  const html = grp("IPOs", "ipo", m.ipo, ipoRow, "ipo", false, false) + grp("Stocks", "stock", m.stock, stRow, "stocks", SR.sSt === "loading" || SR.sSt === "idle", SR.sSt === "fail") + grp("Mutual funds", "fund", m.fund, fRow, "mf", SR.mSt === "loading" || SR.mSt === "idle", SR.mSt === "fail");
  return html || `<div class="sr-empty">${ic("search")}<p>No results for “${esc(q)}”.</p></div>`;
}
function srUpdate() { const el = document.getElementById("gres"); if (el && state.tab === "search") el.innerHTML = srResults(); }
function searchScreen() {
  return `<div class="gs-bar"><label class="gs-in">${ic("search")}<input id="gq" type="search" placeholder="Search IPOs, stocks, funds" value="${esc(SR.q)}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="40" aria-label="Search IPOs, stocks and mutual funds"></label><button class="ib sq" data-back aria-label="Close search">${ic("x")}</button></div><div id="gres" aria-live="polite">${srResults()}</div>`;
}
function openSearch() {
  if (state.tab !== "search") { state.tab = "search"; state.detail = null; state.report = null; state.sub = null; state.modal = null; state.drawer = false; SR.q = ""; render(); scrollTo(0, 0); }
  srLoadStocks(); srLoadMf();
  const q = document.getElementById("gq"); if (q) q.focus();
}
function prefill(id, q, tries = 12) {
  const el = document.getElementById(id);
  if (el) { el.value = q; el.dataset.arrive = "1"; el.dispatchEvent(new Event("input", { bubbles: true })); return; }
  if (tries > 0) setTimeout(() => prefill(id, q, tries - 1), 150);
}
function searchClick(t) {
  const d = t.dataset;
  if (t.hasAttribute("data-sclear")) { store.set("recentSearches", []); srUpdate(); return true; }
  if (d.srecent) { SR.q = d.srecent; const q = document.getElementById("gq"); if (q) q.value = SR.q; srUpdate(); return true; }
  if (d.sall) {
    srSave(SR.q); const q = SR.q;
    if (d.sall === "ipo") { const first = state.ipos.find(i => (i.name + " " + i.symbol).toLowerCase().includes(q.trim().toLowerCase())); state.q = q.trim(); goTab("ipo", first ? first.status : "live"); setTimeout(() => flashFirst(".ipoc"), 120); }
    else if (d.sall === "stocks") { goTab("stocks", "search"); prefill("st-q", q); }
    else { goTab("mf", "funds"); prefill("mf-q", q); }
    return true;
  }
  if (d.sres) {
    srSave(SR.q);
    if (d.sres === "ipo" && byId(d.id)) { state.detail = d.id; }
    else if (d.sres === "stock" && SYM_RE.test(d.id || "")) { state.tab = "stocks:search"; state.mod = "stocks"; state.sub = "stock:" + d.id; state.detail = null; }
    else if (d.sres === "fund" && /^\d+$/.test(d.id || "")) { state.tab = "mf:funds"; state.mod = "mf"; state.sub = "fund:" + d.id; state.detail = null; }
    else return true;
    render(); scrollTo(0, 0); return true;
  }
  return false;
}
document.addEventListener("input", e => { if (e.target.id === "gq") { SR.q = e.target.value.slice(0, 40); srUpdate(); } });
document.addEventListener("keydown", e => {
  if (e.target.id !== "gq") return;
  if (e.key === "Enter") { const b = document.querySelector("#gres .sres"); if (b) b.click(); }
  else if (e.key === "Escape") goBack();
});

// ---------- motion helpers ----------
const REDUCED = () => matchMedia("(prefers-reduced-motion:reduce)").matches;
const cuSeen = new Set();
function countUps() {
  document.querySelectorAll("#app .cu").forEach(el => {
    const k = el.dataset.cu; if (cuSeen.has(k)) return; cuSeen.add(k);
    if (REDUCED()) return;
    const to = +el.dataset.to, dec = +(el.dataset.dec || 0), suf = el.dataset.suf || "", fin = el.textContent, t0 = performance.now();
    if (!isFinite(to)) return;
    const step = now => { const p = Math.min(1, (now - t0) / 650), e = 1 - Math.pow(1 - p, 3); if (p < 1 && el.isConnected) { el.textContent = (to * e).toLocaleString("en-IN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; requestAnimationFrame(step); } else el.textContent = fin; };
    requestAnimationFrame(step);
  });
}
const skelCards = n => Array.from({ length: n }, () => `<div class="card skel-card"><div class="skel-line w60"></div><div class="skel-line w40"></div><div class="skel-block"></div><div class="skel-line w80"></div></div>`).join("");
const SKEL = `<div class="skel" role="status" aria-label="Loading"><div class="skel-line w50"></div><div class="skel-row"></div><div class="skel-row"></div><div class="skel-row"></div></div>`;
let lastScreen = "", enterFlip = 0, shownModal = null, sheetTop = 0;
const screenKey = () => [state.tab, state.tab === "ipo" ? state.seg : "", state.sub || "", state.detail || "", state.report || ""].join("|");

// ---------- render & events ----------
function render() {
  state.tab = fixTab(state.tab);
  if (!state.loaded) {
    $("#app").dataset.view = "ipo";
    $("#app").innerHTML = state.error ? `<div class="card errc">${ic("alert-triangle")}<p>${esc(state.error)}</p><button class="btn" data-refresh>Try again</button></div>` : `${brand()}<div class="skel-top"></div><div class="cards">${skelCards(3)}</div>`;
    return;
  }
  const screens = { ipo: ipoTab, compare, allot: allotment, unlisted, settings, about: aboutPage, general: () => sectionPage("general"), share: () => sectionPage("share"), help: () => sectionPage("help"), search: searchScreen };
  if (state.detail && !byId(state.detail)) state.detail = null;           // an IPO that is no longer in the data
  if (state.report && !byId(state.report)) state.report = null;
  if (state.modal && !byId(state.modal)) state.modal = null;
  const sh0 = document.querySelector("#app .modal .card.sheet"); if (sh0) sheetTop = sh0.scrollTop;
  const ae = document.activeElement, keep = ae && ae.id && ae !== document.body ? { id: ae.id, s: ae.selectionStart, e: ae.selectionEnd } : null;
  $("#app").dataset.view = state.report ? "report" : state.detail ? "detail" : modOf(state.tab) && modOf(state.tab) !== "ipo" ? "mod" : state.tab;
  const mo = modOf(state.tab); if (mo) { state.mod = mo; if (!modLoaded[mo]) { modLoaded[mo] = true; try { TrendyModules[mo]?.load?.(hostApi()); } catch (e) { console.warn(e); } } }
  const sk = screenKey(), newScreen = sk !== lastScreen; lastScreen = sk;
  $("#app").innerHTML = staleBar() + (state.report ? reportView() : state.detail ? detail() : (screens[state.tab] || modScreen)()) + credit() +
    (state.modal ? (() => { const i = byId(state.modal), pre = preApply(i), still = shownModal === state.modal ? " still" : ""; return `<div class="modal${still}" data-close><div class="card sheet${still}"><button class="ib sq sheetx" data-close aria-label="Close">${ic("x")}</button><h3>${pre ? "Pre-apply for" : "Apply for"} ${esc(i.name)}</h3><p class="sm">Open your broker app or UPI app, go to the IPO section and choose <b>${esc(i.name)}</b>.</p>${pre ? `<p class="sm">The price band is out, so many brokers let you <b>pre-apply</b> now: your bid is placed in advance and goes in when the IPO opens${i.open ? " on <b>" + fmtD(i.open) + "</b>" : ""}. Availability depends on your broker.</p>` : ""}<ul class="sm applyl"><li>Price: ₹${i.priceHigh} (cut-off)</li><li>Min. lot: ${i.lot} shares = ₹${inr(i.lot * i.priceHigh)}</li><li>Closes: ${fmtD(i.close)}</li></ul><a class="btn wide ${pre ? "pre" : ""}" href="https://groww.in/ipo" data-track="broker/Groww" target="_blank" rel="noopener noreferrer">${pre ? "Pre Apply" : "Apply"} on Groww ${ic("external-link")}</a><div class="sm otherb"><b>Other brokers</b> <span class="mut">(opens their IPO page; log in with your own account)</span></div><div class="brokers">${BROKERS.filter(b => b[0] !== "Groww").map(([n, u]) => `<a class="chipb" data-track="broker/${esc(n)}" href="${u}" target="_blank" rel="noopener noreferrer">${n} ${ic("external-link")}</a>`).join("")}</div><p class="mut sm">You can also apply from the IPO section of UPI apps such as PhonePe, Google Pay or Paytm. Trendy IPO never asks for your login, UPI PIN or bank details.</p><button class="btn wide ghost" data-close>Got it</button></div></div>`; })() : "");
  { const sh = document.querySelector("#app .modal .card.sheet"); if (sh && shownModal === state.modal) sh.scrollTop = sheetTop; shownModal = state.modal || null; if (!state.modal) sheetTop = 0; }
  syncAck();
  // shimmer skeletons instead of "Loading…" text (module screens print plain loading lines while their data downloads)
  document.querySelectorAll("#app p.mut").forEach(p => { if (/^Loading/i.test(p.textContent.trim())) { const w = document.createElement("div"); w.innerHTML = SKEL; p.replaceWith(w.firstChild); } });
  const app = $("#app");
  if (newScreen && !REDUCED()) { enterFlip ^= 1; app.classList.remove("enter0", "enter1"); app.classList.add("enter" + enterFlip); }
  if (keep) { const n = document.getElementById(keep.id); if (n && n !== document.activeElement) { n.focus({ preventScroll: true }); try { if (keep.s != null) n.setSelectionRange(keep.s, keep.e); } catch {} } }
  if (newScreen && state.tab === "search") { const g = document.getElementById("gq"); if (g) { g.focus({ preventScroll: true }); srLoadStocks(); srLoadMf(); } }
  const side = $("#side"); side.innerHTML = sideMenu(); side.classList.toggle("open", !!state.drawer);
  document.querySelectorAll("nav button[data-mod]").forEach(b => { b.classList.toggle("on", b.dataset.mod === state.mod); b.setAttribute("aria-current", b.dataset.mod === state.mod ? "page" : "false"); });
  document.querySelectorAll("nav .navref").forEach(b => b.classList.toggle("spin", !!state.refreshing));
  document.querySelectorAll("nav .navbell i").forEach(x => x.remove()); if (unreadCount()) document.querySelectorAll("nav .navbell").forEach(b => b.insertAdjacentHTML("beforeend", '<i class="bdot"></i>'));
  const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); q.oninput = e => { state.q = e.target.value; render(); }; }
  const sel = (id, fn) => { const e = $(id); if (e) e.onchange = ev => fn(ev.target.value); };
  sel("#pick", v => { if (v) { state.cmp.push(v); store.set("cmp", state.cmp); render(); } });
  sel("#sort", v => { state.sort = v; render(); });
  sel("#allotSel", v => { state.allotIpo = v; render(); });
  countUps();
  pushView();
}
// ---- first-run disclaimer: ONE persistent dialog on <body> (outside #app, so render() never rebuilds, re-animates or scrolls it).
// Both languages are stacked in the same grid cell, so the dialog keeps one fixed height when the language is switched.
let ackEl = null, ackPrevFocus = null;
const ackPane = l => '<div class="ackpane" lang="' + l + '" data-l="' + l + '"><b>' + TEXT.disclaimerTitle[l] + "</b><br>" + TEXT.disclaimer[l] + "<br>" +
  (l === "en" ? `<button class="linkbtn" data-lang="hi">${ic("language")} Translate to Hindi / हिंदी में पढ़ें</button>` : `<button class="linkbtn" data-lang="en">${ic("language")} Show in English / अंग्रेज़ी में पढ़ें</button>`) + "</div>";
function setLock() { document.documentElement.classList.toggle("locked", !acked() || !!state.modal); }
function syncAck() {
  if (acked()) {
    if (ackEl) { ackEl.remove(); ackEl = null; [...document.body.children].forEach(n => n.removeAttribute("inert")); try { ackPrevFocus && ackPrevFocus.focus({ preventScroll: true }); } catch {} }
    setLock(); return;
  }
  if (!ackEl) {
    ackPrevFocus = document.activeElement;
    ackEl = document.createElement("div"); ackEl.className = "modal ackm"; ackEl.setAttribute("role", "dialog"); ackEl.setAttribute("aria-modal", "true"); ackEl.setAttribute("aria-label", "Disclaimer");
    ackEl.innerHTML = '<div class="card"><div class="ackbody">' + ackPane("en") + ackPane("hi") + '</div><button class="btn wide ackok" data-ack></button></div>';
    document.body.appendChild(ackEl);
    [...document.body.children].forEach(n => { if (n !== ackEl && n.id !== "splash" && n.tagName !== "SCRIPT" && n.tagName !== "STYLE") n.setAttribute("inert", ""); });
    setTimeout(() => { const b = ackEl && ackEl.querySelector("[data-ack]"); if (b) b.focus({ preventScroll: true }); }, 60);
  }
  const l = lang(), hi = l === "hi";
  ackEl.querySelectorAll(".ackpane").forEach(p => { const on = p.dataset.l === l; p.classList.toggle("off", !on); if (on) p.removeAttribute("inert"); else p.setAttribute("inert", ""); p.setAttribute("aria-hidden", on ? "false" : "true"); });
  const ok = ackEl.querySelector("[data-ack]"); if (ok.dataset.l !== l) { ok.dataset.l = l; ok.textContent = hi ? "मैं समझ गया" : "I understand"; ok.lang = l; }
  setLock();
}
document.addEventListener("keydown", e => {
  if (e.key === "Tab" && ackEl) {   // focus trap
    const f = [...ackEl.querySelectorAll("button,a[href]")].filter(x => !x.closest("[inert]"));
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (!ackEl.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  } else if (e.key === "Escape" && state.modal && !ackEl) { state.modal = null; render(); }
});
let toastTimer = null;
function toast(m) {
  render();   // some callers rely on this to redraw after a state change
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = String(m); void el.offsetWidth; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove("show"); toastTimer = setTimeout(() => el.remove(), 300); }, 1900);
}
document.addEventListener("click", e => {
  const t = e.target.closest("[data-open],[data-back],[data-tab],[data-seg],[data-watch],[data-cmp],[data-apply],[data-close],[data-jump],[data-search],[data-share],[data-toast],[data-ack],[data-lang],[data-report],[data-report-close],[data-print],[data-rtab],[data-more-filings],[data-pill],[data-stat],[data-more],[data-goto],[data-refresh],[data-star],[data-menu],[data-drawer-close],[data-mod],[data-mtab],[data-m],[data-sub],[data-nreadall],[data-nkey],[data-applied],[data-appshare],[data-rate],[data-pansave],[data-pandel],[data-allot-open],[data-gsearch],[data-bell],[data-sres],[data-sall],[data-srecent],[data-sclear]"); if (!t) return;
  trackClick(t, t.dataset);
  if (t.hasAttribute("data-refresh")) { loadData(true); return; }
  if (t.hasAttribute("data-menu")) { if (state.drawer) goBack(); else { state.drawer = true; render(); } return; }
  if (t.hasAttribute("data-drawer-close")) { goBack(); return; }
  if (t.hasAttribute("data-gsearch")) { openSearch(); return; }
  if (t.hasAttribute("data-bell")) { state.tab = "general"; state.sub = "notif"; state.detail = null; state.report = null; state.drawer = false; state.modal = null; render(); scrollTo(0, 0); return; }
  if (searchClick(t)) return;
  if (aboutClick(t)) return;
  if (modClick(t)) return;
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
  else if (d.tab) { if (state.drawer) replaceNext = true; state.tab = d.tab; state.detail = null; state.report = null; state.drawer = false; state.sub = null; }
  else if (d.seg) { state.seg = d.seg; state.perf = null; state.showAll = false; }
  else if (t.hasAttribute("data-search")) { state.search = !state.search; if (!state.search) state.q = ""; }
  else if (d.watch) { const k = state.watch.indexOf(d.watch); k < 0 ? state.watch.push(d.watch) : state.watch.splice(k, 1); store.set("watch", state.watch); }
  else if (d.cmp) { const k = state.cmp.indexOf(d.cmp); if (k >= 0) state.cmp.splice(k, 1); else if (state.cmp.length < 3) state.cmp.push(d.cmp); store.set("cmp", state.cmp); }
  else if (d.apply) { const i = byId(d.apply); if (phase(i).k !== "apply") return toast("Bidding is closed for this IPO"); state.modal = i.symbol; }
  else if (t.hasAttribute("data-close")) { goBack(); return; }
  else if (t.hasAttribute("data-share")) { shareIpo(); return; }
  else if (d.toast) return toast(d.toast);
  render();
});
document.addEventListener("change", e => {
  const d = e.target.dataset;
  if (d.alert) { state.alerts[d.alert] = e.target.checked; store.set("alerts", state.alerts); }
  else if (d.board) { state[d.board] = e.target.checked; if (!state.main && !state.sme) state.main = true; render(); }
});
// status is recomputed from today's date so a stale data file never shows a closed IPO as live
const withStatus = i => ({ ...i, status: i.close && dayDiff(i.close) < 0 ? "listed" : !i.open && !i.close && i.status !== "listed" ? "upcoming" : i.open && dayDiff(i.open) > 0 ? "upcoming" : i.status === "listed" ? "listed" : "live" });
// ---------- the phone's Back button ----------
// Every screen you move to (tab, menu page, an IPO, a report, the Apply popup, the side menu) adds one history step, so Back goes to the screen you came from
// instead of leaving the app. Switching report tabs does not add steps. Choosing a page from the side menu replaces the "menu open" step.
const levelKey = () => [state.tab === "ipo" ? "ipo~" + state.seg : state.tab, state.sub || "", state.detail || "", state.report || "", state.modal || "", state.drawer ? "d" : ""].join("|");
let navLevel = levelKey(), replaceNext = false;
const histState = () => ({ level: levelKey(), rtab: state.reportTab });
try { history.replaceState(histState(), ""); } catch {}
function pushView() {
  const lv = levelKey();
  try {
    if (lv !== navLevel) { navLevel = lv; replaceNext ? history.replaceState(histState(), "") : history.pushState(histState(), ""); }
    else { const h = history.state || {}; if (h.rtab !== state.reportTab) history.replaceState(histState(), ""); }
  } catch {}
  replaceNext = false;
}
window.addEventListener("popstate", e => {
  const s = e.state; if (!s || typeof s.level !== "string") return;
  const [tab0, sub, detail, report, modal, drawer] = s.level.split("|"); if (drawer === undefined) return;
  const [tab, segv] = String(tab0).split("~"); if (segv) state.seg = segv;
  const ft = fixTab(tab || "ipo"), gone = ft !== (tab || "ipo");   // a step of a removed module opens the IPO home
  navLevel = s.level; state.tab = ft; state.mod = modOf(state.tab) || state.mod; state.sub = gone ? null : sub || null; state.detail = gone ? null : detail || null; state.report = gone ? null : report || null; state.modal = modal || null; state.drawer = drawer === "d"; if (s.rtab) state.reportTab = s.rtab;
  render(); window.scrollTo(0, 0);
});
// the on-screen back arrows use the same history, so the phone's Back button and the arrow always agree
function goBack() {
  const before = levelKey();
  try { history.back(); } catch {}
  setTimeout(() => {                                                    // if the browser could not go back, step out one level directly
    if (levelKey() !== before) return;
    if (state.drawer) state.drawer = false; else if (state.modal) state.modal = null; else if (state.report) state.report = null; else if (state.detail) state.detail = null; else if (state.sub) state.sub = null; else state.tab = "ipo";
    render();
  }, 250);
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

document.addEventListener("keydown", e => { if (e.key === "Escape" && state.drawer) goBack(); });

// ---------- near-live market snapshot (live.js, docs/LIVE.md) ----------
// Started once at boot. It polls only while the page is visible and the market window is open. When a snapshot really changed (or the status changed) the
// current module's livePatch(H) is called: it swaps the HTML of its own [data-lvr] regions and updates its charts through update(), so nothing is re-mounted,
// inputs keep focus and the IPO screens (which have no livePatch) are never touched. The pill / line texts age by themselves (live.js, every 30 s).
(function () {
  const L = window.TrendyLive; if (!L) return;
  const patch = () => {
    const m = modOf(state.tab); if (!m || m === "ipo" || !state.loaded) return;
    const mod = window.TrendyModules[m]; if (!mod || typeof mod.livePatch !== "function") return;
    try { mod.livePatch(hostApi()); } catch (e) { console.warn("live patch", e); }
  };
  L.subscribe(patch, { status: true });
  try { L.start(); } catch (e) { console.warn("live start", e); }
})();
