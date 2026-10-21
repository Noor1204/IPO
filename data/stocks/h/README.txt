OHLCV history of the most traded NSE stocks (source: NSE sec_bhavdata_full bhavcopy), built by pipeline/stocks.mjs.
One file per stock: h/<SYMBOL>.json  (use encodeURIComponent(symbol) + ".json"; "M&M" -> "M%26M.json").
Last 260 trading days, adjusted for splits / bonus issues.

Columns (compact, integer arrays):
  s    symbol                                  u  ISO date of the last row           n  number of rows
  p    price scale: price = integer / p        (p is 100, 1000 or 10000)
  t    first date as YYYYMMDD int              g  g[i] = calendar days between row i-1 and row i (g[0] = 0)
  c    close * p
  od   open  - close   (p units, may be negative)
  hd   high  - close   (>= 0)
  ld   close - low     (>= 0)
  v    volume in shares (adjusted: older volume divided by the split factor)
  adj  optional [[YYYYMMDD, factor], ...]: corporate action (split / bonus) ex-dates detected in the window; prices BEFORE that date were
       multiplied by factor, volumes divided by it ("adjusted for split/bonus" in the UI). Missing = nothing detected.

Decode (JavaScript):
  let d = String(j.t), dates = [];                         // YYYYMMDD
  let ms = Date.UTC(+d.slice(0,4), +d.slice(4,6)-1, +d.slice(6,8));
  for (let i = 0; i < j.n; i++) { ms += j.g[i] * 864e5; dates.push(new Date(ms)); }
  open[i] = (j.c[i] + j.od[i]) / j.p;  high[i] = (j.c[i] + j.hd[i]) / j.p;  low[i] = (j.c[i] - j.ld[i]) / j.p;  close[i] = j.c[i] / j.p;  volume[i] = j.v[i];

A day on which the stock did not trade (or a row that failed validation: non-positive price, low > open/close/high, negative volume) is simply absent.
Stocks that entered the tracked list recently have fewer rows (n < 260).
Per-stock summary stats (1W..1Y change %, 20-day average volume, turnover rank) are the last column of the rows in ../d/<first letter>.json:
  stats = [ret1w, ret1m, ret3m, ret6m, ret1y, ret3y, avgVol20, turnoverRank]   (ret3y is always null: the archive window is 260 days)
Index history lives in ../idx/ (same columns, plus nm = name; v may be missing).
