// Step 1c: per-issue facts that only exist inside NSE's PDF documents (official), parsed with pdftotext and cached in data/params.json:
//   categories : shares reserved for QIB / NII (bNII + sNII) / Retail / market maker and the total (all EXCLUDING the anchor portion) from the
//                "Security Parameters" PDF. NSE's own bid table shows "offered 0" for finished SME issues, so this is the only official source.
//   anchor     : the anchor allocation (date, price, shares, amount) from the first lines of the "Anchor Allocation Report" letter.
// Every figure is cross-checked (categories must add up to the document's total and to NSE's own total issue size; anchor shares must equal the
// anchor shares in NSE's issue-size text; the anchor amount must appear in the letter). Anything that does not reconcile is left out (null), never guessed.
// A failed download / parse keeps the previously cached values.
//   node pipeline/params.mjs            only issues not cached yet (or cached from the pre-anchor PDF while the post-anchor one is now out)
//   node pipeline/params.mjs --all      re-parse everything
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadEntries } from "./entries.mjs";
import { parseParams } from "./params-parse.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ALL = process.argv.includes("--all");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = s => { const m = String(s ?? "").replace(/,/g, "").match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function unzip(zip, dest) {
  const tries = [["C:/Windows/System32/tar.exe", ["-xf", zip, "-C", dest]], ["unzip", ["-oq", zip, "-d", dest]], ["tar", ["-xf", zip, "-C", dest]]];
  for (const [cmd, args] of tries) { try { execFileSync(cmd, args, { stdio: "pipe" }); return; } catch {} }
  throw new Error("could not unzip");
}
// nsearchives rejects Node's HTTP/2 client; curl over HTTP/1.1 works. Returns the text of every PDF inside the zip.
async function pdfTexts(url) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trendy-params-"));
  try {
    const zip = path.join(dir, "d.zip"), out = path.join(dir, "x"); await fs.mkdir(out);
    execFileSync("curl", ["-sS", "-L", "--proto", "=https", "--proto-redir", "=https", "--max-filesize", "60000000", "--http1.1", "--ssl-no-revoke", "--fail", "-m", "90", "-A", UA, "-e", "https://www.nseindia.com/", "-o", zip, url], { stdio: "pipe" });
    unzip(zip, out);
    const texts = [];
    const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.pdf$/i.test(e.name)) { const t = path.join(dir, `t${texts.length}.txt`); try { execFileSync("pdftotext", ["-layout", p, t], { stdio: "pipe" }); texts.push(await fs.readFile(t, "utf8")); } catch {} } } };
    await walk(out);
    return texts;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// ---- anchor allocation letter: only the summary line items that can be checked
function parseAnchor(text, info, priceHigh) {
  const t = text.replace(/\r/g, "");
  const flat = t.replace(/\s+/g, " ");
  const sh = flat.match(/allocation of\s+([\d,]{5,})\s+Equity\s+Shares?\s*,?\s*to\s+Anchor/i), pr = flat.match(/Anchor\s+Investor\s+Allocation\s+Price\s+of\s*[^\d]{0,12}(\d[\d,]*(?:\.\d+)?)/i);
  if (!sh || !pr) return null;
  const shares = num(sh[1]), price = num(pr[1]);
  const issueTxt = String(info["Issue Size"] || ""), a = issueTxt.match(/anchor[^\d]{0,60}([\d,]{5,})/i);
  const nseShares = a ? num(a[1]) : null;
  if (!shares || !price || (nseShares && nseShares !== shares)) return null;          // letter must agree with NSE's own issue-size text
  if (priceHigh && (price > priceHigh * 1.0001 || price < priceHigh * 0.5)) return null;
  const amount = Math.round(shares * price * 100) / 100;
  // the letter's total row carries the amount (Indian or western grouping, sometimes with ".00"); require it to be there
  const digits = flat.replace(/(\d)[ ,](?=\d)/g, "$1");
  const confirmed = digits.includes(String(Math.round(amount)));
  const d = flat.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  const bidDate = d ? `${d[3]}-${String(MON[d[1].toLowerCase()]).padStart(2, "0")}-${d[2].padStart(2, "0")}` : null;
  return { bidDate, price, totalShares: shares, totalAmountCr: Math.round(amount / 1e5) / 100, amountVerified: confirmed };
}

