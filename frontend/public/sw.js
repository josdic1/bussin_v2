// Bussin app shell cache. Keeps the app opening (never a white screen) when the
// server is unreachable or returns an error page: a redeploy, a dead zone,
// airplane mode, a Railway outage. API calls are never cached; data always
// comes from the live server.
const CACHE = "bussin-shell-v2";
const SHELL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.add(new Request(SHELL, { cache: "reload" }));
    // Save every built code file now, not only the ones this visit happened to load.
    try {
      const list = await (await fetch("/asset-list.json", { cache: "no-store" })).json();
      if (Array.isArray(list)) await cache.addAll(list.filter((path) => typeof path === "string" && path.startsWith("/assets/")));
    } catch {
      // Older build without a list: assets still get saved as they load.
    }
    await self.skipWaiting();
  })());
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
  if (url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/sw.js" || url.pathname === "/asset-list.json") return;

  // Pages: live server first so new deploys show up. If the server is down or
  // answers with an error page (502/503 during an outage), use the saved shell.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await withTimeout(fetch(request), 5000);
        if (fresh.ok) {
          await cache.put(SHELL, fresh.clone());
          return fresh;
        }
        return (await cache.match(SHELL)) || fresh;
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

  // Icons and manifest: serve saved, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    const network = fetch(request).then((fresh) => { if (fresh.ok) void cache.put(request, fresh.clone()); return fresh; }).catch(() => hit);
    return hit || network;
  })());
});
