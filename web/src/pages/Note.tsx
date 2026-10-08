// Notification detail: full text (markdown or plain), image preview, file download, copy, read/archive.

import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { bumpFeed, feedVersion, toast, toastError, unread } from '../lib/store'
import { back, navigate } from '../lib/router'
import { getCache, patchCached, pendingTopic } from '../lib/feed'
import { renderText } from '../lib/markdown'
import { copyText, fmtBytes, fullTime } from '../lib/util'
import type { Note } from '../lib/types'
import { BackButton, TopBar, useScrolled } from '../components/ui'
import { openViewer } from '../components/ImageViewer'
import { IconArchive, IconBolt, IconCheck, IconCopy, IconDownload, IconFile, IconMail, IconUnarchive } from '../components/icons'

/** Find the note in a cached list so the page paints instantly while the full text loads. */
function fromCache(id: number): Note | null {
  for (const v of ['inbox', 'archived', 'history'] as const) {
    const n = getCache(v)?.items.find((x) => x.id === id)
    if (n) return n
  }
  return null
}

export function NotePage({ id }: { id: number }) {
  const [note, setNote] = useState<Note | null>(() => fromCache(id))
  const [missing, setMissing] = useState(false)
  const [copied, setCopied] = useState(false)
  const { scrolled, onScroll } = useScrolled()
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    api.note(id).then(async (n) => {
      if (!alive) return
      setNote(n)
      // Opening a notification reads it.
      if (!n.read) {
        try {
          const r = await api.setState([n.id], { read: true })
          if (!alive) return
          setNote({ ...n, read: true })
          unread.value = r.unread
          patchCached([n.id], { read: true })
          bumpFeed()
        } catch { /* stay unread */ }
      }
    }).catch((e) => {
      if (!alive) return
      if (e.status === 404) setMissing(true); else toastError(e)
    })
    return () => { alive = false }
  }, [id])

  // Re-read after a push or resume (state may have changed on another device).
  useEffect(() => {
    if (!note) return
    api.note(id).then(setNote).catch(() => {})
  }, [feedVersion.value])

  const set = async (s: { read?: boolean; archived?: boolean }) => {
    if (!note) return
    const prev = note
    setNote({ ...note, ...s })
    try {
      const r = await api.setState([note.id], s)
      unread.value = r.unread
      patchCached([note.id], s)
      bumpFeed()
      if (s.archived === true) { toast('Archived'); back() }
      else if (s.archived === false) toast('Moved to inbox')
      else if (s.read === false) { toast('Marked as unread'); back() }
    } catch (e) { setNote(prev); toastError(e) }
  }

  const copy = async () => {
    if (!note?.text) return
    try {
      await copyText(note.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch { toast('Copy failed', 'error') }
  }

  // Delegated clicks inside rendered content: code copy buttons, images, topics.
  const onBodyClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement
    const cp = t.closest('[data-copy]') as HTMLElement | null
    if (cp) {
      const code = cp.closest('.codeblock')?.querySelector('code')?.textContent || ''
      copyText(code).then(() => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy' }, 1400) })
      return
    }
    const topic = t.closest('[data-topic]') as HTMLElement | null
    if (topic) {
      e.preventDefault()
      pendingTopic.value = topic.dataset.topic || null
      navigate({ name: 'home' })
      return
    }
    const img = t.closest('img[data-view]') as HTMLImageElement | null
    if (img) {
      e.preventDefault()
      const imgs = Array.from(body.current?.querySelectorAll<HTMLImageElement>('img[data-view]') || [])
      openViewer(imgs.map((i) => ({ src: i.src, name: i.alt || undefined })), imgs.indexOf(img))
    }
  }

  const file = note?.file
  const viewImage = () => file && openViewer([{ src: file.url, name: file.name, download: file.download_url }])

  return (
    <div class="page note-page">
      <TopBar scrolled={scrolled}
        left={<BackButton onClick={() => back()} />}
        right={note && (
          <div class="topbar-actions">
            <button class="icon-btn" aria-label="Mark as unread" onClick={() => set({ read: false })}><IconMail /></button>
            {note.archived
              ? <button class="icon-btn" aria-label="Move to inbox" onClick={() => set({ archived: false })}><IconUnarchive /></button>
              : <button class="icon-btn" aria-label="Archive" onClick={() => set({ archived: true })}><IconArchive /></button>}
          </div>
        )} />
      <div class="page-scroll" onScroll={onScroll}>
        <div class="container note-container">
          {missing && (
            <div class="empty rise">
              <h3 class="serif">Not found</h3>
              <p>This notification does not exist or was not sent to you.</p>
              <button class="btn" onClick={() => navigate({ name: 'home' }, { replace: true })}>Go to notifications</button>
            </div>
          )}
          {!note && !missing && (
            <div class="note-skeleton">
              <div class="skeleton" style={{ height: '18px', width: '40%' }} />
              <div class="skeleton" style={{ height: '120px', marginTop: '18px' }} />
            </div>
          )}
          {note && (
            <article class="note-detail rise">
              <div class="nd-meta">
                <time dateTime={note.created_at}>{fullTime(note.created_at)}</time>
                {note.archived && <span class="nc-tag">Archived</span>}
              </div>
              {note.topics.length > 0 && (
                <div class="nd-topics">
                  {note.topics.map((t) => (
                    <button key={t} class="topic-chip" onClick={() => { pendingTopic.value = t; navigate({ name: 'home' }) }}>#{t}</button>
                  ))}
                </div>
              )}

              {file?.is_image && (
                <button class="nd-image" onClick={viewImage} aria-label={`View ${file.name}`}>
                  <img src={file.url} alt={file.name} decoding="async" draggable={false} />
                </button>
              )}

              {note.text ? (
                <div ref={body} class="nd-text md selectable" onClick={onBodyClick}
                  dangerouslySetInnerHTML={{ __html: renderText(note.text, note.markdown) }} />
              ) : !file ? (
                <p class="nd-empty">This notification has no text.</p>
              ) : null}

              {file && !file.is_image && (
                <a class="file-card" href={file.download_url} download={file.name}>
                  <span class="fc-icon"><IconFile /><b>{ext(file.name)}</b></span>
                  <span class="fc-meta">
                    <span class="fc-name">{file.name}</span>
                    <span class="fc-path">{fmtBytes(file.size)} · {file.mime}</span>
                  </span>
                  <span class="fc-dl"><IconDownload /></span>
                </a>
              )}

              <div class="nd-actions">
                {note.text && (
                  <button class={`btn ${copied ? 'done' : ''}`} onClick={copy}>
                    {copied ? <IconCheck width={18} height={18} /> : <IconCopy width={18} height={18} />}
                    {copied ? 'Copied' : 'Copy text'}
                  </button>
                )}
                {note.actions?.map((a, i) => (
                  <a key={i} class="btn" href={a.url} target={/^https?:/i.test(a.url) ? '_blank' : undefined} rel="noopener noreferrer">
                    <IconBolt width={18} height={18} /> {a.name}
                  </a>
                ))}
                {file && (
                  <a class="btn" href={file.download_url} download={file.name}>
                    <IconDownload width={18} height={18} /> Download {file.is_image ? 'image' : 'file'}
                  </a>
                )}
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}

function ext(name: string) {
  return (name.includes('.') ? name.split('.').pop()! : 'file').slice(0, 5).toUpperCase()
}
