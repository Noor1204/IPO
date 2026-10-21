// Stocks module pipeline: NSE end-of-day data -> data/stocks/*
// Sources (all official NSE archive files, fetched with curl --http1.1 like fetch-nse.mjs):
//   products/content/sec_bhavdata_full_DDMMYYYY.csv   daily bhavcopy with delivery
//   content/CM_52_wk_High_low_DDMMYYYY.csv            52 week high / low (adjusted for corporate actions)
//   content/indices/ind_close_all_DDMMYYYY.csv        index closing levels
//   content/equities/EQUITY_L.csv                     company names, ISIN, listing date, face value
// Output:
//   meta.json    source, tradeDate, generatedAt, counts, known non-trading days
//   list.json    compact all-stocks array for Search
//   movers.json  precomputed top lists (gainers, losers, most active, delivery, 52w high / low)
//   index.json   index table
//   d/<K>.json   per first-letter chunks: details of every stock + rolling close history of the most traded stocks
// Safe: never throws on network errors, never overwrites good data with a worse result.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const OUT = path.resolve(import.meta.dirname, "..", "data", "stocks");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://nsearchives.nseindia.com/";
const TARGET_DAYS = Number(process.env.STOCKS_DAYS || 260);      // trading days of history kept
const TRACK = Number(process.env.STOCKS_TRACK || 800);           // stocks (by traded value) that get a history
const BUDGET_MS = Number(process.env.STOCKS_BUDGET_MIN || 9) * 60e3;
const PAR = 4;
const MIN_VALUE_CR = 2;                                           // liquidity filter for the mover lists (traded value, crore rupees)
const SERIES_OK = new Set(["EQ", "BE", "BZ", "SM", "ST"]);
const t0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ---------- helpers ----------
const dmy = iso => iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);
const isoOf = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoOf(new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5));
const isWeekday = iso => { const w = new Date(iso + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };
const istToday = () => isoOf(new Date(Date.now() + 19800e3));
function parseDate(s) {                                           // "19-Oct-2026" -> 2026-10-19
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || "").trim()); if (!m) return null;
  const mo = MON[m[2].toLowerCase()]; if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
const num = x => { const s = String(x ?? "").trim(); if (s === "" || s === "-") return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 1e4) / 1e4;
function csvLine(line) {                                          // handles quoted fields
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim()); return out;
}
const readJson = async f => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return null; } };
async function writeJson(f, obj) {
  await fs.mkdir(path.dirname(f), { recursive: true });
  const tmp = f + ".tmp"; await fs.writeFile(tmp, JSON.stringify(obj)); await fs.rename(tmp, f);
}

// nsearchives rejects Node's HTTP/2 client: curl over HTTP/1.1 works. Returns {status, text}; status 0 = network problem.
function get(url) {
  return new Promise(resolve => {
    execFile("curl", ["-sS", "-L", "--http1.1", "--fail", "--connect-timeout", "25", "-m", "90", "-A", UA, "-e", "https://www.nseindia.com/", url],
      { maxBuffer: 64e6, encoding: "utf8" }, (err, stdout, stderr) => {
        if (!err) return resolve({ status: 200, text: stdout });
        const m = /error: (\d{3})/.exec(String(stderr)); resolve({ status: m ? +m[1] : 0, text: "", err: String(stderr).trim().slice(0, 120) });
      });
  });
}
async function getRetry(url, tries = 3) {
  const cf = CACHE ? path.join(CACHE, url.split("/").pop()) : "";
  if (cf) { try { return { status: 200, text: await fs.readFile(cf, "utf8") }; } catch {} }
  let r;
  for (let k = 0; k < tries; k++) { r = await get(url); if (r.status === 200 || r.status === 404) { if (cf && r.status === 200) { await fs.mkdir(CACHE, { recursive: true }); await fs.writeFile(cf, r.text); } return r; } await sleep(1500 * (k + 1)); }
  return r;
}

