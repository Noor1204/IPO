# Trendy charts (`charts.js`, `window.TrendyCharts`)

Dependency-free canvas charts. Load `<script src="charts.js"></script>` (classic script). Styles are injected once as `<style id="tcx-style">` (classes `tcx-*`). Theme (`data-theme`, `prefers-color-scheme`) and size changes redraw automatically. No API throws; bad input shows "Not enough data for a chart".

Times are `"YYYY-MM-DD"` (or `"YYYY-MM-DD HH:MM"`, IST) strings or epoch ms. Numbers use en-IN grouping, prices 2 decimals, missing values show "—". Volumes/OI use K / L / Cr units.

## `TrendyCharts.price(container, opts)` -> `{update(data|opts), setRange(r), setType(t), destroy()}`
```js
const ctl = TrendyCharts.price(el, {
  data: rows,            // [[t, o, h, l, c, v], ...]  (o/h/l may be null = close-only -> line/area, Candles chip disabled; v may be null)
  type: "candles",       // "candles" | "line" | "area"
  ranges: ["1M","3M","6M","1Y","All"],  // calendar from last date; ranges the data cannot cover are hidden + a note; default range "6M" (opts.range)
  volume: true, ma: {sma20: false, sma50: false},   // chips always shown unless ma:false
  prevClose: 1987.8,     // dashed line + used for the last bar's day change
  high52: 2124.2, low52: 1257.4,  // optional dashed labelled lines
  currency: "₹", title: "RELIANCE", subtitle: "NSE · EOD",
  height: 300            // plot height (260 below 420px width); volume adds 70
});
ctl.update(newRows);          // array = new data; object = merge options. Keeps zoom/range if data unchanged
ctl.update({data, prevClose});
ctl.setRange("1Y"); ctl.setType("line"); ctl.destroy();
```
Interaction: hover / touch-drag crosshair (page still scrolls vertically; tap shows it, hides 2.5 s after release), readout row above the plot (date, O H L C, change, volume, active SMAs; last bar when idle), mouse drag = pan, **Ctrl/Cmd + wheel (or wheel while the plot is focused) = zoom** (plain wheel scrolls the page so it never traps scrolling), keyboard: ←/→ move (Shift = 5 bars), Home/End, +/- zoom, Esc hides. Zoomed/panned views un-press the range chips.

## `TrendyCharts.line(container, opts)`
```js
TrendyCharts.line(el, {
  title: "NAV vs benchmark", subtitle: "Example fund", height: 280,
  ranges: ["1M","3M","All"],      // optional chips (omit for none); range: "All"
  baseline: 100,                  // optional dashed line
  series: [
    {name: "NAV", data: [["2026-09-01", 98.2], ...], axis: "left",  fill: true, format: v => v.toFixed(2), color: "#6366f1"},
    {name: "Benchmark", data: [...], axis: "right", color: "#f59e0b"}   // different axis => dual axis
  ]
});
```
One-day (intraday) options: `session: true` fixes the x axis to the NSE session 09:15-15:30 of the data's day (grows only if data lies outside; the right side stays empty until the day completes; hour labels HH:MM at 1/2/3 h steps by width), `timeOnly: true` (readout and crosshair tag show "HH:MM IST"), `baseline` + `baselineLabel: "Prev close"` (dashed line, label "Prev close 1,209"; already included in the y range), `keepHover: true` (an `update()` keeps the crosshair index), per-series `readout: v => text` (readout text only; axis and baseline label keep `format`), `fill: true`. Times are `"YYYY-MM-DD HH:MM"` IST strings.
Readout shows one item per series at the hovered date (value at or before that date). Returns the same controller shape (`update(opts)`, `setRange`, `destroy`).

## `TrendyCharts.bars(container, opts)`
```js
TrendyCharts.bars(el, {
  title: "OI by strike", categories: [23000, 23100, ...],   // numbers or strings
  series: [{name: "Call OI", values: [...]}, {name: "Put OI", values: [...], color: "#10b981"}],  // defaults: rose, emerald
  marker: 24273.4,               // category (or number between numeric categories) -> dashed amber line + pill
  markerLabel: "Spot",           // default "Spot"
  categoryLabel: "Strike ",      // readout prefix
  orientation: "v",              // "h" = categories down the side (scrolls vertically inside its box when > 25)
  height: 280
});
```
Vertical chart scrolls horizontally inside its own box only when there are more than 25 categories (y-axis stays fixed, scrolled to the marker). Hover/tap shows exact values (`3,39,242 (3.39 L)`); ←/→ when focused. Controller: `update(opts)`, `destroy()`.

## Live TradingView embed (DEPRECATED, unused)
**Deprecated:** TradingView's free widgets do not serve NSE/BSE symbols (they show "This symbol is only available on TradingView"). The app no longer calls these; use the intraday line chart below. The functions stay for now and may be removed.
```js
el.innerHTML = TrendyCharts.liveEmbed(TrendyCharts.tvSymbol("stock", "RELIANCE"));  // "" when the symbol is invalid
TrendyCharts.liveEmbedInit(el);   // wires the 8 s "Live chart could not load" fallback (also done by auto())
```
`tvSymbol(kind, sym)`: `stock` -> `NSE:SYM` (`&`/`-` become `_`, e.g. `NSE:M_M`), `index` -> `NSE:NIFTY`, `NSE:BANKNIFTY`, `NSE:CNXFINANCE` (FINNIFTY), `BSE:SENSEX`, `future` -> `NSE:SYM1!`. A value already prefixed `NSE:`/`BSE:` is kept. `liveEmbed` accepts only `/^[A-Z0-9&._-]{1,25}$/` (optional `1!`) with NSE or BSE; opts: `{title, height}`. Needs `frame-src https://s.tradingview.com` in the CSP (already present in index.html).

## Mounting from module screens (innerHTML re-renders)
```js
TrendyCharts.configure("stock-price", {data, title, prevClose});   // any time, before auto()
html = `<div data-tc="price" data-tc-key="stock-price"></div>`;     // also "line" | "bars"
H.render(html); requestAnimationFrame(() => TrendyCharts.auto(document));
```
`auto(root)` mounts each `[data-tc]` element that is new (previous charts whose element was removed are destroyed); an element already mounted is only `update()`d if `configure()` stored a different object since. Safe to call after every render.

Helpers: `TrendyCharts.fmt.{num, price, units, date, change}`.

## Limitations
Time axis uses IST wall-clock; intraday labels only for sub-1.5-day spans. No pinch zoom. Candles with > ~1500 visible bars become 1px wick lines. Bars chart treats negative values as 0. Readouts for `line` use the value at or before the date (step), not interpolation.
