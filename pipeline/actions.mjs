// NSE corporate actions (rights issues, buybacks, bonus, splits, dividends) for the IPO app's Reports tab.
// Source: NSE public JSON api/corporates-corporateActions (ex-date / record date as NSE lists them). Output: data/market/actions.json
// Safe by design: when NSE cannot be reached or returns nothing usable, the old file is left untouched.
import fs from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "..", "data", "market", "actions.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const H = { "user-agent": UA, accept: "application/json,text/plain,*/*", "accept-language": "en-US,en;q=0.9" };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const p2 = n => String(n).padStart(2, "0");
const ddmmyyyy = d => `${p2(d.getUTCDate())}-${p2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
const iso = s => { const m = String(s || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/); return m && MON[m[2].toLowerCase()] ? `${m[3]}-${p2(MON[m[2].toLowerCase()])}-${p2(m[1])}` : null; };
const kindOf = s => { const t = String(s).toLowerCase(); return /buy ?back/.test(t) ? "buyback" : /rights/.test(t) ? "rights" : /bonus/.test(t) ? "bonus" : /split|sub-division|sub division|face value/.test(t) ? "split" : /dividend/.test(t) ? "dividend" : null; };

const home = await fetch("https://www.nseindia.com/market-data/all-upcoming-issues-ipo", { headers: { ...H, accept: "text/html" } }).catch(() => null);
if (!home) { console.log("actions: NSE unreachable, file unchanged"); process.exit(0); }
const cookie = (home.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
async function api(u) {
  for (let k = 0; k < 3; k++) {
    try { const r = await fetch("https://www.nseindia.com/api/" + u, { headers: { ...H, cookie, referer: "https://www.nseindia.com/" } }); if (r.ok) { const j = JSON.parse(await r.text()); if (Array.isArray(j)) return j; } } catch {}
    await sleep(1500);
  }
  return null;
}

const now = new Date(), day = 86400000, rows = new Map(); let got = 0;
// four windows: the last 30 days and the next 90 days, in 30-day slices (NSE answers short ranges most reliably)
for (const [a, b] of [[-30, 0], [1, 30], [31, 60], [61, 90]]) {
  const j = await api(`corporates-corporateActions?index=equities&from_date=${ddmmyyyy(new Date(+now + a * day))}&to_date=${ddmmyyyy(new Date(+now + b * day))}`);
  if (!j) continue; got++;
  for (const x of j) {
    const kind = kindOf(x.subject), ex = iso(x.exDate); if (!kind || !ex || !x.symbol || !/^[A-Z0-9&-]{1,20}$/.test(x.symbol) || x.series === "GS") continue;
    const rec = { s: x.symbol, n: String(x.comp || "").trim().slice(0, 90), k: kind, t: String(x.subject).replace(/\s+/g, " ").trim().slice(0, 120), ex, rd: iso(x.recDate) };
    rows.set(`${rec.s}|${rec.k}|${rec.ex}|${rec.t}`, rec);
  }
}
if (!got) { console.log("actions: NSE returned nothing, file unchanged"); process.exit(0); }
const list = [...rows.values()].sort((a, b) => a.ex.localeCompare(b.ex) || a.s.localeCompare(b.s));
let prev = null; try { prev = JSON.parse(await fs.readFile(OUT, "utf8")); } catch {}
if (prev?.rows?.length > 20 && list.length < prev.rows.length * 0.3) { console.log(`actions: only ${list.length} rows vs ${prev.rows.length} before, file unchanged`); process.exit(0); }
const same = prev && JSON.stringify(prev.rows) === JSON.stringify(list);
if (same) { console.log("actions: no change"); process.exit(0); }
await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify({ u: now.toISOString().slice(0, 16) + "Z", source: "NSE corporate actions", rows: list }));
const c = {}; for (const r of list) c[r.k] = (c[r.k] || 0) + 1;
console.log(`actions: ${list.length} rows`, c);
