// Step 2: pick the best offer document per IPO, convert to text (pdftotext) and cut out the sections needed for analysis.
// Source preference: SEBI final Prospectus (price fields filled in) > NSE RHP zip > SEBI RHP pdf.
// Output: data/text/<SYMBOL>/{basis,financials,risks,business,objects}.txt, rhp_full.txt, source.txt
// Also hosts RHP / supporting PDFs for recent IPOs under data/files/<SYMBOL>/ (pruned after 21 days).
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DATA = path.resolve(import.meta.dirname, "..", "data");
// Windows ships bsdtar (reads zip); Git-bash tar does not, so try explicit paths before falling back to unzip.
function unzip(zip, dest) {
  const tries = [["C:/Windows/System32/tar.exe", ["-xf", zip, "-C", dest]], ["unzip", ["-oq", zip, "-d", dest]], ["tar", ["-xf", zip, "-C", dest]]];
  for (const [cmd, args] of tries) { try { execFileSync(cmd, args, { stdio: "pipe" }); return; } catch {} }
  throw new Error("could not unzip " + zip);
}
const exists = f => fs.access(f).then(() => true, () => false);
import { loadEntries } from "./entries.mjs";
const nse = await loadEntries();   // NSE issues + BSE-only issues
const offerDocs = JSON.parse(await fs.readFile(path.join(DATA, "offer-docs.json"), "utf8").catch(() => "{}"));

// Headings differ per document ("Issue"/"Offer", "OF"/"FOR", "SECTION II -" prefix...). TOC entries are skipped by picking the longest span.
const P = String.raw`(?:SECTION\s+[IVX]+\s*[:\-–—]*\s*)?`;
const rx = body => new RegExp(String.raw`^[ \t\f]*` + P + body + String.raw`[ \t\f\r]*$`, "gmi");
const SECTIONS = {
  basis: [[rx("BASIS (FOR|OF) (THE )?(ISSUE|OFFER) PRICE")], rx("STATEMENT OF (SPECIAL )?TAX BENEFITS"), 70000],
  financials: [[rx("SUMMARY OF (THE )?(RESTATED )?([A-Z]+ (AND )?)*FINANCIAL (INFORMATION|STATEMENTS?)"), rx("SUMMARY FINANCIAL (INFORMATION|STATEMENTS?)"),
    /^.*Summary (of )?Restated (Consolidated |Standalone )?Statements? of Assets (and|&) Liabilities.*$/gmi, /^[ \t\f]*Restated (Consolidated |Standalone )?(Summary )?Statements? of Assets (and|&) Liabilities[ \t\r]*$/gmi], rx("(GENERAL INFORMATION|RISK FACTORS|THE (ISSUE|OFFER)|CAPITAL STRUCTURE|OBJECTS OF THE (ISSUE|OFFER))"), 60000],
  risks: [[rx("RISK FACTORS")], rx("(INTRODUCTION|THE (ISSUE|OFFER)|SUMMARY OF THE (ISSUE|OFFER)|CAPITAL STRUCTURE|GENERAL INFORMATION)"), 45000],
  business: [[rx("OUR BUSINESS")], rx("(KEY (INDUSTRY )?REGULATIONS[A-Z ]*|REGULATIONS AND POLICIES|HISTORY AND CERTAIN CORPORATE MATTERS|OUR MANAGEMENT)"), 45000],
  objects: [[rx("OBJECTS OF THE (ISSUE|OFFER)")], rx("BASIS (FOR|OF) (THE )?(ISSUE|OFFER) PRICE"), 25000],
};

function cut(text, [starts, end, max]) {
  let best = null;
  for (const st of starts) {
    const s = new RegExp(st.source, st.flags); let m;
    while ((m = s.exec(text))) {
      const rest = text.slice(m.index + m[0].length + 200);
      const e = rest.search(new RegExp(end.source, end.flags.replace("g", "")));
      const len = e < 0 ? Math.min(rest.length, max) : e + 200;
      if (!best || len > best.len) best = { at: m.index, len };
    }
  }
  return best ? text.slice(best.at, best.at + Math.min(best.len, max)) : "";
}

