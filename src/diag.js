// GET /__diag - shows what *this server* sees when it reaches out to a few sites.
// It only contacts the fixed hosts below (no user input), so it can't be used as an open relay.
// Delete the route in src/index.js once you're done debugging.
import dns from "node:dns/promises";

const HOSTS = [
  "example.com",
  "www.google.com",
  "play.geforcenow.com",
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
];

async function probe(host) {
  const out = { host };
  try {
    const addrs = await dns.lookup(host, { all: true });
    out.dns = addrs.map((a) => a.address);
  } catch (err) {
    out.dns = `lookup failed: ${err.code || err.message}`;
  }
  const started = Date.now();
  try {
    const res = await fetch(`https://${host}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) minty-diag" },
    });
    const text = (await res.text()).replace(/\s+/g, " ");
    out.status = res.status;
    out.server = res.headers.get("server");
    out.contentType = res.headers.get("content-type");
    out.headerBytes = [...res.headers].reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
    out.bodyStart = text.slice(0, 140);
    out.looksLikeHostErrorPage = /wispbyte|web server isn.t running/i.test(text);
  } catch (err) {
    out.error = `${err.name}: ${err.cause?.code || err.message}`;
  }
  out.ms = Date.now() - started;
  return out;
}

export async function diag(req, res) {
  const results = await Promise.all(HOSTS.map(probe));
  res.type("application/json").send(
    JSON.stringify({ node: process.version, time: new Date().toISOString(), results }, null, 2),
  );
}
