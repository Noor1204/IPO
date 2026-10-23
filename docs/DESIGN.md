# Trendy design system (theme.css)

`theme.css` loads after `style.css`. It re-defines the old variable names (`--bg --card --soft --tx --mut --bd --pri --ok --bad --warn`) so old rules inherit the new look, then restyles every component. Dark (deep indigo-navy glass) is the signature; light is lavender-tinted white. Theme = system (`prefers-color-scheme`), overridden by `html[data-theme=dark|light]`.

Rules for every screen (owner feedback): no plain white or plain black cards - every surface is tinted with the app indigo/violet family. No on-screen "Back" button (the phone/browser back walks the history). Nothing under 12px. All numbers tabular (`font-variant-numeric: tabular-nums` is set on `body`). Icons only via `H.ic("name")` (Tabler outline sprite in `index.html`, ids `ti-<name>`). Never use emoji as UI icons.

## Tokens
| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | #070b1a | #eceefb | canvas (a fixed radial indigo/violet glow sits on top via `body::before`) |
| `--card` | #10173a | #f6f5ff | solid card colour (inputs, ring centre); for surfaces use `--surf` |
| `--surf` | indigo-navy gradient | lavender-white gradient | default card / row / tile background |
| `--surf-up` / `--surf-dn` | emerald / rose tinted surf | same | gain / loss cards (`.t-up`, `.t-dn`) |
| `--hero` | strong indigo gradient | lavender gradient | hero cards (`.hero`) |
| `--tint` `--tint2` | 10% / 18% indigo | 7% / 13% indigo | inner tiles, inputs, chips (resting) |
| `--soft` | #1a2150 | #ebe8ff | legacy soft fill |
| `--tx` `--mut` | #eef0ff / #a7b0d0 | #12163a / #4f5679 | text / secondary text (both AA on `--surf`) |
| `--bd` `--bd2` | indigo 22% / 40% | indigo 17% / 32% | hairline / emphasised border |
| `--pri` `--pri2` | #8b8cf8 / #9ea0fb | #4f46e5 | links, active text, icons |
| `--grad` | #6366f1 -> #8b5cf6 | same | primary buttons, active pill, avatars |
| `--grad-ok` `--grad-pre` | emerald / slate | same | Apply / Pre-apply |
| `--ok --bad --warn --info` | #34d399 #fb7185 #fbbf24 #60a5fa | #047857 #be123c #b45309 #2563eb | gain, loss, caution, info text |
| `--ok-bg --bad-bg --warn-bg --pri-bg` | 14-18% tints | 10-13% tints | chip / badge backgrounds |
| `--glass` `--glass-bd` | rgba navy .74 | rgba lavender .78 | header, nav bar, toast (with blur) |
| `--shadow` `--shadow-lg` `--glow` | layered | indigo-tinted | elevation 1 / 2 / accent glow |

Radius: `--r-xs 8, --r-sm 12, --r-md 16, --r-lg 20 (cards), --r-xl 24 (sheets), --r-pill 999`.
Spacing: `--s1..--s7 = 4, 8, 12, 16, 24, 32, 48`. Card padding 16, gap between cards 14, page gutter 14 (22 on tablet, 24-56 on laptop).
Type (Inter variable, self-hosted in `fonts/`): `--fs-xs 12, --fs-sm 13, --fs-md 15 (body), --fs-lg 17, --fs-xl 20, --fs-2xl 26, --fs-3xl 34`. Weights: body 500-600, labels 700, numbers/titles 800. Headings `letter-spacing:-.02em`. Page title (`h1`) 22-24px; card title (`h2`) 17px; big stat numerals 24-34px/800.
Elevation: 0 = flat tint; 1 = `--shadow` (cards); 2 = `--shadow-lg` (hover, nav, sheet). Motion: 120-280ms, `--ease`, transform/opacity only; `prefers-reduced-motion` switches animations off.

