// Step 5: merge NSE data + GMP + RHP fundamentals into data/ipos.json (the only file the app reads).
// Also appends a subscription snapshot per IPO to data/sub-history.json so day-wise data builds up automatically.
import fs from "node:fs/promises";
import path from "node:path";
import { norm } from "./util.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = async (f, d) => JSON.parse(await fs.readFile(path.join(DATA, f), "utf8").catch(() => JSON.stringify(d)));
import { loadEntries } from "./entries.mjs";
const nseAll = await loadEntries();   // NSE issues + BSE-only issues
// NSE's past-issues list can return the same symbol twice (seen with SRIT: two different snapshots). Keep one row per symbol: the one with the most bids,
// because a finished issue's bid count never goes down, so the larger one is the later and complete snapshot.
const nse = [...nseAll.reduce((m, r) => {
  const p = m.get(r.symbol), bids = e => Number(e?.demand?.totalBidRecieved) || Number(e?.row?.noOfsharesBid) || 0;
  if (!p || bids(r) > bids(p)) m.set(r.symbol, r);
  return m;
}, new Map()).values()];
const gmp = await read("gmp.json", { current: {}, history: {} });
const subHist = await read("sub-history.json", {});

const num = s => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/); return m ? Number(m[0]) : null; };   // NSE writes some totals as "1.404E7"
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const iso = s => { const m = String(s || "").match(/(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})/); if (!m) return null; return `${m[3]}-${String(MON[m[2].toLowerCase()] + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`; };
const addWorkdays = (d, n) => { const x = new Date(d + "T00:00:00"); while (n > 0) { x.setDate(x.getDate() + 1); if (x.getDay() % 6) n--; } return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
const today = new Date().toISOString().slice(0, 10);

// NSE's "Issue Size" text describes Fresh Issue / Offer for Sale either in shares or in money (lakhs / million / crore).
// Returns the full issue (incl. anchor) or nulls when a component can't be read, never a partial sum.
function parseIssueSize(txt, price) {
  const parts = []; const re = /(fresh issue|offer for sale)/gi; let m;
  while ((m = re.exec(txt))) parts.push(m.index);
  if (!parts.length || !price) return { shares: null, cr: null };
  // an amount written before the first keyword ("comprising of aggregating up to 7500 million and offer for sale ...") is part of the issue too
  if (/([\d,]+(?:\.\d+)?)\s*(lakhs?|million|crores?|cr\b)/i.test(txt.slice(0, parts[0]))) parts.unshift(0);
  let cr = 0;
  for (let k = 0; k < parts.length; k++) {
    const seg = txt.slice(parts[k], parts[k + 1] ?? parts[k] + 220);
    const money = seg.match(/(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|million|crores?|cr\b)/i);
    const sh = seg.match(/([\d,]{5,})\s*equity shares/i);
    if (money && (!sh || money.index < sh.index)) { const v = num(money[1]), u = money[2].toLowerCase(); cr += u.startsWith("lakh") ? v / 100 : u === "million" ? v / 10 : v; }
    else if (sh) cr += num(sh[1]) * price / 1e7;
    else return { shares: null, cr: null };
  }
  cr = Math.round(cr * 100) / 100;
  return { shares: Math.round(cr * 1e7 / price), cr };
}

// any other top-level reserved category (not QIB / NII / Retail / Employees / Shareholders) so that the categories always add up to the Total row
function otherCat(rows) {
  const top = rows.filter(r => /^\d+$/.test(String(r.srNo).trim()) && !["1", "2", "3"].includes(String(r.srNo).trim()) && !/employee|^shareholders?\b/i.test(String(r.category).trim()) && num(r.noOfShareOffered ?? r.noOfSharesOffered) > 0);
  if (!top.length) return null;
  return { offered: top.reduce((a, r) => a + num(r.noOfShareOffered ?? r.noOfSharesOffered), 0), bid: top.reduce((a, r) => a + (num(r.noOfSharesBid) || 0), 0), times: null, label: top.map(r => String(r.category).trim()).join(", ") };
}
function bids(rows) {
  const by = {}; for (const r of rows) by[String(r.srNo)] = { offered: num(r.noOfShareOffered ?? r.noOfSharesOffered), bid: num(r.noOfSharesBid), times: num(r.noOfTotalMeant ?? r.noOfTime) };
  const pick = k => by[k] && by[k].offered ? by[k] : null;
  const total = rows.find(r => /^total$/i.test(String(r.category).trim()) || /^total/i.test(String(r.srNo)));
  return { qib: pick("1"), nii: pick("2"), bnii: pick("2.1"), snii: pick("2.2"), retail: pick("3"), employee: rows.some(r => /employee/i.test(r.category)) ? by[rows.find(r => /employee/i.test(r.category)).srNo] : null,
    shareholders: rows.some(r => /^shareholders?\b/i.test(String(r.category).trim()) && (r.noOfShareOffered ?? r.noOfSharesOffered)) ? by[rows.find(r => /^shareholders?\b/i.test(String(r.category).trim())).srNo] : null,   // e.g. Jio: a reserved portion for the promoter group's shareholders
    other: otherCat(rows),
    total: total ? { offered: num(total.noOfShareOffered ?? total.noOfSharesOffered), bid: num(total.noOfSharesBid), times: num(total.noOfTotalMeant ?? total.noOfTime) } : null };
}

const quotes = await read("quotes.json", {});
const params = await read("params.json", {});          // category shares + anchor summary parsed from NSE PDFs (params.mjs)
const contactsFile = await read("contacts.json", {});  // company / registrar contacts parsed from offer documents (contacts.mjs)
const prevOut = await read("ipos.json", { ipos: [], filings: [] });   // a source failure must never blank what we already had
const prevBy = new Map((prevOut.ipos || []).map(i => [i.symbol, i]));
const sebi = await read("sebi.json", { filings: [], offerDocs: [] });
const verify = await read("verify.json", {});
const logos = await read("logos.json", {});
const offerFiles = await read("offer-docs.json", {});
const gkeys = Object.keys(gmp.current);
const findG = name => { const nk = norm(name); return gkeys.find(k => k === nk || (k.length > 4 && (nk.startsWith(k + " ") || k.startsWith(nk + " ")))) || null; };
const boardFor = (board, lot, price) => { const v = lot > 0 && price > 0 ? lot * price : null; return v === null ? board : v >= 100000 ? "SME" : v <= 20000 ? "Mainboard" : board; };
const statusOf = (open, close) => close && close < today ? "listed" : !open && !close ? "upcoming" : open && open > today ? "upcoming" : "live";   // no dates yet = it has not opened
const pct = (a, b) => (a != null && b ? Math.round((a / b - 1) * 10000) / 100 : null);
// Company names: if the exchange already wrote the name in proper capitals ("HD Fire Protect Limited", "AceVector Limited") it is kept as it is.
// Only ALL-CAPS or all-lowercase names are rewritten: small words stay small, initials and vowel-less acronyms (SMC, PM, R.K.) stay capital, "Shah Investor's" keeps its apostrophe.
const SMALL_WORDS = new Set(["and", "of", "the", "in", "for", "to", "on", "at", "by", "a", "an"]);
const prettyName = s => {
  const t = String(s).trim().replace(/\s+/g, " ");
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t.replace(/ Ltd\.?$/i, " Limited");
  const word = (w, k) => {
    const lw = w.toLowerCase(), letters = lw.replace(/[^a-z]/g, "");
    if (k > 0 && SMALL_WORDS.has(lw)) return lw;
    if (letters.length === 1 || (letters.length >= 2 && letters.length <= 4 && !/[aeiouy]/.test(letters)) || /^([a-z]\.)+[a-z]?\.?$/.test(lw)) return w.toUpperCase();   // initials, SMC, PM, R.K.
    return lw.replace(/(^|[^a-z'])([a-z])/g, (_, p, c) => p + c.toUpperCase());
  };
  return t.split(" ").map(word).join(" ").replace(/ Ltd\.?$/i, " Limited");
};
const matchedKeys = new Set();

function gmpBlock(gk) {
  const g = gk ? gmp.current[gk] : null;
  if (!g || g.gmp == null) return null;
  return { value: g.gmp, min: g.min, max: g.max, sources: g.sources, rating: g.rating ?? null, updated: g.igUpdated || g.sources.map(s => s.updated).find(Boolean) || null, history: gmp.history[gk] || [] };
}
// cross-check NSE (official) against InvestorGain; a disagreement is surfaced, never silently resolved
function checks(i, g) {
  const c = []; if (!g) return c;
  const add = (field, a, b, tol = 0) => { if (a != null && b != null) c.push({ field, nse: a, other: b, ok: Math.abs(a - b) <= tol * Math.max(1, Math.abs(a)) }); };
  add("Issue size (Cr)", i.issueSizeCr, g.igSizeCr, 0.02); add("Lot size", i.lot, g.igLot); add("Cap price", i.priceHigh, g.igPrice);
  if (i.close && g.close) c.push({ field: "Close date", nse: i.close, other: g.close, ok: i.close === g.close });
  return c;
}

// ---- documents: files hosted in data/files/<SYMBOL>/ (readable + downloadable in the app) for recent IPOs,
// NSE zip links for anything not hosted, plus the SEBI filing page and the GMP page.
const KEY_OF = { "Red Herring Prospectus": "rhp", "Ratios / Basis of Issue Price": "ratios", "Anchor Allocation Report": "anchor", "Security Parameters": "security", "Security Parameters (Pre Anchor)": "preanchor",
  "Security Parameters (Post Anchor)": "postanchor", "Bidding Centers": "bidding", "Sample Application Forms": "forms" };
const KEY_LABEL = { rhp: "Red Herring Prospectus (RHP)", ratios: "Price band ad / basis for issue price", anchor: "Anchor investors allocation", security: "Security parameters", preanchor: "Security parameters (before anchor)",
  postanchor: "Security parameters (after anchor)", bidding: "Bidding centres", forms: "Application form" };
const KEY_GROUP = { rhp: "Offer document", ratios: "Price band & basis", anchor: "Anchor investors", security: "Anchor investors", preanchor: "Anchor investors", postanchor: "Anchor investors", bidding: "Application forms & centres", forms: "Application forms & centres" };
const sebiFor = name => { const n = norm(name); return (sebi.filings || []).find(f => { const c = norm(f.company); return c === n || c.startsWith(n + " ") || n.startsWith(c + " "); }) || null; };
const stem = f => f.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
function fileLabel(key, file) {
  const s = stem(file);
  if (key === "forms") {
    if (/abridged|abrigde/i.test(s)) return "Abridged prospectus";
    if (/instruction/i.test(s)) return /\bNR|NRI/i.test(s) ? "Application form instructions (non-resident)" : "Application form instructions (resident)";
    if (/emp/i.test(s)) return "Application form (employees)";
    if (/\bNR|NRI|non.?resident/i.test(s)) return "Application form (non-resident / NRI)";
    if (/resident|\bR\b|R Form|R3|R4/i.test(s)) return "Application form (resident)";
  }
  if (key === "bidding") return /\bNR\b|non.?resident/i.test(s) ? "Bidding centres (non-resident)" : /\bR\b|resident/i.test(s) ? "Bidding centres (resident)" : "Bidding centres";
  if (key === "anchor" || key === "security" || key === "preanchor" || key === "postanchor") return KEY_LABEL[key];
  return `${KEY_LABEL[key]} — ${s.length > 60 ? s.slice(0, 57) + "…" : s}`;
}
async function docsFor(symbol, name, info, ig, bse = null) {
  const list = [], hosted = new Set();
  const mb = n => Math.round(n / 104857.6) / 10;
  const HOST = !!process.env.HOST_FILES;                           // hosted copies are off by default: the app links to the official files
  const rhp = HOST ? await fs.stat(path.join(DATA, "files", symbol, "RHP.pdf")).catch(() => null) : null;
  if (rhp) { hosted.add("rhp"); list.push({ label: KEY_LABEL.rhp, url: `data/files/${symbol}/RHP.pdf`, source: "NSE", kind: "pdf", sizeMB: mb(rhp.size), hosted: true, group: KEY_GROUP.rhp }); }
  for (const key of ["ratios", "anchor", "security", "preanchor", "postanchor", "bidding", "forms"]) {
    const dir = path.join(DATA, "files", symbol, key);
    for (const file of (HOST ? await fs.readdir(dir).catch(() => []) : []).sort()) {
      const st = await fs.stat(path.join(dir, file)); hosted.add(key);
      list.push({ label: fileLabel(key, file), url: `data/files/${symbol}/${key}/${file}`, source: "NSE", kind: /\.pdf$/i.test(file) ? "pdf" : "file", sizeMB: mb(st.size), hosted: true, group: KEY_GROUP[key], file });
    }
  }
  for (const [k, v] of Object.entries(info)) {                      // NSE zips for anything we don't host
    const key = KEY_OF[k];
    if (/^https?:\/\/\S+\.(zip|pdf)/i.test(v) && !(key && hosted.has(key))) list.push({ label: (KEY_LABEL[key] || k) + " (zip from NSE)", url: v, source: "NSE", kind: /\.pdf/i.test(v) ? "pdf-link" : "zip", group: KEY_GROUP[key] || "Other" });
  }
  if (bse?.docs) {                                                  // documents published on BSE
    const d = bse.docs;
    if (d.prospectus) list.push({ label: "Prospectus / RHP with GID (zip from BSE)", url: d.prospectus, source: "BSE", kind: "zip", group: "Offer document" });
    if (d.priceBandAd) list.push({ label: "Price band advertisement", url: d.priceBandAd, source: "BSE", kind: "pdf-link", group: "Price band & basis" });
    if (d.addendum) list.push({ label: "Addendum", url: d.addendum, source: "BSE", kind: "pdf-link", group: "Offer document" });
    if (d.corrigendum) list.push({ label: "Corrigendum", url: d.corrigendum, source: "BSE", kind: "pdf-link", group: "Offer document" });
    if (d.anchorNotice) list.push({ label: "Anchor allocation notice", url: d.anchorNotice, source: "BSE", kind: "pdf-link", group: "Anchor investors" });
  }
  const od = offerFiles[symbol];                                   // official PDF on SEBI (final Prospectus preferred, else RHP)
  if (od?.pdfUrl) list.push({ label: `${od.kind === "Prospectus" ? "Prospectus (final)" : "RHP"} — SEBI copy`, url: od.pdfUrl, source: "SEBI", kind: "pdf-link", group: "Offer document" });
  const s = sebiFor(name); if (s) list.push({ label: `SEBI filing page (${s.type})`, url: s.url, source: "SEBI", kind: "link", group: "Links" });
  if (ig?.igUrl) list.push({ label: "GMP & schedule page", url: ig.igUrl, source: "InvestorGain", kind: "link", group: "Links" });
  return list;
}

// ---- exchange timestamp ("Updated as on 16-Oct-2026 19:00:00", "As on 16-Oct-2026 19:00:00 IST") -> ISO with the +05:30 offset
const istIso = s => {
  const m = String(s || "").match(/(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (!m || MON[m[2].toLowerCase()] == null) return null;
  const p = n => String(n).padStart(2, "0");
  return `${m[3]}-${p(MON[m[2].toLowerCase()] + 1)}-${p(m[1])}T${p(m[4])}:${m[5]}:${p(m[6] || 0)}+05:30`;
};
const r2 = x => Math.round(x * 100) / 100;
// ---- finished SME issues: NSE's category table shows "offered 0" and omits Retail. NSE's bidDetails has the real shares bid per category (and number of applications);
// the shares offered per category come from NSE's Security Parameters PDF (params.json). Everything must reconcile or it is not used.
function smeBids(r, b, cats) {
  const bd = r.bidDetails || []; if (!bd.length || b.qib?.offered > 0) return null;
  const by = {}; for (const x of bd) by[/^total$/i.test(x.category) ? "T" : String(x.srNo ?? "")] = x;
  const one = (k, off) => { const x = by[k]; if (!x) return null; const bid = num(x.shares); if (bid == null) return null; return { offered: off ?? null, bid, times: off > 0 ? r2(bid / off) : null, applications: num(x.applications) }; };
  const T = by.T ? num(by.T.shares) : null, q = by["1"] ? num(by["1"].shares) : null, n = by["2"] ? num(by["2"].shares) : null, rt = by["3"] ? num(by["3"].shares) : null;
  if (T == null || q == null || n == null || rt == null || !(T > 0)) return null;
  if (Math.abs(q + n + rt - T) > T * 0.1) return null;                                    // categories must add up to the Total row
  const dt = num(r.demand?.noOfTimesIssueSubscribed);
  let c = cats?.categories || null;
  if (c && !(dt > 0 && Math.abs(T / c.total - dt) <= dt * 0.02 + 0.006)) c = null;       // the PDF's issue size must reproduce NSE's own total subscription
  const out = { qib: one("1", c?.qib), nii: one("2", c?.nii), bnii: one("2.1", c?.bnii), snii: one("2.2", c?.snii), retail: one("3", c?.retail), employee: null, shareholders: null, other: null,
    marketMaker: c?.marketMaker ? { offered: c.marketMaker, bid: null, times: null } : null,
    total: { offered: c?.total ?? null, bid: T, times: dt > 0 ? dt : (c ? r2(T / c.total) : null) } };
  return { bids: out, withOffered: !!c };
}
// ---- who is bidding: the sub-rows of NSE's category table (QIB: FII / banks / mutual funds / others, NII: corporates / individuals / others), exactly as NSE shows them
function bidSplitOf(r) {
  const rows = (r.bids || []).filter(x => x && /^[0-9]+(\.[0-9]+)?\([a-z]\)$/.test(String(x.srNo ?? "")) && x.category);
  const out = rows.map(x => ({ id: String(x.srNo), label: String(x.category).replace(/\s+/g, " ").trim().slice(0, 140), offered: num(x.noOfShareOffered), bid: num(x.noOfSharesBid), times: num(x.noOfTotalMeant) })).filter(x => x.bid != null && x.bid >= 0);
  return out.length ? out : null;
}
// ---- issue facts NSE publishes (tick size, discount, bid limits, timings, UPI sub-categories); short text only, as NSE words it
function nseInfoOf(info) {
  const t = (k, n = 300) => { const v = String(info[k] ?? "").replace(/\s+/g, " ").trim(); return v && !/^(na|nil|-)$/i.test(v) ? v.slice(0, n) : null; };
  const o = { tickSize: t("Tick Size", 80), discount: t("Discount"), faceValue: t("Face Value", 80), bidLot: t("Bid Lot", 120), maxBidQib: t("Maximum Bid Quantity for QIB Investors", 160), maxBidNib: t("Maximum Bid Quantity for NIB Investors", 160),
    marketTimings: t("IPO Market Timings", 200), upiSubCategories: t("Sub-Categories applicable for UPI", 200), categories: t("Categories", 200), remark: t("Remark", 300) };
  return Object.values(o).some(Boolean) ? o : null;
}
// ---- who to contact: registrar from NSE/BSE issue info, the rest from the offer document (contacts.json)
const phoneOf = s => { const m = String(s || "").replace(/\s+/g, " ").match(/(\+?\d[\d ()-]{7,}\d)/); return m ? m[1].trim() : null; };
const emailOf = s => (String(s || "").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0]?.toLowerCase() || null;
function contactsFor(r, info, domain) {
  const ci = info["Contact person name number and Email id"];
  const reg = info["Name of the Registrar"] ? { name: info["Name of the Registrar"], address: info["Address of the Registrar"] || null, phone: phoneOf(ci), email: emailOf(ci),
    contactPerson: (String(ci || "").split(/[,;]|\+?\d{2}/)[0] || "").trim() || null, website: null } : null;
  const f = contactsFile[r.symbol] || {};
  const reg2 = reg ? { ...reg, website: f.registrar?.website || null, phone: reg.phone || f.registrar?.phone || null, email: reg.email || f.registrar?.email || null } : (f.registrar || null);
  const co = f.company ? { ...f.company } : {};
  if (!co.website && domain) co.website = "https://" + domain;     // domain read from the offer document's cover page and matched to the company name (logos.mjs)
  const company = ["address", "phone", "email", "website", "contactPerson"].some(k => co[k]) ? { address: co.address || null, phone: co.phone || null, email: co.email || null, website: co.website || null, contactPerson: co.contactPerson || null } : null;
  return company || reg2 ? { company, registrar: reg2, source: "NSE issue info" + (f.company || f.registrar ? " + offer document" : "") + (company?.website && !f.company?.website ? " (company website from offer document cover)" : "") } : null;
}
// ---- lead managers as a list: the offer document's full list (contacts.json, parsed by contacts.mjs) when it has at least as many names as NSE's text, else NSE's text split into names
// (split at commas / semicolons, and at " and " only when the part before it ends in a company suffix, so "HSBC Securities and Capital Markets (India) Private Limited" stays one name)
const SUFFIX = /(?:Limited|Ltd\.?|LLP|Paribas)$/i;
function splitManagers(s) {
  const out = [];
  for (const p of String(s || "").split(/\s*[,;]\s*/)) {
    let rest = p.trim();
    for (const m of [...rest.matchAll(/\s+and\s+/gi)]) { const l = rest.slice(0, m.index).trim(), rr = rest.slice(m.index + m[0].length).trim(); if (SUFFIX.test(l) && /^[A-Z0-9]/.test(rr)) { out.push(l); rest = rr; break; } }
    if (rest) out.push(rest.replace(/\s+/g, " "));
  }
  return [...new Set(out)].filter(x => x.length >= 3 && x.length <= 90);
}
function leadManagersList(symbol, nseText) {
  const nse = splitManagers(nseText), rhp = contactsFile[symbol]?.leadManagers;
  const list = Array.isArray(rhp) && rhp.length && rhp.length >= nse.length ? rhp : nse;
  return list.length ? list : null;
}
// ---- "Apply as": what each investor category pays and may bid, only from what NSE states
function applyAsFor(info, priceLow, priceHigh, lot, board) {
  if (!priceHigh || !lot) return { applyAs: null, minInvestment: null, minInvestmentLots: null };
  const cat = String(info["Categories"] || ""), disc = String(info["Discount"] || "");
  const rupees = t => { const m = String(t).match(/Rs\.?\s*([\d,]+(?:\.\d+)?)/i); return m ? num(m[1]) : null; };
  const maxOf = re => { for (const [k, v] of Object.entries(info)) if (re.test(k)) { const x = num(v); if (x) return x; } return null; };
  const moq = num(info["Minimum Order Quantity"]);                                          // shares, e.g. "43 Equity Shares"
  const minLots = moq && lot && moq % lot === 0 ? moq / lot : null;
  const out = [{ category: "Regular", priceLow, priceHigh, maxAmount: maxOf(/Maximum Subscription Amount for Retail/i), minAmount: minLots ? Math.round(minLots * lot * priceHigh) : null, lot, note: "Retail individual investors" }];
  const empMax = maxOf(/Maximum Subscription Amount for (Eligible )?Employee/i);
  if (/\bEMP\b/.test(cat) || empMax) {
    const d = /employee/i.test(disc) ? rupees(disc) : /^\s*(na|nil|-)?\s*$/i.test(disc) ? 0 : null;       // "Rs. 14/- per equity share is being offered to Eligible Employees"
    out.push({ category: "Employee", priceLow: d != null && priceLow != null ? r2(priceLow - d) : null, priceHigh: d != null ? r2(priceHigh - d) : null, maxAmount: empMax, minAmount: null, lot, note: d ? `Discount Rs ${d} per share` : d === 0 ? "No discount stated" : "Discount not stated" });
  }
  const shMax = maxOf(/Maximum Subscription Amount for Shareholder/i);
  if (/\bSHA\b/.test(cat) || shMax) {
    const d = /shareholder/i.test(disc) ? rupees(disc) : null;
    out.push({ category: "Shareholder", priceLow: d != null && priceLow != null ? r2(priceLow - d) : null, priceHigh: d != null ? r2(priceHigh - d) : null, maxAmount: shMax, minAmount: null, lot, note: d ? `Discount Rs ${d} per share` : "Price for shareholders not stated by NSE" });
  }
  const retMax = out[0].maxAmount;
  if (retMax && /\bNOH\b|\bNII\b|\bNIB\b/.test(cat)) {                  // HNI / non-institutional: must bid above the retail limit, no upper limit except the issue size
    const unit = lot * priceHigh, minAmt = Math.round((Math.floor(retMax / unit) + 1) * unit);
    out.push({ category: "HNI", priceLow, priceHigh, maxAmount: null, minAmount: minAmt, lot, note: "Non-institutional: bid above the retail limit" });
  }
  return { applyAs: out, minInvestment: minLots ? Math.round(minLots * lot * priceHigh) : (moq == null && board === "Mainboard" ? Math.round(lot * priceHigh) : null), minInvestmentLots: minLots ?? (moq == null && board === "Mainboard" ? 1 : null) };
}
// anything a source failed to give this time is taken from the previous build instead of being blanked
const carry = (cur, prev) => cur == null || (Array.isArray(cur) && !cur.length) ? (prev ?? cur) : cur;

const out = [];
for (const r of nse) {
  if (r.row?.series === "DEBT" || /\bZCZP\b/i.test(r.name || "")) continue;                // not an IPO (social-stock bond): never shown
  const info = r.info || {}, row = r.row || {}, past = r.bucket === "listed" ? r.row : null;
  const band = [row.issuePrice, row.priceRange, info["Price Range"]].map(x => String(x || "").match(/(\d[\d,.]*)\D+(\d[\d,.]*)/)).find(Boolean) || null;
  const gk = findG(r.name), ig = gk ? gmp.current[gk] : null; if (gk) matchedKeys.add(gk);
  const priceLow = band ? num(band[1]) : null; let priceHigh = band ? num(band[2]) : null;
  if (priceHigh == null && ig?.igPrice) priceHigh = ig.igPrice;                      // SME: NSE list has no price
  const open = iso(info["Issue Period"]?.split(/\s+to\s+/)[0] || row.issueStartDate || past?.ipoStartDate) || ig?.open || null;
  const close = iso(info["Issue Period"]?.split(/\s+to\s+/)[1] || row.issueEndDate || past?.ipoEndDate) || ig?.close || null;
  const listedOn = past ? iso(past.listingDate) : null;
  const lot = num(info["Bid Lot"] ?? info["Lot Size"]) ?? ig?.igLot ?? null;
  const { shares: fullShares, cr: fullCr } = parseIssueSize(info["Issue Size"] || "", priceHigh);
  const issueShares = fullShares || num(row.issueSize) || num(row.noOfSharesOffered);
  const b = bids(r.bids || []);
  if (row.series === "SME" && row.noOfTime != null) b.total = { offered: num(row.noOfSharesOffered), bid: num(row.noOfsharesBid), times: num(row.noOfTime) };
  if (!b.total && ig?.igSub != null && statusOf(open, close) !== "upcoming") b.total = { offered: null, bid: null, times: ig.igSub };   // BSE issues: only InvestorGain has the headline subscription
  if (!b.total && row.noOfTime != null) b.total = { offered: num(row.noOfSharesOffered), bid: num(row.noOfsharesBid), times: num(row.noOfTime) };
  // Finished SME issues: NSE's category table is all zeros ("offered 0", "0.00x") and has no Retail row. Its demand figures
  // (all bids and times subscribed) are the real ones, so they are used instead. The offered figure is then unknown, not 0.
  { const dt = num(r.demand?.noOfTimesIssueSubscribed), db = num(r.demand?.totalBidRecieved);
    if (b.total && !(b.total.offered > 0 && b.total.times > 0) && dt > 0 && db > 0) b.total = { offered: null, bid: db, times: dt };
    if (b.total && !(b.total.offered > 0) && !(b.total.times > 0)) b.total = { ...b.total, times: null }; }
  const status = statusOf(open, close);
  const boardVal = boardFor(row.series === "SME" ? "SME" : ig?.board || (Object.keys(info).length ? "Mainboard" : "SME"), lot, priceHigh);
  const pc = params[r.symbol] || null, prev = prevBy.get(r.symbol) || null;
  const sme = smeBids(r, b, pc);
  let bidsOut = b, bidsSource = "NSE bid table";
  if (sme) { bidsOut = sme.bids; bidsSource = sme.withOffered ? "NSE bid details + NSE security-parameters PDF (shares offered)" : "NSE bid details (shares bid; shares offered per category not available)"; }
  const anc = pc?.anchor?.amountVerified && pc.anchor.totalShares ? pc.anchor : null;
  if (anc) bidsOut = { ...bidsOut, anchor: { offered: anc.totalShares, bid: anc.totalShares, times: null } };
  if (!bidsOut.total && prev?.bids?.total) { bidsOut = prev.bids; bidsSource = (prev.bidsSource || "previous build") + " (kept from previous build)"; }   // source failed this time
  const aa = applyAsFor(info, priceLow, priceHigh, lot, boardVal);
  const subsAsOnX = istIso(r.bidsAsOn) || istIso(r.demand?.timestamp);
  const fund = await fs.readFile(path.join(DATA, "fundamentals", `${r.symbol}.json`), "utf8").then(t => { try { return JSON.parse(t); } catch { return null; } }, () => null);   // tolerate a file that is mid-write
  if (b.total?.times != null && status === "live") {
    const h = (subHist[r.symbol] ||= []); const snap = { at: new Date().toISOString(), date: today, qib: b.qib?.times ?? null, bnii: b.bnii?.times ?? null, snii: b.snii?.times ?? null, nii: b.nii?.times ?? null, retail: b.retail?.times ?? null, total: b.total.times };
    const last = h[h.length - 1]; if (last?.date === today) h[h.length - 1] = snap; else h.push(snap);
  }
  const allotment = ig?.allotment || (close ? addWorkdays(close, 1) : null);
  const listing = listedOn || ig?.listing || (close ? addWorkdays(close, 3) : null);
  const q = quotes[r.symbol] || null;
  out.push({
    symbol: r.symbol, name: prettyName(r.name), board: boardFor(row.series === "SME" ? "SME" : ig?.board || (Object.keys(info).length ? "Mainboard" : "SME"), lot, priceHigh), status, open, close,
    // T = close. Allotment T+1, refund + demat credit T+2, listing T+3 (InvestorGain's announced dates win when available)
    timeline: { open, close, allotment, refund: allotment ? addWorkdays(allotment, 1) : null, demat: allotment ? addWorkdays(allotment, 1) : null, listing },
    allotment, listing, datesExpected: !(listedOn || ig?.listing),
    priceLow, priceHigh, lot, faceValue: num(info["Face Value"]), issueShares, issueSizeCr: fullCr ?? (issueShares && priceHigh ? Math.round(issueShares * priceHigh / 1e5) / 100 : null) ?? ig?.igSizeCr ?? null,
    issueType: info["Issue Type"] || null, maxRetailAmount: num(info["Maximum Subscription Amount for Retail Investor"]),
    issueDetail: info["Issue Size"] || null, upiCutoff: info["Cut-off time for UPI Mandate Confirmation"] || null,
    bids: bidsOut, bidsSource,
    // when the exchange's own table was last updated (ISO, +05:30); else the time we fetched it
    subsAsOn: subsAsOnX || r.fetchedAt || null, subsAsOnSource: subsAsOnX ? "exchange" : "fetched",
    applyAs: carry(aa.applyAs, prev?.applyAs), minInvestment: carry(aa.minInvestment, prev?.minInvestment), minInvestmentLots: carry(aa.minInvestmentLots, prev?.minInvestmentLots),
    contacts: carry(contactsFor(r, info, logos[r.symbol]?.domain), prev?.contacts),
    anchorSummary: anc ? { bidDate: anc.bidDate, price: anc.price, totalShares: anc.totalShares, totalAmountCr: anc.totalAmountCr } : (prev?.anchorSummary ?? null),
    bidSplit: carry(bidSplitOf(r), prev?.bidSplit), nseInfo: carry(nseInfoOf(info), prev?.nseInfo),
    anchorInvestors: null,        // the NSE anchor letters are free-form (some scanned images): the list of investors cannot be read reliably, so it is not shown
    demand: r.demand ? { asOn: r.demand.timestamp, totalBids: num(r.demand.totalBidRecieved), timesSubscribed: num(r.demand.noOfTimesIssueSubscribed), byPrice: r.demand.plotData || null } : null,
    registrar: { name: info["Name of the Registrar"] || null, address: info["Address of the Registrar"] || null, contact: info["Contact person name number and Email id"] || null },
    leadManagers: info["Book Running Lead Managers"] || null, leadManagersList: leadManagersList(r.symbol, info["Book Running Lead Managers"]), sponsorBank: info["Sponsor Bank"] || null,
    docs: { rhp: info["Red Herring Prospectus"] || null, anchor: info["Anchor Allocation Report"] || null },
    logo: logos[r.symbol]?.file || null,
    documents: await docsFor(r.symbol, r.name, info, ig, r.bse),
    anchor: ig?.anchor ?? null,
    gmp: gmpBlock(gk), subHistory: subHist[r.symbol] || [],
    listingPerf: q ? { dayOpen: q.dayOpen, ltp: q.ltp, exchange: q.exchange, listDate: q.listDate, asOf: q.asOf, dayOpenGainPct: pct(q.dayOpen, priceHigh), ltpGainPct: pct(q.ltp, priceHigh) } : null,
    checks: checks({ issueSizeCr: fullCr, lot, priceHigh, close }, ig),
    fundamentals: fund, verification: verify[r.symbol] ? { status: verify[r.symbol].status, checked: verify[r.symbol].checked, notFound: verify[r.symbol].ungrounded.length, issues: verify[r.symbol].issues, sourceDoc: verify[r.symbol].sourceDoc } : null, fetchedAt: r.fetchedAt,
  });
}

// IPOs NSE's API doesn't list (mostly upcoming / SME) come from InvestorGain's schedule
for (const [k, g] of Object.entries(gmp.current)) {
  if (matchedKeys.has(k) || !["U", "O", "CT", "C"].includes(g.igStatus)) continue;
  if (g.close && g.close < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) continue;
  const status = statusOf(g.open, g.close);
  out.push({
    symbol: "IG-" + (g.igUrl?.match(/\/(\d+)\/?$/)?.[1] || k.replace(/\W+/g, "")), name: g.name, board: boardFor(g.board || "SME", g.igLot, g.igPrice), status, open: g.open, close: g.close,
    timeline: { open: g.open, close: g.close, allotment: g.allotment, refund: g.allotment ? addWorkdays(g.allotment, 1) : null, demat: g.allotment ? addWorkdays(g.allotment, 1) : null, listing: g.listing },
    allotment: g.allotment, listing: g.listing, datesExpected: !g.listing, priceLow: null, priceHigh: g.igPrice, lot: g.igLot, faceValue: null, issueShares: null, issueSizeCr: g.igSizeCr,
    issueType: null, maxRetailAmount: null, issueDetail: null, upiCutoff: null,
    bids: { total: g.igSub != null ? { offered: null, bid: null, times: g.igSub } : null }, bidsSource: "InvestorGain (unofficial)", subsAsOn: g.igUpdated && istIso(g.igUpdated) || g.scrapedAt || null, subsAsOnSource: "fetched",
    applyAs: null, minInvestment: null, minInvestmentLots: null, contacts: null, anchorSummary: null, anchorInvestors: null, demand: null,
    registrar: { name: null, address: null, contact: null }, leadManagers: null, leadManagersList: null, sponsorBank: null, docs: {}, documents: await docsFor("IG", g.name, {}, g), anchor: g.anchor ?? null,
    gmp: gmpBlock(k), subHistory: [], listingPerf: null, checks: [], fundamentals: null, fetchedAt: g.scrapedAt, sourceNote: "Schedule from InvestorGain only (not in NSE's public API)",
  });
}

// DRHP / RHP filings that are not yet (or no longer) an open IPO -> "to be announced"
const known = out.map(i => norm(i.name));
const filingsRaw = (() => {
  const seen = new Map();                                             // one row per company: the same company can be filed twice (e.g. "(I)" and "I" in its name); the newest filing wins
  for (const f of sebi.filings || []) { const n = norm(f.company), p = seen.get(n); if (!p || String(f.date) > String(p.date)) seen.set(n, f); }
  const cutRhp = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  return [...seen.values()].filter(f => { const n = norm(f.company); return !known.some(k => k === n || k.startsWith(n + " ") || n.startsWith(k + " ")); })
    .filter(f => !f.prospectusDate && !(f.rhpDate && f.rhpDate < cutRhp));   // a final prospectus means the issue is over; an RHP older than 2 weeks without an IPO row is stale
})();
let filings = filingsRaw.map(f => { const k = findG(f.company), g = k ? gmp.current[k] : null;   // grey-market quote / dates if InvestorGain already lists it
  const lk = "F-" + String(f.company).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");   // same key logos.mjs uses
  return { ...f, gmp: g?.gmp ?? null, gmpUpdated: g?.igUpdated || null, open: g?.open || null, close: g?.close || null, logo: logos[lk]?.file || null }; });
if (!filings.length && !(sebi.filings || []).length && (prevOut.filings || []).length) { filings = prevOut.filings; console.log("build: sebi.json has no filings - kept the previous list"); }   // SEBI source failed: never blank the list

await fs.writeFile(path.join(DATA, "sub-history.json"), JSON.stringify(subHist, null, 1));
out.sort((a, b) => (b.open || "").localeCompare(a.open || ""));
await fs.writeFile(path.join(DATA, "ipos.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  sources: [
    { name: "NSE India (official): dates, price, subscription, registrar", fetchedAt: nse.map(r => r.fetchedAt).sort().pop() || null },
    { name: "RHP documents via NSE (official): financials, KPI, peers, risks", fetchedAt: null },
    { name: "SEBI public issues (official): DRHP / RHP filings", fetchedAt: sebi.fetchedAt || null },
    { name: "ipowatch.in + investorgain.com: GMP (unofficial, rumour data)", fetchedAt: gmp.fetchedAt || null },
    { name: "Yahoo Finance: post-listing prices", fetchedAt: Object.values(quotes).map(x => x.asOf).sort().pop() || null },
  ],
  ipos: out, filings,
}, null, 1));
console.log(`build: ${out.length} IPOs (${out.filter(i => i.fundamentals).length} with fundamentals, ${out.filter(i => i.gmp).length} with GMP, ${out.filter(i => i.listingPerf).length} with listing perf) + ${filings.length} SEBI filings`);
