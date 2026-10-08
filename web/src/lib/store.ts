// Global app state (signals): session, unread count, toasts, and a change counter that lists watch.

import { signal } from '@preact/signals'
import type { Me } from './types'

/** null while booting, false when signed out. */
export const me = signal<Me | null | false>(null)
export const unread = signal(0)
/** Bumped after any read/archive change so other mounted lists refetch. */
export const feedVersion = signal(0)

export function bumpFeed(newUnread?: number) {
  if (typeof newUnread === 'number') unread.value = newUnread
  feedVersion.value++
}

// ---------- Toasts ----------

export interface Toast { id: number; text: string; kind: 'info' | 'error'; leaving?: boolean }
export const toasts = signal<Toast[]>([])
let toastSeq = 0

export function toast(text: string, kind: 'info' | 'error' = 'info', ms = 2600) {
  const id = ++toastSeq
  toasts.value = [...toasts.value, { id, text, kind }].slice(-3)
  setTimeout(() => {
    toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id) }, 260)
  }, ms)
}

export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), 'error', 4000)
}

// ---------- Network activity ----------

/** In-flight request counts. Writes also block input so slow networks can't trigger repeat taps. */
export const netReads = signal(0)
export const netWrites = signal(0)
