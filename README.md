# Trendy IPO

Developed by **Zynora Technology** (Noor).

IPO tracker with a 0–100 score. Everything is fetched automatically — nothing is typed in by hand.
Information only, not investment advice.

## Data pipeline (`npm run refresh`)

| Step | File | Source | Output |
|---|---|---|---|
| 1 | `fetch-nse.mjs` | NSE India public JSON (official): dates, price, lot, subscription by category, demand by price, registrar, lead managers, document links. Both EQ and SME (Emerge) series. Keeps the last good detail per IPO in `nse-history.json` because NSE removes it after listing. | `nse.json`, `docs/rhp_*.zip`, supporting zips |
| 1b | `fetch-bse.mjs` | BSE public issues (official): live + recent IPOs on BSE Main Board and **BSE SME**, details, demand schedule, prospectus zip (BSE-only issues) | `bse.json`, `docs/bse_*.zip/pdf` |
| 2 | `sebi.mjs` | SEBI public-issues pages (official): draft filings (= "to be announced"), RHPs and final Prospectuses | `sebi.json` |
| 2b | `offerdocs.mjs` | Finds each IPO's final Prospectus (preferred) or RHP on SEBI and downloads it when needed | `offer-docs.json`, `docs/sebi_*.pdf` |
| 3 | `docs.mjs` | Picks the best document per IPO (Prospectus > NSE RHP > SEBI RHP > BSE), `pdftotext`, cuts sections, builds an index of all risk-factor titles. Hosts RHP + supporting PDFs for recent IPOs (pruned after 21 days) | `text/<SYMBOL>/*.txt`, `files/<SYMBOL>/` |
| 3b | `logos.mjs` | Company logo: website from the offer document's cover page (matched to the company name so a lead manager's site is never used) → the site's apple-touch-icon / icon, else a favicon service. Saved locally; the app shows initials when there is none | `logos.json`, `logos/<SYMBOL>.*` |
| 4 | `gmp.mjs` | ipowatch.in + investorgain.com: GMP (**unofficial / rumour**, averaged, range kept, daily history) + InvestorGain schedule | `gmp.json` |
| 5 | `quotes.mjs` | Yahoo Finance: day-1 open and last price of closed IPOs (NSE symbol `.NS`, BSE scrip code `.BO`) | `quotes.json` |
| 6 | `extract.mjs` | Offer-document sections → structured fundamentals using `extract-prompt.md`. Backend: `ANTHROPIC_API_KEY`, else a logged-in Claude CLI. Re-extracts when a better document (Prospectus) becomes available | `fundamentals/<SYMBOL>.json` |
| 7 | `verify.mjs` | Checks every extracted figure exists in the offer document + cross-field consistency. `fail` = the app does not use or show that IPO's fundamentals | `verify.json` |
| 8 | `build.mjs` | Merges everything | `ipos.json` (the only file the app reads) |

`npm run live` = fast hourly refresh (NSE without document downloads, BSE, GMP, SEBI, Yahoo, verify, build).
`npm run serve` serves the app on http://localhost:8740.

### Two routes to the live site
1. **Cloud (GitHub Actions)**: the workflow is set to run every hour, but GitHub in practice starts scheduled runs only every ~2–5 hours. It refreshes the data, checks it (`validate.mjs`) and publishes the site.
2. **This PC (backup)**: after each hourly/daily run, `scripts/push-data.cmd` checks the data and pushes it to GitHub (only once a GitHub remote named `origin` exists). It is also the only route for company figures and logos, which need this PC.
A push from this PC also makes the workflow run (it is triggered by pushes to `data/`), so the site does not wait for the next hourly run.
In the app, the 🔄 button re-reads the latest data at any time, and the app re-checks by itself every 5 minutes while it is open.
If both routes merge (PC and cloud push at the same time), `ipos.json` is rebuilt and checked again after the merge before anything is pushed. `prune.mjs` (daily) deletes downloaded documents older than 21 days once their text is extracted, and `scripts/trim-logs.cmd` keeps the logs small.
If neither route updates the data for more than 8 hours, the app shows a red "Data is N hours old" bar.

### Scheduling
Windows Task Scheduler tasks (set to run on battery, hidden window):
- `IPORadar-Live` — every hour → `scripts/run-live.cmd` → `data/logs/live.log`
- `IPORadar-Daily` — 07:30 → `scripts/run-daily.cmd` (full `npm run refresh`) → `data/logs/daily.log`

They only run while the PC is on and you are logged in. `.github/workflows/refresh.yml` is the cloud alternative (hourly live data via GitHub Actions; not tested against NSE/BSE from GitHub's servers).

## Score
Six factors, weights 25/15/20/20/10/10: financials, GMP, subscription, valuation vs peers,
business quality (OFS share, customer/government concentration, high-severity risks, cash flow, promoter holding),
RoNW vs peers. A factor with no data is dropped and the rest re-weighted; below 50% data coverage no score is shown.
Debt/equity uses the figure the offer document reports when present.

## Known limits
- Fundamentals extraction needs a logged-in Claude CLI or `ANTHROPIC_API_KEY`; without it new IPOs have no fundamentals/score until it runs.
- A few BSE issues publish their prospectus link as a web page rather than a zip/pdf (e.g. Black Opal, EIMS): no fundamentals for those.
- Allotment/listing dates come from InvestorGain when available, else are estimated (T+1 / T+3) and marked "(exp.)".
- GMP is rumour data. Scraping ipowatch.in / investorgain.com may break if they change their pages.
- Yahoo's day-1 open can differ from the exchange's discovered listing price.
- The verification proves a number exists in the document, not that it sits under the right label; cross-field checks catch most swaps.

## Documents and full report
- `build.mjs` lists every file published for an issue (RHP/Prospectus, ratios/price-band ads, anchor report, security parameters, bidding centres, forms) plus SEBI/BSE copies and the SEBI filing page, in `ipo.documents`.
- Hosted PDFs live in `data/files/<SYMBOL>/` (recent IPOs only). The GitHub Action does not run `docs.mjs`: run `npm run refresh` locally and push `data/files/` when you want hosted PDFs.
- In the app each IPO has a **Full company report**: a Documents tab (grouped; hosted PDFs can be read or downloaded) and a Company data tab (everything we hold, printable / Save as PDF).

## Company figures without the PC (Gemini)
The workflow `.github/workflows/fundamentals.yml` (every ~3 hours, or "Run workflow" by hand) finds IPOs that have no company figures yet, downloads their offer document,
cuts it into sections, lets Google Gemini read the figures (`pipeline/extract.mjs`, key in the repository secret `GEMINI_API_KEY`, free tier), checks every number against the
document (`pipeline/verify.mjs`) and commits the result; that commit republishes the site. An IPO whose document is not available yet is put on hold
(`data/fundamentals-skip.json`) and retried later. Optional repository variable `GEMINI_MODEL` overrides the model name. The PC route (Claude CLI) still works.
