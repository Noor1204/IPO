/* Trendy near-live market snapshot client (classic script, no dependencies) -> window.TrendyLive
 * Reads the snapshot files that pipeline/live.mjs + .github/workflows/live.yml publish on the branch "live":
 *   meta.json (tiny, polled first), market.json (indices + stocks), oc-<SYMBOL>.json (option chains).
 * This is a delayed snapshot taken every ~2 minutes during market hours, NOT real-time ticks. See docs/LIVE.md.
 * Never throws: every fetch error ends up in status(). Strings that reach the DOM through badge() are escaped.
 *
 *   TrendyLive.get()            Promise<market|null>   latest market.json ({meta, idxCols, indices, cols, stocks, top})
 *   TrendyLive.chain("NIFTY")   Promise<chain|null>    oc-NIFTY.json ({meta, exps, cols, tot, expiries:[{e, coi, poi, pcr, mp, n, strikes}]})
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

  var S = { metaFetched: null, meta: null, market: null, qmap: null, imap: null, chains: {}, chainFetched: {}, err: null, inflight: null, chainFlight: {}, lastRun: 0, subs: [], lastState: null, timer: null, started: false };

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
  function getJson(file, validate) {
    var list = bases(), q = "?t=" + Math.floor(now() / 30000);
    var i = 0;
    function next(lastErr) {
      if (i >= list.length) return Promise.reject(lastErr || new Error("no source"));
      var url = list[i++] + file + q;
      var ac = typeof AbortController === "function" ? new AbortController() : null;
      var timer = setTimeout(function () { try { ac && ac.abort(); } catch (e) {} }, 12000);
      return fetch(url, { cache: "no-store", signal: ac ? ac.signal : undefined, credentials: "omit" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (j) { clearTimeout(timer); var v = validate(j); if (!v) throw new Error("unexpected shape of " + file); return v; })
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
  function okChain(j) {
    if (!j || typeof j !== "object" || !j.meta || !Array.isArray(j.cols) || !Array.isArray(j.expiries) || !j.expiries.length) return null;
    var cl = j.cols.length, ex = [];
    for (var i = 0; i < j.expiries.length; i++) {
      var e = j.expiries[i];
      if (!e || typeof e.e !== "string" || !Array.isArray(e.strikes)) return null;
      var st = e.strikes.filter(function (r) { return Array.isArray(r) && r.length === cl && isNum(r[0]); });
      if (!st.length) return null;
      ex.push({ e: e.e, coi: e.coi, poi: e.poi, pcr: isNum(e.pcr) ? e.pcr : null, mp: isNum(e.mp) ? e.mp : null, n: st.length, strikes: st });
    }
    return { meta: j.meta, exps: Array.isArray(j.exps) ? j.exps : [], cols: j.cols, tot: j.tot || null, expiries: ex };
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
      if (!m) return { state: "unavailable", asOn: null, ageMin: null, text: "Live data unavailable" };
      var asOn = m.meta.asOn, asMs = Date.parse(asOn), age = Math.max(0, (t - asMs) / 60000), meta = S.meta;
      var open = meta ? meta.marketOpen : true;
      var state, text;
      if (!inWindow(t) || !open) { state = "closed"; text = "Market closed · end-of-day data"; }
      else if (age > STALE_MIN) { state = "stale"; text = "Delayed · " + hhmm(asMs) + " IST"; }
      else { state = "live"; text = "Live snapshot · " + hhmm(asMs) + " IST · ~" + Math.max(1, Math.round(age)) + " min delay"; }
      return { state: state, asOn: asOn, ageMin: Math.round(age * 10) / 10, text: text };
    } catch (e) { return { state: "unavailable", asOn: null, ageMin: null, text: "Live data unavailable" }; }
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function badge(st) {
    var s = st && typeof st === "object" ? st : status();
    var state = ["live", "stale", "closed", "unavailable"].indexOf(s.state) >= 0 ? s.state : "unavailable";
    var text = typeof s.text === "string" && s.text ? s.text : "Live data unavailable";
    return '<span class="tl-pill tl-' + state + '" data-live-state="' + state + '" role="status"><span class="tl-dot" aria-hidden="true"></span>' + esc(text) + "</span>";
  }

  function notify(reason) {
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
      return getJson("market.json", okMarket).then(function (m) {
        var changed = !S.market || S.market.meta.fetchedAt !== m.meta.fetchedAt;
        S.metaFetched = meta.fetchedAt; ingest(m);
        if (changed) { S.lastState = status().state; notify("data"); }
        return m;
      });
    }).catch(function (e) { S.err = e; return S.market || null; })
      .then(function (r) { S.inflight = null; try { checkState(); } catch (e) {} return r; });
    return S.inflight;
  }
  function get() { try { return refresh().then(function (r) { return r || null; }, function () { return null; }); } catch (e) { return Promise.resolve(null); } }

  function chain(sym) {
    try {
      sym = String(sym || "").toUpperCase();
      if (!/^[A-Z0-9&_.-]{1,20}$/.test(sym)) return Promise.resolve(null);
      var fresh = now() - S.lastRun < 20000 && S.meta ? Promise.resolve() : refresh();
      return fresh.then(function () {
        var stamp = S.meta ? S.meta.fetchedAt : null;
        if (S.chains[sym] && S.chainFetched[sym] === stamp) return S.chains[sym];
        if (S.chainFlight[sym]) return S.chainFlight[sym];
        var p = getJson("oc-" + encodeURIComponent(sym) + ".json", okChain).then(function (c) { S.chains[sym] = c; S.chainFetched[sym] = stamp; return c; })
          .catch(function () { return S.chains[sym] || null; })
          .then(function (r) { delete S.chainFlight[sym]; return r; });
        S.chainFlight[sym] = p; return p;
      }).catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

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
    if (!hidden()) refresh().then(schedule, schedule);
  }
  function stop() { S.started = false; clearTimeout(S.timer); S.timer = null; try { document.removeEventListener("visibilitychange", onVis); } catch (e) {} }

  L.get = get; L.chain = chain; L.status = status; L.quote = quote; L.index = index; L.subscribe = subscribe; L.start = start; L.stop = stop; L.badge = badge;
  L.refresh = get; L.version = SCHEMA;
  window.TrendyLive = L;
})();
