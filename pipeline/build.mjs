// Step 5: merge NSE data + GMP + RHP fundamentals into data/ipos.json (the only file the app reads).
// Also appends a subscription snapshot per IPO to data/sub-history.json so day-wise data builds up automatically.
import fs from "node:fs/promises";
import path from "node:path";
import { norm } from "./util.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const read = async (f, d) => JSON.parse(await fs.readFile(path.join(DATA, f), "utf8").catch(() => JSON.stringify(d)));
import { loadEntries } from "./entries.mjs";
const nse = await loadEntries();   // NSE issues + BSE-only issues
const gmp = await read("gmp.json", { current: {}, history: {} });
const subHist = await read("sub-history.json", {});

const num = s => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
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

function bids(rows) {
  const by = {}; for (const r of rows) by[String(r.srNo)] = { offered: num(r.noOfShareOffered ?? r.noOfSharesOffered), bid: num(r.noOfSharesBid), times: num(r.noOfTotalMeant ?? r.noOfTime) };
  const pick = k => by[k] && by[k].offered ? by[k] : null;
  const total = rows.find(r => /^total$/i.test(String(r.category).trim()) || /^total/i.test(String(r.srNo)));
  return { qib: pick("1"), nii: pick("2"), bnii: pick("2.1"), snii: pick("2.2"), retail: pick("3"), employee: rows.some(r => /employee/i.test(r.category)) ? by[rows.find(r => /employee/i.test(r.category)).srNo] : null,
    total: total ? { offered: num(total.noOfShareOffered ?? total.noOfSharesOffered), bid: num(total.noOfSharesBid), times: num(total.noOfTotalMeant ?? total.noOfTime) } : null };
}

const quotes = await read("quotes.json", {});
const sebi = await read("sebi.json", { filings: [], offerDocs: [] });
const verify = await read("verify.json", {});
const logos = await read("logos.json", {});
const offerFiles = await read("offer-docs.json", {});
const gkeys = Object.keys(gmp.current);
const findG = name => { const nk = norm(name); return gkeys.find(k => k === nk || (k.length > 4 && (nk.startsWith(k + " ") || k.startsWith(nk + " ")))) || null; };
const statusOf = (open, close) => close && close < today ? "listed" : open && open > today ? "upcoming" : "live";
const pct = (a, b) => (a != null && b ? Math.round((a / b - 1) * 10000) / 100 : null);
const prettyName = s => s.replace(/\b(\w)(\w*)/g, (_, a, c) => a.toUpperCase() + c.toLowerCase()).replace(/ Ltd\b/, " Limited");
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

const out = [];
for (const r of nse) {
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
  const status = statusOf(open, close);
  const fund = await fs.readFile(path.join(DATA, "fundamentals", `${r.symbol}.json`), "utf8").then(t => { try { return JSON.parse(t); } catch { return null; } }, () => null);   // tolerate a file that is mid-write
  if (b.total?.times != null && status === "live") {
    const h = (subHist[r.symbol] ||= []); const snap = { at: new Date().toISOString(), date: today, qib: b.qib?.times ?? null, bnii: b.bnii?.times ?? null, snii: b.snii?.times ?? null, nii: b.nii?.times ?? null, retail: b.retail?.times ?? null, total: b.total.times };
    const last = h[h.length - 1]; if (last?.date === today) h[h.length - 1] = snap; else h.push(snap);
  }
  const allotment = ig?.allotment || (close ? addWorkdays(close, 1) : null);
  const listing = listedOn || ig?.listing || (close ? addWorkdays(close, 3) : null);
  const q = quotes[r.symbol] || null;
  out.push({
    symbol: r.symbol, name: prettyName(r.name), board: row.series === "SME" ? "SME" : ig?.board || (Object.keys(info).length ? "Mainboard" : "SME"), status, open, close,
    // T = close. Allotment T+1, refund + demat credit T+2, listing T+3 (InvestorGain's announced dates win when available)
    timeline: { open, close, allotment, refund: allotment ? addWorkdays(allotment, 1) : null, demat: allotment ? addWorkdays(allotment, 1) : null, listing },
    allotment, listing, datesExpected: !(listedOn || ig?.listing),
    priceLow, priceHigh, lot, faceValue: num(info["Face Value"]), issueShares, issueSizeCr: fullCr ?? (issueShares && priceHigh ? Math.round(issueShares * priceHigh / 1e5) / 100 : null) ?? ig?.igSizeCr ?? null,
    issueType: info["Issue Type"] || null, maxRetailAmount: num(info["Maximum Subscription Amount for Retail Investor"]),
    issueDetail: info["Issue Size"] || null, upiCutoff: info["Cut-off time for UPI Mandate Confirmation"] || null,
    bids: b, demand: r.demand ? { asOn: r.demand.timestamp, totalBids: num(r.demand.totalBidRecieved), timesSubscribed: num(r.demand.noOfTimesIssueSubscribed), byPrice: r.demand.plotData || null } : null,
    registrar: { name: info["Name of the Registrar"] || null, address: info["Address of the Registrar"] || null, contact: info["Contact person name number and Email id"] || null },
    leadManagers: info["Book Running Lead Managers"] || null, sponsorBank: info["Sponsor Bank"] || null,
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
    symbol: "IG-" + (g.igUrl?.match(/\/(\d+)\/?$/)?.[1] || k.replace(/\W+/g, "")), name: g.name, board: g.board || "SME", status, open: g.open, close: g.close,
    timeline: { open: g.open, close: g.close, allotment: g.allotment, refund: g.allotment ? addWorkdays(g.allotment, 1) : null, demat: g.allotment ? addWorkdays(g.allotment, 1) : null, listing: g.listing },
    allotment: g.allotment, listing: g.listing, datesExpected: !g.listing, priceLow: null, priceHigh: g.igPrice, lot: g.igLot, faceValue: null, issueShares: null, issueSizeCr: g.igSizeCr,
    issueType: null, maxRetailAmount: null, issueDetail: null, upiCutoff: null,
    bids: { total: g.igSub != null ? { offered: null, bid: null, times: g.igSub } : null }, demand: null,
    registrar: { name: null, address: null, contact: null }, leadManagers: null, sponsorBank: null, docs: {}, documents: await docsFor("IG", g.name, {}, g), anchor: g.anchor ?? null,
    gmp: gmpBlock(k), subHistory: [], listingPerf: null, checks: [], fundamentals: null, fetchedAt: g.scrapedAt, sourceNote: "Schedule from InvestorGain only (not in NSE's public API)",
  });
}

// DRHP / RHP filings that are not yet (or no longer) an open IPO -> "to be announced"
const known = out.map(i => norm(i.name));
const filingsRaw = (sebi.filings || []).filter(f => { const n = norm(f.company); return !known.some(k => k === n || k.startsWith(n + " ") || n.startsWith(k + " ")); });
const filings = filingsRaw.map(f => { const k = findG(f.company), g = k ? gmp.current[k] : null;   // grey-market quote / dates if InvestorGain already lists it
  const lk = "F-" + String(f.company).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");   // same key logos.mjs uses
  return { ...f, gmp: g?.gmp ?? null, gmpUpdated: g?.igUpdated || null, open: g?.open || null, close: g?.close || null, logo: logos[lk]?.file || null }; });

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
