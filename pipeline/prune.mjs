// Housekeeping so the PC's disk does not fill up: data/docs holds the downloaded offer-document zips and PDFs (about 80 MB per day).
// A file is deleted when it is older than KEEP_DAYS AND the text of that IPO's offer document has already been extracted (data/text/<SYMBOL>/rhp_full.txt),
// because the app and the score only use the text. Nothing in use or still needed for a fresh extraction is touched. `--dry` only lists what would go.
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const DOCS = path.join(DATA, "docs");
const KEEP_DAYS = 21, dry = process.argv.includes("--dry");
const NAME = /^(?:sebi_(?:rhp|prospectus)|rhp|bse|ratios|anchor|security|preanchor|postanchor|bidding|forms)_(.+)\.(?:zip|pdf)$/i;

let freed = 0, removed = 0, kept = 0;
for (const f of await fs.readdir(DOCS).catch(() => [])) {
  const m = f.match(NAME); if (!m) continue;                                   // unknown file names are left alone
  const p = path.join(DOCS, f), st = await fs.stat(p).catch(() => null); if (!st?.isFile()) continue;
  const ageDays = (Date.now() - st.mtimeMs) / 864e5;
  const hasText = await fs.access(path.join(DATA, "text", m[1], "rhp_full.txt")).then(() => true, () => false);
  if (ageDays > KEEP_DAYS && hasText) { freed += st.size; removed++; if (!dry) await fs.rm(p, { force: true }); }
  else kept++;
}
console.log(`prune${dry ? " (dry run)" : ""}: ${removed} files ${dry ? "would be " : ""}removed (${(freed / 1048576).toFixed(0)} MB), ${kept} kept`);
