# Module API (Stocks, Mutual Fund)

Trendy is a static vanilla-JS app (no build step, no framework). `app.js` is the shell; each extra module is one file `app-<id>.js` that registers itself, and a Node script `pipeline/<id>.mjs` that fetches its data from official free sources into `data/<id>/` (JSON files, committed by a GitHub workflow). The app only reads those JSON files with `fetch("data/<id>/...")`.

## Rules that apply to every module
1. **All data is fetched automatically** from official/free sources by the pipeline script. Never type numbers in by hand. If a source cannot be reached, keep the last good file (the script must not overwrite good data with an empty/garbage result) and exit 0.
2. **Data must be correct.** Validate what you parse (ranges, types, row counts vs previous run, dates). The script must print what it did and refuse to write when the result looks wrong (for example fewer than 70 % of the previous rows). Every number shown in the UI must come from the data file; if a value is missing show "—", never 0 or a guess. State the source and the data date on every screen ("Source: AMFI, NAV as on 20 Oct 2026").
3. **Back button everywhere.** Detail pages use `H.setSub("<key>")` (this adds a browser-history step). The shell draws a visible "← Back" button in `H.head()` for you, and the phone's Back button pops the same history. Never keep a detail page open without using `setSub`. Do not call `history.*` yourself.
4. **Information only.** No buy/sell/target/"tip" language anywhere. Each module screen shows a one-line disclaimer ("Information only, not investment advice").
5. **No `innerHTML` with unescaped data.** Every string from a data file goes through `H.esc()`. Links only through `H.safeUrl()` and `rel="noopener noreferrer" target="_blank"`. No inline `<script>`, no inline event handlers (`onclick=`): the page has a strict CSP (`script-src 'self'`). Use `data-m="<id>"` + `data-...` attributes and handle them in `click(el, H)`.
6. Match the existing look: reuse `H.card`, `H.tbl`, CSS classes already in `style.css` (`.card`, `.row`, `.pill`, `.mut`, `.sm`, `.grn-t`, `.red-t`, `.btn`, `.btn.ghost`, `.stats/.stat`, `.tw` table wrapper). Put new CSS in a clearly marked section appended to `style.css` ONLY under classes prefixed with your module id (for example `.mf-...`). Text must work in light and dark mode (use CSS variables `--tx --mut --card --soft --bd --pri --ok --bad`). Bold, readable text; nothing smaller than 12px.
7. Layout must work from 320 px to 1366 px wide with no horizontal page scroll (wide tables go inside `.tw`).
8. Performance: load big JSON lazily (in `load()` or on first use), cache in memory. Keep each file small (target < 400 KB uncompressed, split by letter/category if needed). Use compact arrays instead of verbose objects for big lists.
9. Only edit the files assigned to you. Do not edit `app.js`, `index.html`, `sw.js`, `docs/`, `.github/`, or other modules. If you need a shell change, say so in your final report instead of making it.

## Registering a module (`app-<id>.js`)
```js
(function () {
  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.mf = {
    id: "mf", label: "Mutual Fund", icon: "💼",
    tabs: [["funds", "Funds"], ["compare", "Compare"], ["sip", "SIP"], ["watch", "Watchlist"]],   // [id, label]; the shell draws the tab strip
    load(H) { /* optional, called once when the module is first opened: fetch data, then H.render() */ },
    render(tab, sub, H) { return H.head("Funds") + "...html..."; },     // tab = "funds"|...; sub = detail key or null; return an HTML string
    click(el, H) { /* el has data-m="mf"; return true if handled */ },
    input(el, H) {},      // optional, for <input data-m="mf" ...> (fires on every keystroke)
    change(el, H) {},     // optional, for <select data-m="mf">, checkboxes
  };
})();
```
Tab ids are fixed (the shell and the bottom bar know them): stocks: market, movers, watch, search; mf: funds, compare, sip, watch.
`render` runs on every re-render (typing in a search box re-renders; keep input focus by giving the input an `id` — the shell restores focus and caret for inputs with an id). Keep UI state (selected fund, query, filters) in a module-local object, not in the DOM.

