# Trendy IPO: security notes

Developed by Zynora Technology (Noor). The site is static (HTML, CSS, JavaScript and JSON files): there is no server code, no database, no login and no API key on the site, so there is nothing to break into on a server and no user data is collected.

## What protects the site

| Risk | Protection |
|---|---|
| Malicious text in the data (XSS) | Every string loaded from `data/ipos.json` is cleaned on load (`<`, `>`, `"` replaced, `javascript:` / `data:` values emptied) and escaped again wherever it is placed in HTML (`esc()`). Tested with a deliberately poisoned data file: nothing executed. |
| Injected scripts | Content-Security-Policy in `index.html`: scripts only from the site itself, no inline scripts, no inline event handlers, no plugins, no outside connections, no form posts. |
| Dangerous links | Document and filing links must be `https://` (or the site's own logo folder). External links open with `rel="noopener noreferrer"` and the page sends no referrer. |
| Clickjacking | The published site refuses to run inside another site's frame (`guard.js`, added by `make-site.mjs`). |
| Bad or hijacked data source | `pipeline/validate.mjs` runs in the hourly job before anything is committed: markup or scripts in the data, links to unknown hosts, impossible numbers (negative price, 99999x subscription), or a sudden drop in the number of IPOs make the job fail. The last good data stays live. |
| Someone changing the data on the site | The data only changes through commits to the GitHub repository. Protect the account (see below). |
| Supply chain | No npm dependencies at all. The workflow uses only GitHub's own actions. |
| Over-powerful automation | The workflow starts with no permissions; the build job can only write repository contents, the deploy job can only publish Pages. |
| Visitor counting | Optional, anonymous (GoatCounter, no cookies, no names). Off until a site code is set in `analytics.js`; the Content-Security-Policy allows only `gc.zgo.at` and `*.goatcounter.com` for it. See ADMIN.md. |
| Secrets | None in the repository. `ANTHROPIC_API_KEY` (only needed to extract company figures on your own PC) is read from your environment and never committed. |

## Do this on GitHub (free)

1. Turn on **two-factor authentication** (Settings -> Password and authentication). This is the single most important step: whoever owns the account owns the data.
2. Do **not** add collaborators. Do not create access tokens you do not need.
3. Repository **Settings -> Branches -> Add branch ruleset** for `main`: block force pushes and deletion.
4. **Settings -> Actions -> General**: "Fork pull request workflows" -> require approval; Workflow permissions -> "Read repository contents" (the workflow asks for more only where needed).
5. Turn on **Settings -> Code security -> Secret scanning / push protection** (free for public repositories).

## What cannot be fully fixed

- GMP is **unofficial rumour data** from InvestorGain / ipowatch. A source can show wrong or manipulated numbers; the app labels it as unofficial and the disclaimer says so. The checks above only catch impossible values, not plausible-looking wrong ones.
- Company figures are extracted from offer documents by an AI model and then compared with the document text (`verify.mjs`). A document containing hidden instructions could mislead the extraction; wrong figures that fail verification are hidden from the app.
- GitHub Pages cannot send HTTP security headers, so the Content-Security-Policy is delivered through a `<meta>` tag (it does not cover `frame-ancestors`; `guard.js` covers that).
- Anyone can copy the public site and its data. The data comes from public sources.

## Reporting a problem

Contact Zynora Technology (Noor).