const file = path.join(DATA, "params.json");
let cache = {}; try { cache = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
const entries = (await loadEntries()).filter(r => r.source === "nse" && r.info && Object.keys(r.info).length);
let done = 0, tried = 0;
for (const r of entries) {
  const info = r.info, sym = r.symbol, c = cache[sym] || {};
  const post = info["Security Parameters (Post Anchor)"], pre = info["Security Parameters (Pre Anchor)"] || info["Security Parameters"], live = info["Live Parameters"];
  const url = [post, pre, live].find(u => /^https:\/\/nsearchives\.nseindia\.com\/.+\.zip$/i.test(u || ""));
  const anchorUrl = /^https:\/\/nsearchives\.nseindia\.com\/.+\.zip$/i.test(info["Anchor Allocation Report"] || "") ? info["Anchor Allocation Report"] : null;
  const needCat = url && (ALL || url !== c.categoriesUrl);                    // new document (e.g. the post-anchor PDF replaced the pre-anchor one) or never tried
  const needAnc = anchorUrl && (ALL || !c.anchor && !c.anchorTried);
  if (!needCat && !needAnc) continue;
  tried++;
  const priceHigh = num(String(info["Price Range"] || "").split(/to|-/i).pop());
  const nseTotal = num(r.demand?.totalIssueSize);
  const next = { ...c };
  if (needCat) {
    try {
      const texts = await pdfTexts(url);
      const issue = String(info["Issue Size"] || ""), mm = issue.match(/market\s*maker[^\d]{0,60}([\d,]{4,})/i), an = issue.match(/anchor[^\d]{0,60}([\d,]{5,})/i);
      const anchor = an ? num(an[1]) : null;
      let res = null;
      for (const t of texts) { res = parseParams(t, { anchorShares: anchor, marketMaker: mm ? num(mm[1]) : null }); if (res) break; }
      const from = url === post ? "post" : url === pre ? "pre" : "live";
      if (res) {
        // pre-anchor PDFs count the anchor portion inside QIB: take it out so everything is "excluding anchor", like NSE's total issue size
        if (res.total && nseTotal && res.total !== nseTotal && anchor && res.total - anchor === nseTotal) { res.qib -= anchor; res.total -= anchor; res.anchorRemoved = anchor; }
        else if (nseTotal && res.total !== nseTotal) res = null;                                            // does not match NSE's own total issue size: do not use
        else if (!nseTotal && from === "pre" && anchor) { res.qib -= anchor; res.total -= anchor; res.anchorRemoved = anchor; }
        if (res && res.qib <= 0) res = null;
      }
      next.categoriesUrl = url;
      if (res) { const { nibInDoc, anchorRemoved, ...cats } = res; next.categories = cats; next.categoriesFrom = from; next.categoriesAt = new Date().toISOString(); }
      console.log("params", sym.padEnd(12), from.padEnd(4), res ? `QIB ${res.qib} NII ${res.nii} Retail ${res.retail} MM ${res.marketMaker ?? "-"} total ${res.total}` : "not parseable / does not reconcile - skipped");
    } catch (e) { console.log("params", sym, "categories failed:", e.message.split("\n")[0]); }
  }
  if (needAnc) {
    try {
      const texts = await pdfTexts(anchorUrl);
      let a = null; for (const t of texts) { a = parseAnchor(t, info, priceHigh); if (a) break; }
      next.anchorTried = true;
      if (a) { next.anchor = { ...a, url: anchorUrl, at: new Date().toISOString() }; }
      console.log("anchor", sym.padEnd(12), a ? `${a.totalShares} sh @ ${a.price} = Rs ${a.totalAmountCr} Cr on ${a.bidDate}${a.amountVerified ? " (amount found in letter)" : " (amount NOT found in letter)"}` : "letter not parseable / does not reconcile - skipped");
    } catch (e) { console.log("anchor", sym, "failed:", e.message.split("\n")[0]); }
  }
  cache[sym] = next; done++;
  await sleep(400);
  if (tried >= 40) break;                                                 // be gentle with NSE: the rest follows on the next run
}
// forget issues that left our data a long time ago
const have = new Set((await loadEntries()).map(r => r.symbol));
for (const k of Object.keys(cache)) if (!have.has(k) && Date.now() - new Date(cache[k].categoriesAt || cache[k].anchor?.at || 0) > 120 * 864e5) delete cache[k];
await fs.writeFile(file, JSON.stringify(cache, null, 1));
console.log(`params: ${tried} issues processed, ${Object.values(cache).filter(c => c.categories).length} with category shares, ${Object.values(cache).filter(c => c.anchor).length} with anchor summary`);
