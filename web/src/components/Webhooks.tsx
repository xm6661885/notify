// Webhooks of one user: list plus an add/edit sheet. Used by Settings (own) and AdminUser (any user).

import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { toast, toastError } from '../lib/store'
import { relTime } from '../lib/util'
import type { Webhook, WebhookIn } from '../lib/types'
import { confirmDialog, Segmented, Sheet, Switch } from './ui'
import { TagInput } from './TagInput'
import { IconChevron, IconClose, IconPlus, IconSend, IconTrash, IconWebhook } from './icons'

const METHODS: WebhookIn['method'][] = ['POST', 'PUT', 'PATCH', 'GET']

const BLANK: WebhookIn = {
  name: '', enabled: true, url: '', method: 'POST', headers: {}, body_kind: 'json',
  body: '{\n  "text": "{{text}}"\n}', topics: [], use_proxy: false,
}

// Starting points for common targets. Only the template differs; everything stays editable.
const PRESETS: { label: string; make: () => Partial<WebhookIn> }[] = [
  { label: 'JSON', make: () => ({ body_kind: 'json', body: BLANK.body }) },
  {
    label: 'Telegram',
    make: () => ({
      name: 'Telegram', url: 'https://api.telegram.org/bot<TOKEN>/sendMessage', method: 'POST', body_kind: 'json',
      body: '{\n  "chat_id": "<CHAT_ID>",\n  "text": "{{text:4096}}",\n  "disable_web_page_preview": true\n}', use_proxy: true,
    }),
  },
  {
    label: 'OneBot / QQ',
    make: () => ({
      name: 'QQ group', url: 'http://127.0.0.1:3000/send_group_msg', method: 'POST', body_kind: 'json',
      body: '{\n  "group_id": "<GROUP_ID>",\n  "message": "{{text}}",\n  "auto_escape": true\n}',
    }),
  },
  { label: 'Plain text', make: () => ({ body_kind: 'text', body: '{{text}}' }) },
]

export const PLACEHOLDERS = ['text', 'title', 'body', 'topics', 'url', 'id', 'type', 'file_name', 'time', 'user']

export function Webhooks({ userId, admin }: { userId: number; admin?: boolean }) {
  const [items, setItems] = useState<Webhook[] | null>(null)
  const [edit, setEdit] = useState<Webhook | 'new' | null>(null)

  const load = () => api.webhooks(userId).then((r) => setItems(r.items)).catch((e) => { setItems([]); toastError(e) })
  useEffect(() => { load() }, [userId])

  const toggle = async (w: Webhook, enabled: boolean) => {
    setItems((l) => l && l.map((x) => (x.id === w.id ? { ...x, enabled } : x)))
    try {
      const r = await api.updateWebhook(userId, w.id, { enabled })
      setItems((l) => l && l.map((x) => (x.id === w.id ? r : x)))
    } catch (e) { toastError(e); load() }
  }

  return (
    <>
      <div class="group-title">Webhooks</div>
      <div class="group">
        {items?.length === 0 && (
          <div class="row"><span class="label"><span class="hint">
            Forward the text of every notification {admin ? 'this user gets' : 'you get'} to another service, such as a Telegram bot or a chat group.
          </span></span></div>
        )}
        {items?.map((w) => (
          <div class="row wh-row" key={w.id}>
            <button class="wh-main" onClick={() => setEdit(w)}>
              <span class={`wh-ic ${w.enabled ? (w.fail_count ? 'bad' : 'on') : ''}`}><IconWebhook /></span>
              <span class="label">
                {w.name}
                {w.use_proxy && <span class="mini-tag muted">Proxy</span>}
                <span class="hint">{whHint(w)}</span>
              </span>
              <IconChevron class="chev" />
            </button>
            <Switch on={w.enabled} onChange={(v) => toggle(w, v)} label={`Enable ${w.name}`} />
          </div>
        ))}
        <button class="row accent-row" onClick={() => setEdit('new')}>
          <IconPlus class="row-ic" />
          <span class="label">Add webhook</span>
        </button>
      </div>
      <WebhookSheet userId={userId} target={edit} onClose={() => setEdit(null)}
        onSaved={(w) => { setItems((l) => { const r = l || []; return r.some((x) => x.id === w.id) ? r.map((x) => (x.id === w.id ? w : x)) : [...r, w] }) }}
        onDeleted={(id) => { setItems((l) => l && l.filter((x) => x.id !== id)); setEdit(null) }} />
    </>
  )
}

