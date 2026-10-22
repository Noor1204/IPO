# Live (near-live) market snapshot

A snapshot of NSE's public website data about every 100 seconds during market hours, visible in the app roughly 2-4 minutes after the exchange. **This is not real-time**: no ticks, no streaming. Every screen using it must show the snapshot time (`TrendyLive.badge()`).

## How it works
1. `.github/workflows/live.yml` runs a chain: each run starts `pipeline/live.mjs`, publishes the result, waits until ~100 s after the run started and starts the next run (`gh workflow run`). GitHub's cron (`*/20 3-10 * * 1-5` UTC) only restarts the chain if it broke. Runs exit quietly outside Mon-Fri 09:00-15:50 IST.
2. `pipeline/live.mjs` fetches, validates and writes `meta.json`, `market.json`, `oc-<SYMBOL>.json` and `intraday.json` into `LIVE_OUT` (`_live/`, untracked).
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

### `intraday.json` (about 10 KB at the first snapshot of the day, ~750-850 KB for a full session)
`{"v":1,"day":"2026-10-22","t":[1427,1428,1437],"s":{"RELIANCE":[1188.2,1188,1190.3],"NIFTY 50":[22621.95,22622,22640.1],...}}`
Today's (IST) price per accepted snapshot, for the app's own intraday chart (TradingView's free widgets do not serve NSE/BSE symbols, so the app cannot embed one). `t` = HHMM integers in IST (NSE's own `asOn` minute, not the fetch time), strictly increasing; `s` = one array per series with one price (2 decimals) or `null` per `t`. Stocks: last traded price (`c`) of every row of `market.json` (~500). Indices: `last`, but only the groups derivatives, broad market and sectoral (45 series; strategy / thematic / fixed-income indices are left out so a full day fits the size cap). Keyed by the same names as `market.json` (symbols, `NIFTY 50` ...). Previous close and day high/low are not stored (they come from `market.json`).
Build rules (`buildIntraday` in `pipeline/live.mjs`): the previous file is read from `LIVE_PREV`; it is used only if it is valid and its `day` is today's IST date (otherwise a new day starts). A point is appended when `asOn` is today, between 09:15 and 15:30, strictly newer than the last `t`, and the market state is Open. A closed market adds nothing, with one exception: a snapshot with `asOn` 15:25-15:30 is still accepted so the closing point is not lost when NSE flips to Closed at the bell (NSE's 15:40 post-close stamps are rejected). A symbol that is new during the day is padded with `null`, a symbol missing from a snapshot gets `null`. When nothing is appended the previous file is re-written unchanged (the published branch is rebuilt from scratch each run, so a file that is not written is lost). Validation before writing: `t` increasing, every series as long as `t`, values positive finite or null, >= 400 series, < 900 KB. On any problem the previous file is kept byte-for-byte and the rest of the snapshot is still published. A previous file that is invalid, from another day, or already over the cap is dropped and a new day starts. After hours, a run with no valid file for today writes none.

### `oc-<SYMBOL>.json` (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY; 7-16 KB each)
`{meta:{symbol, asOn, fetchedAt, underlying, ivNote, pcrNote}, exps, expsAt, cols, tot, expiries}`; `expiries` = the nearest two expiries `{e:"2026-10-27", coi, poi, pcr, mp, n, strikes}`; `tot` = call/put OI and PCR over the kept expiries.
Strike row `cols`: `k, coi, cdoi, cvol, civ, cltp, poi, pdoi, pvol, piv, pltp` = strike, call OI, call change in OI, call volume, call IV, call LTP, then the same for puts. OI is in contracts as NSE publishes it. IV is **as published by NSE** (0 becomes `null`); we do not compute it.
PCR = put OI / call OI (3 decimals). Max pain = strike with the lowest total payout of option writers (sum of OI x intrinsic value, ties go to the lowest strike): identical definitions to `pipeline/fno.mjs`. Both are computed by us from NSE's OI over all strikes of that expiry and cross-checked against NSE's own totals (the run is refused if they differ by more than 5 %).

## Validation (nothing is written unless all pass; exit code 3)
Required numbers present and plausible; stocks >= 70 % of the previous snapshot (else >= 400), indices >= 70 % (else >= 50), chain strikes >= 70 % of the previous (else >= 20); `asOn` parsable, not in the future (5 min tolerance), not older than 3 weekdays and not older than the previous snapshot; NIFTY 50 / NIFTY BANK / RELIANCE / HDFCBANK present; PCR and OI totals plausible; file size caps (market 350 KB, chain 60 KB, intraday 900 KB: an intraday problem never refuses the run). A handful of odd stock rows (up to 1 %, minimum 5) are dropped, more than that refuses the whole run. `meta.json` is written last so the client never sees a half set.

## Failure behaviour
- A run that fails (exit 3) publishes nothing, so the branch `live` keeps the previous `intraday.json`. The workflow clones the branch into `_prev` (3 tries); if the branch exists but cannot be cloned, the run is skipped so `intraday.json` is not reset to one point; only when the branch does not exist yet (very first run) does it start without it.
- Exit 3 (NSE down/blocked, bad data, budget used up): the workflow logs a warning, publishes nothing, still waits and starts the next run. The previous snapshot stays on the branch; the client sees it age and `status()` turns `stale` after 12 minutes (inside market hours).
- Client: all fetch errors are swallowed; `status().state` is `unavailable` only when no snapshot was ever fetched. Shapes are validated before use; a corrupt file is ignored and the last good data kept.
- If the chain stops (GitHub outage), the 20-minute cron restarts it in market hours.

