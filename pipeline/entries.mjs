// One list of every IPO we track: NSE issues (data/nse.json) + BSE-only issues (data/bse.json, those not already on NSE).
// Pipeline steps that only need symbol / name / issue period (docs, offerdocs) use this instead of reading nse.json directly.
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}-${MON[+m - 1]}-${y}`; };

export async function loadEntries() {
  const read = async f => JSON.parse(await fs.readFile(path.join(DATA, f), "utf8").catch(() => "[]"));
  const nse = (await read("nse.json")).map(r => ({ ...r, source: "nse" }));
  const bse = (await read("bse.json")).filter(b => !b.onNse && b.symbol).map(b => ({
    symbol: b.symbol, name: b.name, bucket: b.bucket === "current" ? "live" : "listed", source: "bse", bse: b,
    info: {
      "Issue Period": `${dmy(b.open)} to ${dmy(b.close)}`, ...(b.priceHigh ? { "Price Range": `Rs.${b.priceLow ?? b.priceHigh} to Rs.${b.priceHigh}` } : {}), ...(b.lot ? { "Lot Size": String(b.lot) } : {}),
      ...(b.faceValue ? { "Face Value": `Rs. ${b.faceValue} per Equity Share` } : {}), "Issue Type": "Book Building",
      ...(b.registrar ? { "Name of the Registrar": b.registrar, "Address of the Registrar": b.registrarAddress || "", "Contact person name number and Email id": b.registrarEmail || "" } : {}),
      ...(b.leadManager ? { "Book Running Lead Managers": b.leadManager } : {}), ...(b.sponsorBank ? { "Sponsor Bank": b.sponsorBank } : {}),
    },
    row: { series: b.board === "SME" ? "SME" : "EQ", issueSize: b.issueShares }, bids: [],
    demand: b.demand ? { timestamp: b.demand.asOn, totalBidRecieved: b.demand.lowestPriceQty, noOfTimesIssueSubscribed: null, plotData: b.demand.byPrice } : null, fetchedAt: b.fetchedAt,
  }));
  return [...nse, ...bse];
}
