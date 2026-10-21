// Company logos, fully automatic, for every IPO we show (open, upcoming, closed, Mainboard and SME) and for the "to be announced" SEBI filings.
// Where the company website comes from:
//   1. the offer document's cover page (data/text/<SYMBOL>/rhp_full.txt)
//   2. for SEBI filings: the first pages of the draft prospectus on SEBI (downloaded temporarily, then deleted)
// The website is checked against the company name (page title / domain), then its own icon is used (apple-touch-icon / favicon).
// If that fails, the IPO's logo from its InvestorGain page is used. No logo -> the app shows initials.
// Files are saved locally (data/logos/<KEY>.<ext>) so the app never calls third parties at runtime.
// Output: data/logos.json { KEY: { file, domain, source } }   KEY = exchange symbol, "IG-<id>", or "F-<company-slug>" for filings
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEntries } from "./entries.mjs";

const run = promisify(execFile);
const DATA = path.resolve(import.meta.dirname, "..", "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// websites of registrars, lead managers, exchanges and regulators that also appear on the cover page
const BAD = /kfintech|skylinerta|bigshare|mufg|cameo|purva|maashitla|integratedregistry|beetal|linkintime|sebi\.gov|nseindia|bseindia|nsdl|cdsl|mcsregistrars|accordfin|kosmicrta|\.gov\.in|example|capital|securit|advisor|finserv|fincorp|merchant|jefferies|morganstanley|goldmansachs|bnpparibas|jmfl|nuvama|motilal|iiflcapital|icicisec|axiscapital|kotak|avendus|hsbc|clsa|anandrathi|choiceindia|plindia|ksl|emkay|systematix|pantomath|saffron|gretex|swastika.co.in|hemsec|corporateprofessionals|corporatemakers|fedsec|nexgen|vivro|shannon|oneview|finshore|indorient|masserv|mudrarta|kreocapital|srujan|phillipcap|damcap|beeline|credora|finaax|socradamus|comfort|affinityglobal|serencapital|expertglobal|wealthmine|nirbhay|gyrcapital|sarthi|sobhagya|ibd|grievance|getfive|l\.b\.s|adobe|acrobat|w3\.org|google|microsoft|linkedin|facebook|twitter|youtube|instagram|wikipedia/i;
const GENERIC = new Set(["limited", "ltd", "pvt", "private", "the", "and", "of", "india", "indian", "company", "corporation", "industries", "technologies", "technology", "services", "solutions", "enterprises", "global", "international", "group", "foundation", "holdings"]);
const norm = s => String(s).toLowerCase().replace(/&amp;/g, "and").replace(/\b(limited|ltd|pvt|private|india|the|and)\b/g, "").replace(/[^a-z0-9]/g, "");
const words = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(" ").filter(w => w.length >= 3 && !GENERIC.has(w));
const label = d => d.replace(/\.(co\.in|com|in|org|net|io|asia|co|ai|biz|info)$/i, "").replace(/[^a-z0-9]/g, "");
const fkey = c => "F-" + String(c).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// length of the longest common substring: how much the domain looks like the company name
function lcs(a, b) { let best = 0; const dp = Array(b.length + 1).fill(0); for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0; if (dp[j] > best) best = dp[j]; prev = t; } } return best; }

// every website-looking token in the cover text, ranked by how much it resembles the company name
function domainsFrom(text, name) {
  const t = text.slice(0, 60000);
  const found = [...t.matchAll(/(^|[^@a-z0-9.-])((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|in|co\.in|org|net|io|ai|biz|info|asia|co))(?![a-z0-9-])/gi)]
    .map(m => m[2].replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase()).filter(d => !BAD.test(d) && d.length > 4);
  const n = norm(name), initials = words(name).map(w => w[0]).join("");   // SMT = Sahajanand Medical Technologies
  const ranked = [...new Set(found)].map(d => { let s = lcs(label(d), n); if (initials.length >= 3 && label(d).startsWith(initials)) s = Math.max(s, 4 + initials.length); return { d, s }; });
  return ranked.filter(x => x.s >= 4).sort((a, b) => b.s - a.s);
}
const kind = b => b.length < 4 ? null : b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpg" : b[0] === 0x47 && b[1] === 0x49 ? "gif" : b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 ? "ico"
  : b.subarray(0, 4).toString() === "RIFF" ? "webp" : /<svg[\s>]/i.test(b.subarray(0, 600).toString("utf8")) ? "svg" : null;