function whHint(w: Webhook) {
  let host = ''
  try { host = new URL(w.url).host } catch { host = w.url }
  const parts = [host]
  if (w.topics.length) parts.push(w.topics.map((t) => `#${t}`).join(' '))
  if (!w.enabled) parts.push('Off')
  else if (w.fail_count) parts.push(`failing: ${w.last_error || 'error'}`)
  else if (w.last_ok_at) parts.push(`last sent ${relTime(w.last_ok_at)}`)
  return parts.join(' · ')
}

type HeaderRow = { k: string; v: string }

function WebhookSheet({ userId, target, onClose, onSaved, onDeleted }: {
  userId: number
  target: Webhook | 'new' | null
  onClose: () => void
  onSaved: (w: Webhook) => void
  onDeleted: (id: number) => void
}) {
  const isNew = target === 'new'
  const [f, setF] = useState<WebhookIn>(BLANK)
  const [headers, setHeaders] = useState<HeaderRow[]>([])
  const [saved, setSaved] = useState<Webhook | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!target) return
    setErr('')
    if (target === 'new') {
      setF(BLANK); setHeaders([]); setSaved(null)
    } else {
      setF({
        name: target.name, enabled: target.enabled, url: target.url, method: target.method, headers: target.headers,
        body_kind: target.body_kind, body: target.body, topics: target.topics, use_proxy: target.use_proxy,
      })
      setHeaders(Object.entries(target.headers).map(([k, v]) => ({ k, v })))
      setSaved(target)
    }
  }, [target])

  const set = (p: Partial<WebhookIn>) => setF((x) => ({ ...x, ...p }))
  const setHeader = (i: number, p: Partial<HeaderRow>) => setHeaders((h) => h.map((r, j) => (j === i ? { ...r, ...p } : r)))

  const payload = (): WebhookIn => ({
    ...f,
    name: f.name.trim(),
    url: f.url.trim(),
    headers: Object.fromEntries(headers.filter((h) => h.k.trim()).map((h) => [h.k.trim(), h.v])),
  })

  const jsonError = (() => {
    if (f.body_kind !== 'json' || !f.body.trim()) return ''
    try { JSON.parse(f.body); return '' } catch { return 'The body is not valid JSON.' }
  })()

  const save = async (e?: Event) => {
    e?.preventDefault()
    if (jsonError) { setErr(jsonError); return }
    setBusy(true)
    setErr('')
    try {
      const w = saved ? await api.updateWebhook(userId, saved.id, payload()) : await api.createWebhook(userId, payload())
      setSaved(w)
      onSaved(w)
      toast(saved ? 'Webhook saved' : `Added ${w.name}`)
      onClose()
    } catch (ex) { setErr((ex as Error).message) } finally { setBusy(false) }
  }

  // Test always runs against the saved version, so save first when there are edits.
  const test = async () => {
    if (jsonError) { setErr(jsonError); return }
    setTesting(true)
    setErr('')
    try {
      let w = saved
      w = w ? await api.updateWebhook(userId, w.id, payload()) : await api.createWebhook(userId, payload())
      setSaved(w)
      onSaved(w)
      const r = await api.testWebhook(userId, w.id)
      if (r.ok) toast(`Test sent${r.status ? ` (HTTP ${r.status})` : ''}`)
      else setErr(`Test failed: ${r.error || `HTTP ${r.status}`}`)
    } catch (ex) { setErr((ex as Error).message) } finally { setTesting(false) }
  }

  const remove = async () => {
    if (!saved) return
    if (!(await confirmDialog({ title: `Delete ${saved.name}?`, body: 'Queued deliveries to this webhook are dropped.', confirm: 'Delete', danger: true }))) return
    try { await api.deleteWebhook(userId, saved.id); onDeleted(saved.id); toast('Webhook deleted') } catch (e) { toastError(e) }
  }

  const insert = (name: string) => set({ body: f.body + `{{${name}}}` })

  return (
    <Sheet open={!!target} onClose={onClose} title={isNew && !saved ? 'Add webhook' : f.name || 'Webhook'}
      actions={saved ? <button class="icon-btn" aria-label="Delete webhook" onClick={remove}><IconTrash /></button> : undefined}>
      <form class="pw-form wh-form" onSubmit={save}>
        {isNew && !saved && (
          <div class="tags-suggest wh-presets">
            {PRESETS.map((p) => <button type="button" key={p.label} class="chip dashed" onClick={() => set(p.make())}>{p.label}</button>)}
          </div>
        )}
        <label class="flabel">Name</label>
        <input class="input" value={f.name} placeholder="Telegram" maxLength={64} autocomplete="off"
          onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />

        <label class="flabel">URL</label>
        <div class="wh-url">
          <select class="select wh-method" value={f.method} aria-label="Method"
            onChange={(e) => set({ method: (e.target as HTMLSelectElement).value as WebhookIn['method'] })}>
            {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input class="input mono" value={f.url} placeholder="https://example.com/hook" inputMode="url"
            autocapitalize="none" autocorrect="off" spellcheck={false} autocomplete="off"
            onInput={(e) => set({ url: (e.target as HTMLInputElement).value })} />
        </div>

        <label class="flabel">Headers</label>
        <div class="wh-headers">
          {headers.map((h, i) => (
            <div class="wh-header" key={i}>
              <input class="input mono" value={h.k} placeholder="Authorization" aria-label="Header name"
                autocapitalize="none" autocorrect="off" spellcheck={false} autocomplete="off"
                onInput={(e) => setHeader(i, { k: (e.target as HTMLInputElement).value })} />
              <input class="input mono" value={h.v} placeholder="Bearer ..." aria-label="Header value"
                autocapitalize="none" autocorrect="off" spellcheck={false} autocomplete="off"
                onInput={(e) => setHeader(i, { v: (e.target as HTMLInputElement).value })} />
              <button type="button" class="icon-btn" aria-label="Remove header"
                onClick={() => setHeaders((x) => x.filter((_, j) => j !== i))}><IconClose /></button>
            </div>
          ))}
          <button type="button" class="btn ghost small wh-add" onClick={() => setHeaders((x) => [...x, { k: '', v: '' }])}>
            <IconPlus /> Add header
          </button>
        </div>

        {f.method !== 'GET' && (
          <>
            <label class="flabel">Body</label>
            <Segmented value={f.body_kind} onChange={(v) => set({ body_kind: v })}
              options={[{ value: 'json', label: 'JSON' }, { value: 'text', label: 'Text' }]} />
            <textarea class="textarea mono wh-body" value={f.body} rows={6} spellcheck={false} autocapitalize="none" autocorrect="off"
              placeholder={f.body_kind === 'json' ? '{"text": "{{text}}"}' : '{{text}}'}
              onInput={(e) => set({ body: (e.target as HTMLTextAreaElement).value })} />
            {jsonError && <span class="fhint-inline warn-text">{jsonError}</span>}
          </>
        )}
        <div class="wh-ph">
          {PLACEHOLDERS.map((p) => (
            <button type="button" key={p} class="chip" onClick={() => insert(p)} disabled={f.method === 'GET'}>{`{{${p}}}`}</button>
          ))}
        </div>
        <span class="fhint-inline">
          Placeholders work in the URL, headers and body. Add <code>:N</code> to cut a value to N characters, for example <code>{'{{text:4096}}'}</code>.
        </span>

        <label class="flabel">Topics</label>
        <TagInput value={f.topics} prefix="#" placeholder="All topics" onChange={(v) => set({ topics: v })} />
        <span class="fhint-inline">Leave empty to forward everything. Otherwise only notifications with one of these topics.</span>

        <div class="row plain-row">
          <span class="label">Use HTTP proxy<span class="hint">Send through the proxy set by the admin.</span></span>
          <Switch on={f.use_proxy} onChange={(v) => set({ use_proxy: v })} label="Use HTTP proxy" />
        </div>
        <div class="row plain-row">
          <span class="label">Enabled</span>
          <Switch on={f.enabled} onChange={(v) => set({ enabled: v })} label="Enabled" />
        </div>
        {saved?.last_error && <div class="wh-last">Last error: {saved.last_error}</div>}

        <div class="form-err" aria-live="polite">{err}</div>
        <div class="wh-actions">
          <button type="button" class="btn ghost" onClick={test} disabled={busy || testing || !f.name.trim() || !f.url.trim()}>
            {testing ? <span class="spinner" /> : <><IconSend /> Save and test</>}
          </button>
          <button type="submit" class="btn primary" disabled={busy || testing || !f.name.trim() || !f.url.trim()}>
            {busy ? <span class="spinner" /> : 'Save'}
          </button>
        </div>
      </form>
    </Sheet>
  )
}
