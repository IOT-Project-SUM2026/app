const CACHE = "smart-display-shell-v4";
const SHELL = ["/", "/style.css", "/app.js", "/pwa.js", "/manifest.webmanifest",
  "/icons/icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("smart-display-shell-") && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Cache only the interface. Never cache or replay audio, commands or confirmations.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin ||
      !SHELL.includes(url.pathname)) return;
  // Cache first for instant loads; refresh the cache in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.pathname);
    const refresh = fetch(event.request).then(async (response) => {
      if (response.ok) await cache.put(url.pathname, response.clone());
      return response;
    });
    if (cached) {
      event.waitUntil(refresh.catch(() => {}));
      return cached;
    }
    return refresh.catch(() => Response.error());
  })());
});
