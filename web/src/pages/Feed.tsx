// Inbox (home), Archived and History lists. Long-press (or the select button) starts multi-select.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { bumpFeed, feedVersion, me, toast, toastError, unread } from '../lib/store'
import { back, direction, navigate } from '../lib/router'
import { getCache, patchCached, pendingTopic, setCache } from '../lib/feed'
import { pushState, PUSH_LABEL } from '../lib/push'
import { dayLabel, fmtBytes, haptic, plain, relTime, titleBody } from '../lib/util'
import type { Note, TopicCount, View } from '../lib/types'
import { BackButton, TopBar, useScrolled } from '../components/ui'
import { BellMark } from '../components/BellMark'
import {
  IconArchive, IconCheckAll, IconChevron, IconClose, IconFile, IconHistory, IconMail, IconMailOpen, IconRefresh, IconSearch,
  IconSelect, IconSettings, IconUnarchive,
} from '../components/icons'

const TITLES: Record<View, string> = { inbox: 'Notifications', archived: 'Archived', history: 'History' }
const PAGE = 20

export function FeedPage({ view }: { view: View }) {
  const cached = getCache(view)
  // Restore without animation when coming back to a list we already showed.
  const restored = useRef(!!cached && direction.value !== 'forward')
  const init = restored.current ? cached : undefined

  const [items, setItems] = useState<Note[]>(init?.items || [])
  const [page, setPage] = useState(init?.page || 1)
  const [total, setTotal] = useState(init?.total || 0)
  const [loading, setLoading] = useState(!init)
  const [q, setQ] = useState(init?.q || '')
  const [query, setQuery] = useState(init?.q || '')
  const [topic, setTopic] = useState(() => (view === 'inbox' && pendingTopic.value) || init?.topic || '')
  const [unreadOnly, setUnreadOnly] = useState(init ? !!init.unreadOnly : localStorage.getItem('nt_default_tab') === 'unread')
  const [topics, setTopics] = useState<TopicCount[]>(init?.topics || [])
  const [selected, setSelected] = useState<Set<number> | null>(null)
  const [leaving, setLeaving] = useState<Set<number>>(new Set())
  const scroller = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const loadedVersion = useRef(init?.version ?? -1)
  const { scrolled, onScroll } = useScrolled()

  // A #topic tapped inside a notification switches the home feed to it.
  useEffect(() => {
    if (view === 'inbox' && pendingTopic.value) { setTopic(pendingTopic.value); pendingTopic.value = null }
  }, [pendingTopic.value])

  // Debounce typing into the search box.
  useEffect(() => {
    if (q === query) return
    const t = setTimeout(() => setQuery(q), 280)
    return () => clearTimeout(t)
  }, [q])

  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try { await load(true) } finally { setRefreshing(false) }
  }

  // Filter switches keep the old cards (dimmed) until the new page arrives, then the new cards rise in.
  const [switching, setSwitching] = useState(false)
  const [gen, setGen] = useState(0)

  const load = async (quiet: boolean, swap = false, p = page) => {
    const my = ++seq.current
    if (swap) setSwitching(true)
    else if (!quiet) setLoading(true)
    try {
      const [res, tp] = await Promise.all([
        api.list({ view, q: query.trim() || undefined, topic: topic || undefined, unread: unreadOnly || undefined, limit: PAGE, page: p }),
        api.topics(view).catch(() => null),
      ])
      if (my !== seq.current) return
      const pages = Math.max(1, Math.ceil((res.total || 0) / PAGE))
      // The page may have emptied (archived everything on the last page): step back.
      if (p > pages) { load(quiet, swap, pages); return }
      setItems(res.items)
      setPage(p)
      setTotal(res.total || 0)
      if (swap) { setGen((g) => g + 1); scroller.current?.scrollTo({ top: 0 }) }
      unread.value = res.unread
      if (tp) setTopics(tp.topics)
      loadedVersion.current = feedVersion.value
    } catch (e) {
      if (my === seq.current) toastError(e)
    } finally {
      if (my === seq.current) { setLoading(false); setSwitching(false) }
    }
  }

  // First load, and reload when the filters change. A restored list only refreshes quietly.
  const first = useRef(true)
  useEffect(() => {
    if (first.current && init) {
      first.current = false
      requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = init.scroll })
      if (init.q === query && init.topic === topic && !!init.unreadOnly === unreadOnly) {
        if (loadedVersion.current !== feedVersion.value) load(true)
        return
      }
    }
    const wasFirst = first.current
    first.current = false
    load(false, !wasFirst && items.length > 0, 1)
  }, [query, topic, unreadOnly])

  // Something changed elsewhere (push arrived, app resumed, detail page toggled state).
  useEffect(() => {
    if (loadedVersion.current !== -1 && loadedVersion.current !== feedVersion.value) load(true)
  }, [feedVersion.value])

  const goPage = (p: number) => { if (p !== page && !switching) load(false, true, p) }

  // Keep the cache current so Back restores this exact state.
  useEffect(() => () => {
    setCache(view, {
      items: itemsRef.current, page: pageRef.current, total: totalRef.current, q: qRef.current, topic: topicRef.current, unreadOnly: unreadRef.current,
      topics: topicsRef.current, scroll: scroller.current?.scrollTop || 0, version: loadedVersion.current,
    })
  }, [])
  const itemsRef = useRef(items); itemsRef.current = items
  const pageRef = useRef(page); pageRef.current = page
  const totalRef = useRef(total); totalRef.current = total
  const qRef = useRef(query); qRef.current = query
  const topicRef = useRef(topic); topicRef.current = topic
  const unreadRef = useRef(unreadOnly); unreadRef.current = unreadOnly
  const topicsRef = useRef(topics); topicsRef.current = topics

  // ---------- state changes ----------

  const apply = async (ids: number[], s: { read?: boolean; archived?: boolean }, undo = true) => {
    if (!ids.length) return
    const prev = items
    const removes = s.archived !== undefined && ((view === 'inbox' && s.archived) || (view === 'archived' && !s.archived))
    const patchOne = (n: Note): Note => ({
      ...n,
      ...(s.read !== undefined ? { read: s.read } : {}),
      ...(s.archived !== undefined ? { archived: s.archived } : {}),
    })
    const idSet = new Set(ids)
    if (removes) {
      setLeaving(new Set(ids))
      setTimeout(() => {
        setItems((cur) => cur.filter((n) => !idSet.has(n.id)))
        setLeaving(new Set())
      }, 300)
    } else {
      setItems((cur) => cur.map((n) => (idSet.has(n.id) ? patchOne(n) : n)))
    }
    setSelected(null)
    try {
      const r = await api.setState(ids, s)
      patchCached(ids, s)
      unread.value = r.unread
      loadedVersion.current = feedVersion.value + 1
      bumpFeed()
      if (unreadOnly && s.read !== undefined) load(true)
      else api.topics(view).then((t) => setTopics(t.topics)).catch(() => {})
      if (undo && s.archived !== undefined) {
        const n = ids.length
        toast(`${n} notification${n > 1 ? 's' : ''} ${s.archived ? 'archived' : 'moved to inbox'}`)
      }
    } catch (e) {
      setItems(prev)
      setLeaving(new Set())
      toastError(e)
    }
  }

  const readAll = async () => {
    try {
      const r = await api.readAll(view, topic || undefined)
      setItems((cur) => cur.map((n) => ({ ...n, read: true })))
      unread.value = r.unread
      patchCached(items.map((n) => n.id), { read: true })
      loadedVersion.current = feedVersion.value + 1
      bumpFeed()
      if (unreadOnly) load(true)
      else api.topics(view).then((t) => setTopics(t.topics)).catch(() => {})
      toast(r.updated ? `Marked ${r.updated} as read` : 'Everything is already read')
    } catch (e) { toastError(e) }
  }

  // ---------- selection ----------

  const startSelect = (id?: number) => { haptic(); setSelected(new Set(id !== undefined ? [id] : [])) }
  const toggle = (id: number) => {
    setSelected((cur) => {
      const s = new Set(cur || [])
      if (s.has(id)) s.delete(id); else s.add(id)
      return s
    })
  }
  const sel = selected ? items.filter((n) => selected.has(n.id)) : []
  const selIds = sel.map((n) => n.id)
  const allSelected = !!selected && items.length > 0 && sel.length === items.length

  // ---------- render ----------

  const groups = useMemo(() => {
    const out: { label: string; items: Note[] }[] = []
    for (const n of items) {
      const label = dayLabel(n.created_at)
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] })
      out[out.length - 1].items.push(n)
    }
    return out
  }, [items])

  const isHome = view === 'inbox'
  const user = me.value ? me.value.user : null
  const ps = pushState.value
  const anim = !restored.current
  const unreadHere = items.some((n) => !n.read)
  // The global count covers the inbox only; with a topic picked, use that topic's count.
  const unreadChip = topic ? (topics.find((t) => t.key === topic.toLowerCase())?.unread || 0) : view === 'inbox' ? unread.value : 0
  let idx = 0
  // Home shows only the user's chosen filter topics, in their order, when any are set.
  const pinned = isHome && me.value ? me.value.settings.feed_topics : []
  const shownTopics: TopicCount[] = pinned.length
    ? pinned.map((p) => topics.find((t) => t.key === p.toLowerCase()) || { topic: p, key: p.toLowerCase(), count: 0, unread: 0 })
    : topics

  const topBar = selected ? (
    <TopBar scrolled
      left={<button class="btn ghost small" onClick={() => setSelected(null)}>Cancel</button>}
      right={<button class="btn ghost small" onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((n) => n.id)))}>
        {allSelected ? 'Select none' : 'Select all'}
      </button>}>
      <span class="sel-count">{sel.length ? `${sel.length} selected` : 'Select notifications'}</span>
    </TopBar>
  ) : (
    <TopBar scrolled={scrolled}
      left={isHome ? undefined : <BackButton onClick={() => back()} />}
      right={
        <div class="topbar-actions">
          {items.length > 0 && <button class="icon-btn" aria-label="Select" onClick={() => startSelect()}><IconSelect /></button>}
          {isHome && <button class={`icon-btn ${refreshing ? 'spinning' : ''}`} aria-label="Refresh" disabled={refreshing} onClick={refresh}><IconRefresh /></button>}
          {isHome && <button class="icon-btn" aria-label="Archived" onClick={() => navigate({ name: 'archived' })}><IconArchive /></button>}
          {isHome && <button class="icon-btn" aria-label="History" onClick={() => navigate({ name: 'history' })}><IconHistory /></button>}
          {isHome && <button class="icon-btn" aria-label="Settings" onClick={() => navigate({ name: 'settings' })}><IconSettings /></button>}
        </div>
      }>
      {isHome && ps && ps !== 'on' ? (
        <button class={`push-pill ${ps}`} onClick={() => navigate({ name: 'settings' })} aria-label={`Push: ${PUSH_LABEL[ps]}`}>
          <span class="dot" />Push {PUSH_LABEL[ps].toLowerCase()}
        </button>
      ) : isHome && ps === 'on' ? (
        <span class="push-pill on" title="Push notifications are on for this device"><span class="dot live" />Push on</span>
      ) : null}
      {scrolled && !isHome && <span class="fade-in">{TITLES[view]}</span>}
    </TopBar>
  )

  return (
    <div class={`page feed ${selected ? 'selecting' : ''}`}>
      {topBar}
      <div class="page-scroll" ref={scroller} onScroll={onScroll}>
        <div class="container">
          <div class={anim ? 'rise' : ''}>
            <h1 class="large-title">{TITLES[view]}</h1>
            <p class="subtitle">
              {view === 'inbox' ? (unread.value ? `${unread.value} unread` : `All caught up${user ? `, ${user.username}` : ''}.`)
                : view === 'archived' ? 'Archived notifications stay here and in History.'
                : 'Everything you have received, archived or not.'}
            </p>
          </div>

          <div class={`search-box ${anim ? 'rise' : ''}`} style={{ '--i': 1 }}>
            <IconSearch />
            <input type="search" enterKeyHint="search" placeholder={`Search ${view === 'inbox' ? 'notifications' : view}`}
              value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search" />
            {q && <button class="search-clear" aria-label="Clear search" onClick={() => { setQ(''); setQuery('') }}><IconClose /></button>}
          </div>

          <div class={`feed-tabs ${anim ? 'rise' : ''}`} style={{ '--i': 2 }} role="tablist" aria-label="Show">
            <button role="tab" aria-selected={!unreadOnly} class={!unreadOnly ? 'on' : ''} onClick={() => setUnreadOnly(false)}>All</button>
            <button role="tab" aria-selected={unreadOnly} class={unreadOnly ? 'on' : ''} onClick={() => setUnreadOnly(true)}>
              Unread{unreadChip > 0 && <span class="tc-n">{unreadChip}</span>}
            </button>
          </div>

          {(shownTopics.length > 0 || topic) && (
            <div class={`topic-row ${anim ? 'rise' : ''}`} style={{ '--i': 3 }} role="tablist" aria-label="Filter by topic">
              {topic && !shownTopics.some((t) => t.key === topic.toLowerCase()) && (
                <button class="topic-chip on" role="tab" aria-selected onClick={() => setTopic('')}>#{topic}</button>
              )}
              {shownTopics.map((t) => {
                const on = topic.toLowerCase() === t.key
                return (
                  <button key={t.key} class={`topic-chip ${on ? 'on' : ''}`} role="tab" aria-selected={on}
                    onClick={() => setTopic(on ? '' : t.topic)}>
                    #{t.topic}{t.unread > 0 && <span class="tc-n">{t.unread}</span>}
                  </button>
                )
              })}
            </div>
          )}

          {!selected && unreadHere && view !== 'archived' && (
            <div class="list-tools fade-in">
              <button class="link-btn" onClick={readAll}><IconCheckAll /> Mark all{topic ? ` #${topic}` : ''} read</button>
            </div>
          )}

          {loading && (
            <div class="note-list">
              {[0, 1, 2, 3].map((i) => <div key={i} class="skeleton note-skel" style={{ animationDelay: `${i * 90}ms` }} />)}
            </div>
          )}

          {!loading && items.length === 0 && (
            <div class={`empty ${anim ? 'rise' : 'fade-in'}`}>
              <div class="empty-mark"><BellMark /></div>
              <h3 class="serif">{query || topic || unreadOnly ? 'Nothing matches' : view === 'archived' ? 'Nothing archived' : 'No notifications yet'}</h3>
              <p>{query || topic || unreadOnly ? 'Try another word or clear the filter.'
                : view === 'archived' ? 'Long-press a notification on the home page to archive it.'
                : 'New notifications show up here as soon as they are sent.'}</p>
            </div>
          )}

          {!loading && groups.map((g) => (
            <section key={`${gen}-${g.label}`} class={`note-group ${switching ? 'switching' : ''}`}>
              <div class="day-label">{g.label}</div>
              <div class="note-list">
                {g.items.map((n) => {
                  const i = idx++
                  return (
                    <NoteCard key={n.id} note={n} index={gen > 0 ? i * 0.6 : i + 3} animate={(anim || gen > 0) && i < 12} view={view}
                      leaving={leaving.has(n.id)}
                      selecting={!!selected} selected={!!selected?.has(n.id)}
                      onOpen={() => navigate({ name: 'note', id: n.id })}
                      onToggle={() => toggle(n.id)}
                      onLongPress={() => (selected ? toggle(n.id) : startSelect(n.id))} />
                  )
                })}
              </div>
            </section>
          ))}

          {!loading && total > PAGE && <Pager page={page} pages={Math.ceil(total / PAGE)} busy={switching} onGo={goPage} />}
        </div>
      </div>

      {selected && (
        <div class="action-bar" role="toolbar" aria-label="Actions for selected notifications">
          <ActionBtn label="Read" icon={<IconMailOpen />} disabled={!sel.length || sel.every((n) => n.read)}
            onClick={() => apply(selIds, { read: true })} />
          <ActionBtn label="Unread" icon={<IconMail />} disabled={!sel.length || sel.every((n) => !n.read)}
            onClick={() => apply(selIds, { read: false })} />
          {view !== 'archived' && (
            <ActionBtn label="Archive" icon={<IconArchive />} disabled={!sel.length || sel.every((n) => n.archived)}
              onClick={() => apply(selIds, { archived: true })} />
          )}
          {view !== 'inbox' && (
            <ActionBtn label="Unarchive" icon={<IconUnarchive />} disabled={!sel.length || sel.every((n) => !n.archived)}
              onClick={() => apply(selIds, { archived: false })} />
          )}
        </div>
      )}
    </div>
  )
}