## Host API `H`
`H.esc(s)` escape · `H.card(title, innerHtml)` · `H.tbl(headers[], rows[][])` · `H.head(title, extraHtml)` page header (Back button + title + the tab strip when not in a detail page) · `H.store.get(k, default)` / `H.store.set(k, v)` (localStorage JSON; prefix keys with your id) · `H.toast(msg)` · `H.render()` re-render · `H.setSub(key|null)` open/close a detail page (history step) · `H.back()` · `H.go(moduleId, tabId)` · `H.hl(text, query | [terms])` escaped HTML with every case-insensitive match wrapped in `<mark class="hl">` (no RegExp from user input; also a global `hl` in app.js) · `H.flash(selector)` scroll the first match into view and flash it once · `H.isNum(x)` · `H.f2(x)` two decimals or "—" · `H.inr(x)` Indian digit grouping · `H.fmtD(isoDate)` · `H.safeUrl(url)` · `H.istDay()` today as `YYYY-MM-DD` in IST · `H.tab` current tab id · `H.sub` current detail key.

## Pipeline script (`pipeline/<id>.mjs`)
Plain Node 22 ESM, no npm packages (use built-in `fetch`; for NSE archive files use `curl` via `execFileSync` with `--http1.1`, a browser User-Agent and `-e https://www.nseindia.com/` like `pipeline/fetch-nse.mjs` does; for zip/csv parse with built-in tools or the system `unzip`/`tar` — the GitHub runner is Ubuntu, the dev machine is Windows with Git-bash). Output only under `data/<id>/`. Idempotent: running it twice does nothing the second time. Prints a short summary. Never throws on a network error (log it and exit 0 with the old files untouched). Must also be safe when the market was closed (holiday/weekend: no new file yet, use the previous trading day's file).

## Local testing
Serve the repo folder with any static server (for example `node -e` with `http`, port of your choice, **not 8740**) and open it with the Playwright browser tools (`file:` URLs are blocked, use `http://127.0.0.1:<port>/`). Test: opens without console errors, every tab, every detail page, the Back arrow and `history.back()` from each detail page, the tab strip, 320 px and 1366 px widths, dark mode (`document.documentElement.dataset.theme = "dark"`), search/filter inputs, and "no data / fetch failed" states (rename the data file temporarily).

The F&O module (app-fno.js, mod-fno.css, pipeline/fno.mjs, data/fno/) was removed in Oct 2026. The shell treats a saved `modLast` key or a history step of an unknown module (e.g. `fno:overview`) as the IPO home (`MODS` / `fixTab` in app.js), so old installs keep working.

## Stocks dashboard (Market tab, Groww-style, no charts)
Sections: Indices (scroll-snap card row, "All indices" = sub page `indices`), Net FII & DII (`data/stocks/fiidii.json`, "View more" = sub page `fiidii`), Top gainers / Top losers / Most traded by volume (chips Large / Mid / Small = NIFTY 100 / MIDCAP 150 / SMALLCAP 250 from `data/stocks/caps.json`, "See more" opens the Movers tab with that list and cap), plain 52-week high / low rows. Charts exist only on the stock and index pages. Rows come from the live snapshot when usable, else from `list.json` (columns symbol,name,series,close,chgPct,volume,valueCr,prevClose) joined with caps. `pipeline/stocks.mjs` writes `caps.json` (weekly refresh, counts validated) and `fiidii.json` (NSE `api/fiidiiTradeReact` gives only the latest day, so it accumulates one row per trading day, 60 kept). `STOCKS_FORCE=1 node pipeline/stocks.mjs` rewrites the day's files even when the trade date is unchanged.

## Movers (full lists)
The Movers tab lists every stock, not only a top 50: gainers (change > 0, % descending), losers, most active, by volume (cap chips All / Large / Mid / Small; the dashboard keeps the top 5 of each and "See more" opens this list). `Live` mode = all rows of the live snapshot (NIFTY 500 + F&O + Smallcap 500 + recent IPOs + the market's top movers), `Last close` = all main-board stocks of `list.json` (EQ, BE, BZ; SME series are not listed). Rows under Rs 10 lakh traded carry an `illiquid` tag; the toggle "Hide very low volume" (default off) hides them. First 50 rows are rendered, 100 more are appended to the DOM when the reader scrolls near the end (or with the button). The search box, mode control and rows live in separate `data-lvr` regions, so a snapshot swaps only the rows and keeps the typed text and scroll position. Search matches symbol or name, highlights with `H.hl`, and pins an exact symbol (or the most traded name starting with the text) as "Best match". Arriving from the global search ("See all in ...") scrolls to the first match and flashes it (`input` elements get `data-arrive="1"` from `prefill()`).
