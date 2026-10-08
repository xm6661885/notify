import { useEffect, useRef } from 'preact/hooks'
import { api } from './lib/api'
import { bumpFeed, me, unread } from './lib/store'
import { attachSwipeBack, back, direction, navigate, parentOf, route } from './lib/router'
import { refreshPush } from './lib/push'
import { Login } from './pages/Login'
import { FeedPage } from './pages/Feed'
import { NotePage } from './pages/Note'
import { Settings } from './pages/Settings'
import { Guide } from './pages/Guide'
import { Admin } from './pages/Admin'
import { AdminUser } from './pages/AdminUser'
import { Delivery } from './pages/Delivery'
import { DialogHost, NetActivity, Toasts } from './components/ui'
import { ImageViewerHost } from './components/ImageViewer'
import { BellMark } from './components/BellMark'

export function App() {
  useEffect(() => {
    api.me().then((m) => { me.value = m; unread.value = m.unread }).catch(() => { me.value = false })
  }, [])

  useEffect(() => {
    if (!me.value) return
    refreshPush()
    if (!('serviceWorker' in navigator)) return
    // The service worker tells open windows about new pushes and notification taps.
    const onMsg = (e: MessageEvent) => {
      const d = e.data || {}
      if (d.type === 'push') bumpFeed()
      if (d.type === 'open' && typeof d.url === 'string' && d.url.startsWith('/')) navigate(d.url)
    }
    navigator.serviceWorker.addEventListener('message', onMsg)
    // Refresh when the app returns to the foreground (a push may have arrived meanwhile).
    const wake = () => { if (document.visibilityState === 'visible') { bumpFeed(); refreshPush() } }
    document.addEventListener('visibilitychange', wake)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [!!me.value])

  if (me.value === null) {
    return <div class="boot"><div class="boot-mark"><BellMark /></div></div>
  }
  if (!me.value) return <><Login /><NetActivity /><Toasts /></>

  return (
    <>
      <Routed />
      <DialogHost />
      <ImageViewerHost />
      <NetActivity />
      <Toasts />
    </>
  )
}

function Routed() {
  const r = route.value
  const key = JSON.stringify(r)
  const ref = useRef<HTMLDivElement>(null)
  const isAdmin = me.value && me.value.user.is_admin

  useEffect(() => {
    const el = ref.current
    if (!el || r.name === 'home') return
    return attachSwipeBack(el, () => back(parentOf(r)))
  }, [key])

  let page
  switch (r.name) {
    case 'home': page = <FeedPage view="inbox" />; break
    case 'archived': page = <FeedPage view="archived" />; break
    case 'history': page = <FeedPage view="history" />; break
    case 'note': page = <NotePage id={r.id} />; break
    case 'settings': page = <Settings />; break
    case 'guide': page = <Guide />; break
    case 'admin': page = isAdmin ? <Admin /> : <FeedPage view="inbox" />; break
    case 'admin-user': page = isAdmin ? <AdminUser id={r.id} /> : <FeedPage view="inbox" />; break
    case 'delivery': page = isAdmin ? <Delivery /> : <FeedPage view="inbox" />; break
  }
  return (
    <div key={key} ref={ref} class={`route enter-${direction.value}`}>
      {page}
    </div>
  )
}
