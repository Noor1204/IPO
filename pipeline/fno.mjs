// F&O module pipeline: NSE end-of-day derivatives bhavcopy (UDiFF) + lot sizes -> data/fno/*.json
// Source files (official, free, no login):
//   https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip   (all F&O contracts of the day)
//   https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv                                     (lot sizes by expiry month)
// Output: data/fno/summary.json, lots.json, u/<SYMBOL>.json (latest day, option chain), h/<SYMBOL>.json (daily history, columns), hist.json (history state)
// All OI / volume numbers are in UNITS, not lots.
// Each run: (1) walks back from today day by day, downloads the bhavcopy zips not yet in the history (cached in FNO_CACHE or the OS temp dir,
// never committed), stops after FNO_BUDGET_MIN minutes (default 9) and continues next run; (2) rebuilds summary/u from the newest day.
// Safe: network failure or a suspicious file keeps the old data and exits 0. Idempotent: nothing new published -> nothing written (FORCE=1 rebuilds summary/u).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const OUT = path.resolve(import.meta.dirname, "..", "data", "fno");
const UDIR = path.join(OUT, "u"), HDIR = path.join(OUT, "h");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://nsearchives.nseindia.com/content/fo/";
const HIST = Math.max(5, Number(process.env.FNO_HIST_DAYS) || 90);            // trading days of history kept per underlying
const BUDGET_MS = (Number(process.env.FNO_BUDGET_MIN) || 9) * 60e3;
const CACHE = process.env.FNO_CACHE || path.join(os.tmpdir(), "trendy-fno-cache");
const t0 = Date.now();
const log = (...a) => console.log("[fno]", ...a);

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const fname = s => s.replace(/[^A-Za-z0-9-]/g, c => "_" + c.charCodeAt(0).toString(16));
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const dInt = iso => Number(iso.replaceAll("-", ""));
const dIso = n => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`; };

// returns "ok" | "404" | "err"
function curl(url, file, tries = 2) {
  let last = "err";
  for (let k = 0; k < tries; k++) {
    try { execFileSync("curl", ["-sS", "-L", "--http1.1", "--fail", "-m", "180", "-A", UA, "-e", "https://www.nseindia.com/", "-o", file, url], { stdio: "pipe" }); return "ok"; }
    catch (e) { if (/\b404\b/.test(String(e.stderr || e.message))) return "404"; last = "err"; }
  }
  return last;
}

// minimal single-file zip reader (central directory + raw inflate); no external tools needed on Windows or Ubuntu
function unzipFirst(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const cd = buf.readUInt32LE(e + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("bad central directory");
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

const num = s => { if (s === undefined || s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const r2 = x => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const r3 = x => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);
const pct = (a, b) => (b > 0 ? r2((a / b) * 100) : null);

// ---------- parse one day ----------
function parseDay(csvText, tradeDate) {
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const hdr = lines[0].split(",").map(s => s.trim()), ix = n => { const i = hdr.indexOf(n); if (i < 0) throw new Error("missing column " + n); return i; };
  const C = Object.fromEntries(["TradDt", "FinInstrmTp", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "OpnPric", "HghPric", "LwPric", "ClsPric", "LastPric", "PrvsClsgPric", "UndrlygPric", "SttlmPric", "OpnIntrst", "ChngInOpnIntrst", "TtlTradgVol", "TtlTrfVal", "NewBrdLotQty"].map(n => [n, ix(n)]));
  const und = new Map();   // symbol -> { type, spot, lot, exp: Map(expiry -> {fut, opts: Map(strike -> {CE,PE})}) }
  let contracts = 0, bad = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    const tp = f[C.FinInstrmTp];
    if (!["IDF", "STF", "IDO", "STO"].includes(tp)) { bad++; continue; }
    if (f[C.TradDt] !== tradeDate) { bad++; continue; }
    const sym = f[C.TckrSymb], exp = f[C.XpryDt];
    const oi = num(f[C.OpnIntrst]), doi = num(f[C.ChngInOpnIntrst]), vol = num(f[C.TtlTradgVol]), close = num(f[C.ClsPric]), last = num(f[C.LastPric]), pcl = num(f[C.PrvsClsgPric]);
    if (!sym || !/^\d{4}-\d{2}-\d{2}$/.test(exp) || oi === null || oi < 0 || vol === null || vol < 0) { bad++; continue; }
    contracts++;
    let u = und.get(sym);
    if (!u) und.set(sym, u = { type: tp[0] === "I" ? "I" : "S", spot: null, lot: null, exp: new Map() });
    const sp = num(f[C.UndrlygPric]); if (sp > 0) u.spot = sp;
    const lot = num(f[C.NewBrdLotQty]); if (lot > 0) u.lot = lot;
    let e = u.exp.get(exp); if (!e) u.exp.set(exp, e = { fut: null, opts: new Map() });
    if (tp.endsWith("F")) {
      const st = num(f[C.SttlmPric]);
      e.fut = { o: num(f[C.OpnPric]), h: num(f[C.HghPric]), l: num(f[C.LwPric]), c: close > 0 ? close : st, pc: pcl > 0 ? pcl : null, oi, doi: doi ?? 0, v: vol, tv: num(f[C.TtlTrfVal]) ?? 0, lot };
    } else {
      const k = num(f[C.StrkPric]), ot = f[C.OptnTp];
      if (!(k > 0) || (ot !== "CE" && ot !== "PE")) { contracts--; bad++; continue; }
      let o = e.opts.get(k); if (!o) e.opts.set(k, o = {});
      o[ot] = { oi, doi: doi ?? 0, v: vol, p: last > 0 ? last : null };
    }
  }
  return { und, contracts, bad };
}
const dayLooksOk = p => p.contracts >= 5000 && p.und.size >= 50 && p.und.has("NIFTY") && p.und.has("BANKNIFTY");

function maxPain(opts) {
  const ks = [...opts.keys()].sort((a, b) => a - b);
  let best = null, bestV = Infinity;
  for (const K of ks) {          // total payout by option writers if the underlying settles at K (units x rupees); first (lowest) strike wins a tie
    let v = 0;
    for (const [k, o] of opts) { if (o.CE) v += o.CE.oi * Math.max(0, K - k); if (o.PE) v += o.PE.oi * Math.max(0, k - K); }
    if (v < bestV) { bestV = v; best = K; }
  }
  return best;
}
function optStats(e) {
  let coi = 0, poi = 0, hc = null, hp = null, hcV = -1, hpV = -1;
  for (const k of [...e.opts.keys()].sort((a, b) => a - b)) {
    const o = e.opts.get(k);
    if (o.CE) { coi += o.CE.oi; if (o.CE.oi > hcV) { hcV = o.CE.oi; hc = k; } }
    if (o.PE) { poi += o.PE.oi; if (o.PE.oi > hpV) { hpV = o.PE.oi; hp = k; } }
  }
  return { coi, poi, pcr: coi > 0 ? r3(poi / coi) : null, mp: e.opts.size ? maxPain(e.opts) : null, hc: hcV > 0 ? hc : null, hp: hpV > 0 ? hp : null };
}

// ---------- history record of one underlying on one day ----------
const HCOLS = ["spot", "o", "h", "l", "c", "fx", "v", "vt", "oi", "doi", "coi", "poi", "pcr", "pcrn", "nx", "mp", "hc", "hp"];
let anomalies = { spot: 0, ohlc: 0, close: 0, drop: 0 };
function histRecord(u, tradeDate) {
  const exps = [...u.exp.keys()].sort();
  const futE = exps.filter(x => u.exp.get(x).fut);
  const nfE = futE.find(x => x > tradeDate) || futE[0] || null;     // an expiry that falls on the trade date is over: roll to the next one
  let o = null, h = null, l = null, c = null, v = null, fx = null;
  if (nfE) {
    const f = u.exp.get(nfE).fut; fx = dInt(nfE); v = f.v;
    c = f.c > 0 ? f.c : null;
    if (c === null && f.c !== null) anomalies.close++;
    if (f.o > 0 && f.h > 0 && f.l > 0 && f.h >= f.l && f.h >= f.o && f.h >= (c ?? 0) && f.l <= f.o && (c === null || f.l <= c)) { o = r2(f.o); h = r2(f.h); l = r2(f.l); }
    else if (f.o || f.h || f.l) anomalies.ohlc++;               // untraded contract (zeros) or inconsistent: no candle, close/settlement only
    if (c !== null) c = r2(c);
  }
  let oi = 0, doi = 0, vt = 0, coi = 0, poi = 0;
  for (const x of futE) { const f = u.exp.get(x).fut; oi += f.oi; doi += f.doi; vt += f.v; }
  for (const x of exps) { const s = optStats(u.exp.get(x)); coi += s.coi; poi += s.poi; }
  const optE = exps.filter(x => { const s = optStats(u.exp.get(x)); return s.coi + s.poi > 0; });
  const noE = optE.find(x => x > tradeDate) || optE[0] || null;
  const ns = noE ? optStats(u.exp.get(noE)) : null;
  let spot = u.spot > 0 ? r2(u.spot) : null; if (spot === null) anomalies.spot++;
  if (spot === null && c === null) { anomalies.drop++; return null; }
  const pcr = coi > 0 ? r3(poi / coi) : null;
  const rec = [spot, o, h, l, c, fx, v, futE.length ? vt : null, futE.length ? oi : null, futE.length ? doi : null, coi, poi, pcr, ns ? ns.pcr : null, noE ? dInt(noE) : null, ns ? ns.mp : null, ns ? ns.hc : null, ns ? ns.hp : null];
  if (!(rec[8] === null || rec[8] >= 0) || !(coi >= 0 && poi >= 0) || (pcr !== null && !Number.isFinite(pcr))) { anomalies.drop++; return null; }
  return rec;
}

const README = {
  what: "Daily history of one F&O underlying from the official NSE UDiFF F&O bhavcopy. Column format: every key listed in cols is an array parallel to days (oldest first). null = not available that day (e.g. untraded contract has no candle). Days on which the underlying has no contracts are absent.",
  days: "trade date as YYYYMMDD integer",
  spot: "underlying price in the bhavcopy (index level / stock cash price)",
  "o,h,l,c": "near-month futures open, high, low, close (c = settlement-based close price of the file). The near-month contract rolls to the next expiry on the expiry day itself. o/h/l are null when the contract did not trade that day or the candle was inconsistent",
  fx: "expiry (YYYYMMDD) of the near-month futures contract used for o,h,l,c,v",
  v: "near-month futures volume (units)", vt: "futures volume of all expiries (units)",
  oi: "total futures open interest, all expiries (units)", doi: "change in total futures open interest vs previous day, all expiries (units)",
  coi: "total call open interest, all expiries (units)", poi: "total put open interest, all expiries (units)",
  pcr: "put OI / call OI over all expiries (3 decimals)", pcrn: "put OI / call OI of the nearest option expiry",
  nx: "nearest option expiry (YYYYMMDD) used for pcrn, mp, hc, hp (an expiry on the trade date counts as over, same rule as the futures roll)",
  mp: "max pain strike of the nearest option expiry (strike with the lowest total payout to option writers; lowest strike wins a tie)",
  "hc,hp": "strike with the highest call OI / highest put OI in the nearest option expiry",
  roll: "dates (YYYYMMDD) on which the near-month futures contract differs from the previous day in this file",
  u: "last data date in this file (YYYYMMDD)",
  units: "OI and volume in units (quantity), not lots",
};

// ---------- history state ----------
const state0 = readJson(path.join(OUT, "hist.json"));
const processed = new Set((state0?.days || []).map(Number));
const closed = new Set((state0?.closed || []).map(Number));
const counts = { ...(state0?.contracts || {}) };
const hdata = new Map();     // sym -> Map(day -> rec)
if (state0) {
  for (const f of fs.existsSync(HDIR) ? fs.readdirSync(HDIR) : []) {
    const j = readJson(path.join(HDIR, f));
    if (!j?.s || !Array.isArray(j.days)) continue;
    const m = new Map();
    j.days.forEach((d, i) => m.set(d, HCOLS.map(c => j[c]?.[i] ?? null)));
    hdata.set(j.s, m);
  }
}
const prev = readJson(path.join(OUT, "summary.json"));
const prevDate = prev?.meta?.tradeDate || "";
const prevContracts = prev?.meta?.contracts || 0;
fs.mkdirSync(CACHE, { recursive: true });

// ---------- walk back, download, ingest ----------
const today = new Date(istDay() + "T00:00:00Z");
let summaryDay = null, summaryDone = false, newDays = 0, fetched = 0, budgetHit = false, netFail = false, count = 0;
const medianContracts = () => { const v = Object.values(counts).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 0; };
for (let back = 0; back <= HIST * 2 + 40 && count < HIST; back++) {
  const d = new Date(today.getTime() - back * 86400e3), dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const iso = d.toISOString().slice(0, 10), ymd = dInt(iso);
  if (closed.has(ymd)) continue;
  const needSummary = !summaryDone && (process.env.FORCE || !prevDate || iso > prevDate);
  if (processed.has(ymd) && !needSummary) { count++; summaryDone = true; continue; }
  if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; break; }
  const url = `${BASE}BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`, zf = path.join(CACHE, ymd + ".zip");
  let st = "ok";
  if (!fs.existsSync(zf) || fs.statSync(zf).size < 10000) { st = curl(url, zf + ".part"); if (st === "ok") fs.renameSync(zf + ".part", zf); else fs.rmSync(zf + ".part", { force: true }); fetched += st === "ok" ? 1 : 0; }
  if (st === "404") {
    const later = [...processed].some(x => x > ymd) || count > 0 || newDays > 0;      // only a weekday older than a published day can be a holiday; today may just be not published yet
    if (later) closed.add(ymd);
    log("no file for", iso, later ? "(holiday)" : "(not published yet)");
    continue;
  }
  if (st !== "ok") { log("download failed for", iso, "(network); stopping, will continue next run"); netFail = true; break; }
  let p;
  try { p = parseDay(unzipFirst(fs.readFileSync(zf)).toString("utf8"), iso); }
  catch (e) { log("bad zip/csv for", iso, e.message); fs.rmSync(zf, { force: true }); continue; }
  const med = medianContracts();
  if (!dayLooksOk(p) || (med && p.contracts < 0.7 * med)) { log(`${iso}: result looks wrong (${p.contracts} contracts, ${p.und.size} underlyings); skipped`); continue; }
  if (needSummary) { summaryDay = { iso, p, url }; summaryDone = true; }
  if (!processed.has(ymd)) {
    for (const [sym, u] of p.und) { const r = histRecord(u, iso); if (!r) continue; let m = hdata.get(sym); if (!m) hdata.set(sym, m = new Map()); m.set(ymd, r); }
    processed.add(ymd); counts[ymd] = p.contracts; newDays++;
    log(`${iso}: ${p.contracts} contracts, ${p.und.size} underlyings`);
  }
  count++; summaryDone = true;
}
const sumDay = summaryDay;
if (!newDays && !sumDay) {
  log(budgetHit ? "time budget reached with nothing new" : "nothing new to do (already up to date)", `; history days ${processed.size}`);
  process.exit(0);
}

// ---------- latest-day summary + option chains (only when a newer day arrived or FORCE) ----------
let files = null, rows = null, COLS = null, lots = null, tradeDate = null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fno-"));
if (sumDay) {
  const { p } = sumDay; tradeDate = sumDay.iso;
  const { und, contracts } = p;
  let ok = true;
  if (prevContracts && contracts < 0.7 * prevContracts) { log(`only ${contracts} contracts vs ${prevContracts} before (<70%); keeping existing summary`); ok = false; }
  if (prevDate && tradeDate < prevDate) { log("downloaded file is older than current summary; keeping existing summary"); ok = false; }
  if (ok) {
    files = new Map(); rows = [];
    for (const [sym, u] of und) {
      const exps = [...u.exp.keys()].sort();
      const outExp = [];
      for (const ex of exps) {
        const e = u.exp.get(ex);
        const st = optStats(e);
        const ch = [], oic = [];
        let cdoi = 0, pdoi = 0, atm = null, atmD = Infinity;
        for (const k of [...e.opts.keys()].sort((a, b) => a - b)) {
          const o = e.opts.get(k), ce = o.CE, pe = o.PE;
          cdoi += ce?.doi || 0; pdoi += pe?.doi || 0;
          if (u.spot > 0 && Math.abs(k - u.spot) < atmD) { atmD = Math.abs(k - u.spot); atm = k; }
          if ((ce?.oi || 0) + (pe?.oi || 0) + (ce?.v || 0) + (pe?.v || 0) === 0) continue;           // never traded, no open interest: left out to keep the file small
          ch.push([k, ce?.oi ?? null, ce?.doi ?? null, ce?.v ?? null, ce?.p ?? null, pe?.oi ?? null, pe?.doi ?? null, pe?.v ?? null, pe?.p ?? null]);
          if ((ce?.doi || 0) !== 0 || (pe?.doi || 0) !== 0) oic.push([k, ce?.doi ?? 0, pe?.doi ?? 0]);
        }
        const x = { e: ex, fut: null, ch, coi: st.coi, poi: st.poi, pcr: st.pcr, mp: st.mp, hc: st.hc, hp: st.hp, atm, cdoi, pdoi, oic };
        if (e.fut) {
          const f = e.fut, base = f.oi - f.doi;
          x.fut = { c: f.c, pc: f.pc, pcp: f.pc > 0 && f.c > 0 ? r2(((f.c - f.pc) / f.pc) * 100) : null, oi: f.oi, doi: f.doi, oip: pct(f.doi, base), v: f.v, prem: u.spot > 0 && f.c > 0 ? r2(((f.c - u.spot) / u.spot) * 100) : null };
        }
        outExp.push(x);
      }
      files.set(sym, { s: sym, t: u.type, d: tradeDate, spot: u.spot, lot: u.lot, chCols: ["strike", "callOI", "callChgOI", "callVol", "callLTP", "putOI", "putChgOI", "putVol", "putLTP"], oicCols: ["strike", "callChgOI", "putChgOI"], x: outExp });
      // summary row: futures totals across all expiries, price move from the nearest futures expiry
      const futs = outExp.filter(x => x.fut), nfx = futs.find(x => x.e > tradeDate) || futs[0], nf = nfx?.fut || null;
      let oi = 0, doi = 0, oiv = 0, vol = 0;
      for (const x of futs) { oi += x.fut.oi; doi += x.fut.doi; oiv += x.fut.oi * x.fut.c; vol += x.fut.v; }
      const no = outExp.find(x => x.e > tradeDate && x.coi + x.poi > 0) || outExp.find(x => x.coi + x.poi > 0);
      rows.push([sym, u.type, u.spot, nf?.c ?? null, nf?.pcp ?? null, oi, doi, pct(doi, oi - doi), Math.round(oiv / 1e5) / 100, vol, u.lot, nfx?.e ?? null, nf?.prem ?? null, no?.e ?? null, no?.pcr ?? null, no?.mp ?? null, no?.coi ?? null, no?.poi ?? null]);
    }
    COLS = ["s", "t", "spot", "fut", "pcp", "oi", "doi", "oip", "oiv", "vol", "lot", "fexp", "prem", "oexp", "pcr", "mp", "coi", "poi"];
    const lf = path.join(tmp, "lots.csv");
    if (curl(BASE + "fo_mktlots.csv", lf) === "ok") {
      const L = fs.readFileSync(lf, "utf8").split(/\r?\n/).filter(l => l.trim());
      const months = { I: [], S: [] }, list = [];
      let sect = "I";
      for (const ln of L) {
        const c = ln.split(",").map(s => s.trim());
        if (/^derivatives on individual/i.test(c[0])) { sect = "S"; months.S = c.slice(2).filter(Boolean); continue; }
        if (/^underlying$/i.test(c[0])) { months.I = c.slice(2).filter(Boolean); continue; }
        if (!c[1]) continue;
        list.push([c[1], c[0], sect, c.slice(2, 2 + months[sect].length).map(v => (/^\d+$/.test(v) ? Number(v) : null))]);
      }
      if (list.length > 100 && list.some(r => r[0] === "NIFTY")) lots = { meta: { source: BASE + "fo_mktlots.csv", generatedAt: new Date().toISOString(), count: list.length }, months, rows: list };
      else log("lot size file looked wrong; keeping existing lots.json");
    } else log("could not download fo_mktlots.csv; keeping existing lots.json");
  }
}

// ---------- write history ----------
const keepDays = [...processed].sort((a, b) => b - a).slice(0, HIST).sort((a, b) => a - b);
const keepSet = new Set(keepDays);
const hOut = new Map();
for (const [sym, m] of hdata) {
  const ds = [...m.keys()].filter(d => keepSet.has(d)).sort((a, b) => a - b);
  if (!ds.length) continue;
  const o = { s: sym, u: ds[ds.length - 1], readme: README, cols: HCOLS, days: ds };
  HCOLS.forEach((c, i) => { o[c] = ds.map(d => m.get(d)[i]); });
  const fx = o.fx, roll = [];
  for (let i = 1; i < ds.length; i++) if (fx[i] !== null && fx[i - 1] !== null && fx[i] !== fx[i - 1]) roll.push(ds[i]);
  o.roll = roll;
  hOut.set(sym, o);
}
if (hOut.size < 50 || !hOut.has("NIFTY") || !hOut.has("BANKNIFTY")) { log("history result looks wrong (too few underlyings); not writing"); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(0); }
fs.mkdirSync(HDIR, { recursive: true });
for (const [sym, o] of hOut) write(path.join(HDIR, fname(sym) + ".json"), o);
const hkeep = new Set([...hOut.keys()].map(s => fname(s) + ".json"));
for (const f of fs.readdirSync(HDIR)) if (!hkeep.has(f)) fs.unlinkSync(path.join(HDIR, f));
const oldest = keepDays[0];
const cnt2 = Object.fromEntries(Object.entries(counts).filter(([d]) => keepSet.has(Number(d))));
write(path.join(OUT, "hist.json"), { meta: { generatedAt: new Date().toISOString(), target: HIST, note: "state of the daily history back-fill; days = trading days ingested (YYYYMMDD), closed = weekdays with no bhavcopy (holidays)" }, u: keepDays[keepDays.length - 1], days: keepDays, closed: [...closed].filter(d => d >= oldest).sort((a, b) => a - b), contracts: cnt2 });

// ---------- write latest-day files ----------
if (files) {
  fs.mkdirSync(UDIR, { recursive: true });
  for (const [sym, o] of files) write(path.join(UDIR, fname(sym) + ".json"), o);
  const keep = new Set([...files.keys()].map(s => fname(s) + ".json"));
  for (const f of fs.readdirSync(UDIR)) if (!keep.has(f)) fs.unlinkSync(path.join(UDIR, f));
  rows.sort((a, b) => (b[8] || 0) - (a[8] || 0));
  write(path.join(OUT, "summary.json"), { meta: { source: sumDay.url, tradeDate, generatedAt: new Date().toISOString(), contracts: sumDay.p.contracts, underlyings: sumDay.p.und.size, indices: rows.filter(r => r[1] === "I").length, units: "OI and volume in units (quantity), not lots; oiv in Rs crore" }, cols: COLS, rows });
  if (lots) write(path.join(OUT, "lots.json"), lots);
}
fs.rmSync(tmp, { recursive: true, force: true });
const size = d => fs.readdirSync(d).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0);
log(`history: +${newDays} days (${fetched} downloaded), ${keepDays.length}/${HIST} kept, ${hOut.size} underlyings, ${(size(HDIR) / 1024).toFixed(0)} KB${budgetHit ? "; time budget reached, continues next run" : ""}${netFail ? "; network error, continues next run" : ""}; anomalies ${JSON.stringify(anomalies)}`);
if (files) log(`wrote ${files.size} underlying files (${(size(UDIR) / 1024).toFixed(0)} KB), summary ${(fs.statSync(path.join(OUT, "summary.json")).size / 1024).toFixed(1)} KB, lots ${lots ? lots.rows.length : "kept"} rows; trade date ${tradeDate}`);
log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
