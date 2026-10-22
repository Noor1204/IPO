/* Trendy near-live market snapshot client (classic script, no dependencies) -> window.TrendyLive
 * Reads the snapshot files that pipeline/live.mjs + .github/workflows/live.yml publish on the branch "live":
 *   meta.json (tiny, polled first), market.json (indices + stocks), intraday.json (today's price points).
 * This is a delayed snapshot taken every ~2 minutes during market hours, NOT real-time ticks. See docs/LIVE.md.
 * Never throws: every fetch error ends up in status(). Strings that reach the DOM through badge() are escaped.
 *
 *   TrendyLive.get()            Promise<market|null>   latest market.json ({meta, idxCols, indices, cols, stocks, top})
 *   TrendyLive.intraday()       Promise<intraday|null> today's price points per snapshot ({v, day, t:[HHMM], s:{SYMBOL|index name: [price|null]}}); the first call turns on
 *                               downloading intraday.json (only pages that ask for it ever download it); refreshed when the snapshot changed
 *   TrendyLive.series("TCS")    sync: {day, t:["YYYY-MM-DD HH:MM", ...], p:[price, ...]} (nulls dropped) for a stock symbol or index name, or null (absent, < 2 valid points,
 *                               or the file is not from the snapshot's trading day)
 *   TrendyLive.status()         {state: "live"|"stale"|"closed"|"unavailable", asOn, ageMin, text}
 *   TrendyLive.quote("TCS")     object keyed by market.cols (s, c, ch, p, o, h, l, pc, v, tv, wh, wl, y1, m1, fo, t) or null
 *   TrendyLive.index("NIFTY 50") object keyed by market.idxCols (name, grp, last, chg, pct, ...) or null
 *   TrendyLive.subscribe(fn[, {status:true}])  fn(market, status) when the snapshot changed (and, with status:true, when the state changed); returns unsubscribe
 *   TrendyLive.start() / stop() polling: 60 s while visible and the IST market window (Mon-Fri 09:00-15:50) is open, 5 min otherwise, none while hidden
 *   TrendyLive.badge(status)    safe HTML for a small pill
 * Config: window.TRENDY_LIVE_BASE = "https://host/path/" (or an array of such bases, tried in order). Default: jsDelivr, then raw.githubusercontent.com.
 * Test hook: TrendyLive._now = () => <epoch ms> fakes the clock.
 */
