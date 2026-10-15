// SEBI public-issues listings (official):
//   smid=10  Draft offer documents (DRHP)      -> "filings"   = companies that filed but have no price band yet ("to be announced")
//   smid=11  Red Herring documents filed w/ RoC -> "offerDocs" kind RHP
//   smid=12  Final offer documents (Prospectus) -> "offerDocs" kind Prospectus
// Output: data/sebi.json  { fetchedAt, filings: [{company,date,type,url}], offerDocs: [{company,date,kind,url}] }
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const clean = t => t.replace(/\s*[-–]\s*(Draft Abridged Prospectus|UDRHP.*|DRHP.*|RHP.*|Prospectus.*|\w+ Addendum.*|Addendum.*|Corrigendum.*|Abridged.*)$/i, "").replace(/\s+/g, " ").trim();

async function listing(smid) {
  const html = await (await fetch(`https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&ssid=15&smid=${smid}`, { headers: { "user-agent": UA } })).text();
  const out = [];
  // SEBI's table leaves the 2nd <td> unclosed, so split on <tr> and read date + first filing link from each chunk.
  for (const chunk of html.split(/<tr[\s>]/).slice(1)) {
    const d = chunk.match(/<td>\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s*<\/td>/); if (!d) continue;
    const a = chunk.match(/<a href="([^"]*public-issues[^"]*\.html)"[\s\S]*?class="points">\s*([^<]*)/); if (!a) continue;
    const title = strip(a[2]); const company = clean(title); if (!company) continue;
    out.push({ title, company, date: `${d[3]}-${String(MON[d[1].toLowerCase()]).padStart(2, "0")}-${d[2].padStart(2, "0")}`, url: new URL(a[1], "https://www.sebi.gov.in").href });
  }
  return out;
}
const latestPerCompany = rows => { const seen = new Set(); return rows.filter(r => { const k = r.company.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); };

try {
  const [draft, rhp, fin] = await Promise.all([listing(10), listing(11), listing(12)]);
  const filings = latestPerCompany(draft).map(r => ({ company: r.company, date: r.date, url: r.url, type: /UDRHP/i.test(r.title) ? "UDRHP" : /DRHP/i.test(r.title) ? "DRHP" : /Abridged/i.test(r.title) ? "Abridged" : /Addendum/i.test(r.title) ? "Addendum" : "Other" }));
  // Prospectus and RHP kept separately (a company can have both, plus corrigenda; corrigenda are not the document itself)
  const offerDocs = [...fin.filter(r => !/corrigendum|addendum/i.test(r.title)).map(r => ({ company: r.company, date: r.date, kind: "Prospectus", url: r.url })),
    ...rhp.filter(r => !/corrigendum|addendum/i.test(r.title)).map(r => ({ company: r.company, date: r.date, kind: "RHP", url: r.url }))];
  await fs.writeFile(path.join(DATA, "sebi.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), filings, offerDocs }, null, 1));
  console.log(`SEBI: ${filings.length} draft filings, ${offerDocs.filter(o => o.kind === "RHP").length} RHPs, ${offerDocs.filter(o => o.kind === "Prospectus").length} prospectuses`);
} catch (e) { console.log("SEBI failed:", e.message); }
