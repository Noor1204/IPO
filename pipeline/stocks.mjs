// Stocks module pipeline: NSE end-of-day data -> data/stocks/*
// Sources (all official NSE archive files, fetched with curl --http1.1 like fetch-nse.mjs):
//   products/content/sec_bhavdata_full_DDMMYYYY.csv   daily bhavcopy with delivery
//   content/CM_52_wk_High_low_DDMMYYYY.csv            52 week high / low (adjusted for corporate actions)
//   content/indices/ind_close_all_DDMMYYYY.csv        index OHLC, volume, closing levels
//   content/equities/EQUITY_L.csv                     company names, ISIN, listing date, face value
// Output:
//   meta.json    source, tradeDate, generatedAt, counts, known non-trading days
//   list.json    compact all-stocks array for Search
//   movers.json  precomputed top lists (gainers, losers, most active, delivery, 52w high / low)
//   index.json   index table (latest day)
//   d/<K>.json   per first-letter chunks: details of every stock + rolling close history + stats of the most traded stocks
//   h/<SYMBOL>.json   OHLCV history (260 trading days, split/bonus adjusted) of the tracked stocks, compact columns (schema below)
//   h/README.txt      the same schema documentation as text
//   idx/<slug>.json   OHLC(+volume) history of NSE indices from ind_close_all (same compact schema)
//   idx/index.json    list of the history indices: slug, name, last close, change, change %
//
// ===== Compact history schema (h/<SYMBOL>.json and idx/<slug>.json) =====
//   {"s":"RELIANCE","u":"2026-10-19","p":100,"n":260,"t":20251017,"g":[0,3,1,...],
//    "c":[...],"od":[...],"hd":[...],"ld":[...],"v":[...],"adj":[[20260312,0.5]]}
//   s   symbol (idx files: "s" = slug and "nm" = index name)       u  date of the last row (ISO)       n  row count
//   p   price scale: every price integer is price * p (p = 100, 1000 or 10000; 10000 when split-adjusted values need 4 decimals)
//   t   first date as YYYYMMDD int; g[i] = calendar days between row i-1 and row i (g[0] = 0)  ->  date(i) = t + sum(g[0..i])
//   c   close * p                 od  open  - close (in p units, signed)      hd  high - close (>= 0)      ld  close - low (>= 0)
//       decode:  close = c/p, open = (c+od)/p, high = (c+hd)/p, low = (c-ld)/p
//   v   volume (shares, int; split-adjusted: old volume / factor). idx files: index volume, null = not published (array omitted if never published)
//   adj stocks only, optional: detected corporate actions [[YYYYMMDD ex-date, factor]]; all prices BEFORE that date were multiplied by factor
//       (and volumes divided by it). Absent = no split / bonus detected in the window.
//   lc  idx files only: [points change, change %] of the last row as published by NSE
//   File names: the NSE symbol as is (A-Z 0-9 & _ . $ -), so the UI must use encodeURIComponent(symbol) + ".json" ("M&M" -> "M%26M.json").
// Rows are never invented: a day a symbol did not trade (or failed validation) is simply missing from the row list.
// d/<K>.json rows get one extra trailing column "stats" = [ret1w,ret1m,ret3m,ret6m,ret1y,ret3y,avgVol20,turnoverRank]
//   (returns in %, from the adjusted close history; null when the history is too short; ret3y is always null: the archive window is 260 days;
//    avgVol20 = mean of the last 20 daily volumes (adjusted); turnoverRank = rank by traded value among EQ-series stocks that day).
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
const IDX_BUDGET_MS = BUDGET_MS + 5 * 60e3;                       // the index back-fill may use 5 more minutes
const PAR = 4;
const MIN_VALUE_CR = 2;                                           // liquidity filter for the mover lists (traded value, crore rupees)
const SERIES_OK = new Set(["EQ", "BE", "BZ", "SM", "ST"]);
const IDX_REQUIRED = ["Nifty 50", "Nifty Bank", "Nifty IT", "Nifty Next 50", "Nifty Midcap 100", "Nifty Midcap 150", "Nifty Smallcap 100", "Nifty Smallcap 250",
  "Nifty Financial Services", "Nifty FMCG", "Nifty Auto", "Nifty Pharma", "Nifty Metal", "Nifty Realty", "Nifty Energy", "India VIX"];
