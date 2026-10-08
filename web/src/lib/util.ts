export function relTime(ts: string | null | undefined): string {
  if (!ts) return ''
  const t = Date.parse(ts)
  if (Number.isNaN(t)) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined })
}

export function fullTime(ts: string): string {
  const t = new Date(ts)
  if (Number.isNaN(t.getTime())) return ts
  return t.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Section label for grouping a feed by day. */
export function dayLabel(ts: string): string {
  const t = new Date(ts)
  const today = new Date()
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((start(today) - start(t)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return t.toLocaleDateString(undefined, { weekday: 'long' })
  return t.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: diff > 300 ? 'numeric' : undefined })
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function haptic() {
  // Vibration API is unavailable on iOS; this is a harmless no-op there.
  try { navigator.vibrate?.(8) } catch { /* ignore */ }
}

export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && isSecureContext) return navigator.clipboard.writeText(text)
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  ta.remove()
  return Promise.resolve()
}

/** Plain one-line preview of possibly-markdown text for cards. */
export function plain(text: string | null, markdown: boolean): string {
  if (!text) return ''
  let s = text
  if (markdown || /[*_`#\[]/.test(s)) {
    s = s.replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/[*_`~]+/g, '')
  }
  return s.trim()
}

/** Split text into title (first line) and body when it has several lines. */
export function titleBody(text: string): { title: string; body: string } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length >= 2 && lines[0].length <= 90) return { title: lines[0], body: lines.slice(1).join('\n') }
  return { title: '', body: lines.join('\n') }
}

export const standalone = () =>
  (navigator as any).standalone === true || matchMedia('(display-mode: standalone)').matches

export function platform(): 'ios' | 'android' | 'mac' | 'desktop' {
  const ua = navigator.userAgent
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Macintosh/.test(ua)) return 'mac'
  return 'desktop'
}
