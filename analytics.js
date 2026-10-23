// Anonymous visit counting with GoatCounter (https://www.goatcounter.com): no cookies, no names, no accounts.
// It stays OFF until a site code is set in CODE below. It never runs on localhost, and never when the browser sends "Do Not Track".
// Setup: see ADMIN.md. The dashboard (visitors, screens, countries, devices, actions) is at https://<CODE>.goatcounter.com
(function () {
  var CODE = "trendyipo";   // <- your GoatCounter site code, for example "trendyipo" for https://trendyipo.goatcounter.com
  var local = ["localhost", "127.0.0.1", "[::1]"].indexOf(location.hostname) >= 0;
  var dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1";
  var on = !!CODE && !local && !dnt && !window.TRENDY_NO_ANALYTICS;
  var queue = [];
  // window.trendyTrack("tab/compare", "Tab: Compare") records one anonymous action (a screen opened, a button used)
  window.trendyTrack = function (path, title) {
    if (!on) return;
    try {
      if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path, title: title || path, event: true });
      else queue.push([path, title]);
    } catch (e) {}
  };
  if (!on) return;
  var s = document.createElement("script");
  s.async = true;
  s.src = "vendor/goatcounter-count.js";   // pinned copy of https://gc.zgo.at/count.js (ISC licence), so no third-party script runs on this page
  s.setAttribute("data-goatcounter", "https://" + CODE + ".goatcounter.com/count");
  s.onload = function () { queue.splice(0).forEach(function (q) { window.trendyTrack(q[0], q[1]); }); };
  document.head.appendChild(s);
})();
