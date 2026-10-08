// Per-view list cache so going back to a list (button or iOS swipe) restores it instantly at the
// same scroll position instead of refetching and replaying the entry animation.

import { signal } from '@preact/signals'
import type { Note, TopicCount, View } from './types'

export interface FeedCache {
  items: Note[]
  page: number
  total: number
  q: string
  topic: string
  unreadOnly: boolean
  topics: TopicCount[]
  scroll: number
  version: number
}

const caches = new Map<View, FeedCache>()

export const getCache = (v: View) => caches.get(v)
export const setCache = (v: View, c: FeedCache) => { caches.set(v, c) }
export const clearCaches = () => caches.clear()

/** Topic the home feed should switch to (set by tapping a #topic inside a notification). */
export const pendingTopic = signal<string | null>(null)

/** Apply a local read/archive change to every cached list so nothing looks stale on return. */
export function patchCached(ids: number[], s: { read?: boolean; archived?: boolean }) {
  const set = new Set(ids)
  const now = new Date().toISOString()
  for (const [view, c] of caches) {
    let items = c.items.map((n) => set.has(n.id) ? {
      ...n,
      ...(s.read !== undefined ? { read: s.read, read_at: s.read ? n.read_at || now : null } : {}),
      ...(s.archived !== undefined ? { archived: s.archived, archived_at: s.archived ? n.archived_at || now : null } : {}),
    } : n)
    if (s.archived !== undefined) {
      if (view === 'inbox') items = items.filter((n) => !n.archived)
      if (view === 'archived') items = items.filter((n) => n.archived)
    }
    // An unread-only list drops what was just read (the quiet refetch on return fixes the total).
    if (s.read === true && c.unreadOnly) items = items.filter((n) => !set.has(n.id))
    caches.set(view, { ...c, items })
  }
}
