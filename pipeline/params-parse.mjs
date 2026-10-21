// Parser for NSE's "Security Parameters" PDFs (pre-anchor / post-anchor / live). These carry, per issue, the number of shares reserved for each
// main category (QIB, NIB with its 2 sub-categories, Individual/Retail) and the total issue size. For finished SME issues NSE's own bid table
// shows "offered 0", so this is the only official source of the category-wise shares offered.
// parseParams(text, {anchorShares, marketMaker}) -> { qib, nii, bnii, snii, retail, total, marketMaker, anchorExcluded } or null (never a guess).
// Safety: the categories must add up to the document's own total (1+2+3), and the NIB sub-categories to the NIB total (less market maker).
const toNum = s => Number(s.replace(/,/g, ""));

export function parseParams(text, { anchorShares = null, marketMaker = null } = {}) {
  const t = String(text || "").replace(/\r/g, "");
  const heads = [...t.matchAll(/\n[ \t]*Session Details[^\n]*\n/gi)];                         // the table follows the last "Session Details" heading
  const start = heads.length ? heads[heads.length - 1].index : t.search(/Main\s+Category/i); if (start < 0) return null;
  let region = t.slice(start);
  const end = region.search(/Max(?:imum)?\s+Quantity|Category\s+Max|\*\s*Market\s+Maker|\*\s*Above\s+figures/i);
  if (end > 0) region = region.slice(0, end);
  const toks = [];
  for (const m of region.matchAll(/(?<![\d,])(\d{1,3}(?:,\d{2,3})+)(?![\d,])(?=[^\n]{0,70}?Equity|\s+Equity|[^\n]*\n[^\n]{0,40}Equity)/gi)) {
    const v = toNum(m[1]), before = region.slice(Math.max(0, m.index - 90), m.index).replace(/\s+/g, " "), after = region.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/\s+/g, " ");
    if (/anchor[a-z ]{0,30}$/i.test(before)) continue;      // "excluding anchor allocation of 7,52,400 Equity Shares"
    if (anchorShares && v === anchorShares) continue;
    toks.push(v);
  }
  if (toks.length < 4) return null;
  const total = toks[toks.length - 1], rest = toks.slice(0, -1);
  const qib = rest[0], nib = rest[1], tail = rest.slice(2);
  // NIB sub-categories (above 10 lakh / 2-10 lakh): two tokens that add up to the NIB total (less market maker, which NSE adds to the NIB category)
  const mmCands = [0, ...(marketMaker ? [marketMaker] : [])];
  let sub = null, mmUsed = 0;
  outer: for (const mm of mmCands) for (let i = 0; i < tail.length; i++) for (let j = 0; j < tail.length; j++) if (i !== j && tail[i] + tail[j] === nib - mm && tail[i] >= tail[j]) { sub = [tail[i], tail[j]]; mmUsed = mm; tail.splice(Math.max(i, j), 1); tail.splice(Math.min(i, j), 1); break outer; }
  // what remains must be exactly the retail figure and complete the total
  const need = total - qib - nib;
  if (tail.length !== 1 || tail[0] !== need || need <= 0) return null;
  const retail = tail[0];
  if (qib + nib + retail !== total) return null;
  if (!sub && (marketMaker || /market\s+maker/i.test(t))) return null;   // NIB figure includes the market maker and cannot be split safely
  const mm = mmUsed;
  // NIB figure excl. market maker is the one investors compete for
  const niiOffered = sub ? sub[0] + sub[1] : nib;
  if (niiOffered <= 0) return null;
  return { qib, nii: niiOffered, bnii: sub ? sub[0] : null, snii: sub ? sub[1] : null, retail, marketMaker: mmUsed || null, total, nibInDoc: nib };
}
