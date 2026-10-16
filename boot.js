// Starts the splash screen and registers the service worker. Kept in its own file so the page can forbid inline scripts (Content-Security-Policy).
(function(){try{var s=document.getElementById("splash"),h=s.querySelector("h1"),t="Trendy IPO";for(var i=0;i<t.length;i++){var c=document.createElement("span");c.textContent=t[i]===" "?" ":t[i];c.style.animationDelay=(2.15+i*.055)+"s";if(i>=7)c.className="gold";h.appendChild(c)}
var done=function(){s.classList.add("out");setTimeout(function(){s.remove()},650)};var m=matchMedia("(prefers-reduced-motion:reduce)").matches;setTimeout(done,m?300:4200);s.addEventListener("click",done)}catch(e){}})();
if ("serviceWorker" in navigator) {
  // when a newer version of the app takes over, reload once so the open page runs the new code (not on the very first visit)
  var hadController = !!navigator.serviceWorker.controller, reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") reg.update().catch(function () {}); });   // look for a new version whenever the app is opened again
    }).catch(function () {});
  });
}
