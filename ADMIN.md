# Admin dashboard: who visits and what they use

Developed by Zynora Technology (Noor).

Trendy IPO counts **anonymous** visits with [GoatCounter](https://www.goatcounter.com). The counting code is already in the app (`analytics.js`) but stays **off** until you set your own site code. The admin dashboard is GoatCounter's own page, protected by your login.

## Switch it on (5 minutes, free)

1. Go to https://www.goatcounter.com and press **Sign up**.
2. Choose a **Code** (for example `trendyipo`), your email and a password. Your dashboard will be `https://trendyipo.goatcounter.com`.
3. Open `analytics.js` and put the code in the first line: `var CODE = "trendyipo";`
4. Commit and push (or tell Claude to do it). The site updates in about 3 minutes.
5. Open your site, then open the dashboard: you will see yourself as the first visitor. (Visits from `localhost` and from browsers that send "Do Not Track" are never counted.)

## What you will see in the dashboard

| Question | Where |
|---|---|
| How many visitors today / this week / this month | Top chart and the totals |
| Which countries (and regions) they come from | **Locations** |
| Phone or laptop, which browser, screen size | **Browsers**, **Systems**, **Sizes** |
| Where they came from (WhatsApp, Google, a link) | **Sites** (referrers) |
| What they do inside the app | **Pages**: every action below is recorded as a page with this name |

Actions recorded (names are the page paths):

- `tab/compare`, `tab/allot`, `tab/settings`: tabs opened
- `list/live`, `list/upcoming`, `list/listed`: which list they look at
- `ipo/<SYMBOL>`: which IPO's details were opened (so you can see the most-viewed IPOs)
- `apply/<SYMBOL>`: Apply / Pre Apply pressed, per IPO
- `broker/Groww`, `broker/Zerodha` ...: which broker link was used
- `report/<SYMBOL>`, `compare/add`, `watchlist`, `share`, `search`, `refresh`, `language/hi`

## What it does NOT show, on purpose

- **Names, phone numbers, emails.** The app has no sign-in, so nobody's name is known, and the counter never asks for it.
- **Exact location or IP address.** Only country / region, worked out by the counter from the connection, and no IP address is stored.
- **One person's full history.** There are no cookies or user IDs: you see totals, not individual people.

If you ever want names (for example a sign-up form), that is a different feature: it needs the user's clear consent, a privacy policy and a database with its own admin login (India's DPDP Act applies). Ask before building it.

## Notes

- The Privacy card in the app (Settings, English and Hindi) tells users what is counted.
- GoatCounter's free plan is for **non-commercial** use. If Zynora Technology uses this commercially, take their paid plan, or switch to Cloudflare Web Analytics (also free).
- The Content-Security-Policy allows scripts only from this site (the counter is the pinned copy `vendor/goatcounter-count.js`) and `*.goatcounter.com` as the place the counts are sent.
- To switch counting off again, set `CODE` back to `""`.

## Optional Google sign-in (off until you set a client ID)
The sign-in screen (shown once after the welcome screens, with "Skip for now") and the "Sign in" row in the menu appear only when `AUTH.clientId` in `app.js` holds a Google OAuth client ID. Empty = no sign-in anywhere; nothing else changes.
1. Open https://console.cloud.google.com/ with your own Google account, create (or pick) a project, and under *APIs & Services → OAuth consent screen* set it up (External, app name Trendy IPO, your support e-mail, scopes openid / email / profile).
2. *Credentials → Create credentials → OAuth client ID → Web application*. Under **Authorised JavaScript origins** add `https://noor1204.github.io`. Under **Authorised redirect URIs** add exactly `https://noor1204.github.io/IPO/` (with the trailing slash).
3. Copy the client ID (it ends in `.apps.googleusercontent.com`; it is public, not a secret) into `AUTH.clientId` in `app.js` and push. Never put a client *secret* anywhere: this flow does not use one.
4. While the consent screen is in "Testing", only the test users you list can sign in; publish it to let everyone in.
What it does: Google's own page handles the password and returns a signed ID token in the address bar; the app checks issuer, audience, expiry, nonce and Google's RS256 signature (public keys from `www.googleapis.com`), keeps only name and e-mail on this device, removes the token from the address bar and never stores it. There is no server, so signing in does not sync anything yet; syncing the watchlist across devices would need a backend (for example Firestore) and is not built.
