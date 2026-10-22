// "Near-live" market snapshot for Trendy: one run = one snapshot of NSE's public website JSON (NOT real-time ticks).
// Sources (unofficial, the same JSON NSE's own pages use; may change or block us at any time):
//   /api/marketStatus                                    market state + timestamps
//   /api/allIndices                                      all indices (levels, change, P/E ...)
//   /api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY 500 | SECURITIES IN F&O   live stock quotes
//        (the old /api/equity-stockIndices answers 404 "Resource not found" now; this is what nseindia.com/market-data/live-equity-market calls)
//   /api/option-chain-contract-info?symbol=X             expiry list (only when the stored list is stale)
//   /api/option-chain-v3?type=Indices&symbol=X&expiry=D  option chain of one expiry (the old /api/option-chain-indices answers 404 now)
// Output (env LIVE_OUT, default _live/): meta.json (tiny, polled first), market.json, oc-<SYMBOL>.json
// Env: LIVE_PREV = directory with the previous snapshot (row-count guard, expiry cache); LIVE_BUDGET_MS (default 100000);
//      LIVE_FAULT = fault injection for tests: stocks-short | bad-number | future | chain-short | nse-down
// Exit codes: 0 written, 3 refused (fetch/validation failed: NOTHING is written, keep the previous snapshot), 1 crash.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.env.LIVE_OUT || "_live");
const PREV = process.env.LIVE_PREV ? path.resolve(process.env.LIVE_PREV) : null;
const BUDGET = Number(process.env.LIVE_BUDGET_MS || 100000);
const FAULT = process.env.LIVE_FAULT || "";
const T0 = Date.now();
const SCHEMA = 1;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://www.nseindia.com";
const PAGE = BASE + "/market-data/live-equity-market";
const CHAIN_SYMBOLS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[live +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

class Refuse extends Error {}
const refuse = m => { throw new Refuse(m); };

// ---------------------------------------------------------------- HTTP (cookie jar, retries, budget)
const jar = new Map();
let requests = 0;
const keepCookies = r => { for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(";")[0], i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1)); } };
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const left = () => BUDGET - (Date.now() - T0);

