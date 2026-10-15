// For each IPO find its offer document on SEBI (official): the final Prospectus (has the price band, OFS size, P/E ...)
// is preferred over the RHP (price fields blank). Downloads the PDF only when it is needed to (re)build fundamentals.
// Output: data/offer-docs.json { SYMBOL: {kind, date, filingUrl, pdfUrl} }, data/docs/sebi_<kind>_<SYMBOL>.pdf
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { norm } from "./util.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const read = async (f, d) => JSON.parse(await fs.readFile(path.join(DATA, f), "utf8").catch(() => JSON.stringify(d)));
import { loadEntries } from "./entries.mjs";
const nse = await loadEntries();
const sebi = await read("sebi.json", { offerDocs: [] });
const known = await read("offer-docs.json", {});
const exists = f => fs.access(f).then(() => true, () => false);
await fs.mkdir(path.join(DATA, "docs"), { recursive: true });

const same = (a, b) => { const x = norm(a), y = norm(b); return x === y || (x.length > 4 && y.length > 4 && (x.startsWith(y + " ") || y.startsWith(x + " "))); };
async function pdfUrl(filingUrl) {
  const html = await (await fetch(filingUrl, { headers: { "user-agent": UA } })).text();
  const m = [...html.matchAll(/(?:href|src|file)=['"]([^'"]*\.pdf[^'"]*)['"]/gi)].map(x => x[1]);
  const raw = m.find(u => /sebi_data\/attachdocs/.test(u)) || m[0]; if (!raw) return null;
  const inner = raw.match(/file=(https?:[^&]+)/); return inner ? inner[1] : new URL(raw, filingUrl).href;
}
// curl fails SEBI's TLS revocation check on Windows (schannel), Node's own TLS works
async function download(url, file) {
  let err;
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.subarray(0, 4).toString() !== "%PDF") throw new Error("not a PDF");
      return await fs.writeFile(file, buf);
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 3000 * (k + 1))); }
  }
  throw err;
}

let found = 0, fetched = 0;
for (const r of nse) {
  const pro = sebi.offerDocs.find(o => o.kind === "Prospectus" && same(o.company, r.name));
  const rhp = sebi.offerDocs.find(o => o.kind === "RHP" && same(o.company, r.name));
  const pick = pro || rhp; if (!pick) continue;
  found++;
  let entry = known[r.symbol];
  if (!entry || entry.kind !== pick.kind || entry.filingUrl !== pick.url) {
    try { const u = await pdfUrl(pick.url); entry = { kind: pick.kind, date: pick.date, filingUrl: pick.url, pdfUrl: u }; known[r.symbol] = entry; }
    catch (e) { console.log(r.symbol, "SEBI page failed:", e.message); continue; }
  }
  if (!entry.pdfUrl) { console.log(r.symbol, "no pdf link on", pick.url); continue; }
  const hasFund = await exists(path.join(DATA, "fundamentals", `${r.symbol}.json`));
  const fund = hasFund ? JSON.parse(await fs.readFile(path.join(DATA, "fundamentals", `${r.symbol}.json`), "utf8")) : null;
  const needed = !hasFund || (entry.kind === "Prospectus" && fund?.source_doc !== "Prospectus");
  const file = path.join(DATA, "docs", `sebi_${entry.kind.toLowerCase()}_${r.symbol}.pdf`);
  if (needed && !(await exists(file))) {
    try { await download(entry.pdfUrl, file); fetched++; console.log("downloaded SEBI", entry.kind, r.symbol, ((await fs.stat(file)).size / 1048576).toFixed(1), "MB"); }
    catch (e) { console.log(r.symbol, "download failed:", e.message.split("\n")[0]); await fs.rm(file, { force: true }); }
  }
}
await fs.writeFile(path.join(DATA, "offer-docs.json"), JSON.stringify(known, null, 1));
console.log(`offerdocs: ${found} IPOs matched on SEBI, ${fetched} PDFs downloaded`);
