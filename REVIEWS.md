# Public reviews: how it works and how to switch it on

Developed by Zynora Technology (Noor).

Visitors can write a **public review** (stars, optional name, text) in the **Reviews** tab. The admin sees every review in a private **Google Sheet** and gets an **email** for each new one. A review becomes public **only after the admin approves it**, so spam and bad words never reach the site.

```
Visitor writes review -> your Google Sheet (status: pending) + email to you
You change the status to "approved"  -> the review appears in the app for everyone
```

It uses a free Google Sheet and a small Google Apps Script (`reviews-backend/Code.gs`). No extra account is needed beyond your Google account.

## Switch it on (10 minutes, free)

1. Open https://sheets.google.com and create a **Blank** spreadsheet. Name it `Trendy IPO reviews`.
2. Menu **Extensions -> Apps Script**. Delete the sample code, paste the whole content of `reviews-backend/Code.gs`, press **Save** (disk icon).
3. In the toolbar choose the function **setup** and press **Run**. Google asks for permission:
   **Review permissions -> choose your account -> Advanced -> Go to ... (unsafe) -> Allow.**
   (It says "unsafe" only because you wrote the script yourself and Google has not reviewed it.) This creates the `Reviews` tab and a `Summary` tab.
4. Press **Deploy -> New deployment -> (gear icon) Web app**. Set:
   - **Execute as:** Me
   - **Who has access:** Anyone
   then **Deploy** and copy the **Web app URL** (it looks like `https://script.google.com/macros/s/.../exec`).
5. Give that URL to Claude, or put it in `config.js`:
   `window.TRENDY_REVIEWS_URL = "https://script.google.com/macros/s/.../exec";`
   then commit and push. The Reviews tab opens within about 3 minutes.

## Every day: how the admin works

- Open your Google Sheet. New reviews appear in the **Reviews** tab with **Status = pending**, and an email tells you about them.
- To publish one: change **Status** to **approved** (dropdown), or select the rows and use the menu **Reviews -> Approve selected rows**.
- To remove one: set **Status** to **hidden** (the row stays in your sheet but is not shown).
- The **Summary** tab shows the total, the number waiting, the approved ones and the average rating.
- The app shows approved reviews within about 5 minutes (users can also refresh).

## Protection built in

| Risk | What happens |
|---|---|
| Spam / bots | A hidden form field catches bots; links and web addresses are refused; one review per device per 10 minutes; at most 30 reviews per hour for the whole site. |
| Bad or abusive text | Nothing is public until you approve it. |
| Scripts in a review | `<` and `>` are removed on the server, and the app shows review text as plain text only. Tested with poisoned reviews. |
| Fake names / personal data | The name is optional. Users are told not to write phone numbers, emails or links. Emails are never collected. |
| Privacy | Users must tick a consent box, and the Privacy card in Settings (English and Hindi) explains that approved reviews are public. |

## Limits to know

- Anyone who knows the Web app URL can send reviews (it is in the public site code), but only within the limits above, and nothing goes live without you.
- Google allows roughly 100 emails a day from a normal account; the review is saved even if an email cannot be sent.
- If you change `Code.gs` later: **Deploy -> Manage deployments -> edit -> New version -> Deploy** (the URL stays the same).
- The shared Artifact preview page cannot send reviews; only the real site can.
