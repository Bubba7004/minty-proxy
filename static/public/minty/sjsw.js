/* global $scramjetLoadWorker */
// minty's Scramjet service worker. Ultraviolet keeps its own worker (sw.js);
// this one only ever handles URLs under the Scramjet prefix (/minty/sj/).
importScripts("/minty/sjlib/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// take over straight away so switching proxies never needs a second page load
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function handle(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  event.respondWith(handle(event));
});
