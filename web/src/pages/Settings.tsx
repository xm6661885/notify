// Settings: push on this device, my topics and blacklist, password, admin entry, sign out.

import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { me, toast, toastError } from '../lib/store'
import { back, navigate } from '../lib/router'
import { clearCaches } from '../lib/feed'
import { currentEndpoint, disablePush, enablePush, pushBusy, pushState, PUSH_LABEL, refreshPush } from '../lib/push'
import { platform, relTime } from '../lib/util'
import type { Device, NoteAction, UserSettings } from '../lib/types'
import { BackButton, confirmDialog, Segmented, Sheet, Switch, TopBar, useScrolled } from '../components/ui'
import { TagInput } from '../components/TagInput'
import { PLACEHOLDERS, Webhooks } from '../components/Webhooks'
import {
  IconBell, IconBellOff, IconBolt, IconChevron, IconPlus, IconTrash, IconLock, IconLogout, IconMonitor, IconPhone, IconQuestion, IconSend, IconShield,
} from '../components/icons'

export function Settings() {
  const { scrolled, onScroll } = useScrolled()
  const m = me.value || null
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [defTab, setDefTab] = useState<'all' | 'unread'>(() => localStorage.getItem('nt_default_tab') === 'unread' ? 'unread' : 'all')

  const loadDevices = () => api.devices().then((d) => setDevices(d.items)).catch(() => setDevices([]))
  useEffect(() => { refreshPush(); loadDevices() }, [])

  if (!m) return null
  const ps = pushState.value

  const toggle = async () => {
    try {
      if (ps === 'on') {
        await disablePush()
        toast('Push turned off on this device')
      } else {
        await enablePush()
        toast('Push is on. Sending a test notification.')
        api.testPush(await currentEndpoint()).catch(() => {})
      }
      loadDevices()
    } catch (e) { toastError(e) }
  }

  const test = async () => {
    try {
      const r = await api.testPush()
      toast(r.position > 0 ? `Test queued behind ${r.position} other push${r.position > 1 ? 'es' : ''}` : 'Test notification sent')
    } catch (e) { toastError(e) }
  }

  const logout = async () => {
    if (!(await confirmDialog({ title: 'Sign out?', body: 'This device keeps its push subscription until you turn push off.', confirm: 'Sign out', danger: true }))) return
    try { await api.logout() } catch { /* ignore */ }
    clearCaches()
    me.value = false
  }

  return (
    <div class="page">
      <TopBar scrolled={scrolled} left={<BackButton onClick={() => back()} />}>
        {scrolled && <span class="fade-in">Settings</span>}
      </TopBar>
      <div class="page-scroll" onScroll={onScroll}>
        <div class="container settings">
          <h1 class="large-title rise">Settings</h1>
          <p class="subtitle rise" style={{ '--i': 1 }}>Signed in as {m.user.username}{m.user.is_admin ? ' (admin)' : ''}.</p>

          <div class="group-title">Push on this device</div>
          <div class="group rise" style={{ '--i': 2 }}>
            <div class="row push-row">
              <span class={`push-ic ${ps || ''}`}>{ps === 'on' ? <IconBell /> : <IconBellOff />}</span>
              <span class="label">
                Web push
                <span class="hint">{pushHint(ps)}</span>
              </span>
              {ps === 'on' || ps === 'off'
                ? (pushBusy.value ? <span class="spinner" /> : <Switch on={ps === 'on'} onChange={toggle} label="Web push" />)
                : <span class={`status-tag ${ps || ''}`}>{ps ? PUSH_LABEL[ps] : ''}</span>}
            </div>
            {ps === 'on' && (
              <button class="row" onClick={test}>
                <IconSend class="row-ic" />
                <span class="label">Send a test notification</span>
              </button>
            )}
            <button class="row" onClick={() => navigate({ name: 'guide' })}>
              <IconQuestion class="row-ic" />
              <span class="label">How to get notifications<span class="hint">iPhone, Android, Mac and PC</span></span>
              <IconChevron class="chev" />
            </button>
          </div>

          {devices && devices.length > 0 && (
            <>
              <div class="group-title">Subscribed devices</div>
              <div class="group fade-in">
                {devices.map((d) => (
                  <div class="row" key={d.id}>
                    {/Mobile|iPhone|Android/.test(d.user_agent || '') ? <IconPhone class="row-ic" /> : <IconMonitor class="row-ic" />}
                    <span class="label">
                      {deviceName(d.user_agent)}
                      <span class="hint">
                        {d.endpoint_host} · {d.last_ok_at ? `last push ${relTime(d.last_ok_at)}` : `added ${relTime(d.created_at)}`}
                        {d.fail_count > 0 ? ` · ${d.fail_count} failed` : ''}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div class="group-title">Feed</div>
          <div class="group">
            <div class="field">
              <Segmented value={defTab} onChange={(v) => { localStorage.setItem('nt_default_tab', v); setDefTab(v) }}
                options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
              <span class="fhint">Tab shown when the app opens on this device.</span>
            </div>
          </div>

          <RoutingSettings />

          <Webhooks userId={m.user.id} />

          <ActionSettings />

          <div class="group-title">Account</div>
          <div class="group">
            <button class="row" onClick={() => setPwOpen(true)}>
              <IconLock class="row-ic" />
              <span class="label">Change password</span>
              <IconChevron class="chev" />
            </button>
            {m.user.is_admin && (
              <button class="row" onClick={() => navigate({ name: 'admin' })}>
                <IconShield class="row-ic" />
                <span class="label">Admin<span class="hint">Users, topic routing, delivery status, proxy</span></span>
                <IconChevron class="chev" />
              </button>
            )}
            <button class="row danger-row" onClick={logout}>
              <IconLogout class="row-ic" />
              <span class="label">Sign out</span>
            </button>
          </div>

          <div class="about">
            <span>Notify</span>
            <span>Web Push for your devices</span>
          </div>
        </div>
      </div>
      <PasswordSheet open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  )
}

function pushHint(ps: string | null) {
  switch (ps) {
    case 'on': return 'This device receives notifications.'
    case 'off': return 'Turn on to receive notifications here.'
    case 'denied': return 'Notifications are blocked. Allow them in browser or system settings.'
    case 'needs-install': return 'On iPhone and iPad, add this site to the Home Screen first.'
    case 'unsupported': return platform() === 'ios'
      ? 'Needs iOS 16.4 or later, opened from the Home Screen icon.'
      : 'This browser does not support web push here.'
    default: return 'Checking...'
  }
}

function deviceName(ua: string | null) {
  if (!ua) return 'Unknown device'
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : ''
  return br ? `${br} on ${os}` : os
}

/** My topic subscription and keyword blacklist. Saved as soon as they change. */
function RoutingSettings() {
  const m = me.value || null
  const [s, setS] = useState<UserSettings | null>(m ? m.settings : null)
  const [known, setKnown] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.topics('history').then((t) => setKnown(t.topics.map((x) => x.topic))).catch(() => {})
  }, [])

  if (!m || !s) return null

  const save = async (p: Partial<UserSettings>) => {
    const prev = s
    setS({ ...s, ...p })
    setSaving(true)
    try {
      const r = await api.saveSettings(p)
      me.value = r
      setS(r.settings)
    } catch (e) { setS(prev); toastError(e) } finally { setSaving(false) }
  }

  return (
    <>
      <div class="group-title with-spin">Topics {saving && <span class="spinner tiny" />}</div>
      <div class="group">
        <div class="field">
          <Segmented value={s.topics_mode} onChange={(v) => save({ topics_mode: v })}
            options={[{ value: 'all', label: 'Everything' }, { value: 'only', label: 'Only chosen topics' }]} />
          <span class="fhint">
            {s.topics_mode === 'all'
              ? 'You get every notification except blacklisted ones.'
              : 'You only get notifications tagged with one of these #topics.'}
          </span>
        </div>
        {s.topics_mode === 'only' && (
          <div class="field fade-in">
            <span class="flabel">My topics</span>
            <TagInput value={s.topics} prefix="#" placeholder="Add a topic, e.g. deploy" suggestions={known}
              onChange={(v) => save({ topics: v })} />
          </div>
        )}
      </div>

      <div class="group-title">Home filters</div>
      <div class="group">
        <div class="field">
          <TagInput value={s.feed_topics} prefix="#" placeholder="Add a topic" suggestions={known} sortable
            onChange={(v) => save({ feed_topics: v })} />
          <span class="fhint">
            {s.feed_topics.length
              ? 'Only these #topics appear as filters on the home screen, in this order. Use the arrows to reorder.'
              : 'The home screen shows a filter for every topic you have. Add topics to choose which ones appear.'}
          </span>
        </div>
      </div>

      <div class="group-title">Keyword blacklist</div>
      <div class="group">
        <div class="field">
          <TagInput value={s.blacklist} placeholder="Add a keyword" onChange={(v) => save({ blacklist: v })} />
          <span class="fhint">Notifications containing any of these words are not sent to you and do not appear in your lists.</span>
        </div>
        {s.admin_blacklist.length > 0 && (
          <div class="field">
            <span class="flabel">Set by admin</span>
            <TagInput value={s.admin_blacklist} onChange={() => {}} disabled />
          </div>
        )}
      </div>
    </>
  )
}

function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { if (open) { setCur(''); setPw(''); setPw2(''); setErr('') } }, [open])

  const submit = async (e: Event) => {
    e.preventDefault()
    if (pw !== pw2) { setErr('The new passwords do not match.'); return }
    if (pw.length < 4) { setErr('Use at least 4 characters.'); return }
    setBusy(true)
    setErr('')
    try {
      await api.changePassword(cur, pw)
      toast('Password changed. Other devices were signed out.')
      onClose()
    } catch (ex) { setErr((ex as Error).message) } finally { setBusy(false) }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Change password">
      <form onSubmit={submit} class="pw-form">
        <input type="text" autocomplete="username" value={me.value ? me.value.user.username : ''} hidden readOnly />
        <label class="flabel">Current password</label>
        <input class="input" type="password" autocomplete="current-password" value={cur} onInput={(e) => setCur((e.target as HTMLInputElement).value)} />
        <label class="flabel">New password</label>
        <input class="input" type="password" autocomplete="new-password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        <label class="flabel">Repeat new password</label>
        <input class="input" type="password" autocomplete="new-password" value={pw2} onInput={(e) => setPw2((e.target as HTMLInputElement).value)} />
        <div class="form-err" aria-live="polite">{err}</div>
        <button class="btn primary block" type="submit" disabled={busy || !cur || !pw || !pw2}>
          {busy ? <span class="spinner" /> : 'Change password'}
        </button>
      </form>
    </Sheet>
  )
}

/** Custom buttons on the notification page, opening a link or URL scheme built from the notification. */
function ActionSettings() {
  const m = me.value || null
  const [edit, setEdit] = useState<number | 'new' | null>(null)
  if (!m) return null
  const list = m.settings.actions

  const save = async (actions: NoteAction[]) => {
    try { me.value = await api.saveSettings({ actions }); return true } catch (e) { toastError(e); return false }
  }
  const move = (i: number, d: number) => {
    const next = [...list]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    save(next)
  }

  return (
    <>
      <div class="group-title">Notification buttons</div>
      <div class="group">
        {list.length === 0 && (
          <div class="row"><span class="label"><span class="hint">
            Add buttons next to Copy text on each notification. A button opens a link or app URL scheme, such as shortcuts://, filled with values from the notification.
          </span></span></div>
        )}
        {list.map((a, i) => (
          <div class="row act-row" key={i}>
            <button class="wh-main" onClick={() => setEdit(i)}>
              <IconBolt class="row-ic" />
              <span class="label">{a.name}<span class="hint">{a.url}</span></span>
            </button>
            <button class="icon-btn" aria-label={`Move ${a.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><IconChevron style={{ transform: 'rotate(-90deg)' }} /></button>
            <button class="icon-btn" aria-label={`Move ${a.name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}><IconChevron style={{ transform: 'rotate(90deg)' }} /></button>
          </div>
        ))}
        {list.length < 20 && (
          <button class="row accent-row" onClick={() => setEdit('new')}>
            <IconPlus class="row-ic" />
            <span class="label">Add button</span>
          </button>
        )}
      </div>
      <ActionSheet target={edit} initial={typeof edit === 'number' ? list[edit] : null} onClose={() => setEdit(null)}
        onSave={async (a) => {
          const next = edit === 'new' ? [...list, a] : list.map((x, j) => (j === edit ? a : x))
          if (await save(next)) setEdit(null)
        }}
        onDelete={async () => {
          if (typeof edit !== 'number') return
          if (await save(list.filter((_, j) => j !== edit))) setEdit(null)
        }} />
    </>
  )
}

function ActionSheet({ target, initial, onClose, onSave, onDelete }: {
  target: number | 'new' | null
  initial: NoteAction | null
  onClose: () => void
  onSave: (a: NoteAction) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)

  useEffect(() => { if (target !== null) { setName(initial?.name || ''); setUrl(initial?.url || ''); setCursor(null) } }, [target])

  const insert = (p: string) => {
    const tag = `{{${p}}}`
    const at = cursor ?? url.length
    setUrl(url.slice(0, at) + tag + url.slice(at))
    setCursor(at + tag.length)
  }
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } finally { setBusy(false) } }

  return (
    <Sheet open={target !== null} onClose={onClose} title={target === 'new' ? 'New button' : 'Edit button'}>
      <form class="act-form" onSubmit={(e) => { e.preventDefault(); run(() => onSave({ name: name.trim(), url: url.trim() })) }}>
        <label class="flabel">Button name</label>
        <input class="input" value={name} maxLength={40} placeholder="e.g. Run shortcut"
          onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <label class="flabel">Link</label>
        <textarea class="textarea mono" rows={3} value={url} autocapitalize="none" autocorrect="off" spellcheck={false}
          placeholder="shortcuts://run-shortcut?name=Save&input=text&text={{text}}"
          onInput={(e) => { const t = e.target as HTMLTextAreaElement; setUrl(t.value); setCursor(t.selectionStart) }}
          onSelect={(e) => setCursor((e.target as HTMLTextAreaElement).selectionStart)} />
        <div class="wh-ph">
          {PLACEHOLDERS.map((p) => (
            <button type="button" key={p} class="chip" onClick={() => insert(p)}>{`{{${p}}}`}</button>
          ))}
        </div>
        <span class="fhint-inline">
          Any URL or app scheme. Placeholders are filled in and URL-encoded when you open a notification. Add <code>:N</code> to cut a value to N characters.
        </span>
        <button class="btn primary block" type="submit" disabled={busy || !name.trim() || !url.trim()}>
          {busy ? <span class="spinner" /> : 'Save'}
        </button>
        {target !== 'new' && (
          <button type="button" class="btn block danger" disabled={busy} onClick={() => run(onDelete)}>
            <IconTrash width={18} height={18} /> Delete
          </button>
        )}
      </form>
    </Sheet>
  )
}
