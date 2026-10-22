# Live (near-live) market snapshot

A snapshot of NSE's public website data about every 100 seconds during market hours, visible in the app roughly 2-4 minutes after the exchange. **This is not real-time**: no ticks, no streaming. Every screen using it must show the snapshot time (`TrendyLive.badge()`).

## How it works
1. `.github/workflows/live.yml` runs a chain: each run starts `pipeline/live.mjs`, publishes the result, waits until ~100 s after the run started and starts the next run (`gh workflow run`). GitHub's cron (`*/20 3-10 * * 1-5` UTC) only restarts the chain if it broke. Runs exit quietly outside Mon-Fri 09:00-15:50 IST.
2. `pipeline/live.mjs` fetches, validates and writes `meta.json`, `market.json`, `oc-<SYMBOL>.json` into `LIVE_OUT` (`_live/`, untracked).
3. The workflow turns `_live` into a one-commit repository and force-pushes it to the **orphan branch `live`** (history is replaced every time, the repo does not grow), then purges jsDelivr per file.
4. The browser (`live.js`, `window.TrendyLive`) reads `https://cdn.jsdelivr.net/gh/Noor1204/IPO@live/<file>` and falls back to `https://raw.githubusercontent.com/Noor1204/IPO/live/<file>` (override with `window.TRENDY_LIVE_BASE`, string or array). It polls the tiny `meta.json` first and downloads `market.json` only when `fetchedAt` changed.

Delay budget: NSE -> run (up to ~100 s between runs + ~20-30 s fetch) -> CDN purge (seconds; raw.githubusercontent may cache up to 5 min) -> client poll (60 s).

## NSE endpoints used (all from nseindia.com, after a first GET of `/market-data/live-equity-market` for cookies)
| Data | URL |
|---|---|
| market status | `/api/marketStatus` |
| indices | `/api/allIndices` |
| stock quotes | `/api/NextApi/apiClient/marketWatchApi?functionName=getIndicesData&symbol=NIFTY%20500` and `...&symbol=SECURITIES%20IN%20F%26O` |
| expiry list | `/api/option-chain-contract-info?symbol=NIFTY` (only when the stored expiry list is not from today) |
| option chain | `/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=27-Oct-2026` (one request per expiry; two expiries per index) |

Note: the older `/api/equity-stockIndices` and `/api/option-chain-indices` endpoints answer 404 "Resource not found" (verified Oct 2026); the endpoints above are what NSE's current pages call. Requests per run: 13 (17 on the first run of a day, when the four expiry lists are fetched). About 0.35 s pause between requests, 3 tries with 0.8/1.6/3.2 s backoff, 20 s per-request timeout, cookies refreshed after any non-OK answer, total budget 100 s.

## Files
### `meta.json` (~0.2 KB, polled first)
`{"v":1,"asOn":"2026-10-21T15:40:31+05:30","fetchedAt":"2026-10-21T16:39:59Z","marketOpen":false,"marketState":"Closed","counts":{"stocks":501,"indices":139,"chains":{"NIFTY":248,...}}}`
`asOn` is NSE's own time (NIFTY 500 index row), `fetchedAt` is when we fetched, `marketOpen` is NSE's Capital Market status.

### `market.json` (~70 KB)
`{meta, idxCols, indices, cols, colNotes, stocks, top}`; `meta` = `{asOn, fetchedAt, marketStatus:{state,text}, quotesUpTo, source, ivNote}`.
- `idxCols`: `name, grp, last, chg, pct, o, h, l, pc, yh, yl, pe, pb, dy, adv, dec, p365, p30` (grp: derivatives / broad market / sectoral / strategy / thematic / fixed income; p365/p30 = 1-year / 30-day change %).
- `cols` (stocks, one array per symbol, NIFTY 500 plus the F&O list merged by symbol): `s, c, ch, p, o, h, l, pc, v, tv, wh, wl, y1, m1, fo, t` = symbol, last, change, change %, open, high, low, previous close, volume, traded value (Rs crore), 52-week high, 52-week low, 1-year change %, 30-day change %, in F&O list (1/0), quote time HH:MM IST. Missing values are `null`.
- `top`: symbol lists `gainers, losers, active, high52, low52` (liquid stocks only).

### `oc-<SYMBOL>.json` (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY; 7-16 KB each)
`{meta:{symbol, asOn, fetchedAt, underlying, ivNote, pcrNote}, exps, expsAt, cols, tot, expiries}`; `expiries` = the nearest two expiries `{e:"2026-10-27", coi, poi, pcr, mp, n, strikes}`; `tot` = call/put OI and PCR over the kept expiries.
Strike row `cols`: `k, coi, cdoi, cvol, civ, cltp, poi, pdoi, pvol, piv, pltp` = strike, call OI, call change in OI, call volume, call IV, call LTP, then the same for puts. OI is in contracts as NSE publishes it. IV is **as published by NSE** (0 becomes `null`); we do not compute it.
PCR = put OI / call OI (3 decimals). Max pain = strike with the lowest total payout of option writers (sum of OI x intrinsic value, ties go to the lowest strike): identical definitions to `pipeline/fno.mjs`. Both are computed by us from NSE's OI over all strikes of that expiry and cross-checked against NSE's own totals (the run is refused if they differ by more than 5 %).

