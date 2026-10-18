// Runs the pipeline step by step; a failing step (e.g. NSE unreachable) never stops the others.
//   node pipeline/run.mjs          full daily refresh (documents, extraction ...)
//   node pipeline/run.mjs --live   fast hourly refresh (no document downloads, no extraction)
import { execFileSync } from "node:child_process";
import path from "node:path";
const dir = import.meta.dirname;
const live = process.argv.includes("--live");
const steps = live
  ? [["fetch-nse", "--no-docs"], ["fetch-bse", "--no-docs"], ["gmp"], ["sebi"], ["quotes"], ["verify"], ["build"]]
  : [["fetch-nse"], ["fetch-bse"], ["sebi"], ["offerdocs"], ["docs"], ["logos"], ["gmp"], ["quotes"], ["extract"], ["verify"], ["prune"], ["build"]];
for (const [step, ...args] of steps) {
  console.log(`
── ${step} ──`);
  try { execFileSync("node", [path.join(dir, `${step}.mjs`), ...args], { stdio: "inherit" }); } catch { console.log(`step ${step} failed, continuing`); }
}