// Risk factors are hundreds of pages: a fixed-size slice only covers the first ~6 risks. Instead build an index of ALL numbered
// risk-factor titles (each with its first lines) so the model can pick the most material ones.
function riskIndex(text) {
  const region = cut(text, [SECTIONS.risks[0], SECTIONS.risks[1], 900000]);
  const lines = region.split(/\r?\n/), items = []; let expected = 1, cur = null;   // pdftotext output has Windows line endings
  const flush = () => { if (cur) items.push(cur.join(" ").replace(/\s+/g, " ").slice(0, 600)); cur = null; };
  for (const raw of lines) {
    const l = raw.replace(/\f/g, "");
    const m = l.match(/^\s{0,6}(\d{1,3})\.\s+(\S.*)$/);
    if (m && (+m[1] === expected || (+m[1] === 1 && expected > 5))) { flush(); expected = +m[1] + 1; cur = [`${m[1]}. ${m[2]}`]; continue; }
    if (cur && cur.join(" ").length < 600 && l.trim() && !/^\s*\d{1,3}\s*$/.test(l)) cur.push(l.trim());
  }
  flush();
  const body = items.join("\n---\n");
  return items.length >= 8 ? `INDEX OF ${items.length} RISK FACTOR TITLES (first lines of each; numbering as in the document)\n---\n${body}`.slice(0, 90000) : cut(text, SECTIONS.risks);
}

// A hosted copy of the RHP PDF (data/files/<SYMBOL>/RHP.pdf) is kept only for IPOs that are open, upcoming or closed
// within the last 21 days, so the repository doesn't grow by ~10 MB per IPO forever. Older copies are pruned.
const KEEP_DAYS = 21;
// Hosting PDFs inside the app is off by default (hundreds of MB): the app links to the official NSE / BSE / SEBI files instead. HOST_FILES=1 turns it back on.
const HOST = !!process.env.HOST_FILES;
const closeOf = r => { const m = String(r.info?.["Issue Period"] || "").split(/\s+to\s+/)[1] || r.row?.issueEndDate || r.row?.ipoEndDate; const d = m ? new Date(m.replace(/-/g, " ")) : null; return d && !isNaN(d) ? d : null; };
const isRecent = r => { const c = closeOf(r); return !c || (Date.now() - c) / 864e5 <= KEEP_DAYS; };
await fs.mkdir(path.join(DATA, "files"), { recursive: true });
const keep = new Set(nse.filter(isRecent).map(r => r.symbol));
for (const d of await fs.readdir(path.join(DATA, "files")).catch(() => [])) if (!keep.has(d)) { await fs.rm(path.join(DATA, "files", d), { recursive: true, force: true }); console.log("pruned old hosted docs:", d); }

async function mainPdf(zip, tmp) {
  await fs.rm(tmp, { recursive: true, force: true }); await fs.mkdir(tmp, { recursive: true });
  unzip(zip, tmp);
  const pdfs = []; const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? await walk(p) : /\.pdf$/i.test(e.name) && pdfs.push({ p, size: (await fs.stat(p)).size }); } };
  await walk(tmp);
  const main = pdfs.sort((a, b) => b.size - a.size)[0]; if (!main) throw new Error("no pdf in zip");
  return main;
}
const toText = (pdf, out) => { execFileSync("pdftotext", ["-layout", pdf, out], { stdio: "pipe", maxBuffer: 1 << 28 }); };

