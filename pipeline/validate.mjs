// Sanity checks on data/ipos.json before it is committed and published. If a data source returns garbage, is hijacked or changes its format,
// the workflow stops here and the last good data stays live. Usage: node pipeline/validate.mjs [previous-ipos.json]
// Exit code 1 = do not publish.
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const problems = [];
const bad = msg => problems.push(msg);
const read = async f => JSON.parse(await fs.readFile(f, "utf8"));

const j = await read(path.join(DATA, "ipos.json")).catch(e => { bad("ipos.json missing or not valid JSON: " + e.message); return null; });
if (!j) { console.error(problems.join("\n")); process.exit(1); }
const prev = process.argv[2] ? await read(process.argv[2]).catch(() => null) : null;

// ---- one row per symbol (a repeated row once showed wrong subscription numbers)
if (Array.isArray(j.ipos)) { const seen = new Set(); for (const i of j.ipos) { if (seen.has(i.symbol)) bad(`duplicate IPO row: ${i.symbol}`); seen.add(i.symbol); } }
// ---- shape and size
if (!Array.isArray(j.ipos) || !Array.isArray(j.filings)) bad("ipos / filings are not lists");
const n = j.ipos?.length || 0, nf = j.filings?.length || 0;
if (n < 10) bad(`only ${n} IPOs (expected dozens)`);
if (prev?.ipos?.length && n < prev.ipos.length * 0.7) bad(`IPO count dropped from ${prev.ipos.length} to ${n}`);
if (prev?.filings?.length && nf < prev.filings.length * 0.5) bad(`filings count dropped from ${prev.filings.length} to ${nf}`);
const age = Date.now() - new Date(j.generatedAt).getTime();
if (!(age < 3600e3 * 6)) bad("generatedAt is missing or older than 6 hours");

// ---- no markup or scripts anywhere in the data (the app also strips them, this stops a poisoned source from being published at all)
const EVIL = /<\s*\/?\s*(script|iframe|object|embed|img|svg|link|style|meta|form)\b|javascript:|vbscript:|\bon[a-z]+\s*=\s*["']|data:text\/html/i;
let scanned = 0;
(function walk(v, p) {
  if (typeof v === "string") { scanned++; if (EVIL.test(v)) bad(`suspicious text at ${p}: ${v.slice(0, 60)}`); }
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (EVIL.test(k)) bad(`suspicious key at ${p}.${k}`); walk(x, `${p}.${k}`); }
})(j, "$");

// ---- every link must be https on a known official host (or our own logo folder)
const HOSTS = ["nseindia.com", "bseindia.com", "sebi.gov.in", "investorgain.com", "ipowatch.in"];
const okUrl = u => { if (typeof u !== "string" || !u) return true; if (/^data\/logos\/[A-Za-z0-9._-]+$/.test(u)) return true; try { const x = new URL(u); return x.protocol === "https:" && HOSTS.some(h => x.hostname === h || x.hostname.endsWith("." + h)); } catch { return false; } };
for (const i of j.ipos || []) {
  for (const d of i.documents || []) if (!okUrl(d.url)) bad(`${i.symbol}: document link not allowed: ${String(d.url).slice(0, 80)}`);
  if (i.logo && !/^data\/logos\/[A-Za-z0-9._-]+$/.test(i.logo)) bad(`${i.symbol}: logo path not allowed: ${i.logo}`);
}
for (const f of j.filings || []) { if (!okUrl(f.url)) bad(`filing ${f.company}: link not allowed: ${String(f.url).slice(0, 80)}`); if (f.logo && !/^data\/logos\/[A-Za-z0-9._-]+$/.test(f.logo)) bad(`filing ${f.company}: logo path not allowed`); }