const t0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ---------- helpers ----------
const dmy = iso => iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);
const isoOf = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoOf(new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5));
const isWeekday = iso => { const w = new Date(iso + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };
const istToday = () => isoOf(new Date(Date.now() + 19800e3));
const dInt = iso => +iso.replace(/-/g, "");
const dIso = n => { const s = String(n); return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8); };
const dayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
function addMonths(iso, n) { const d = new Date(iso + "T00:00:00Z"); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return isoOf(d); }
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
const wrote = { n: 0, same: 0 };
async function writeJson(f, obj, raw) {                           // atomic, and untouched when the content is identical (low git churn)
  await fs.mkdir(path.dirname(f), { recursive: true });
  const body = raw ? obj : JSON.stringify(obj);
  try { if ((await fs.readFile(f, "utf8")).replace(/\r\n/g, "\n") === body.replace(/\r\n/g, "\n")) { wrote.same++; return false; } } catch {}
  const tmp = f + ".tmp"; await fs.writeFile(tmp, body); await fs.rename(tmp, f); wrote.n++; return true;
}
// bars: Map(isoDate -> [open, high, low, close, volume|null]) -> compact object (see the schema at the top)
function encodeBars(bars, extra) {
  const ds = [...bars.keys()].sort(); if (!ds.length) return null;
  let p = 100;
  const isInt = (x, q) => Math.abs(x * q - Math.round(x * q)) < 1e-4;
  for (const q of [100, 1000, 10000]) { p = q; if (ds.every(d => { const b = bars.get(d); return isInt(b[0], q) && isInt(b[1], q) && isInt(b[2], q) && isInt(b[3], q); })) break; }
  const R = x => Math.round(x * p);
  const g = [], c = [], od = [], hd = [], ld = [], v = []; let prev = null, anyV = false;
  for (const d of ds) {
    const [o, h, l, cl, vol] = bars.get(d), C = R(cl);
    g.push(prev ? dayDiff(prev, d) : 0); prev = d;
    c.push(C); od.push(R(o) - C); hd.push(R(h) - C); ld.push(C - R(l));
    if (vol == null) v.push(null); else { v.push(Math.round(vol)); anyV = true; }
  }
  const out = { ...extra, u: ds[ds.length - 1], p, n: ds.length, t: dInt(ds[0]), g, c, od, hd, ld };
  if (anyV) out.v = v;
  return out;
}
function decodeBars(j) {                                          // -> {bars, adj, lc} or null when the file is not valid
  try {
    const n = j?.c?.length;
    if (!n || !(j.p > 0) || j.g.length !== n || j.od.length !== n || j.hd.length !== n || j.ld.length !== n || (j.v && j.v.length !== n)) return null;
    const bars = new Map(); let d = dIso(j.t);
    for (let i = 0; i < n; i++) {
      d = i ? addDays(d, j.g[i]) : d;
      const C = j.c[i], p = j.p;
      bars.set(d, [(C + j.od[i]) / p, (C + j.hd[i]) / p, (C - j.ld[i]) / p, C / p, j.v ? j.v[i] : null]);
    }
    return { bars, adj: (j.adj || []).map(([dd, f]) => [dIso(dd), f]), lc: j.lc || null };
  } catch { return null; }
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
const CACHE = process.env.STOCKS_CACHE || "";                     // dev only: cache raw downloads in this folder
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
// full index row set of one day: Map(normalised name -> {name,o,h,l,c,v,pts,pct}); rows with bad OHLC are dropped (counted)
function parseIdxAll(text, wantIso) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!/^Index Name/i.test(lines[0] || "")) return { error: "unexpected header" };
  const head = csvLine(lines[0]).map(h => h.toLowerCase()), ix = n => head.indexOf(n);
  const I = { name: ix("index name"), dt: ix("index date"), o: ix("open index value"), h: ix("high index value"), l: ix("low index value"), c: ix("closing index value"), pts: ix("points change"), pct: ix("change(%)"), v: ix("volume") };
  if (Object.values(I).some(v => v < 0)) return { error: "missing columns" };
  const rows = new Map(); let bad = 0, date = null;
  for (const line of lines.slice(1)) {
    const f = csvLine(line); if (f.length < head.length - 3) continue;
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(f[I.dt]); if (!m) { bad++; continue; }
    const d = `${m[3]}-${m[2]}-${m[1]}`; date = date || d; if (d !== date) { bad++; continue; }
    const o = num(f[I.o]), h = num(f[I.h]), l = num(f[I.l]), c = num(f[I.c]), v = num(f[I.v]);
    const eps = 1e-6 * (h || 1);
    if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0) || h < l - eps || o > h + eps || o < l - eps || c > h + eps || c < l - eps || (v != null && v < 0)) { bad++; continue; }
    const key = f[I.name].toLowerCase().replace(/\s+/g, " ");
    rows.set(key, { name: f[I.name], o, h, l, c, v, pts: num(f[I.pts]), pct: num(f[I.pct]) });
  }
  if (!date) return { error: "no rows" };
  if (wantIso && date !== wantIso) return { error: "file is for " + date, date };
  return { date, rows, bad };
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
// After the ex-date NSE sets the price band around the ADJUSTED previous close, so both the open and the close sit within about +-20 % of f * prev.
// A day is a corporate action only when the close or the open fell below 0.78 x prev AND both fit one ratio from the list.
const REV = [2, 3, 4, 5, 10, 20, 25, 50, 100];
function splitFactor(r) {
  const q = r.close / r.prev, qo = r.open / r.prev;
  if (Math.min(q, qo) >= 0.78) return null;
  let best = null, be = 1e9;
  for (const c of SPLITS) {
    if (Math.abs(q / c - 1) >= 0.22 || Math.abs(qo / c - 1) >= 0.25) continue;
    const e = Math.abs(Math.log(q / c)) + Math.abs(Math.log(qo / c));
    if (e < be) { be = e; best = c; }
  }
  if (best) return best;
  // consolidation (reverse split): both open and close jump to about c x prev (c integer). Needs >= +50 % at the open AND the close, which the +-20 % price band
  // makes impossible without a corporate action; IPO listing days have no older bars to adjust, so they are harmless.
  if (Math.min(q, qo) < 1.5) return null;
  for (const c of REV) {
    if (Math.abs(q / c - 1) >= 0.22 || Math.abs(qo / c - 1) >= 0.25) continue;
    const e = Math.abs(Math.log(q / c)) + Math.abs(Math.log(qo / c));
    if (e < be) { be = e; best = c; }
  }
  return best;
}