for (const r of nse) {
  const sym = r.symbol, out = path.join(DATA, "text", sym), tmp = path.join(DATA, "docs", `_x_${sym}`);
  const nseZip = path.join(DATA, "docs", `rhp_${sym}.zip`);
  const proPdf = path.join(DATA, "docs", `sebi_prospectus_${sym}.pdf`), sebiRhp = path.join(DATA, "docs", `sebi_rhp_${sym}.pdf`);
  const hosted = path.join(DATA, "files", sym, "RHP.pdf");
  const cands = [];
  if (await exists(proPdf) && !offerDocs[sym]?.badProspectus) cands.push({ kind: "Prospectus", pdf: proPdf });
  if (await exists(nseZip)) cands.push({ kind: "RHP", zip: nseZip });
  if (await exists(sebiRhp)) cands.push({ kind: "RHP", pdf: sebiRhp });
  const bseZip = path.join(DATA, "docs", `bse_${sym}.zip`), bsePdf = path.join(DATA, "docs", `bse_${sym}.pdf`);
  if (await exists(bseZip)) cands.push({ kind: "RHP", zip: bseZip, bse: true });
  else if (await exists(bsePdf)) cands.push({ kind: "RHP", pdf: bsePdf, bse: true });
  if (!cands.length) continue;

  const cachedKind = (await fs.readFile(path.join(out, "source.txt"), "utf8").catch(() => "")).trim();
  const needPdf = HOST && isRecent(r) && !(await exists(hosted)) && cands.some(c => c.zip && !c.bse);
  if (!process.env.FORCE && (cachedKind === cands[0].kind || (cands[0].bse && cachedKind)) && (await exists(path.join(out, "basis.txt"))) && !needPdf) continue;   // up to date (FORCE=1 re-cuts sections)
  try {
    await fs.mkdir(out, { recursive: true });
    let text = null, used = null;
    for (const c of cands) {
      let pdf = c.pdf;
      if (c.zip) { const main = await mainPdf(c.zip, tmp); pdf = main.p; if (needPdf && !c.bse) { await fs.mkdir(path.dirname(hosted), { recursive: true }); await fs.copyFile(main.p, hosted); console.log(sym, "hosted RHP.pdf", (main.size / 1048576).toFixed(1), "MB"); } }
      if (cachedKind === c.kind && !needPdf && (await exists(path.join(out, "rhp_full.txt")))) { text = await fs.readFile(path.join(out, "rhp_full.txt"), "utf8"); used = c.kind; break; }
      const txt = path.join(tmp, "doc.txt"); await fs.mkdir(tmp, { recursive: true }); toText(pdf, txt);
      const t = await fs.readFile(txt, "utf8");
      if (c.kind === "Prospectus" && t.length < 400000) { console.log(sym, "SEBI prospectus is only a short document, ignoring it"); (offerDocs[sym] ||= {}).badProspectus = true; continue; }
      // BSE files are named inconsistently: decide RHP vs final Prospectus from the cover page
      const kind = c.bse ? (/RED\s+HERRING/i.test(t.slice(0, 40000)) ? "RHP" : "Prospectus") : c.kind;
      if (t.length < 100000) { console.log(sym, "document text too short, ignoring"); continue; }
      text = t; used = kind; await fs.writeFile(path.join(out, "rhp_full.txt"), t); break;
    }
    if (text === null) throw new Error("no usable document");
    await fs.writeFile(path.join(out, "source.txt"), used);
    const sizes = {};
    for (const [k, def] of Object.entries(SECTIONS)) { const t = k === "risks" ? riskIndex(text) : cut(text, def); sizes[k] = t.length; await fs.writeFile(path.join(out, `${k}.txt`), t); }
    console.log(sym, used, "sections", JSON.stringify(sizes));
  } catch (e) { console.log(sym, "FAILED:", e.message.split("\n")[0]); }
  await fs.rm(tmp, { recursive: true, force: true });
}
await fs.writeFile(path.join(DATA, "offer-docs.json"), JSON.stringify(offerDocs, null, 1));

// ---- supporting documents (ratios, anchor report, security parameters, bidding centres, forms): unzip and host the files
// so users can read / download them inside the app. Only for recent IPOs (older folders were pruned above).
const EXTRA = ["ratios", "anchor", "security", "preanchor", "postanchor", "bidding", "forms"];
const safe = s => s.replace(/[^A-Za-z0-9._-]+/g, "_");
for (const r of nse) {
  if (!HOST || !isRecent(r)) continue;
  for (const key of EXTRA) {
    const zip = path.join(DATA, "docs", `${key}_${r.symbol}.zip`);
    const dest = path.join(DATA, "files", r.symbol, key);
    if (!(await exists(zip)) || (await fs.readdir(dest).catch(() => [])).length) continue;
    const tmp = path.join(DATA, "docs", `_x_${key}_${r.symbol}`);
    try {
      await fs.rm(tmp, { recursive: true, force: true }); await fs.mkdir(tmp, { recursive: true });
      unzip(zip, tmp);
      await fs.mkdir(dest, { recursive: true });
      const files = []; const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? await walk(p) : files.push({ p, name: e.name }); } };
      await walk(tmp);
      for (const f of files) await fs.copyFile(f.p, path.join(dest, safe(f.name)));
      console.log(r.symbol, key, "->", files.map(f => safe(f.name)).join(", "));
    } catch (e) { console.log(r.symbol, key, "FAILED:", e.message.split("\n")[0]); }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
