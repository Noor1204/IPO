// Mutual Fund data pipeline -> data/mf/*.json
// Sources (official, free):
//   NAV list : https://portal.amfiindia.com/spages/NAVAll.txt   (www.amfiindia.com/spages/NAVAll.txt redirects here)
//   History  : https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=DD-Mon-YYYY&todt=DD-Mon-YYYY
// Returns (6M absolute, 1Y absolute, 3Y/5Y CAGR) are computed from AMFI NAVs on navDate and the same date 6M/1Y/3Y/5Y earlier
// (stepping back up to 7 days when that day has no data).
// Never throws on network errors: logs, keeps the old files, exits 0. Refuses to overwrite with < 70 % of the previous rows.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "mf");
const NAV_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const HIST_URL = (d) => `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=${d}&todt=${d}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const UA = "Mozilla/5.0 (compatible; TrendyMF/1.0)";

const log = (...a) => console.log("[mf]", ...a);
const fmtAmfi = (dt) => `${String(dt.getUTCDate()).padStart(2, "0")}-${MON[dt.getUTCMonth()]}-${dt.getUTCFullYear()}`;
const iso = (dt) => dt.toISOString().slice(0, 10);
function parseAmfiDate(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((s || "").trim()); if (!m) return null;
  const mi = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()); if (mi < 0) return null;
  return new Date(Date.UTC(+m[3], mi, +m[1]));
}
function shift(dt, years, months) { // same calendar day earlier; 29 Feb -> 28 Feb
  let y = dt.getUTCFullYear() - years, mo = dt.getUTCMonth() - months;
  while (mo < 0) { mo += 12; y--; }
  const day = dt.getUTCDate(), last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(day, last)));
}

async function get(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.text();
    } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw err;
}

// ---------- category normalisation ----------
function category(raw) {
  const t = raw.replace(/\s+/g, " ").trim(), l = t.toLowerCase();
  const sub = (t.includes(" - ") ? t.slice(t.indexOf(" - ") + 3) : t).replace(/\s+/g, " ").replace(/ Fund$/i, "").trim();
  if (/index fund/.test(l)) return ["Index Fund", "index"];
  if (/^equity/.test(l)) {
    if (/elss/.test(l)) return ["ELSS (Tax Saver)", "elss"];
    if (/large & mid/.test(l)) return ["Large & Mid Cap", "eqother"];
    if (/large cap/.test(l)) return ["Large Cap", "large"];
    if (/mid cap/.test(l)) return ["Mid Cap", "mid"];
    if (/small cap/.test(l)) return ["Small Cap", "small"];
    if (/flexi cap/.test(l)) return ["Flexi Cap", "flexi"];
    if (/multi cap/.test(l)) return ["Multi Cap", "multi"];
    if (/sectoral|thematic/.test(l)) return ["Sectoral/Thematic", "eqother"];
    return [sub, "eqother"];
  }
  if (/^hybrid/.test(l)) {
    if (/dynamic asset|balanced advantage/.test(l)) return ["Balanced Advantage", "hybrid"];
    return [sub.replace(/^Multi Asset Allocation$/, "Multi Asset Allocation"), "hybrid"];
  }
  if (/^(income|debt|gilt)/.test(l)) return [/^income\/debt/.test(l) ? sub : sub === "Income" ? "Income" : sub, "debt"];
  return [sub || "Other", "other"];
}
const FILE_OF = { large: "equity", mid: "equity", small: "equity", flexi: "equity", multi: "equity", elss: "equity", eqother: "equity", index: "hybrid", hybrid: "hybrid", other: "hybrid", debt: "debt" };

// ---------- parse NAVAll ----------
function parseNavAll(txt) {
  const rows = [], skipped = { notOpenEnded: 0, noPlan: 0, idcwOrOther: 0, badNav: 0, junkName: 0 };
  let cat = null, amc = "";
  const lines = txt.split(/\r?\n/);
  const head = lines[0].split(";").map((s) => s.trim().toLowerCase());
  const ix = (re) => head.findIndex((h) => re.test(h));
  const iCode = ix(/^scheme code/), iName = ix(/^scheme name|^nav name/), iPlan = ix(/^plan/), iOpt = ix(/^option/), iNav = ix(/^net asset value/), iDate = ix(/^date/);
  if ([iCode, iName, iPlan, iOpt, iNav, iDate].some((i) => i < 0)) throw new Error("NAVAll header changed: " + lines[0]);
  for (const ln0 of lines.slice(1)) {
    const ln = ln0.trim(); if (!ln) continue;
    if (!ln.includes(";")) {
      const m = /^(Open Ended|Close Ended|Interval Fund) Schemes\s*\((.*)\)\s*$/i.exec(ln);
      if (m) { cat = /^open/i.test(m[1]) ? m[2] : null; continue; }
      amc = ln.replace(/\s*Mutual Fund\s*$/i, "").trim(); continue;
    }
    const f = ln.split(";");
    if (f.length < head.length) continue;
    if (cat == null) { skipped.notOpenEnded++; continue; }
    const plan = /^direct/i.test(f[iPlan]) ? 0 : /^regular/i.test(f[iPlan]) ? 1 : -1;
    if (plan < 0) { skipped.noPlan++; continue; }
    const opt = f[iOpt].trim();
    if (!/^growth/i.test(opt) || /idcw|dividend|payout|reinvest/i.test(opt)) { skipped.idcwOrOther++; continue; }
    const name = f[iName].trim().replace(/\s+/g, " ");
    if (/bonus|segregated|\bfmp\b|fixed (term|maturity)|\(ex-?\s?bonus/i.test(name)) { skipped.junkName++; continue; }
    const nav = parseFloat(f[iNav]), d = parseAmfiDate(f[iDate]), code = +f[iCode];
    if (!(nav > 0) || !isFinite(nav) || !d || !Number.isInteger(code)) { skipped.badNav++; continue; }
    rows.push({ code, name, amc, plan, cat, nav, date: d });
  }
  return { rows, skipped };
}

// ---------- parse history report for one day -> Map(code -> nav) ----------
function parseHist(txt) {
  const lines = txt.split(/\r?\n/), m = new Map();
  const head = (lines[0] || "").split(";").map((s) => s.trim().toLowerCase());
  const iCode = head.findIndex((h) => /^scheme code/.test(h)), iNav = head.findIndex((h) => /^net asset value/.test(h));
  if (iCode < 0 || iNav < 0) return m;
  for (const ln of lines.slice(1)) {
    if (!ln.includes(";")) continue;
    const f = ln.split(";"), code = +f[iCode], nav = parseFloat(f[iNav]);
    if (Number.isInteger(code) && nav > 0 && isFinite(nav)) m.set(code, nav);
  }
  return m;
}
// AMFI's per-day report is sometimes partial (a few AMCs missing on a given day), so for each target date we merge up to 3 trading days
// going back (max 9 calendar days). Each scheme uses its nearest NAV on or before the target date; the NAV's own date is kept for the day count.
async function histOn(target, maxDays = 3) {
  const map = new Map(); let got = 0, first = null;
  for (let k = 0; k <= 9 && got < maxDays; k++) {
    const dt = new Date(target.getTime() - k * 86400000);
    const m = parseHist(await get(HIST_URL(fmtAmfi(dt))));
    if (m.size < 2000) { log("history", fmtAmfi(dt), "no/partial data (rows " + m.size + ")"); continue; }
    log("history", fmtAmfi(dt), "rows", m.size);
    got++; if (!first) first = dt;
    for (const [c, n] of m) if (!map.has(c)) map.set(c, [n, dt]);
  }
  if (!first) throw new Error("no history within 9 days of " + fmtAmfi(target));
  return { date: first, map };
}

const r2 = (x) => Math.round(x * 100) / 100;
function ret(cur, past, days, annual) {
  if (!(cur > 0) || !(past > 0)) return null;
  const ratio = cur / past; if (ratio < 0.05 || ratio > 100) return null;
  const v = annual ? (Math.pow(ratio, 365 / days) - 1) * 100 : (ratio - 1) * 100;
  if (!isFinite(v)) return null;
  const lo = annual ? -60 : -95, hi = annual ? 150 : 1000;   // obviously broken -> drop
  return v < lo || v > hi ? null : r2(v);
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function prevRows() {
  const idx = readJson(path.join(OUT, "index.json")); if (!idx) return { n: 0, idx: null };
  return { n: idx.meta?.counts?.total || 0, idx };
}

async function main() {
  const prev = prevRows();
  let navTxt;
  try { navTxt = await get(NAV_URL); } catch (e) { log("NAVAll fetch failed, keeping old files:", e.message); return; }
  const { rows, skipped } = parseNavAll(navTxt);
  if (rows.length < 500) { log("NAVAll parse looks wrong (" + rows.length + " rows), keeping old files"); return; }
  // current date = the date most schemes carry; drop schemes whose NAV is older than 7 days (dead/merged)
  const cnt = new Map(); rows.forEach((r) => cnt.set(+r.date, (cnt.get(+r.date) || 0) + 1));
  const navDt = new Date([...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  let stale = 0;
  const live = rows.filter((r) => { if (navDt - r.date > 7 * 86400000) { stale++; return false; } return true; });
  log("NAVAll rows (Direct/Regular Growth, open ended):", rows.length, "| stale dropped:", stale, "| navDate:", iso(navDt));

  if (prev.idx && prev.idx.meta?.navDate === iso(navDt) && prev.idx.meta?.rowsKey === live.length) { log("same NAV date and row count, nothing to do"); return; }

  let cur, p6, p1, p3, p5;
  try {
    cur = await histOn(navDt, 1);
    p6 = await histOn(shift(navDt, 0, 6)); p1 = await histOn(shift(navDt, 1, 0));
    p3 = await histOn(shift(navDt, 3, 0)); p5 = await histOn(shift(navDt, 5, 0));
  } catch (e) { log("history fetch failed, keeping old files:", e.message); return; }
  
  const amcs = [], amcIx = new Map(), cats = [], catIx = new Map();
  const files = { equity: [], hybrid: [], debt: [] };
  const cnts = { total: 0, direct: 0, regular: 0, r6m: 0, r1y: 0, r3y: 0, r5y: 0 };
  live.sort((a, b) => a.name.localeCompare(b.name) || a.plan - b.plan || a.code - b.code);
  for (const r of live) {
    if (!amcIx.has(r.amc)) { amcIx.set(r.amc, amcs.length); amcs.push(r.amc); }
    const [label, key] = category(r.cat), ck = key + "|" + label;
    if (!catIx.has(ck)) { catIx.set(ck, cats.length); cats.push([label, key]); }
    // returns are measured from the history file's NAV on navDate so every scheme uses the same end date
    const c = cur.map.get(r.code)?.[0] ?? (+r.date === +navDt ? r.nav : null);
    const R = (p, annual) => { const q = p.map.get(r.code); return q ? ret(c, q[0], Math.round((navDt - q[1]) / 86400000), annual) : null; };
    const r6 = R(p6, false), r1 = R(p1, false), r3 = R(p3, true), r5 = R(p5, true);
    cnts.total++; r.plan ? cnts.regular++ : cnts.direct++;
    if (r6 != null) cnts.r6m++; if (r1 != null) cnts.r1y++; if (r3 != null) cnts.r3y++; if (r5 != null) cnts.r5y++;
    files[FILE_OF[key]].push([r.code, r.name, amcIx.get(r.amc), r.plan, catIx.get(ck), r.nav, iso(r.date), r6, r1, r3, r5]);
  }
  if (prev.n && cnts.total < prev.n * 0.7) { log(`only ${cnts.total} rows vs ${prev.n} before (< 70 %), refusing to overwrite`); return; }
  if (cnts.r1y < cnts.total * 0.4) { log("too few 1Y returns (" + cnts.r1y + "/" + cnts.total + "), refusing to overwrite"); return; }

  const idx = {
    meta: {
      source: "AMFI (NAVAll.txt + NAV history report)", navDate: iso(navDt), rowsKey: live.length,
      returnBases: { "6M": iso(p6.date), "1Y": iso(p1.date), "3Y": iso(p3.date), "5Y": iso(p5.date) },
      returns: "6M and 1Y = absolute %, 3Y and 5Y = CAGR % (annualised over the actual days between the two NAV dates)",
      scope: "Open-ended Growth-option schemes of Direct and Regular plans. Excluded: IDCW/dividend options, bonus, segregated portfolios, FMP/fixed-term, closed-ended, interval schemes, exchange-traded units (the AMFI file gives them no Direct/Regular plan), schemes whose NAV is older than 7 days.",
      skipped: { ...skipped, staleNav: stale },
      columns: ["code", "name", "amc", "plan(0=Direct,1=Regular)", "cat", "nav", "navDate", "ret6m", "ret1y", "ret3y", "ret5y"],
      counts: cnts,
    },
    amcs, cats, files: Object.keys(files).filter((k) => files[k].length).map((k) => `rows-${k}.json`),
  };
  const out = { "index.json": idx };
  for (const k of Object.keys(files)) if (files[k].length) out[`rows-${k}.json`] = { rows: files[k] };
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = (o) => JSON.stringify(o);
  let changed = 0;
  for (const [f, o] of Object.entries(out)) {
    const fp = path.join(OUT, f), old = readJson(fp);
    if (old && stamp(old) === stamp(f === "index.json" ? { ...o, meta: { ...o.meta, generatedAt: old.meta?.generatedAt } } : o)) continue;
    if (f === "index.json") o.meta.generatedAt = new Date().toISOString();
    fs.writeFileSync(fp, JSON.stringify(o)); changed++;
  }
  // remove rows files that are no longer listed
  for (const f of fs.readdirSync(OUT)) if (/^rows-.*\.json$/.test(f) && !out[f]) fs.unlinkSync(path.join(OUT, f));
  log("counts:", JSON.stringify(cnts), "| skipped:", JSON.stringify(idx.meta.skipped));
  for (const f of fs.readdirSync(OUT)) log(f, fs.statSync(path.join(OUT, f)).size, "bytes");
  log(changed ? "wrote " + changed + " file(s)" : "no changes");
}
main().catch((e) => { console.log("[mf] failed, keeping old files:", e.message); }).finally(() => process.exit(0));
