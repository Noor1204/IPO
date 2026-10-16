// Starts the splash screen and registers the service worker. Kept in its own file so the page can forbid inline scripts (Content-Security-Policy).
(function(){try{var s=document.getElementById("splash"),h=s.querySelector("h1"),t="Trendy IPO";for(var i=0;i<t.length;i++){var c=document.createElement("span");c.textContent=t[i]===" "?" ":t[i];c.style.animationDelay=(2.15+i*.055)+"s";if(i>=7)c.className="gold";h.appendChild(c)}
var done=function(){s.classList.add("out");setTimeout(function(){s.remove()},650)};var m=matchMedia("(prefers-reduced-motion:reduce)").matches;setTimeout(done,m?300:4200);s.addEventListener("click",done)}catch(e){}})();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
