// Step 3: GMP (unofficial / rumour data) from two independent sources, plus schedule info from InvestorGain.
// Output: data/gmp.json  { current: {normName: {...}}, history: {normName: [{date,gmp}]}, fetchedAt }
import fs from "node:fs/promises";
import path from "node:path";
import { norm } from "./util.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const dec = s => s.replace(/&#8377;/g, "₹").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#128293;/g, "🔥").replace(/&nbsp;|&#160;/g, " ");
const strip = h => dec(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const num = s => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const year = new Date().getFullYear();
// "30-Sep" -> 2026-09-30 (year inferred; if more than 6 months in the past assume next year)
const dm = s => { const m = String(s || "").match(/(\d{1,2})-([A-Za-z]{3})/); if (!m) return null; let y = year; const d = new Date(y, MON[m[2].toLowerCase()] - 1, +m[1]); if (d < new Date(Date.now() - 180 * 864e5)) y++; return `${y}-${String(MON[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`; };

const prev = JSON.parse(await fs.readFile(path.join(DATA, "gmp.json"), "utf8").catch(() => "{}"));
const history = prev.history || {};
const cur = {};   // key -> merged record
const today = new Date().toISOString().slice(0, 10);
const slot = key => (cur[key] ||= { sources: [] });

// ---- source 1: ipowatch.in
try {
  let html = ""; for (let k = 0; k < 2 && !html; k++) { try { html = await (await fetch("https://ipowatch.in/ipo-grey-market-premium-latest-ipo-gmp/", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(25000) })).text(); } catch (e) { if (k) throw e; } }
  // two tables (mainboard, SME): Company (with a status word at the end), GMP, Trend, Price Band, Est. Gain, Date. Read by the header names, so a changed column order is noticed.
  let n = 0;
  for (const table of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/g) || []).map(row => (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(strip));
    const head = (rows[0] || []).map(h => h.toLowerCase()), iName = head.findIndex(h => h.startsWith("company")), iGmp = head.findIndex(h => h.startsWith("gmp")), iDate = head.findIndex(h => h.startsWith("date"));
    if (iName < 0 || iGmp < 0) continue;                                       // not a GMP table
    for (const c of rows.slice(1)) {
      if (c.length <= iGmp || !c[iName]) continue;
      const name = c[iName].replace(/\s+(Upcoming|Open|Closed|Listed|Allotment|Pending)$/i, "").trim();
      let v = /\d/.test(c[iGmp]) ? num(c[iGmp]) : null; if (v !== null && /-\s*₹|₹\s*-/.test(c[iGmp])) v = -Math.abs(v);
      const r = slot(norm(name)); r.name ||= name;
      if (v !== null) r.sources.push({ source: "ipowatch.in", gmp: v, updated: iDate >= 0 ? c[iDate] || null : null });
      n++;
    }
  }
  console.log(`GMP ipowatch: ${n} rows`);
} catch (e) { console.log("ipowatch failed:", e.message); }

// ---- source 2: investorgain.com (also gives schedule, rating, anchor flag and per-day GMP)
try {
  const html = await (await fetch("https://www.investorgain.com/report/live-ipo-gmp/331/", { headers: { "user-agent": UA } })).text();
  const body = html.slice(html.indexOf("<tbody"));
  let n = 0;
  for (const m of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => x[1]);
    if (tds.length < 12) continue;
    const a = tds[0].match(/<a[^>]*href="([^"]*)"[^>]*title="([^"]*)"/); if (!a) continue;
    const name = dec(a[2]).trim(), t = tds.map(strip);
    const status = (t[0].match(/(?:IPO|SME)\s+(U|O|CT|C|L)\b/) || [])[1] || null;
    const board = /SME/.test(t[0]) ? "SME" : "Mainboard";
    // "(-%)" appears while the price band is not announced yet: the GMP in rupees is still valid, only the percentage is unknown
    const g = t[1].match(/₹\s*(--|-?[\d.,]+)\s*\((-?[\d.]+|-)%\)/);
    const gmp = g && g[1] !== "--" ? num(g[1]) : null;
    const rng = t[1].match(/(-?[\d.]+)\s*↓\s*\/\s*(-?[\d.]+)\s*↑/);   // lowest / highest GMP seen so far
    const r = slot(norm(name)); r.name ||= name;
    Object.assign(r, { igStatus: status, board, igUrl: "https://www.investorgain.com" + a[1], rating: (t[2].match(/🔥/g) || []).length || null, igSub: num(t[3]), igPrice: num(t[4]) || null, igSizeCr: num(t[5]), igLot: num(t[6]),
      open: dm(t[7]), close: dm(t[8]), allotment: dm(t[9]), listing: dm(t[10]), igUpdated: t[11], anchor: t[12]?.includes("✅") ? true : t[12]?.includes("❌") ? false : null });
    if (g && gmp !== null) r.sources.push({ source: "investorgain.com", gmp, pct: num(g[2]), updated: t[11], ...(rng ? { seenLow: num(rng[1]), seenHigh: num(rng[2]) } : {}) });
    // per-day GMP embedded in the schedule cells ("28-Sep GMP: 33")
    for (const cell of t.slice(7, 11)) { const d = cell.match(/^(\d{1,2}-[A-Za-z]{3})\s+GMP:\s*(-?[\d.]+)/); if (d) (r.daily ||= []).push({ date: dm(d[1]), gmp: num(d[2]) }); }
    n++;
  }
  console.log(`GMP investorgain: ${n} rows`);
} catch (e) { console.log("investorgain failed:", e.message); }

// ---- same IPO under different spellings ("Nityas Gems" vs "Nityas Gems and Jewellery"): fold the shorter key into the longer one
for (const short of Object.keys(cur).sort((a, b) => a.length - b.length)) {
  const long = Object.keys(cur).find(k => k !== short && short.length > 4 && k.startsWith(short + " "));
  if (!long) continue;
  cur[long].sources.push(...cur[short].sources); cur[long].name ||= cur[short].name;
  if (history[short]) { history[long] = [...(history[long] || []), ...history[short]]; delete history[short]; }
  delete cur[short];
}

// ---- merge: average of available sources, keep range; append daily history (seeded from InvestorGain's per-day values)
for (const [k, r] of Object.entries(cur)) {
  const vals = r.sources.map(s => s.gmp);
  r.gmp = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) / 100 : null;
  r.min = vals.length ? Math.min(...vals) : null; r.max = vals.length ? Math.max(...vals) : null;
  r.scrapedAt = new Date().toISOString();
  const h = (history[k] ||= []);
  for (const d of r.daily || []) if (d.date && d.gmp !== null && !h.some(x => x.date === d.date)) h.push({ date: d.date, gmp: d.gmp });
  if (r.gmp !== null) { const i = h.findIndex(x => x.date === today); if (i >= 0) h[i].gmp = r.gmp; else h.push({ date: today, gmp: r.gmp }); }
  h.sort((a, b) => a.date.localeCompare(b.date));
  delete r.daily;
}
const ok = Object.keys(cur).length;
await fs.writeFile(path.join(DATA, "gmp.json"), JSON.stringify({ current: ok ? cur : prev.current || {}, history, fetchedAt: new Date().toISOString() }, null, 1));
console.log(`GMP merged: ${ok} IPOs`);