// ---------- parsers (validate every row) ----------
function parseBhav(text, wantDate) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length || !/^SYMBOL\s*,\s*SERIES/i.test(lines[0])) return { error: "unexpected header" };
  const head = csvLine(lines[0]).map(h => h.toUpperCase()), ix = n => head.indexOf(n);
  const I = { sym: ix("SYMBOL"), ser: ix("SERIES"), dt: ix("DATE1"), prev: ix("PREV_CLOSE"), open: ix("OPEN_PRICE"), high: ix("HIGH_PRICE"), low: ix("LOW_PRICE"), close: ix("CLOSE_PRICE"), qty: ix("TTL_TRD_QNTY"), turn: ix("TURNOVER_LACS"), trades: ix("NO_OF_TRADES"), dq: ix("DELIV_QTY"), dp: ix("DELIV_PER") };
  if (Object.values(I).some(v => v < 0)) return { error: "missing columns" };
  const rows = new Map(); let date = null, dropped = 0, total = 0;
  for (const line of lines.slice(1)) {
    const f = csvLine(line); if (f.length < head.length) { dropped++; continue; }
    const ser = f[I.ser]; if (!SERIES_OK.has(ser)) continue;
    total++;
    const sym = f[I.sym], d = parseDate(f[I.dt]);
    const prev = num(f[I.prev]), open = num(f[I.open]), high = num(f[I.high]), low = num(f[I.low]), close = num(f[I.close]);
    const qty = num(f[I.qty]), turn = num(f[I.turn]), trades = num(f[I.trades]);
    let dq = num(f[I.dq]), dp = num(f[I.dp]);
    if (!/^[A-Z0-9&_.$-]{1,20}$/.test(sym) || !d || !(close > 0) || !(prev > 0) || !(open > 0) || !(high > 0) || !(low > 0) || high < low - 1e-9 ||
        close > high + 1e-9 || close < low - 1e-9 || open > high + 1e-9 || open < low - 1e-9 || !(qty >= 0) || !(turn >= 0)) { dropped++; continue; }
    if (dp != null && (dp < 0 || dp > 100.01)) { dp = null; dq = null; }
    if (date && d !== date) { dropped++; continue; }
    date = d;
    const old = rows.get(sym); if (old && old.ser === "EQ") continue;   // prefer the EQ row of a symbol
    rows.set(sym, { ser, prev, open, high, low, close, qty, turn, trades: trades ?? null, dq, dp });
  }
  if (!date) return { error: "no valid rows" };
  if (wantDate && date !== wantDate) return { error: "file is for " + date, date };
  return { date, rows, dropped, total };
}
function parse52(text) {
  const lines = text.split(/\r?\n/), at = lines.findIndex(l => /^"?SYMBOL"?\s*,/i.test(l)); if (at < 0) return null;
  const m = /Effective for (\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(text); const eff = m ? parseDate(m[1]) : null;
  const map = new Map();
  for (const line of lines.slice(at + 1)) {
    const f = csvLine(line); if (f.length < 6) continue;
    const hi = num(f[2]), lo = num(f[4]); if (!(hi > 0) || !(lo > 0) || hi < lo) continue;
    const old = map.get(f[0]); if (old && f[1] !== "EQ") continue;
    map.set(f[0], { hi, hid: parseDate(f[3]), lo, lod: parseDate(f[5]) });
  }
  return { eff, map };
}
function parseIdx(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!/^Index Name/i.test(lines[0] || "")) return null;
  const rows = []; let date = null;
  for (const line of lines.slice(1)) {
    const f = csvLine(line); if (f.length < 8) continue;
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(f[1]); if (!m) continue;
    const d = `${m[3]}-${m[2]}-${m[1]}`, close = num(f[5]), pts = num(f[6]), pct = num(f[7]);
    if (!(close > 0) || pct == null || Math.abs(pct) > 40) continue;
    date = date || d; if (d !== date) continue;
    rows.push([f[0], close, pts == null ? null : r2(pts), r2(pct), num(f[2]), num(f[3]), num(f[4]), num(f[10])]);
  }
  return rows.length ? { date, rows } : null;
}
function parseEquityL(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!/^SYMBOL/i.test(lines[0] || "")) return null;
  const map = new Map();
  for (const line of lines.slice(1)) {
    const f = csvLine(line); if (f.length < 8 || !f[0]) continue;
    const ld = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(f[3]); const listed = ld ? parseDate(`${+ld[1]}-${ld[2]}-${ld[3]}`) : null;
    map.set(f[0], { name: f[1], isin: /^IN[A-Z0-9]{10}$/.test(f[6]) ? f[6] : null, listed, fv: num(f[7]) });
  }
  return map.size ? map : null;
}

