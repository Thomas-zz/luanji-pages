/* ============================================================
   乱记 · 1.0
   一个只在本机工作的个人记录器：打开就是纸，写完就放下。
   ============================================================ */
(function () {
  "use strict";

  var STORAGE_KEY = "luanji.v2";
  var DAY = 24 * 60 * 60 * 1000;
  var SHOT_MARK = "〔图:";
  var SHOT_RE = /〔图:([a-z0-9]+)〕/g;
  var shotCache = {};
  var shotStorePromise = null;
  var shotStoreWarned = false;
  var shotListKey = "";
  var activeOverlay = null;
  var lastFocused = null;
  var toastTimer = null;
  var autosaveTimer = null;
  var state = loadState();

  function $(selector, root) { return (root || document).querySelector(selector); }
  function $$(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return "r-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  function pad(value) { return value < 10 ? "0" + value : String(value); }

  function startOfDay(timestamp) {
    var date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function relativeDate(timestamp) {
    var days = Math.round((startOfDay(Date.now()) - startOfDay(timestamp)) / DAY);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days === 2) return "前天";
    if (days < 30) return days + "天前";
    if (days < 365) return Math.max(1, Math.round(days / 30)) + "个月前";
    return Math.max(1, Math.round(days / 365)) + "年前";
  }

  function absoluteDate(timestamp, includeTime) {
    var date = new Date(timestamp);
    var result = date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日";
    if (includeTime !== false) result += " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    return result;
  }

  function listDate(timestamp) {
    var date = new Date(timestamp);
    var now = new Date();
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
      return relativeDate(timestamp);
    }
    if (date.getFullYear() === now.getFullYear()) {
      return (date.getMonth() + 1) + "月" + date.getDate() + "日";
    }
    return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日";
  }

  function monthLabel(timestamp) {
    var date = new Date(timestamp);
    var now = new Date();
    return date.getFullYear() === now.getFullYear()
      ? (date.getMonth() + 1) + "月"
      : date.getFullYear() + "年 " + (date.getMonth() + 1) + "月";
  }

  function fileStamp() {
    var date = new Date();
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + "-" +
      pad(date.getHours()) + pad(date.getMinutes());
  }

  function previewText(text, length) {
    return String(text || "").replace(SHOT_RE, "〔图〕").replace(/\s+/g, " ").trim().slice(0, length || 72);
  }

  /* ---------- 贴在纸上的图 ----------
     图不进 localStorage：那里只放得下字。图收在本机的 IndexedDB 里，
     纸面上只留一个轻的标记 〔图:id〕，读纸时再把它显影成图。 */

  function shotMarker(id) { return SHOT_MARK + id + "〕"; }

  function shotIdsIn(text) {
    var ids = [];
    var seen = {};
    var match;
    SHOT_RE.lastIndex = 0;
    while ((match = SHOT_RE.exec(String(text || "")))) {
      if (!seen[match[1]]) { seen[match[1]] = 1; ids.push(match[1]); }
    }
    return ids;
  }

  function freshShotId() {
    var draft = $("#write") ? $("#write").value : "";
    var candidate;
    do {
      candidate = Math.random().toString(36).slice(2, 8);
    } while (candidate.length < 6 || shotCache[candidate] || draft.indexOf(shotMarker(candidate)) >= 0);
    return candidate;
  }

  function shotStoreReady() {
    if (!shotStorePromise) {
      shotStorePromise = new Promise(function (resolve) {
        if (!window.indexedDB) return resolve(null);
        var request;
        try {
          request = window.indexedDB.open("luanji-shots", 1);
        } catch (error) {
          return resolve(null);
        }
        request.onupgradeneeded = function () {
          if (!request.result.objectStoreNames.contains("shots")) request.result.createObjectStore("shots");
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { resolve(null); };
      });
    }
    return shotStorePromise;
  }

  function shotRequest(mode, run) {
    return shotStoreReady().then(function (db) {
      return new Promise(function (resolve) {
        if (!db) return resolve(null);
        var tx;
        var request;
        try {
          tx = db.transaction("shots", mode);
          request = run(tx.objectStore("shots"));
        } catch (error) {
          return resolve(null);
        }
        tx.oncomplete = function () { resolve(request ? request.result : undefined); };
        tx.onabort = tx.onerror = function () { resolve(null); };
      });
    });
  }

  function warnShotStoreOnce() {
    if (shotStoreWarned) return;
    shotStoreWarned = true;
    toast("这台浏览器存不住图，刷新后贴上的图会不见。");
  }

  function putShot(id, data) {
    shotCache[id] = data;
    return shotRequest("readwrite", function (store) {
      store.put({ id: id, data: data, created_at: Date.now() }, id);
    }).then(function (result) {
      if (result === null) warnShotStoreOnce();
    });
  }

  function loadShot(id) {
    if (shotCache[id]) return Promise.resolve(shotCache[id]);
    return shotRequest("readonly", function (store) { return store.get(id); }).then(function (row) {
      return row && row.data ? (shotCache[id] = row.data) : null;
    });
  }

  function allShots() {
    return shotRequest("readonly", function (store) { return store.getAll(); }).then(function (rows) {
      return rows || [];
    });
  }

  function deleteShot(id) {
    delete shotCache[id];
    return shotRequest("readwrite", function (store) { store.delete(id); });
  }

  function clearShots() {
    shotCache = {};
    return shotRequest("readwrite", function (store) { store.clear(); });
  }

  function gcShots() {
    var keep = {};
    function collect(text) { shotIdsIn(text).forEach(function (id) { keep[id] = 1; }); }
    collect(state.draft);
    collect(state.stashDraft);
    state.records.forEach(function (record) { collect(record.text); });
    allShots().then(function (rows) {
      rows.forEach(function (row) {
        if (row && row.id && !keep[row.id]) deleteShot(row.id);
      });
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  function shrinkShot(dataURL) {
    return new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        var scale = Math.min(1, 1600 / Math.max(image.width, image.height));
        if (scale >= 1) return resolve(dataURL);
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fcfaf4";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      image.onerror = function () { resolve(dataURL); };
      image.src = dataURL;
    });
  }

  function fileToShot(file) {
    return readAsDataURL(file).then(function (data) {
      if (file.type === "image/gif" || file.size <= 400 * 1024) return data;
      return shrinkShot(data);
    });
  }

  function insertShotMarker(id) {
    var textarea = $("#write");
    var marker = shotMarker(id);
    var start = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart;
    var end = textarea.selectionEnd == null ? start : textarea.selectionEnd;
    var before = textarea.value.slice(0, start);
    var after = textarea.value.slice(end);
    var lead = before && before.slice(-1) !== "\n" ? "\n" : "";
    var tail = after && after.charAt(0) !== "\n" ? "\n" : "";
    textarea.value = before + lead + marker + tail + after;
    var caret = start + lead.length + marker.length;
    textarea.setSelectionRange(caret, caret);
    afterDraftEdit();
    if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) focusTextarea(textarea);
  }

  function removeShotFromDraft(id) {
    var textarea = $("#write");
    var marker = shotMarker(id);
    var at = textarea.value.indexOf(marker);
    if (at < 0) return;
    var before = textarea.value.slice(0, at);
    var after = textarea.value.slice(at + marker.length);
    if (before.slice(-1) === "\n" && after.charAt(0) === "\n") after = after.slice(1);
    textarea.value = before + after;
    textarea.setSelectionRange(at, at);
    afterDraftEdit();
    focusTextarea(textarea);
  }

  /* 文字或纸摞变化后统一走这里，保持草稿状态和纸面一致。 */
  function afterDraftEdit() {
    var textarea = $("#write");
    state.draft = textarea.value;
    refreshPaperState();
    fitTextarea();
    scheduleDraftSave();
    renderShots();
  }

  function handleShotFiles(fileList) {
    var files = Array.prototype.filter.call(fileList || [], function (file) {
      return file && file.type && file.type.indexOf("image/") === 0;
    });
    if (!files.length) return;
    files.reduce(function (chain, file) {
      return chain.then(function () {
        return fileToShot(file).then(function (data) {
          var id = freshShotId();
          return putShot(id, data).then(function () { insertShotMarker(id); });
        });
      });
    }, Promise.resolve()).then(function () {
      toast(files.length > 1 ? "贴上了 " + files.length + " 张。" : "贴上了。");
    }).catch(function () {
      toast("这张图放不上。");
    });
  }

  function renderShots() {
    var wrap = $("#paper-shots");
    if (!wrap) return;
    var ids = shotIdsIn($("#write").value);
    var key = ids.join(" ");
    if (key === shotListKey) return;
    shotListKey = key;
    wrap.hidden = ids.length === 0;
    wrap.innerHTML = ids.map(function (id) {
      return '<span class="paper-shot" data-shot-id="' + esc(id) + '">' +
        '<img alt="贴在这张纸上的图">' +
        '<button class="paper-shot-remove" type="button" aria-label="把这张图从纸上取下">×</button>' +
        '</span>';
    }).join("");
    ids.forEach(function (id, index) {
      var holder = $$(".paper-shot", wrap)[index];
      if (!holder) return;
      loadShot(id).then(function (src) {
        if (src) $("img", holder).src = src;
        else holder.classList.add("is-missing");
      });
    });
  }

  function renderTextWithShots(text) {
    return esc(text).replace(SHOT_RE, function (whole, id) {
      return '<img class="shot" data-shot="' + esc(id) + '" alt="贴在纸上的图">';
    }).replace(/\n/g, "<br>");
  }

  function hydrateShots(root) {
    $$("[data-shot]", root).forEach(function (img) {
      loadShot(img.getAttribute("data-shot")).then(function (src) {
        if (!src) {
          var note = document.createElement("span");
          note.className = "shot-missing";
          note.textContent = "〔图不在这台设备上了〕";
          img.replaceWith(note);
          return;
        }
        img.src = src;
      });
    });
  }

  function sortedRecords(byCreated) {
    return state.records.slice().sort(function (a, b) {
      return (byCreated ? b.created_at - a.created_at : b.updated_at - a.updated_at);
    });
  }

  function findRecord(id) {
    return state.records.find(function (record) { return record.id === id; }) || null;
  }

  function freshState() {
    return {
      v: 2,
      records: [],
      draft: "",
      editingId: null,
      stashDraft: "",
      seen: {},
      lastSavedAt: 0
    };
  }

  function normalizeRecord(record) {
    var now = Date.now();
    var created = Number(record.created_at || record.createdAt || now);
    var updated = Number(record.updated_at || record.updatedAt || created);
    return {
      id: String(record.id || uid()),
      text: String(record.text || ""),
      created_at: created,
      updated_at: updated,
      source: record.source || "web"
    };
  }

  function loadState() {
    var blank = freshState();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var current = JSON.parse(raw);
        blank.records = Array.isArray(current.records) ? current.records.map(normalizeRecord).filter(function (r) { return r.text.trim(); }) : [];
        blank.draft = typeof current.draft === "string" ? current.draft : "";
        blank.editingId = current.editingId || null;
        blank.stashDraft = typeof current.stashDraft === "string" ? current.stashDraft : "";
        blank.seen = current.seen && typeof current.seen === "object" ? current.seen : {};
        blank.lastSavedAt = Number(current.lastSavedAt || 0);
        return blank;
      }

      /* 一次性接住上一版 MVP 的本地数据。数据不离开设备。 */
      var legacy = localStorage.getItem("luanji.v1");
      if (legacy) {
        var old = JSON.parse(legacy);
        blank.records = Array.isArray(old.records) ? old.records.map(normalizeRecord).filter(function (r) { return r.text.trim(); }) : [];
        blank.draft = typeof old.draft === "string" ? old.draft : "";
        blank.editingId = old.editingId || null;
        blank.stashDraft = typeof old.stashDraft === "string" ? old.stashDraft : "";
        blank.seen = old.seen && typeof old.seen === "object" ? old.seen : {};
        persist(blank);
      }
    } catch (error) {
      /* 损坏的本地数据不能阻止用户继续写。 */
      return freshState();
    }
    return blank;
  }

  function persist(nextState) {
    try {
      nextState.lastSavedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      return true;
    } catch (error) {
      return false;
    }
  }

  function saveState(message) {
    var saved = persist(state);
    setSaveState(message || (saved ? "已保存在本机" : "暂时只留在这页上"));
    return saved;
  }

  function setSaveState(message) {
    var target = $("#save-state");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("save-error", message.indexOf("暂时") === 0);
  }

  function scheduleDraftSave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(function () {
      state.draft = $("#write").value;
      saveState(state.draft.trim() ? "草稿已留在本机" : "草稿会自动留在本机");
    }, 120);
  }

  function toast(message) {
    var target = $("#toast");
    target.textContent = message;
    target.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { target.classList.remove("show"); }, 2600);
  }

  function download(name, content, type) {
    var blob = new Blob([content], { type: type || "text/plain;charset=utf-8" });
    var anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(function () {
      URL.revokeObjectURL(anchor.href);
      anchor.remove();
    }, 500);
  }

  function focusTextarea(textarea) {
    try { textarea.focus({ preventScroll: true }); } catch (error) { textarea.focus(); }
    setTimeout(function () { window.scrollTo(0, 0); }, 0);
  }

  function fitTextarea() {
    var textarea = $("#write");
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, window.innerHeight * 0.62) + "px";
  }

  function refreshPaperState() {
    var textarea = $("#write");
    var hasText = textarea.value.trim().length > 0;
    var editing = state.editingId && findRecord(state.editingId);
    $("#btn-drop").disabled = !hasText;
    $("#btn-clear-draft").hidden = !hasText && !editing;
    $("#paper-label").textContent = editing ? "接着写这张纸" : "一张新纸";
    $("#writing-hint").textContent = editing
      ? "写完会放回原来的位置。"
      : (hasText ? "写到这里就够了。" : "不必起标题，也不必想完整。");
    document.body.classList.toggle("is-writing", hasText);
  }

  function renderStack(settle) {
    var target = $("#stack");
    var records = sortedRecords().slice(0, 4);
    var pileButton = $("#btn-pile");
    var note = $("#stack-note");

    if (!records.length) {
      target.innerHTML =
        '<div class="stack-empty"><span>纸摞还是空的。</span><span>先留下一句，改天再来翻。</span></div>';
      pileButton.hidden = true;
      note.textContent = "写下的会一直在这里";
      return;
    }

    pileButton.hidden = false;
    note.textContent = records.length === 1 ? "已经有一张纸了" : "最近写下的在上面";
    target.innerHTML = records.map(function (record, index) {
      return '<button class="stack-sheet ' + (index === 0 ? "is-top " : "") +
        (settle && index === 0 ? "settle " : "") + '" data-record-id="' + esc(record.id) + '" type="button" ' +
        'aria-label="打开' + esc(previewText(record.text, 24)) + '">' +
        '<span class="stack-sheet-copy">' + esc(previewText(record.text, 56)) + '</span>' +
        '<span class="stack-sheet-date">' + esc(listDate(record.updated_at)) + '</span>' +
        '</button>';
    }).join("");

    $$("[data-record-id]", target).forEach(function (button) {
      button.addEventListener("click", function () { openRead(button.getAttribute("data-record-id")); });
    });
  }

  function animateDrop() {
    var paper = $("#paper");
    paper.classList.remove("sinking", "returning");
    void paper.offsetWidth;
    paper.classList.add("sinking");
    setTimeout(function () {
      paper.classList.remove("sinking");
      paper.classList.add("returning");
      renderStack(true);
      refreshPaperState();
      fitTextarea();
      setTimeout(function () { paper.classList.remove("returning"); }, 380);
    }, 430);
  }

  function drop() {
    var textarea = $("#write");
    var text = textarea.value.trim();
    if (!text) return;

    var now = Date.now();
    var editing = state.editingId ? findRecord(state.editingId) : null;
    if (editing) {
      editing.text = text;
      editing.updated_at = now;
      state.editingId = null;
      textarea.value = state.stashDraft || "";
      state.stashDraft = "";
      state.draft = textarea.value;
      saveState("已放回纸摞");
      toast("放回纸摞了。");
    } else {
      state.records.push({
        id: uid(),
        text: text,
        created_at: now,
        updated_at: now,
        source: "web"
      });
      textarea.value = "";
      state.draft = "";
      saveState("已放下，留在本机");
      toast("放下了。");
    }

    renderStack(false);
    refreshPaperState();
    renderShots();
    animateDrop();
    gcShots();
    if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) {
      setTimeout(function () { focusTextarea(textarea); }, 470);
    }
  }

  function clearDraft() {
    var textarea = $("#write");
    var editing = state.editingId && findRecord(state.editingId);
    state.editingId = null;
    state.stashDraft = "";
    textarea.value = "";
    state.draft = "";
    saveState("草稿清掉了");
    refreshPaperState();
    fitTextarea();
    renderShots();
    gcShots();
    if (editing) toast("没有改动原来的纸。");
    focusTextarea(textarea);
  }

  function beginContinue(record) {
    var textarea = $("#write");
    if (textarea.value.trim() && textarea.value.trim() !== record.text.trim()) {
      state.stashDraft = textarea.value;
    }
    state.editingId = record.id;
    textarea.value = record.text;
    state.draft = textarea.value;
    saveState("正在接着写这张纸");
    closeOverlay();
    refreshPaperState();
    fitTextarea();
    renderShots();
    focusTextarea(textarea);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function sheet(title, eyebrow, content, className) {
    return '<section class="sheet ' + (className || "") + '">' +
      '<div class="sheet-head">' +
      '<div><div class="sheet-eyebrow">' + esc(eyebrow || "") + '</div>' +
      '<h2 id="' + (title === "翻一翻" ? "flip-title" : title === "看看最近" ? "recent-title" : title === "找一下" ? "search-title" : title === "设置" ? "settings-title" : title === "读一张纸" ? "read-title" : "") + '">' + esc(title) + '</h2></div>' +
      '<button class="sheet-close" type="button" data-close aria-label="关闭">收起</button>' +
      '</div>' + content + '</section>';
  }

  function openOverlay(id, html, focusSelector) {
    if (activeOverlay) closeOverlay();
    var target = $(id);
    lastFocused = document.activeElement;
    target.innerHTML = html;
    target.hidden = false;
    target.classList.add("open");
    activeOverlay = id;
    document.body.classList.add("overlay-open");
    $$('[data-close]', target).forEach(function (button) {
      button.addEventListener("click", closeOverlay);
    });
    target.addEventListener("click", onOverlayClick);
    setTimeout(function () {
      var focusTarget = focusSelector ? $(focusSelector, target) : $("[data-autofocus]", target) || $("[data-close]", target);
      if (focusTarget) focusTarget.focus();
    }, 30);
  }

  function onOverlayClick(event) {
    if (event.target === event.currentTarget) closeOverlay();
  }

  function closeOverlay() {
    if (!activeOverlay) return;
    var target = $(activeOverlay);
    target.classList.remove("open");
    target.hidden = true;
    target.innerHTML = "";
    target.removeEventListener("click", onOverlayClick);
    activeOverlay = null;
    document.body.classList.remove("overlay-open");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
  }

  function openRead(id) {
    var record = findRecord(id);
    if (!record) return;
    var related = LuanjiAI.related(state.records, record, 2);
    var relatedHtml = related.length
      ? '<div class="related-block"><div class="related-label">还有几张纸，可能挨得近</div>' +
        related.map(function (item) {
          return '<button class="related-slip" type="button" data-related-id="' + esc(item.record.id) + '">' +
            '<span>' + esc(previewText(item.record.text, 70)) + '</span><span>' + esc(listDate(item.record.updated_at)) + '</span></button>';
        }).join("") + '</div>'
      : "";
    var body =
      '<div class="read-meta"><span>' + esc(relativeDate(record.created_at)) + '</span><span>' + esc(absoluteDate(record.updated_at)) + '</span></div>' +
      '<div class="read-copy">' + renderTextWithShots(record.text) + '</div>' +
      relatedHtml +
      '<div class="sheet-actions read-actions">' +
      '<button class="primary-text-action" type="button" data-continue>接着写这张</button>' +
      '<button class="secondary-text-action" type="button" data-delete>收走这张</button>' +
      '</div>' +
      '<div class="delete-confirm" data-delete-confirm hidden>' +
      '<span>收走后不会出现在纸摞里。</span><button class="secondary-text-action danger" type="button" data-delete-final>确认收走</button>' +
      '</div>';

    openOverlay("#ov-read", sheet("读一张纸", "纸面", body, "read-sheet"));
    hydrateShots($("#ov-read"));
    $("[data-continue]", $("#ov-read")).addEventListener("click", function () { beginContinue(record); });
    $("[data-delete]", $("#ov-read")).addEventListener("click", function () {
      $("[data-delete-confirm]", $("#ov-read")).hidden = false;
      this.hidden = true;
    });
    $("[data-delete-final]", $("#ov-read")).addEventListener("click", function () {
      state.records = state.records.filter(function (item) { return item.id !== record.id; });
      if (state.editingId === record.id) {
        state.editingId = null;
        state.stashDraft = "";
        $("#write").value = "";
        state.draft = "";
      }
      delete state.seen[record.id];
      saveState("已收走这张纸");
      closeOverlay();
      renderStack(false);
      renderShots();
      gcShots();
      toast("收走了。");
    });
    $$('[data-related-id]', $("#ov-read")).forEach(function (button) {
      button.addEventListener("click", function () { openRead(button.getAttribute("data-related-id")); });
    });
  }

  function openFlip() {
    if (!state.records.length) {
      openOverlay("#ov-flip", sheet("翻一翻", "回看", '<div class="empty-sheet"><strong>纸摞还没有纸。</strong><span>先留下一句，改天再来翻。</span><button class="primary-text-action" type="button" data-close>回到纸面</button></div>'));
      return;
    }
    renderFlip();
  }

  function renderFlip(record) {
    var records = sortedRecords(true);
    var excluded = {};
    (state.seen.flipRecent || []).forEach(function (id) { excluded[id] = true; });
    record = record || LuanjiAI.pickForFlip(records, { seen: state.seen.records || {}, exclude: excluded }) || records[records.length - 1];
    state.seen.records = state.seen.records || {};
    state.seen.records[record.id] = Date.now();
    state.seen.flipRecent = (state.seen.flipRecent || []).concat(record.id).slice(-4);
    saveState("");

    var body =
      '<div class="flip-card">' +
      '<div class="flip-card-meta"><span>' + esc(relativeDate(record.created_at)) + '</span><span>' + esc(absoluteDate(record.created_at)) + '</span></div>' +
      '<div class="flip-card-copy">' + renderTextWithShots(record.text) + '</div>' +
      '</div>' +
      '<div class="sheet-actions flip-actions"><button class="primary-text-action" id="btn-next-flip" type="button">再翻一张</button><button class="secondary-text-action" type="button" data-open-record>读这张纸</button></div>' +
      '<div class="flip-footnote">不是推荐，只是让旧纸偶尔自己浮上来。</div>';

    openOverlay("#ov-flip", sheet("翻一翻", "偶遇", body, "flip-sheet"));
    hydrateShots($("#ov-flip"));
    $("#btn-next-flip", $("#ov-flip")).addEventListener("click", function () { renderFlip(); });
    $("[data-open-record]", $("#ov-flip")).addEventListener("click", function () { openRead(record.id); });
  }

  function highlight(text, query) {
    var raw = String(text || "");
    var q = String(query || "").trim();
    if (!q) return esc(raw);
    var index = raw.toLowerCase().indexOf(q.toLowerCase());
    if (index < 0) return esc(raw);
    return esc(raw.slice(0, index)) + '<mark>' + esc(raw.slice(index, index + q.length)) + '</mark>' + esc(raw.slice(index + q.length));
  }

  function openSearch() {
    var body = '<div class="search-box"><input id="search-input" data-autofocus type="search" autocomplete="off" placeholder="想找什么？可以只记得意思" aria-label="搜索纸片"><span class="search-shortcut">⌘ K</span></div>' +
      '<div class="search-results" id="search-results"></div>';
    openOverlay("#ov-search", sheet("找一下", "回看", body, "search-sheet"), "#search-input");
    var input = $("#search-input", $("#ov-search"));
    var render = function () { renderSearchResults(input.value); };
    input.addEventListener("input", render);
    render();
  }

  function renderSearchResults(query) {
    var target = $("#search-results", $("#ov-search"));
    if (!target) return;
    var q = String(query || "").trim();
    if (!q) {
      target.innerHTML = '<div class="search-empty"><strong>先写几个记得的字。</strong><span>不必记得原话，想起一点意思也可以。</span></div>';
      return;
    }
    var result = LuanjiAI.search(state.records, q);
    if (!result.length) {
      target.innerHTML = '<div class="search-empty"><strong>还没有找到。</strong><span>换一种说法，或者只留一个词。</span></div>';
      return;
    }
    target.innerHTML = result.map(function (item) {
      return '<button class="result-slip" type="button" data-result-id="' + esc(item.record.id) + '">' +
        '<span class="result-copy">' + highlight(previewText(item.record.text, 180), q) + '</span>' +
        '<span class="result-meta"><span>' + esc(listDate(item.record.updated_at)) + '</span>' + (item.exact ? '<span>原话碰到了</span>' : '<span>意思挨得近</span>') + '</span>' +
        '</button>';
    }).join("");
    $$('[data-result-id]', target).forEach(function (button) {
      button.addEventListener("click", function () { openRead(button.getAttribute("data-result-id")); });
    });
  }

  function openRecent() {
    var records = sortedRecords(true);
    if (!records.length) {
      openOverlay("#ov-recent", sheet("看看最近", "纸摞", '<div class="empty-sheet"><strong>这里还没有时间。</strong><span>写下的纸，会按它们来到你的时间留在这里。</span><button class="primary-text-action" type="button" data-close>回到纸面</button></div>'));
      return;
    }

    var lastMonth = "";
    var html = '<div class="recent-list">';
    records.forEach(function (record) {
      var month = new Date(record.created_at).getFullYear() + "-" + new Date(record.created_at).getMonth();
      if (month !== lastMonth) {
        lastMonth = month;
        html += '<div class="month-heading">' + esc(monthLabel(record.created_at)) + '</div>';
      }
      html += '<button class="recent-slip" type="button" data-recent-id="' + esc(record.id) + '">' +
        '<span class="recent-date">' + esc(listDate(record.updated_at)) + '</span>' +
        '<span class="recent-copy">' + esc(previewText(record.text, 170)) + '</span>' +
        '</button>';
    });
    html += '</div>';
    openOverlay("#ov-recent", sheet("看看最近", "沿时间回去", html, "recent-sheet"));
    $$('[data-recent-id]', $("#ov-recent")).forEach(function (button) {
      button.addEventListener("click", function () { openRead(button.getAttribute("data-recent-id")); });
    });
  }

  function exportJson() {
    allShots().then(function (rows) {
      var payload = {
        app: "luanji",
        version: 2,
        exported_at: Date.now(),
        records: sortedRecords(true).map(function (record) {
          return {
            id: record.id,
            text: record.text,
            created_at: record.created_at,
            updated_at: record.updated_at,
            source: record.source || "web"
          };
        }),
        shots: rows.map(function (row) { return { id: row.id, data: row.data }; })
      };
      download("luanji-" + fileStamp() + ".json", JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
      toast("带走了一份 JSON，贴过的图也在里面。");
    });
  }

  function exportMarkdown() {
    var records = sortedRecords(true);
    var markdown = "# 乱记\n\n> 记下时不必先整理，回来时不必从头找起。\n";
    records.forEach(function (record) {
      markdown += "\n## " + absoluteDate(record.created_at, false) + "\n\n" + record.text.replace(SHOT_RE, "〔图〕") + "\n";
    });
    download("luanji-" + fileStamp() + ".md", markdown, "text/markdown;charset=utf-8");
    toast("带走了一份 Markdown。");
  }

  function importFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var incoming = Array.isArray(data) ? data : data.records;
        if (!Array.isArray(incoming)) throw new Error("not records");
        var added = 0;
        var updated = 0;
        incoming.forEach(function (raw) {
          if (!raw || typeof raw.text !== "string" || !raw.text.trim()) return;
          var record = normalizeRecord(raw);
          var existing = findRecord(record.id);
          if (existing) {
            if (record.updated_at > existing.updated_at) {
              existing.text = record.text;
              existing.created_at = record.created_at;
              existing.updated_at = record.updated_at;
              existing.source = record.source;
              updated++;
            }
          } else {
            state.records.push(record);
            added++;
          }
        });
        var shots = Array.isArray(data.shots) ? data.shots : [];
        shots.forEach(function (shot) {
          if (shot && typeof shot.id === "string" && typeof shot.data === "string" &&
            shot.data.indexOf("data:image/") === 0) putShot(shot.id, shot.data);
        });
        saveState("纸片已经合进本机");
        renderStack(false);
        refreshPaperState();
        toast(added || updated ? "放进了 " + (added + updated) + " 张纸。" : "没有新的纸片。");
      } catch (error) {
        toast("这个文件读不懂，需要乱记的 JSON。");
      }
    };
    reader.readAsText(file, "utf-8");
  }

  function openSettings() {
    var body =
      '<div class="settings-lede"><strong>这里没有账号，也没有云端。</strong><span>所有纸片、草稿和设置都留在这台设备的浏览器里。</span></div>' +
      '<div class="settings-block"><div class="settings-block-title">带走你的纸</div><div class="settings-actions"><button class="secondary-text-action" id="btn-export-json" type="button">导出 JSON</button><button class="secondary-text-action" id="btn-export-md" type="button">导出 Markdown</button><button class="secondary-text-action" id="btn-import" type="button">导入 JSON</button><input id="import-file" type="file" accept="application/json,.json" hidden></div></div>' +
      '<div class="settings-block"><div class="settings-block-title">危险动作</div><div class="settings-danger"><span>清空会删除本机上的所有纸片和草稿。</span><button class="secondary-text-action danger" id="btn-wipe" type="button">清空纸摞</button></div></div>' +
      '<div class="settings-footnote">乱记不会主动上传内容。以后如果需要多端同步，会是另一个明确的版本。</div>';
    openOverlay("#ov-settings", sheet("设置", "只在本机", body, "settings-sheet"));

    $("#btn-export-json", $("#ov-settings")).addEventListener("click", exportJson);
    $("#btn-export-md", $("#ov-settings")).addEventListener("click", exportMarkdown);
    $("#btn-import", $("#ov-settings")).addEventListener("click", function () { $("#import-file", $("#ov-settings")).click(); });
    $("#import-file", $("#ov-settings")).addEventListener("change", function () {
      importFile(this.files[0]);
      this.value = "";
    });

    var wipeButton = $("#btn-wipe", $("#ov-settings"));
    var wipeArmed = false;
    var wipeTimer;
    wipeButton.addEventListener("click", function () {
      if (!wipeArmed) {
        wipeArmed = true;
        wipeButton.textContent = "再点一次，全部收走";
        clearTimeout(wipeTimer);
        wipeTimer = setTimeout(function () {
          wipeArmed = false;
          wipeButton.textContent = "清空纸摞";
        }, 3500);
        return;
      }
      state = freshState();
      saveState("纸摞已经空了");
      $("#write").value = "";
      renderStack(false);
      refreshPaperState();
      renderShots();
      clearShots();
      closeOverlay();
      toast("都收走了。纸又是空的了。");
    });
  }

  function setup() {
    if (window.history && "scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
    setTimeout(function () { window.scrollTo(0, 0); }, 0);
    var textarea = $("#write");
    textarea.value = state.draft || "";
    fitTextarea();
    refreshPaperState();
    renderStack(false);
    renderShots();

    textarea.addEventListener("input", function () {
      state.draft = textarea.value;
      refreshPaperState();
      fitTextarea();
      scheduleDraftSave();
      renderShots();
    });
    textarea.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        drop();
      }
    });
    textarea.addEventListener("paste", function (event) {
      var files = event.clipboardData && event.clipboardData.files;
      var hasImage = files && Array.prototype.some.call(files, function (file) {
        return file.type.indexOf("image/") === 0;
      });
      if (!hasImage) return;
      event.preventDefault();
      handleShotFiles(files);
    });

    var paper = $("#paper");
    paper.addEventListener("dragover", function (event) {
      if (event.dataTransfer && Array.prototype.indexOf.call(event.dataTransfer.types, "Files") >= 0) {
        event.preventDefault();
        paper.classList.add("is-shot-target");
      }
    });
    paper.addEventListener("dragleave", function (event) {
      if (!paper.contains(event.relatedTarget)) paper.classList.remove("is-shot-target");
    });
    paper.addEventListener("drop", function (event) {
      if (!event.dataTransfer) return;
      event.preventDefault();
      paper.classList.remove("is-shot-target");
      handleShotFiles(event.dataTransfer.files);
    });

    $("#btn-drop").addEventListener("click", drop);
    $("#btn-clear-draft").addEventListener("click", clearDraft);
    $("#btn-flip").addEventListener("click", openFlip);
    $("#btn-search").addEventListener("click", openSearch);
    $("#btn-pile").addEventListener("click", openRecent);
    $("#btn-settings").addEventListener("click", openSettings);

    $("#btn-shot").addEventListener("click", function () { $("#shot-file").click(); });
    $("#shot-file").addEventListener("change", function () {
      handleShotFiles(this.files);
      this.value = "";
    });
    $("#paper-shots").addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest(".paper-shot-remove") : null;
      if (!button) return;
      var holder = button.closest(".paper-shot");
      if (holder) removeShotFromDraft(holder.getAttribute("data-shot-id"));
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && activeOverlay) {
        event.preventDefault();
        closeOverlay();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (activeOverlay) closeOverlay();
        openSearch();
      }
    });

    window.addEventListener("resize", fitTextarea);
    window.addEventListener("pagehide", function () {
      state.draft = textarea.value;
      persist(state);
    });

    if (window.matchMedia && window.matchMedia("(pointer: fine)").matches) focusTextarea(textarea);
  }

  setup();
})();
