"use strict";
/* minty browser shell: tabs, bookmarks, settings, configurable shortcuts */
(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };

  /* ---------- storage ---------- */
  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ }
    },
    del: function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ }
    },
  };

  /* ---------- settings ---------- */
  var ENGINES = {
    google: { name: "Google", url: "https://www.google.com/search?hl=en-us&q=%s" },
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
  };
  var PROXIES = {
    uv: { name: "Ultraviolet" },
    scramjet: { name: "Scramjet v1" },
    scramjet2: { name: "Scramjet v2 (alpha)" },
  };
  var ACTIONS = {
    fullscreen: { label: "Fullscreen the site you're viewing", def: "Ctrl+\\" },
    bookmarks: { label: "Hide / show bookmarks bar", def: "Ctrl+]" },
    newTab: { label: "New tab", def: "Alt+T" },
    closeTab: { label: "Close tab", def: "Alt+W" },
  };

  var settings;
  function loadSettings() {
    var saved = store.get("minty.settings", {}) || {};
    settings = {
      engine: ENGINES[saved.engine] ? saved.engine : "google",
      proxy: PROXIES[saved.proxy] ? saved.proxy : "uv",
      newTabLinks: saved.newTabLinks === "same" ? "same" : "tab",
      showBookmarks: saved.showBookmarks !== false,
      keys: {},
    };
    Object.keys(ACTIONS).forEach(function (a) {
      var k = saved.keys && typeof saved.keys[a] === "string" ? saved.keys[a] : ACTIONS[a].def;
      settings.keys[a] = k;
    });
  }
  function saveSettings() { store.set("minty.settings", settings); }
  loadSettings();

  /* ---------- key combos ---------- */
  function combo(e) {
    if (["Control", "Shift", "Alt", "Meta"].indexOf(e.key) !== -1) return null;
    var parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    var k;
    if (/^Key[A-Z]$/.test(e.code || "")) k = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code || "")) k = e.code.slice(5);
    else k = e.key === " " ? "Space" : e.key;
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join("+");
  }

  /* ---------- helpers ---------- */
  function isUrl(val) {
    return /^https?:\/\//.test(val) || (val.indexOf(".") !== -1 && val.slice(0, 1) !== " " && val.indexOf(" ") === -1);
  }
  function resolveInput(input) {
    var v = input.trim();
    if (!isUrl(v)) return ENGINES[settings.engine].url.replace("%s", encodeURIComponent(v));
    if (!/^https?:\/\//.test(v)) return "http://" + v;
    return v;
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return url; }
  }
  function hueOf(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }
  function avatar(url, title) {
    var el = document.createElement("span");
    el.className = "avatar";
    el.style.setProperty("--hue", hueOf(hostOf(url)));
    el.textContent = (hostOf(url) || title || "?").charAt(0).toUpperCase();
    return el;
  }
  // turn the address of a proxied iframe back into the real site URL
  function decodeFrameUrl(href, engine, tab) {
    try { return engines[engine || "uv"].decode(href, tab); } catch (e) { return null; }
  }

  /* ---------- proxy engines ---------- */
  // minty can load sites through Ultraviolet or Scramjet. Each engine knows how to
  // start itself, wrap a fresh iframe, send it to a URL, and read the real URL back
  // out of the iframe's address. Both live side by side (own service worker, own URL
  // prefix); the Proxy setting only decides which one the next page uses.
  var SJ = {
    prefix: "/minty/sj/",
    sw: "/minty/sjsw.js",
    files: {
      wasm: "/minty/sjlib/scramjet.wasm.wasm",
      all: "/minty/sjlib/scramjet.all.js",
      sync: "/minty/sjlib/scramjet.sync.js",
    },
    muxWorker: "/minty/mux/worker.js",
    muxModule: "/minty/mux/index.mjs",
    muxScript: "/minty/mux/index.js",
    transport: "/minty/mod/index.mjs",
  };
  var sj = { controller: null, connection: null };

  function exists(url) {
    return fetch(url, { method: "HEAD", cache: "no-store" }).then(
      function (r) { return r.ok; },
      function () { return false; }
    );
  }
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error("Couldn't load " + src)); };
      document.head.appendChild(el);
    });
  }
  function loadBareMux() {
    if (window.BareMux && window.BareMux.BareMuxConnection) return Promise.resolve(window.BareMux);
    return import(SJ.muxModule)
      .catch(function () {
        return loadScript(SJ.muxScript).then(function () { return window.BareMux; });
      })
      .then(function (m) {
        if (!m || !m.BareMuxConnection) throw new Error("bare-mux loaded, but BareMuxConnection is missing.");
        return m;
      });
  }
  // a page outside the worker's scope can't use navigator.serviceWorker.ready
  function waitActive(reg) {
    return new Promise(function (resolve, reject) {
      // an already-active worker is good enough, even if a newer one is waiting behind it
      var worker = reg.active && reg.active.state === "activated" ? reg.active : (reg.installing || reg.waiting || reg.active);
      if (!worker) { reject(new Error("The service worker didn't install.")); return; }
      if (worker.state === "activated") { resolve(); return; }
      var timer = setTimeout(function () { reject(new Error("The service worker took too long to start.")); }, 10000);
      worker.addEventListener("statechange", function () {
        if (worker.state === "activated") { clearTimeout(timer); resolve(); }
        else if (worker.state === "redundant") { clearTimeout(timer); reject(new Error("The service worker failed to install.")); }
      });
    });
  }

  function startScramjet() {
    if (!("serviceWorker" in navigator)) {
      return Promise.reject(new Error("Service workers aren't available. minty needs HTTPS (or localhost)."));
    }
    if (typeof SharedWorker === "undefined") {
      return Promise.reject(new Error("This browser doesn't support SharedWorker, which Scramjet needs. Use Ultraviolet here."));
    }
    return Promise.all([SJ.files.all, SJ.files.wasm, SJ.muxWorker, SJ.transport].map(exists))
      .then(function (found) {
        if (!found[0] || !found[1]) throw new Error("Scramjet's files are missing from this server (static/public/minty/sjlib).");
        if (!found[2] || !found[3]) throw new Error("Scramjet needs two packages that aren't installed on this server yet. Run \"npm install\", restart the server, and try again.");
        return window.$scramjetLoadController ? null : loadScript(SJ.files.all);
      })
      .then(loadBareMux)
      .then(function (BareMux) {
        // create the connection first: the worker asks the page for its bare-mux port
        sj.connection = new BareMux.BareMuxConnection(SJ.muxWorker);
        sj.controller = new (window.$scramjetLoadController().ScramjetController)({ prefix: SJ.prefix, files: SJ.files });
        return sj.controller.init();
      })
      .then(function () { return navigator.serviceWorker.register(SJ.sw, { scope: SJ.prefix }); })
      .then(waitActive)
      .then(function () { return sj.connection.setTransport(SJ.transport, [location.origin + "/bare/"]); });
  }

  // Scramjet v2 is built differently: the page hosts a "controller" that does the
  // fetching, and the service worker only forwards requests to it. The transport that
  // moves bytes to the internet is minty's own Bare v3 client (sj2lib/bare-transport.js).
  var SJ2 = {
    prefix: "/minty/sj2/",
    sw: "/minty/sj2sw.js",
    lib: "/minty/sj2lib/",
  };
  var sj2 = { controller: null, transport: null };

  function startScramjet2() {
    if (!("serviceWorker" in navigator)) {
      return Promise.reject(new Error("Service workers aren't available. minty needs HTTPS (or localhost)."));
    }
    var files = ["scramjet.js", "scramjet.wasm", "controller.api.js", "controller.inject.js", "controller.sw.js", "bare-transport.js"];
    var reg;
    return Promise.all(files.map(function (f) { return exists(SJ2.lib + f); }))
      .then(function (found) {
        var missing = files.filter(function (f, i) { return !found[i]; });
        if (missing.length) throw new Error("Scramjet v2's files are missing from this server (" + missing.join(", ") + " in static/public/minty/sj2lib).");
      })
      // order matters: the controller needs scramjet loaded first
      .then(function () { return window.$scramjet ? null : loadScript(SJ2.lib + "scramjet.js"); })
      .then(function () { return window.$scramjetController ? null : loadScript(SJ2.lib + "controller.api.js"); })
      .then(function () { return window.MintyBareTransport ? null : loadScript(SJ2.lib + "bare-transport.js"); })
      .then(function () { return navigator.serviceWorker.register(SJ2.sw, { scope: SJ2.prefix }); })
      .then(function (r) { reg = r; return waitActive(r); })
      .then(function () {
        sj2.transport = new window.MintyBareTransport(location.origin + "/bare/");
        return sj2.transport.init();
      })
      .then(function () {
        sj2.controller = new window.$scramjetController.Controller({
          serviceworker: reg.active,
          transport: sj2.transport,
          config: {
            prefix: SJ2.prefix,
            scramjetPath: SJ2.lib + "scramjet.js",
            injectPath: SJ2.lib + "controller.inject.js",
            wasmPath: SJ2.lib + "scramjet.wasm",
          },
        });
        // resolves once the service worker has linked up with this page
        return Promise.race([
          sj2.controller.wait(),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error("The service worker didn't respond.")); }, 10000);
          }),
        ]);
      });
  }

  var engines = {
    uv: {
      prefixFor: function () { return __uv$config.prefix; },
      start: function () {
        if (!("serviceWorker" in navigator)) return Promise.reject(new Error("Service workers aren't available."));
        // wait until it's active: on a first visit the very first page request would
        // otherwise go out before the worker can catch it and come back as a 404
        return navigator.serviceWorker.register("/minty/sw.js", { scope: __uv$config.prefix }).then(waitActive);
      },
      attach: function () { return null; },
      load: function (t, url) { t.frame.src = __uv$config.prefix + __uv$config.encodeUrl(url); },
      decode: function (href) {
        var u = new URL(href);
        var prefix = __uv$config.prefix;
        if (u.origin !== location.origin || u.pathname.indexOf(prefix) !== 0) return null;
        return __uv$config.decodeUrl(u.pathname.slice(prefix.length));
      },
    },
    scramjet: {
      prefixFor: function () { return SJ.prefix; },
      start: startScramjet,
      // Scramjet needs its own wrapper around the iframe (an unwrapped one won't work)
      attach: function (iframe) { return sj.controller.createFrame(iframe); },
      load: function (t, url) { t.handle.go(url); },
      decode: function (href) {
        var u = new URL(href);
        if (u.origin !== location.origin || u.pathname.indexOf(SJ.prefix) !== 0) return null;
        return sj.controller ? sj.controller.decodeUrl(href) : null;
      },
    },
    scramjet2: {
      // every v2 frame has its own prefix, so ask the frame
      prefixFor: function (t) { return t && t.handle ? t.handle.prefix : SJ2.prefix; },
      start: startScramjet2,
      attach: function (iframe) { return sj2.controller.createFrame(iframe); },
      load: function (t, url) { t.handle.go(url); },
      decode: function (href, t) {
        if (!t || !t.handle) return null;
        var u = new URL(href);
        if (u.origin !== location.origin || u.pathname.indexOf(t.handle.prefix) !== 0) return null;
        return window.$scramjet.unrewriteUrl(href, t.handle.context);
      },
    },
  };

  var engineStatus = { uv: "idle", scramjet: "idle", scramjet2: "idle" }; // idle | pending | ok | error
  var engineError = { uv: "", scramjet: "", scramjet2: "" };
  var engineReady = {};

  // starts an engine once; resolves true when it's usable, false if it couldn't start
  function startEngine(id) {
    if (engineReady[id]) return engineReady[id];
    engineStatus[id] = "pending";
    engineReady[id] = engines[id].start().then(
      function () {
        engineStatus[id] = "ok";
        engineError[id] = "";
        renderProxyStatus();
        return true;
      },
      function (err) {
        console.error(err);
        engineStatus[id] = "error";
        engineError[id] = err && err.message ? err.message : String(err);
        engineReady[id] = null; // let the next attempt try again
        renderProxyStatus();
        return false;
      }
    );
    renderProxyStatus();
    return engineReady[id];
  }

  /* ---------- tabs ---------- */
  var tabs = [];
  var activeId = null;
  var seq = 0;
  var tabsEl = $("#tabs");
  var viewport = $("#viewport");
  var homeEl = $("#home");
  var urlInput = $("#url-input");
  var starBtn = $("#btn-star");

  function activeTab() {
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === activeId) return tabs[i];
    return null;
  }

  function newTab(url) {
    var t = { id: ++seq, url: "", title: "New Tab", frame: null, engine: null, handle: null, el: null, titleEl: null, last: "" };
    var el = document.createElement("div");
    el.className = "tab";
    el.setAttribute("role", "tab");
    el.tabIndex = 0;
    var dot = document.createElement("span");
    dot.className = "tab-dot";
    t.titleEl = document.createElement("span");
    t.titleEl.className = "tab-title";
    t.titleEl.textContent = t.title;
    var close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.setAttribute("aria-label", "Close tab");
    close.innerHTML = "&times;";
    el.appendChild(dot);
    el.appendChild(t.titleEl);
    el.appendChild(close);
    el.addEventListener("click", function () { activate(t.id); });
    el.addEventListener("keydown", function (e) {
      if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); activate(t.id); }
    });
    el.addEventListener("auxclick", function (e) { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
    close.addEventListener("click", function (e) { e.stopPropagation(); closeTab(t.id); });
    t.el = el;
    tabsEl.appendChild(el);
    tabs.push(t);
    activate(t.id);
    if (url) navigate(t, url, true);
    else urlInput.focus();
    return t;
  }

  function closeTab(id) {
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].id === id) idx = i;
    if (idx === -1) return;
    var t = tabs[idx];
    if (document.fullscreenElement && t.frame === document.fullscreenElement) document.exitFullscreen();
    if (t.frame) t.frame.remove();
    t.el.remove();
    tabs.splice(idx, 1);
    if (!tabs.length) { newTab(); return; }
    if (activeId === id) activate(tabs[Math.min(idx, tabs.length - 1)].id);
  }

  function activate(id) {
    activeId = id;
    var cur = activeTab();
    tabs.forEach(function (t) {
      var on = t.id === id;
      t.el.classList.toggle("active", on);
      t.el.setAttribute("aria-selected", on ? "true" : "false");
      if (t.frame) t.frame.hidden = !on;
    });
    homeEl.hidden = !!(cur && cur.frame);
    if (cur && !cur.frame) renderQuickLinks();
    syncChrome();
    if (cur && cur.frame) { try { cur.frame.focus(); } catch (e) { /* ignore */ } }
  }

  function syncChrome() {
    var t = activeTab();
    if (document.activeElement !== urlInput) urlInput.value = t && t.url ? t.url : "";
    document.title = t && t.frame && t.title ? t.title + " - minty" : "minty";
    starBtn.disabled = !(t && t.url);
    var marked = !!(t && t.url && findBookmark(t.url) !== -1);
    starBtn.classList.toggle("on", marked);
    starBtn.title = marked ? "Remove bookmark" : "Bookmark this page";
  }

  function dropFrame(t) {
    if (document.fullscreenElement && t.frame === document.fullscreenElement) document.exitFullscreen();
    if (t.frame) t.frame.remove();
    t.frame = null;
    t.handle = null;
    t.engine = null;
    t.last = "";
  }

  // frameName must be given here: an iframe renamed after it's in the page can't be
  // targeted by name (forms and links with target=...)
  function ensureFrame(t, engineId, frameName) {
    // a tab that was loaded with the other proxy gets a fresh frame for the new one
    if (t.frame && t.engine !== engineId) dropFrame(t);
    if (t.frame) return;
    var f = document.createElement("iframe");
    f.className = "uv-frame";
    f.setAttribute("allowfullscreen", "");
    f.setAttribute("allow", "fullscreen; autoplay; encrypted-media; clipboard-read; clipboard-write");
    f.hidden = t.id !== activeId;
    f.addEventListener("load", function () { hookFrame(t); pollTab(t); });
    t.engine = engineId;
    if (frameName) f.name = frameName;
    t.handle = engines[engineId].attach(f);
    viewport.appendChild(f);
    t.frame = f;
  }

  function navigate(t, input, alreadyResolved) {
    var raw = (input || "").trim();
    if (!raw) return Promise.resolve();
    var url = alreadyResolved && /^https?:\/\//.test(raw) ? raw : resolveInput(raw);
    var id = settings.proxy;
    return startEngine(id).then(function (ok) {
      var err = $("#uv-error"), code = $("#uv-error-code");
      if (!ok) {
        var msg = id === "uv"
          ? "Failed to register the service worker. minty needs HTTPS (or localhost)."
          : PROXIES[id].name + " couldn't start. " + engineError[id];
        err.textContent = msg;
        code.textContent = "";
        // the new-tab page (and its error line) is hidden while a site is showing
        if (t.frame) alert(msg);
        return;
      }
      err.textContent = "";
      showSite(t, id, url);
    });
  }

  // load a real URL into a tab right now, using an engine that has already started
  function showSite(t, id, url) {
    t.url = url;
    t.title = hostOf(url);
    t.titleEl.textContent = t.title;
    ensureFrame(t, id);
    engines[id].load(t, url);
    if (t.id === activeId) activate(t.id);
  }

  function goHome(t) {
    if (t.frame) { t.frame.remove(); t.frame = null; }
    t.handle = null;
    t.engine = null;
    t.url = "";
    t.last = "";
    t.title = "New Tab";
    t.titleEl.textContent = t.title;
    if (t.id === activeId) { activate(t.id); urlInput.focus(); }
  }

  function pollTab(t) {
    if (!t.frame) return;
    try {
      var href = t.frame.contentWindow.location.href;
      if (href !== t.last) {
        t.last = href;
        var u = decodeFrameUrl(href, t.engine, t);
        if (u) t.url = u;
      }
      var title = t.frame.contentDocument && t.frame.contentDocument.title;
      if (title && title !== t.title) {
        t.title = title;
        t.titleEl.textContent = title;
      } else if (!title && t.url && t.title === "New Tab") {
        t.titleEl.textContent = hostOf(t.url);
      }
    } catch (e) { /* cross-origin or mid-navigation */ }
    if (t.id === activeId) syncChrome();
  }
  setInterval(function () { tabs.forEach(pollTab); }, 1000);

  /* ---------- frame helpers ---------- */
  function frameOp(fn) {
    var t = activeTab();
    if (!t || !t.frame) return;
    try { fn(t.frame.contentWindow, t); } catch (e) { /* ignore */ }
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    var t = activeTab();
    if (t && t.frame && !t.frame.hidden && t.frame.requestFullscreen) {
      t.frame.requestFullscreen().catch(function () { /* blocked by browser */ });
    }
  }

  /* ---------- bookmarks ---------- */
  var bookmarks = store.get("minty.bookmarks", []);
  if (!Array.isArray(bookmarks)) bookmarks = [];
  var bar = $("#bookmarks-bar");

  function saveBookmarks() { store.set("minty.bookmarks", bookmarks); }
  function findBookmark(url) {
    for (var i = 0; i < bookmarks.length; i++) if (bookmarks[i].url === url) return i;
    return -1;
  }
  function openUrl(url, newTabFlag) {
    if (newTabFlag) newTab(url);
    else { var t = activeTab(); if (t) navigate(t, url, true); }
  }
  function toggleBookmark() {
    var t = activeTab();
    if (!t || !t.url) return;
    var i = findBookmark(t.url);
    if (i === -1) bookmarks.push({ title: t.title || hostOf(t.url), url: t.url });
    else bookmarks.splice(i, 1);
    saveBookmarks();
    renderBookmarks();
  }

  function renderBookmarks() {
    bar.hidden = !settings.showBookmarks;
    bar.textContent = "";
    if (!bookmarks.length) {
      var empty = document.createElement("span");
      empty.className = "bb-empty";
      empty.textContent = "No bookmarks yet. Press the star in the address bar to add one.";
      bar.appendChild(empty);
    }
    bookmarks.forEach(function (b) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bb-chip";
      chip.title = b.url;
      chip.appendChild(avatar(b.url, b.title));
      var label = document.createElement("span");
      label.textContent = b.title;
      chip.appendChild(label);
      chip.addEventListener("click", function (e) { openUrl(b.url, e.ctrlKey || e.metaKey); });
      chip.addEventListener("auxclick", function (e) { if (e.button === 1) { e.preventDefault(); openUrl(b.url, true); } });
      bar.appendChild(chip);
    });
    renderBookmarkList();
    renderQuickLinks();
    syncChrome();
  }

  function renderQuickLinks() {
    var box = $("#quick-links");
    box.textContent = "";
    if (!bookmarks.length) {
      var hint = document.createElement("p");
      hint.className = "quick-hint";
      hint.textContent = "Your bookmarks will show up here.";
      box.appendChild(hint);
      return;
    }
    bookmarks.slice(0, 12).forEach(function (b) {
      var tile = document.createElement("button");
      tile.type = "button";
      tile.className = "tile";
      tile.appendChild(avatar(b.url, b.title));
      var label = document.createElement("span");
      label.className = "tile-label";
      label.textContent = b.title;
      tile.appendChild(label);
      tile.addEventListener("click", function () { openUrl(b.url, false); });
      box.appendChild(tile);
    });
  }

  function renderBookmarkList() {
    var list = $("#bm-list");
    list.textContent = "";
    if (!bookmarks.length) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No bookmarks yet.";
      list.appendChild(li);
      return;
    }
    bookmarks.forEach(function (b, i) {
      var li = document.createElement("li");
      li.className = "row";
      var main = document.createElement("button");
      main.type = "button";
      main.className = "row-main";
      main.appendChild(avatar(b.url, b.title));
      var text = document.createElement("span");
      text.className = "row-text";
      var title = document.createElement("span");
      title.className = "row-title";
      title.textContent = b.title;
      var sub = document.createElement("span");
      sub.className = "row-sub";
      sub.textContent = b.url;
      text.appendChild(title);
      text.appendChild(sub);
      main.appendChild(text);
      main.addEventListener("click", function () { $("#dlg-bookmarks").close(); openUrl(b.url, false); });
      var del = document.createElement("button");
      del.type = "button";
      del.className = "row-del";
      del.setAttribute("aria-label", "Remove bookmark");
      del.innerHTML = "&times;";
      del.addEventListener("click", function () { bookmarks.splice(i, 1); saveBookmarks(); renderBookmarks(); });
      li.appendChild(main);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  $("#bm-add").addEventListener("click", toggleBookmarkAdd);
  function toggleBookmarkAdd() {
    var t = activeTab();
    if (t && t.url && findBookmark(t.url) === -1) toggleBookmark();
  }
  $("#bm-clear").addEventListener("click", function () {
    if (bookmarks.length && confirm("Remove all bookmarks?")) { bookmarks = []; saveBookmarks(); renderBookmarks(); }
  });
  $("#bm-export").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(bookmarks, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "minty-bookmarks.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  $("#bm-import").addEventListener("click", function () { $("#bm-file").click(); });
  $("#bm-file").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error("not a list");
        data.forEach(function (b) {
          if (b && typeof b.url === "string" && /^https?:\/\//.test(b.url) && findBookmark(b.url) === -1) {
            bookmarks.push({ title: String(b.title || hostOf(b.url)), url: b.url });
          }
        });
        saveBookmarks();
        renderBookmarks();
      } catch (err) { alert("That file isn't a valid bookmarks export."); }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  /* ---------- actions & shortcuts ---------- */
  function setBookmarksBar(show) {
    settings.showBookmarks = show;
    saveSettings();
    bar.hidden = !show;
    var sw = $("#set-bar");
    if (sw) sw.checked = show;
  }

  var runAction = {
    fullscreen: toggleFullscreen,
    bookmarks: function () { setBookmarksBar(!settings.showBookmarks); },
    newTab: function () { newTab(); },
    closeTab: function () { var t = activeTab(); if (t) closeTab(t.id); },
  };

  var capturing = false;
  function onKey(e) {
    if (capturing) return;
    var c = combo(e);
    if (!c) return;
    var actions = Object.keys(settings.keys);
    for (var i = 0; i < actions.length; i++) {
      if (settings.keys[actions[i]] === c) {
        e.preventDefault();
        e.stopPropagation();
        runAction[actions[i]]();
        return;
      }
    }
  }
  document.addEventListener("keydown", onKey, true);

  // proxied pages are same-origin, so shortcuts keep working while the site has focus
  function hookFrame(t) {
    var win;
    try {
      win = t.frame.contentWindow;
      win.addEventListener("keydown", onKey, true);
    } catch (e) { return; }
    try { hookNewTabs(t, win); } catch (e) { console.error("minty: couldn't hook new-tab handling", e); }
  }

  /* ---------- sites that try to open a new browser tab ---------- */
  // A proxied page can leave minty through target="_blank" links, Ctrl/Shift/middle
  // clicks, forms and window.open(). Those would open a real browser tab, outside the
  // proxy, so they're caught here and shown inside minty instead: in a new minty tab,
  // or in the same tab, depending on Settings.
  var nativeGetAttr = Element.prototype.getAttribute;
  var nativeSetAttr = Element.prototype.setAttribute;
  var recentOpen = { url: "", at: 0, win: null };

  // the real URL of the page currently showing in a tab's frame
  function pageUrl(t, win) {
    try { return decodeFrameUrl(win.location.href, t.engine, t) || t.url; } catch (e) { return t.url; }
  }

  // a link's href attribute is already in proxied form (/minty/ixl/..., /minty/sj/...)
  function linkTarget(t, win, raw) {
    var prefix = engines[t.engine].prefixFor(t);
    var real = null;
    if (raw.indexOf(prefix) === 0 || raw.indexOf(location.origin + prefix) === 0) {
      real = decodeFrameUrl(new URL(raw, location.href).href, t.engine, t);
    }
    if (!real) { try { real = new URL(raw, pageUrl(t, win)).href; } catch (e) { return null; } }
    return /^https?:\/\//i.test(real) ? real : null;
  }

  // a blank tab for window.open("") / window.open("about:blank"); the page fills it in
  function openBlankTab(t) {
    var nt = newTab();
    ensureFrame(nt, t.engine);
    activate(nt.id);
    urlInput.blur();
    return nt.frame.contentWindow;
  }

  // show a real URL the way settings say; returns the window it ended up in
  function openFromPage(t, url) {
    var target = t;
    if (settings.newTabLinks !== "same") {
      target = newTab();
    }
    showSite(target, t.engine, url);
    urlInput.blur(); // a fresh minty tab focuses the address bar; the page should have focus
    recentOpen = { url: url, at: Date.now(), win: target.frame ? target.frame.contentWindow : null };
    return recentOpen.win;
  }

  function hookNewTabs(t, win) {
    var doc = win.document;

    function onLinkClick(e) {
      if (e.type === "auxclick" ? e.button !== 1 : e.button !== 0) return;
      var a = null;
      var path = e.composedPath ? e.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        var el = path[i];
        if (el && el.nodeType === 1) {
          var name = String(el.localName).toLowerCase();
          if ((name === "a" || name === "area") && nativeGetAttr.call(el, "href") != null) { a = el; break; }
        }
      }
      if (!a) return;
      var target = nativeGetAttr.call(a, "target");
      if (target == null) {
        var base = doc.querySelector("base[target]");
        if (base) target = nativeGetAttr.call(base, "target");
      }
      var wantsNewTab = (target && target.toLowerCase() === "_blank") || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1;
      if (!wantsNewTab) return;
      var url = linkTarget(t, win, nativeGetAttr.call(a, "href"));
      if (!url) return; // javascript:, mailto:, #hash... leave it to the page
      e.preventDefault();
      openFromPage(t, url);
    }
    doc.addEventListener("click", onLinkClick, true);
    doc.addEventListener("auxclick", onLinkClick, true);

    // <form target="_blank">: point it at a minty tab's frame and let it submit normally
    doc.addEventListener("submit", function (e) {
      var form = e.target;
      if (!form || e.defaultPrevented || !form.nodeType) return;
      var target = nativeGetAttr.call(form, "target");
      if (!target || target.toLowerCase() !== "_blank") return;
      if (settings.newTabLinks === "same") {
        nativeSetAttr.call(form, "target", "_self");
        return;
      }
      var nt = newTab();
      ensureFrame(nt, t.engine, "minty-" + nt.id);
      nativeSetAttr.call(form, "target", nt.frame.name); // Scramjet may pick its own name
      activate(nt.id);
    }, true);

    // window.open()
    var realOpen = win.open;
    function patchedOpen(url, target) {
      var args = arguments;
      var name = target == null || target === "" ? "_blank" : String(target);
      if (/^_(self|parent|top)$/i.test(name)) return realOpen.apply(win, args);
      try { if (name !== "_blank" && win.frames[name]) return realOpen.apply(win, args); } catch (e) { /* ignore */ }
      var raw = url == null ? "" : String(url);
      if (raw === "" || raw === "about:blank") return openBlankTab(t);
      var real;
      try { real = new URL(raw, pageUrl(t, win)).href; } catch (e) { return realOpen.apply(win, args); }
      if (!/^https?:\/\//i.test(real)) return realOpen.apply(win, args);
      // a click handler may have already opened this very link a moment ago
      if (recentOpen.url === real && Date.now() - recentOpen.at < 800) return recentOpen.win;
      return openFromPage(t, real);
    }
    try {
      Object.defineProperty(win, "open", { value: patchedOpen, writable: true, configurable: true });
    } catch (e) { /* the page locked window.open; links and forms are still handled */ }
  }

  function prettyKey(k) { return k.replace(/\+/g, " + "); }
  function refreshHints() {
    document.querySelectorAll("[data-hint]").forEach(function (el) {
      el.textContent = prettyKey(settings.keys[el.getAttribute("data-hint")] || "");
    });
  }

  /* ---------- menu ---------- */
  var menu = $("#menu");
  var menuBtn = $("#menu-btn");
  function setMenu(open) {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  menuBtn.addEventListener("click", function (e) { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener("click", function (e) {
    if (!menu.hidden && !menu.contains(e.target)) setMenu(false);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });
  // clicks inside the proxied page don't bubble to this document, so close on blur too
  window.addEventListener("blur", function () { setMenu(false); });

  var menuActions = {
    newTab: function () { newTab(); },
    bookmarkPage: toggleBookmark,
    bookmarks: function () { $("#dlg-bookmarks").showModal(); },
    toggleBar: function () { runAction.bookmarks(); },
    fullscreen: toggleFullscreen,
    closeTab: function () { runAction.closeTab(); },
    settings: function () { renderSettings(); $("#dlg-settings").showModal(); },
  };
  menu.addEventListener("click", function (e) {
    var b = e.target.closest("button[data-act]");
    if (!b) return;
    setMenu(false);
    menuActions[b.getAttribute("data-act")]();
  });

  /* ---------- dialogs ---------- */
  document.querySelectorAll("dialog").forEach(function (d) {
    d.addEventListener("click", function (e) { if (e.target === d) d.close(); });
    var x = d.querySelector(".dlg-close");
    if (x) x.addEventListener("click", function () { d.close(); });
  });

  /* ---------- settings dialog ---------- */
  var keyList = $("#key-list");
  function renderSettings() {
    var sel = $("#set-engine");
    sel.textContent = "";
    Object.keys(ENGINES).forEach(function (id) {
      var o = document.createElement("option");
      o.value = id;
      o.textContent = ENGINES[id].name;
      sel.appendChild(o);
    });
    sel.value = settings.engine;
    $("#set-bar").checked = settings.showBookmarks;

    var proxySel = $("#set-proxy");
    proxySel.textContent = "";
    Object.keys(PROXIES).forEach(function (id) {
      var o = document.createElement("option");
      o.value = id;
      o.textContent = PROXIES[id].name;
      proxySel.appendChild(o);
    });
    proxySel.value = settings.proxy;
    $("#set-links").value = settings.newTabLinks;
    renderProxyStatus();

    keyList.textContent = "";
    Object.keys(ACTIONS).forEach(function (a) {
      var row = document.createElement("div");
      row.className = "setting";
      var label = document.createElement("div");
      label.className = "setting-label";
      label.textContent = ACTIONS[a].label;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = prettyKey(settings.keys[a]);
      btn.title = "Click, then press the new shortcut. Esc cancels.";
      btn.addEventListener("click", function () { captureKey(a, btn); });
      row.appendChild(label);
      row.appendChild(btn);
      keyList.appendChild(row);
    });
  }

  // the service-worker row always describes whichever proxy is selected
  function renderProxyStatus() {
    var pill = $("#sw-status");
    var detail = $("#proxy-detail");
    if (!pill || !detail) return;
    var id = settings.proxy;
    var st = engineStatus[id];
    pill.className = "status-pill" + (st === "ok" ? " good" : st === "error" ? " bad" : "");
    pill.textContent = st === "ok" ? "active" : st === "error" ? "not available" : "starting…";
    detail.hidden = st !== "error";
    detail.textContent = st === "error" ? PROXIES[id].name + " couldn't start. " + engineError[id] : "";
  }

  function captureKey(action, btn) {
    capturing = true;
    btn.textContent = "press keys…";
    function done() {
      capturing = false;
      window.removeEventListener("keydown", handler, true);
      btn.textContent = prettyKey(settings.keys[action]);
    }
    function handler(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { done(); return; }
      var c = combo(e);
      if (!c) return; // only a modifier so far
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        btn.textContent = "add Ctrl, Alt or Meta";
        return;
      }
      var clash = Object.keys(settings.keys).filter(function (o) { return o !== action && settings.keys[o] === c; })[0];
      if (clash) {
        btn.textContent = "used by " + ACTIONS[clash].label.toLowerCase();
        return;
      }
      settings.keys[action] = c;
      saveSettings();
      refreshHints();
      done();
    }
    window.addEventListener("keydown", handler, true);
  }

  $("#set-engine").addEventListener("change", function (e) { settings.engine = e.target.value; saveSettings(); });
  $("#set-links").addEventListener("change", function (e) { settings.newTabLinks = e.target.value; saveSettings(); });
  $("#set-proxy").addEventListener("change", function (e) {
    settings.proxy = e.target.value;
    saveSettings();
    startEngine(settings.proxy); // warm it up now so the status shown is the real one
    renderProxyStatus();
  });
  $("#set-bar").addEventListener("change", function (e) { setBookmarksBar(e.target.checked); });
  $("#keys-reset").addEventListener("click", function () {
    Object.keys(ACTIONS).forEach(function (a) { settings.keys[a] = ACTIONS[a].def; });
    saveSettings();
    refreshHints();
    renderSettings();
  });
  $("#data-reset").addEventListener("click", function () {
    if (!confirm("Reset all settings and shortcuts? Bookmarks are kept.")) return;
    store.del("minty.settings");
    loadSettings();
    startEngine(settings.proxy);
    bar.hidden = !settings.showBookmarks;
    refreshHints();
    renderSettings();
  });

  /* ---------- toolbar & address bar ---------- */
  $("#new-tab").addEventListener("click", function () { newTab(); });
  $("#btn-back").addEventListener("click", function () { frameOp(function (w) { w.history.back(); }); });
  $("#btn-forward").addEventListener("click", function () { frameOp(function (w) { w.history.forward(); }); });
  $("#btn-reload").addEventListener("click", function () {
    frameOp(function (w, t) { try { w.location.reload(); } catch (e) { t.frame.src = t.frame.src; } });
  });
  $("#btn-home").addEventListener("click", function () { var t = activeTab(); if (t) goHome(t); });
  starBtn.addEventListener("click", toggleBookmark);

  $("#url-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var t = activeTab();
    if (t) { navigate(t, urlInput.value); urlInput.blur(); }
  });
  urlInput.addEventListener("focus", function () { urlInput.select(); });
  urlInput.addEventListener("blur", syncChrome);

  $("#uv-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var input = $("#uv-address");
    var t = activeTab();
    if (t) navigate(t, input.value);
    input.value = "";
  });

  /* ---------- boot ---------- */
  renderBookmarks();
  refreshHints();
  startEngine(settings.proxy);
  var start = null;
  try {
    // the landing page hands over the plain URL so either proxy can encode it
    var plain = sessionStorage.getItem("startUrl");
    if (plain) { start = plain; sessionStorage.removeItem("startUrl"); }
    var enc = sessionStorage.getItem("encodedUrl"); // older landing pages stored a UV-encoded URL
    if (enc) {
      if (!start) start = __uv$config.decodeUrl(enc);
      sessionStorage.removeItem("encodedUrl");
    }
  } catch (e) { /* ignore */ }
  newTab(start || undefined);
})();