// ---------- load stored state (the h/ files are the stored OHLCV history) ----------
const meta = await readJson(path.join(OUT, "meta.json"));
const chunkKeys = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0"];
const stored = { dates: [], bars: new Map(), adj: new Map() };      // bars: sym -> Map(date -> [o,h,l,c,v]) adjusted
{
  const names = await fs.readdir(path.join(OUT, "h")).catch(() => []);
  const all = new Set();
  for (const fn of names) {
    if (!fn.endsWith(".json")) continue;
    const dec = decodeBars(await readJson(path.join(OUT, "h", fn))); if (!dec) continue;
    const sym = fn.slice(0, -5); stored.bars.set(sym, dec.bars); stored.adj.set(sym, dec.adj);
    for (const d of dec.bars.keys()) all.add(d);
  }
  stored.dates = [...all].sort();
}
const lastStored = stored.dates.length ? stored.dates[stored.dates.length - 1] : null;
const firstStored = stored.dates.length ? stored.dates[0] : null;
const noData = new Set(meta?.noData || []);                       // weekdays that returned no file (market holidays)

// ---------- index history (idx/<slug>.json) ----------
const idxSlug = name => name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
async function indexPhase(dates, today) {                          // dates: ISO trading days that should be covered (ascending)
  if (!dates.length) return;
  const idxDir = path.join(OUT, "idx");
  const meta2 = await readJson(path.join(idxDir, "index.json"));
  const st = new Map();                                            // key -> {name, bars, lc}
  for (const fn of await fs.readdir(idxDir).catch(() => [])) {
    if (!fn.endsWith(".json") || fn === "index.json") continue;
    const j = await readJson(path.join(idxDir, fn)), dec = decodeBars(j); if (!dec) continue;
    st.set(j.nm.toLowerCase().replace(/\s+/g, " "), { name: j.nm, bars: dec.bars, lc: dec.lc });
  }
  const covered = new Set(); for (const e of st.values()) for (const d of e.bars.keys()) covered.add(d);
  const idxNo = new Set(meta2?.noFile || []);
  const missing = dates.filter(d => !covered.has(d) && !idxNo.has(d)).reverse();       // newest first
  let i = 0, fails = 0, got = 0, badRows = 0; const parsed = new Map();
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (i < missing.length && Date.now() - t0 < IDX_BUDGET_MS && fails < 8) {
      const iso = missing[i++];
      const r = await getRetry(BASE + `content/indices/ind_close_all_${dmy(iso)}.csv`);
      if (r.status === 404) { idxNo.add(iso); continue; }
      if (r.status !== 200) { fails++; console.log("  index file failed", iso, r.err || r.status); continue; }
      const p = parseIdxAll(r.text, iso); if (p.error) { console.log("  index file", iso, p.error); if (p.date) idxNo.add(iso); else fails++; continue; }
      parsed.set(iso, p); got++; badRows += p.bad;
    }
  }));
  for (const iso of [...parsed.keys()].sort()) {
    const p = parsed.get(iso);
    for (const [key, x] of p.rows) {
      let e = st.get(key); if (!e) { e = { name: x.name, bars: new Map(), lc: null }; st.set(key, e); }
      e.name = x.name; e.bars.set(iso, [x.o, x.h, x.l, x.c, x.v]);
      if (iso === dates[dates.length - 1] || !e.lcDate || iso >= e.lcDate) { if (x.pts != null && x.pct != null) { e.lc = [r2(x.pts), r2(x.pct)]; e.lcDate = iso; } }
    }
  }
  const win = new Set(dates);
  for (const e of st.values()) for (const d of [...e.bars.keys()]) if (!win.has(d) && d < dates[0]) e.bars.delete(d);
  // choose the indices to publish: the required ones + every index with a valid OHLC on >= 90 % of the window days
  const need = new Set(IDX_REQUIRED.map(n => n.toLowerCase()));
  const chosen = [...st.entries()].filter(([k, e]) => e.bars.size >= 0.9 * dates.length || (need.has(k) && e.bars.size >= 20) ).sort((a, b) => a[1].name < b[1].name ? -1 : 1);
  const lastDate = dates[dates.length - 1], used = new Set(), rows = [], missingReq = IDX_REQUIRED.filter(n => !chosen.some(([k]) => k === n.toLowerCase()));
  let changed = 0;
  for (const [, e] of chosen) {
    let slug = idxSlug(e.name); if (used.has(slug)) slug += "-" + used.size; used.add(slug);
    const ds = [...e.bars.keys()].sort(), last = ds[ds.length - 1];
    let lc = e.lc;
    if (!lc || (e.lcDate && e.lcDate !== last)) { const j = ds.length > 1 ? e.bars.get(ds[ds.length - 2])[3] : null; const c = e.bars.get(last)[3]; lc = j && !e.lcDate ? [r2(c - j), r2((c - j) / j * 100)] : e.lc; }
    const obj = encodeBars(e.bars, { s: slug, nm: e.name }); if (!obj) continue;
    if (lc) obj.lc = lc;
    if (await writeJson(path.join(idxDir, slug + ".json"), obj)) changed++;
    rows.push([slug, e.name, e.bars.get(last)[3], lc ? lc[0] : null, lc ? lc[1] : null, last]);
  }
  if (rows.length) {
    const fresh = [...used].map(s => s + ".json"); fresh.push("index.json");
    for (const fn of await fs.readdir(idxDir).catch(() => [])) if (fn.endsWith(".json") && !fresh.includes(fn)) await fs.rm(path.join(idxDir, fn), { force: true });
    await writeJson(path.join(idxDir, "index.json"), { date: lastDate, from: dates[0], days: dates.length, cols: "slug,name,close,points,chgPct,lastDate", rows, noFile: [...idxNo].filter(d => d >= dates[0] && d < addDays(today, -3)).sort(), source: "NSE ind_close_all_DDMMYYYY.csv" });
    await writeJson(path.join(idxDir, "README.txt"), "Index history (NSE ind_close_all files). Same compact columns as ../h/README.txt; file idx/<slug>.json has s=slug, nm=index name, v=index volume (null when NSE publishes none), lc=[points,pct] of the last day.\nSee data/stocks/h/README.txt for the decode formula. idx/index.json lists every index: slug,name,close,points,chgPct,lastDate.\n", true);
  }
  console.log(`Index history: ${chosen.length} indices published (${changed} files changed), ${got}/${missing.length} missing days fetched, ${badRows} invalid index rows skipped${missingReq.length ? ", required but not available: " + missingReq.join(", ") : ""}`);
}

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
  if (lastStored) {
    console.log(`Stocks: no newer day than ${lastStored} published yet. Nothing to do for the stock history.`);
    await indexPhase(stored.dates.slice(-TARGET_DAYS), today);     // (no-op when the index history is complete)
  } else console.log("Stocks: could not fetch any bhavcopy (network or NSE problem). Nothing written.");
  process.exit(0);
}
const latest = [...days.keys()].sort().pop();
if (lastStored && latest < lastStored) { console.log(`Stocks: refusing to go back in time (${latest} < ${lastStored}).`); process.exit(0); }
const latestDay = days.get(latest);
if (meta && meta.counts?.eq && latestDay.rows.size < 0.7 * meta.counts.rows) { console.log(`Stocks: refusing, only ${latestDay.rows.size} rows vs ${meta.counts.rows} before.`); process.exit(0); }
if (meta?.tradeDate && latest < meta.tradeDate) { console.log(`Stocks: refusing, ${latest} is older than the published ${meta.tradeDate}.`); process.exit(0); }

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
const eqRows = [...latestDay.rows].filter(([, r]) => r.ser === "EQ").sort((a, b) => b[1].turn - a[1].turn);
const rankOf = new Map(eqRows.map(([s], i) => [s, i + 1]));
// hysteresis: a stored stock keeps its history until it falls out of the top 1.25 x TRACK (avoids history holes for stocks hovering at the cut-off)
const tracked = new Set(eqRows.slice(0, TRACK).map(([s]) => s));
for (const s of stored.bars.keys()) if (rankOf.has(s) && rankOf.get(s) <= TRACK * 1.25 && latestDay.rows.has(s)) tracked.add(s);
const series = new Map();                                          // sym -> Map(date -> [o,h,l,c,v]), adjusted
const adjLog = new Map();                                          // sym -> Map(date -> factor)
for (const s of tracked) { series.set(s, new Map(stored.bars.get(s) || [])); adjLog.set(s, new Map((stored.adj.get(s) || []))); }
let adjCount = 0;
const adjustBefore = (m, sym, date, f) => {
  for (const [d, b] of m) if (d < date) m.set(d, [r4(b[0] * f), r4(b[1] * f), r4(b[2] * f), r4(b[3] * f), b[4] == null ? null : b[4] / f]);
  if (m.size && [...m.keys()].some(d => d < date)) { adjLog.get(sym).set(date, r4(f)); adjCount++; }
};
// When NSE already adjusted the PREV_CLOSE of the row (seen for consolidations and some splits), prev / (our last close) is exactly the adjustment ratio.
const NICE = [...SPLITS, ...REV];
function eventFactor(m, d, r) {
  let ld = null; for (const k of m.keys()) if (k < d && (!ld || k > ld)) ld = k;
  if (ld) { const p = r.prev / m.get(ld)[3]; if (Math.abs(p - 1) > 0.02 && NICE.some(c => Math.abs(p / c - 1) < 0.015)) return r4(p); }
  return splitFactor(r);
}
const barOf = r => [r.open, r.high, r.low, r.close, r.qty];
const allDates = [...new Set([...stored.dates, ...[...days.keys()].filter(k => k[0] !== "B")])].sort();
// forward: days newer than the stored history, chronological, using each row's PREV_CLOSE to detect splits / bonus
{
  const fwd = [...days.keys()].filter(k => k[0] !== "B" && (lastStored ? k > lastStored : k === latest)).sort();
  for (const d of fwd) {
    const rows = days.get(d).rows;
    for (const s of tracked) {
      const r = rows.get(s), m = series.get(s); if (!r) continue;
      const f = eventFactor(m, d, r); if (f) { adjustBefore(m, s, d, f); console.log("  corporate action", s, d, "x" + r4(f)); }
      m.set(d, barOf(r));
    }
  }
  // backward: raw days older than the stored history; chain them to the stored (adjusted) boundary day
  const bnd = firstStored || latest, bRaw = firstStored ? days.get("B" + firstStored) : latestDay;
  const back = [...days.keys()].filter(k => k[0] !== "B" && k < bnd).sort();
  if (back.length && bRaw) {
    const chain = [...back, bnd];
    for (const s of tracked) {
      const have0 = series.get(s);
      if (firstStored && !have0.has(bnd)) continue;                // no stored anchor day (new entrant): cannot chain safely, skip
      const m = new Map();
      for (const d of chain) {
        const r = d === bnd ? bRaw.rows.get(s) : days.get(d).rows.get(s); if (!r) continue;
        const f = eventFactor(m, d, r);
        if (f) { adjustBeforeChain(m, d, f, s); console.log("  corporate action", s, d, "x" + r4(f)); }
        m.set(d, barOf(r));
      }
      const c = m.has(bnd) && have0.has(bnd) ? have0.get(bnd)[3] / m.get(bnd)[3] : 1;
      for (const d of back) if (m.has(d)) { const b = m.get(d); have0.set(d, [r4(b[0] * c), r4(b[1] * c), r4(b[2] * c), r4(b[3] * c), b[4] == null ? null : b[4] / c]); }
    }
  }
}
function adjustBeforeChain(m, date, f, sym) {                       // chain maps are raw until anchored; log the event under the real symbol
  let any = false;
  for (const [d, b] of m) if (d < date) { m.set(d, [r4(b[0] * f), r4(b[1] * f), r4(b[2] * f), r4(b[3] * f), b[4] == null ? null : b[4] / f]); any = true; }
  if (any) { adjLog.get(sym).set(date, r4(f)); adjCount++; }
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

// ---------- reconcile the adjustments with NSE's own adjusted 52-week high / low (they carry the date of the extreme) ----------
// NSE's file is the official value of the extreme price AFTER corporate actions, so  NSE value / our bar value  at that date is the factor we are
// missing (1 when we are right). We use it to (a) correct the ratio of a detected event (a 1:5 split that looked like 1:4, a rights issue),
// (b) add an event the bhavcopy alone cannot show (a ~20 % bonus that hides inside a normal daily move). If NSE simply did not adjust an event
// that clearly is a price cliff to a split ratio (R ~ 1/f) we keep our adjustment (a chart with a 80 % cliff is wrong) and only report it.
const scaleBefore = (m, date, f) => { for (const [d, b] of m) if (d < date) m.set(d, [r4(b[0] * f), r4(b[1] * f), r4(b[2] * f), r4(b[3] * f), b[4] == null ? null : b[4] / f]); };
const recon = { fixed: 0, added: 0, contested: [], unresolved: [] };
function constraintsOf(m, W) {
  const out = [];
  for (const [d, v, k] of [[W.hid, W.hi, 1], [W.lod, W.lo, 2]]) { const b = d && m.get(d); if (b && b[k] > 0 && v > 0) out.push({ d, R: v / b[k] }); }
  return out;
}
function reconcile(sym, W, m) {
  const ev = adjLog.get(sym), cons = constraintsOf(m, W), bad = cons.filter(c => Math.abs(c.R - 1) > 0.015);
  if (!bad.length) return;
  const R = bad[0].R, bmin = bad.map(c => c.d).sort()[0];
  if (bad.some(c => Math.abs(c.R / R - 1) > 0.01)) { recon.unresolved.push(sym + " (inconsistent)"); return; }
  const after = [...ev].filter(([d]) => d > bmin).sort();
  const backupM = new Map(m), backupE = new Map(ev);
  let msg = null;
  if (after.length === 1) {
    const [e, f] = after[0];
    if (Math.abs(R * f - 1) < 0.05) { recon.contested.push(`${sym} ${e} x${f}`); return; }          // NSE did not adjust this event: keep ours
    scaleBefore(m, e, R); ev.set(e, r4(f * R)); msg = `corrected ${e} x${f} -> x${r4(f * R)}`;
  } else if (after.length === 0 && Math.abs(R - 1) > 0.04) {
    const ds = [...m.keys()].sort(), cand = [];
    for (let i = 1; i < ds.length; i++) {
      if (ds[i] <= bmin) continue;
      const pc = m.get(ds[i - 1])[3], b = m.get(ds[i]);
      cand.push({ d: ds[i], s: Math.min(Math.abs(Math.log(b[3] / pc / R)), Math.abs(Math.log(b[0] / pc / R))) });
    }
    cand.sort((a, b) => a.s - b.s);
    if (cand.length < 2 || cand[0].s > 0.15 || cand[1].s - cand[0].s < 0.06) { recon.unresolved.push(`${sym} (R ${r4(R)}, no unique day)`); return; }
    scaleBefore(m, cand[0].d, R); ev.set(cand[0].d, r4(R)); msg = `added ${cand[0].d} x${r4(R)}`;
  } else { recon.unresolved.push(`${sym} (R ${r4(R)}, ${after.length} events)`); return; }
  if (constraintsOf(m, W).some(c => Math.abs(c.R - 1) > 0.015)) {           // the fix must satisfy every NSE data point, else undo it
    m.clear(); for (const [d, b] of backupM) m.set(d, b); ev.clear(); for (const [d, f] of backupE) ev.set(d, f);
    recon.unresolved.push(`${sym} (fix rejected)`); return;
  }
  if (msg.startsWith("added")) recon.added++; else recon.fixed++;
  console.log("  reconciled with NSE 52-week file:", sym, msg);
}
if (w52 && finalDates.length >= 200) for (const s of tracked) { const W = w52.map.get(s), m = series.get(s); if (W && m && W.hid && W.lod) reconcile(s, W, m); }
{
  let checked = 0; const left = [];
  if (w52) for (const s of tracked) {
    const W = w52.map.get(s), m = series.get(s); if (!W || !m) continue;
    const c = constraintsOf(m, W); if (!c.length) continue; checked++;
    if (c.some(x => Math.abs(x.R - 1) > 0.015)) left.push(s);
  }
  console.log(`52-week cross-check vs NSE (value at NSE's high/low date): ${checked} stocks, ${recon.fixed} ratios corrected, ${recon.added} events added, ${left.length} still differ > 1.5 %${left.length ? " (" + left.join(" ") + ")" : ""}`);
  if (recon.contested.length) console.log("  events NSE's 52-week file does not adjust (kept): " + recon.contested.join(", "));
  if (recon.unresolved.length) console.log("  not resolvable: " + recon.unresolved.join(", "));
}

// ---------- per-stock stats from the adjusted history ----------
function statsOf(sym) {
  const rank = rankOf.get(sym) ?? null, m = series.get(sym);
  const out = [null, null, null, null, null, null, null, rank];
  if (!m) return out;
  const ds = [...m.keys()].filter(d => keep.has(d)).sort(); if (!ds.length || ds[ds.length - 1] !== latest) return out;
  const cl = d => m.get(d)[3], cNow = cl(latest);
  const targets = [addDays(latest, -7), addMonths(latest, -1), addMonths(latest, -3), addMonths(latest, -6), addMonths(latest, -12), addMonths(latest, -36)];
  targets.forEach((tg, k) => {
    if (finalDates[0] > tg || ds[0] > tg) return;                  // the window does not reach back that far
    let ref = null; for (const d of ds) { if (d <= tg) ref = d; else break; }
    if (!ref || dayDiff(ref, tg) > 7) return;                      // reference day must be close to the target (data hole)
    out[k] = r2((cNow / cl(ref) - 1) * 100);
  });
  if (ds.length >= 20) { let s = 0; for (const d of ds.slice(-20)) s += m.get(d)[4] ?? 0; out[6] = Math.round(s / 20); }
  return out;
}

// ---------- write chunks ----------
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
  const h = hist ? finalDates.map(d => hist.get(d)?.[3] ?? null) : null;
  (chunks[key] ||= {})[sym] = [info?.name || sym, info?.isin || null, r.ser, r.open, r.high, r.low, r.prev, r.close, r.qty, r.turn, r.trades, r.dq, r.dp,
    w ? w.hi : null, w ? w.hid : null, w ? w.lo : null, w ? w.lod : null, info?.listed || null, info?.fv ?? null, h && h.some(x => x != null) ? h : null, statsOf(sym)];
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
if (meta && latest === meta.tradeDate && !older.length && days.size <= 1) {
  console.log("Stocks: already up to date (" + latest + ").");
  await indexPhase(finalDates, today); process.exit(0);
}

// OHLCV history files
const hDir = path.join(OUT, "h");
let hFiles = 0, hBad = 0;
for (const s of tracked) {
  const m = new Map([...series.get(s)].filter(([d]) => keep.has(d)));
  if (!m.size) continue;
  const adj = [...adjLog.get(s)].filter(([d]) => d > finalDates[0]).sort().map(([d, f]) => [dInt(d), f]);
  const extra = { s }; const o = encodeBars(m, extra); if (adj.length) o.adj = adj;
  if (!decodeBars(o)) { hBad++; continue; }
  await writeJson(path.join(hDir, s + ".json"), o); hFiles++;
}
for (const fn of await fs.readdir(hDir).catch(() => [])) if (fn.endsWith(".json") && !tracked.has(fn.slice(0, -5))) await fs.rm(path.join(hDir, fn), { force: true });
await writeJson(path.join(hDir, "README.txt"), `OHLCV history of the most traded NSE stocks (source: NSE sec_bhavdata_full bhavcopy), built by pipeline/stocks.mjs.
One file per stock: h/<SYMBOL>.json  (use encodeURIComponent(symbol) + ".json"; "M&M" -> "M%26M.json").
Last ${TARGET_DAYS} trading days, adjusted for splits / bonus issues.

Columns (compact, integer arrays):
  s    symbol                                  u  ISO date of the last row           n  number of rows
  p    price scale: price = integer / p        (p is 100, 1000 or 10000)
  t    first date as YYYYMMDD int              g  g[i] = calendar days between row i-1 and row i (g[0] = 0)
  c    close * p
  od   open  - close   (p units, may be negative)
  hd   high  - close   (>= 0)
  ld   close - low     (>= 0)
  v    volume in shares (adjusted: older volume divided by the split factor)
  adj  optional [[YYYYMMDD, factor], ...]: corporate action (split / bonus) ex-dates detected in the window; prices BEFORE that date were
       multiplied by factor, volumes divided by it ("adjusted for split/bonus" in the UI). Missing = nothing detected.

Decode (JavaScript):
  let d = String(j.t), dates = [];                         // YYYYMMDD
  let ms = Date.UTC(+d.slice(0,4), +d.slice(4,6)-1, +d.slice(6,8));
  for (let i = 0; i < j.n; i++) { ms += j.g[i] * 864e5; dates.push(new Date(ms)); }
  open[i] = (j.c[i] + j.od[i]) / j.p;  high[i] = (j.c[i] + j.hd[i]) / j.p;  low[i] = (j.c[i] - j.ld[i]) / j.p;  close[i] = j.c[i] / j.p;  volume[i] = j.v[i];

A day on which the stock did not trade (or a row that failed validation: non-positive price, low > open/close/high, negative volume) is simply absent.
Stocks that entered the tracked list recently have fewer rows (n < ${TARGET_DAYS}).
Per-stock summary stats (1W..1Y change %, 20-day average volume, turnover rank) are the last column of the rows in ../d/<first letter>.json:
  stats = [ret1w, ret1m, ret3m, ret6m, ret1y, ret3y, avgVol20, turnoverRank]   (ret3y is always null: the archive window is ${TARGET_DAYS} days)
Index history lives in ../idx/ (same columns, plus nm = name; v may be missing).
`, true);

await fs.mkdir(path.join(OUT, "d"), { recursive: true });
for (const k of chunkKeys) {
  const f = path.join(OUT, "d", k + ".json");
  if (chunks[k]) await writeJson(f, { tradeDate: latest, d: finalDates, f: "name,isin,series,open,high,low,prev,close,volume,valueLacs,trades,delivQty,delivPct,w52High,w52HighDate,w52Low,w52LowDate,listed,faceValue,hist,stats[ret1w,ret1m,ret3m,ret6m,ret1y,ret3y,avgVol20,turnoverRank]", s: chunks[k] });
  else await fs.rm(f, { force: true });
}
await writeJson(path.join(OUT, "list.json"), { tradeDate: latest, cols: "symbol,name,series,close,chgPct,volume,valueCr", rows: listRows.sort((a, b) => a[0] < b[0] ? -1 : 1) });
await writeJson(path.join(OUT, "movers.json"), movers);
if (idx && (!meta || idx.date >= (meta.indexDate || ""))) await writeJson(path.join(OUT, "index.json"), { date: idx.date, cols: "name,close,points,chgPct,open,high,low,pe", rows: idx.rows });
await indexPhase(finalDates, today);
const keepNo = [...noData].filter(d => d >= finalDates[0] && d < addDays(today, -3)).sort();
counts.hFiles = hFiles;
const metaOut = {
  source: "NSE India (nseindia.com) end-of-day bhavcopy with delivery, 52-week high/low file, index closing file, EQUITY_L",
  tradeDate: latest, indexDate: idx?.date || meta?.indexDate || null, w52Date: w52?.eff || null, generatedAt: new Date().toISOString(), counts, noData: keepNo,
  urls: ["products/content/sec_bhavdata_full_DDMMYYYY.csv", "content/CM_52_wk_High_low_DDMMYYYY.csv", "content/indices/ind_close_all_DDMMYYYY.csv", "content/equities/EQUITY_L.csv"].map(u => BASE + u),
};
await writeJson(path.join(OUT, "meta.json"), metaOut);
console.log(`Stocks: ${latest}  rows ${counts.rows} (EQ ${counts.eq}, dropped ${counts.dropped}), tracked ${counts.tracked}, history days ${counts.days} (${finalDates[0]} .. ${finalDates.at(-1)}), h files ${hFiles}${hBad ? " (" + hBad + " invalid)" : ""}, split adjustments ${adjCount}, newly fetched days ${days.size}, files written ${wrote.n} / unchanged ${wrote.same}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