/** Google-style numbered pager: Prev 1 … 4 5 [6] 7 8 … 20 Next */
function Pager({ page, pages, busy, onGo }: { page: number; pages: number; busy: boolean; onGo: (p: number) => void }) {
  const nums: (number | null)[] = []
  const lo = Math.max(2, page - 2), hi = Math.min(pages - 1, page + 2)
  nums.push(1)
  if (lo > 2) nums.push(null)
  for (let i = lo; i <= hi; i++) nums.push(i)
  if (hi < pages - 1) nums.push(null)
  if (pages > 1) nums.push(pages)
  return (
    <nav class={`pager ${busy ? 'busy' : ''}`} aria-label="Pages">
      <button class="pg-btn pg-step" disabled={page <= 1 || busy} onClick={() => onGo(page - 1)} aria-label="Previous page">
        <IconChevron style={{ transform: 'scaleX(-1)' }} />
      </button>
      {nums.map((n, i) => n === null
        ? <span key={`g${i}`} class="pg-gap" aria-hidden="true">…</span>
        : <button key={n} class={`pg-btn ${n === page ? 'on' : ''}`} disabled={busy} aria-current={n === page ? 'page' : undefined}
            aria-label={`Page ${n}`} onClick={() => onGo(n)}>{n}</button>)}
      <button class="pg-btn pg-step" disabled={page >= pages || busy} onClick={() => onGo(page + 1)} aria-label="Next page">
        <IconChevron />
      </button>
    </nav>
  )
}