## Run locally
```
LIVE_OUT=/tmp/live node pipeline/live.mjs                     # first run
LIVE_PREV=/tmp/live LIVE_OUT=/tmp/live2 node pipeline/live.mjs # second run, compared with the first
LIVE_FAULT=stocks-short|bad-number|future|chain-short|nse-down LIVE_OUT=/tmp/x node pipeline/live.mjs   # fault injection: must exit 3 and write nothing
```
Test hooks for the intraday step only: `LIVE_FAULT=closed` (it sees state Closed), `LIVE_TEST_ASON=2026-10-22T15:28:00+05:30`, `LIVE_TEST_TODAY=2026-10-23`.
Serve the output with any static server (CORS enabled) and set `window.TRENDY_LIVE_BASE = "http://localhost:8891/"` before `live.js`. `TrendyLive._now = () => epochMs` fakes the clock for tests.

## Client API (`live.js`)
`get()`, `chain(sym)`, `status()` -> `{state: live|stale|closed|unavailable, asOn, ageMin, text}`, `quote(sym)`, `index(name)`, `subscribe(fn[, {status:true}])`, `start()`/`stop()`, `badge(status)`, `intraday()`, `series(name)`. Polling: 60 s while visible and inside Mon-Fri 09:00-15:50 IST, 5 min outside, none while the tab is hidden. `badge()` returns `<span class="tl-pill tl-<state>">` (dot `tl-dot` inside); style these classes in the app CSS. The status text is re-evaluated only when `status()` is called, so a UI that stays open should call it on a timer or from a `{status:true}` subscriber.

### Intraday (client)
`TrendyLive.intraday()` -> Promise of the validated `{v, day, t, s}` or `null`. The first call sets `intradayWanted`; from then on every new snapshot also fetches `intraday.json` (same CDN bases, `?v=<meta.fetchedAt>`, held in memory) and notifies subscribers a second time when it arrived. Pages that never call it never download the file. Validation: `v:1`, valid `day`, strictly increasing HHMM `t` (else the whole file is ignored); a series with the wrong length or a non-positive/non-finite value is dropped. `TrendyLive.series(name)` (sync, after `intraday()` resolved) -> `{day, t:["2026-10-22 09:15", ...], p:[price, ...]}` with null points removed; `null` when absent, fewer than 2 valid points, or `day` differs from the snapshot's day (a stale file is never shown as today's chart). `name` is a stock symbol or the exact index name from `market.json` (e.g. `TrendyLive.index("nifty 50").name`).

## Limits
Not real-time, not official: these are the JSON files NSE's own pages use, undocumented, may change shape, be rate-limited, or block GitHub's IP ranges at any time (the pipeline then keeps the old snapshot). Information only, not investment advice; data may be delayed or incomplete. Index option chains only (no stock options). Needs the `live` branch and workflow on the default branch of the repository; CSP `connect-src` must allow `https://cdn.jsdelivr.net` and `https://raw.githubusercontent.com`.

## Integration (app)
- `app.js` starts `TrendyLive` once and subscribes (data and status changes) to the current module's optional `livePatch(H)`. IPO screens have none and are never touched.
- `livePatch` swaps only `<div data-lvr="name">` regions whose HTML changed (`display:contents`, no inputs inside) and updates charts through `TrendyCharts.configure` + `auto` (update path, no re-mount). No full render on a snapshot, except the first arrival of an option chain (once, skipped while an input has focus).
- `live.js` additions: `peek()` (sync market object), `asOnDay()`, `usable(eodDate)` (snapshot day >= end-of-day date), `bar({what, eod, fresh})` / `line(...)` (pill + one-line explanation), `paint()` (runs every 30 s: pills and lines age by themselves; pills with `data-tl-static` are skipped). Status texts: "Market closed · showing the last session", "Live data unavailable · showing end-of-day data".
- A screen uses live numbers only when `usable()` is true; otherwise it shows end-of-day numbers and says so. Stocks: indices, movers (NIFTY 500 + F&O stocks, traded value >= 2 crore), stock and index pages (live block + today's partial candle when o/h/l/last are valid and the day is after the last candle). F&O: the four index chains (overview cards, underlying page, Chain tab). Stock option chains stay end-of-day.
- Intraday chart (Stocks stock/index pages, F&O underlying page): built from `series()` with `TrendyCharts.line` (`session`, `timeOnly`, `keepHover`, `baseline` + `baselineLabel: "Prev close"`); the body is a `data-lvr` region, so a snapshot updates the chart in place (same canvas, crosshair kept) and swaps the DOM only when it flips between the empty message (< 3 points) and the chart. Default view is Intraday while the market is open (status live/stale) and >= 3 points exist, else Daily. F&O: Futures | Spot line | Intraday; NIFTY -> `NIFTY 50`, BANKNIFTY -> `NIFTY BANK`, FINNIFTY -> `NIFTY FINANCIAL SERVICES`, MIDCPNIFTY -> `NIFTY MIDCAP SELECT`, NIFTYNXT50 -> `NIFTY NEXT 50`, stocks by symbol. BSE Sensex is not available (no live source).
- `charts.js`: `bars` accepts negative values (`signed:true` adds "+" to positive readouts); `line` accepts `yearAxis: "YYYY-MM-DD"` (ticks "Year N" counted from that date). Test hook: serve a snapshot directory and set `window.TRENDY_LIVE_BASE` before `live.js`.
