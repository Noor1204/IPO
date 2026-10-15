// Verification of extracted fundamentals (runs after extraction, before build).
//  1. Grounding: every money / ratio figure must exist as a number in the offer document text (any unit: crore, million, lakh).
//     Catches invented numbers. It does NOT prove a number sits under the right year/label, so we also do:
//  2. Cross-field consistency: PAT margin vs PAT/revenue, debt-equity vs borrowings/net worth, array lengths, assets vs net worth + debt,
//     implausible jumps; this is what exposes swapped years or mixed-up columns.
//  3. Freshness: extraction must come from the best document available (Prospectus beats RHP).
// Output: data/verify.json { SYMBOL: { status: ok|warn|fail, checked, ungrounded:[...], issues:[...], sourceDoc, stale } }
//   fail = more than 5% of figures not found in the document, or missing core fields; build.mjs hands this to the app,
//   which then refuses to score from that IPO's fundamentals.
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const syms = (await fs.readdir(path.join(DATA, "fundamentals")).catch(() => [])).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
const nse = JSON.parse(await fs.readFile(path.join(DATA, "nse.json"), "utf8").catch(() => "[]"));

const numbersIn = text => { const a = []; for (const m of text.matchAll(/\(?-?\d[\d,]*\.?\d*\)?/g)) { const v = parseFloat(m[0].replace(/[,()]/g, "")); if (isFinite(v)) a.push(Math.abs(v)); } return a.sort((x, y) => x - y); };
const has = (arr, v, tol = 0.0015) => { v = Math.abs(v); let lo = 0, hi = arr.length - 1; const t = Math.max(0.011, v * tol); while (lo < hi) { const mid = (lo + hi) >> 1; arr[mid] < v - t ? lo = mid + 1 : hi = mid; } return arr[lo] !== undefined && Math.abs(arr[lo] - v) <= t; };
const moneyIn = (arr, cr) => [cr, cr * 10, cr * 100, cr * 1e5, cr * 1e7].some(c => has(arr, c));   // crore, million, lakh, thousand, rupees

const out = {};
for (const sym of syms) {
  let f; try { f = JSON.parse(await fs.readFile(path.join(DATA, "fundamentals", sym + ".json"), "utf8")); } catch { continue; }   // skip unreadable / half-written files
  const text = await fs.readFile(path.join(DATA, "text", sym, "rhp_full.txt"), "utf8").catch(() => "");
  const sourceDoc = (await fs.readFile(path.join(DATA, "text", sym, "source.txt"), "utf8").catch(() => "")).trim() || null;
  const arr = numbersIn(text), per = f.periods || [], fin = f.financials || {}, k = f.kpi || {};
  const R = { status: "ok", checked: 0, ungrounded: [], issues: [], sourceDoc, stale: !!(sourceDoc && f.source_doc !== sourceDoc) };
  const check = (label, v, money) => { if (typeof v !== "number") return; R.checked++; if (!(money ? moneyIn(arr, v) : has(arr, v))) R.ungrounded.push(`${label}=${v}`); };

  if (!text) R.issues.push("offer document text missing: numbers could not be grounded");
  for (const key of ["revenue", "pat", "net_worth", "total_assets", "borrowings", "reserves", "pbt", "ebitda", "cash_and_bank", "operating_cash_flow"]) (fin[key] || []).forEach((v, i) => check(`financials.${key}[${per[i]}]`, v, true));
  for (const key of ["roce", "ronw", "roe", "eps_basic", "eps_diluted", "pat_margin", "ebitda_margin", "debt_equity"]) (k[key] || []).forEach((v, i) => check(`kpi.${key}[${per[i]}]`, v, false));
  check("kpi.nav_per_share", k.nav_per_share); check("kpi.pe_post_ipo", k.pe_post_ipo);
  for (const p of f.peers || []) for (const key of ["pe", "ronw", "nav", "eps_basic", "eps_diluted", "cmp"]) check(`peer ${p.name}.${key}`, p[key]);
  for (const o of f.issue?.objects || []) check(`object ${String(o.purpose).slice(0, 24)}`, o.amount_cr, true);

  // core fields present
  for (const key of ["revenue", "pat", "net_worth"]) if (!(fin[key] || []).some(v => typeof v === "number")) R.issues.push(`MISSING core field financials.${key}`);
  for (const key of Object.keys(fin)) if (fin[key]?.length && fin[key].length !== per.length) R.issues.push(`length of financials.${key} is ${fin[key].length}, periods ${per.length}`);

  // consistency
  per.forEach((p, i) => {
    const rev = fin.revenue?.[i], pat = fin.pat?.[i], nw = fin.net_worth?.[i], b = fin.borrowings?.[i], ta = fin.total_assets?.[i];
    const pm = k.pat_margin?.[i], de = k.debt_equity?.[i];
    if (rev > 0 && typeof pat === "number" && typeof pm === "number" && Math.abs(pat / rev * 100 - pm) > 1.5) R.issues.push(`${p}: reported PAT margin ${pm}% vs PAT/revenue ${(pat / rev * 100).toFixed(2)}% (possible swapped years, or margin quoted on total income)`);
    if (nw > 0 && typeof b === "number" && typeof de === "number" && Math.abs(b / nw - de) > 0.3) R.issues.push(`${p}: reported debt/equity ${de} vs borrowings/net worth ${(b / nw).toFixed(2)} (RHP debt may include leases)`);
    if (typeof ta === "number" && typeof nw === "number" && typeof b === "number" && ta < nw + b * 0.8) R.issues.push(`${p}: total assets ${ta} below net worth ${nw} + borrowings ${b}`);
    if (i > 0 && fin.revenue?.[i - 1] > 0 && rev / fin.revenue[i - 1] > 3.5) R.issues.push(`${p}: revenue jumped ${(rev / fin.revenue[i - 1]).toFixed(1)}x vs previous year (check, or genuine hyper-growth)`);
  });
  if (!(f.peers || []).length) R.issues.push("no peer companies extracted");
  if ((f.risks || []).length < 5) R.issues.push(`only ${(f.risks || []).length} risk factors extracted`);
  if (R.stale) R.issues.push(`extraction is from "${f.source_doc || "unknown"}" but the best document now is "${sourceDoc}": re-extract`);

  const ratio = R.checked ? R.ungrounded.length / R.checked : 1;
  R.status = !text || ratio > 0.05 || R.issues.some(x => x.startsWith("MISSING")) ? "fail" : (R.ungrounded.length || R.issues.length) ? "warn" : "ok";
  R.ungrounded = R.ungrounded.slice(0, 25);
  out[sym] = R;
}
await fs.writeFile(path.join(DATA, "verify.json"), JSON.stringify(out, null, 1));
for (const [s, r] of Object.entries(out)) console.log(`verify ${s.padEnd(11)} ${r.status.padEnd(4)} ${r.checked} figures, ${r.ungrounded.length} not in document, ${r.issues.length} notes${r.stale ? " [STALE]" : ""}`);
