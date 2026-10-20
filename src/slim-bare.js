// Bare packs *every* upstream response header into one JSON blob, which it then
// sends back split across x-bare-headers-0, -1, -2... lines. Sites like YouTube
// answer with 6-10KB of headers (CSP, permissions-policy, origin-trial, ...), and
// reverse proxies in front of small hosts (nginx's default proxy_buffer_size is
// 4-8KB) reject that with a 502 - which shows up as "web server isn't running".
//
// Ultraviolet strips or ignores all of the headers below on the client anyway, so
// dropping them here keeps the response small without changing behaviour.

const CHUNK = 3072; // same chunk size bare uses

const DROP = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "report-to",
  "reporting-endpoints",
  "permissions-policy",
  "feature-policy",
  "origin-trial",
  "accept-ch",
  "critical-ch",
  "nel",
  "cross-origin-opener-policy",
  "cross-origin-opener-policy-report-only",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "x-frame-options",
  "x-content-type-options",
  "x-xss-protection",
  "strict-transport-security",
  "alt-svc",
  "link",
  "p3p",
  "server-timing",
  "expect-ct",
  "public-key-pins",
]);

// Headers the proxy genuinely needs. Anything else is only kept when it is small:
// a blocklist alone can't keep up with whatever a big site decides to send.
const KEEP = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-disposition",
  "content-language",
  "content-range",
  "accept-ranges",
  "location",
  "set-cookie",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "date",
  "age",
  "vary",
  "refresh",
  "retry-after",
  "www-authenticate",
]);
const MAX_UNKNOWN = 400; // bytes of JSON for any header not in KEEP

const PART = /^x-bare-headers-(\d+)$/;

const seenHosts = new Set();

// Log the first upstream result per site, so the host's console shows whether a
// request reached this server and what the target answered with.
function logFirst(res, req) {
  let host;
  try {
    host = new URL(String(req.headers["x-bare-url"])).host;
  } catch {
    return;
  }
  if (seenHosts.has(host)) return;
  seenHosts.add(host);
  console.log(
    `bare: first request for ${host} -> upstream status ${res.getHeader("x-bare-status") ?? "none"} (bare ${res.statusCode})`,
  );
}

function slim(res, req) {
  logFirst(res, req);
  const names = res
    .getHeaderNames()
    .filter((n) => n === "x-bare-headers" || PART.test(n));
  if (!names.length) return;

  let json;
  if (names.length === 1 && names[0] === "x-bare-headers") {
    json = String(res.getHeader("x-bare-headers"));
  } else {
    const parts = [];
    for (const n of names) {
      const m = PART.exec(n);
      if (!m) continue;
      parts[Number(m[1])] = String(res.getHeader(n)).replace(/^;/, "");
    }
    json = parts.join("");
  }

  const headers = JSON.parse(json);
  let dropped = 0;
  for (const key of Object.keys(headers)) {
    const name = key.toLowerCase();
    if (
      DROP.has(name) ||
      (!KEEP.has(name) && JSON.stringify(headers[key]).length > MAX_UNKNOWN)
    ) {
      delete headers[key];
      dropped++;
    }
  }
  if (!dropped) return;

  const out = JSON.stringify(headers);
  for (const n of names) res.removeHeader(n);
  if (out.length > CHUNK) {
    let id = 0;
    for (let i = 0; i < out.length; i += CHUNK) {
      res.setHeader(`x-bare-headers-${id++}`, `;${out.slice(i, i + CHUNK)}`);
    }
  } else {
    res.setHeader("x-bare-headers", out);
  }

  if (out.length > 3000) {
    // still big: say which headers are responsible
    const top = Object.keys(headers)
      .map((k) => [k, JSON.stringify(headers[k]).length])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    console.log(`bare: still ${out.length} bytes after slimming; largest: ${top}`);
  }

  if (json.length - out.length > 2000) {
    let host = "?";
    try {
      host = new URL(String(req.headers["x-bare-url"])).host;
    } catch {
      /* ignore */
    }
    console.log(
      `bare: slimmed response headers for ${host}: ${json.length} -> ${out.length} bytes`,
    );
  }
}

/** Call before bare.routeRequest(req, res). */
export function slimBareResponse(req, res) {
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    try {
      slim(res, req);
    } catch (err) {
      console.error("slim-bare failed (sending headers untouched):", err);
    }
    return writeHead.apply(this, args);
  };
}