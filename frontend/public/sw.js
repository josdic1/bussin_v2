// Bussin app shell cache. Keeps the app opening (never a white screen) when the
// server is briefly unreachable: a redeploy, a dead zone, airplane mode.
// API calls are never cached; the phone always talks to the live server for data.
const CACHE = "bussin-shell-v1";
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(new Request(SHELL, { cache: "reload" }))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/sw.js") return;

  // Pages: always try the live server first so new deploys show up; fall back to the cached shell.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await withTimeout(fetch(request), 5000);
        if (fresh.ok) await cache.put(SHELL, fresh.clone());
        return fresh;
      } catch {
        return (await cache.match(SHELL)) || Response.error();
      }
    })());
    return;
  }

  // Built assets have content hashes in their names: cache forever once fetched.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(request, fresh.clone());
      return fresh;
    })());
    return;
  }

  // Icons and manifest: serve cached, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    const network = fetch(request).then((fresh) => { if (fresh.ok) void cache.put(request, fresh.clone()); return fresh; }).catch(() => hit);
    return hit || network;
  })());
});