// NSE's PREV_CLOSE column is NOT adjusted for splits / bonus, so a corporate action shows as a one-day price jump to a "nice" ratio.
// Exchange price bands (max 20 %) make a >22 % one-day fall on an equity stock practically always a split or bonus; we then scale the older history.
const SPLITS = [1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100, 2 / 3, 3 / 4, 4 / 5, 1 / 1.5, 1 / 1.2];
function splitFactor(r) {
  const q = r.close / r.prev;
  if (q < 0.78) { let best = null; for (const c of SPLITS) if (Math.abs(q / c - 1) < 0.12 && (!best || Math.abs(q / c - 1) < Math.abs(q / best - 1))) best = c; return best; }
  // reverse splits and IPO listing days (prev close = issue price) also jump upwards; they are not adjusted (too ambiguous)
  return null;
}
const CACHE = process.env.STOCKS_CACHE || "";                     // dev only: cache raw downloads in this folder

// ---------- load stored state ----------
const meta = await readJson(path.join(OUT, "meta.json"));
const stored = { dates: [], close: new Map() };                   // close: sym -> Map(date -> adjusted close)
const chunkKeys = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0"];
if (meta) {
  for (const k of chunkKeys) {
    const c = await readJson(path.join(OUT, "d", k + ".json")); if (!c) continue;
    if (!stored.dates.length) stored.dates = c.d;
    for (const [sym, v] of Object.entries(c.s)) {
      const h = v[v.length - 1]; if (!Array.isArray(h)) continue;
      const m = new Map(); h.forEach((x, i) => { if (x != null) m.set(c.d[i], x); }); stored.close.set(sym, m);
    }
  }
}
const lastStored = stored.dates.length ? stored.dates[stored.dates.length - 1] : null;
const firstStored = stored.dates.length ? stored.dates[0] : null;
const noData = new Set(meta?.noData || []);                       // weekdays that returned no file (market holidays)