// ---- numbers must be plausible
const num = (v, lo, hi, label, i) => { if (v == null) return; if (typeof v !== "number" || !isFinite(v) || v < lo || v > hi) bad(`${i.symbol}: ${label} out of range (${v})`); };
for (const i of j.ipos || []) {
  if (!i.symbol || !i.name) bad("an IPO has no symbol or name");
  if (!["live", "upcoming", "listed"].includes(i.status)) bad(`${i.symbol}: unknown status ${i.status}`);
  if (!["Mainboard", "SME"].includes(i.board)) bad(`${i.symbol}: unknown board ${i.board}`);
  num(i.priceHigh, 0, 100000, "price", i); num(i.priceLow, 0, 100000, "low price", i);
  if (i.priceLow && i.priceHigh && i.priceLow > i.priceHigh) bad(`${i.symbol}: price band is upside down`);
  num(i.lot, 1, 1000000, "lot", i); num(i.issueSizeCr, 0, 100000, "issue size", i);
  num(i.bids?.total?.times, 0, 10000, "subscription", i);
  if (i.gmp && i.priceHigh) num(i.gmp.value, -i.priceHigh, i.priceHigh * 5, "GMP", i);
  num(i.listingPerf?.dayOpenGainPct, -100, 2000, "listing gain", i);
  // the Total row must agree with the categories (this caught NSE's "1.404E7" being read as 1.404)
  const bb = i.bids || {}; let so = 0, sb = 0;
  for (const k of ["qib", "nii", "retail", "employee", "shareholders", "other", "marketMaker"]) if (bb[k]) { so += bb[k].offered || 0; sb += bb[k].bid || 0; }
  if (bb.total && bb.total.bid > 0 && bb.total.times === 0) bad(`${i.symbol}: Total shows bids but 0.00x subscription`);                        // finished SME issues once showed 0 here
  if (bb.total && bb.total.offered > 0 && i.issueShares && bb.total.offered > i.issueShares * 1.10) bad(`${i.symbol}: shares offered (${bb.total.offered}) are more than the whole issue (${i.issueShares})`);   // catches a wrong issue size
  if (bb.total && bb.total.offered != null && so > 0) {
    const ro = bb.total.offered / so, rb = sb > 0 && bb.total.bid != null ? bb.total.bid / sb : 1;
    if (ro < 0.9 || ro > 1.1 || rb < 0.9 || rb > 1.1) bad(`${i.symbol}: Total row (${bb.total.offered} offered, ${bb.total.bid} bid) does not match the categories (${so}, ${sb})`);
  }
  for (const k of ["open", "close", "allotment", "listing"]) if (i[k] && !/^\d{4}-\d{2}-\d{2}$/.test(i[k])) bad(`${i.symbol}: bad ${k} date ${i[k]}`);
  checkNew(i);
}