(function () {
  "use strict";
  var DEFAULT_BASES = ["https://cdn.jsdelivr.net/gh/Noor1204/IPO@live/", "https://raw.githubusercontent.com/Noor1204/IPO/live/"];
  var STALE_MIN = 12, POLL_OPEN = 60e3, POLL_IDLE = 300e3, SCHEMA = 1;
  var L = { _now: null };

  var S = { intraday: null, intradayStamp: null, intradayFlight: null, intradayWanted: false, baseIdx: 0, metaFetched: null, meta: null, market: null, qmap: null, imap: null, err: null, inflight: null, lastRun: 0, subs: [], lastState: null, timer: null, started: false };

  function now() { try { var n = typeof L._now === "function" ? L._now() : L._now; if (typeof n === "number" && isFinite(n)) return n; } catch (e) {} return Date.now(); }
  function bases() {
    var b = window.TRENDY_LIVE_BASE, out = [];
    if (typeof b === "string") b = [b];
    if (!Array.isArray(b) || !b.length) b = DEFAULT_BASES;
    for (var i = 0; i < b.length; i++) if (typeof b[i] === "string" && b[i]) out.push(b[i].replace(/\/*$/, "/"));
    return out.length ? out : DEFAULT_BASES;
  }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function istParts(ms) { var d = new Date(ms + 19800000); return { dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), h: d.getUTCHours(), m: d.getUTCMinutes() }; }
  function inWindow(ms) { var p = istParts(ms); return p.dow >= 1 && p.dow <= 5 && p.min >= 540 && p.min <= 950; }
  function hhmm(ms) { var p = istParts(ms); return (p.h < 10 ? "0" : "") + p.h + ":" + (p.m < 10 ? "0" : "") + p.m; }

  // ---------------------------------------------------------------- fetching
  function getJson(file, validate, ver) {
    // meta.json is polled with a 30 s cache-buster; the big files are asked by the snapshot's own version (?v=<fetchedAt>): the CDN edge keeps ONE copy per snapshot for everybody (fast), and a new snapshot is a new URL (never stale)
    var list = bases(), q = ver ? "?v=" + encodeURIComponent(ver) : "?t=" + Math.floor(now() / 30000);
    var i = 0, off = S.baseIdx % list.length;
    function next(lastErr) {
      if (i >= list.length) return Promise.reject(lastErr || new Error("no source"));
      var bi = (off + i++) % list.length, url = list[bi] + file + q;
      var ac = typeof AbortController === "function" ? new AbortController() : null;
      var timer = setTimeout(function () { try { ac && ac.abort(); } catch (e) {} }, 12000);
      return fetch(url, { cache: "no-store", signal: ac ? ac.signal : undefined, credentials: "omit" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) { clearTimeout(timer); var v = validate(j); if (!v) throw new Error("unexpected shape of " + file); S.baseIdx = bi; return v; })
        .catch(function (e) { clearTimeout(timer); return next(e); });
    }
    try { return next(null); } catch (e) { return Promise.reject(e); }
  }

  // ---------------------------------------------------------------- shape validation (nothing unvalidated is exposed)
  function okMeta(j) {
    if (!j || typeof j !== "object" || j.v !== SCHEMA || typeof j.asOn !== "string" || typeof j.fetchedAt !== "string" || typeof j.marketOpen !== "boolean") return null;
    if (!isFinite(Date.parse(j.asOn)) || !isFinite(Date.parse(j.fetchedAt))) return null;
    return { v: j.v, asOn: j.asOn, fetchedAt: j.fetchedAt, marketOpen: j.marketOpen, marketState: typeof j.marketState === "string" ? j.marketState : "", counts: j.counts && typeof j.counts === "object" ? j.counts : {} };
  }
  function okMarket(j) {
    if (!j || typeof j !== "object" || !j.meta || typeof j.meta.asOn !== "string" || typeof j.meta.fetchedAt !== "string" || !isFinite(Date.parse(j.meta.asOn))) return null;
    if (!Array.isArray(j.cols) || j.cols[0] !== "s" || j.cols.indexOf("c") < 0 || !Array.isArray(j.idxCols) || j.idxCols[0] !== "name" || !Array.isArray(j.stocks) || !Array.isArray(j.indices)) return null;
    var cl = j.cols.length, il = j.idxCols.length;
    var stocks = j.stocks.filter(function (r) { return Array.isArray(r) && r.length === cl && typeof r[0] === "string" && isNum(r[1]); });
    var indices = j.indices.filter(function (r) { return Array.isArray(r) && r.length === il && typeof r[0] === "string" && isNum(r[2]); });
    if (stocks.length < 1 || stocks.length < j.stocks.length * 0.9) return null;
    return { meta: j.meta, cols: j.cols, idxCols: j.idxCols, stocks: stocks, indices: indices, top: j.top && typeof j.top === "object" ? j.top : {}, colNotes: j.colNotes || {} };
  }

  // intraday.json: {v:1, day, t:[HHMM ints, strictly increasing], s:{name:[price|null per t]}}. A series of the wrong length or with a bad value is dropped (never exposed).
  function okIntraday(j) {
    if (!j || typeof j !== "object" || j.v !== 1 || typeof j.day !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(j.day) || !Array.isArray(j.t) || !j.t.length || j.t.length > 600 || !j.s || typeof j.s !== "object" || Array.isArray(j.s)) return null;
    var n = j.t.length, i;
    for (i = 0; i < n; i++) { var x = j.t[i]; if (!(typeof x === "number" && x % 1 === 0 && x >= 0 && x <= 2359 && x % 100 < 60) || (i && !(x > j.t[i - 1]))) return null; }
    var out = Object.create(null), cnt = 0, keys = Object.keys(j.s);
    if (keys.length > 3000) return null;
    keys.forEach(function (k) {
      var a = j.s[k], ok = Array.isArray(a) && a.length === n;
      for (var q = 0; ok && q < n; q++) if (a[q] !== null && !(isNum(a[q]) && a[q] > 0)) ok = false;
      if (ok) { out[k] = a; cnt++; }
    });
    return cnt ? { v: 1, day: j.day, t: j.t.slice(), s: out } : null;
  }
  // downloads intraday.json for the snapshot stamp (meta.fetchedAt) unless that version is already held; resolves with the held object (or null), never rejects
  function loadIntraday(stamp) {
    if (S.intraday && S.intradayStamp === stamp) return Promise.resolve(S.intraday);
    if (S.intradayFlight && S.intradayFlight.stamp === stamp) return S.intradayFlight.p;
    var f = { stamp: stamp };
    f.p = getJson("intraday.json", okIntraday, stamp).then(function (d) { S.intraday = d; S.intradayStamp = stamp; return d; })
      .catch(function () { return S.intraday; })
      .then(function (r) { if (S.intradayFlight === f) S.intradayFlight = null; return r; });
    S.intradayFlight = f; return f.p;
  }
  function intraday() {
    try {
      S.intradayWanted = true;
      var fresh = now() - S.lastRun < 20000 && S.meta ? Promise.resolve() : refresh();
      return fresh.then(function () {
        if (!S.meta) return S.intraday;
        return loadIntraday(S.meta.fetchedAt).then(function (d) { return d || null; });
      }).catch(function () { return S.intraday || null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function series(name) {
    try {
      var d = S.intraday; name = String(name || "");
      if (!d || !Object.prototype.hasOwnProperty.call(d.s, name)) return null;
      var day = asOnDay(); if (day && day !== d.day) return null;            // a file from another trading day is never shown as today's chart
      var a = d.s[name], t = [], p = [];
      for (var i = 0; i < a.length; i++) if (a[i] !== null) { var h = d.t[i]; t.push(d.day + " " + (h < 1000 ? "0" : "") + Math.floor(h / 100) + ":" + (h % 100 < 10 ? "0" : "") + (h % 100)); p.push(a[i]); }
      return p.length >= 2 ? { day: d.day, t: t, p: p } : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- state
  function ingest(m) {
    S.market = m; S.qmap = {}; S.imap = {};
    for (var i = 0; i < m.stocks.length; i++) S.qmap[m.stocks[i][0]] = m.stocks[i];
    for (var k = 0; k < m.indices.length; k++) S.imap[m.indices[k][0].toLowerCase()] = m.indices[k];
  }
  function toObj(cols, row) { var o = {}; for (var i = 0; i < cols.length; i++) o[cols[i]] = row[i]; return o; }

  function status() {
    try {
      var t = now(), m = S.market;
      if (!m) return { state: "unavailable", asOn: null, ageMin: null, text: "Live data unavailable · showing end-of-day data" };
      var asOn = m.meta.asOn, asMs = Date.parse(asOn), age = Math.max(0, (t - asMs) / 60000), meta = S.meta;
      var open = meta ? meta.marketOpen : true;
      var state, text;
      if (!inWindow(t) || !open) { state = "closed"; text = "Market closed · showing the last session"; }
      else if (age > STALE_MIN) { state = "stale"; text = "Delayed · " + hhmm(asMs) + " IST · " + (age >= 120 ? Math.round(age / 60) + " h" : Math.round(age) + " min") + " old"; }
      else { state = "live"; text = "Live snapshot · " + hhmm(asMs) + " IST · ~" + Math.max(1, Math.round(age)) + " min delay"; }
      return { state: state, asOn: asOn, ageMin: Math.round(age * 10) / 10, text: text };
    } catch (e) { return { state: "unavailable", asOn: null, ageMin: null, text: "Live data unavailable · showing end-of-day data" }; }
  }
  // IST calendar day (YYYY-MM-DD) of the snapshot, taken from NSE's own asOn string ("2026-10-21T15:40:31+05:30")
  function asOnDay() { var m = S.market && /^(\d{4}-\d{2}-\d{2})T/.exec(S.market.meta.asOn); return m ? m[1] : null; }
  // true when a snapshot exists and is from the same day as, or later than, the end-of-day data it would replace
  function usable(eodDate) { var d = asOnDay(); return !!d && (typeof eodDate !== "string" || !eodDate || d >= eodDate); }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dayLabel() { var d = asOnDay(); return d ? +d.slice(8, 10) + " " + MON[+d.slice(5, 7) - 1] : ""; }
  // the sentence under the pill; what = "Index values and movers", eod = "19 Oct 2026" (label of the end-of-day fallback), fresh=false when the screen fell back to end-of-day numbers
  function lineText(st, what, eod, fresh) {
    what = what || "This screen"; var e = eod ? " (" + eod + ")" : "";
    if (st.state === "unavailable") return what + ": live data is not available right now, showing end-of-day data" + e + ".";
    var asMs = Date.parse(st.asOn), at = dayLabel() + ", " + hhmm(asMs) + " IST";
    if (fresh === false) return what + ": the live snapshot (" + at + ") is older than the end-of-day data" + e + ", so end-of-day numbers are shown.";
    if (st.state === "live") return what + ": snapshot of NSE's website data, a few minutes behind the exchange. Not real-time.";
    if (st.state === "stale") return what + ": the live feed is behind (last snapshot " + at + "). Numbers may be out of date.";
    return what + ": market closed, showing the last session (" + at + ").";
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function badge(st) {
    var s = st && typeof st === "object" ? st : status();
    var state = ["live", "stale", "closed", "unavailable"].indexOf(s.state) >= 0 ? s.state : "unavailable";
    var text = typeof s.text === "string" && s.text ? s.text : "Live data unavailable · showing end-of-day data";
    return '<span class="tl-pill tl-' + state + '" data-live-state="' + state + '" role="status" aria-live="off"><span class="tl-dot" aria-hidden="true"></span>' + esc(text) + "</span>";
  }

  // pill + one-line explanation for a screen: bar({what, eod, fresh}); both texts are kept current by paint()
  function lineHtml(o, st) {
    return '<p class="tl-line" data-tl-line="' + (o.fresh === false ? "0" : "1") + '" data-tl-what="' + esc(o.what || "") + '" data-tl-eod="' + esc(o.eod || "") + '">' + esc(lineText(st, o.what, o.eod, o.fresh !== false)) + "</p>";
  }
  function line(o) { return lineHtml(o || {}, status()); }
  function bar(o) { o = o || {}; var st = status(); return '<div class="tl-bar">' + badge(st) + lineHtml(o, st) + "</div>"; }
  // re-evaluates every pill and line in the page (cheap text updates, no re-render); runs every 30 s and after each snapshot
  function paint() {
    try {
      var st = status(), i, p = document.querySelectorAll(".tl-pill"), l = document.querySelectorAll("[data-tl-line]");
      for (i = 0; i < p.length; i++) {
        var el = p[i], tx = el.lastChild;
        if (el.hasAttribute("data-tl-static")) continue;   // a fixed note such as "End of day, 19 Oct", not the live status
        if (el.getAttribute("data-live-state") !== st.state) { el.setAttribute("data-live-state", st.state); el.className = "tl-pill tl-" + st.state; }
        if (tx && tx.nodeType === 3) { if (tx.nodeValue !== st.text) tx.nodeValue = st.text; } else el.appendChild(document.createTextNode(st.text));
      }
      for (i = 0; i < l.length; i++) { var q = l[i], t = lineText(st, q.getAttribute("data-tl-what"), q.getAttribute("data-tl-eod"), q.getAttribute("data-tl-line") !== "0"); if (q.textContent !== t) q.textContent = t; }
    } catch (e) {}
  }
  function notify(reason) {
    paint();
    var st = status();
    var subs = S.subs.slice();
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (reason === "data" || (reason === "status" && s.status)) { try { s.fn(S.market, st); } catch (e) { try { console.error(e); } catch (x) {} } }
    }
  }
  function checkState() { var st = status().state; if (S.lastState !== null && st !== S.lastState) { S.lastState = st; notify("status"); } else S.lastState = st; }

  // ---------------------------------------------------------------- refresh (meta first, market.json only when meta changed)
  function refresh() {
    if (S.inflight) return S.inflight;
    S.lastRun = now();
    S.inflight = getJson("meta.json", okMeta).then(function (meta) {
      S.meta = meta; S.err = null;
      if (S.market && S.metaFetched === meta.fetchedAt) return S.market;
      return getJson("market.json", okMarket, meta.fetchedAt).then(function (m) {
        var changed = !S.market || S.market.meta.fetchedAt !== m.meta.fetchedAt;
        S.metaFetched = meta.fetchedAt; ingest(m);
        if (changed) {
          S.lastState = status().state; notify("data");
          if (S.intradayWanted) loadIntraday(meta.fetchedAt).then(function (d) { if (d && S.metaFetched === meta.fetchedAt) notify("data"); });   // second notification when the new points arrived
        }
        return m;
      });
    }).catch(function (e) { S.err = e; return S.market || null; })
      .then(function (r) { S.inflight = null; try { checkState(); } catch (e) {} return r; });
    return S.inflight;
  }
  function get() { try { return refresh().then(function (r) { return r || null; }, function () { return null; }); } catch (e) { return Promise.resolve(null); } }

  function quote(sym) { var r = S.qmap && S.qmap[String(sym || "").toUpperCase()]; return r && Object.prototype.hasOwnProperty.call(S.qmap, String(sym).toUpperCase()) ? toObj(S.market.cols, r) : null; }
  function index(name) { var r = S.imap && S.imap[String(name || "").toLowerCase()]; return r && Object.prototype.hasOwnProperty.call(S.imap, String(name).toLowerCase()) ? toObj(S.market.idxCols, r) : null; }

  function subscribe(fn, opt) {
    if (typeof fn !== "function") return function () {};
    var s = { fn: fn, status: !!(opt && opt.status) };
    S.subs.push(s);
    return function () { var i = S.subs.indexOf(s); if (i >= 0) S.subs.splice(i, 1); };
  }

  // ---------------------------------------------------------------- polling
  function hidden() { try { return document.visibilityState === "hidden"; } catch (e) { return false; } }
  function schedule() {
    clearTimeout(S.timer); S.timer = null;
    if (!S.started || hidden()) return;
    S.timer = setTimeout(function () { S.timer = null; refresh().then(schedule, schedule); }, inWindow(now()) ? POLL_OPEN : POLL_IDLE);
  }
  function onVis() { if (!S.started) return; if (hidden()) { clearTimeout(S.timer); S.timer = null; } else { if (now() - S.lastRun > 20000) refresh().then(schedule, schedule); else schedule(); } }
  function start() {
    if (S.started) return; S.started = true;
    try { document.addEventListener("visibilitychange", onVis); } catch (e) {}
    clearInterval(S.ager); S.ager = setInterval(paint, 30000);
    if (!hidden()) refresh().then(schedule, schedule);
  }
  function stop() { S.started = false; clearTimeout(S.timer); S.timer = null; clearInterval(S.ager); S.ager = null; try { document.removeEventListener("visibilitychange", onVis); } catch (e) {} }

  L.intraday = intraday; L.series = series; L.get = get; L.status = status; L.quote = quote; L.index = index; L.subscribe = subscribe; L.start = start; L.stop = stop; L.badge = badge;
  L.peek = function () { return S.market; }; L.asOnDay = asOnDay; L.usable = usable; L.bar = bar; L.line = line; L.paint = paint; L.refresh = get; L.version = SCHEMA;
  window.TrendyLive = L;
})();