// ---------- fetch the missing days ----------
const today = istToday();
const days = new Map();                                            // date -> parsed bhavcopy
const newNoData = new Set();
async function fetchDay(iso) {
  const r = await getRetry(BASE + `products/content/sec_bhavdata_full_${dmy(iso)}.csv`);
  if (r.status === 404) return { iso, none: true };
  if (r.status !== 200) return { iso, fail: r.err || r.status };
  const p = parseBhav(r.text, iso);
  if (p.error) return p.date ? { iso, none: true, why: p.error } : { iso, fail: p.error };
  return { iso, p };
}
async function fetchMany(list) {                                  // newest first, PAR at a time; returns when list is done or budget used
  let i = 0, fails = 0;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (i < list.length && Date.now() - t0 < BUDGET_MS && fails < 6) {
      const iso = list[i++]; const r = await fetchDay(iso);
      if (r.p) days.set(iso, r.p); else if (r.none) newNoData.add(iso); else { fails++; console.log("  fetch failed", iso, r.fail); }
    }
  }));
}
// 1. newer days (or, on the very first run, the latest trading day)
const newer = [];
for (let d = today, n = 0; n < (lastStored ? 400 : 12); d = addDays(d, -1), n++) {
  if (lastStored && d <= lastStored) break;
  if (isWeekday(d) && !(noData.has(d) && d < addDays(today, -3))) newer.push(d);
}
if (!lastStored) {                                                 // find the latest published day first
  for (const d of newer) { const r = await fetchDay(d); if (r.p) { days.set(d, r.p); break; } if (r.none) newNoData.add(d); }
} else await fetchMany(newer);
if (!days.size && lastStored && stored.dates.length < TARGET_DAYS) { const r = await fetchDay(lastStored); if (r.p) days.set(lastStored, r.p); }   // history still short: keep back-filling
if (!days.size) {
  if (lastStored) console.log(`Stocks: no newer day than ${lastStored} published yet. Nothing to do.`);
  else console.log("Stocks: could not fetch any bhavcopy (network or NSE problem). Nothing written.");
  process.exit(0);
}
const latest = [...days.keys()].sort().pop();
if (lastStored && latest < lastStored) { console.log(`Stocks: refusing to go back in time (${latest} < ${lastStored}).`); process.exit(0); }
const latestDay = days.get(latest);
if (meta && meta.counts?.eq && latestDay.rows.size < 0.7 * meta.counts.rows) { console.log(`Stocks: refusing, only ${latestDay.rows.size} rows vs ${meta.counts.rows} before.`); process.exit(0); }

// 2. older days for the history (only until TARGET_DAYS trading days are stored)
const have = () => new Set([...stored.dates, ...[...days.keys()].filter(k => k[0] !== "B")]);
const oldest = firstStored || latest;
const older = [];
const needOlder = TARGET_DAYS - have().size;
if (needOlder > 0) {
  for (let d = addDays(oldest, -1), n = 0; n < 420; d = addDays(d, -1), n++) if (isWeekday(d) && !noData.has(d)) older.push(d);
  // one boundary day (the oldest stored day, or the latest day itself on the first run) is re-fetched to line the old raw prices up with the stored adjusted ones
  const boundary = firstStored || latest;
  if (firstStored) { const r = await fetchDay(boundary); if (r.p) days.set("B" + boundary, r.p); }
  // chunked so we stop once enough trading days are known
  let idx = 0;
  while (idx < older.length && (TARGET_DAYS - have().size) > 0 && Date.now() - t0 < BUDGET_MS) {
    const batch = older.slice(idx, idx + PAR * 4); idx += batch.length;
    await fetchMany(batch);
    const got = batch.filter(d => days.has(d)).length; if (!got && batch.length && idx > 60) break;
  }
}
for (const d of newNoData) noData.add(d);

// ---------- build the tracked set and merged histories ----------
const eqRows = [...latestDay.rows].filter(([, r]) => r.ser === "EQ");
const tracked = new Set(eqRows.sort((a, b) => b[1].turn - a[1].turn).slice(0, TRACK).map(([s]) => s));
const series = new Map();                                          // sym -> Map(date -> close), adjusted
for (const s of tracked) series.set(s, new Map(stored.close.get(s) || []));
let adjCount = 0;
const adjustBefore = (m, date, f) => { for (const [d, v] of m) if (d < date) m.set(d, r4(v * f)); adjCount++; };
const allDates = [...new Set([...stored.dates, ...[...days.keys()].filter(k => k[0] !== "B")])].sort();
// forward: days newer than the stored history, chronological, using each row's PREV_CLOSE to detect splits / bonus
{
  const fwd = [...days.keys()].filter(k => k[0] !== "B" && (!lastStored || k > lastStored)).sort();
  
  for (const d of fwd) {
    const rows = days.get(d).rows;
    for (const s of tracked) {
      const r = rows.get(s), m = series.get(s); if (!r) continue;
      const f = splitFactor(r); if (f) { adjustBefore(m, d, f); console.log("  corporate action", s, d, "x" + r4(f)); }
      m.set(d, r.close);
    }
  }
  // backward: raw days older than the stored history; chain them to the stored (adjusted) boundary day
  const bnd = firstStored || latest, bRaw = firstStored ? days.get("B" + firstStored) : latestDay;
  const back = [...days.keys()].filter(k => k[0] !== "B" && k < bnd).sort();
  if (back.length && bRaw) {
    const chain = [...back, bnd], raw = new Map();
    for (const s of tracked) {
      const m = new Map();
      for (const d of chain) {
        const r = d === bnd ? bRaw.rows.get(s) : days.get(d).rows.get(s); if (!r) continue;
        const f = splitFactor(r); if (f) { adjustBefore(m, d, f); console.log("  corporate action", s, d, "x" + r4(f)); }
        m.set(d, r.close);
      }
      const have0 = series.get(s), c = m.has(bnd) && have0.has(bnd) ? have0.get(bnd) / m.get(bnd) : 1;
      for (const d of back) if (m.has(d)) have0.set(d, r4(m.get(d) * c));
    }
  }
}
const finalDates = allDates.slice(-TARGET_DAYS);
const keep = new Set(finalDates);

