try {
    importScripts('/scramjet/scramjet_bundled.js');

    const { ScramjetServiceWorker } = $scramjetLoadWorker();
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
                    console.error("Scramjet routing exception:", err);
                }
                return fetch(event.request);
            })()
        );
    });

    console.log("Scramjet Service Worker initialized successfully.");
} catch (err) {
    console.error("CRITICAL: Scramjet SW failed to evaluate:", err);
    throw err;
}
