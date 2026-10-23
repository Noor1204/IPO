// Step 3c: who to contact, read from the offer document text that docs.mjs already extracted (data/text/<SYMBOL>/rhp_full.txt; official RHP / Prospectus):
//   company   : registered office address (GENERAL INFORMATION), telephone / e-mail / website / contact person (cover page)
//   leadManagers: all Book Running Lead Managers of the issue (parseLeadManagers below)
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

// ---- lead managers (Book Running Lead Managers) from the "DETAILS OF BOOK RUNNING LEAD MANAGERS" block of the offer document.
// NSE's issue info names only one (the first) lead manager for a big issue, the offer document lists all of them. The block is laid out in columns
// (name | contact person | e-mail / phone) and the pdf text interleaves them, so this is deliberately conservative: only the leftmost (name) column is read,
// wrapped names are joined, "(formerly known as ...)" notes and footnote marks are dropped. A list is returned only when ALL of these hold, else null (never a guess):
//   - every name ends in a company suffix (Limited / Ltd / LLP / Paribas), has 4-90 characters, only name characters, no header / contact words, no duplicates
//   - 1 to 25 names, and as many names as e-mail addresses in the block (every manager has exactly one e-mail line)
//   - every name also occurs at least twice in the document text (the document repeats the names; a name glued together from two columns never does)
//   - every manager that NSE names is in the list
const SUF = /\b(?:Limited|Ltd\.?|LLP|Paribas)(?![A-Za-z])/i;
const NAME_END = /(?:\bLimited|\bLtd\.?|\bLLP|\bParibas)$/i;
const HEADWORDS = /^(?:name|names|of|the|and|logo|logos|book|running|lead|manager|managers|brlm|brlms|contact|person|persons|e-?mail|telephone|tel|&|s)$/i;
const BADWORD = /\b(?:contact|e-?mail|email|tel|telephone|logo|logos|registrar|prospectus|dated|page|section|bid|offer|issue|name|person)\b/i;
const titleCase = n => (n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(?![aeiou]|Pvt|Ltd)[b-df-hj-np-tv-z]+\b/gi, w => w.toUpperCase()).replace(/\bPvt\b/, "Pvt.").replace(/\bLtd\b/, "Ltd.") : n);   // all-caps source: Title Case, vowel-less words (GYR, LLP) stay upper case
const nameKey = s => norm(s).replace(/\b(company|co|services|securities|capital|markets|advisors|advisers)\b/g, "").replace(/\s+/g, " ").trim();
export function parseLeadManagers(text, nseNames) {
  const lines = String(text || "").replace(/\r/g, "").replace(/\t/g, " ").replace(/\f/g, "\n").split("\n");
  const HEAD = /^\s*(?:DETAILS OF (?:THE )?)?BOOK RUNNING LEAD MANAGERS?(?:\s*\(\W*BRLMS?\W*\))?\s*$|^.{0,60}\bDETAILS OF THE BRLMS\b/i;
  const ENDM = /REGISTRAR TO THE (?:ISSUE|OFFER)|DETAILS OF (?:THE )?R[E]?GISTRAR|NAME OF (?:THE )?REGISTRAR|SYNDICATE MEMBER|LEGAL (?:COUNSEL|ADVISOR)|BID ?\/ ?(?:ISSUE|OFFER) (?:PERIOD|PROGRAMME|PROGRAM)|(?:ISSUE|OFFER) PROGRAMME?|OFFER PERIOD/i;
  for (let hi = 0; hi < lines.length; hi++) {
    if (!HEAD.test(lines[hi])) continue;
    // the block: until the registrar / programme heading (that heading may share a line with the last manager's name, so keep the text left of it)
    const blk = []; let endIdx = -1;
    for (let k = hi + 1; k < Math.min(lines.length, hi + 90); k++) {
      const m = ENDM.exec(lines[k]);
      if (m) { if (m.index > 3) blk.push(lines[k].slice(0, m.index)); endIdx = k; break; }
      blk.push(lines[k]);
    }
    if (blk.length < 2 || endIdx < 0) continue;
    const emails = blk.join(" ").match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
    // contact column: where the "Contact Person" heading starts (names always start left of it)
    let contactCol = Infinity;
    for (const l of blk.slice(0, 8)) { const x = l.search(/contact/i); if (x >= 0 && x < contactCol) contactCol = x; }
    if (!isFinite(contactCol)) continue;
    const names = []; let pend = "", note = false, ok = true;
    for (const raw of blk) {
      const line = raw.replace(/\s+$/, ""); if (!line.trim()) continue;
      const lead = line.length - line.trimStart().length;
      if (lead >= contactCol - 3) continue;                                      // starts in the contact / e-mail columns
      const frag = line.trim().split(/ {2,}/)[0];
      if (note) { if (frag.includes(")")) note = false; continue; }               // inside "(formerly known as ...)"
      if (/[\/:@]/.test(frag) && !SUF.test(frag.split(/[\/:@]/)[0])) continue;   // a contact person ("A / B") or a label
      if (frag.startsWith("(")) { if (!frag.includes(")")) note = true; continue; }
      if (frag.split(/\s+/).every(w => HEADWORDS.test(w))) continue;             // header text: "Manager", "and Logo"
      // a wrapped name continues in a short fragment (<= 3 words: "Limited", "Private Limited", "Advisors Limited"); anything longer starts a new name,
      // and a fragment left over without a suffix (a contact person that sits in the name column) is dropped when the next fragment is not its continuation
      const cont = pend && SUF.test(frag) && frag.split(/\s+/).length <= 3 && /^(?:Private|Pvt\.?|Limited|Ltd\.?|Advisors?|Company|Co\.?|Services|Securities|Management|Markets|Capital|Financial|Investment|Consultants|Partners)\b/i.test(frag);
      const full = cont ? pend + " " + frag : frag, m = SUF.exec(full);
      if (m) {
        names.push(full.slice(0, m.index + m[0].length).replace(/\s+/g, " ").trim()); pend = "";
        const rest = full.slice(m.index + m[0].length);
        if (rest.includes("(") && !rest.includes(")")) note = true;
      } else pend = frag;
    }
    if (ok && pend) {                                                              // last name wrapped to the other side of the registrar heading ("Limited" below it)
      const m = lines.slice(endIdx, endIdx + 8).map(l => l.trim().split(/ {2,}/)[0]).find(l => /^(?:Private )?(?:Limited|Ltd\.?)$/i.test(l));
      if (m) names.push(pend + " " + m); else ok = false;
    }
    if (!ok) continue;
    const out = [];
    for (let n of names) {
      n = n.replace(/\s+/g, " ").replace(/[*#^]+$/g, "").trim();
      if (!n.replace(/\b(?:Private|Pvt\.?|Limited|Ltd\.?|LLP)\b/gi, "").trim() || !/^[A-Za-z0-9][A-Za-z0-9&.,'()\- ]*$/.test(n) || !NAME_END.test(n) || n.length < 4 || n.length > 90 || BADWORD.test(n) || n.split(" ").length > 10) { ok = false; break; }
      n = titleCase(n);
      if (out.some(x => x.toLowerCase() === n.toLowerCase())) { ok = false; break; }
      out.push(n);
    }
    if (!ok || !out.length || out.length > 25 || out.length !== emails.length) continue;
    const flat = String(text).replace(/\s+/g, " ").toLowerCase();
    if (!out.every(n => flat.split(n.toLowerCase()).length - 1 >= 2)) continue;
    // every manager NSE names must be in the list ("A, B and C"; a name can itself contain "and", so try every split)
    const have = out.map(nameKey), inList = p => have.includes(nameKey(p)) || [...p.matchAll(/\band\b/gi)].some(m => inList(p.slice(0, m.index)) && inList(p.slice(m.index + 3)));
    const want = (Array.isArray(nseNames) ? nseNames : String(nseNames || "").split(/\s*[,;]\s*/)).map(x => x.trim()).filter(Boolean);
    if (!want.every(inList)) continue;
    return out.map(n => want.find(w => nameKey(w) === nameKey(n) && w !== w.toUpperCase() && /^[A-Za-z0-9][A-Za-z0-9&.,'()\- ]*$/.test(w)) || n);   // NSE's spelling of a name when it has one (GYR, IIFL ...)
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
    const leadManagers = parseLeadManagers(text, r.info?.["Book Running Lead Managers"]);
    if (!company && !registrar && !leadManagers) continue;
    cache[r.symbol] = { ...(cache[r.symbol] || {}), company: company || cache[r.symbol]?.company || null, registrar: registrar || cache[r.symbol]?.registrar || null, ...(leadManagers || cache[r.symbol]?.leadManagers ? { leadManagers: leadManagers || cache[r.symbol].leadManagers } : {}), at: new Date().toISOString() }; n++;
    console.log("contacts", r.symbol.padEnd(12), company ? "company " + [company.address && "addr", company.phone && "tel", company.email && "mail", company.website && "web"].filter(Boolean).join("+") : "company -", "|", registrar ? "registrar " + [registrar.phone && "tel", registrar.email && "mail", registrar.website && "web"].filter(Boolean).join("+") : "registrar -", "| lead managers", leadManagers ? leadManagers.length : "-");
  }
  await fs.writeFile(file, JSON.stringify(cache, null, 1));
  console.log(`contacts: ${n} issues parsed this run, ${Object.keys(cache).length} in cache`);
}
