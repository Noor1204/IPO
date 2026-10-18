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
  for (const k of ["qib", "nii", "retail", "employee"]) if (bb[k]) { so += bb[k].offered || 0; sb += bb[k].bid || 0; }
  if (bb.total && bb.total.bid > 0 && bb.total.times === 0) bad(`${i.symbol}: Total shows bids but 0.00x subscription`);                        // finished SME issues once showed 0 here
  if (bb.total && bb.total.offered > 0 && i.issueShares && bb.total.offered > i.issueShares * 1.10) bad(`${i.symbol}: shares offered (${bb.total.offered}) are more than the whole issue (${i.issueShares})`);   // catches a wrong issue size
  if (bb.total && bb.total.offered != null && so > 0) {
    const ro = bb.total.offered / so, rb = sb > 0 && bb.total.bid != null ? bb.total.bid / sb : 1;
    if (ro < 0.9 || ro > 1.1 || rb < 0.9 || rb > 1.1) bad(`${i.symbol}: Total row (${bb.total.offered} offered, ${bb.total.bid} bid) does not match the categories (${so}, ${sb})`);
  }
  for (const k of ["open", "close", "allotment", "listing"]) if (i[k] && !/^\d{4}-\d{2}-\d{2}$/.test(i[k])) bad(`${i.symbol}: bad ${k} date ${i[k]}`);
}

if (problems.length) {
  console.error(`validate: ${problems.length} problem(s) - NOT publishing`);
  for (const p of problems.slice(0, 25)) console.error(" - " + p);
  process.exit(1);
}
console.log(`validate: ok (${n} IPOs, ${nf} filings, ${scanned} text fields scanned)`);
