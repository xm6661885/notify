import { render } from 'preact'
import { App } from './App'
import './styles/base.css'
import './styles/components.css'
import './styles/md.css'
import './styles/pages.css'

// Track the visual viewport so fixed layouts sit right above the iOS keyboard.
function syncViewport() {
  const vv = window.visualViewport
  const h = vv ? vv.height : window.innerHeight
  document.documentElement.style.setProperty('--app-h', `${h}px`)
  // Space the keyboard covers at the bottom of the layout viewport (iOS does not shrink it).
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
  document.documentElement.style.setProperty('--kb', `${kb}px`)
  // iOS scrolls the layout viewport when the keyboard opens; pin it back.
  if (vv && vv.offsetTop > 0) window.scrollTo(0, 0)
}
syncViewport()
window.visualViewport?.addEventListener('resize', syncViewport)
window.visualViewport?.addEventListener('scroll', syncViewport)
window.addEventListener('resize', syncViewport)

// Keep a focused field inside a sheet visible once the keyboard has settled.
document.addEventListener('focusin', (e) => {
  const el = e.target as HTMLElement
  if (!el.matches('input, textarea, select') || !el.closest('.sheet-body')) return
  setTimeout(() => el.scrollIntoView({ block: 'nearest' }), 320)
})

// Prevent pinch / double-tap zoom, like a native app.
document.addEventListener('gesturestart', (e) => e.preventDefault())
let lastTouch = 0
document.addEventListener('touchend', (e) => {
  const now = Date.now()
  if (now - lastTouch < 300 && !(e.target as HTMLElement).closest('input, textarea')) e.preventDefault()
  lastTouch = now
}, { passive: false })

render(<App />, document.getElementById('app')!)
// The app's own boot screen takes over from the inline splash.
document.getElementById('splash')?.remove()