## Components (class -> use)
- Shell: `.brand` (sticky glass header: `.logomark .wm .ib.sq` bell/menu + `.gsearch` search pill; phone only) · `nav` (floating glass pill on phone; glass top bar on >=960px; `button.on` = gradient pill with label) · `#side .drawer` (sidebar; `.dnav button.on`).
- Page head: `H.head(title)` -> brand + `.top > h1`; module tab strip `.mtabs button.on` (pills); `.seg button.on` segmented control.
- Surfaces: `.card` (default), `.card.hero` (gradient hero), `.card.t-up` / `.t-dn` (gain / loss tint), `.note` (info strip; `.note.topnote` with icon), `.tile` / `.bt` (inner tile with `span` label + `b` value), `.bento` (2/4-col grid of `.bt`), `.kv3` (3 mini stats).
- Lists: `.uprow` (row card), `.ipoc` (IPO card), `.ins` (insight tile), `.sres` (search result row), `.mrow` (menu row inside `.msec`), `.st-row`, `.mf-row` (module rows already inherit the tint).
- Stats: `.stats > .stat(.on)` count tiles (add `class="cu" data-cu="key" data-to="N"` on the number for the count-up), `.tile.ut.ut1/2/3` gradient KPI tiles.
- Chips/badges: `.pill` (board tag), `.st.red|blue|gray|grn` (status), `.badge.g|y|r|gr` (score verdict), `.chip.g|y|r`, `.chipb` (outlined chip button), `.chk` (checkbox pill), `.bd.main|sme`.
- Buttons: `.btn` (gradient primary), `.btn.ghost` (outline), `.btn.sm`, `.btn.wide` (full width), `.btn[data-apply]` (emerald, pulsing glow), `.btn.pre` / `.btn[data-apply].pre` (gray Pre-apply), `.ib.sq` (icon button), `.ib.pillb` (labelled pill button), `.linkbtn`.
- Forms: `input, select` (tinted, 44px), `input[type=checkbox]`, `.switch` (toggle), `.gs-in` (search field).
- Data: `table` inside `.tw` (uppercase muted header, hairline rows), `.bar > i` (progress, animated fill; width via inline style), `.sbar`, `.ring` + `ring(score, big)` (animated conic ring), `.tl > li.done|.now` (timeline), `.sr .sr-h .sr-m` (subscription row), `.reasons`, `.factor`, `.ct .ct-l` (contacts), `.aa .aa-g` (apply-as block), `.mininv`.
- Charts: `.gch` GMP chart (smooth path + gradient fill, hover readout `.gread`), `.tc-*` chart panel (below).
- Feedback: `.modal > .card.sheet` (bottom sheet on phone, centred dialog on laptop; has a `.sheetx` close button), `.toast` (`toast(msg)`; slides up), `.skel`, `.skel-line`, `.skel-row`, `.skel-card` (shimmer skeletons; plain "Loading..." lines are replaced automatically), `.stale` (data-age warning).
- Helpers: `.mut` `.sm` `.num` `.grn-t` `.red-t` `.warn-t` `.sp` (flex spacer) `.row` (flex between) `.chips` (wrap row) `.empty`.
- Motion hooks: `#app.enter0/.enter1` (page enter, added by `render()` on screen change), press feedback (scale .97) on all tappables, hover lift only on laptop with a mouse.

## Chart panel (for the shared chart library and module pages)
```html
<div class="tc-panel">
  <div class="tc-head"><span class="tc-sym">RELIANCE</span><span class="tc-px">1,213.50</span><span class="tc-chg up">+1.2%</span></div>
  <div class="tc-chips" role="group" aria-label="Chart type">
    <button class="on">Candles</button><button>Line</button><span class="sp"></span>
    <button>1M</button><button class="on">3M</button><button>6M</button><button>1Y</button><button>All</button>
  </div>
  <div class="tc-plot"><svg viewBox="0 0 640 260">...</svg></div>   <!-- crosshair line: class "xh"; candles/lines: class "up" (emerald) or "dn" (rose) -->
  <svg class="tc-vol" viewBox="0 0 640 48">...</svg>                 <!-- volume strip, rects with class "vol up|dn" -->
  <div class="tc-readout">12 Oct 2026 - O 1,200 H 1,220 L 1,195 C 1,213.5 - Vol 2.3M</div>
</div>
```
Classes: `.tc-panel` (card), `.tc-head` (symbol / price / change row; `.tc-chg.up|.dn`), `.tc-chips` (type + range toggles, `button.on` gradient), `.tc-plot` (tinted plot area, min-height 220px / 320px on laptop; inside it `.up/.dn` colour candles and lines emerald `#10b981` / rose `#f43f5e`, `.area-up/.area-dn` use gradients `url(#tc-up)` / `url(#tc-dn)` that the library defines as emerald/rose -> transparent, `.vol` strip at 40% opacity, `.xh` crosshair), `.tc-readout` (OHLC/value line under the plot, updated on hover or touch). Text inside the plot is 12px muted. The CSP allows `frame-src https://s.tradingview.com` for an embedded TradingView widget inside `.tc-plot`.

## Adding a new screen
Use `H.head("Title")` first, wrap sections in `H.card(title, html)` (the title gets the icon style), use `.bento > .bt` for key numbers, `.t-up`/`.t-dn` on cards that are gains/losses, `.chips` + `.chipb` for filters, `table` inside `.tw`. Do not set colours or sizes inline; use the tokens above.

