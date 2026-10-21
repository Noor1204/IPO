// Step 3c: who to contact, read from the offer document text that docs.mjs already extracted (data/text/<SYMBOL>/rhp_full.txt; official RHP / Prospectus):
//   company   : registered office address (GENERAL INFORMATION), telephone / e-mail / website / contact person (cover page)
//   registrar : telephone / e-mail / website / contact person (the "Registrar to the Offer" block of GENERAL INFORMATION)
// The registrar's name and address, phone and e-mail also come from NSE's issue info (build.mjs), this file only adds what NSE does not carry (website, company contacts).
// Only values that are literally in the document and pass a format check are stored; a value that does not look right is dropped (null), never guessed.
// Output: data/contacts.json  { SYMBOL: { company: {...}, registrar: {...}, at } }. Existing entries are kept when a document is unavailable.
//   node pipeline/contacts.mjs           (TEXT_DIR=<dir> overrides data/text for testing)
import fs from "node:fs/promises";
import path from "node:path";
import { loadEntries } from "./entries.mjs";
import { norm } from "./util.mjs";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const TEXT = process.env.TEXT_DIR || path.join(DATA, "text");
const clean = s => String(s || "").replace(/\r/g, "").replace(/[ \t\f]+/g, " ");
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const okEmail = e => (e && EMAIL.test(e) && e.length <= 80 ? e.toLowerCase() : null);
const okPhone = p => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 8 && d.length <= 14 ? String(p).replace(/\s+/g, " ").trim() : null; };
const okSite = w => { if (!w) return null; let u = String(w).trim().replace(/[;,.)]+$/, ""); if (!/^https?:\/\//i.test(u)) u = "https://" + u; try { const x = new URL(u); return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(x.hostname) && !/\.(pdf|html?)$/i.test(x.pathname) ? x.origin + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, "") : "") : null; } catch { return null; } };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export function parseCompany(text, domain) {
  const t = clean(text), c = {}, dom = String(domain || "").replace(/^www\./, "").toLowerCase();
  // Tie the contact block to THIS company: it is the one whose "Website:" is the company website matched to its name on the cover page (logos.mjs).
  // Without that website we do not read phone / e-mail at all (the cover also lists the lead managers, registrar and the RoC).
  const cover = t.slice(0, 60000);
  if (dom) for (const m of cover.matchAll(/Website\s*:\s*(\S+)/gi)) {
    const w = okSite(m[1]); if (!w || host(w) !== dom) continue;
    const win = cover.slice(Math.max(0, m.index - 260), m.index + 260);
    const em = [...win.matchAll(/E-?mail(?: (?:ID|Id))?\s*:\s*([^\s;,|]+@[^\s;,|]+)/gi)].map(x => okEmail(x[1])).find(Boolean);
    const tel = win.match(/Tel(?:ephone)?\.?\s*(?:No\.?)?\s*:?\s*(\+?[\d][\d ()+\-\/]{6,}\d)/i);
    const cp = win.match(/Contact Person\s*:\s*([^;\n,]+)/i);
    c.website = w; c.email = em || null; c.phone = tel ? okPhone(tel[1]) : null;
    if (cp && /^[A-Za-z][A-Za-z .'-]{2,60}$/.test(cp[1].trim())) c.contactPerson = cp[1].trim();
    break;
  }
  // registered office address
  const a = t.match(/\nRegistered (?:and Corporate )?Office(?: of our Company)?\s*\n(?:\s*\n)?([^\n]+)\n((?:[^\n]+\n){1,5}?)\s*\n/i);
  if (a) { const lines = a[2].split("\n").map(x => x.trim()).filter(Boolean); const addr = lines.join(", ").replace(/,\s*,/g, ",").replace(/,$/, ""); if (addr.length >= 15 && addr.length <= 300 && !/website|e-?mail|tel/i.test(addr)) c.address = addr; }
  return Object.keys(c).filter(k => c[k]).length ? { address: c.address || null, phone: c.phone || null, email: c.email || null, website: c.website || null, contactPerson: c.contactPerson || null } : null;
}

export function parseRegistrar(text, nseName) {
  const t = clean(text);
  const want = norm(nseName).split(" ").slice(0, 2).join(" ");
  for (const m of t.matchAll(/\n\s*Registrar to the (?:Offer|Issue)\s*\n\s*\n?([^\n]+)\n((?:[^\n]*\n){0,14})/gi)) {
    if (want && !norm(m[1]).startsWith(want)) continue;                    // the block must be for the registrar NSE names
    const blk = m[2].split(/\n\s*\n\s*\n/)[0];
    const web = blk.match(/Website\s*:\s*(\S+)/i), em = blk.match(/E-?mail\s*:\s*(\S+@\S+)/i), tel = blk.match(/Tel(?:ephone)?\.?\s*(?:No\.?)?\s*:?\s*(\+?[\d][\d ()+\-\/]{6,}\d)/i), cp = blk.match(/Contact Person\s*:\s*([^\n]+)/i);
    const r = { website: okSite(web?.[1]), email: okEmail(em?.[1]), phone: okPhone(tel?.[1]), contactPerson: cp && /^[A-Za-z][A-Za-z .'-]{2,60}$/.test(cp[1].trim()) ? cp[1].trim() : null };
    if (r.website || r.email || r.phone) return r;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const file = path.join(DATA, "contacts.json");
  let cache = {}; try { cache = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
  const logos = JSON.parse(await fs.readFile(path.join(DATA, "logos.json"), "utf8").catch(() => "{}"));
  let n = 0;
  for (const r of await loadEntries()) {
    const text = await fs.readFile(path.join(TEXT, r.symbol, "rhp_full.txt"), "utf8").catch(() => null);
    if (!text) continue;
    const company = parseCompany(text, logos[r.symbol]?.domain), registrar = parseRegistrar(text, r.info?.["Name of the Registrar"]);
    if (!company && !registrar) continue;
    cache[r.symbol] = { company: company || cache[r.symbol]?.company || null, registrar: registrar || cache[r.symbol]?.registrar || null, at: new Date().toISOString() }; n++;
    console.log("contacts", r.symbol.padEnd(12), company ? "company " + [company.address && "addr", company.phone && "tel", company.email && "mail", company.website && "web"].filter(Boolean).join("+") : "company -", "|", registrar ? "registrar " + [registrar.phone && "tel", registrar.email && "mail", registrar.website && "web"].filter(Boolean).join("+") : "registrar -");
  }
  await fs.writeFile(file, JSON.stringify(cache, null, 1));
  console.log(`contacts: ${n} issues parsed this run, ${Object.keys(cache).length} in cache`);
}
