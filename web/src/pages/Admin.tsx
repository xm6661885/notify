// Admin: users, topic routing, registration and push pacing.

import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { me, toast, toastError } from '../lib/store'
import { back, navigate } from '../lib/router'
import type { AdminUser, PushService, Route_, SiteSettings } from '../lib/types'
import { BackButton, confirmDialog, Sheet, Switch, TopBar, useScrolled } from '../components/ui'
import { IconAlert, IconChevron, IconGlobe, IconHash, IconPlus, IconTrash, IconUser } from '../components/icons'

export function Admin() {
  const { scrolled, onScroll } = useScrolled()
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [routes, setRoutes] = useState<Route_[] | null>(null)
  const [site, setSite] = useState<SiteSettings | null>(null)
  const [known, setKnown] = useState<string[]>([])
  const [newUser, setNewUser] = useState(false)
  const [editRoute, setEditRoute] = useState<Route_ | 'new' | null>(null)

  const load = () => {
    api.users().then((r) => setUsers(r.items)).catch(toastError)
    api.routes().then((r) => setRoutes(r.items)).catch(toastError)
    api.siteSettings().then(setSite).catch(toastError)
    api.knownTopics().then((r) => setKnown(r.topics)).catch(() => {})
  }
  useEffect(load, [])

  const patchSite = async (p: Partial<Omit<SiteSettings, 'push' | 'webhook' | 'vapid_public_key'>>) => {
    if (!site) return
    const prev = site
    setSite({ ...site, ...p })
    try { setSite(await api.saveSiteSettings(p)) } catch (e) { setSite(prev); toastError(e) }
  }

  return (
    <div class="page">
      <TopBar scrolled={scrolled} left={<BackButton onClick={() => back()} />}>
        {scrolled && <span class="fade-in">Admin</span>}
      </TopBar>
      <div class="page-scroll" onScroll={onScroll}>
        <div class="container settings">
          <h1 class="large-title rise">Admin</h1>
          <p class="subtitle rise" style={{ '--i': 1 }}>Who receives what, and how pushes go out.</p>

          <div class="group-title">Users</div>
          <div class="group rise" style={{ '--i': 2 }}>
            {!users && <div class="row"><span class="skeleton" style={{ height: '18px', width: '50%' }} /></div>}
            {users?.map((u) => (
              <button class="row" key={u.id} onClick={() => navigate({ name: 'admin-user', id: u.id })}>
                <span class={`user-av ${u.disabled ? 'off' : ''}`}>{u.username.slice(0, 1).toUpperCase()}</span>
                <span class="label">
                  {u.username}
                  {u.is_admin && <span class="mini-tag">Admin</span>}
                  {u.disabled && <span class="mini-tag muted">Disabled</span>}
                  <span class="hint">
                    {u.subscriptions} device{u.subscriptions === 1 ? '' : 's'}{u.webhooks ? ` · ${u.webhooks} webhook${u.webhooks === 1 ? '' : 's'}` : ''} · {u.delivered} received
                    {u.settings.topics_mode === 'only' ? ` · ${u.settings.topics.length} topic${u.settings.topics.length === 1 ? '' : 's'} only` : ''}
                    {u.settings.blacklist.length + u.settings.admin_blacklist.length > 0
                      ? ` · ${u.settings.blacklist.length + u.settings.admin_blacklist.length} blocked` : ''}
                  </span>
                </span>
                <IconChevron class="chev" />
              </button>
            ))}
            <button class="row accent-row" onClick={() => setNewUser(true)}>
              <IconPlus class="row-ic" />
              <span class="label">Add user</span>
            </button>
          </div>

          <div class="group-title">Topic routing</div>
          <div class="group">
            {routes?.length === 0 && (
              <div class="row"><span class="label"><span class="hint">
                Route a #topic to chosen users. Notifications with that topic then go only to them, whatever their own topic settings say.
              </span></span></div>
            )}
            {routes?.map((r) => (
              <button class="row" key={r.key} onClick={() => setEditRoute(r)}>
                <IconHash class="row-ic" />
                <span class="label">#{r.topic}<span class="hint">Only {r.users.join(', ')}</span></span>
                <IconChevron class="chev" />
              </button>
            ))}
            <button class="row accent-row" onClick={() => setEditRoute('new')}>
              <IconPlus class="row-ic" />
              <span class="label">Add route</span>
            </button>
          </div>

          {site && (
            <>
              <div class="group-title">Registration</div>
              <div class="group">
                <div class="row">
                  <span class="label">Open registration<span class="hint">Anyone with the link can create an account.</span></span>
                  <Switch on={site.registration_open} onChange={(v) => patchSite({ registration_open: v })} label="Open registration" />
                </div>
                {site.registration_open && (
                  <div class="row fade-in">
                    <span class="label">Require invite code</span>
                    <Switch on={site.invite_only} onChange={(v) => patchSite({ invite_only: v })} label="Require invite code" />
                  </div>
                )}
                {site.registration_open && site.invite_only && (
                  <InviteField value={site.invite_code} onSave={(v) => patchSite({ invite_code: v })} />
                )}
              </div>

              <div class="group-title">Delivery</div>
              <div class="group">
                <button class="row" onClick={() => navigate({ name: 'delivery' })}>
                  <IconAlert class={`row-ic ${site.push.failed_24h + site.webhook.failed_24h ? 'bad-ic' : ''}`} />
                  <span class="label">
                    Delivery status
                    <span class="hint">
                      {site.push.pending + site.webhook.pending} waiting · {site.push.sent_24h + site.webhook.sent_24h} sent today
                      {site.push.failed_24h + site.webhook.failed_24h ? ` · ${site.push.failed_24h + site.webhook.failed_24h} failed` : ''}
                    </span>
                  </span>
                  {site.push.failed_24h + site.webhook.failed_24h > 0 && <span class="count-badge">{site.push.failed_24h + site.webhook.failed_24h}</span>}
                  <IconChevron class="chev" />
                </button>
                <IntervalField value={site.push_interval_sec} onSave={(v) => patchSite({ push_interval_sec: v })} />
              </div>

              <div class="group-title">Proxy</div>
              <div class="group">
                <ProxyField value={site.proxy_url} onSave={(v) => patchSite({ proxy_url: v })} />
                <div class="field">
                  <span class="flabel">Send pushes through the proxy</span>
                  <span class="fhint" style={{ marginTop: 0, marginBottom: '4px' }}>Each browser uses its own push service. Pick the ones this server cannot reach directly.</span>
                </div>
                {SERVICES.map((sv) => (
                  <div class="row" key={sv.key}>
                    <span class="label">{sv.label}<span class="hint">{sv.hint}</span></span>
                    <Switch on={!!site.push_proxy[sv.key]} label={sv.label}
                      onChange={(v) => patchSite({ push_proxy: { ...site.push_proxy, [sv.key]: v } })} />
                  </div>
                ))}
                <div class="row"><span class="label"><span class="hint">Webhooks choose for themselves with their own Use HTTP proxy switch.</span></span></div>
              </div>
            </>
          )}
        </div>
      </div>
      <NewUserSheet open={newUser} onClose={() => setNewUser(false)} onCreated={(u) => { setUsers((l) => [...(l || []), u]); setNewUser(false) }} />
      <RouteSheet route={editRoute} users={users || []} known={known} onClose={() => setEditRoute(null)}
        onSaved={() => { setEditRoute(null); api.routes().then((r) => setRoutes(r.items)).catch(toastError) }} />
    </div>
  )
}

