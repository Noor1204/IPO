// Plain Node tests (no packages): `npm test`. They check the things that broke before: scripts that do not parse, regexes that lost a backslash,
// score weights that no longer add up, files the page or the service worker needs that are missing, and data files with an impossible shape.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const json = f => JSON.parse(read(f));
const exists = f => fs.existsSync(path.join(ROOT, f));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const JS = ["app.js", "app-stocks.js", "app-mf.js", "charts.js", "live.js", "boot.js", "analytics.js", "sw.js"];
const PIPE = fs.readdirSync(path.join(ROOT, "pipeline")).filter(f => f.endsWith(".mjs")).map(f => "pipeline/" + f);

test("every script parses", () => {
  for (const f of JS) assert.doesNotThrow(() => new vm.Script(read(f), { filename: f }), f);
  for (const f of PIPE) assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" }), f);
});

test("no regex that lost its backslash (e.g. /s+/ instead of /\\s+/)", () => {
  // the classic shell-heredoc corruption: split(/s+/), replace(/s+/g...), /^d+/, /d{4}/ ; a real /s+/ is never wanted in this code base
  const bad = [/\.(?:split|replace|match|test)\(\/s[+*]/, /\/\^d[+{]/, /\/d\{\d/, /\(\/\^\[0-9\]\+\(\.d/];
  for (const f of [...JS, ...PIPE]) {
    const t = read(f).split("\n");
    t.forEach((line, k) => { for (const re of bad) assert.ok(!re.test(line), `${f}:${k + 1} looks like a regex that lost a backslash: ${line.trim().slice(0, 100)}`); });
  }
});

test("no inline event handlers or inline scripts (strict CSP)", () => {
  for (const f of ["app.js", "app-stocks.js", "app-mf.js"]) assert.ok(!/\son(click|change|input|load|error)\s*=/i.test(read(f)), f + " has an inline handler");
  const html = read("index.html");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html), "index.html has an inline script");
});

test("score weights add up to 1 and every factor has a label", () => {
  const src = read("app.js"), w = src.match(/const WEIGHTS = (\{[^}]*\})/)?.[1], l = src.match(/const FACTOR_LABEL = (\{[^}]*\})/)?.[1];
  assert.ok(w && l, "WEIGHTS / FACTOR_LABEL not found");
  const W = vm.runInNewContext("(" + w + ")"), L = vm.runInNewContext("(" + l + ")");
  assert.ok(Math.abs(Object.values(W).reduce((a, b) => a + b, 0) - 1) < 1e-9, "weights must sum to 1");
  assert.deepEqual(Object.keys(W).sort(), Object.keys(L).sort());
  assert.equal(L.peers, "RoNW vs peers");
});

test("page and service worker only reference files that exist", () => {
  const html = read("index.html");
  for (const m of html.matchAll(/(?:src|href)="([^"#?:]+\.(?:js|css|webmanifest|png|woff2))"/g)) assert.ok(exists(m[1]), "index.html -> " + m[1]);
  const sw = read("sw.js"), shell = sw.match(/const SHELL = (\[[^\]]*\])/)?.[1];
  assert.ok(shell, "SHELL list not found");
  for (const f of vm.runInNewContext(shell)) if (f !== "./") assert.ok(exists(f), "sw SHELL -> " + f);
  assert.match(sw, /const CACHE = "ipo-radar-v\d+"/);
});

test("every icon the code uses exists in the sprite", () => {
  const sprite = new Set([...read("index.html").matchAll(/<symbol id="ti-([a-z0-9-]+)"/g)].map(m => m[1]));
  const used = new Set();
  for (const f of ["app.js", "app-stocks.js", "app-mf.js"]) for (const m of read(f).matchAll(/\bic\("([a-z0-9-]+)"/g)) used.add(m[1]);
  const missing = [...used].filter(n => !sprite.has(n));
  assert.deepEqual(missing, [], "icons missing from the sprite: " + missing.join(", "));
});

test("data/ipos.json is well formed", () => {
  const d = json("data/ipos.json"), L = d.ipos;
  assert.ok(Array.isArray(L) && L.length > 5);
  const seen = new Set();
  for (const i of L) {
    assert.ok(i.symbol && i.name, "symbol and name");
    assert.ok(!seen.has(i.symbol), "duplicate symbol " + i.symbol); seen.add(i.symbol);
    assert.ok(["live", "upcoming", "listed"].includes(i.status), i.symbol + " status " + i.status);
    for (const k of ["open", "close", "listing"]) if (i[k]) assert.match(i[k], ISO, `${i.symbol}.${k}`);
    if (i.priceLow != null && i.priceHigh != null) assert.ok(i.priceLow <= i.priceHigh && i.priceHigh > 0, i.symbol + " price band");
    if (i.listingPerf) for (const k of ["dayOpen", "ltp"]) assert.ok(Number.isFinite(i.listingPerf[k]) && i.listingPerf[k] > 0, `${i.symbol}.listingPerf.${k}`);
    for (const x of i.bidSplit || []) assert.match(x.id, /^[0-9]+(\.[0-9]+)?\([a-z]\)$/, i.symbol + " bidSplit id");
    for (const [k, v] of Object.entries(i.nseInfo || {})) assert.ok(v === null || (typeof v === "string" && !/\s{2}/.test(v) && v.length <= 300), `${i.symbol}.nseInfo.${k}`);   // double spaces = a letter was lost
  }
});

test("a split sub-row's shares never exceed its category", () => {
  for (const i of json("data/ipos.json").ipos) {
    const q = (i.bidSplit || []).filter(x => x.id.startsWith("1(")).reduce((a, x) => a + x.bid, 0), t = i.bids?.qib?.bid;
    if (q > 0 && Number.isFinite(t) && t > 0) assert.ok(q <= t * 1.001, `${i.symbol}: QIB sub-rows ${q} > QIB ${t}`);
  }
});

test("data/market files are well formed", () => {
  if (exists("data/market/actions.json")) {
    const a = json("data/market/actions.json"); assert.ok(Array.isArray(a.rows));
    for (const r of a.rows) { assert.ok(r.s && r.n && r.t, "action fields"); assert.ok(["rights", "buyback", "bonus", "split", "dividend"].includes(r.k), r.k); assert.match(r.ex, ISO); if (r.rd) assert.match(r.rd, ISO); }
  }
  if (exists("data/market/holidays.json")) for (const r of json("data/market/holidays.json").rows) { assert.match(r.d, ISO); assert.ok(r.name); }
});

test("CSV export protects against spreadsheet formulas", () => {
  // the cell quoting from rpCsv, copied here so a change to it has to change this test
  const src = read("app.js"), m = src.match(/const q = v => \{[^\n]*\n/);
  assert.ok(m, "rpCsv cell function not found");
  const q = vm.runInNewContext("(" + m[0].replace(/^const q = /, "").replace(/;\s*$/, "") + ")");
  assert.equal(q("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(q("-5"), "-5");
  assert.equal(q('a,"b"'), '"a,""b"""');
  assert.equal(q(null), "");
});
