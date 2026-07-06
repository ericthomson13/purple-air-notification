// Kept identical to correctPm25()/calcAqiFromPm25() in ../../../src/aqi.ts -
// if that formula changes, update it here too (see aqi-math.test.ts, which
// checks this file's output against known values from src/aqi.ts's own
// exact-boundary tests, to catch the two silently drifting apart).
//
// Loaded as a plain <script> (window.AqiMath) by index.html, and as a
// CommonJS module by aqi-math.test.ts - hence the dual export at the bottom
// rather than an ES module, so the static site needs no build step.
(function (global) {
  "use strict";

  var BREAKPOINTS = [
    [0.0, 9.0, 0, 50],
    [9.1, 35.4, 51, 100],
    [35.5, 55.4, 101, 150],
    [55.5, 125.4, 151, 200],
    [125.5, 225.4, 201, 300],
    [225.5, 325.4, 301, 500],
  ];

  function aqiFromPm25(pm25) {
    for (var i = 0; i < BREAKPOINTS.length; i++) {
      var b = BREAKPOINTS[i];
      if (pm25 <= b[1] || i === BREAKPOINTS.length - 1) {
        return Math.round(((b[3] - b[2]) / (b[1] - b[0])) * (pm25 - b[0]) + b[2]);
      }
    }
  }

  function correctPm25(pm25, rh, temp) {
    var corrected;
    if (pm25 < 343) {
      corrected = 0.541 * pm25 - 0.0618 * rh + 0.00534 * temp + 3.634;
    } else {
      corrected = 0.46 * pm25 + 3.93e-4 * pm25 * pm25 + 2.97;
    }
    return Math.max(0, corrected);
  }

  var AqiMath = { aqiFromPm25: aqiFromPm25, correctPm25: correctPm25 };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AqiMath;
  } else {
    global.AqiMath = AqiMath;
  }
})(typeof window !== "undefined" ? window : this);
