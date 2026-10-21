// SEBI public-issues listings (official):
//   smid=10  Draft offer documents (DRHP)      -> "filings"   = companies that filed but have no price band yet ("to be announced")
//   smid=11  Red Herring documents filed w/ RoC -> "offerDocs" kind RHP
//   smid=12  Final offer documents (Prospectus) -> "offerDocs" kind Prospectus
// The listing page shows only the newest page (~16 days). Older pages come from SEBI's own ajax endpoint (getnewslistinfo.jsp, page index 0,1,2...).
// We read the last SEBI_DAYS (default 60) days of each listing.
// Output: data/sebi.json  { fetchedAt, windowDays, filings: [{company,date,type,url,stage,rhpDate?,prospectusDate?}], offerDocs: [{company,date,kind,url}] }
// A listing that fails keeps its previous rows (never blanked).
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DAYS = Number(process.env.SEBI_DAYS || 60), MAX_PAGES = 40;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const strip = s => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const clean = t => t.replace(/\s*[-–]\s*(Draft Abridged Prospectus|UDRHP.*|DRHP.*|RHP.*|Prospectus.*|\w+ Addendum.*|Addendum.*|Corrigendum.*|Abridged.*)$/i, "").replace(/\s+/g, " ").trim();
const LIST = smid => `https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&ssid=15&smid=${smid}`;
const TEXT = { 10: "Draft Offer Documents filed with SEBI", 11: "Red Herring Documents filed with ROC", 12: "Final Offer Documents filed with ROC" };

// SEBI's table leaves the 2nd <td> unclosed, so split on <tr> and read date + first filing link from each chunk.
function parseRows(html) {
  const out = [];
  for (const chunk of html.split(/<tr[\s>]/).slice(1)) {
    const d = chunk.match(/<td>\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s*<\/td>/); if (!d || !MON[d[1].toLowerCase()]) continue;
    const a = chunk.match(/<a href=["']([^"']*public-issues[^"']*\.html)["'][\s\S]*?class=["']points["']>\s*([^<]*)/); if (!a) continue;
    const title = strip(a[2]); const company = clean(title); if (!company) continue;
    let url; try { url = new URL(a[1], "https://www.sebi.gov.in"); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname !== "www.sebi.gov.in") continue;
    out.push({ title, company, date: `${d[3]}-${String(MON[d[1].toLowerCase()]).padStart(2, "0")}-${d[2].padStart(2, "0")}`, url: url.href });
  }
  return out;
}
async function getText(url, init, tries = 3) {
  let err;
  for (let k = 0; k < tries; k++) {
    try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) }); if (r.ok) return await r.text(); err = new Error("HTTP " + r.status); } catch (e) { err = e; }
    await sleep(1500);
  }
  throw err;
}
const page = (smid, n) => getText("https://www.sebi.gov.in/sebiweb/ajax/home/getnewslistinfo.jsp", {
  method: "POST",
  headers: { "user-agent": UA, "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", referer: LIST(smid) },
  body: new URLSearchParams({ nextValue: String(n), next: "n", search: "", fromDate: "", toDate: "", fromYear: "", toYear: "", deptId: "-1", sid: "3", ssid: "15", smid: String(smid), ssidhidden: "15", intmid: "-1",
    sText: "Filings", ssText: "Public Issues", smText: TEXT[smid], doDirect: String(n) }),
});

