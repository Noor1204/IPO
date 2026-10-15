// BSE public issues (official): live / upcoming and recently closed IPOs on BSE Main Board and BSE SME.
// NSE's API only covers NSE-listed issues, so this fills the other half of the market (mostly SME IPOs).
// Output: data/bse.json, data/docs/bsezip_<SYMBOL>.zip (prospectus / RHP + GID, recent IPOs only)
import fs from "node:fs/promises";
import path from "node:path";
import { norm } from "./util.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const H = { "user-agent": UA, accept: "application/json, text/plain, */*", origin: "https://www.bseindia.com", referer: "https://www.bseindia.com/" };
const API = "https://api.bseindia.com/BseIndiaAPI/api/";
const KEEP_DAYS = 21;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async u => { for (let k = 0; k < 3; k++) { try { const r = await fetch(API + u, { headers: H, signal: AbortSignal.timeout(30000) }); if (r.ok) return JSON.parse(await r.text()); } catch {} await sleep(1200); } return null; };
const day = s => String(s || "").slice(0, 10) || null;
const fixUrl = u => u ? u.replace(/\\/g, "/").replace(/\s+/g, "%20") : null;          // BSE returns Windows paths in some links
const nm = s => String(s || "").split("^")[0].trim();
const addr = s => String(s || "").split("^")[1]?.split("|")[0]?.trim() || null;
const email = s => (String(s || "").match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [])[0] || null;
const num = s => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

const old = JSON.parse(await fs.readFile(path.join(DATA, "bse.json"), "utf8").catch(() => "[]"));
const cur = (await get("GetPublicIssue_par_updated/w?flag=1&scrip_Name=&ir_flag=&status=&exchange=")) || {};
const past = (await get("GetPublicIssue_par_updated/w?flag=2&scrip_Name=&ir_flag=&status=&exchange=")) || {};
const rows = [...(cur.Table || []).map(r => ({ ...r, bucket: "current" })), ...(past.Table || []).map(r => ({ ...r, bucket: "past" }))]
  .filter(r => r.IR_flag === "IPO" && r.IPO_NO)
  .filter(r => r.bucket === "current" || (Date.now() - new Date(r.End_Dt)) / 864e5 <= KEEP_DAYS);
console.log(`BSE: ${rows.length} IPOs (${rows.filter(r => r.eXCHANGE_PLATFORM === "SME").length} SME)`);

const out = [];
for (const r of rows) {
  const j = await get(`GetMkt_ISSUE_BBS_IPO/w?IPO_NO=${r.IPO_NO}`); await sleep(350);
  const d = j?.IPONO_0?.[0];
  if (!d) { const prev = old.find(o => o.iponNo === String(r.IPO_NO)); if (prev) out.push(prev); continue; }
  const [lo, hi] = String(d.Price_Band || r.Price_Band || "").split("-").map(num);
  const demand = (j.IPONO_2 || []).map(x => [String(num(x.Price)), num(x.Quantity)]);
  out.push({
    iponNo: String(r.IPO_NO), scripCode: String(r.Scrip_cd), symbol: d.Symbol || null, name: r.Scrip_Name.replace(/\s+/g, " ").trim(), board: r.eXCHANGE_PLATFORM === "SME" ? "SME" : "Mainboard",
    exchange: "BSE", bucket: r.bucket, status: r.Status, open: day(r.Start_Dt), close: day(r.End_Dt), priceLow: lo ?? null, priceHigh: hi ?? lo ?? null, faceValue: num(d.Face_Value), lot: num(d.Market_Lot), minBid: num(d.Minimum_Bid_Quantity),
    issueShares: num(d.Issue_Size_No_of_shares), leadManager: nm(d.Book_Running_Lead_Manager), leadManagerAddress: addr(d.Book_Running_Lead_Manager), registrar: nm(d.Registrar), registrarAddress: addr(d.Registrar), registrarEmail: email(d.Registrar),
    sponsorBank: nm(d.Sponsor_Bank), upiCategories: d.UPI_Categories || null,
    docs: { prospectus: fixUrl(d.Prospectus_GID), priceBandAd: fixUrl(d.Price_Band_Advertisement), addendum: fixUrl(d.Addendum), corrigendum: fixUrl(d.Corrigendum), anchorNotice: fixUrl(j.IPONO_4?.[0]?.FILENAME) },
    demand: demand.length ? { asOn: d.DT_TMC || d.DT_TM, byPrice: Object.fromEntries(demand), lowestPriceQty: demand[0]?.[1] ?? null } : null,
    fetchedAt: new Date().toISOString(),
  });
  console.log("BSE", out[out.length - 1].board.padEnd(9), String(out[out.length - 1].symbol).padEnd(14), r.bucket);
}
await fs.writeFile(path.join(DATA, "bse.json"), JSON.stringify(out, null, 1));

// offer document zip for each BSE IPO (needed for fundamentals); recent ones only
// Dual-listed issues are already covered via NSE/SEBI, so only BSE-only issues need their document from here.
const nseNames = JSON.parse(await fs.readFile(path.join(DATA, "nse.json"), "utf8").catch(() => "[]")).map(r => norm(r.name));
const onNse = name => { const n = norm(name); return nseNames.some(k => k === n || (k.length > 4 && n.length > 4 && (k.startsWith(n + " ") || n.startsWith(k + " ")))); };
await fs.mkdir(path.join(DATA, "docs"), { recursive: true });
for (const o of process.argv.includes("--no-docs") ? [] : out) {
  o.onNse = onNse(o.name);
  if (o.onNse || !o.docs.prospectus || !o.symbol) continue;
  const base = path.join(DATA, "docs", `bse_${o.symbol}`);
  if ((await fs.access(base + ".zip").then(() => true, () => false)) || (await fs.access(base + ".pdf").then(() => true, () => false))) continue;
  try {
    const r = await fetch(o.docs.prospectus, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(300000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const head = buf.subarray(0, 4).toString(), ext = head.startsWith("PK") ? ".zip" : head === "%PDF" ? ".pdf" : null;
    if (!r.ok || !ext) throw new Error(`HTTP ${r.status}, neither zip nor pdf`);
    await fs.writeFile(base + ext, buf); console.log("downloaded", path.basename(base + ext), (buf.length / 1048576).toFixed(1), "MB");
  } catch (e) { console.log("download failed", o.symbol, e.message); }
}
for (const o of out) o.onNse = o.onNse ?? onNse(o.name);
await fs.writeFile(path.join(DATA, "bse.json"), JSON.stringify(out, null, 1));
