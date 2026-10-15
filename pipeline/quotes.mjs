// Step: listing performance for closed IPOs from Yahoo Finance (listing-day open = listing price, last close = LTP).
// Output: data/quotes.json  { SYMBOL: {listPrice, ltp, listDate, exchange, asOf} }
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
import { loadEntries } from "./entries.mjs";
const nse = await loadEntries();
const quotes = JSON.parse(await fs.readFile(path.join(DATA, "quotes.json"), "utf8").catch(() => "{}"));
const ymd = ts => new Date((ts + 19800) * 1000).toISOString().slice(0, 10);   // IST

async function chart(sym, bseCode) {
  for (const suffix of bseCode ? [".BO"] : [".NS", ".BO"]) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(bseCode || sym)}${suffix}?range=3mo&interval=1d`, { headers: { "user-agent": UA } });
      if (!r.ok) continue;
      const res = (await r.json()).chart?.result?.[0]; const ts = res?.timestamp, q = res?.indicators?.quote?.[0];
      if (!ts?.length || !q?.open) continue;
      const i0 = q.open.findIndex(x => x != null);
      return { dayOpen: q.open[i0], ltp: res.meta.regularMarketPrice, listDate: ymd(ts[i0]), exchange: suffix === ".NS" ? "NSE" : "BSE", asOf: ymd(res.meta.regularMarketTime) };
    } catch {}
  }
  return null;
}
let n = 0;
for (const r of nse) {
  if (r.bucket === "live" && !(r.row?.status && /closed|listed/i.test(r.row.status))) continue;
  const closed = r.bucket === "listed" || (r.info?.["Issue Period"] && new Date() > new Date(r.info["Issue Period"].split(" to ")[1]));
  if (!closed) continue;
  const q = await chart(r.symbol, r.bse?.scripCode);
  if (q) { quotes[r.symbol] = q; n++; }
}
await fs.writeFile(path.join(DATA, "quotes.json"), JSON.stringify(quotes, null, 1));
console.log(`Yahoo quotes: ${n} listed IPOs`);
