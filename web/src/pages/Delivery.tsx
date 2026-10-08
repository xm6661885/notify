// Admin delivery status: push and webhook jobs, failed first, with retry and clear.

import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { toast, toastError } from '../lib/store'
import { back, navigate } from '../lib/router'
import { relTime } from '../lib/util'
import type { DeliveryItem, DeliveryPage, JobKind, JobStatus } from '../lib/types'
import { BackButton, confirmDialog, Segmented, TopBar, useScrolled } from '../components/ui'
import { IconBell, IconRefresh, IconTrash, IconWebhook } from '../components/icons'

type St = JobStatus | 'all'
type Kd = JobKind | 'all'

export function Delivery() {
  const { scrolled, onScroll } = useScrolled()
  const [status, setStatus] = useState<St>('failed')
  const [kind, setKind] = useState<Kd>('all')
  const [page, setPage] = useState<DeliveryPage | null>(null)
  const [items, setItems] = useState<DeliveryItem[]>([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async (before?: string | null) => {
    setBusy(true)
    try {
      const r = await api.delivery({ status, kind, before, limit: 50 })
      setPage(r)
      setItems((l) => (before ? [...l, ...r.items] : r.items))
      setMore(!!r.next_before)
    } catch (e) { toastError(e) } finally { setBusy(false) }
  }
  useEffect(() => { setItems([]); setPage(null); load() }, [status, kind])

  const retry = async (it: DeliveryItem) => {
    try {
      await api.retryJob(it.kind, it.id)
      toast('Queued again')
      load()
    } catch (e) { toastError(e) }
  }
  const retryAll = async () => {
    try {
      const r = await api.retryAll(kind)
      toast(r.retried ? `Retrying ${r.retried} job${r.retried === 1 ? '' : 's'}` : 'Nothing to retry')
      load()
    } catch (e) { toastError(e) }
  }
  const clear = async () => {
    if (!(await confirmDialog({ title: 'Clear failed jobs?', body: 'They are removed from this list. Notifications themselves stay.', confirm: 'Clear', danger: true }))) return
    try {
      const r = await api.clearFailed(kind)
      toast(`Cleared ${r.deleted}`)
      load()
    } catch (e) { toastError(e) }
  }

  const c = page?.counts
  const failedTotal = c ? c.push.failed_24h + c.webhook.failed_24h : 0

  return (
    <div class="page">
      <TopBar scrolled={scrolled} left={<BackButton onClick={() => back({ name: 'admin' })} label="Admin" />}
        right={busy ? <span class="spinner" style={{ marginRight: '12px' }} /> : undefined}>
        {scrolled && <span class="fade-in">Delivery</span>}
      </TopBar>
      <div class="page-scroll" onScroll={onScroll}>
        <div class="container settings">
          <h1 class="large-title rise">Delivery</h1>
          <p class="subtitle rise" style={{ '--i': 1 }}>
            The CLI only hands notifications to the server. Pushes and webhooks go out here, one at a time.
          </p>

          {c && (
            <div class="dl-stats rise" style={{ '--i': 2 }}>
              <Stat icon={<IconBell />} label="Push" n={c.push} />
              <Stat icon={<IconWebhook />} label="Webhooks" n={c.webhook} />
            </div>
          )}

          <div class="dl-filters">
            <Segmented value={status} onChange={setStatus}
              options={[{ value: 'failed', label: 'Failed' }, { value: 'pending', label: 'Waiting' }, { value: 'sent', label: 'Sent' }, { value: 'all', label: 'All' }]} />
            <Segmented value={kind} onChange={setKind}
              options={[{ value: 'all', label: 'All' }, { value: 'push', label: 'Push' }, { value: 'webhook', label: 'Webhooks' }]} />
          </div>

          {status === 'failed' && items.length > 0 && (
            <div class="dl-bulk fade-in">
              <button class="btn ghost small" onClick={retryAll} disabled={!failedTotal}><IconRefresh /> Retry last 24 h</button>
              <button class="btn ghost small" onClick={clear}><IconTrash /> Clear</button>
            </div>
          )}

          {page && items.length === 0 && (
            <div class="empty rise">
              <h3 class="serif">{status === 'failed' ? 'Nothing failed' : 'Nothing here'}</h3>
              <p>{status === 'failed' ? 'Every push and webhook went through.' : 'No jobs match this filter.'}</p>
            </div>
          )}

          {items.length > 0 && (
            <div class="group">
              {items.map((it, i) => (
                <div class="row dl-row" key={`${it.kind}-${it.id}`} style={{ '--i': Math.min(i, 12) }}>
                  <span class={`dl-ic ${it.status}`}>{it.kind === 'push' ? <IconBell /> : <IconWebhook />}</span>
                  <span class="label">
                    <span class="dl-head">
                      <span class="dl-target">{it.target || (it.kind === 'push' ? 'Push' : 'Webhook')}</span>
                      {it.user && <span class="mini-tag muted">{it.user.username}</span>}
                      <span class={`dl-status ${it.status}`}>{statusLabel(it)}</span>
                    </span>
                    {it.notification
                      ? <button class="dl-note" onClick={() => navigate({ name: 'note', id: it.notification!.id })}>{it.notification.preview || `#${it.notification.id}`}</button>
                      : <span class="hint">Test push</span>}
                    {it.error && <span class="dl-err selectable">{it.error}</span>}
                    <span class="hint">{relTime(it.sent_at || it.created_at)}{it.attempts > 1 ? ` · ${it.attempts} attempts` : ''}</span>
                  </span>
                  {it.status === 'failed' && (
                    <button class="icon-btn" aria-label="Retry" onClick={() => retry(it)}><IconRefresh /></button>
                  )}
                </div>
              ))}
            </div>
          )}
          {more && (
            <button class="btn ghost block" style={{ marginTop: '14px' }} disabled={busy} onClick={() => load(page?.next_before)}>Load more</button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ icon, label, n }: { icon: preact.JSX.Element; label: string; n: { pending: number; failed_24h: number; sent_24h: number } }) {
  return (
    <div class={`dl-stat ${n.failed_24h ? 'bad' : ''}`}>
      <span class="dl-stat-ic">{icon}</span>
      <span class="dl-stat-label">{label}</span>
      <span class="dl-stat-nums">
        <b>{n.sent_24h}</b> sent · <b>{n.pending}</b> waiting · <b class="f">{n.failed_24h}</b> failed
      </span>
      <span class="dl-stat-sub">last 24 h</span>
    </div>
  )
}

function statusLabel(it: DeliveryItem) {
  if (it.status === 'sent') return 'Sent'
  if (it.status === 'failed') return 'Failed'
  return it.attempts > 0 ? 'Retrying' : 'Waiting'
}