const get = async (url, ms = 12000, headers = {}) => { for (let k = 0; k < 2; k++) { try { const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*", ...headers }, redirect: "follow", signal: AbortSignal.timeout(ms) }); return r.ok ? r : null; } catch { await new Promise(r => setTimeout(r, 800)); } } return null; };
async function image(url) { const r = await get(url); if (!r) return null; const b = Buffer.from(await r.arrayBuffer()); const k = kind(b); return k && b.length >= 600 && b.length < 400000 ? { buf: b, ext: k } : null; }

async function home(domain) {
  for (const u of [`https://www.${domain}/`, `https://${domain}/`, `http://www.${domain}/`]) { const r = await get(u); if (r) return { html: (await r.text()).slice(0, 700000), base: r.url }; }
  return { html: "", base: "" };
}
// does the website really belong to this company? strong domain match, or the page title / site name mentions the company
function belongs(h, name, domain, score) {
  if (score >= 7) return true;
  const meta = [/<title[^>]*>([^<]*)/i, /property=["']og:site_name["'][^>]*content=["']([^"']*)/i, /property=["']og:title["'][^>]*content=["']([^"']*)/i].map(re => (h.html.match(re) || [])[1] || "").join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return h.html !== "" && words(name).some(w => meta.includes(w));
}
const attr = (tag, name) => (tag.match(new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")) || []).slice(1).find(Boolean);
const PLACEHOLDER = /vite\.svg|react\.svg|next\.svg|default[-_]?(favicon|icon)/i;
async function iconOf(domain, h) {
  const links = [...h.html.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).map(t => ({ rel: attr(t, "rel") || "", href: attr(t, "href"), sizes: (attr(t, "sizes") || "").match(/^(\d+)x/)?.[1] })).filter(l => l.href && !l.href.startsWith("data:") && !PLACEHOLDER.test(l.href));
  const abs = x => { try { return new URL(x, h.base || `https://${domain}/`).href; } catch { return null; } };
  const apple = links.filter(l => /apple-touch-icon/i.test(l.rel)).sort((x, y) => (+y.sizes || 0) - (+x.sizes || 0))[0];
  if (apple) { const i = await image(abs(apple.href)); if (i) return { ...i, source: "apple-touch-icon" }; }
  const g = await image(`https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&url=https://${domain}&size=128`);          // 404 when the site has no icon
  if (g) return { ...g, source: "favicon service" };
  const icons = links.filter(l => /(^|\s)(shortcut )?icon($|\s)/i.test(l.rel)).sort((x, y) => (+y.sizes || 0) - (+x.sizes || 0));
  for (const l of icons) { const i = await image(abs(l.href)); if (i) return { ...i, source: "site icon" }; }
  const logoImg = [...h.html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]).find(t => /logo/i.test(t) && attr(t, "src") && !attr(t, "src").startsWith("data:"));
  if (logoImg) { const i = await image(abs(attr(logoImg, "src"))); if (i) return { ...i, source: "site logo image" }; }
  const f = await image(abs("/favicon.ico")); if (f) return { ...f, source: "favicon.ico" };
  return null;
}
// the IPO's own logo as shown on its InvestorGain page
async function igLogo(igUrl, name) {
  const r = await get(igUrl, 30000); if (!r) return null;
  const html = (await r.text()).replace(/\\/g, "");
  const n = norm(name);
  for (const m of html.matchAll(/https:\/\/www\.chittorgarh\.net\/images\/ipo\/([a-z0-9-]+?)-logo\.png/gi)) {
    const slug = m[1].toLowerCase(); if (/ipomatrix|ipo-platform|chittorgarh|white-main/.test(slug)) continue;
    const flat = slug.replace(/-/g, ""), first = n.split(" ")[0] || "";
    if (first.length >= 3 ? !flat.includes(first.slice(0, 5)) : lcs(flat, n) < 4) continue;      // the logo's file name must start from the company's own first word (a similar-looking sidebar logo of another IPO is not accepted)
    const i = await image(m[0]); if (i) return { ...i, source: "InvestorGain" };
  }
  return null;
}
// website printed on the first pages of a SEBI draft prospectus (the PDF is downloaded, read for 8 pages and deleted)
async function sebiCoverText(pageUrl) {
  const r = await get(pageUrl, 30000); if (!r) return "";
  const html = await r.text();
  const pdfs = [...html.matchAll(/(?:src|href)=["']([^"']+\.pdf)["']/gi)].map(m => m[1]).filter(u => !/file=/.test(u));
  const raw = pdfs[0] || (html.match(/file=([^"'&]+\.pdf)/i) || [])[1]; if (!raw) return "";
  let url; try { url = new URL(raw, pageUrl).href; } catch { return ""; }
  try {
    let buf = null;                                                                    // whole file: a cut-off PDF has no index and cannot be read; SEBI drops connections now and then, so try twice
    for (let k = 0; k < 2 && !buf; k++) { try { const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(240000) }); if (res.ok) buf = Buffer.from(await res.arrayBuffer()); } catch {} }
    if (!buf) return "";
    const tmp = path.join(DATA, `_cover_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);
    await fs.writeFile(tmp, buf);
    try { return (await run("pdftotext", ["-l", "8", "-layout", tmp, "-"], { maxBuffer: 20000000 })).stdout; } catch (e) { return e.stdout || ""; } finally { await fs.rm(tmp, { force: true }); }
  } catch { return ""; }
}

await fs.mkdir(path.join(DATA, "logos"), { recursive: true });
const map = JSON.parse(await fs.readFile(path.join(DATA, "logos.json"), "utf8").catch(() => "{}"));
const readJson = async (f, d) => JSON.parse(await fs.readFile(path.join(DATA, f), "utf8").catch(() => JSON.stringify(d)));
// targets: exchange IPOs, IPOs only InvestorGain lists (from the last build), and SEBI filings
const targets = new Map();
for (const r of await loadEntries()) targets.set(r.symbol, { key: r.symbol, name: r.name, text: path.join(DATA, "text", r.symbol, "rhp_full.txt") });
const built = await readJson("ipos.json", { ipos: [], filings: [] });
for (const i of built.ipos) {
  const ig = (i.documents || []).find(d => d.source === "InvestorGain")?.url;
  const t = targets.get(i.symbol) || { key: i.symbol, name: i.name, text: path.join(DATA, "text", i.symbol, "rhp_full.txt") };
  targets.set(i.symbol, { ...t, ig });
}
const sebi = await readJson("sebi.json", { filings: [] });
for (const f of sebi.filings || []) { const key = fkey(f.company); if (!targets.has(key)) targets.set(key, { key, name: f.company, filing: f.url }); }

const have = async t => { if (!map[t.key]?.file) return false; try { await fs.access(path.join(DATA, map[t.key].file.replace(/^data\//, ""))); return true; } catch { return false; } };
const queue = []; for (const t of targets.values()) if (process.env.FORCE || !(await have(t))) queue.push(t);
let ok = 0, miss = 0;
async function resolve(t) {
  const why = [];   // printed when nothing is found, to see where it stopped
  let text = t.text ? await fs.readFile(t.text, "utf8").catch(() => "") : "";
  if (!text && t.filing) text = await sebiCoverText(t.filing);
  if (!text) why.push("no document text");
  else {
    const cands = domainsFrom(text, t.name).slice(0, 3);
    if (!cands.length) why.push("no website matching the name in the document");
    for (const c of cands) {
      const h = await home(c.d);
      if (!h.html) { why.push(`${c.d}: site not reachable`); if (c.s < 7) continue; }
      else if (!belongs(h, t.name, c.d, c.s)) { why.push(`${c.d}: site does not mention the company`); continue; }
      const l = await iconOf(c.d, h); if (l) return { ...l, domain: c.d };
      why.push(`${c.d}: no icon`);
    }
  }
  if (t.ig) { const l = await igLogo(t.ig, t.name); if (l) return { ...l, domain: null }; why.push("InvestorGain page has no logo"); }
  return { why: why.join("; ") };
}
await Promise.all(Array.from({ length: 5 }, async () => {
  for (let t; (t = queue.shift());) {
    const l = await resolve(t);
    if (!l || l.why !== undefined) { miss++; console.log("no logo", t.key.padEnd(24), t.name, "->", l?.why || ""); continue; }
    const file = `data/logos/${t.key}.${l.ext}`;
    await fs.writeFile(path.join(DATA, "logos", `${t.key}.${l.ext}`), l.buf);
    map[t.key] = { file, domain: l.domain, source: l.source }; ok++;
    console.log("logo", t.key.padEnd(24), String(l.domain || "-").padEnd(26), l.source, (l.buf.length / 1024).toFixed(1) + " KB");
  }
}));
await fs.writeFile(path.join(DATA, "logos.json"), JSON.stringify(map, null, 1));
console.log(`logos: ${ok} new, ${miss} not found, ${Object.keys(map).length} total`);