// ---------- extras for the latest day ----------
const [r52, rIdx, rEq] = await Promise.all([
  getRetry(BASE + `content/CM_52_wk_High_low_${dmy(latest)}.csv`),
  getRetry(BASE + `content/indices/ind_close_all_${dmy(latest)}.csv`),
  getRetry(BASE + "content/equities/EQUITY_L.csv"),
]);
const w52 = r52.status === 200 ? parse52(r52.text) : null;
const idx = rIdx.status === 200 ? parseIdx(rIdx.text) : null;
const eqL = rEq.status === 200 ? parseEquityL(rEq.text) : null;
console.log(`extras: 52wk ${w52 ? w52.map.size + " rows (eff " + w52.eff + ")" : "MISSING"}, indices ${idx ? idx.rows.length + " (" + idx.date + ")" : "MISSING"}, names ${eqL ? eqL.size : "MISSING"}`);

// ---------- write chunks ----------
const prevFiles = meta?.counts || {};
const chunks = {};
const listRows = [];
const L = [];                                                      // enriched rows for lists
for (const [sym, r] of latestDay.rows) {
  const info = eqL?.get(sym);
  let w = w52?.map.get(sym);
  if (w) { w = { ...w }; if (r.high > w.hi) { w.hi = r.high; w.hid = latest; } if (r.low < w.lo) { w.lo = r.low; w.lod = latest; } }   // the 52-week file may not include the latest day yet
  const chg = r2((r.close - r.prev) / r.prev * 100), valueCr = r2(r.turn / 100);
  const row = { sym, name: info?.name || sym, ser: r.ser, ...r, chg, valueCr, w };
  L.push(row);
  const key = /^[A-Z]/.test(sym) ? sym[0] : "0";
  const hist = series.get(sym);
  const h = hist ? finalDates.map(d => hist.get(d) ?? null) : null;
  (chunks[key] ||= {})[sym] = [info?.name || sym, info?.isin || null, r.ser, r.open, r.high, r.low, r.prev, r.close, r.qty, r.turn, r.trades, r.dq, r.dp,
    w ? w.hi : null, w ? w.hid : null, w ? w.lo : null, w ? w.lod : null, info?.listed || null, info?.fv ?? null, h && h.some(x => x != null) ? h : null];
  listRows.push([sym, info?.name || sym, r.ser, r.close, chg, r.qty, valueCr]);
}
const liquid = L.filter(x => x.ser === "EQ" && x.valueCr >= MIN_VALUE_CR);
const top = (arr, n, cmp) => arr.slice().sort(cmp).slice(0, n);
const mv = x => [x.sym, x.name, x.close, x.chg, x.valueCr, x.dp ?? null];
const near = x => x.w ? { hi: r2((x.w.hi - x.close) / x.w.hi * 100), lo: r2((x.close - x.w.lo) / x.w.lo * 100) } : null;
const hiList = top(liquid.filter(x => x.w && x.close >= x.w.hi * 0.97), 50, (a, b) => near(a).hi - near(b).hi || b.valueCr - a.valueCr).map(x => [...mv(x), near(x).hi]);
const loList = top(liquid.filter(x => x.w && x.close <= x.w.lo * 1.03), 50, (a, b) => near(a).lo - near(b).lo || b.valueCr - a.valueCr).map(x => [...mv(x), near(x).lo]);
const movers = {
  tradeDate: latest, minValueCr: MIN_VALUE_CR, cols: "symbol,name,close,chgPct,valueCr,deliveryPct[,distancePct]",
  gain: top(liquid, 50, (a, b) => b.chg - a.chg).map(mv),
  loss: top(liquid, 50, (a, b) => a.chg - b.chg).map(mv),
  active: top(L.filter(x => x.ser === "EQ"), 50, (a, b) => b.valueCr - a.valueCr).map(mv),
  deliv: top(liquid.filter(x => x.dp != null), 50, (a, b) => b.dp - a.dp || b.valueCr - a.valueCr).map(mv),
  hi: hiList, lo: loList,
};
const counts = { rows: latestDay.rows.size, eq: eqRows.length, dropped: latestDay.dropped, tracked: tracked.size, days: finalDates.length, indices: idx?.rows.length || 0, with52w: L.filter(x => x.w).length, liquid: liquid.length };
if (meta && latest === meta.tradeDate && !older.length && days.size <= 1) { console.log("Stocks: already up to date (" + latest + ")."); process.exit(0); }