## IPO detail page (tabs) and "See more"
The IPO detail screen is a compact hero (`.card.hero`: logo, name, board + status chip, share icon, `.facts` 2x3 grid of `.bt` key facts: issue size, price band, lot size, IPO dates, min. investment, listing; the live countdown `.cd`; a `.kv3` strip GMP / Subscribed / Score; Apply / Pre-apply / status, Watchlist and Compare) followed by a sticky tab bar and ONE tab panel. There is no on-screen Back button and no page header on this screen.

- Tabs: `.dtabs` (pill buttons like `.mtabs`, `role=tablist`, horizontally scrollable, glass background, `position:sticky; top:var(--stk)`; `--stk` is set on `#app` by `detailAfter()`: 0 on phones, the height of the fixed top bar on laptops). Tabs: Overview, Subscription, GMP, Financials, Company, Documents (`DTABS` in app.js). Only the selected panel (`#dpanel.dgrid`) is rendered. The selection lives in `state.dtab` (+ `state.dtabFor` = the IPO it belongs to, `state.dOpen` = open See-more keys); `detail()` resets them when another IPO is opened and `render()` clears them when no IPO is open. Switching a tab calls `setDtab(k)`: a normal re-render, NO history step (`levelKey()` does not contain the tab, so the phone Back button from any tab returns to the list). If the page was scrolled past the hero the tab bar stays pinned and the new tab starts right under it. Arrow / Home / End keys move between tabs. The click is tracked as `ipo/<symbol>/<tab>`.
- Overview: IPO Progress (`.prog`, 4 steps Open / Close / Allotment / Listing, state done / now / next from the dates and the closing time; all six dates behind See more), Trendy IPO Score (`#ai`, ring + verdict; factors and analysis behind "Why this score"), Offer breakup (`.obar` stacked bar + `.ob` legend; NSE bid table shares incl. anchor, else the offer-document reservation %; percentages use the largest-remainder rule so they add up to exactly 100.0; a grey "Not split" / "Other (not stated)" part appears only when the source does not cover the whole issue), Key ratios (`.kr`: P/E, EBITDA, RoNW or ROE, PAT; "—" when missing), IPO Lot Size (`table.lot`, Category / Lots / Shares / Amount = lots x lot x upper price / Profit* = shares x GMP; rows Retail min / max, S-HNI min / max, B-HNI min, Employee and Shareholder max when `applyAs` has them; limits: retail `maxRetailAmount` or 2 lakh, S-HNI from 2 lakh, B-HNI from 10 lakh), Apply as, Anchor investors, listing performance (listed IPOs).
- Subscription: category table, retail allotment chance, Application-wise breakup (only when `bids.*.applications` exist; total = `bids.total.applications` or the sum of the non-overlapping categories), day-wise table and demand by price (both collapsed).
- GMP: chart, sources, GMP x lots, unofficial note (`.calm` empty message without GMP). Financials: `.fch` bar charts (revenue, EBITDA, PAT) + tables. Company: About (4 lines), promoters, strengths, risks, lead managers (first 3 + See more), registrar and contacts. Documents: full-report button and the documents grouped (3 rows + See more per group).

### See more (`mx()` / `moreList()` / `fitMx()` / `toggleMx()` in app.js)
```js
mx(key, innerHtml, { n: 4, sel: "tr", more: "See all figures", less: "See less" })   // first 4 rows (header counts), rest clipped
mx(key, innerHtml, { lines: 4, more: "Show more", less: "Show less" })               // first 4 text lines, faded
mx(key, innerHtml, { n: 0, more: "Why this score" })                                 // hidden completely until opened
moreList(key, itemsHtmlArray, 3, h => `<ul class="lst">${h}</ul>`)                   // first 3 items, "See N more" for the rest
```
Markup: `div.mx#mx-<key>[data-n|data-lines]` + `button.seemore[data-mx=<key>][aria-expanded][aria-controls]`. `key` must be unique on the page. After every render `fitMx()` measures the block, sets `--ch` (collapsed height) and `--fh` (full height), adds `.fit`, and removes the button if nothing would be hidden; fully hidden blocks get `inert` so their links cannot be focused. CSS animates `max-height` 280ms (`.mx.fit`, `.open`, `.open.done` = none after the animation so live content can grow); no animation with reduced motion. Toggling edits the DOM in place (no re-render, no flicker) and stores the key in `state.dOpen`, so a re-render (data refresh, countdown end) re-draws the block open. The printed full report (`detail(true)`) shows every block open and no buttons.
