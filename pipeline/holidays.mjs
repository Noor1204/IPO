// Market holidays: NSE's official trading-holiday list for the Capital Market (equity) segment, the one IPOs trade in.
//   source: https://www.nseindia.com/api/holiday-master?type=trading   (what nseindia.com/resources/exchange-communication-holidays shows; needs the same cookie handshake as live.mjs / fetch-nse.mjs)
//   output: data/market/holidays.json  { year, u, rows: [{ d: "YYYY-MM-DD", day: "Mon", name, special?, session? }] }
//     u       = date (IST) the list was last fetched and changed
//     special = true when NSE marks the day with an asterisk in the name (for example "Diwali Laxmi Pujan*": a special session is held that day, timings are announced by NSE)
//     session = NSE's morning / evening session text when the list carries one (null in today's list, kept for when NSE starts to fill it)
// Weekend dates are kept (NSE lists them, for example a festival that falls on a Sunday), the app decides what to show.
// Never writes a worse file: when NSE is unreachable, answers something unexpected, or the new list is much shorter than the old one for the same year, the old file stays and the exit code is 0.
//   node pipeline/holidays.mjs
import fs from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "..", "data", "market", "holidays.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const H = { "user-agent": UA, accept: "application/json,text/plain,*/*", "accept-language": "en-US,en;q=0.9" };
const PAGE = "https://www.nseindia.com/resources/exchange-communication-holidays";
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// "15-Jan-2026" -> "2026-01-15" (null when it is not a real calendar date)
export function isoOf(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/); if (!m) return null;
  const mo = MON[m[2].toLowerCase()], d = +m[1], y = +m[3]; if (!mo || y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, mo - 1, d)); if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const dayOf = iso => DAYS[new Date(iso + "T00:00:00Z").getUTCDay()];

// the Capital Market rows of NSE's answer -> clean rows; throws on anything that looks wrong
export function parseRows(j) {
  const src = j?.CM;
  if (!Array.isArray(src) || src.length < 5) throw new Error("no usable CM list in NSE's answer");
  const rows = [], seen = new Set();
  for (const x of src) {
    const d = isoOf(x?.tradingDate); if (!d) throw new Error("bad date " + JSON.stringify(x?.tradingDate));
    const day = dayOf(d), given = String(x.weekDay || "").slice(0, 3).toLowerCase();
    if (given && given !== day.toLowerCase()) throw new Error(`${x.tradingDate} is a ${day}, NSE says ${x.weekDay}`);
    const raw = String(x.description || "").replace(/\s+/g, " ").trim(), special = /\*+$/.test(raw), name = raw.replace(/\*+$/, "").trim();
    if (name.length < 3 || name.length > 80 || /[<>{}]/.test(name)) throw new Error("bad name for " + d + ": " + raw.slice(0, 40));
    if (seen.has(d)) continue; seen.add(d);
    const sess = [x.morning_session, x.evening_session].map(s => String(s || "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" / ");
    rows.push({ d, day, name, ...(special ? { special: true } : {}), ...(sess ? { session: sess.slice(0, 60) } : {}) });
  }
  rows.sort((a, b) => a.d.localeCompare(b.d));
  const years = new Set(rows.map(r => r.d.slice(0, 4)));
  if (years.size > 2 || rows[0].d.slice(0, 4) < String(+istDay().slice(0, 4) - 1)) throw new Error("the list is not for this year");
  return rows;
}

async function fetchList() {
  const home = await fetch(PAGE, { headers: { ...H, accept: "text/html" } });
  const cookie = (home.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("no cookies from " + PAGE + " (HTTP " + home.status + ")");
  const r = await fetch("https://www.nseindia.com/api/holiday-master?type=trading", { headers: { ...H, cookie, referer: PAGE } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return JSON.parse(await r.text());
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  let old = null; try { old = JSON.parse(await fs.readFile(OUT, "utf8")); } catch {}
  let rows = null;
  for (let k = 0; k < 3 && !rows; k++) {
    try { rows = parseRows(await fetchList()); } catch (e) { console.log(`holidays: attempt ${k + 1} failed: ${e.message}`); await sleep(2000); }
  }
  if (!rows) { console.log("holidays: NSE list not available, old file kept" + (old ? ` (${old.rows?.length} rows, fetched ${old.u})` : " (there is none yet)")); process.exit(0); }
  const year = +rows[0].d.slice(0, 4), cur = String(year);
  const oldSame = (old?.rows || []).filter(r => r.d.startsWith(cur));
  if (oldSame.length >= 5 && rows.filter(r => r.d.startsWith(cur)).length < oldSame.length * 0.7) { console.log(`holidays: new list for ${year} has ${rows.length} rows, old had ${oldSame.length}: looks wrong, old file kept`); process.exit(0); }
  const same = old && JSON.stringify(old.rows) === JSON.stringify(rows);
  const age = old?.u ? (Date.now() - new Date(old.u + "T00:00:00+05:30").getTime()) / 864e5 : 99;
  if (same && age < 7) { console.log(`holidays: ${rows.length} rows, unchanged (fetched ${old.u})`); process.exit(0); }   // idempotent: no commit every hour
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `{"year":${year},"u":"${istDay()}","rows":[\n${rows.map(r => " " + JSON.stringify(r)).join(",\n")}\n]}\n`);   // one row per line: small diffs
  console.log(`holidays: ${rows.length} rows written (${rows[0].d} to ${rows[rows.length - 1].d})${same ? " (unchanged, refreshed date)" : ""}`);
}
