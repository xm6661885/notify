// Tiny history router with direction-aware page transitions and swipe-back support.

import { signal } from '@preact/signals'

export type Route =
  | { name: 'home' }
  | { name: 'archived' }
  | { name: 'history' }
  | { name: 'note'; id: number }
  | { name: 'settings' }
  | { name: 'guide' }
  | { name: 'admin' }
  | { name: 'admin-user'; id: number }
  | { name: 'delivery' }

export function parse(path: string): Route {
  const p = path.replace(/\/+$/, '').split('/').filter(Boolean).map(decodeURIComponent)
  if (p[0] === 'n' && /^\d+$/.test(p[1] || '')) return { name: 'note', id: Number(p[1]) }
  if (p[0] === 'archived') return { name: 'archived' }
  if (p[0] === 'history') return { name: 'history' }
  if (p[0] === 'settings' && p[1] === 'guide') return { name: 'guide' }
  if (p[0] === 'settings') return { name: 'settings' }
  if (p[0] === 'admin' && p[1] === 'delivery') return { name: 'delivery' }
  if (p[0] === 'admin' && p[1] === 'users' && /^\d+$/.test(p[2] || '')) return { name: 'admin-user', id: Number(p[2]) }
  if (p[0] === 'admin') return { name: 'admin' }
  return { name: 'home' }
}

export function href(r: Route): string {
  switch (r.name) {
    case 'home': return '/'
    case 'archived': return '/archived'
    case 'history': return '/history'
    case 'note': return `/n/${r.id}`
    case 'settings': return '/settings'
    case 'guide': return '/settings/guide'
    case 'admin': return '/admin'
    case 'admin-user': return `/admin/users/${r.id}`
    case 'delivery': return '/admin/delivery'
  }
}

export const route = signal<Route>(parse(location.pathname))
export const direction = signal<'forward' | 'back' | 'fade' | 'none'>('fade')

// Only a back we trigger (the top-left button) animates; system gestures and browser back already
// show the previous page, so replaying the enter animation looks like a flash.
let ownBack = false

let depth = (history.state && history.state.depth) || 0
if (!history.state) history.replaceState({ depth }, '')

export function navigate(r: Route | string, opts: { replace?: boolean; animate?: boolean } = {}) {
  const url = typeof r === 'string' ? r : href(r)
  if (url === location.pathname) return
  if (opts.replace) {
    history.replaceState({ depth }, '', url)
    direction.value = 'fade'
  } else {
    depth++
    history.pushState({ depth }, '', url)
    direction.value = opts.animate === false ? 'none' : 'forward'
  }
  route.value = parse(url)
}

/** Where Back leads when there is no history entry to return to. */
export function parentOf(r: Route): Route {
  switch (r.name) {
    case 'guide': case 'admin': return { name: 'settings' }
    case 'admin-user': case 'delivery': return { name: 'admin' }
    default: return { name: 'home' }
  }
}

/** Go back in history if we pushed a page, otherwise to the given fallback. */
export function back(fallback: Route = { name: 'home' }) {
  if (depth > 0) { ownBack = true; history.back() }
  else navigate(fallback, { replace: true })
}

window.addEventListener('popstate', (e) => {
  const d = (e.state && e.state.depth) || 0
  direction.value = d < depth ? (ownBack ? 'back' : 'none') : 'forward'
  ownBack = false
  depth = d
  route.value = parse(location.pathname)
})

/**
 * Edge swipe to go back on touch devices when running standalone (Safari's own gesture
 * covers the browser case). Attach to a page root element.
 */
export function attachSwipeBack(el: HTMLElement, onBack: () => void) {
  const standalone = (navigator as any).standalone || matchMedia('(display-mode: standalone)').matches
  if (!standalone) return () => {}
  let startX = 0, startY = 0, dx = 0, active = false, decided = false, startPath = ''
  const onStart = (e: TouchEvent) => {
    const t = e.touches[0]
    if (t.clientX > 24) return
    startX = t.clientX; startY = t.clientY; dx = 0; active = true; decided = false; startPath = location.pathname
  }
  // Newer iOS versions run their own edge-swipe back in standalone apps too. When the system already
  // navigated, drop our gesture so the two do not go back twice (note -> list -> home).
  const onPop = () => {
    if (!active && !el.style.transform) return
    active = false
    el.style.transition = ''
    el.style.transform = ''
    el.style.boxShadow = ''
  }
  window.addEventListener('popstate', onPop)
  const onMove = (e: TouchEvent) => {
    if (!active) return
    const t = e.touches[0]
    dx = t.clientX - startX
    const dy = t.clientY - startY
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      decided = true
      if (Math.abs(dy) > Math.abs(dx) || dx < 0) { active = false; return }
    }
    el.style.transition = 'none'
    el.style.transform = `translate3d(${Math.max(0, dx)}px,0,0)`
    el.style.boxShadow = '-12px 0 30px rgba(0,0,0,0.12)'
  }
  const onEnd = () => {
    if (!active) return
    active = false
    const w = el.clientWidth
    el.style.transition = 'transform 0.28s cubic-bezier(0.32,0.72,0,1)'
    if (location.pathname !== startPath) return
    if (dx > w * 0.33) {
      el.style.transform = `translate3d(${w}px,0,0)`
      setTimeout(() => { if (location.pathname === startPath) onBack() }, 200)
    } else {
      el.style.transform = ''
      setTimeout(() => { el.style.boxShadow = ''; el.style.transition = '' }, 300)
    }
  }
  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: true })
  el.addEventListener('touchend', onEnd)
  el.addEventListener('touchcancel', onEnd)
  return () => {
    window.removeEventListener('popstate', onPop)
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
  }
}
