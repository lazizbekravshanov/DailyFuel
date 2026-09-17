// Hero price roll: each digit spins up into place once, under 600 ms.
// Skipped when the reader prefers reduced motion. Without JS the price is plain text.
(function () {
  var root = document.querySelector("[data-roll]");
  if (!root || !window.matchMedia || !Element.prototype.animate) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  var digits = root.querySelectorAll(".dg");
  digits.forEach(function (dg, i) {
    var target = Number(dg.textContent);
    var spins = 5 + i * 2;
    var reel = document.createElement("span");
    reel.className = "reel";
    for (var j = 0; j <= spins; j++) {
      var row = document.createElement("span");
      row.textContent = String((((target - spins + j) % 10) + 10) % 10);
      reel.appendChild(row);
    }
    dg.classList.add("rolling");
    dg.appendChild(reel);
    var anim = reel.animate(
      [{ transform: "translateY(0)" }, { transform: "translateY(-" + spins + "em)" }],
      { duration: 360 + i * 45, easing: "cubic-bezier(0.2, 0.75, 0.25, 1)", fill: "both" }
    );
    function done() {
      if (reel.parentNode) reel.parentNode.removeChild(reel);
      dg.classList.remove("rolling");
    }
    anim.onfinish = done;
    anim.oncancel = done;
    // never leave a reel behind if the animation can't run
    setTimeout(function () { anim.finish(); }, 2000);
  });
})();