// ---- fields added later: category-wise bids, timestamps, "apply as", contacts, anchors
function checkNew(i) {
  const s = i.symbol, bb = i.bids || {}, isNum = v => typeof v === "number" && isFinite(v);
  // subscription timestamp
  if (i.subsAsOn != null) {
    const t = Date.parse(i.subsAsOn);
    if (typeof i.subsAsOn !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(i.subsAsOn) || isNaN(t)) bad(`${s}: bad subsAsOn ${i.subsAsOn}`);
    else if (t > Date.now() + 15 * 60e3) bad(`${s}: subsAsOn is in the future (${i.subsAsOn})`);
    if (!["exchange", "fetched"].includes(i.subsAsOnSource)) bad(`${s}: bad subsAsOnSource ${i.subsAsOnSource}`);
  }
  // category rows: numbers sane, times = bid / offered, categories add up to the total
  let sumBid = 0, nCat = 0;
  for (const k of ["qib", "nii", "bnii", "snii", "retail", "employee", "shareholders", "other", "marketMaker", "anchor", "total"]) {
    const c = bb[k]; if (c == null) continue;
    if (typeof c !== "object") { bad(`${s}: bids.${k} is not an object`); continue; }
    for (const f of ["offered", "bid", "times", "applications"]) if (c[f] != null && (!isNum(c[f]) || c[f] < 0 || c[f] > 1e12)) bad(`${s}: bids.${k}.${f} out of range (${c[f]})`);
    if (c.offered > 0 && c.bid != null && c.times != null && Math.abs(c.times - c.bid / c.offered) > c.bid / c.offered * 0.01 + 0.011) bad(`${s}: bids.${k}.times ${c.times} does not match bid/offered ${(c.bid / c.offered).toFixed(3)}`);
    if (["qib", "nii", "retail", "employee", "shareholders", "other"].includes(k) && c.bid != null) { sumBid += c.bid; nCat++; }
  }
  if (bb.total?.bid > 0 && bb.qib?.bid != null && bb.nii?.bid != null && bb.retail?.bid != null && Math.abs(sumBid - bb.total.bid) > bb.total.bid * 0.1) bad(`${s}: category bids (${sumBid}) do not add up to the Total (${bb.total.bid})`);
  if (bb.nii?.bid > 0 && bb.bnii?.bid != null && bb.snii?.bid != null && Math.abs(bb.bnii.bid + bb.snii.bid - bb.nii.bid) > bb.nii.bid * 0.1) bad(`${s}: bNII + sNII do not add up to NII`);
  if (bb.nii?.offered > 0 && bb.bnii?.offered != null && bb.snii?.offered != null && Math.abs(bb.bnii.offered + bb.snii.offered + (bb.nii.includesMarketMaker ? bb.marketMaker?.offered || 0 : 0) - bb.nii.offered) > bb.nii.offered * 0.02) bad(`${s}: bNII + sNII (+ market maker) offered do not add up to NII offered`);
  if (bb.marketMaker && !(bb.marketMaker.offered > 0)) bad(`${s}: market maker row without shares`);
  // apply-as
  if (i.applyAs != null) {
    if (!Array.isArray(i.applyAs) || i.applyAs.length > 6) bad(`${s}: applyAs is not a short list`);
    else for (const a of i.applyAs) {
      if (!["Regular", "Employee", "Shareholder", "HNI"].includes(a.category)) bad(`${s}: applyAs category ${a.category}`);
      for (const f of ["priceLow", "priceHigh", "maxAmount", "minAmount"]) if (a[f] != null && (!isNum(a[f]) || a[f] <= 0 || a[f] > 1e10)) bad(`${s}: applyAs ${a.category}.${f} out of range (${a[f]})`);
      if (a.priceLow != null && a.priceHigh != null && a.priceLow > a.priceHigh) bad(`${s}: applyAs ${a.category} price band upside down`);
      if (!Number.isInteger(a.lot) || a.lot < 1) bad(`${s}: applyAs ${a.category} lot ${a.lot}`);
      if (a.note != null && (typeof a.note !== "string" || a.note.length > 160)) bad(`${s}: applyAs note too long`);
      if (a.category === "Regular" && i.priceHigh && a.priceHigh !== i.priceHigh) bad(`${s}: applyAs Regular price differs from the issue price`);
      if (a.category === "Employee" && a.priceHigh != null && i.priceHigh && a.priceHigh > i.priceHigh) bad(`${s}: employee price is above the issue price`);
    }
  }
  if (i.minInvestment != null) {
    if (!isNum(i.minInvestment) || i.minInvestment <= 0 || i.minInvestment > 1e8) bad(`${s}: minInvestment out of range (${i.minInvestment})`);
    else if (!Number.isInteger(i.minInvestmentLots) || i.minInvestmentLots < 1 || i.minInvestmentLots > 100) bad(`${s}: minInvestmentLots ${i.minInvestmentLots}`);
    else if (i.lot && i.priceHigh && Math.abs(i.minInvestment - i.minInvestmentLots * i.lot * i.priceHigh) > 1) bad(`${s}: minInvestment is not lots x lot x upper price`);
  }
  // contacts
  if (i.contacts != null) {
    const c = i.contacts, EM = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/, SITE = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x.hostname) && !x.username && u.length < 200; } catch { return false; } };
    for (const [who, p] of [["company", c.company], ["registrar", c.registrar]]) {
      if (p == null) continue;
      if (typeof p !== "object") { bad(`${s}: contacts.${who} is not an object`); continue; }
      for (const [k, v] of Object.entries(p)) { if (v != null && (typeof v !== "string" || v.length > 400)) bad(`${s}: contacts.${who}.${k} is not a short string`); }
      if (p.email && !EM.test(p.email)) bad(`${s}: contacts.${who}.email looks wrong (${p.email})`);
      if (p.website && !SITE(p.website)) bad(`${s}: contacts.${who}.website looks wrong (${p.website})`);
      if (p.phone && !/^[\d+ ()\-\/.]{8,25}$/.test(p.phone)) bad(`${s}: contacts.${who}.phone looks wrong (${p.phone})`);
    }
  }
  // lead managers as a list (offer document or NSE text): short plain names, no markup
  if (i.leadManagersList != null) {
    const L = i.leadManagersList;
    if (!Array.isArray(L) || L.length < 1 || L.length > 25) bad(`${s}: leadManagersList must be 1-25 names`);
    else {
      for (const n of L) if (typeof n !== "string" || n.length < 3 || n.length > 90 || /[<>]|&lt;|&gt;|javascript:|https?:|@/i.test(n) || /^\s|\s$/.test(n)) bad(`${s}: leadManagersList name looks wrong (${String(n).slice(0, 40)})`);
      if (new Set(L.map(n => String(n).toLowerCase())).size !== L.length) bad(`${s}: leadManagersList has duplicates`);
    }
  }
  // anchors
  const an = i.anchorSummary;
  if (an != null) {
    if (!isNum(an.price) || an.price <= 0 || !Number.isInteger(an.totalShares) || an.totalShares <= 0 || !isNum(an.totalAmountCr) || an.totalAmountCr <= 0) bad(`${s}: anchorSummary has bad numbers`);
    else {
      const exp = an.totalShares * an.price / 1e7;
      if (Math.abs(exp - an.totalAmountCr) > exp * 0.01 + 0.006) bad(`${s}: anchor amount ${an.totalAmountCr} Cr does not match shares x price (${exp.toFixed(2)})`);
      if (i.priceHigh && (an.price > i.priceHigh * 1.1 || an.price < i.priceHigh * 0.7)) bad(`${s}: anchor price ${an.price} is far from the issue price ${i.priceHigh}`);   // may sit at the top of the band while the final price is lower
      if (bb.anchor && bb.anchor.offered !== an.totalShares) bad(`${s}: bids.anchor does not match anchorSummary`);
    }
    if (an.bidDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(an.bidDate)) bad(`${s}: anchor bidDate ${an.bidDate}`);
  }
  if (i.anchorInvestors != null) {
    const L = i.anchorInvestors;
    if (!Array.isArray(L) || L.length > 25) bad(`${s}: anchorInvestors must be a list of at most 25`);
    else if (L.length) {
      let sh = 0, pc = 0;
      for (const a of L) { if (typeof a.name !== "string" || !a.name || a.name.length > 160) bad(`${s}: anchor investor name`); if (!Number.isInteger(a.shares) || a.shares <= 0) bad(`${s}: anchor investor shares`); sh += a.shares || 0; pc += a.pct || 0; if (a.amountCr != null && !(a.amountCr > 0)) bad(`${s}: anchor investor amount`); }
      if (!an || Math.abs(sh - an.totalShares) > an.totalShares * 0.01) bad(`${s}: anchor investors (${sh} shares) do not reconcile with the total`);
      if (pc && Math.abs(pc - 100) > 1.5) bad(`${s}: anchor investor percentages add up to ${pc.toFixed(2)}`);
    }
  }
}
// SEBI filings: dates, types, stage
for (const f of j.filings || []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) bad(`filing ${f.company}: bad date ${f.date}`);
  else if (f.date > new Date(Date.now() + 864e5).toISOString().slice(0, 10)) bad(`filing ${f.company}: date in the future`);
  if (f.type != null && !["DRHP", "UDRHP", "Abridged", "Addendum", "Corrigendum", "RHP", "Prospectus", "Other"].includes(f.type)) bad(`filing ${f.company}: unknown type ${f.type}`);
  if (f.stage != null && !["DRHP", "UDRHP", "Abridged", "Addendum", "Corrigendum", "RHP", "Prospectus", "Other"].includes(f.stage)) bad(`filing ${f.company}: unknown stage ${f.stage}`);
  for (const k of ["rhpDate", "prospectusDate"]) if (f[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(f[k])) bad(`filing ${f.company}: bad ${k}`);
}

if (problems.length) {
  console.error(`validate: ${problems.length} problem(s) - NOT publishing`);
  for (const p of problems.slice(0, 25)) console.error(" - " + p);
  process.exit(1);
}
console.log(`validate: ok (${n} IPOs, ${nf} filings, ${scanned} text fields scanned)`);
