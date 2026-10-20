/* minty: a Scramjet v2 transport that talks Bare v3 to minty's own /bare/ server.
 *
 * Scramjet v2 doesn't talk to the network itself; it is handed a "transport" with
 *   ready, init(), request(...) and connect(...)
 * This one implements those on top of the Bare server minty already runs, so no extra
 * server (e.g. Wisp) is needed.
 *
 *   var transport = new MintyBareTransport(location.origin + "/bare/");
 */
(function () {
  "use strict";

  var MAX_HEADER_VALUE = 3072; // Bare splits long x-bare-headers into chunks of this size

  // the browser already decoded the body, so the encoding/length headers no longer apply
  var DROP_RESPONSE = { "content-encoding": 1, "content-length": 1, "transfer-encoding": 1 };
  // set by the WebSocket handshake itself, never by the page
  var DROP_WS_REQUEST = {
    host: 1, connection: 1, upgrade: 1,
    "sec-websocket-key": 1, "sec-websocket-version": 1,
    "sec-websocket-extensions": 1, "sec-websocket-protocol": 1,
  };

  function rawToObject(raw, drop) {
    var out = {};
    for (var i = 0; i < raw.length; i++) {
      var name = raw[i][0], value = raw[i][1];
      if (drop && drop[name.toLowerCase()]) continue;
      if (out[name] === undefined) out[name] = value;
      else if (Array.isArray(out[name])) out[name].push(value);
      else out[name] = [out[name], value];
    }
    return out;
  }

  function objectToRaw(obj) {
    var out = [];
    for (var name in obj) {
      var v = obj[name];
      if (Array.isArray(v)) for (var i = 0; i < v.length; i++) out.push([name, String(v[i])]);
      else out.push([name, String(v)]);
    }
    return out;
  }

  // header values must be Latin-1, so escape anything else; JSON.parse undoes it server-side
  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u0080-\uffff]/g, function (c) {
      return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function bareRequestHeaders(url, sendHeaders) {
    var h = { "x-bare-url": url };
    var json = asciiJson(sendHeaders);
    if (json.length > MAX_HEADER_VALUE) {
      for (var i = 0, n = 0; i < json.length; i += MAX_HEADER_VALUE) {
        h["x-bare-headers-" + n++] = ";" + json.slice(i, i + MAX_HEADER_VALUE);
      }
    } else {
      h["x-bare-headers"] = json;
    }
    return h;
  }

  function readBareHeaders(headers) {
    if (!headers.has("x-bare-headers-0")) return headers.get("x-bare-headers");
    var parts = [];
    headers.forEach(function (value, name) {
      var m = /^x-bare-headers-(\d+)$/.exec(name);
      if (m) parts[+m[1]] = value.charAt(0) === ";" ? value.slice(1) : value;
    });
    return parts.join("");
  }

  function MintyBareTransport(server) {
    var url = new URL(server, location.href);
    if (url.pathname.slice(-1) !== "/") url.pathname += "/";
    this.server = url; // e.g. http://host/bare/
    this.ready = false;
  }

  MintyBareTransport.prototype.init = async function () {
    var res;
    try {
      res = await fetch(this.server.href, { cache: "no-store", credentials: "omit" });
    } catch (e) {
      throw new Error("Couldn't reach the Bare server at " + this.server.href);
    }
    var info;
    try { info = await res.json(); } catch (e) { info = null; }
    if (!info || !Array.isArray(info.versions)) {
      throw new Error("No Bare server answered at " + this.server.href);
    }
    if (info.versions.indexOf("v3") === -1) {
      throw new Error("The Bare server doesn't support Bare v3 (it offers " + info.versions.join(", ") + ").");
    }
    this.ready = true;
  };

  MintyBareTransport.prototype.request = async function (remote, method, body, headers, signal) {
    var send = rawToObject(headers || []);
    var hasHost = false;
    for (var k in send) if (k.toLowerCase() === "host") hasHost = true;
    if (!hasHost) send.Host = remote.host; // the server doesn't add one itself

    var payload = body == null ? null : body;
    if (payload !== null && typeof payload !== "string" && !(payload instanceof ArrayBuffer) && !ArrayBuffer.isView(payload)) {
      // streams, blobs and form data: browsers can't stream uploads over plain HTTP/1.1
      payload = await new Response(payload).arrayBuffer();
    }
    if (method === "GET" || method === "HEAD") payload = null;

    var res = await fetch(this.server.href + "v3/", {
      method: method,
      headers: bareRequestHeaders(remote.href, send),
      body: payload,
      signal: signal,
      redirect: "manual",
      credentials: "omit",
      cache: "no-store", // every request shares one URL, so it must never be cached
    });

    var status = res.headers.get("x-bare-status");
    if (status === null) {
      var detail = "";
      try { var err = await res.json(); detail = err.message || err.code || ""; } catch (e) { /* not JSON */ }
      throw new Error("Bare server error " + res.status + (detail ? ": " + detail : ""));
    }

    var raw = [];
    var json = readBareHeaders(res.headers);
    if (json) {
      raw = objectToRaw(JSON.parse(json)).filter(function (pair) {
        return !DROP_RESPONSE[pair[0].toLowerCase()];
      });
    }

    return {
      body: res.body || new ArrayBuffer(0),
      headers: raw,
      status: parseInt(status, 10),
      statusText: res.headers.get("x-bare-status-text") || "",
    };
  };

  MintyBareTransport.prototype.connect = function (url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    var wsUrl = new URL("v3/", this.server);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

    var socket = new WebSocket(wsUrl.href);
    socket.binaryType = "arraybuffer";
    var opened = false;
    var finished = false;

    function fail(message) {
      if (finished) return;
      finished = true;
      onerror(message);
    }

    socket.onopen = function () {
      socket.send(JSON.stringify({
        type: "connect",
        remote: url.href,
        protocols: protocols || [],
        headers: rawToObject(requestHeaders || [], DROP_WS_REQUEST),
        forwardHeaders: ["accept-encoding", "accept-language"],
      }));
    };

    socket.onmessage = function (event) {
      if (!opened) {
        // the first message is the server's answer to our connect packet
        try {
          var packet = JSON.parse(event.data);
          if (packet.type !== "open") throw new Error("unexpected packet");
          opened = true;
          onopen(packet.protocol || "", "");
        } catch (e) {
          fail("Bare server sent an invalid WebSocket handshake");
          socket.close();
        }
        return;
      }
      onmessage(event.data);
    };

    socket.onerror = function () { fail("WebSocket connection failed"); };
    socket.onclose = function (event) {
      if (!opened) { fail("WebSocket closed before it opened"); return; }
      if (finished) return;
      finished = true;
      onclose(event.code, event.reason);
    };

    return [
      function send(data) { socket.send(data); },
      function close(code, reason) {
        try { socket.close(code, reason); } catch (e) { socket.close(); }
      },
    ];
  };

  self.MintyBareTransport = MintyBareTransport;
})();
