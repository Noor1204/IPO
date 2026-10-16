// Builds the static site folder (default _site/) that gets published: the app files, data/ipos.json and logos.
// Documents are links to the official NSE / BSE / SEBI files, so nothing big is published.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const out = path.resolve(ROOT, process.argv[2] || "_site");
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, "data", "logos"), { recursive: true });
await fs.mkdir(path.join(out, "icons"), { recursive: true });
for (const f of ["index.html", "style.css", "app.js", "boot.js", "sw.js", "manifest.webmanifest"]) await fs.copyFile(path.join(ROOT, f), path.join(out, f));
for (const f of await fs.readdir(path.join(ROOT, "icons"))) await fs.copyFile(path.join(ROOT, "icons", f), path.join(out, "icons", f));
for (const f of await fs.readdir(path.join(ROOT, "data", "logos")).catch(() => [])) await fs.copyFile(path.join(ROOT, "data", "logos", f), path.join(out, "data", "logos", f));
await fs.copyFile(path.join(ROOT, "data", "ipos.json"), path.join(out, "data", "ipos.json"));
// clickjacking guard: GitHub Pages cannot send frame-ancestors, so the page refuses to run inside someone else's frame
const GUARD = [
  'if (window.top !== window.self) {',
  '  document.documentElement.style.display = "none";',
  '  try { window.top.location = window.self.location; } catch (e) {}',
  '}', ""].join("\n");
await fs.writeFile(path.join(out, "guard.js"), GUARD);
const idx = path.join(out, "index.html");
await fs.writeFile(idx, (await fs.readFile(idx, "utf8")).replace('<script src="boot.js"></script>', ['<script src="guard.js"></script>', '<script src="boot.js"></script>'].join("\n")));
await fs.writeFile(path.join(out, ".nojekyll"), "");
const j = JSON.parse(await fs.readFile(path.join(out, "data", "ipos.json"), "utf8"));
console.log(`site: ${j.ipos.length} IPOs, ${j.filings.length} filings -> ${out}`);
