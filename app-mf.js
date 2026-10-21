// Mutual Fund module. Written against docs/MODULES.md. Replace this stub with the real screens.
(function () {
  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.mf = {
    id: "mf", label: "Mutual Fund", icon: "💼",
    tabs: [["funds","Funds"],["compare","Compare"],["sip","SIP"],["watch","Watchlist"]],
    render(tab, sub, H) { return H.head("Mutual Fund") + H.card("", '<p class="mut">Coming soon.</p>'); },
  };
})();
