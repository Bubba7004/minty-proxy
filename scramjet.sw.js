importScripts('/scramjet/scramjet.bundle.js');

const scramjet = new ScramjetServiceWorker();

self.addEventListener('fetch', (event) => {
    event.respondWith(
        scramjet.fetch(event)
    );
});
