// Used by the "Fundamentals" GitHub workflow so it only downloads and extracts when there is something to do.
//   node pipeline/need-fundamentals.mjs check   -> prints the IPOs that still have no company figures; sets need=yes|no for the workflow
//   node pipeline/need-fundamentals.mjs mark    -> after a run: an IPO that still has none is put on hold (retry in 6 h for live / upcoming, 24 h for older ones)
//                                                  so a missing offer document is not re-downloaded every time
import fs from "node:fs/promises";
import path from "node:path";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const mode = process.argv[2] || "check";
const read = async (f, d) => JSON.parse(await fs.readFile(path.join(DATA, f), "utf8").catch(() => JSON.stringify(d)));
const j = await read("ipos.json", { ipos: [] });
const skip = await read("fundamentals-skip.json", {});
const has = s => fs.access(path.join(DATA, "fundamentals", `${s}.json`)).then(() => true, () => false);
const dayMs = 864e5, now = Date.now();

const cands = [];
for (const i of j.ipos || []) {
  if (!i.symbol || i.symbol.startsWith("IG-")) continue;                                    // known only from InvestorGain: no NSE offer document
  const recent = i.status !== "listed" || !i.close || now - new Date(i.close).getTime() < 45 * dayMs;
  if (!recent || (await has(i.symbol))) continue;
  cands.push(i);
}
const hold = i => (i.status === "listed" ? 24 : 6) * 36e5;
const due = cands.filter(i => !skip[i.symbol] || now - skip[i.symbol] > hold(i));

if (mode === "mark") {
  const next = {};
  for (const i of cands) next[i.symbol] = skip[i.symbol] && now - skip[i.symbol] <= hold(i) ? skip[i.symbol] : now;
  await fs.writeFile(path.join(DATA, "fundamentals-skip.json"), JSON.stringify(next, null, 1));
  console.log(`on hold: ${Object.keys(next).length} IPO(s) without company figures`);
} else {
  console.log(due.length ? `need figures for: ${due.map(i => i.symbol).join(", ")}` : "nothing to extract");
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `need=${due.length ? "yes" : "no"}\n`);
}
