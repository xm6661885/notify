// Service worker: shows web pushes, routes notification taps, caches the app shell.
// Bump CACHE when the shell changes.
const CACHE = 'notify-v11'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)) }
        return res
      })),
    )
    return
  }

  // Navigations: network first so deploys show up, cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)) }
        return res
      }).catch(() => caches.match('/')),
    )
  }
})

const safePath = (p) => (typeof p === 'string' && /^\/(?!\/)/.test(p) ? p : '/')

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let d = {}
    try { d = e.data ? e.data.json() : {} } catch { d = { body: e.data ? e.data.text() : '' } }
    const url = safePath(d.url)
    // Every notification gets its own tag so new ones never replace older ones.
    await self.registration.showNotification(d.title || 'Notify', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: d.tag || `n-${d.id || Date.now()}`,
      data: { id: d.id, url },
      timestamp: Date.now(),
    })
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) w.postMessage({ type: 'push', id: d.id })
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil((async () => {
    const path = safePath(e.notification.data && e.notification.data.url)
    const target = new URL(path, self.location.origin).href
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue
      // Let the open app route in-place (keeps its history for Back), then bring it forward.
      w.postMessage({ type: 'open', url: path })
      try { return await w.focus() } catch { /* fall through */ }
    }
    return self.clients.openWindow(target)
  })())
})
