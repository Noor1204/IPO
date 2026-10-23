// Step 1: pull live IPO data from NSE's public JSON endpoints and download RHP documents.
// Output: data/nse.json, data/docs/rhp_<SYMBOL>.zip
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const H = { "user-agent": UA, accept: "application/json,text/plain,*/*", "accept-language": "en-US,en;q=0.9" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAST_LIMIT = Number(process.env.PAST_LIMIT || 16);

const home = await fetch("https://www.nseindia.com/market-data/all-upcoming-issues-ipo", { headers: { ...H, accept: "text/html" } });
const cookie = (home.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");

async function api(u, tries = 3) {
  for (let k = 0; k < tries; k++) {
    try {
      const r = await fetch("https://www.nseindia.com/api/" + u, { headers: { ...H, cookie, referer: "https://www.nseindia.com/" } });
      if (r.ok) return JSON.parse(await r.text());
    } catch {}
    await sleep(1500);
  }
  return null;
}

// nsearchives rejects Node's HTTP/2 client, curl over HTTP/1.1 works.
function download(url, file) {
  execFileSync("curl", ["-sS", "-L", "--proto", "=https", "--proto-redir", "=https", "--max-filesize", "150000000", "--http1.1", "--ssl-no-revoke", "--fail", "-m", "240", "-A", UA, "-e", "https://www.nseindia.com/", "-o", file, url], { stdio: "pipe" });
}

const current = (await api("ipo-current-issue")) || [];
const upcoming = (await api("all-upcoming-issues?category=ipo")) || [];
const past = (await api("public-past-issues")) || [];
console.log(`NSE: ${current.length} live, ${upcoming.length} upcoming, ${past.length} past`);

if (!current.length && !upcoming.length && !past.length) { console.log("NSE unreachable (all three lists empty): nse.json left unchanged"); process.exit(0); }   // never blank the data because of an outage
const symbols = new Map();
for (const c of current) if (!symbols.has(c.symbol)) symbols.set(c.symbol, { symbol: c.symbol, name: c.companyName, bucket: "live" });
for (const c of upcoming) if (c.symbol && !symbols.has(c.symbol)) symbols.set(c.symbol, { symbol: c.symbol, name: c.companyName, bucket: "upcoming", row: c });
for (const c of past.slice(0, PAST_LIMIT)) if (c.symbol && !symbols.has(c.symbol)) symbols.set(c.symbol, { symbol: c.symbol, name: c.company, bucket: "listed", row: c });

await fs.mkdir(path.join(DATA, "docs"), { recursive: true });
const result = [];
const histFile = path.join(DATA, "nse-history.json");
const readJson = async f => JSON.parse(await fs.readFile(f, "utf8"));
let history = {};
try { history = await readJson(histFile); }
catch { try { history = Object.fromEntries((await readJson(path.join(DATA, "nse-history.seed.json"))).filter(r => Object.keys(r.info || {}).length).map(r => [r.symbol, r])); } catch {} }   // first run: seed from an older nse.json
const toInfo = detail => { const info = {}; for (const r of detail?.issueInfo?.dataList || []) if (r.title) info[r.title.trim()] = String(r.value ?? "").replace(/^"|"$/g, "").replace(/\s+/g, " ").trim(); return info; };
for (const k of [...symbols.keys()]) if (!/^[A-Z0-9&_.$-]{1,20}$/.test(String(k))) { console.log("skipping an unsafe symbol:", String(k).slice(0, 30)); symbols.delete(k); }   // symbols become file names
for (const s of symbols.values()) {
  const rowOf = s.row || current.find(c => c.symbol === s.symbol) || upcoming.find(c => c.symbol === s.symbol) || null;
  // NSE Emerge (SME) issues only return their full detail (registrar, lead manager, prospectus, ...) with series=SME
  const first = /SME|^SM$/i.test(rowOf?.series || rowOf?.securityType || "") ? "SME" : "EQ";
  const tries = s.bucket === "listed" ? 1 : 3;                  // closed issues often have no detail any more: don't hammer NSE
  const hh = history[s.symbol], needBd = hh && /SME/i.test(rowOf?.securityType || rowOf?.series || "") && !hh.bidDetails?.length && !hh.bidDetailsTried;   // finished SME: category-wise bids (bidDetails) were not stored by older runs
  if (s.bucket === "listed" && hh?.info && Object.keys(hh.info).length && !needBd) {
    result.push({ ...s, row: rowOf, info: hh.info, bids: hh.bids || [], bidDetails: hh.bidDetails || [], bidsAsOn: hh.bidsAsOn || null, demand: hh.demand || null, fetchedAt: hh.fetchedAt, infoFrom: hh.savedAt });
    console.log(s.bucket.padEnd(9), s.symbol.padEnd(12), "kept from history");
    continue;
  }
  let detail = await api(`ipo-detail?symbol=${s.symbol}&series=${first}`, tries);
  let info = toInfo(detail);
  if (!Object.keys(info).length) { const alt = first === "EQ" ? "SME" : "EQ"; const d2 = await api(`ipo-detail?symbol=${s.symbol}&series=${alt}`, tries); if (Object.keys(toInfo(d2)).length) { detail = d2; info = toInfo(d2); } }
  await sleep(s.bucket === "listed" ? 150 : 600);
  result.push({
    ...s,
    row: rowOf,
    info,
    bids: detail?.activeCat?.dataList || detail?.bidDetails || [],
    // category-wise bids as NSE publishes them for SME issues (shares bid + number of applications; includes the Retail row that activeCat lacks)
    bidDetails: (detail?.bidDetails || []).filter(b => b && b.category && b.noOfshareBid != null).map(b => ({ srNo: b.srNo ?? null, category: String(b.category).replace(/\s+/g, " ").trim(), shares: b.noOfshareBid, applications: b.noofapplication ?? null })),
    bidsAsOn: detail?.activeCat?.updateTime || detail?.demandGraphALL?.timestamp || null,
    demand: detail?.demandGraphALL || detail?.demandGraph || null,
    fetchedAt: new Date().toISOString(),
  });
  console.log(s.bucket.padEnd(9), s.symbol.padEnd(12), Object.keys(info).length ? `${Object.keys(info).length} fields` : "no detail (SME/closed)");
}
// NSE removes an issue's detail (registrar, lead managers, document links, subscription tables) some days after listing and trims
// its "past issues" list. Keep the last good copy per symbol in data/nse-history.json so that data doesn't vanish from the app.
const KEEP_HISTORY_DAYS = 90;
for (const r of result) {
  if (Object.keys(r.info).length) {
    const old = history[r.symbol]; history[r.symbol] = { ...r, savedAt: new Date().toISOString() };
    if (!r.bidDetails?.length) { history[r.symbol].bidDetails = r.bidDetails = old?.bidDetails || []; history[r.symbol].bidDetailsTried = true; if (!r.bidsAsOn) history[r.symbol].bidsAsOn = r.bidsAsOn = old?.bidsAsOn || null; }   // a failed fetch never blanks what we had
  }
  else if (history[r.symbol]) { const h = history[r.symbol]; r.info = h.info; if (!r.bids?.length) r.bids = h.bids; if (!r.bidDetails?.length) { r.bidDetails = h.bidDetails || []; r.bidsAsOn ||= h.bidsAsOn || null; } r.demand ||= h.demand; r.infoFrom = h.savedAt; }
}
const have = new Set(result.map(r => r.symbol));
for (const [sym, h] of Object.entries(history)) {
  const closeStr = String(h.info?.["Issue Period"] || "").split(/\s+to\s+/)[1], c = closeStr ? new Date(closeStr.replace(/-/g, " ")) : null;
  if (c && Date.now() - c > KEEP_HISTORY_DAYS * 864e5) { delete history[sym]; continue; }
  if (!have.has(sym)) {                                                                  // fell off NSE's lists but still recent
    if (/SME/i.test(h.row?.securityType || h.row?.series || "") && !h.bidDetails?.length && !h.bidDetailsTried) {   // finished SME: try once to add the category-wise bids
      const d = await api(`ipo-detail?symbol=${sym}&series=SME`, 1); await sleep(150);
      const bd = (d?.bidDetails || []).filter(b => b && b.category && b.noOfshareBid != null).map(b => ({ srNo: b.srNo ?? null, category: String(b.category).replace(/\s+/g, " ").trim(), shares: b.noOfshareBid, applications: b.noofapplication ?? null }));
      h.bidDetailsTried = true; if (bd.length) { h.bidDetails = bd; h.bidsAsOn = d?.activeCat?.updateTime || h.bidsAsOn || null; }
    }
    result.push({ ...h, bucket: "listed", infoFrom: h.savedAt });
  }
}
await fs.writeFile(histFile, JSON.stringify(history, null, 1));
await fs.writeFile(path.join(DATA, "nse.json"), JSON.stringify(result, null, 1));

// Documents NSE publishes for each issue. RHP is downloaded for every IPO (needed for fundamentals);
// the other files are only downloaded for recent IPOs because they are hosted inside the app (see docs.mjs).
const DOC_KEYS = [["Red Herring Prospectus", "rhp", false], ["Ratios / Basis of Issue Price", "ratios", true], ["Anchor Allocation Report", "anchor", true],
  ["Security Parameters", "security", true], ["Security Parameters (Pre Anchor)", "preanchor", true], ["Security Parameters (Post Anchor)", "postanchor", true], ["Bidding Centers", "bidding", true], ["Sample Application Forms", "forms", true]];
const KEEP_DAYS = 21;
const closeOf = r => { const m = String(r.info?.["Issue Period"] || "").split(/\s+to\s+/)[1] || r.row?.issueEndDate || r.row?.ipoEndDate; const d = m ? new Date(m.replace(/-/g, " ")) : null; return d && !isNaN(d) ? d : null; };
const isRecent = r => { const c = closeOf(r); return !c || (Date.now() - c) / 864e5 <= KEEP_DAYS; };

for (const r of process.env.SKIP_DOCS || process.argv.includes("--no-docs") ? [] : result) {   // SKIP_DOCS=1 for the fast hourly refresh (no downloads)
  for (const [title, key, recentOnly] of DOC_KEYS) {
    const url = r.info[title];
    if (!/^https?:/.test(url || "") || (recentOnly && !isRecent(r))) continue;
    if (process.env.FUND_ONLY && (key !== "rhp" || (await fs.access(path.join(DATA, "fundamentals", `${r.symbol}.json`)).then(() => true, () => false)))) continue;
    const f = path.join(DATA, "docs", `${key}_${r.symbol}.zip`);
    try { await fs.access(f); continue; } catch {}
    try { download(url, f); console.log("downloaded", path.basename(f)); } catch (e) { console.log("download failed", key, r.symbol, e.message.split("\n")[0]); await fs.rm(f, { force: true }); }
    await sleep(500);
  }
}
