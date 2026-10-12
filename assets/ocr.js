/*
 * 乱记 · ocr.js
 * 认字：把贴在纸上的图转成字。tesseract.js 的引擎、核心和字库
 * 都打包在 assets/vendor 里，在本机浏览器跑，不联网。
 * 引擎在第一次认字时才加载，之后常驻。
 */
(function () {
  "use strict";

  var BASE = new URL("assets/vendor/", location.href).href;
  var workerPromise = null;

  function loadEngine() {
    return new Promise(function (resolve, reject) {
      if (window.Tesseract) return resolve();
      var script = document.createElement("script");
      script.src = BASE + "tesseract/tesseract.min.js";
      script.async = true;
      script.addEventListener("load", function () { resolve(); });
      script.addEventListener("error", function () { reject(new Error("engine")); });
      document.head.appendChild(script);
    });
  }

  function getWorker(logger) {
    if (!workerPromise) {
      workerPromise = loadEngine().then(function () {
        return window.Tesseract.createWorker("chi_sim+eng", 1, {
          workerPath: BASE + "tesseract/worker.min.js",
          corePath: BASE + "tesseract/core/",
          langPath: BASE + "tessdata",
          gzip: true,
          logger: logger || function () {}
        });
      }).catch(function (error) {
        workerPromise = null;
        throw error;
      });
    }
    return workerPromise;
  }

  /* 中文为主的结果里，字与字之间的空格多半是误插的；只在英文占比高时保留。 */
  function tidy(text) {
    var value = String(text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    var cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
    var ascii = (value.match(/[A-Za-z]/g) || []).length;
    if (cjk > ascii * 2) value = value.replace(/ +/g, "");
    return value;
  }

  function recognize(dataURL, onProgress) {
    return getWorker(function (message) {
      if (onProgress && message && message.status === "recognizing text") {
        onProgress(message.progress || 0);
      }
    }).then(function (worker) {
      return worker.recognize(dataURL);
    }).then(function (result) {
      return tidy(result && result.data && result.data.text);
    });
  }

  window.LuanjiOCR = { recognize: recognize };
})();
