You are extracting structured data from sections of an Indian IPO Red Herring Prospectus (RHP). The text was produced by `pdftotext -layout`, so tables are often garbled: columns interleave, labels wrap, and values can appear on the line above or below their label. Reconstruct each table carefully by cross-checking numbers (totals must add up, margins must match).

RULES
1. Use ONLY what is in the provided text. Never use outside knowledge. If a value is missing or you are not confident, use `null`. A wrong number is far worse than a null.
2. Money: convert every amount to **₹ crore** (1 crore = 10 million = 100 lakh). RHP tables say "in million" / "in lakh" / "in crore" near the table — check it. Round to 2 decimals.
3. Period arrays are ordered oldest → newest, e.g. ["Mar-24","Mar-25","Mar-26"]. If the RHP also gives a stub period (e.g. June 2026 quarter), ignore it in the arrays and mention it in `notes`.
4. Use **consolidated** figures when both consolidated and standalone exist; say which in `basis`.
5. Percentages are plain numbers (28.79 means 28.79%).
6. `strengths` and `risks` are short plain-English sentences (max 30 words), written for a retail investor. Max 8 strengths. For risks list the 8 most material items, most material first, and include concrete numbers from the RHP (customer concentration %, government dependence %, debt, litigation amounts, related-party dealings, promoter pledges, negative cash flow…). Set severity to "high" | "medium" | "low".
7. Do NOT compute scores, verdicts or recommendations. Only extract.
8. Output ONLY one JSON object, no markdown fences, no commentary.
9. The input says which kind of document it is (SOURCE DOCUMENT: Prospectus or RHP). Copy it into `source_doc`. A final **Prospectus** has the price band, issue price, offer-for-sale size, P/E and post-issue shares filled in: extract them. In an **RHP** those are usually blank: use null.
10. The RISK section is an INDEX of numbered risk-factor titles (each with its first lines), covering the whole risk chapter. Pick the 8 most material ones for a retail investor (concentration, debt, regulatory/government dependence, litigation, related-party dealings, negative cash flow, promoter issues, valuation or dilution). Quote concrete numbers that appear in the title text. Do not invent numbers that are not in the index.
11. SME issues (NSE Emerge / BSE SME) use "lakhs" and may show only 3 fiscal years or a stub period; apply the same unit conversion to ₹ crore (1 crore = 100 lakh). Their "peer" table may be short or missing: use [].
12. Where the document reports a ratio itself (ROCE, RoNW, debt/equity, margins), use the reported figure; do not recompute it unless it is missing.

JSON SHAPE (all keys required; use null / [] when unknown)
{
  "company": string,
  "basis": "Consolidated" | "Standalone",
  "about": string,                       // 2-4 sentences: what the company does, where, scale
  "sector": string,
  "headquarters": string | null,
  "founded_year": number | null,
  "periods": ["Mar-24","Mar-25","Mar-26"],
  "financials": {                        // ₹ crore, aligned with `periods`
    "total_assets": [n,n,n], "revenue": [n,n,n], "other_income": [n,n,n], "ebitda": [n,n,n],
    "pbt": [n,n,n], "pat": [n,n,n], "net_worth": [n,n,n], "reserves": [n,n,n],
    "borrowings": [n,n,n], "cash_and_bank": [n,n,n], "operating_cash_flow": [n,n,n]
  },
  "kpi": {                               // aligned with `periods`, null for unknown entries
    "roce": [..], "ronw": [..], "roe": [..], "eps_basic": [..], "eps_diluted": [..],
    "pat_margin": [..], "ebitda_margin": [..], "debt_equity": [..], "current_ratio": [..],
    "nav_per_share": number | null,
    "pe_pre_ipo": number | null,         // at cap price, if stated
    "pe_post_ipo": number | null,
    "weighted_avg_eps": number | null,
    "other": [{"name": string, "unit": string, "values": [..]}]   // up to 6 operational KPIs
  },
  "peers": [{"name": string, "revenue_cr": number|null, "face_value": number|null, "cmp": number|null, "eps_basic": number|null, "eps_diluted": number|null, "nav": number|null, "pe": number|null, "ronw": number|null}],
  "issue": {
    "price_low": number | null, "price_high": number | null,        // only when the price band is printed (Prospectus)
    "total_issue_cr": number | null,                                // fresh + offer for sale, only when stated
    "fresh_issue_cr": number | null, "ofs_cr": number | null,
    "fresh_issue_shares": number | null, "ofs_shares": number | null,
    "pre_issue_shares": number | null, "post_issue_shares": number | null,
    "face_value": number | null,
    "objects": [{"purpose": string, "amount_cr": number | null}],
    "reservation_pct": {"anchor": number|null, "qib": number|null, "nii": number|null, "retail": number|null, "employee": number|null}
  },
  "promoters": {"names": [string], "holding_pre_pct": number|null, "holding_post_pct": number|null, "background": string|null},
  "concentration": {"top_customers_pct": number|null, "govt_share_pct": number|null, "note": string|null},
  "order_book_cr": number | null,
  "litigation_note": string | null,
  "strengths": [string],
  "risks": [{"title": string, "detail": string, "severity": "high"|"medium"|"low"}],
  "source_doc": "Prospectus" | "RHP",     // copy the SOURCE DOCUMENT given in the input
  "notes": string                        // data caveats, e.g. "FY26 audited; Q1FY27 stub ignored"
}
