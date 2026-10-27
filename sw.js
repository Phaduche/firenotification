// 앱 껍데기를 캐시해 두면 홈 화면 앱이 빠르게 열리고, 화재 알림을 잠금 화면에 띄울 수 있다.
const CACHE = "qubit-guardian-v7";
const SHELL = ["./", "index.html", "app.css", "app.js", "firebase-config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 같은 출처의 파일만: 네트워크를 먼저 쓰고, 끊겼을 때만 캐시로 연다. 고친 화면이 바로 반영되게 하려는 것.
// Firebase 통신은 건드리지 않는다.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.navigate?.("./#home");
          return client.focus();
        }
      }
      return self.clients.openWindow("./#home");
    }),
  );
});
