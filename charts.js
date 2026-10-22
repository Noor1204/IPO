/* Trendy shared chart library: window.TrendyCharts
   price(container, opts) | line(container, opts) | bars(container, opts) | liveEmbed(symbol, opts)
   No dependencies. Canvas 2D for plots, DOM for chips/readout. See docs/CHARTS.md. */
(function () {
  "use strict";
  if (window.TrendyCharts) return;

  var DAY = 86400000, IST = 19800000;
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var FONT = "Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
  var PALETTE = ["#6366f1", "#f59e0b", "#14b8a6", "#ec4899", "#0ea5e9"];

  /* ---------- small helpers ---------- */
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function num(x) {
    if (x === null || x === undefined || x === "" || typeof x === "boolean") return null;
    var n = typeof x === "number" ? x : parseFloat(x);
    return isFinite(n) ? n : null;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) { var s = arguments[i]; if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k]; }
    return t;
  }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function add(p) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) p.appendChild(arguments[i]); return p; }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }

  /* time: strings "YYYY-MM-DD[ T]HH:MM" are taken as IST wall-clock; epoch ms is shifted to IST wall-clock.
     All internal times are "IST wall-clock as UTC ms" so UTC getters give the Indian date. */
  function parseT(t) {
    if (typeof t === "number") { if (!isFinite(t)) return null; return (t < 1e11 ? t * 1000 : t) + IST; }
    if (typeof t === "string") {
      var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(t);
      if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
      if (/^\d{9,}$/.test(t)) return parseT(+t);
    }
    return null;
  }
  function fmtDate(tt, withTime) {
    if (!isNum(tt)) return "—";
    var d = new Date(tt), s = d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + d.getUTCFullYear();
    if (withTime && tt % DAY !== 0) s += " " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes());
    return s;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var nfCache = {};
  function fmtNum(v, maxD, minD) {
    if (!isNum(v)) return "—";
    maxD = maxD === undefined ? 2 : maxD; minD = minD === undefined ? 0 : minD;
    var k = minD + "_" + maxD, nf = nfCache[k];
    if (!nf) { try { nf = nfCache[k] = new Intl.NumberFormat("en-IN", { minimumFractionDigits: minD, maximumFractionDigits: maxD }); } catch (e) { nf = nfCache[k] = { format: function (x) { return x.toFixed(maxD); } }; } }
    var s = nf.format(v);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
    return s;
  }
  function fmtP(v, cur) { return isNum(v) ? (cur || "") + fmtNum(v, 2, 2) : "—"; }
  function trim0(s) { return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, ""); }
  /* Indian units: 12.4 L, 3.2 Cr, 45.2 K */
  function fmtUnits(v) {
    if (!isNum(v)) return "—";
    var a = Math.abs(v), sg = v < 0 ? "-" : "";
    if (a >= 1e7) return sg + trim0((a / 1e7).toFixed(2)) + " Cr";
    if (a >= 1e5) return sg + trim0((a / 1e5).toFixed(2)) + " L";
    if (a >= 1e4) return sg + trim0((a / 1e3).toFixed(1)) + " K";
    return fmtNum(v, a < 10 && a % 1 ? 2 : 0, 0);
  }
  function fmtAuto(v) { return !isNum(v) ? "—" : Math.abs(v) >= 1e5 ? fmtUnits(v) : fmtNum(v, 2, 0); }
  function fmtChg(d, p, cur) {
    if (!isNum(d) || !isNum(p)) return "—";
    return (d > 0 ? "+" : "") + fmtNum(d, 2, 2) + " (" + (p > 0 ? "+" : "") + fmtNum(p, 2, 2) + "%)";
  }

  // ticks that cover [lo, hi] completely (first tick <= lo, last tick >= hi); used by the bar chart, which can go below zero
  function barTicks(lo, hi, n) {
    if (!(hi > lo)) hi = lo + 1;
    var nt = niceTicks(lo, hi, n), st = nt.step, bot = Math.floor(lo / st + 1e-9) * st, top = Math.ceil(hi / st - 1e-9) * st, out = [];
    for (var v = bot, i = 0; v <= top + st * 1e-9 && i < 100; v += st, i++) out.push(+v.toPrecision(12) + 0);
    return { ticks: out, step: st, bot: out[0], top: out[out.length - 1] };
  }
  function axLab(v, signed) { var a = fmtUnits(Math.abs(v)); return v < 0 ? "\u2212" + a : (signed && v > 0 ? "+" + a : a); }
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { var d = Math.abs(lo) * 0.01 || 1; lo -= d; hi += d; }
    var raw = (hi - lo) / Math.max(1, n), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    var step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
    for (var v = Math.ceil(lo / step - 1e-9) * step, i = 0; v <= hi + step * 1e-9 && i < 100; v += step, i++) out.push(+v.toPrecision(12));
    return { ticks: out, step: step };
  }
  function decFor(step) { return clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 4); }
  function axisFmt(step) { var d = decFor(step); return function (v) { return Math.abs(v) >= 1e5 ? fmtUnits(v) : fmtNum(v, d, d); }; }

  // category-style axis for projections: ticks at whole years counted from an origin date ("Start", "Year 5") instead of calendar dates
  function monthsFrom(org, t) { var o = new Date(org), d = new Date(t); return (d.getUTCFullYear() - o.getUTCFullYear()) * 12 + d.getUTCMonth() - o.getUTCMonth(); }
  function yearTicks(t0, t1, px, org) {
    var o0 = new Date(org), out = [], max = Math.max(2, Math.floor(px / 74)), spanY = (monthsFrom(org, t1) - monthsFrom(org, t0)) / 12, steps = [1, 2, 5, 10, 20], st = 50, i;
    for (i = 0; i < steps.length; i++) if (spanY / steps[i] <= max) { st = steps[i]; break; }
    for (var k = Math.ceil(monthsFrom(org, t0) / 12 / st) * st, g = 0; g < 200; k += st, g++) {
      var t = Date.UTC(o0.getUTCFullYear(), o0.getUTCMonth() + k * 12, 1);
      if (t > t1) break; if (t < t0) continue;
      out.push({ t: t, label: k === 0 ? "Start" : "Year " + k });
    }
    return out;
  }
  function yearLabel(org, t) { var m = monthsFrom(org, t); return m === 0 ? "Start" : m % 12 === 0 ? "Year " + m / 12 : "Month " + m + " (year " + (m / 12).toFixed(1) + ")"; }
  function timeTicks(t0, t1, px, intraday) {
    var out = [], span = t1 - t0;
    if (!(span > 0)) return out;
    var max = Math.max(2, Math.floor(px / 74)), days = span / DAY, t, i;
    if (intraday && days <= 1.5) {
      var hs = [1, 2, 3, 4, 6, 12], hr = 3600000, step = 12 * hr;
      for (i = 0; i < hs.length; i++) if (span / (hs[i] * hr) <= max) { step = hs[i] * hr; break; }
      for (t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push({ t: t, label: pad2(new Date(t).getUTCHours()) + ":" + pad2(new Date(t).getUTCMinutes()) });
      return out;
    }
    if (days > 100) {
      var ms = days / 30.44, steps = [1, 2, 3, 6, 12, 24, 60], ss = 60;
      for (i = 0; i < steps.length; i++) if (ms / steps[i] <= max) { ss = steps[i]; break; }
      var d0 = new Date(t0), idx = d0.getUTCFullYear() * 12 + d0.getUTCMonth();
      for (var k = Math.ceil(idx / ss) * ss, g = 0; g < 200; k += ss, g++) {
        t = Date.UTC(Math.floor(k / 12), k % 12, 1);
        if (t > t1) break;
        if (t < t0) continue;
        var yr = Math.floor(k / 12);
        out.push({ t: t, label: ss >= 12 ? String(yr) : MON[k % 12] + " '" + String(yr).slice(2) });
      }
      return out;
    }
    var ds = [1, 2, 3, 5, 7, 14, 21, 30, 45], sd = 45;
    for (i = 0; i < ds.length; i++) if (days / ds[i] <= max) { sd = ds[i]; break; }
    for (t = Math.ceil(t0 / DAY) * DAY; t <= t1; t += sd * DAY) { var dd = new Date(t); out.push({ t: t, label: dd.getUTCDate() + " " + MON[dd.getUTCMonth()] }); }
    return out;
  }

  /* ---------- theme ---------- */
  function theme() {
    var root = document.documentElement, attr = root.getAttribute("data-theme"), dark = attr === "dark";
    if (attr !== "dark" && attr !== "light" && window.matchMedia) { try { dark = matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { } }
    var cs = getComputedStyle(root);
    function v(n, d) { var x = cs.getPropertyValue(n); x = x && x.trim(); return x || d; }
    return {
      dark: dark,
      tx: v("--tx", dark ? "#e5e9f2" : "#0f172a"), mut: v("--mut", dark ? "#94a3b8" : "#64748b"),
      bd: v("--bd", dark ? "#26304a" : "#e2e8f0"), pri: v("--pri", "#6366f1"), card: v("--card", dark ? "#151c2e" : "#ffffff"),
      up: "#10b981", dn: "#f43f5e", upT: dark ? "#34d399" : "#059669", dnT: dark ? "#fb7185" : "#e11d48",
      ma20: "#f59e0b", ma50: dark ? "#a78bfa" : "#7c3aed", amber: "#f59e0b"
    };
  }
  var live = [], themeMO = null, themeMQ = null;
  function redrawAll() { for (var i = 0; i < live.length; i++) { try { live[i].redraw(); } catch (e) { } } }
  function reg(c) {
    live.push(c);
    if (!themeMO && window.MutationObserver) { themeMO = new MutationObserver(redrawAll); themeMO.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] }); }
    if (!themeMQ && window.matchMedia) { try { themeMQ = matchMedia("(prefers-color-scheme: dark)"); themeMQ.addEventListener ? themeMQ.addEventListener("change", redrawAll) : themeMQ.addListener(redrawAll); } catch (e) { themeMQ = null; } }
  }
  function unreg(c) {
    var i = live.indexOf(c); if (i >= 0) live.splice(i, 1);
    if (!live.length) {
      if (themeMO) { themeMO.disconnect(); themeMO = null; }
      if (themeMQ) { try { themeMQ.removeEventListener ? themeMQ.removeEventListener("change", redrawAll) : themeMQ.removeListener(redrawAll); } catch (e) { } themeMQ = null; }
    }
  }

  /* ---------- style ---------- */
  function injectStyle() {
    if (document.getElementById("tcx-style")) return;
    var s = document.createElement("style"); s.id = "tcx-style";
    s.textContent = [
      ".tcx{--k-tx:var(--tx,#0f172a);--k-mut:var(--mut,#64748b);--k-bd:var(--bd,#e2e8f0);--k-card:var(--card,#fff);--k-up:#059669;--k-dn:#e11d48;position:relative;width:100%;min-width:0;box-sizing:border-box;color:var(--k-tx);font-family:inherit}",
      ":root[data-theme=dark] .tcx{--k-tx:var(--tx,#e5e9f2);--k-mut:var(--mut,#94a3b8);--k-bd:var(--bd,#26304a);--k-card:var(--card,#151c2e);--k-up:#34d399;--k-dn:#fb7185}",
      "@media(prefers-color-scheme:dark){:root:not([data-theme=light]) .tcx{--k-tx:var(--tx,#e5e9f2);--k-mut:var(--mut,#94a3b8);--k-bd:var(--bd,#26304a);--k-card:var(--card,#151c2e);--k-up:#34d399;--k-dn:#fb7185}}",
      ".tcx *{box-sizing:border-box}",
      ".tcx [hidden],.tcx[hidden]{display:none!important}",
      ".tcx-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px 12px;flex-wrap:wrap;margin-bottom:8px}",
      ".tcx-tt{min-width:0;flex:1 1 140px}",
      ".tcx-title{font-weight:800;font-size:15px;line-height:1.3;overflow-wrap:anywhere}",
      ".tcx-sub{font-size:12.5px;font-weight:600;color:var(--k-mut);line-height:1.35}",
      ".tcx-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}",
      ".tcx-bar{display:flex;gap:6px 12px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:4px}",
      ".tcx-chip{appearance:none;-webkit-appearance:none;border:1px solid var(--k-bd);background:transparent;color:var(--k-tx);min-height:36px;min-width:36px;padding:0 12px;border-radius:999px;font-family:inherit;font-size:12.5px;font-weight:700;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent}",
      ".tcx-chip:hover{border-color:#8b5cf6}",
      ".tcx-chip[aria-pressed=true]{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-color:transparent}",
      ".tcx-chip:disabled{opacity:.4;cursor:not-allowed}.tcx-chip:disabled:hover{border-color:var(--k-bd)}",
      ".tcx-chip:focus-visible,.tcx-plot:focus-visible,.tcx-bs:focus-visible{outline:2px solid #6366f1;outline-offset:2px}",
      ".tcx-dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;flex:none}",
      ".tcx-ro{display:flex;flex-wrap:wrap;align-items:center;gap:2px 12px;min-height:44px;padding:2px 0 6px;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.4}",
      ".tcx-ro b{color:var(--k-mut);font-weight:700;margin-right:4px}",
      ".tcx-ro .tcx-dt{font-weight:800}",
      ".tcx-up{color:var(--k-up)}.tcx-dn{color:var(--k-dn)}",
      ".tcx-plot{position:relative;touch-action:pan-y;outline:none;border-radius:10px;cursor:crosshair;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}",
      ".tcx-plot.tcx-drag{cursor:grabbing}.tcx-plot canvas{display:block;width:100%}",
      ".tcx-note,.tcx-cap{font-size:12.5px;font-weight:600;color:var(--k-mut);margin-top:6px;line-height:1.4}",
      ".tcx-cap a{color:inherit;text-decoration:underline}",
      ".tcx-leg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;font-weight:700;margin-bottom:4px}.tcx-leg span{display:inline-flex;align-items:center}",
      ".tcx-msg{padding:32px 12px;text-align:center;color:var(--k-mut);font-weight:700;font-size:13px;border:1px dashed var(--k-bd);border-radius:10px}",
      ".tcx-bw{display:flex;align-items:stretch}.tcx-bw canvas{display:block}",
      ".tcx-bs{overflow-x:auto;overflow-y:hidden;flex:1 1 auto;min-width:0;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;border-radius:10px;outline:none;cursor:crosshair}",
      ".tcx-bs.tcx-hv{overflow-x:hidden;overflow-y:auto;max-height:460px;overscroll-behavior-y:contain}",
      ".tcx-live iframe{display:block;width:100%;height:420px;border:0;border-radius:10px;background:var(--k-card)}",
      ".tcx-fail{font-size:12.5px;font-weight:700;color:var(--k-dn);margin-top:6px}.tcx-fail[hidden]{display:none}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------- canvas helpers ---------- */
  function fit(canvas, w, hgt, cssW) {
    var d = Math.max(1, window.devicePixelRatio || 1), pw = Math.round(w * d), ph = Math.round(hgt * d);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    canvas.style.height = hgt + "px";
    if (cssW) canvas.style.width = w + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, hgt);
    return ctx;
  }
  function rr(ctx, x, y, w, hh, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  /* pill with text; (x,cy) = left edge/center-y, or centre-x when center=true; clamped to [minX,maxX] */
  function tag(ctx, text, x, cy, bg, fg, center, minX, maxX) {
    ctx.font = "700 12px " + FONT;
    var w = Math.ceil(ctx.measureText(text).width) + 12, hh = 20, lx = center ? x - w / 2 : x;
    if (minX !== undefined) lx = Math.max(minX, Math.min(maxX - w, lx));
    lx = Math.round(lx);
    rr(ctx, lx, Math.round(cy - hh / 2), w, hh, 5); ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, lx + 6, Math.round(cy) + 0.5);
    return { x: lx, w: w };
  }
  function crisp(v) { return Math.round(v) + 0.5; }
  function dashed(ctx, x0, y0, x1, y1, color, w, dash) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w || 1; ctx.setLineDash(dash || [4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.restore();
  }
  function maxLabelW(ctx, labels) {
    ctx.font = "600 12px " + FONT; var m = 0;
    for (var i = 0; i < labels.length; i++) m = Math.max(m, ctx.measureText(labels[i]).width);
    return Math.ceil(m);
  }

  function chip(label, pressed, onclick, dotColor) {
    var b = h("button"); b.type = "button"; b.className = "tcx-chip";
    if (dotColor) { var d = h("span", "tcx-dot"); d.style.background = dotColor; b.appendChild(d); }
    b.appendChild(document.createTextNode(label));
    b.setAttribute("aria-pressed", pressed ? "true" : "false");
    b.addEventListener("click", onclick);
    return b;
  }
  function setPressed(b, on) { b.setAttribute("aria-pressed", on ? "true" : "false"); }

  /* a minimal controller for failures: never throw into the caller */
  function dummy(container, msg) {
    try { container.textContent = ""; var m = h("div", "tcx tcx-msg", msg || "Chart unavailable"); container.appendChild(m); } catch (e) { }
    return { update: function () { }, setRange: function () { }, setType: function () { }, destroy: function () { }, redraw: function () { } };
  }

  /* shared: lifecycle (ResizeObserver, listeners, rAF) */
  function lifecycle(self, observeEl, redraw) {
    var cleanups = [], raf = 0, ro = null;
    self.alive = true;
    self.on = function (t, ev, fn, opt) { t.addEventListener(ev, fn, opt); cleanups.push(function () { t.removeEventListener(ev, fn, opt); }); };
    self.sched = function () { if (!raf && self.alive) raf = requestAnimationFrame(function () { raf = 0; redraw(); }); };
    self.redraw = function () { if (self.alive) redraw(); };
    var lastW = -1;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () { var w = observeEl.clientWidth; if (w !== lastW) { lastW = w; self.sched(); } });
      ro.observe(observeEl);
    } else self.on(window, "resize", self.sched);
    reg(self);
    self.teardown = function () {
      self.alive = false;
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      for (var i = 0; i < cleanups.length; i++) { try { cleanups[i](); } catch (e) { } }
      cleanups = []; unreg(self);
    };
  }

  /* ============================================================ */
  /* PRICE CHART                                                   */
  /* ============================================================ */
  function cleanRows(data) {
    var out = [], full = 0;
    if (!Array.isArray(data)) return { rows: out, hasOHLC: false };
    for (var i = 0; i < data.length; i++) {
      var r = data[i]; if (!r) continue;
      var t = parseT(r[0]), c = num(r[4]); if (t === null || c === null) continue;
      var o = num(r[1]), hi = num(r[2]), lo = num(r[3]), f = o !== null && hi !== null && lo !== null;
      if (f) { hi = Math.max(hi, o, c, lo); lo = Math.min(lo, o, c, hi); full++; }
      var v = num(r[5]); if (v !== null && v < 0) v = null;
      out.push({ t: t, o: f ? o : null, h: f ? hi : null, l: f ? lo : null, c: c, v: v });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    var ded = [];
    for (i = 0; i < out.length; i++) { if (ded.length && ded[ded.length - 1].t === out[i].t) ded[ded.length - 1] = out[i]; else ded.push(out[i]); }
    var hasOHLC = ded.length > 1 && full >= ded.length * 0.8;
    for (i = 0; i < ded.length; i++) {
      var q = ded[i];
      if (hasOHLC) { if (q.o === null) { q.o = q.h = q.l = q.c; } } else { q.o = q.h = q.l = null; }
    }
    return { rows: ded, hasOHLC: hasOHLC };
  }
  function rangeStart(lastT, r) {
    var m = /^(\d+)\s*([DWMY])$/i.exec(String(r));
    if (!m) return -Infinity;
    var k = +m[1], u = m[2].toUpperCase(), d = new Date(lastT);
    if (u === "D") return lastT - k * DAY;
    if (u === "W") return lastT - 7 * k * DAY;
    if (u === "M") d.setUTCMonth(d.getUTCMonth() - k); else d.setUTCFullYear(d.getUTCFullYear() - k);
    return d.getTime();
  }
  function lowerBound(arr, t, key) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if ((key !== undefined ? arr[m][key] : arr[m]) < t) lo = m + 1; else hi = m; } return lo; }
  function spanText(first, last) {
    var d = Math.round((last - first) / DAY);
    if (d < 45) return d + " day" + (d === 1 ? "" : "s");
    var mo = Math.round(d / 30.44);
    return mo < 24 ? mo + " months" : (Math.round(mo / 12 * 10) / 10) + " years";
  }
  function sma(rows, n) {
    var out = new Array(rows.length), s = 0;
    for (var i = 0; i < rows.length; i++) { s += rows[i].c; if (i >= n) s -= rows[i - n].c; out[i] = i >= n - 1 ? s / n : null; }
    return out;
  }

  function mkPrice(container, opts) {
    injectStyle();
    var o = assign({}, opts);
    var self = {}, rows = [], n = 0, hasOHLC = false, hasVol = false, intraday = false, ma = { 20: [], 50: [] }, geo = null, hideT = 0;
    var avail = [], availSig = "", lastSig = "";
    var st = { type: o.type || "candles", range: o.range || "6M", m20: !!(o.ma && o.ma.sma20), m50: !!(o.ma && o.ma.sma50), a: 0, b: 0, zoomed: false, hover: -1, hy: null };

    clear(container);
    var root = h("div", "tcx tcx-price"); container.appendChild(root);
    var head = h("div", "tcx-head"), tt = h("div", "tcx-tt"), ttl = h("div", "tcx-title"), sub = h("div", "tcx-sub"), typeBox = h("div", "tcx-chips");
    add(tt, ttl, sub); add(head, tt, typeBox);
    var body = h("div", "tcx-body"), bar = h("div", "tcx-bar"), rangeBox = h("div", "tcx-chips"), maBox = h("div", "tcx-chips");
    add(bar, rangeBox, maBox);
    var ro = h("div", "tcx-ro"), wrap = h("div", "tcx-plot"), canvas = h("canvas"), note = h("div", "tcx-note");
    wrap.tabIndex = 0; wrap.setAttribute("role", "img"); wrap.appendChild(canvas);
    add(body, bar, ro, wrap, note);
    var msg = h("div", "tcx-msg", "Not enough data for a chart"); msg.hidden = true;
    add(root, head, body, msg);

    var typeChips = {}, TYPES = [["candles", "Candles"], ["line", "Line"], ["area", "Area"]];
    TYPES.forEach(function (t) { var c = chip(t[1], false, function () { self.setType(t[0]); }); typeChips[t[0]] = c; typeBox.appendChild(c); });
    var m20c = chip("SMA 20", st.m20, function () { st.m20 = !st.m20; setPressed(m20c, st.m20); draw(); }, "#f59e0b");
    var m50c = chip("SMA 50", st.m50, function () { st.m50 = !st.m50; setPressed(m50c, st.m50); draw(); }, "#8b5cf6");
    if (o.ma !== false) add(maBox, m20c, m50c);

    function effType() { return !hasOHLC && st.type === "candles" ? "line" : st.type; }
    function syncType() {
      var e = effType();
      TYPES.forEach(function (t) { setPressed(typeChips[t[0]], e === t[0]); });
      typeChips.candles.disabled = !hasOHLC;
      typeChips.candles.title = hasOHLC ? "" : "Candles need open, high and low data";
    }
    function syncRangeChips() {
      var sig = avail.join("|");
      if (sig !== availSig) {
        availSig = sig; clear(rangeBox);
        avail.forEach(function (r) { var c = chip(r, false, function () { self.setRange(r); }); c.setAttribute("data-r", r); rangeBox.appendChild(c); });
      }
      var kids = rangeBox.children;
      for (var i = 0; i < kids.length; i++) setPressed(kids[i], !st.zoomed && kids[i].getAttribute("data-r") === st.range);
    }
    function head2() {
      ttl.textContent = o.title ? String(o.title) : ""; ttl.hidden = !o.title;
      sub.textContent = o.subtitle ? String(o.subtitle) : ""; sub.hidden = !o.subtitle;
      tt.hidden = !o.title && !o.subtitle;
    }
    function applyRange() {
      if (n < 2) return;
      var a = 0;
      if (!/^all$/i.test(st.range)) a = clamp(lowerBound(rows, rangeStart(rows[n - 1].t, st.range), "t"), 0, n - 2);
      st.a = a; st.b = n - 1; st.zoomed = false;
    }
    function prepare() {
      var r = cleanRows(o.data); rows = r.rows; n = rows.length; hasOHLC = r.hasOHLC;
      hasVol = o.volume !== false && rows.some(function (x) { return x.v !== null && x.v > 0; });
      intraday = rows.some(function (x) { return x.t % DAY !== 0; });
      ma[20] = n > 1 ? sma(rows, 20) : []; ma[50] = n > 1 ? sma(rows, 50) : [];
      avail = []; var hidden = false;
      if (n > 1) {
        var want = Array.isArray(o.ranges) ? o.ranges.map(String) : ["1M", "3M", "6M", "1Y", "All"];
        want.forEach(function (rg) {
          if (/^all$/i.test(rg)) { avail.push("All"); return; }
          if (!/^\d+\s*[DWMY]$/i.test(rg)) return;
          if (rows[0].t <= rangeStart(rows[n - 1].t, rg) + 7 * DAY) avail.push(rg.toUpperCase().replace(/\s+/g, "")); else hidden = true;
        });
        if (!avail.length) avail.push("All");
        note.textContent = hidden ? "Only " + spanText(rows[0].t, rows[n - 1].t) + " of history available." : "";
        if (avail.indexOf(st.range) < 0) st.range = /^all$/i.test(st.range) || avail.indexOf("All") >= 0 ? "All" : avail[avail.length - 1];
      }
      var sig = n + "_" + (n ? rows[n - 1].t : 0) + "_" + (n ? rows[0].t : 0);
      return sig;
    }
    function fullRender(keepView) {
      var sig = prepare(), same = keepView && sig === lastSig && n > 1;
      lastSig = sig;
      var ok = n >= 2; msg.hidden = ok; body.hidden = !ok;
      head2(); syncType();
      if (ok) {
        if (!same) applyRange(); else { st.a = clamp(st.a, 0, n - 2); st.b = clamp(st.b, st.a + 1, n - 1); }
        syncRangeChips();
        wrap.setAttribute("aria-label", (o.title ? o.title + ": " : "") + "price chart, " + n + " bars from " + fmtDate(rows[0].t) + " to " + fmtDate(rows[n - 1].t) + ". Use left and right arrow keys to read each bar.");
        setRO(st.hover >= 0 ? st.hover : n - 1);
      }
      draw();
    }

    /* ----- readout ----- */
    function item(label, text, cls) {
      var s = h("span", cls || ""); if (label) s.appendChild(h("b", "", label)); s.appendChild(document.createTextNode(text)); ro.appendChild(s);
    }
    function setRO(i) {
      clear(ro);
      var r = rows[i]; if (!r) return;
      var cur = o.currency === undefined ? "₹" : o.currency;
      var prev = i === n - 1 && isNum(num(o.prevClose)) ? num(o.prevClose) : (i > 0 ? rows[i - 1].c : null);
      var d = prev !== null ? r.c - prev : null, p = prev ? d / prev * 100 : null;
      item("", fmtDate(r.t, true), "tcx-dt");
      if (hasOHLC) { item("O", fmtP(r.o)); item("H", fmtP(r.h)); item("L", fmtP(r.l)); }
      item("C", fmtP(r.c, ""));
      item("", fmtChg(d, p), d === null ? "" : d >= 0 ? "tcx-up" : "tcx-dn");
      if (hasVol) item("Vol", r.v !== null ? fmtUnits(r.v) : "—");
      if (st.m20) item("SMA20", fmtP(ma[20][i]));
      if (st.m50) item("SMA50", fmtP(ma[50][i]));
      void cur;
    }

    /* ----- drawing ----- */
    function draw() {
      if (!self.alive || n < 2) return;
      try { drawInner(); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.price draw", e); }
    }
    function drawInner() {
      var W = wrap.clientWidth; if (W < 60) return;
      var narrow = W < 420, pH = isNum(num(o.height)) ? +o.height : (narrow ? 260 : 300), vH = hasVol ? 70 : 0, XH = 24, H = pH + vH + XH;
      var ctx = fit(canvas, W, H), T = theme(), cur = o.currency === undefined ? "₹" : o.currency;
      var i0 = st.a, i1 = st.b, cnt = i1 - i0 + 1, type = effType();
      var lo = Infinity, hi = -Infinity, i;
      for (i = i0; i <= i1; i++) { var r = rows[i]; var l = hasOHLC ? r.l : r.c, hh = hasOHLC ? r.h : r.c; if (l < lo) lo = l; if (hh > hi) hi = hh; }
      var pad = (hi - lo || Math.abs(hi) * 0.02 || 1) * 0.07; lo -= pad; hi += pad;
      var py0 = 8, py1 = pH, nt = niceTicks(lo, hi, Math.max(3, Math.round((py1 - py0) / 52)));
      var prevC = num(o.prevClose), h52 = num(o.high52), l52 = num(o.low52);
      var last = rows[n - 1], lastIn = n - 1 >= i0 && n - 1 <= i1;
      var chgBase = isNum(prevC) ? prevC : (n > 1 ? rows[n - 2].c : last.c), lastUp = last.c >= chgBase;
      var labels = nt.ticks.map(function (v) { return fmtP(v); }); labels.push(fmtP(last.c), fmtP(hi), fmtP(lo));
      var R = Math.max(54, maxLabelW(ctx, labels) + 14), L = 6, pw = W - L - R, slot = pw / cnt;
      function yP(v) { return py0 + (hi - v) / (hi - lo) * (py1 - py0); }
      function xB(k) { return L + (k - i0 + 0.5) * slot; }
      var vy0 = pH + 10, vy1 = pH + vH;
      geo = { W: W, H: H, L: L, R: R, pw: pw, i0: i0, i1: i1, slot: slot, py0: py0, py1: py1, lo: lo, hi: hi };

      /* grid + y labels */
      ctx.lineWidth = 1; ctx.font = "600 12px " + FONT; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      nt.ticks.forEach(function (v) {
        var y = yP(v); if (y < py0 - 2 || y > py1 + 2) return;
        ctx.strokeStyle = T.bd; ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.moveTo(L, crisp(y)); ctx.lineTo(L + pw, crisp(y)); ctx.stroke(); ctx.globalAlpha = 1;
        if (lastIn && Math.abs(y - yP(last.c)) < 12) return;
        ctx.fillStyle = T.mut; ctx.fillText(fmtP(v), L + pw + 8, Math.round(y) + 0.5);
      });
      /* x labels + faint vertical grid */
      var xt = [], tl = -1e9;
      if ((rows[i1].t - rows[i0].t) / DAY > 100) {
        timeTicks(rows[i0].t, rows[i1].t, pw, intraday).forEach(function (tk) {
          var k = lowerBound(rows, tk.t, "t"); if (k < i0 || k > i1) return;
          if (xt.length && xt[xt.length - 1].k === k) return; xt.push({ k: k, label: tk.label });
        });
      } else {
        var every = Math.max(1, Math.ceil(78 / slot));
        for (var k2 = i1; k2 >= i0; k2 -= every) { var dd = new Date(rows[k2].t); xt.unshift({ k: k2, label: intraday && (rows[i1].t - rows[i0].t) < 2 * DAY ? pad2(dd.getUTCHours()) + ":" + pad2(dd.getUTCMinutes()) : dd.getUTCDate() + " " + MON[dd.getUTCMonth()] }); }
      }
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      xt.forEach(function (tk) {
        var x = xB(tk.k), w = ctx.measureText(tk.label).width, cx = clamp(x, L + w / 2, L + pw - w / 2);
        if (cx - w / 2 < tl + 8) return; tl = cx + w / 2;
        ctx.strokeStyle = T.bd; ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(crisp(x), py0); ctx.lineTo(crisp(x), H - XH); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = T.mut; ctx.fillText(tk.label, cx, H - 7);
      });
      /* clip plot */
      ctx.save(); ctx.beginPath(); ctx.rect(L, py0 - 4, pw, py1 - py0 + 8); ctx.clip();
      if (isNum(prevC) && prevC > lo && prevC < hi) dashed(ctx, L, crisp(yP(prevC)), L + pw, crisp(yP(prevC)), T.mut, 1, [5, 4]);
      if (isNum(h52) && h52 > lo && h52 < hi) dashed(ctx, L, crisp(yP(h52)), L + pw, crisp(yP(h52)), T.upT, 1, [2, 4]);
      if (isNum(l52) && l52 > lo && l52 < hi) dashed(ctx, L, crisp(yP(l52)), L + pw, crisp(yP(l52)), T.dnT, 1, [2, 4]);
      var x0, c0;
      if (type === "candles") {
        var bw = Math.max(1, Math.floor(slot * 0.68)); if (bw > 2 && bw % 2 === 0) bw--; bw = Math.min(bw, 15); if (slot < 2) bw = 1;
        for (i = i0; i <= i1; i++) {
          var q = rows[i], up = q.c >= q.o; c0 = up ? T.up : T.dn; ctx.fillStyle = c0;
          var xc = Math.round(xB(i)), yh = Math.round(yP(q.h)), yl = Math.round(yP(q.l)), yo = yP(q.o), yc = yP(q.c);
          var yt = Math.round(Math.min(yo, yc)), yb = Math.round(Math.max(yo, yc)); if (yb - yt < 1) yb = yt + 1;
          ctx.fillRect(xc, yh, 1, Math.max(1, yl - yh));
          if (bw > 1) ctx.fillRect(xc - (bw - 1) / 2, yt, bw, yb - yt);
        }
      } else {
        var col = lastUp ? T.up : T.dn, g;
        ctx.beginPath();
        for (i = i0; i <= i1; i++) { x0 = xB(i); if (i === i0) ctx.moveTo(x0, yP(rows[i].c)); else ctx.lineTo(x0, yP(rows[i].c)); }
        if (type === "area") {
          ctx.save(); ctx.lineTo(xB(i1), py1); ctx.lineTo(xB(i0), py1); ctx.closePath();
          g = ctx.createLinearGradient(0, py0, 0, py1); g.addColorStop(0, col + "55"); g.addColorStop(1, col + "05"); ctx.fillStyle = g; ctx.fill(); ctx.restore();
          ctx.beginPath(); for (i = i0; i <= i1; i++) { x0 = xB(i); if (i === i0) ctx.moveTo(x0, yP(rows[i].c)); else ctx.lineTo(x0, yP(rows[i].c)); }
        }
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      }
      [[20, st.m20, T.ma20], [50, st.m50, T.ma50]].forEach(function (m) {
        if (!m[1]) return; var arr = ma[m[0]], started = false;
        ctx.beginPath(); ctx.strokeStyle = m[2]; ctx.lineWidth = 1.5; ctx.lineJoin = "round";
        for (var k = i0; k <= i1; k++) { if (arr[k] === null) continue; if (!started) { ctx.moveTo(xB(k), yP(arr[k])); started = true; } else ctx.lineTo(xB(k), yP(arr[k])); }
        ctx.stroke();
      });
      ctx.restore();
      /* reference labels */
      function refLabel(v, text, color) {
        if (!isNum(v) || v <= lo || v >= hi) return; ctx.font = "700 12px " + FONT;
        var w = Math.ceil(ctx.measureText(text).width) + 8, y = yP(v);
        ctx.fillStyle = T.card; ctx.globalAlpha = 0.85; ctx.fillRect(L + 2, Math.round(y) - 17, w, 16); ctx.globalAlpha = 1;
        ctx.fillStyle = color; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, L + 6, Math.round(y) - 9);
      }
      refLabel(prevC, "Prev close " + fmtP(prevC), T.mut); refLabel(h52, "52W high " + fmtP(h52), T.upT); refLabel(l52, "52W low " + fmtP(l52), T.dnT);
      /* last price tag */
      var lastY = yP(last.c);
      if (lastIn) {
        dashed(ctx, L, crisp(lastY), L + pw, crisp(lastY), lastUp ? T.up : T.dn, 1, [2, 3]);
        tag(ctx, fmtP(last.c), L + pw + 2, clamp(lastY, py0 + 10, py1 - 10), lastUp ? T.up : T.dn, "#fff", false);
      }
      /* volume */
      if (hasVol) {
        var vmax = 0; for (i = i0; i <= i1; i++) if (rows[i].v > vmax) vmax = rows[i].v;
        ctx.strokeStyle = T.bd; ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.moveTo(L, crisp(vy1)); ctx.lineTo(L + pw, crisp(vy1)); ctx.stroke(); ctx.globalAlpha = 1;
        var vb = Math.max(1, Math.floor(slot * 0.68)); if (vb > 2 && vb % 2 === 0) vb--; vb = Math.min(vb, 15); if (slot < 2) vb = 1;
        ctx.save(); ctx.beginPath(); ctx.rect(L, vy0 - 2, pw, vy1 - vy0 + 4); ctx.clip();
        for (i = i0; i <= i1; i++) {
          var rv = rows[i]; if (!rv.v || !vmax) continue;
          var prevc = i > 0 ? rows[i - 1].c : rv.c, upv = hasOHLC ? rv.c >= rv.o : rv.c >= prevc;
          var bh = Math.max(1, Math.round(rv.v / vmax * (vy1 - vy0 - 2)));
          ctx.fillStyle = upv ? T.up : T.dn; ctx.globalAlpha = 0.6;
          ctx.fillRect(Math.round(xB(i)) - (vb - 1) / 2, vy1 - bh, vb, bh);
        }
        ctx.restore(); ctx.globalAlpha = 1;
        ctx.font = "600 12px " + FONT; ctx.fillStyle = T.mut; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(fmtUnits(vmax), L + pw + 8, vy0 + 6); ctx.fillText("Vol", L + 4, vy0 + 6);
      }
      /* crosshair */
      var hv = st.hover;
      if (hv >= i0 && hv <= i1) {
        var hx = xB(hv), rh = rows[hv], hy = isNum(st.hy) && st.hy >= py0 && st.hy <= py1 ? st.hy : yP(rh.c);
        dashed(ctx, crisp(hx), py0, crisp(hx), H - XH, T.mut, 1, [4, 4]);
        dashed(ctx, L, crisp(hy), L + pw, crisp(hy), T.mut, 1, [4, 4]);
        ctx.beginPath(); ctx.arc(hx, yP(rh.c), 3.5, 0, 6.283); ctx.fillStyle = T.card; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = rh.c >= (hv > 0 ? rows[hv - 1].c : rh.c) ? T.up : T.dn; ctx.stroke();
        var pv = lo + (py1 - hy) / (py1 - py0) * (hi - lo);
        tag(ctx, fmtP(pv), L + pw + 2, clamp(hy, py0 + 10, py1 - 10), T.tx, T.card, false);
        tag(ctx, fmtDate(rh.t), hx, H - XH + 12, T.tx, T.card, true, L, L + pw);
      }
    }

    /* ----- interaction ----- */
    function idxAt(cx) {
      if (!geo) return -1; var rc = canvas.getBoundingClientRect(), x = cx - rc.left;
      return clamp(geo.i0 + Math.floor((x - geo.L) / geo.slot), geo.i0, geo.i1);
    }
    function setHover(i, cy) {
      var rc = canvas.getBoundingClientRect();
      st.hover = i; st.hy = cy === undefined || cy === null ? null : cy - rc.top;
      if (i >= 0) setRO(i); else setRO(n - 1);
      self.sched();
    }
    function clearHover() { clearTimeout(hideT); if (st.hover !== -1) { st.hover = -1; st.hy = null; setRO(n - 1); self.sched(); } }
    var drag = null;
    function panBy(bars) {
      var cnt = st.b - st.a + 1, a = clamp(st.a + bars, 0, n - cnt);
      if (a !== st.a) { st.a = a; st.b = a + cnt - 1; st.zoomed = true; syncRangeChips(); }
    }
    function ptrDown(e) {
      clearTimeout(hideT); if (n < 2) return;
      wrap.setAttribute("aria-live", "off"); ro.setAttribute("aria-live", "off");
      if (e.pointerType === "mouse") {
        if (e.button !== 0) return;
        drag = { x: e.clientX, acc: 0, moved: false }; try { wrap.setPointerCapture(e.pointerId); } catch (x) { }
      }
      setHover(idxAt(e.clientX), e.clientY);
    }
    function ptrMove(e) {
      if (n < 2) return;
      if (drag && e.pointerType === "mouse") {
        var dx = e.clientX - drag.x; drag.x = e.clientX;
        if (Math.abs(dx) > 0) { drag.moved = true; wrap.classList.add("tcx-drag"); }
        drag.acc += dx / geo.slot; var whole = drag.acc < 0 ? Math.ceil(drag.acc) : Math.floor(drag.acc);
        if (whole) { drag.acc -= whole; panBy(-whole); }
      }
      setHover(idxAt(e.clientX), e.clientY);
    }
    function ptrUp(e) {
      if (drag) { drag = null; wrap.classList.remove("tcx-drag"); try { wrap.releasePointerCapture(e.pointerId); } catch (x) { } }
      if (e.pointerType !== "mouse") { clearTimeout(hideT); hideT = setTimeout(clearHover, 2500); }
    }
    function ptrLeave(e) { if (e.pointerType === "mouse" && !drag) clearHover(); }
    function onWheel(e) {
      if (n < 3 || !(e.ctrlKey || e.metaKey || document.activeElement === wrap)) return;
      e.preventDefault();
      var cnt = st.b - st.a + 1, rc = canvas.getBoundingClientRect(), ratio = clamp((e.clientX - rc.left - geo.L) / geo.pw, 0, 1);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { panBy(Math.round(e.deltaX / Math.max(1, geo.slot))); self.sched(); return; }
      var nc = clamp(Math.round(cnt * (e.deltaY < 0 ? 0.85 : 1 / 0.85)), Math.min(10, n), n);
      if (nc === cnt) { if (e.deltaY < 0) nc = Math.max(Math.min(10, n), cnt - 1); else nc = Math.min(n, cnt + 1); }
      var a = clamp(Math.round(st.a + ratio * cnt - ratio * nc), 0, n - nc);
      st.a = a; st.b = a + nc - 1; st.zoomed = true; syncRangeChips(); setHover(st.hover >= st.a && st.hover <= st.b ? st.hover : -1); self.sched();
    }
    function onKey(e) {
      if (n < 2) return; var k = e.key, i = st.hover;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "Home" || k === "End") {
        e.preventDefault(); clearTimeout(hideT);
        var step = e.shiftKey ? 5 : 1;
        i = i < 0 ? st.b : k === "ArrowLeft" ? i - step : k === "ArrowRight" ? i + step : k === "Home" ? st.a : st.b;
        i = clamp(i, 0, n - 1);
        if (i < st.a) { var c1 = st.b - st.a; st.a = i; st.b = i + c1; st.zoomed = true; syncRangeChips(); }
        if (i > st.b) { var c2 = st.b - st.a; st.b = i; st.a = i - c2; st.zoomed = true; syncRangeChips(); }
        ro.setAttribute("aria-live", "polite"); st.hover = i; st.hy = null; setRO(i); self.sched();
      } else if (k === "Escape") { clearHover(); }
      else if (k === "+" || k === "=" || k === "-") {
        e.preventDefault(); var cnt = st.b - st.a + 1, nc = clamp(Math.round(cnt * (k === "-" ? 1.25 : 0.8)), Math.min(10, n), n), a = clamp(st.a + Math.round((cnt - nc) / 2), 0, n - nc);
        st.a = a; st.b = a + nc - 1; st.zoomed = true; syncRangeChips(); self.sched();
      }
    }
    lifecycle(self, wrap, draw);
    self.on(wrap, "pointerdown", ptrDown); self.on(wrap, "pointermove", ptrMove); self.on(wrap, "pointerup", ptrUp);
    self.on(wrap, "pointercancel", ptrUp); self.on(wrap, "pointerleave", ptrLeave); self.on(wrap, "wheel", onWheel, { passive: false });
    self.on(wrap, "keydown", onKey); self.on(wrap, "blur", function () { clearHover(); });
    self.on(wrap, "dragstart", function (e) { e.preventDefault(); });

    self.update = function (x) {
      if (!self.alive) return;
      try {
        if (Array.isArray(x)) o.data = x; else if (x && typeof x === "object") assign(o, x);
        if (x && !Array.isArray(x) && x.type) st.type = x.type;
        if (x && !Array.isArray(x) && x.range) st.range = x.range;
        if (st.hover >= 0 && st.hover > rows.length - 1) st.hover = -1;
        fullRender(!(x && !Array.isArray(x) && x.range));
      } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.price update", e); }
    };
    self.setRange = function (r) { if (!self.alive || n < 2) return; if (avail.indexOf(r) < 0 && !/^all$/i.test(r)) return; st.range = /^all$/i.test(r) ? "All" : r; applyRange(); st.hover = -1; syncRangeChips(); setRO(n - 1); draw(); };
    self.setType = function (t) { if (!self.alive) return; if (t !== "candles" && t !== "line" && t !== "area") return; if (t === "candles" && !hasOHLC) return; st.type = t; syncType(); draw(); };
    self.destroy = function () { if (!self.alive) return; clearTimeout(hideT); self.teardown(); if (root.parentNode) root.parentNode.removeChild(root); };
    fullRender(false);
    return self;
  }

  /* ============================================================ */
  /* LINE CHART (multi-series time series)                         */
  /* ============================================================ */
  function mkLine(container, opts) {
    injectStyle();
    var o = assign({}, opts), self = {}, ser = [], allT = [], intraday = false, geo = null, hideT = 0, avail = [], availSig = "", yo = null;
    function xLabel(t, wt) { return yo !== null ? yearLabel(yo, t) : fmtDate(t, wt); }
    var st = { range: o.range || "All", a: 0, b: 0, hover: -1 };
    clear(container);
    var root = h("div", "tcx tcx-line"); container.appendChild(root);
    var head = h("div", "tcx-head"), tt = h("div", "tcx-tt"), ttl = h("div", "tcx-title"), sub = h("div", "tcx-sub"), rangeBox = h("div", "tcx-chips");
    add(tt, ttl, sub); add(head, tt, rangeBox);
    var body = h("div"), leg = h("div", "tcx-leg"), ro = h("div", "tcx-ro"), wrap = h("div", "tcx-plot"), canvas = h("canvas"), note = h("div", "tcx-note");
    wrap.tabIndex = 0; wrap.setAttribute("role", "img"); wrap.appendChild(canvas);
    add(body, leg, ro, wrap, note);
    var msg = h("div", "tcx-msg", "Not enough data for a chart"); msg.hidden = true;
    add(root, head, body, msg);

    function prepare() {
      yo = o.yearAxis ? parseT(o.yearAxis) : null;
      ser = []; var inp = Array.isArray(o.series) ? o.series : [];
      inp.forEach(function (s, idx) {
        if (!s || !Array.isArray(s.data)) return;
        var pts = [];
        s.data.forEach(function (p) { if (!p) return; var t = parseT(p[0]), v = num(p[1]); if (t !== null && v !== null) pts.push([t, v]); });
        pts.sort(function (a, b) { return a[0] - b[0]; });
        var d = []; pts.forEach(function (p) { if (d.length && d[d.length - 1][0] === p[0]) d[d.length - 1] = p; else d.push(p); });
        if (d.length < 2) return;
        ser.push({ name: s.name ? String(s.name) : "Series " + (ser.length + 1), color: typeof s.color === "string" && /^#[0-9a-f]{3,8}$|^rgb|^hsl/i.test(s.color) ? s.color : PALETTE[idx % PALETTE.length], data: d, axis: s.axis === "right" ? "right" : "left", fill: s.fill === true, format: typeof s.format === "function" ? s.format : fmtAuto });
      });
      var set = {}; allT = [];
      ser.forEach(function (s) { s.data.forEach(function (p) { if (!set[p[0]]) { set[p[0]] = 1; allT.push(p[0]); } }); });
      allT.sort(function (a, b) { return a - b; });
      intraday = allT.some(function (t) { return t % DAY !== 0; });
      avail = [];
      if (ser.length && Array.isArray(o.ranges) && o.ranges.length) {
        var last = allT[allT.length - 1];
        o.ranges.map(String).forEach(function (rg) {
          if (/^all$/i.test(rg)) avail.push("All");
          else if (/^\d+\s*[DWMY]$/i.test(rg) && allT[0] <= rangeStart(last, rg) + 7 * DAY) avail.push(rg.toUpperCase().replace(/\s+/g, ""));
        });
        if (avail.length && avail.indexOf(st.range) < 0) st.range = avail.indexOf("All") >= 0 ? "All" : avail[avail.length - 1];
      }
    }
    function applyRange() {
      st.a = 0; st.b = allT.length - 1;
      if (avail.length && !/^all$/i.test(st.range)) st.a = clamp(lowerBound(allT, rangeStart(allT[allT.length - 1], st.range)), 0, allT.length - 2);
    }
    function syncChips() {
      var sig = avail.join("|");
      if (sig !== availSig) {
        availSig = sig; clear(rangeBox);
        avail.forEach(function (r) { var c = chip(r, false, function () { self.setRange(r); }); c.setAttribute("data-r", r); rangeBox.appendChild(c); });
      }
      var k = rangeBox.children; for (var i = 0; i < k.length; i++) setPressed(k[i], k[i].getAttribute("data-r") === st.range);
    }
    function valAt(s, t) {
      var i = lowerBound(s.data, t, 0); // s.data rows are arrays; lowerBound key needs property -> do manual
      return i;
    }
    function lookup(s, t) { // value at-or-before t
      var d = s.data, lo = 0, hi = d.length - 1, r = -1;
      while (lo <= hi) { var m = (lo + hi) >> 1; if (d[m][0] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
      return r < 0 ? null : d[r][1];
    }
    void valAt;
    function setRO(i) {
      clear(ro); if (i < 0 || i >= allT.length) return;
      var t = allT[i], s0 = h("span", "tcx-dt", xLabel(t, true)); ro.appendChild(s0);
      ser.forEach(function (s) {
        var v = lookup(s, t), e = h("span"), d = h("span", "tcx-dot"); d.style.background = s.color;
        e.appendChild(d); e.appendChild(h("b", "", s.name)); e.appendChild(document.createTextNode(v === null ? "—" : String(safeFmt(s.format, v)))); ro.appendChild(e);
      });
    }
    function safeFmt(f, v) { try { var r = f(v); return r === undefined || r === null || r === "NaN" ? "—" : r; } catch (e) { return "—"; } }
    function fullRender() {
      prepare(); var ok = ser.length > 0; msg.hidden = ok; body.hidden = !ok;
      ttl.textContent = o.title ? String(o.title) : ""; ttl.hidden = !o.title;
      sub.textContent = o.subtitle ? String(o.subtitle) : ""; sub.hidden = !o.subtitle; tt.hidden = !o.title && !o.subtitle;
      if (ok) {
        applyRange(); syncChips(); clear(leg);
        if (ser.length > 1) ser.forEach(function (s) { var e = h("span"), d = h("span", "tcx-dot"); d.style.background = s.color; add(e, d, document.createTextNode(s.name)); leg.appendChild(e); });
        leg.hidden = ser.length < 2;
        wrap.setAttribute("aria-label", (o.title ? o.title + ": " : "") + "trend chart of " + ser.map(function (s) { return s.name; }).join(", ") + ". Use left and right arrow keys to read values.");
        st.hover = -1; setRO(allT.length - 1);
      }
      draw();
    }
    function draw() {
      if (!self.alive || !ser.length) return;
      try { drawInner(); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.line draw", e); }
    }
    function drawInner() {
      var W = wrap.clientWidth; if (W < 60) return;
      var H = (isNum(num(o.height)) ? +o.height : (W < 420 ? 240 : 280)) + 24, XH = 24, py0 = 10, py1 = H - XH;
      var ctx = fit(canvas, W, H), T = theme();
      var tA = allT[st.a], tB = allT[st.b], axes = { left: null, right: null };
      ["left", "right"].forEach(function (ax) {
        var ss = ser.filter(function (s) { return s.axis === ax; }); if (!ss.length) return;
        var lo = Infinity, hi = -Infinity;
        ss.forEach(function (s) {
          var i = Math.max(0, lowerBound(s.data, tA, 0)); void i;
          for (var k = 0; k < s.data.length; k++) { var p = s.data[k]; if (p[0] < tA - 1 && !(k + 1 < s.data.length && s.data[k + 1][0] >= tA)) continue; if (p[0] > tB) break; if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
        });
        if (num(o.baseline) !== null && ax === (ser.some(function (q) { return q.axis === "left"; }) ? "left" : "right")) { var b0 = +o.baseline; if (b0 < lo) lo = b0; if (b0 > hi) hi = b0; }
        if (!isFinite(lo)) return;
        var pd = (hi - lo || Math.abs(hi) * 0.05 || 1) * 0.1; lo -= pd; hi += pd;
        var nt = niceTicks(lo, hi, Math.max(3, Math.round((py1 - py0) / 50))), f = ss[0].format === fmtAuto ? axisFmt(nt.step) : function (v) { return safeFmt(ss[0].format, v); };
        axes[ax] = { lo: lo, hi: hi, nt: nt, f: f, ss: ss };
      });
      var L = 8, R = 8;
      if (axes.left) L = maxLabelW(ctx, axes.left.nt.ticks.map(axes.left.f)) + 14;
      if (axes.right) R = maxLabelW(ctx, axes.right.nt.ticks.map(axes.right.f)) + 14;
      if (!axes.right) R = 10; if (!axes.left) L = 10;
      var pw = W - L - R;
      function xT(t) { return L + (t - tA) / (tB - tA) * pw; }
      function yA(ax, v) { var a = axes[ax]; return py0 + (a.hi - v) / (a.hi - a.lo) * (py1 - py0); }
      geo = { L: L, pw: pw, W: W };
      var gridAx = axes.left || axes.right;
      ctx.font = "600 12px " + FONT; ctx.textBaseline = "middle";
      ["left", "right"].forEach(function (ax) {
        var a = axes[ax]; if (!a) return;
        a.nt.ticks.forEach(function (v) {
          var y = yA(ax, v); if (y < py0 - 2 || y > py1 + 2) return;
          if (a === gridAx) { ctx.strokeStyle = T.bd; ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.moveTo(L, crisp(y)); ctx.lineTo(L + pw, crisp(y)); ctx.stroke(); ctx.globalAlpha = 1; }
          ctx.fillStyle = T.mut; ctx.textAlign = ax === "left" ? "right" : "left";
          ctx.fillText(a.f(v), ax === "left" ? L - 8 : L + pw + 8, Math.round(y) + 0.5);
        });
      });
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; var tl = -1e9;
      (yo !== null ? yearTicks(tA, tB, pw, yo) : timeTicks(tA, tB, pw, intraday)).forEach(function (tk) {
        var x = xT(tk.t), w = ctx.measureText(tk.label).width, cx = clamp(x, L + w / 2, L + pw - w / 2);
        if (cx - w / 2 < tl + 8) return; tl = cx + w / 2;
        ctx.strokeStyle = T.bd; ctx.globalAlpha = 0.35; ctx.beginPath(); ctx.moveTo(crisp(x), py0); ctx.lineTo(crisp(x), py1); ctx.stroke(); ctx.globalAlpha = 1;
        ctx.fillStyle = T.mut; ctx.fillText(tk.label, cx, H - 7);
      });
      ctx.save(); ctx.beginPath(); ctx.rect(L, py0 - 4, pw, py1 - py0 + 8); ctx.clip();
      var bl = num(o.baseline), blax = axes.left ? "left" : "right";
      if (bl !== null) { var by = yA(blax, bl); if (by >= py0 && by <= py1) dashed(ctx, L, crisp(by), L + pw, crisp(by), T.mut, 1, [5, 4]); }
      ser.forEach(function (s) {
        var ax = s.axis; if (!axes[ax]) return;
        var d = s.data, started = false, i, first = -1, lastI = -1;
        ctx.beginPath();
        for (i = 0; i < d.length; i++) {
          if (d[i][0] < tA && !(i + 1 < d.length && d[i + 1][0] >= tA)) continue; if (d[i][0] > tB && i > 0 && d[i - 1][0] > tB) break;
          var x = xT(d[i][0]), y = yA(ax, d[i][1]);
          if (!started) { ctx.moveTo(x, y); started = true; first = x; } else ctx.lineTo(x, y); lastI = x;
        }
        if (!started) return;
        if (s.fill) {
          ctx.save(); ctx.lineTo(lastI, py1); ctx.lineTo(first, py1); ctx.closePath();
          var g = ctx.createLinearGradient(0, py0, 0, py1); g.addColorStop(0, s.color + "55"); g.addColorStop(1, s.color + "05"); ctx.fillStyle = g; ctx.fill(); ctx.restore();
          ctx.beginPath(); started = false;
          for (i = 0; i < d.length; i++) { if (d[i][0] < tA && !(i + 1 < d.length && d[i + 1][0] >= tA)) continue; if (d[i][0] > tB) break; var x2 = xT(d[i][0]), y2 = yA(ax, d[i][1]); if (!started) { ctx.moveTo(x2, y2); started = true; } else ctx.lineTo(x2, y2); }
        }
        ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      });
      ctx.restore();
      if (bl !== null) {
        var by2 = yA(blax, bl);
        if (by2 > py0 && by2 < py1) { var txt = String(safeFmt(ser[0].format, bl)); ctx.font = "700 12px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "middle"; var w2 = ctx.measureText(txt).width + 8; ctx.fillStyle = T.card; ctx.globalAlpha = .85; ctx.fillRect(L + 2, Math.round(by2) - 17, w2, 16); ctx.globalAlpha = 1; ctx.fillStyle = T.mut; ctx.fillText(txt, L + 6, Math.round(by2) - 9); }
      }
      /* end dots */
      ser.forEach(function (s) {
        if (!axes[s.axis]) return; var p = s.data[s.data.length - 1]; if (p[0] < tA || p[0] > tB) return;
        ctx.beginPath(); ctx.arc(xT(p[0]), yA(s.axis, p[1]), 3.5, 0, 6.283); ctx.fillStyle = s.color; ctx.fill();
      });
      var hv = st.hover;
      if (hv >= st.a && hv <= st.b) {
        var th = allT[hv], hx = xT(th);
        dashed(ctx, crisp(hx), py0, crisp(hx), py1, T.mut, 1, [4, 4]);
        ser.forEach(function (s) {
          var v = lookup(s, th); if (v === null || !axes[s.axis]) return;
          ctx.beginPath(); ctx.arc(hx, yA(s.axis, v), 4, 0, 6.283); ctx.fillStyle = T.card; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = s.color; ctx.stroke();
        });
        tag(ctx, xLabel(th, intraday), hx, H - XH + 12, T.tx, T.card, true, L, L + pw);
      }
    }
    function idxAt(cx) {
      if (!geo) return -1; var rc = canvas.getBoundingClientRect(), t = allT[st.a] + clamp((cx - rc.left - geo.L) / geo.pw, 0, 1) * (allT[st.b] - allT[st.a]);
      var i = lowerBound(allT, t); // small arrays; fine
      if (i > 0 && (i >= allT.length || t - allT[i - 1] < allT[i] - t)) i--;
      return clamp(i, st.a, st.b);
    }
    function setHover(i) { st.hover = i; setRO(i >= 0 ? i : allT.length - 1); self.sched(); }
    function clearHover() { clearTimeout(hideT); if (st.hover !== -1) setHover(-1); }
    lifecycle(self, wrap, draw);
    self.on(wrap, "pointerdown", function (e) { clearTimeout(hideT); ro.setAttribute("aria-live", "off"); setHover(idxAt(e.clientX)); });
    self.on(wrap, "pointermove", function (e) { setHover(idxAt(e.clientX)); });
    var upf = function (e) { if (e.pointerType !== "mouse") { clearTimeout(hideT); hideT = setTimeout(clearHover, 2500); } };
    self.on(wrap, "pointerup", upf); self.on(wrap, "pointercancel", upf);
    self.on(wrap, "pointerleave", function (e) { if (e.pointerType === "mouse") clearHover(); });
    self.on(wrap, "blur", clearHover);
    self.on(wrap, "keydown", function (e) {
      var k = e.key; if (!allT.length) return;
      if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); clearTimeout(hideT); ro.setAttribute("aria-live", "polite"); var i = st.hover < 0 ? st.b : st.hover + (k === "ArrowLeft" ? -1 : 1); setHover(clamp(i, st.a, st.b)); }
      else if (k === "Escape") clearHover();
    });
    self.update = function (x) {
      if (!self.alive) return;
      try { if (x && typeof x === "object" && !Array.isArray(x)) { assign(o, x); if (x.range) st.range = x.range; } fullRender(); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.line update", e); }
    };
    self.setRange = function (r) { if (!self.alive || avail.indexOf(r) < 0) return; st.range = r; applyRange(); st.hover = -1; syncChips(); setRO(allT.length - 1); draw(); };
    self.setType = function () { };
    self.destroy = function () { if (!self.alive) return; clearTimeout(hideT); self.teardown(); if (root.parentNode) root.parentNode.removeChild(root); };
    fullRender();
    return self;
  }

  /* ============================================================ */
  /* BARS (grouped, vertical or horizontal)                        */
  /* ============================================================ */
  function mkBars(container, opts) {
    injectStyle();
    var o = assign({}, opts), self = {}, cats = [], ser = [], horiz = false, sel = -1, markerPos = -1, hideT = 0, firstScroll = true, anyNeg = false;
    clear(container);
    var root = h("div", "tcx tcx-bars"); container.appendChild(root);
    var head = h("div", "tcx-head"), tt = h("div", "tcx-tt"), ttl = h("div", "tcx-title"), sub = h("div", "tcx-sub");
    add(tt, ttl, sub); add(head, tt);
    var body = h("div"), leg = h("div", "tcx-leg"), ro = h("div", "tcx-ro"), bw = h("div", "tcx-bw"), axisC = h("canvas"), sc = h("div", "tcx-bs"), canvas = h("canvas"), note = h("div", "tcx-note");
    sc.tabIndex = 0; sc.setAttribute("role", "img"); sc.appendChild(canvas); add(bw, axisC, sc); add(body, leg, ro, bw, note);
    var msg = h("div", "tcx-msg", "No data for this chart"); msg.hidden = true;
    add(root, head, body, msg);

    function catLabel(i) { var c = cats[i]; return typeof c === "number" ? fmtNum(c, 2, 0) : String(c); }
    function prepare() {
      horiz = o.orientation === "h" || o.horizontal === true;
      cats = Array.isArray(o.categories) ? o.categories.filter(function (c) { return c !== null && c !== undefined; }) : [];
      var n = cats.length; ser = []; anyNeg = o.signed === true;
      (Array.isArray(o.series) ? o.series : []).forEach(function (s, idx) {
        if (!s) return; var vals = [];
        for (var i = 0; i < n; i++) { var v = num(s.values && s.values[i]); vals.push(v); if (v !== null && v < 0) anyNeg = true; }
        var def = idx === 0 ? "#f43f5e" : idx === 1 ? "#10b981" : PALETTE[idx % PALETTE.length];
        ser.push({ name: s.name ? String(s.name) : "Series " + (idx + 1), color: typeof s.color === "string" && /^#[0-9a-f]{3,8}$|^rgb|^hsl/i.test(s.color) ? s.color : def, values: vals });
      });
      markerPos = -1; var mk = o.marker;
      if (mk !== undefined && mk !== null && n) {
        var ex = cats.findIndex(function (c) { return String(c) === String(mk); });
        if (ex >= 0) markerPos = ex;
        else {
          var mv = num(mk), nums = cats.map(num);
          if (mv !== null && nums.every(function (x) { return x !== null; }) && n > 1 && mv >= Math.min.apply(null, nums) && mv <= Math.max.apply(null, nums)) {
            for (var i = 0; i < n - 1; i++) { var a = nums[i], b = nums[i + 1]; if ((mv >= a && mv <= b) || (mv <= a && mv >= b)) { markerPos = i + (b === a ? 0 : (mv - a) / (b - a)); break; } }
          }
        }
      }
      if (sel >= n) sel = -1;
    }
    function setRO(i) {
      clear(ro);
      if (i < 0 || i >= cats.length) { ro.appendChild(h("span", "", "Tap or hover a bar to see exact values")); return; }
      ro.appendChild(h("span", "tcx-dt", (o.categoryLabel === undefined ? "Strike " : o.categoryLabel) + catLabel(i)));
      ser.forEach(function (s) {
        var v = s.values[i], e = h("span"), d = h("span", "tcx-dot"); d.style.background = s.color;
        add(e, d, h("b", "", s.name)); var av = v === null ? 0 : Math.abs(v), txt = v === null ? "—" : fmtNum(av, 0, 0) + (av >= 1e4 ? " (" + fmtUnits(av) + ")" : ""); if (v !== null) txt = v < 0 ? "\u2212" + txt : (anyNeg && v > 0 ? "+" + txt : txt);
        e.appendChild(document.createTextNode(txt));
        ro.appendChild(e);
      });
    }
    function fullRender() {
      prepare(); var ok = cats.length > 0 && ser.length > 0; msg.hidden = ok; body.hidden = !ok;
      ttl.textContent = o.title ? String(o.title) : ""; ttl.hidden = !o.title;
      sub.textContent = o.subtitle ? String(o.subtitle) : ""; sub.hidden = !o.subtitle; tt.hidden = !o.title && !o.subtitle; head.hidden = tt.hidden;
      if (ok) {
        clear(leg); ser.forEach(function (s) { var e = h("span"), d = h("span", "tcx-dot"); d.style.background = s.color; add(e, d, document.createTextNode(s.name)); leg.appendChild(e); });
        sc.classList.toggle("tcx-hv", horiz); bw.style.display = horiz ? "block" : "flex"; axisC.hidden = horiz;
        sc.setAttribute("aria-label", (o.title ? o.title + ": " : "") + "grouped bar chart, " + cats.length + " categories. Use left and right arrow keys to read each.");
        setRO(sel >= 0 ? sel : (markerPos >= 0 ? clamp(Math.round(markerPos), 0, cats.length - 1) : -1));
      }
      draw();
    }
    var geo = null;
    function draw() {
      if (!self.alive || !cats.length || !ser.length) return;
      try { drawInner(); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.bars draw", e); }
    }
    function drawInner() {
      var avail = root.clientWidth; if (avail < 80) return;
      var n = cats.length, ns = ser.length, T = theme(), vmax = 0, vmin = 0, i, j;
      ser.forEach(function (s) { s.values.forEach(function (v) { if (v !== null) { if (v > vmax) vmax = v; if (v < vmin) vmin = v; } }); });
      var nt = barTicks(vmin, vmax, 5), top = nt.top, bot = nt.bot, span = top - bot || 1;
      var tlabels = nt.ticks.map(function (v) { return axLab(v, anyNeg); }), selI = sel >= 0 ? sel : -1;
      var mCenter = markerPos >= 0 ? markerPos : -1, mText = (o.markerLabel === undefined ? "Spot" : o.markerLabel) + (num(o.marker) !== null ? " " + fmtNum(num(o.marker), 2, 0) : (typeof o.marker === "string" ? " " + o.marker : ""));
      if (!horiz) {
        var H = isNum(num(o.height)) ? +o.height : 280, XH = 26, py0 = mCenter >= 0 ? 30 : 12, py1 = H - XH;
        var tmp = fit(axisC, 10, H), aw = maxLabelW(tmp, tlabels) + 12;
        var scroll = n > 25, minSlot = Math.max(34, ns * 10 + 14), inner = avail - aw - 2, W = scroll ? Math.max(inner, n * minSlot) : inner;
        var actx = fit(axisC, aw, H, true), ctx = fit(canvas, W, H, true), slot = W / n; if (W < 60) return;
        sc.style.overflowX = scroll ? "auto" : "hidden";
        function yV(v) { return py1 - (v - bot) / span * (py1 - py0); }
        geo = { slot: slot, W: W, n: n, H: H };
        actx.font = "600 12px " + FONT; actx.fillStyle = T.mut; actx.textAlign = "right"; actx.textBaseline = "middle";
        nt.ticks.forEach(function (v, k) {
          var y = yV(v); ctx.strokeStyle = v === 0 ? T.mut : T.bd; ctx.globalAlpha = v === 0 ? 0.9 : 0.7; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, crisp(y)); ctx.lineTo(W, crisp(y)); ctx.stroke(); ctx.globalAlpha = 1;
          actx.fillText(tlabels[k], aw - 6, Math.round(y) + 0.5);
        });
        if (selI >= 0) { ctx.fillStyle = T.tx; ctx.globalAlpha = 0.07; ctx.fillRect(selI * slot, py0 - 6, slot, py1 - py0 + 6); ctx.globalAlpha = 1; }
        var gw = Math.max(2, slot * 0.78), bwid = Math.max(2, Math.floor((gw - (ns - 1)) / ns));
        if (ns * bwid + (ns - 1) > gw) bwid = Math.max(1, Math.floor(gw / ns));
        var tot = ns * bwid + (ns - 1);
        for (i = 0; i < n; i++) {
          var gx = i * slot + (slot - tot) / 2;
          for (j = 0; j < ns; j++) {
            var v = ser[j].values[i]; if (v === null || v === 0) continue;
            var y0 = Math.round(yV(v)), yz = Math.round(yV(0)), bx = Math.round(gx + j * (bwid + 1));
            ctx.fillStyle = ser[j].color; ctx.globalAlpha = selI >= 0 && selI !== i ? 0.75 : 1;
            ctx.fillRect(bx, Math.min(y0, yz), bwid, Math.max(1, Math.abs(yz - y0)));
          }
        }
        ctx.globalAlpha = 1;
        ctx.font = "600 12px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        var lw = maxLabelW(ctx, cats.map(function (c, k) { return catLabel(k); })) + 10, every = Math.max(1, Math.ceil(lw / slot)), occ = [];
        var order = [], strongSet = {};
        for (i = 0; i < n; i++) if (i === selI || (mCenter >= 0 && i === Math.round(mCenter))) { order.push(i); strongSet[i] = 1; }
        for (i = 0; i < n; i += every) if (!strongSet[i]) order.push(i);
        order.forEach(function (i) {
          var strong = !!strongSet[i], lab = catLabel(i);
          ctx.font = (strong ? "800" : "600") + " 12px " + FONT;
          var cx = (i + 0.5) * slot, ww = ctx.measureText(lab).width, px = clamp(cx, ww / 2 + 1, W - ww / 2 - 1), x0 = px - ww / 2 - 4, x1 = px + ww / 2 + 4;
          for (var q = 0; q < occ.length; q++) if (x0 < occ[q][1] && x1 > occ[q][0]) return;
          occ.push([x0, x1]); ctx.fillStyle = strong ? T.tx : T.mut; ctx.fillText(lab, px, H - 8);
        });
        if (mCenter >= 0) {
          var mx = (mCenter + 0.5) * slot; dashed(ctx, crisp(mx), py0 - 4, crisp(mx), py1, T.amber, 1.5, [5, 4]);
          tag(ctx, mText, mx, 13, T.amber, "#1f1300", true, 0, W);
        }
        if (firstScroll && scroll) { firstScroll = false; var tgt = mCenter >= 0 ? (mCenter + 0.5) * slot : W / 2; sc.scrollLeft = Math.max(0, tgt - inner / 2); }
      } else {
        var rowH = Math.max(22, ns * 10 + 10), Hh = n * rowH + 34, ctx2 = fit(canvas, 10, 10);
        var labW = maxLabelW(ctx2, cats.map(function (c, k) { return catLabel(k); })) + 14, Wc = avail - 2;
        ctx = fit(canvas, Wc, Hh, true); axisC.width = 0;
        var px0 = labW, px1 = Wc - 14, XB = 24, pyT = mCenter >= 0 ? 4 : 4;
        function xV(v) { return px0 + (v - bot) / span * (px1 - px0); }
        geo = { slot: rowH, W: Wc, n: n, H: Hh, px0: px0 };
        ctx.font = "600 12px " + FONT; ctx.textBaseline = "middle"; ctx.textAlign = "center";
        nt.ticks.forEach(function (v, k) {
          var x = xV(v); ctx.strokeStyle = v === 0 ? T.mut : T.bd; ctx.globalAlpha = v === 0 ? 0.9 : 0.7; ctx.beginPath(); ctx.moveTo(crisp(x), pyT); ctx.lineTo(crisp(x), Hh - XB); ctx.stroke(); ctx.globalAlpha = 1;
          var w = ctx.measureText(tlabels[k]).width; ctx.fillStyle = T.mut; ctx.fillText(tlabels[k], clamp(x, w / 2, Wc - w / 2), Hh - 10);
        });
        if (selI >= 0) { ctx.fillStyle = T.tx; ctx.globalAlpha = 0.07; ctx.fillRect(0, pyT + selI * rowH, Wc, rowH); ctx.globalAlpha = 1; }
        var gh = rowH - 6, bh2 = Math.max(2, Math.floor(gh / ns));
        ctx.textAlign = "right";
        for (i = 0; i < n; i++) {
          var gy = pyT + i * rowH + (rowH - bh2 * ns) / 2;
          for (j = 0; j < ns; j++) {
            var vv = ser[j].values[i]; if (vv === null || vv === 0) continue;
            ctx.fillStyle = ser[j].color; ctx.globalAlpha = selI >= 0 && selI !== i ? 0.75 : 1;
            var xa = Math.round(xV(0)), xb = Math.round(xV(vv));
            ctx.fillRect(Math.min(xa, xb), Math.round(gy + j * bh2), Math.max(1, Math.abs(xb - xa)), bh2 - 1);
          }
          ctx.globalAlpha = 1; var strong2 = i === selI || (mCenter >= 0 && i === Math.round(mCenter));
          ctx.fillStyle = strong2 ? T.tx : T.mut; ctx.font = (strong2 ? "800" : "600") + " 12px " + FONT; ctx.fillText(catLabel(i), labW - 8, pyT + i * rowH + rowH / 2 + 0.5);
        }
        if (mCenter >= 0) {
          var my = pyT + (mCenter + 0.5) * rowH; dashed(ctx, px0, crisp(my), px1, crisp(my), T.amber, 1.5, [5, 4]);
          tag(ctx, mText, px1 - 4, clamp(my - 14, 12, Hh - XB - 12), T.amber, "#1f1300", false, px0, Wc);
        }
      }
    }
    function catAt(e) {
      if (!geo) return -1; var rc = canvas.getBoundingClientRect(), i;
      i = horiz ? Math.floor((e.clientY - rc.top - 4) / geo.slot) : Math.floor((e.clientX - rc.left) / geo.slot);
      return i >= 0 && i < geo.n ? i : -1;
    }
    function pick(i) { sel = i; setRO(i >= 0 ? i : (markerPos >= 0 ? clamp(Math.round(markerPos), 0, cats.length - 1) : -1)); self.sched(); }
    lifecycle(self, root, draw);
    self.on(canvas, "pointermove", function (e) { if (e.pointerType === "mouse") { clearTimeout(hideT); pick(catAt(e)); } });
    self.on(canvas, "pointerleave", function (e) { if (e.pointerType === "mouse") pick(-1); });
    self.on(canvas, "click", function (e) { clearTimeout(hideT); ro.setAttribute("aria-live", "off"); var i = catAt(e); pick(i); if (e.pointerType && e.pointerType !== "mouse" || e.detail === 0) hideT = setTimeout(function () { pick(-1); }, 6000); });
    self.on(sc, "keydown", function (e) {
      if (!cats.length) return; var k = e.key, back = horiz ? "ArrowUp" : "ArrowLeft", fwd = horiz ? "ArrowDown" : "ArrowRight";
      if (k === back || k === fwd) {
        e.preventDefault(); ro.setAttribute("aria-live", "polite");
        var i = sel < 0 ? (markerPos >= 0 ? Math.round(markerPos) : 0) : sel + (k === back ? -1 : 1); i = clamp(i, 0, cats.length - 1); pick(i);
        if (geo && !horiz) { var x = (i + 0.5) * geo.slot; if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 20) sc.scrollLeft = x - sc.clientWidth / 2; }
      } else if (k === "Escape") pick(-1);
    });
    self.update = function (x) {
      if (!self.alive) return;
      try { if (x && typeof x === "object" && !Array.isArray(x)) assign(o, x); fullRender(); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.bars update", e); }
    };
    self.setRange = function () { }; self.setType = function () { };
    self.destroy = function () { if (!self.alive) return; clearTimeout(hideT); self.teardown(); if (root.parentNode) root.parentNode.removeChild(root); };
    fullRender();
    return self;
  }

  /* ============================================================ */
  /* TradingView live embed                                        */
  /* ============================================================ */
  var IDX = { "NIFTY": "NSE:NIFTY", "NIFTY50": "NSE:NIFTY", "NIFTY 50": "NSE:NIFTY", "BANKNIFTY": "NSE:BANKNIFTY", "NIFTY BANK": "NSE:BANKNIFTY", "FINNIFTY": "NSE:CNXFINANCE", "NIFTY FIN SERVICE": "NSE:CNXFINANCE", "MIDCPNIFTY": "NSE:NIFTY_MID_SELECT", "NIFTYNXT50": "NSE:NIFTYJR", "SENSEX": "BSE:SENSEX", "BANKEX": "BSE:BANKEX" };
  function tvSymbol(kind, sym) {
    var s = String(sym === undefined || sym === null ? "" : sym).trim().toUpperCase();
    if (!s) return "";
    if (/^(NSE|BSE):/.test(s)) return s;
    if (kind === "index") { if (IDX[s]) return IDX[s]; s = s.replace(/[^A-Z0-9&._-]+/g, "_"); return "NSE:" + s; }
    s = s.replace(/[&-]/g, "_"); /* TradingView writes M&M as M_M, BAJAJ-AUTO as BAJAJ_AUTO */
    return kind === "future" ? "NSE:" + s + "1!" : "NSE:" + s;
  }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
  function liveEmbed(symbol, opts) {
    opts = opts || {};
    var s = String(symbol === undefined || symbol === null ? "" : symbol).trim().toUpperCase();
    var m = /^([A-Z]+):(.+)$/.exec(s), ex = "NSE", base = s;
    if (m) { ex = m[1]; base = m[2]; }
    if (ex !== "NSE" && ex !== "BSE") return "";
    var fut = /1!$/.test(base); if (fut) base = base.slice(0, -2);
    if (!/^[A-Z0-9&._-]{1,25}$/.test(base)) return "";
    var tv = ex + ":" + base + (fut ? "1!" : "");
    var dark = theme().dark, title = opts.title ? String(opts.title) : "Live chart for " + base;
    var src = "https://s.tradingview.com/widgetembed/?frameElementId=tv&symbol=" + encodeURIComponent(tv) + "&interval=D&hidesidetoolbar=1&symboledit=0&saveimage=0&theme=" + (dark ? "dark" : "light") + "&style=1&timezone=Asia%2FKolkata&withdateranges=1&hide_top_toolbar=0&locale=en";
    var link = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tv), hgt = isNum(num(opts.height)) ? Math.round(+opts.height) : 420;
    return '<div class="tcx tcx-live" data-tcx-live="1"><iframe src="' + esc(src) + '" title="' + esc(title) + '" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" style="height:' + hgt + 'px"></iframe>' +
      '<div class="tcx-cap">Live chart by <a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">TradingView</a> (delayed)</div>' +
      '<div class="tcx-fail" hidden>Live chart could not load</div></div>';
  }
  function liveEmbedInit(root) {
    try {
      root = root || document;
      var els = root.querySelectorAll ? root.querySelectorAll("[data-tcx-live]") : [];
      Array.prototype.forEach.call(els, function (box) {
        if (box.__tcxLive) return; box.__tcxLive = true;
        var f = box.querySelector("iframe"), fail = box.querySelector(".tcx-fail"); if (!f || !fail) return;
        var ok = false;
        f.addEventListener("load", function () { ok = true; fail.hidden = true; });
        setTimeout(function () { if (!ok && box.isConnected !== false) fail.hidden = false; }, 8000);
      });
    } catch (e) { }
  }

  /* ============================================================ */
  /* configure / auto                                              */
  /* ============================================================ */
  var configs = {}, mounted = [];
  function configure(id, opts) { configs[String(id)] = opts || {}; }
  function sweep() {
    for (var i = mounted.length - 1; i >= 0; i--) {
      var m = mounted[i];
      if (!m.el.isConnected) { try { m.ctl.destroy(); } catch (e) { } mounted.splice(i, 1); }
    }
  }
  function auto(root) {
    try {
      sweep(); root = root || document; liveEmbedInit(root);
      var els = root.querySelectorAll ? root.querySelectorAll("[data-tc]") : [];
      Array.prototype.forEach.call(els, function (el) {
        var type = el.getAttribute("data-tc"), key = el.getAttribute("data-tc-key"), cfg = configs[key];
        if (!cfg || !NS[type] || (type !== "price" && type !== "line" && type !== "bars")) return;
        var ex = null; for (var i = 0; i < mounted.length; i++) if (mounted[i].el === el) { ex = mounted[i]; break; }
        if (ex) { if (ex.cfg !== cfg) { ex.cfg = cfg; try { ex.ctl.update(type === "price" ? assign({}, cfg) : cfg); } catch (e) { } } return; }
        var ctl = NS[type](el, cfg); mounted.push({ el: el, ctl: ctl, cfg: cfg });
      });
    } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.auto", e); }
  }

  var NS = {
    price: function (c, o) { try { return mkPrice(c, o || {}); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.price", e); return dummy(c, "Chart unavailable"); } },
    line: function (c, o) { try { return mkLine(c, o || {}); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.line", e); return dummy(c, "Chart unavailable"); } },
    bars: function (c, o) { try { return mkBars(c, o || {}); } catch (e) { if (window.console && console.warn) console.warn("TrendyCharts.bars", e); return dummy(c, "Chart unavailable"); } },
    liveEmbed: liveEmbed, liveEmbedInit: liveEmbedInit, tvSymbol: tvSymbol,
    configure: configure, auto: auto,
    fmt: { num: fmtNum, price: fmtP, units: fmtUnits, date: fmtDate, change: fmtChg }
  };
  window.TrendyCharts = NS;
})();