const SERVICES: { key: PushService; label: string; hint: string }[] = [
  { key: 'google', label: 'Google', hint: 'Chrome, Edge and Android (fcm.googleapis.com)' },
  { key: 'apple', label: 'Apple', hint: 'Safari on iPhone, iPad and Mac (push.apple.com)' },
  { key: 'mozilla', label: 'Mozilla', hint: 'Firefox (push.services.mozilla.com)' },
  { key: 'microsoft', label: 'Microsoft', hint: 'Legacy Edge on Windows (notify.windows.com)' },
  { key: 'other', label: 'Other', hint: 'Any other push service' },
]

function ProxyField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <div class="field">
      <span class="flabel">HTTP proxy</span>
      <div class="inline-form">
        <IconGlobe class="row-ic" />
        <input class="input mono" value={v} placeholder="http://127.0.0.1:7890" inputMode="url" autocapitalize="none" autocorrect="off"
          spellcheck={false} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        <button class="btn small primary" disabled={v.trim() === value} onClick={() => { onSave(v.trim()); toast('Proxy saved') }}>Save</button>
      </div>
      <span class="fhint">Used by the push services switched on below and by webhooks that ask for it. Leave empty to send everything directly.</span>
    </div>
  )
}

function InviteField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <div class="field fade-in">
      <span class="flabel">Invite code</span>
      <div class="inline-form">
        <input class="input" value={v} placeholder="Choose a code" autocapitalize="none" spellcheck={false}
          onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        <button class="btn small primary" disabled={v === value} onClick={() => { onSave(v.trim()); toast('Invite code saved') }}>Save</button>
      </div>
      {!value && <span class="fhint warn-text">No code set yet, so nobody can register.</span>}
    </div>
  )
}

