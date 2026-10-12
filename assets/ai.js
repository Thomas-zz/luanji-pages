/*
 * 乱记 · local intelligence
 *
 * This file intentionally has no network client. In 1.0, "AI 原生" means
 * the product can understand enough of the local pile to help the user find
 * a trace again, without sending a private thought anywhere.
 */
(function () {
  "use strict";

  var STOP_WORDS = {
    "的": 1, "了": 1, "是": 1, "我": 1, "你": 1, "他": 1, "她": 1, "它": 1,
    "和": 1, "与": 1, "在": 1, "有": 1, "就": 1, "也": 1, "不": 1, "都": 1,
    "要": 1, "还": 1, "这": 1, "那": 1, "一个": 1, "一些": 1, "可能": 1,
    "如果": 1, "因为": 1, "所以": 1, "但是": 1, "然后": 1, "自己": 1
  };

  function normalize(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/[“”‘’「」『』【】（）()［］[\]{}<>《》]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokens(value) {
    var text = normalize(value);
    if (!text) return [];
    var out = [];
    var words = text.match(/[a-z0-9_]+|[\u3400-\u9fff]/g) || [];
    words.forEach(function (word) {
      if (word.length === 1 && STOP_WORDS[word]) return;
      if (word.length > 1 && STOP_WORDS[word]) return;
      out.push(word);
    });
    return out;
  }

  function grams(value) {
    var text = normalize(value).replace(/\s/g, "");
    var result = {};
    var i;
    if (!text) return result;
    for (i = 0; i < text.length; i++) {
      var one = text.slice(i, i + 1);
      result[one] = (result[one] || 0) + 0.35;
      if (i < text.length - 1) {
        var two = text.slice(i, i + 2);
        result[two] = (result[two] || 0) + 1;
      }
    }
    tokens(value).forEach(function (token) {
      result["w:" + token] = (result["w:" + token] || 0) + 2;
    });
    return result;
  }

  function cosine(a, b) {
    var dot = 0, aa = 0, bb = 0, k;
    for (k in a) {
      aa += a[k] * a[k];
      if (b[k]) dot += a[k] * b[k];
    }
    for (k in b) bb += b[k] * b[k];
    if (!aa || !bb) return 0;
    return dot / Math.sqrt(aa * bb);
  }

  function search(records, query) {
    var q = normalize(query);
    if (!q) return [];
    var qTokens = tokens(q);
    var qGrams = grams(q);
    var qLower = q.toLowerCase();

    return records.map(function (record) {
      var text = normalize(record.text);
      var score = cosine(qGrams, grams(text)) * 56;
      var exactIndex = text.indexOf(qLower);
      var exact = exactIndex >= 0;
      if (exact) score += 52 - Math.min(exactIndex / 20, 16);

      var matched = 0;
      qTokens.forEach(function (token) {
        if (text.indexOf(token) >= 0) matched++;
      });
      if (matched) score += (matched / Math.max(qTokens.length, 1)) * 28;

      var ageDays = Math.max(0, (Date.now() - (record.updated_at || record.created_at)) / 86400000);
      score += Math.max(0, 7 - ageDays / 45);
      return { record: record, score: score, exact: exact };
    }).filter(function (item) {
      return item.score > 8;
    }).sort(function (a, b) {
      return b.score - a.score;
    }).slice(0, 60);
  }

  function pickForFlip(records, options) {
    options = options || {};
    var seen = options.seen || {};
    var excluded = options.exclude || {};
    if (!records.length) return null;

    var ranked = records.map(function (record) {
      var ageDays = Math.max(0, (Date.now() - (record.updated_at || record.created_at)) / 86400000);
      var unseen = seen[record.id] ? 0 : 1;
      var ageScore = Math.min(ageDays / 45, 1.4);
      var variety = ((record.text.length % 17) / 17) * 0.15;
      var recentPenalty = ageDays < 1 ? -0.7 : 0;
      var excludedPenalty = excluded[record.id] ? -2.5 : 0;
      return {
        record: record,
        score: unseen * 1.5 + ageScore + variety + recentPenalty + excludedPenalty + Math.random() * 0.55
      };
    }).sort(function (a, b) {
      return b.score - a.score;
    });
    return ranked[0].record;
  }

  function related(records, focus, limit) {
    if (!focus) return [];
    var others = records.filter(function (record) { return record.id !== focus.id; });
    var scored = search(others, focus.text);
    return scored.filter(function (item) { return item.score > 18; }).slice(0, limit || 3);
  }

  window.LuanjiAI = {
    search: search,
    pickForFlip: pickForFlip,
    related: related,
    normalize: normalize
  };
})();
