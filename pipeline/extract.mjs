// Step 4: turn RHP sections into structured fundamentals with an LLM. Skips IPOs that already have data/fundamentals/<SYMBOL>.json.
// Backends (first one available wins):
//   1. ANTHROPIC_API_KEY            -> Anthropic API (pay per use)
//   2. Claude Code CLI (logged in)  -> runs on your existing Claude plan, no extra payment. Path: CLAUDE_BIN, `claude` on PATH,
//                                      or the copy bundled with the Claude desktop app (%APPDATA%\Claude\claude-code\<ver>\claude.exe)
// The prompt (pipeline/extract-prompt.md) is the same for both.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const MODEL = process.env.EXTRACT_MODEL || "claude-sonnet-5-5";
const key = process.env.ANTHROPIC_API_KEY;
const gkey = process.env.GEMINI_API_KEY;        // Google Gemini (free tier): used by the GitHub workflow so nothing needs the PC
const prompt = await fs.readFile(path.join(import.meta.dirname, "extract-prompt.md"), "utf8");
await fs.mkdir(path.join(DATA, "fundamentals"), { recursive: true });

function findCli() {
  const cands = [process.env.CLAUDE_BIN];
  const base = process.env.APPDATA && path.join(process.env.APPDATA, "Claude", "claude-code");
  if (base && fsSync.existsSync(base)) {
    const vers = fsSync.readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    const exe = process.platform === "win32" ? "claude.exe" : "claude";
    for (const v of vers) {                                            // newer app versions keep the binary one folder deeper: claude-code\<ver>\<hash>\claude.exe
      cands.push(path.join(base, v, exe));
      try { for (const h of fsSync.readdirSync(path.join(base, v))) cands.push(path.join(base, v, h, exe)); } catch {}
    }
  }
  cands.push("claude");
  return cands.find(c => c && (c === "claude" ? spawnSync(c, ["--version"], { stdio: "pipe" }).status === 0 : fsSync.existsSync(c))) || null;
}
const cli = key || gkey ? null : findCli();

async function viaApi(user) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 12000, temperature: 0, system: prompt, messages: [{ role: "user", content: user }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.status);
  return j.content.map(c => c.text || "").join("");
}
// Gemini REST API. Tries the configured model first, then the usual fallbacks; waits and retries when the free tier says "slow down" (429 / 503).
const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com";
const GEMINI_MODELS = [...new Set([process.env.GEMINI_MODEL, "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"].filter(Boolean))];
async function viaGemini(user) {
  let last = "no model worked";
  for (const model of GEMINI_MODELS) {
    for (let k = 0; k < 4; k++) {
      let r, j;
      try {
        r = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: { "x-goog-api-key": gkey, "content-type": "application/json" }, signal: AbortSignal.timeout(300000),
          body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 32000 } }),
        });
        j = await r.json();
      } catch (e) { last = e.message; await new Promise(x => setTimeout(x, 20000)); continue; }
      if (r.status === 429 || r.status === 503) { last = j.error?.message || "HTTP " + r.status; await new Promise(x => setTimeout(x, 30000 * (k + 1))); continue; }
      if (r.status === 404) { last = `model ${model} not available`; break; }                 // try the next model name
      if (!r.ok) throw new Error(j.error?.message || "Gemini HTTP " + r.status);
      const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (!text) { last = "empty answer (" + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || "?") + ")"; break; }
      return text;
    }
  }
  throw new Error("Gemini: " + last);
}
function viaCli(user) {
  const p = spawnSync(cli, ["-p", "--model", "sonnet", "--output-format", "text"], { input: `${prompt}\n\n----- INPUT -----\n${user}`, encoding: "utf8", maxBuffer: 1 << 26, timeout: 15 * 60 * 1000 });
  const out = (p.stdout || "").trim();
  if (/not logged in|\/login/i.test(out)) throw new Error("Claude CLI is not logged in. Open a terminal, run the CLI once and complete /login (uses your Claude plan).");
  if (p.status !== 0 && !out.includes("{")) throw new Error((p.stderr || out || "claude CLI failed").slice(0, 300));
  return out;
}

const exists = f => fs.access(f).then(() => true, () => false);
const dirs = await fs.readdir(path.join(DATA, "text")).catch(() => []);
const todo = [];
const srcKind = async sym => (await fs.readFile(path.join(DATA, "text", sym, "source.txt"), "utf8").catch(() => "")).trim();
for (const sym of dirs) {
  const fp = path.join(DATA, "fundamentals", `${sym}.json`);
  if (!(await exists(fp))) { todo.push(sym); continue; }
  const have = JSON.parse(await fs.readFile(fp, "utf8")).source_doc, best = await srcKind(sym);
  if (best && have !== best) todo.push(sym);            // e.g. extracted from the RHP, the final Prospectus is now available
}
if (!todo.length) { console.log("extract: nothing new"); process.exit(0); }
if (!key && !gkey && !cli) { console.log(`extract: ${todo.length} IPO(s) need extraction (${todo.join(", ")}) but no backend found. Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY, or install/login Claude Code (no extra cost on a Claude plan).`); process.exit(0); }
console.log(`extract: using ${key ? "Anthropic API" : gkey ? "Gemini API" : "Claude CLI " + cli} for ${todo.length} IPO(s)`);

const NEEDED = ["financials", "basis", "objects", "business", "risks"];
for (const sym of todo) {
  let body = "";
  for (const k of NEEDED) body += `\n\n===== ${k.toUpperCase()} SECTION =====\n` + (await fs.readFile(path.join(DATA, "text", sym, `${k}.txt`), "utf8").catch(() => "(not found)"));
  try {
    const user = `Symbol: ${sym}\n${body}\n\nReturn the JSON object now.`;
    const text = key ? await viaApi(user) : gkey ? await viaGemini(user) : viaCli(user);
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!data.financials || !data.periods) throw new Error("missing financials/periods");
    data.source_doc = await srcKind(sym);
    await fs.writeFile(path.join(DATA, "fundamentals", `${sym}.json`), JSON.stringify(data, null, 1));
    console.log("extracted", sym);
    if (gkey && !key) await new Promise(x => setTimeout(x, 15000));            // stay under the free tier's requests-per-minute
  } catch (e) { console.log("extract failed", sym, "-", e.message); if (/not logged in/i.test(e.message)) break; }
}