async function timed(url, opt, ms) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), Math.max(1000, Math.min(ms, left())));
  try { return await fetch(url, { ...opt, signal: ac.signal }); } finally { clearTimeout(t); }
}
async function refreshCookies() {
  jar.clear(); requests++;
  const r = await timed(PAGE, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" } }, 15000);
  keepCookies(r); await r.arrayBuffer().catch(() => {});
  if (!jar.size) throw new Error("no cookies from " + PAGE + " (HTTP " + r.status + ")");
}
async function api(p, { tries = 3, pace = 350 } = {}) {
  if (FAULT === "nse-down") throw new Error("fault injection: NSE down");
  let lastErr;
  for (let k = 0; k < tries; k++) {
    if (left() < 3000) refuse("run budget of " + BUDGET / 1000 + " s used up");
    try {
      if (!jar.size) await refreshCookies();
      requests++;
      const r = await timed(BASE + "/api/" + p, { headers: { "user-agent": UA, accept: "*/*", "accept-language": "en-US,en;q=0.9", cookie: cookieHeader(), referer: PAGE } }, 20000);
      keepCookies(r);
      const txt = await r.text();
      if (r.ok) { try { await sleep(pace); return JSON.parse(txt); } catch { lastErr = new Error("not JSON: " + txt.slice(0, 60).replace(/\s+/g, " ")); } }
      else lastErr = new Error("HTTP " + r.status);
      if (r.status === 401 || r.status === 403 || r.status === 404 || !r.ok) jar.clear();      // NSE answers 401/403 (and sometimes a fake 404) when the session cookie is bad
    } catch (e) { lastErr = e; if (e instanceof Refuse) throw e; }
    await sleep(800 * 2 ** k);                                                                // 0.8 s, 1.6 s, 3.2 s
  }
  throw new Error(`${p.slice(0, 70)}: ${lastErr?.message}`);
}

// ---------------------------------------------------------------- helpers
const num = x => (x === null || x === undefined || x === "" || x === "-" ? null : Number.isFinite(+x) ? +x : null);
const rnd = (x, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const r3 = x => Math.round(x * 1000) / 1000;
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const p2 = n => String(n).padStart(2, "0");
// "21-Oct-2026 15:40:00" | "2026-10-21 15:40:31" | "21-Oct-2026" -> "2026-10-21T15:40:00+05:30" (NSE times are IST)
function istIso(s) {
  s = String(s || "").trim(); let m;
  if ((m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) { const mo = MON[m[2].toLowerCase()]; if (mo === undefined) return null; return `${m[3]}-${p2(mo + 1)}-${p2(m[1])}T${p2(m[4] || 0)}:${m[5] || "00"}:${m[6] || "00"}+05:30`; }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/))) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}+05:30`;
  return null;
}
const istNow = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);          // today's date in IST
function expiryIso(s) { const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/); return m && MON[m[2].toLowerCase()] !== undefined ? `${m[3]}-${p2(MON[m[2].toLowerCase()] + 1)}-${p2(m[1])}` : null; }
function weekdaysBetween(isoDay, nowDay) {                                                 // weekdays in (isoDay, nowDay]
  let n = 0; for (let d = new Date(isoDay + "T00:00:00Z"); ;) { d = new Date(d.getTime() + 864e5); if (d.toISOString().slice(0, 10) > nowDay) break; const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return n;
}
const readPrev = f => { if (!PREV) return null; try { return JSON.parse(fs.readFileSync(path.join(PREV, f), "utf8")); } catch { return null; } };

// ---------------------------------------------------------------- max pain / totals (same definitions as pipeline/fno.mjs)
// maxPain: strike at which the total payout by option writers (OI x intrinsic value, calls and puts) is lowest; a tie goes to the lowest strike.
function maxPain(opts) {
  const ks = [...opts.keys()].sort((a, b) => a - b);
  let best = null, bestV = Infinity;
  for (const K of ks) {
    let v = 0;
    for (const [k, o] of opts) { if (o.ce) v += o.ce.oi * Math.max(0, K - k); if (o.pe) v += o.pe.oi * Math.max(0, k - K); }
    if (v < bestV) { bestV = v; best = K; }
  }
  return best;
}
function stats(opts) {
  let coi = 0, poi = 0;
  for (const o of opts.values()) { if (o.ce) coi += o.ce.oi; if (o.pe) poi += o.pe.oi; }
  return { coi, poi, pcr: coi > 0 ? r3(poi / coi) : null, mp: opts.size ? maxPain(opts) : null };
}

// ---------------------------------------------------------------- parsers
function parseStatus(j) {
  const cm = (j?.marketState || []).find(x => x?.market === "Capital Market");
  if (!cm) refuse("marketStatus: no Capital Market entry");
  return { state: String(cm.marketStatus || "").trim(), text: String(cm.marketStatusMessage || "").trim(), tradeDate: istIso(cm.tradeDate) };
}
const IDX_COLS = ["name", "grp", "last", "chg", "pct", "o", "h", "l", "pc", "yh", "yl", "pe", "pb", "dy", "adv", "dec", "p365", "p30"];
function parseIndices(j) {
  const rows = [];
  for (const x of j?.data || []) {
    const last = num(x.last);
    if (!x.index || last === null) continue;
    rows.push([String(x.index), String(x.key || "").replace(/ INDICES?( ELIGIBLE IN DERIVATIVES)?$/i, "").trim().toLowerCase().replace(/^indices eligible in derivatives$/, "derivatives"), rnd(last), rnd(num(x.variation)), rnd(num(x.percentChange)), rnd(num(x.open)), rnd(num(x.high)), rnd(num(x.low)), rnd(num(x.previousClose)),
      rnd(num(x.yearHigh)), rnd(num(x.yearLow)), rnd(num(x.pe)), rnd(num(x.pb)), rnd(num(x.dy)), num(x.advances), num(x.declines), rnd(num(x.perChange365d)), rnd(num(x.perChange30d))]);
  }
  return rows;
}
const STK_COLS = ["s", "c", "ch", "p", "o", "h", "l", "pc", "v", "tv", "wh", "wl", "y1", "m1", "fo", "t"];
// tv = traded value in rupees crore, y1 = 1-year change %, m1 = 30-day change %, fo = 1 if in the F&O list, t = HH:MM of the quote
function parseStocks(j500, jfo) {
  const m = new Map();
  const take = (j, fo) => {
    for (const x of j?.data?.data || []) {
      if (!x || x.priority === 1 || !x.series || !x.symbol) continue;
      const c = num(x.lastPrice);
      if (c === null) continue;
      const ts = istIso(x.lastUpdateTime), cur = m.get(x.symbol);
      const row = [String(x.symbol), rnd(c), rnd(num(x.change)), rnd(num(x.pChange)), rnd(num(x.open)), rnd(num(x.dayHigh)), rnd(num(x.dayLow)), rnd(num(x.previousClose)), num(x.totalTradedVolume),
        num(x.totalTradedValue) === null ? null : rnd(num(x.totalTradedValue) / 1e7), rnd(num(x.yearHigh)), rnd(num(x.yearLow)), rnd(num(x.perChange365d)), rnd(num(x.perChange30d)), fo ? 1 : (cur ? cur[14] : 0), ts ? ts.slice(11, 16) : null];
      m.set(x.symbol, cur && !fo ? cur.map((v, i) => (v === null ? row[i] : v)) : row);
      if (fo) m.get(x.symbol)[14] = 1;
    }
  };
  take(j500, false); take(jfo, true);
  return [...m.values()];
}
function parseChain(j, sym) {
  const rec = j?.records;
  if (!rec || !Array.isArray(rec.data)) return null;
  const opts = new Map();
  for (const r of rec.data) {
    const k = num(r.strikePrice); if (k === null) continue;
    const side = o => {
      if (!o) return null;
      const oi = num(o.openInterest), ltp = num(o.lastPrice);
      if (oi === null || oi < 0) return null;
      const iv = num(o.impliedVolatility);
      return { oi, doi: num(o.changeinOpenInterest) ?? 0, vol: num(o.totalTradedVolume) ?? 0, iv: iv && iv > 0 ? rnd(iv) : null, ltp: ltp === null ? null : rnd(ltp) };
    };
    opts.set(k, { ce: side(r.CE), pe: side(r.PE) });
  }
  return { opts, und: num(rec.underlyingValue), ts: istIso(rec.timestamp), totCE: num(j.filtered?.CE?.totOI), totPE: num(j.filtered?.PE?.totOI) };
}
const OC_COLS = ["k", "coi", "cdoi", "cvol", "civ", "cltp", "poi", "pdoi", "pvol", "piv", "pltp"];
const ocRow = (k, o) => [k, o.ce?.oi ?? null, o.ce?.doi ?? null, o.ce?.vol ?? null, o.ce?.iv ?? null, o.ce?.ltp ?? null, o.pe?.oi ?? null, o.pe?.doi ?? null, o.pe?.vol ?? null, o.pe?.iv ?? null, o.pe?.ltp ?? null];

// ---------------------------------------------------------------- main
async function run() {
  const today = istNow();
  log("start; out", OUT, PREV ? "prev " + PREV : "(no previous snapshot)");
  await refreshCookies();
  const status = parseStatus(await api("marketStatus"));
  const idxJson = await api("allIndices");
  const j500 = await api("NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=" + encodeURIComponent("NIFTY 500"));
  const jfo = await api("NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=" + encodeURIComponent("SECURITIES IN F&O"));
  log(`status ${status.state}; fetched indices, NIFTY 500 and F&O lists (${requests} requests so far)`);

  let indices = parseIndices(idxJson), stocks = parseStocks(j500, jfo);
  // asOn: NSE's own timestamp of the NIFTY 500 index row (falls back to the list's timestamp, then to the status timestamp)
  const idxRow = (j500?.data?.data || []).find(x => x?.priority === 1);
  const asOnStr = istIso(idxRow?.lastUpdateTime) || istIso(j500?.data?.timestamp) || status.tradeDate;
  const stockTimes = (j500?.data?.data || []).map(x => istIso(x?.lastUpdateTime)).filter(Boolean).sort();
  let asOn = asOnStr;

  // option chains
  const prevExp = {};
  const chains = {};
  for (const sym of CHAIN_SYMBOLS) {
    const pc = readPrev(`oc-${sym}.json`);
    let exps = pc?.expsAt === today && Array.isArray(pc.exps) ? pc.exps.filter(e => e >= today) : [];
    if (exps.length < 2) {
      const ci = await api("option-chain-contract-info?symbol=" + sym);
      exps = (ci?.expiryDates || []).map(expiryIso).filter(Boolean).sort().filter(e => e >= today).slice(0, 6);
      if (!exps.length) refuse(`${sym}: no expiry dates from NSE`);
    }
    const want = exps.slice(0, 2), kept = [];
    let ts = null, und = null;
    for (const e of want) {
      const dd = new Date(e + "T00:00:00Z");
      const label = `${p2(dd.getUTCDate())}-${Object.keys(MON)[dd.getUTCMonth()].replace(/^./, c => c.toUpperCase())}-${dd.getUTCFullYear()}`;
      const c = parseChain(await api(`option-chain-v3?type=Indices&symbol=${sym}&expiry=${label}`), sym);
      if (!c || c.opts.size === 0) { log(sym, e, "no strikes returned (expired or not started), skipped"); continue; }
      const st = stats(c.opts);
      if (c.totCE !== null && st.coi > 0 && Math.abs(st.coi - c.totCE) / st.coi > 0.05) refuse(`${sym} ${e}: call OI ${st.coi} differs from NSE's own total ${c.totCE}`);
      if (c.totPE !== null && st.poi > 0 && Math.abs(st.poi - c.totPE) / st.poi > 0.05) refuse(`${sym} ${e}: put OI ${st.poi} differs from NSE's own total ${c.totPE}`);
      const strikes = [...c.opts.keys()].sort((a, b) => a - b).map(k => ocRow(k, c.opts.get(k)));
      kept.push({ e, coi: st.coi, poi: st.poi, pcr: st.pcr, mp: st.mp, n: strikes.length, strikes });
      ts = ts || c.ts; und = und ?? c.und;
    }
    chains[sym] = { kept, ts, und, exps, today };
  }

  // fault injection (tests): the validators below must catch each of these
  if (FAULT === "stocks-short") stocks = stocks.slice(0, 120);
  if (FAULT === "bad-number") for (let i = 0; i < 10; i++) stocks[i * 7][1] = i % 2 ? NaN : -5;
  if (FAULT === "future") asOn = new Date(Date.now() + 36e5 + 5.5 * 36e5).toISOString().replace(/\.\d+Z$/, "+05:30").replace("Z", "+05:30");
  if (FAULT === "chain-short") chains.NIFTY.kept.forEach(k => { k.strikes = k.strikes.slice(0, 5); k.n = 5; });

  // ---------------------------------------------------------------- validation: nothing is written unless everything passes
  const prevMarket = readPrev("market.json");
  const fails = [];
  const bad = (c, m) => { if (!c) fails.push(m); };
  const finite = x => typeof x === "number" && Number.isFinite(x);
  bad(["Open", "Closed", "Pre-Open", "Close", "Preopen"].some(s => s.toLowerCase() === status.state.toLowerCase()) || status.state.length > 0, "market state missing");
  const minStocks = prevMarket?.stocks?.length ? Math.ceil(prevMarket.stocks.length * 0.7) : 400;
  const minIdx = prevMarket?.indices?.length ? Math.ceil(prevMarket.indices.length * 0.7) : 50;
  bad(stocks.length >= minStocks, `stocks: ${stocks.length} rows < required ${minStocks}`);
  bad(indices.length >= minIdx, `indices: ${indices.length} rows < required ${minIdx}`);
  let badStock = 0;
  const goodStock = r => {
    const [, c, ch, p, o, h, l, pc, v] = r;
    return !(!(finite(c) && c > 0 && c < 1e6) || !finite(pc) || pc <= 0 || !finite(ch) || !finite(p) || Math.abs(p) > 100 || !(v === null || (finite(v) && v >= 0)) || (finite(h) && finite(l) && (h < l * 0.999 || c > h * 1.001 || c < l * 0.999)));
  };
  const nAll = stocks.length; stocks = stocks.filter(goodStock); badStock = nAll - stocks.length;       // a few odd rows are dropped, many mean the feed is broken
  bad(badStock <= Math.max(5, nAll * 0.01), `stocks: ${badStock} rows with missing/implausible numbers`);
  let badIdx = 0;
  for (const r of indices) { const [, , last, , pct] = r; if (!(finite(last) && last > 0 && last < 1e7) || (finite(pct) && Math.abs(pct) > 40)) badIdx++; }
  bad(badIdx <= 1, `indices: ${badIdx} rows with implausible numbers`);
  bad(indices.some(r => r[0] === "NIFTY 50") && indices.some(r => r[0] === "NIFTY BANK"), "indices: NIFTY 50 / NIFTY BANK missing");
  bad(stocks.some(r => r[0] === "RELIANCE") && stocks.some(r => r[0] === "HDFCBANK"), "stocks: RELIANCE / HDFCBANK missing");
  const nowMs = Date.now();
  const asMs = asOn ? Date.parse(asOn) : NaN;
  bad(Number.isFinite(asMs), "asOn missing or unparsable: " + asOn);
  if (Number.isFinite(asMs)) {
    bad(asMs <= nowMs + 5 * 60e3, "asOn is in the future: " + asOn);
    bad(weekdaysBetween(asOn.slice(0, 10), today) <= 3, "asOn is older than 3 trading days: " + asOn);
    const pm = prevMarket?.meta?.asOn ? Date.parse(prevMarket.meta.asOn) : NaN;
    bad(!(Number.isFinite(pm) && asMs < pm), `asOn ${asOn} is older than the previous snapshot ${prevMarket?.meta?.asOn}`);
  }
  for (const sym of CHAIN_SYMBOLS) {
    const c = chains[sym], pc = readPrev(`oc-${sym}.json`);
    bad(c.kept.length >= 1, `${sym}: no expiry with strikes`);
    const first = c.kept[0];
    if (!first) continue;
    const prevN = pc?.expiries?.[0]?.e === first.e ? pc.expiries[0].n : null;
    const minStrikes = prevN ? Math.ceil(prevN * 0.7) : 20;
    for (const k of c.kept) {
      bad(k.n >= (k === first ? minStrikes : 5), `${sym} ${k.e}: ${k.n} strikes < required ${k === first ? minStrikes : 5}`);   // later expiries (e.g. a far monthly) have few strikes
      bad(k.coi > 0 && k.poi > 0 && finite(k.pcr) && k.pcr > 0.05 && k.pcr < 20, `${sym} ${k.e}: OI totals/PCR implausible (call ${k.coi}, put ${k.poi})`);
      bad(finite(k.mp), `${sym} ${k.e}: max pain missing`);
      let b = 0; for (const r of k.strikes) { if (!finite(r[0]) || r[0] <= 0 || [1, 3, 6, 8].some(i => r[i] !== null && !(finite(r[i]) && r[i] >= 0)) || [5, 10].some(i => r[i] !== null && !(finite(r[i]) && r[i] >= 0)) || [4, 9].some(i => r[i] !== null && !(finite(r[i]) && r[i] < 500))) b++; }
      bad(b === 0, `${sym} ${k.e}: ${b} strike rows with bad numbers`);
    }
    bad(finite(c.und) && c.und > 100, `${sym}: underlying value missing`);
    const t = c.ts ? Date.parse(c.ts) : NaN;
    bad(Number.isFinite(t) && t <= nowMs + 5 * 60e3, `${sym}: chain timestamp missing or in the future (${c.ts})`);
  }
  if (fails.length) { for (const f of fails) log("VALIDATION FAILED:", f); refuse(`${fails.length} validation problem(s); nothing written`); }

  // ---------------------------------------------------------------- build files
  const fetchedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const byPct = (cmp, n = 15) => stocks.filter(r => r[14] === 1 || (r[9] !== null && r[9] >= 5)).filter(r => finite(r[3])).sort(cmp).slice(0, n).map(r => r[0]);
  const top = {
    note: "symbols only; liquid stocks (F&O list or traded value >= 5 crore)",
    gainers: byPct((a, b) => b[3] - a[3]), losers: byPct((a, b) => a[3] - b[3]), active: byPct((a, b) => (b[9] ?? 0) - (a[9] ?? 0)),
    high52: byPct((a, b) => (b[1] / b[10]) - (a[1] / a[10])).filter(s => { const r = stocks.find(x => x[0] === s); return r[10] && r[1] >= r[10] * 0.99; }),
    low52: byPct((a, b) => (a[1] / a[11]) - (b[1] / b[11])).filter(s => { const r = stocks.find(x => x[0] === s); return r[11] && r[1] <= r[11] * 1.01; }),
  };
  const meta = { asOn, fetchedAt, marketStatus: { state: status.state, text: status.text }, quotesUpTo: stockTimes.at(-1) || null,
    source: "NSE India public website data (unofficial). Delayed snapshot, not real-time ticks. Information only.", ivNote: "Implied volatility is as published by NSE" };
  const market = { meta, idxCols: IDX_COLS, indices, cols: STK_COLS, colNotes: { tv: "traded value, Rs crore", y1: "1-year change %", m1: "30-day change %", fo: "1 = in F&O list", t: "quote time HH:MM IST" }, stocks, top };
  const files = { "market.json": JSON.stringify(market) };
  const ocCounts = {};
  for (const sym of CHAIN_SYMBOLS) {
    const c = chains[sym];
    const tot = c.kept.reduce((a, k) => ({ coi: a.coi + k.coi, poi: a.poi + k.poi }), { coi: 0, poi: 0 });
    ocCounts[sym] = c.kept.reduce((a, k) => a + k.n, 0);
    files[`oc-${sym}.json`] = JSON.stringify({
      meta: { symbol: sym, asOn: c.ts, fetchedAt, underlying: rnd(c.und), ivNote: "IV as published by NSE (0 / missing shown as null)", pcrNote: "PCR = put OI / call OI; max pain = strike with the lowest total option-writer payout (computed by Trendy from NSE's OI)" },
      exps: c.exps, expsAt: today, cols: OC_COLS,
      tot: { coi: tot.coi, poi: tot.poi, pcr: tot.coi > 0 ? r3(tot.poi / tot.coi) : null },
      expiries: c.kept,
    });
  }
  const metaSmall = { v: SCHEMA, asOn, fetchedAt, marketOpen: /^open$/i.test(status.state), marketState: status.state, counts: { stocks: stocks.length, indices: indices.length, chains: ocCounts } };
  files["meta.json"] = JSON.stringify(metaSmall);
  for (const [f, s] of Object.entries(files)) {
    const cap = f === "market.json" ? 350e3 : f === "meta.json" ? 2e3 : 60e3;
    if (s.length > cap) refuse(`${f} is ${s.length} bytes (> ${cap}); nothing written`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const order = Object.keys(files).filter(f => f !== "meta.json").concat("meta.json");           // meta.json last: the client sees a complete set
  for (const f of order) { const tmp = path.join(OUT, f + ".tmp"); fs.writeFileSync(tmp, files[f]); fs.renameSync(tmp, path.join(OUT, f)); }
  log(`written ${order.map(f => f + " " + (files[f].length / 1024).toFixed(1) + " KB").join(", ")}`);
  log(`asOn ${asOn}, ${stocks.length} stocks, ${indices.length} indices, chains ${JSON.stringify(ocCounts)}, ${requests} requests, ${((Date.now() - T0) / 1000).toFixed(1)} s`);
}

try { await run(); }
catch (e) {
  if (e instanceof Refuse) log("REFUSED:", e.message); else log("FAILED:", e?.stack || e);
  log("nothing written; the previous snapshot stays");
  process.exit(3);
}