await fs.mkdir(path.join(OUT, "d"), { recursive: true });
for (const k of chunkKeys) {
  const f = path.join(OUT, "d", k + ".json");
  if (chunks[k]) await writeJson(f, { tradeDate: latest, d: finalDates, f: "name,isin,series,open,high,low,prev,close,volume,valueLacs,trades,delivQty,delivPct,w52High,w52HighDate,w52Low,w52LowDate,listed,faceValue,hist", s: chunks[k] });
  else await fs.rm(f, { force: true });
}
await writeJson(path.join(OUT, "list.json"), { tradeDate: latest, cols: "symbol,name,series,close,chgPct,volume,valueCr", rows: listRows.sort((a, b) => a[0] < b[0] ? -1 : 1) });
await writeJson(path.join(OUT, "movers.json"), movers);
if (idx && (!meta || idx.date >= (meta.indexDate || ""))) await writeJson(path.join(OUT, "index.json"), { date: idx.date, cols: "name,close,points,chgPct,open,high,low,pe", rows: idx.rows });
const keepNo = [...noData].filter(d => d >= finalDates[0] && d < addDays(today, -3)).sort();
await writeJson(path.join(OUT, "meta.json"), {
  source: "NSE India (nseindia.com) end-of-day bhavcopy with delivery, 52-week high/low file, index closing file, EQUITY_L",
  tradeDate: latest, indexDate: idx?.date || meta?.indexDate || null, w52Date: w52?.eff || null, generatedAt: new Date().toISOString(), counts, noData: keepNo,
  urls: ["products/content/sec_bhavdata_full_DDMMYYYY.csv", "content/CM_52_wk_High_low_DDMMYYYY.csv", "content/indices/ind_close_all_DDMMYYYY.csv", "content/equities/EQUITY_L.csv"].map(u => BASE + u),
});
console.log(`Stocks: ${latest}  rows ${counts.rows} (EQ ${counts.eq}, dropped ${counts.dropped}), tracked ${counts.tracked}, history days ${counts.days} (${finalDates[0]} .. ${finalDates.at(-1)}), split adjustments ${adjCount}, newly fetched days ${days.size}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
