// F&O module pipeline: NSE end-of-day derivatives bhavcopy (UDiFF) + lot sizes -> data/fno/*.json
// Source files (official, free, no login):
//   https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip   (all F&O contracts of the day)
//   https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv                                     (lot sizes by expiry month)
// Output: data/fno/summary.json, data/fno/lots.json, data/fno/u/<SYMBOL>.json  (all OI / volume numbers are in UNITS, not lots)
// Safe: network failure or a suspicious result keeps the old files and exits 0. Idempotent: same trade date -> nothing to do (FORCE=1 to rebuild).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const OUT = path.resolve(import.meta.dirname, "..", "data", "fno");
const UDIR = path.join(OUT, "u");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://nsearchives.nseindia.com/content/fo/";
const t0 = Date.now();
const log = (...a) => console.log("[fno]", ...a);

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const istDay = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

function curl(url, file, tries = 2) {
  for (let k = 0; k < tries; k++) {
    try { execFileSync("curl", ["-sS", "-L", "--http1.1", "--fail", "-m", "180", "-A", UA, "-e", "https://www.nseindia.com/", "-o", file, url], { stdio: "pipe" }); return true; }
    catch (e) { if (/\b404\b/.test(String(e.stderr || e.message))) return false; }
  }
  return false;
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

// ---------- 1. find the latest bhavcopy ----------
const prev = readJson(path.join(OUT, "summary.json"));
const prevDate = prev?.meta?.tradeDate || "";
const prevContracts = prev?.meta?.contracts || 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fno-"));
let csvText = null, tradeDate = null, usedUrl = null;
const today = new Date(istDay() + "T00:00:00Z");
for (let back = 0; back <= 7 && !csvText; back++) {
  const d = new Date(today.getTime() - back * 86400e3), dow = d.getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const ymd = d.toISOString().slice(0, 10).replaceAll("-", "");
  if (prevDate && ymd < prevDate.replaceAll("-", "")) break;                        // never go older than what we already have
  const url = `${BASE}BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`, zf = path.join(tmp, ymd + ".zip");
  if (!curl(url, zf)) { log("no file for", ymd); continue; }
  try { csvText = unzipFirst(fs.readFileSync(zf)).toString("utf8"); tradeDate = d.toISOString().slice(0, 10); usedUrl = url; log("downloaded", url); }
  catch (e) { log("bad zip for", ymd, e.message); }
}
if (!csvText) { log("could not get a bhavcopy (network or holiday window); keeping existing files"); process.exit(0); }
if (prevDate && tradeDate === prevDate && !process.env.FORCE) { log("already up to date for", tradeDate); process.exit(0); }
if (prevDate && tradeDate < prevDate) { log("downloaded file is older than current data; keeping existing files"); process.exit(0); }

// ---------- 2. parse ----------
const lines = csvText.split(/\r?\n/).filter(Boolean);
const hdr = lines[0].split(",").map(s => s.trim()), ix = n => { const i = hdr.indexOf(n); if (i < 0) throw new Error("missing column " + n); return i; };
const C = Object.fromEntries(["TradDt", "FinInstrmTp", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "ClsPric", "LastPric", "PrvsClsgPric", "UndrlygPric", "SttlmPric", "OpnIntrst", "ChngInOpnIntrst", "TtlTradgVol", "TtlTrfVal", "NewBrdLotQty"].map(n => [n, ix(n)]));
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
    e.fut = { c: close > 0 ? close : st, pc: pcl > 0 ? pcl : null, oi, doi: doi ?? 0, v: vol, tv: num(f[C.TtlTrfVal]) ?? 0, lot };
  } else {
    const k = num(f[C.StrkPric]), ot = f[C.OptnTp];
    if (!(k > 0) || (ot !== "CE" && ot !== "PE")) { contracts--; bad++; continue; }
    let o = e.opts.get(k); if (!o) e.opts.set(k, o = {});
    o[ot] = { oi, doi: doi ?? 0, v: vol, p: last > 0 ? last : null };
  }
}
log(`parsed ${contracts} contracts, ${und.size} underlyings, ${bad} skipped rows`);

// ---------- 3. validate ----------
if (contracts < 5000 || und.size < 50 || !und.has("NIFTY") || !und.has("BANKNIFTY")) { log("result looks wrong (too few contracts/underlyings); keeping existing files"); process.exit(0); }
if (prevContracts && contracts < 0.7 * prevContracts) { log(`only ${contracts} contracts vs ${prevContracts} before (<70%); keeping existing files`); process.exit(0); }