## Validation (nothing is written unless all pass; exit code 3)
Required numbers present and plausible; stocks >= 70 % of the previous snapshot (else >= 400), indices >= 70 % (else >= 50), chain strikes >= 70 % of the previous (else >= 20); `asOn` parsable, not in the future (5 min tolerance), not older than 3 weekdays and not older than the previous snapshot; NIFTY 50 / NIFTY BANK / RELIANCE / HDFCBANK present; PCR and OI totals plausible; file size caps (market 350 KB, chain 60 KB). A handful of odd stock rows (up to 1 %, minimum 5) are dropped, more than that refuses the whole run. `meta.json` is written last so the client never sees a half set.

## Failure behaviour
- Exit 3 (NSE down/blocked, bad data, budget used up): the workflow logs a warning, publishes nothing, still waits and starts the next run. The previous snapshot stays on the branch; the client sees it age and `status()` turns `stale` after 12 minutes (inside market hours).
- Client: all fetch errors are swallowed; `status().state` is `unavailable` only when no snapshot was ever fetched. Shapes are validated before use; a corrupt file is ignored and the last good data kept.
- If the chain stops (GitHub outage), the 20-minute cron restarts it in market hours.

## Run locally
```
LIVE_OUT=/tmp/live node pipeline/live.mjs                     # first run
LIVE_PREV=/tmp/live LIVE_OUT=/tmp/live2 node pipeline/live.mjs # second run, compared with the first
LIVE_FAULT=stocks-short|bad-number|future|chain-short|nse-down LIVE_OUT=/tmp/x node pipeline/live.mjs   # fault injection: must exit 3 and write nothing
```
Serve the output with any static server (CORS enabled) and set `window.TRENDY_LIVE_BASE = "http://localhost:8891/"` before `live.js`. `TrendyLive._now = () => epochMs` fakes the clock for tests.

## Client API (`live.js`)
`get()`, `chain(sym)`, `status()` -> `{state: live|stale|closed|unavailable, asOn, ageMin, text}`, `quote(sym)`, `index(name)`, `subscribe(fn[, {status:true}])`, `start()`/`stop()`, `badge(status)`. Polling: 60 s while visible and inside Mon-Fri 09:00-15:50 IST, 5 min outside, none while the tab is hidden. `badge()` returns `<span class="tl-pill tl-<state>">` (dot `tl-dot` inside); style these classes in the app CSS. The status text is re-evaluated only when `status()` is called, so a UI that stays open should call it on a timer or from a `{status:true}` subscriber.

## Limits
Not real-time, not official: these are the JSON files NSE's own pages use, undocumented, may change shape, be rate-limited, or block GitHub's IP ranges at any time (the pipeline then keeps the old snapshot). Information only, not investment advice; data may be delayed or incomplete. Index option chains only (no stock options). Needs the `live` branch and workflow on the default branch of the repository; CSP `connect-src` must allow `https://cdn.jsdelivr.net` and `https://raw.githubusercontent.com`.

## Integration (app)
- `app.js` starts `TrendyLive` once and subscribes (data and status changes) to the current module's optional `livePatch(H)`. IPO screens have none and are never touched.
- `livePatch` swaps only `<div data-lvr="name">` regions whose HTML changed (`display:contents`, no inputs inside) and updates charts through `TrendyCharts.configure` + `auto` (update path, no re-mount). No full render on a snapshot, except the first arrival of an option chain (once, skipped while an input has focus).
- `live.js` additions: `peek()` (sync market object), `asOnDay()`, `usable(eodDate)` (snapshot day >= end-of-day date), `bar({what, eod, fresh})` / `line(...)` (pill + one-line explanation), `paint()` (runs every 30 s: pills and lines age by themselves; pills with `data-tl-static` are skipped). Status texts: "Market closed · showing the last session", "Live data unavailable · showing end-of-day data".
- A screen uses live numbers only when `usable()` is true; otherwise it shows end-of-day numbers and says so. Stocks: indices, movers (NIFTY 500 + F&O stocks, traded value >= 2 crore), stock and index pages (live block + today's partial candle when o/h/l/last are valid and the day is after the last candle). F&O: the four index chains (overview cards, underlying page, Chain tab). Stock option chains stay end-of-day.
- `charts.js`: `bars` accepts negative values (`signed:true` adds "+" to positive readouts); `line` accepts `yearAxis: "YYYY-MM-DD"` (ticks "Year N" counted from that date). Test hook: serve a snapshot directory and set `window.TRENDY_LIVE_BASE` before `live.js`.