function ActionBtn({ label, icon, disabled, onClick }: { label: string; icon: preact.ComponentChildren; disabled?: boolean; onClick: () => void }) {
  return (
    <button class="action-btn" disabled={disabled} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  )
}

const LONG_MS = 450

function NoteCard({ note, index, animate, view, leaving, selecting, selected, onOpen, onToggle, onLongPress }: {
  note: Note
  index: number
  animate: boolean
  view: View
  leaving: boolean
  selecting: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
  onLongPress: () => void
}) {
  const press = useRef<{ x: number; y: number; timer: number; fired: boolean } | null>(null)
  const [pressing, setPressing] = useState(false)

  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
    setPressing(false)
  }
  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const timer = window.setTimeout(() => {
      if (!press.current) return
      press.current.fired = true
      setPressing(false)
      onLongPress()
    }, LONG_MS)
    press.current = { x: e.clientX, y: e.clientY, timer, fired: false }
    setPressing(true)
  }
  const onMove = (e: PointerEvent) => {
    const p = press.current
    if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel()
  }
  const onClick = (e: Event) => {
    const fired = press.current?.fired
    cancel()
    if (fired) { e.preventDefault(); return }
    if (selecting) onToggle(); else onOpen()
  }

  const text = plain(note.text, note.markdown)
  const { title, body } = titleBody(text)
  const file = note.file
  const showArchivedTag = view === 'history' && note.archived

  return (
    <div class={`note-wrap ${leaving ? 'leaving' : ''}`}>
      <button
        class={`note-card ${note.read ? 'read' : 'unread'} ${animate ? 'rise' : ''} ${pressing ? 'pressing' : ''} ${selected ? 'selected' : ''}`}
        style={animate ? { '--i': index } : undefined}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { if (press.current && !press.current.fired) clearTimeout(press.current.timer) }}
        onPointerCancel={cancel} onPointerLeave={() => { if (press.current && !press.current.fired) cancel() }}
        onContextMenu={(e) => { e.preventDefault(); if (!press.current?.fired) { cancel(); onLongPress() } }}
        onClick={onClick}
        aria-pressed={selecting ? selected : undefined}
        aria-label={selecting ? `${selected ? 'Deselect' : 'Select'} notification` : undefined}>
        {selecting && <span class={`check ${selected ? 'on' : ''}`} aria-hidden="true" />}
        <div class="nc-main">
          <div class="nc-head">
            {!note.read && <span class="nc-unread" aria-label="Unread" />}
            {note.topics.slice(0, 3).map((t) => <span key={t} class="nc-topic">#{t}</span>)}
            {showArchivedTag && <span class="nc-tag">Archived</span>}
            <span class="nc-time">{relTime(note.created_at)}</span>
          </div>
          {title && <div class="nc-title">{title}</div>}
          {body && <div class="nc-body">{body}</div>}
          {!text && !file && <div class="nc-body empty-text">Empty notification</div>}
          {file && file.is_image && (
            <div class="nc-thumb"><img src={file.url} alt={file.name} loading="lazy" decoding="async" draggable={false} /></div>
          )}
          {file && !file.is_image && (
            <div class="nc-file">
              <span class="nc-file-ic"><IconFile /></span>
              <span class="nc-file-name">{file.name}</span>
              <span class="nc-file-size">{fmtBytes(file.size)}</span>
            </div>
          )}
        </div>
      </button>
    </div>
  )
}
