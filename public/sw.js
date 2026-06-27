/*
 * CE Desktop service worker — offline app shell for the PWA shell only.
 *
 * Strategy:
 *   - precache the minimal shell (index + manifest + icons) on install,
 *   - navigations: network-first, fall back to the cached index (offline app shell),
 *   - same-origin static assets (hashed /assets/*, icons): stale-while-revalidate,
 *   - the live node API (`/ce/*`) and the in-browser bridge are NEVER cached — node data
 *     must always be live; those requests pass straight through to the network/bridge,
 *   - cross-origin requests pass through untouched.
 *
 * The CE node itself is not cached here: this only makes the UI bundle installable and
 * available offline. Plain JS (not type-checked): it ships verbatim from public/.
 */

const CACHE = "ce-desktop-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {
        /* a missing shell asset must not break install */
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: passthrough
  if (url.pathname === "/ce" || url.pathname.startsWith("/ce/")) return; // live node API
  if (url.pathname === "/sw.js") return; // never cache the worker itself

  // App-shell navigation: prefer fresh, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match("/index.html").then((r) => r || caches.match("/")),
      ),
    );
    return;
  }

  // Static assets: serve cached immediately, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