// ---------- 4. compute ----------
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
const pct = (a, b) => (b > 0 ? r2((a / b) * 100) : null);
const files = new Map(), rows = [];
for (const [sym, u] of und) {
  const exps = [...u.exp.keys()].sort();
  const outExp = [];
  for (const ex of exps) {
    const e = u.exp.get(ex);
    let coi = 0, poi = 0, hc = null, hp = null, hcV = -1, hpV = -1;
    const ch = [];
    for (const k of [...e.opts.keys()].sort((a, b) => a - b)) {
      const o = e.opts.get(k), ce = o.CE, pe = o.PE;
      if (ce) { coi += ce.oi; if (ce.oi > hcV) { hcV = ce.oi; hc = k; } }
      if (pe) { poi += pe.oi; if (pe.oi > hpV) { hpV = pe.oi; hp = k; } }
      if ((ce?.oi || 0) + (pe?.oi || 0) + (ce?.v || 0) + (pe?.v || 0) === 0) continue;           // never traded, no open interest: left out to keep the file small
      ch.push([k, ce?.oi ?? null, ce?.doi ?? null, ce?.v ?? null, ce?.p ?? null, pe?.oi ?? null, pe?.doi ?? null, pe?.v ?? null, pe?.p ?? null]);
    }
    const x = { e: ex, fut: null, ch, coi, poi, pcr: coi > 0 ? Math.round((poi / coi) * 1000) / 1000 : null, mp: e.opts.size ? maxPain(e.opts) : null, hc: hcV > 0 ? hc : null, hp: hpV > 0 ? hp : null };
    if (e.fut) {
      const f = e.fut, base = f.oi - f.doi;
      x.fut = { c: f.c, pc: f.pc, pcp: f.pc > 0 && f.c > 0 ? r2(((f.c - f.pc) / f.pc) * 100) : null, oi: f.oi, doi: f.doi, oip: pct(f.doi, base), v: f.v, prem: u.spot > 0 && f.c > 0 ? r2(((f.c - u.spot) / u.spot) * 100) : null };
    }
    outExp.push(x);
  }
  files.set(sym, { s: sym, t: u.type, d: tradeDate, spot: u.spot, lot: u.lot, x: outExp });
  // summary row: futures totals across all expiries, price move from the nearest futures expiry
  const futs = outExp.filter(x => x.fut), nfx = futs.find(x => x.e > tradeDate) || futs[0], nf = nfx?.fut || null;   // an expiry that falls on the trade date is over: use the next one
  let oi = 0, doi = 0, oiv = 0, vol = 0;
  for (const x of futs) { oi += x.fut.oi; doi += x.fut.doi; oiv += x.fut.oi * x.fut.c; vol += x.fut.v; }
  const no = outExp.find(x => x.e > tradeDate && x.coi + x.poi > 0) || outExp.find(x => x.coi + x.poi > 0);
  rows.push([sym, u.type, u.spot, nf?.c ?? null, nf?.pcp ?? null, oi, doi, pct(doi, oi - doi), Math.round(oiv / 1e5) / 100, vol, u.lot, nfx?.e ?? null, nf?.prem ?? null, no?.e ?? null, no?.pcr ?? null, no?.mp ?? null, no?.coi ?? null, no?.poi ?? null]);
}
const COLS = ["s", "t", "spot", "fut", "pcp", "oi", "doi", "oip", "oiv", "vol", "lot", "fexp", "prem", "oexp", "pcr", "mp", "coi", "poi"];

// ---------- 5. lot sizes ----------
let lots = null;
{
  const lf = path.join(tmp, "lots.csv");
  if (curl(BASE + "fo_mktlots.csv", lf)) {
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

// ---------- 6. write ----------
fs.mkdirSync(UDIR, { recursive: true });
const fname = s => s.replace(/[^A-Za-z0-9-]/g, c => "_" + c.charCodeAt(0).toString(16));
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
for (const [sym, o] of files) write(path.join(UDIR, fname(sym) + ".json"), o);
const keep = new Set([...files.keys()].map(s => fname(s) + ".json"));
for (const f of fs.readdirSync(UDIR)) if (!keep.has(f)) fs.unlinkSync(path.join(UDIR, f));
rows.sort((a, b) => (b[8] || 0) - (a[8] || 0));
write(path.join(OUT, "summary.json"), { meta: { source: usedUrl, tradeDate, generatedAt: new Date().toISOString(), contracts, underlyings: und.size, indices: rows.filter(r => r[1] === "I").length, units: "OI and volume in units (quantity), not lots; oiv in Rs crore" }, cols: COLS, rows });
if (lots) write(path.join(OUT, "lots.json"), lots);
fs.rmSync(tmp, { recursive: true, force: true });
const size = d => fs.readdirSync(d).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0);
log(`wrote ${files.size} underlying files (${(size(UDIR) / 1024).toFixed(0)} KB), summary ${(fs.statSync(path.join(OUT, "summary.json")).size / 1024).toFixed(1)} KB, lots ${lots ? lots.rows.length : "kept"} rows; trade date ${tradeDate}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