// Newest-first listing; read pages until a whole page is older than the window. Page 0 is also available from the normal listing page (fallback).
async function listing(smid) {
  const cutoff = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10), rows = []; let pages = 0;
  for (let n = 0; n < MAX_PAGES; n++) {
    let html;
    try { html = await page(smid, n); }
    catch (e) { if (n > 0) { console.log(`SEBI smid=${smid}: page ${n} failed (${e.message}), keeping ${rows.length} rows`); break; } html = await getText(LIST(smid), { headers: { "user-agent": UA } }); }   // page 0 fallback; throws if this fails too
    const r = parseRows(html); pages++;
    if (!r.length) { if (n === 0) throw new Error("no rows parsed on page 0"); break; }
    rows.push(...r);
    if (r.every(x => x.date < cutoff)) break;
    await sleep(300);
  }
  return { rows: rows.filter(r => r.date >= cutoff), pages };
}
const latestPerCompany = rows => { const seen = new Set(); return rows.filter(r => { const key = r.company.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }); };
const typeOf = title => /addendum/i.test(title) ? "Addendum" : /corrigendum/i.test(title) ? "Corrigendum" : /UDRHP/i.test(title) ? "UDRHP" : /DRHP/i.test(title) ? "DRHP" : /Abridged/i.test(title) ? "Abridged" : /Addendum/i.test(title) ? "Addendum" : "Other";
const nk = s => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(limited|ltd|private|pvt)\b/g, "").replace(/\s+/g, " ").trim();

let prev = {}; try { prev = JSON.parse(await fs.readFile(path.join(DATA, "sebi.json"), "utf8")); } catch {}
try {
  const res = {}, failed = [];
  for (const smid of [10, 11, 12]) { try { res[smid] = await listing(smid); } catch (e) { failed.push(smid); console.log(`SEBI smid=${smid} failed: ${e.message} - keeping previous rows`); } }
  if (failed.length === 3) throw new Error("all listings failed");

  // DRHP/UDRHP rows are the filings; an Addendum / abridged prospectus for the same company only counts when no DRHP row is in the window
  let filings;
  if (res[10]) {
    const rank = r => (/DRHP/i.test(r.title) && !/addendum|corrigendum/i.test(r.title) ? 0 : 1);   // the DRHP itself beats its addenda
    const sorted = [...res[10].rows].sort((a, b) => rank(a) - rank(b) || b.date.localeCompare(a.date));   // newest DRHP first per company
    filings = latestPerCompany(sorted).map(r => ({ company: r.company, date: r.date, url: r.url, type: typeOf(r.title) })).sort((a, b) => b.date.localeCompare(a.date));
  } else filings = (prev.filings || []).map(({ rhpDate, prospectusDate, stage, ...f }) => f);

  const docRows = (rows, kind) => rows.filter(r => !/corrigendum|addendum/i.test(r.title)).map(r => ({ company: r.company, date: r.date, kind, url: r.url }));
  // Prospectus and RHP kept separately (a company can have both, plus corrigenda; corrigenda are not the document itself)
  const keepPrev = kind => (prev.offerDocs || []).filter(o => o.kind === kind);
  const offerDocs = [...(res[12] ? docRows(res[12].rows, "Prospectus") : keepPrev("Prospectus")), ...(res[11] ? docRows(res[11].rows, "RHP") : keepPrev("RHP"))];

  // companies that already filed an RHP / final prospectus: say so on the filing (build.mjs decides what to do with it)
  const latest = kind => { const m = new Map(); for (const o of offerDocs) if (o.kind === kind) { const key = nk(o.company), p = m.get(key); if (!p || o.date > p.date) m.set(key, o); } return m; };
  const rhp = latest("RHP"), pro = latest("Prospectus");
  for (const f of filings) {
    const a = rhp.get(nk(f.company)), b = pro.get(nk(f.company));
    f.stage = b ? "Prospectus" : a ? "RHP" : f.type;
    if (a) f.rhpDate = a.date;
    if (b) f.prospectusDate = b.date;
  }
  await fs.writeFile(path.join(DATA, "sebi.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), windowDays: DAYS, filings, offerDocs }, null, 1));
  console.log(`SEBI (${DAYS} days; pages read ${[10, 11, 12].map(s => `smid${s}:${res[s]?.pages ?? "kept"}`).join(" ")}): ${filings.length} draft filings (was ${(prev.filings || []).length}), ${offerDocs.filter(o => o.kind === "RHP").length} RHPs, ${offerDocs.filter(o => o.kind === "Prospectus").length} prospectuses; ${filings.filter(f => f.rhpDate || f.prospectusDate).length} filings already have RHP/prospectus`);
} catch (e) { console.log("SEBI failed:", e.message, "- sebi.json left unchanged"); }
