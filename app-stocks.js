// Stocks module. Written against docs/MODULES.md. Replace this stub with the real screens.
(function () {
  window.TrendyModules = window.TrendyModules || {};
  window.TrendyModules.stocks = {
    id: "stocks", label: "Stocks", icon: "📈",
    tabs: [["market","Market"],["movers","Movers"],["watch","Watchlist"],["search","Search"]],
    render(tab, sub, H) { return H.head("Stocks") + H.card("", '<p class="mut">Coming soon.</p>'); },
  };
})();
