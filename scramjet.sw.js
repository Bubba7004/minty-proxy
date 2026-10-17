importScripts('/scramjet/scramjet_bundled.js');

const scramjet = new ScramjetServiceWorker();

self.addEventListener('fetch', (event) => {
    event.respondWith(
        (async () => {
            try {
                await scramjet.loadConfig();
                if (scramjet.route(event)) {
                    return await scramjet.fetch(event);
                }
            } catch (err) {
                console.error("Scramjet SW fetch error:", err);
            }
            return fetch(event.request);
        })()
    );
});
