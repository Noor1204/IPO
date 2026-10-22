// Builds the static site folder (default _site/) that gets published: the app files, data/ipos.json and logos.
// Documents are links to the official NSE / BSE / SEBI files, so nothing big is published.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const out = path.resolve(ROOT, process.argv[2] || "_site");
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(path.join(out, "data", "logos"), { recursive: true });
await fs.mkdir(path.join(out, "icons"), { recursive: true });
for (const f of ["index.html", "style.css", "theme.css", "mod-stocks.css", "mod-mf.css", "app.js", "charts.js", "live.js", "app-stocks.js", "app-mf.js", "boot.js", "analytics.js", "sw.js", "manifest.webmanifest"]) await fs.copyFile(path.join(ROOT, f), path.join(out, f));
for (const f of await fs.readdir(path.join(ROOT, "icons"))) await fs.copyFile(path.join(ROOT, "icons", f), path.join(out, "icons", f));
await fs.mkdir(path.join(out, "fonts"), { recursive: true });
for (const f of await fs.readdir(path.join(ROOT, "fonts"))) await fs.copyFile(path.join(ROOT, "fonts", f), path.join(out, "fonts", f));
for (const f of await fs.readdir(path.join(ROOT, "data", "logos")).catch(() => [])) await fs.copyFile(path.join(ROOT, "data", "logos", f), path.join(out, "data", "logos", f));
await fs.copyFile(path.join(ROOT, "data", "ipos.json"), path.join(out, "data", "ipos.json"));
// data of the other modules (Stocks, Mutual Fund): whole folders, if they exist
async function copyTree(a, b) { await fs.mkdir(b, { recursive: true }); for (const e of await fs.readdir(a, { withFileTypes: true })) e.isDirectory() ? await copyTree(path.join(a, e.name), path.join(b, e.name)) : await fs.copyFile(path.join(a, e.name), path.join(b, e.name)); }
for (const d of ["stocks", "mf"]) await copyTree(path.join(ROOT, "data", d), path.join(out, "data", d)).catch(() => {});
// clickjacking guard: GitHub Pages cannot send frame-ancestors, so the page refuses to run inside someone else's frame
const GUARD = [
  'if (window.top !== window.self) {',
  '  document.documentElement.style.display = "none";',
  '  try { window.top.location = window.self.location; } catch (e) {}',
  '}', ""].join("\n");
await fs.writeFile(path.join(out, "guard.js"), GUARD);
const idx = path.join(out, "index.html");
await fs.writeFile(idx, (await fs.readFile(idx, "utf8")).replace('<script src="boot.js"></script>', ['<script src="guard.js"></script>', '<script src="boot.js"></script>'].join("\n")));
// cache-bust: every deploy gets new script / style URLs (?v=<commit>) so a phone or browser never keeps running a stale copy for up to 10 minutes (GitHub Pages sends max-age=600)
{
  const v = String(process.env.GITHUB_SHA || Date.now()).slice(0, 10);
  const html = await fs.readFile(idx, "utf8");
  await fs.writeFile(idx, html.replace(/(<script src="|<link rel="stylesheet" href=")((?!https?:)[^"?]+.(?:js|css))"/g, (m, p, f) => `${p}${f}?v=${v}"`));
}
await fs.writeFile(path.join(out, ".nojekyll"), "");
const j = JSON.parse(await fs.readFile(path.join(out, "data", "ipos.json"), "utf8"));
console.log(`site: ${j.ipos.length} IPOs, ${j.filings.length} filings -> ${out}`);
