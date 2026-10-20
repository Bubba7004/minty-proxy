// Optional Scramjet v1 support. (Scramjet v2 needs nothing from here: it is fully
// vendored in static/public/minty/sj2lib/ and uses minty's own Bare transport.)
//
// The browser half of Scramjet is vendored in static/public/minty/sjlib/ (taken from
// @mercuryworkshop/scramjet 1.1.0), so it needs nothing from npm. At runtime it also
// needs the bare-mux worker plus a transport that talks to minty's existing /bare/
// server. Those come from two small npm packages and are served from node_modules.
//
// Nothing here is allowed to stop the server from starting: if the packages aren't
// installed yet, minty keeps working with Ultraviolet and Settings reports that
// Scramjet is unavailable.
import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Find a package's browser-files folder. First ask the package (it exports the path
// for server use), then fall back to the usual node_modules/<pkg>/dist location.
async function findDist(pkg, nodeEntry, mustContain) {
  const candidates = [];
  try {
    const mod = await import(nodeEntry);
    const all = { ...(typeof mod.default === "object" ? mod.default : {}), ...mod };
    for (const [key, value] of Object.entries(all)) {
      if (/path$/i.test(key) && typeof value === "string") candidates.push(value);
    }
  } catch {
    /* not installed, or no node entry point */
  }
  candidates.push(join(root, "node_modules", pkg, "dist"));
  return candidates.find((dir) => existsSync(join(dir, mustContain))) ?? null;
}

export async function mountScramjet(app) {
  const mux = await findDist(
    "@mercuryworkshop/bare-mux",
    "@mercuryworkshop/bare-mux/node",
    "worker.js",
  );
  const transport = await findDist(
    "@mercuryworkshop/bare-as-module3",
    "@mercuryworkshop/bare-as-module3",
    "index.mjs",
  );

  if (mux) app.use("/minty/mux/", express.static(mux));
  if (transport) app.use("/minty/mod/", express.static(transport));

  if (mux && transport) {
    console.log("scramjet v1: ready (bare-mux + bare transport found)");
  } else {
    const missing = [
      !mux && "@mercuryworkshop/bare-mux",
      !transport && "@mercuryworkshop/bare-as-module3",
    ].filter(Boolean);
    console.log(
      `scramjet v1: unavailable, missing ${missing.join(" and ")} - run "npm install" (Ultraviolet and Scramjet v2 are unaffected)`,
    );
  }
}