function IntervalField({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const n = Number(v)
  const ok = v.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 600
  return (
    <div class="field">
      <span class="flabel">Seconds between pushes</span>
      <div class="inline-form">
        <input class="input" type="number" inputMode="decimal" min={0} max={600} step="0.5" value={v}
          onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        <button class="btn small primary" disabled={!ok || n === value} onClick={() => { onSave(n); toast('Saved') }}>Save</button>
      </div>
      <span class="fhint">Every push request waits this long after the previous one, across all users and devices.</span>
    </div>
  )
}

function NewUserSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (u: AdminUser) => void }) {
  const [name, setName] = useState('')
  const [pw, setPw] = useState('')
  const [admin, setAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { if (open) { setName(''); setPw(''); setAdmin(false); setErr('') } }, [open])

  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const u = await api.createUser(name.trim(), pw, admin)
      toast(`Created ${u.username}`)
      onCreated(u)
    } catch (ex) { setErr((ex as Error).message) } finally { setBusy(false) }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add user">
      <form class="pw-form" onSubmit={submit}>
        <label class="flabel">Username</label>
        <input class="input" value={name} autocapitalize="none" autocorrect="off" spellcheck={false} autocomplete="off"
          onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <label class="flabel">Password</label>
        <input class="input" type="text" value={pw} autocomplete="off" autocapitalize="none" spellcheck={false}
          onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
        <div class="row plain-row">
          <span class="label">Administrator</span>
          <Switch on={admin} onChange={setAdmin} label="Administrator" />
        </div>
        <div class="form-err" aria-live="polite">{err}</div>
        <button class="btn primary block" type="submit" disabled={busy || !name.trim() || !pw}>
          {busy ? <span class="spinner" /> : 'Create user'}
        </button>
      </form>
    </Sheet>
  )
}

function RouteSheet({ route, users, known, onClose, onSaved }: {
  route: Route_ | 'new' | null
  users: AdminUser[]
  known: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const isNew = route === 'new'
  const [topic, setTopic] = useState('')
  const [ids, setIds] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!route) return
    if (route === 'new') {
      setTopic('')
      const self = me.value ? me.value.user.id : null
      setIds(new Set(self ? [self] : []))
    } else {
      setTopic(route.topic)
      setIds(new Set(route.user_ids))
    }
  }, [route])

  const flip = (id: number) => setIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const clean = topic.trim().replace(/^#+/, '')

  const save = async () => {
    setBusy(true)
    try {
      await api.saveRoute(clean, [...ids])
      toast(`#${clean} routed to ${ids.size} user${ids.size === 1 ? '' : 's'}`)
      onSaved()
    } catch (e) { toastError(e) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (route === 'new' || !route) return
    if (!(await confirmDialog({ title: `Remove route #${route.topic}?`, body: 'Notifications with this topic go back to normal delivery.', confirm: 'Remove', danger: true }))) return
    try { await api.deleteRoute(route.key); onSaved() } catch (e) { toastError(e) }
  }

  const suggestions = known.filter((k) => k.toLowerCase().includes(clean.toLowerCase()) && k.toLowerCase() !== clean.toLowerCase()).slice(0, 10)

  return (
    <Sheet open={!!route} onClose={onClose} title={!route || route === 'new' ? 'Add route' : `#${route.topic}`}
      actions={!isNew && route ? <button class="icon-btn" aria-label="Remove route" onClick={remove}><IconTrash /></button> : undefined}>
      <p class="sheet-note">Notifications tagged with this topic go only to the users you pick. Their keyword blacklists still apply.</p>
      {isNew && (
        <div class="pw-form">
          <label class="flabel">Topic</label>
          <div class="hash-input">
            <span>#</span>
            <input class="input" value={topic} placeholder="deploy" autocapitalize="none" autocorrect="off" spellcheck={false}
              onInput={(e) => setTopic((e.target as HTMLInputElement).value)} />
          </div>
          {suggestions.length > 0 && (
            <div class="tags-suggest">
              {suggestions.map((s) => <button type="button" key={s} class="chip dashed" onClick={() => setTopic(s)}>#{s}</button>)}
            </div>
          )}
        </div>
      )}
      <div class="flabel" style={{ margin: '16px 4px 8px' }}>Deliver only to</div>
      <div class="group">
        {users.map((u) => (
          <button class="row" key={u.id} onClick={() => flip(u.id)} aria-pressed={ids.has(u.id)}>
            <span class={`check ${ids.has(u.id) ? 'on' : ''}`} />
            <span class="label">{u.username}{u.disabled && <span class="mini-tag muted">Disabled</span>}</span>
            {u.is_admin && <IconUser class="row-ic dim" />}
          </button>
        ))}
      </div>
      <button class="btn primary block" style={{ marginTop: '18px' }} disabled={busy || !clean || ids.size === 0} onClick={save}>
        {busy ? <span class="spinner" /> : 'Save route'}
      </button>
    </Sheet>
  )
}

