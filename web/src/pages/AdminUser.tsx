// Admin view of one user: role, status, password reset, topics, both blacklists, delete.

import { useEffect, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { me, toast, toastError } from '../lib/store'
import { back } from '../lib/router'
import { relTime } from '../lib/util'
import type { AdminUser as AU, UserSettings } from '../lib/types'
import { BackButton, confirmDialog, promptDialog, Segmented, Switch, TopBar, useScrolled } from '../components/ui'
import { TagInput } from '../components/TagInput'
import { Webhooks } from '../components/Webhooks'
import { IconKey, IconTrash } from '../components/icons'

export function AdminUser({ id }: { id: number }) {
  const { scrolled, onScroll } = useScrolled()
  const [u, setU] = useState<AU | null>(null)
  const [missing, setMissing] = useState(false)
  const [known, setKnown] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const self = me.value ? me.value.user.id === id : false

  useEffect(() => {
    api.users().then((r) => {
      const x = r.items.find((i) => i.id === id)
      if (x) setU(x); else setMissing(true)
    }).catch(toastError)
    api.knownTopics().then((r) => setKnown(r.topics)).catch(() => {})
  }, [id])

  const patch = async (p: Parameters<typeof api.updateUser>[1], optimistic?: Partial<AU>) => {
    if (!u) return
    const prev = u
    if (optimistic) setU({ ...u, ...optimistic })
    setSaving(true)
    try {
      const r = await api.updateUser(u.id, p)
      setU(r)
      // Editing myself changes what the rest of the app shows.
      if (self) api.me().then((m) => { me.value = m }).catch(() => {})
      return r
    } catch (e) { setU(prev); toastError(e) } finally { setSaving(false) }
  }

  const saveSettings = (s: Partial<UserSettings>) => u && patch({ settings: s }, { settings: { ...u.settings, ...s } })

  const resetPw = async () => {
    if (!u) return
    const pw = await promptDialog({ title: `New password for ${u.username}`, placeholder: 'At least 4 characters', confirm: 'Set password' })
    if (pw === null) return
    if (pw.length < 4) { toast('Use at least 4 characters', 'error'); return }
    if (await patch({ password: pw })) toast(self ? 'Password changed' : `Password changed. ${u.username} was signed out everywhere.`)
  }

  const remove = async () => {
    if (!u) return
    if (!(await confirmDialog({
      title: `Delete ${u.username}?`,
      body: 'Their devices stop receiving pushes and their read and archive state is removed. Notifications stay in the global history.',
      confirm: 'Delete user', danger: true,
    }))) return
    try {
      await api.deleteUser(u.id)
      toast(`Deleted ${u.username}`)
      back({ name: 'admin' })
    } catch (e) { toastError(e) }
  }

  return (
    <div class="page">
      <TopBar scrolled={scrolled} left={<BackButton onClick={() => back({ name: 'admin' })} label="Admin" />}
        right={saving ? <span class="spinner" style={{ marginRight: '12px' }} /> : undefined}>
        {scrolled && u && <span class="fade-in">{u.username}</span>}
      </TopBar>
      <div class="page-scroll" onScroll={onScroll}>
        <div class="container settings">
          {missing && <div class="empty rise"><h3 class="serif">User not found</h3></div>}
          {u && (
            <>
              <div class="user-hero rise">
                <span class={`user-av big ${u.disabled ? 'off' : ''}`}>{u.username.slice(0, 1).toUpperCase()}</span>
                <h1 class="large-title">{u.username}</h1>
                <p class="subtitle">
                  Joined {relTime(u.created_at)} · {u.subscriptions} device{u.subscriptions === 1 ? '' : 's'} · {u.delivered} received · {u.unread} unread
                </p>
              </div>

              <div class="group-title">Account</div>
              <div class="group rise" style={{ '--i': 1 }}>
                <div class="row">
                  <span class="label">Administrator</span>
                  <Switch on={u.is_admin} onChange={(v) => patch({ is_admin: v }, { is_admin: v })} label="Administrator" />
                </div>
                <div class="row">
                  <span class="label">Disabled<span class="hint">Cannot sign in and receives nothing.</span></span>
                  <Switch on={u.disabled} onChange={(v) => patch({ disabled: v }, { disabled: v })} label="Disabled" />
                </div>
                <button class="row" onClick={resetPw}>
                  <IconKey class="row-ic" />
                  <span class="label">Set a new password</span>
                </button>
              </div>

              <div class="group-title">Topics</div>
              <div class="group">
                <div class="field">
                  <Segmented value={u.settings.topics_mode} onChange={(v) => saveSettings({ topics_mode: v })}
                    options={[{ value: 'all', label: 'Everything' }, { value: 'only', label: 'Only chosen topics' }]} />
                </div>
                {u.settings.topics_mode === 'only' && (
                  <div class="field fade-in">
                    <span class="flabel">Topics</span>
                    <TagInput value={u.settings.topics} prefix="#" placeholder="Add a topic" suggestions={known}
                      onChange={(v) => saveSettings({ topics: v })} />
                  </div>
                )}
              </div>

              <div class="group-title">Blacklist</div>
              <div class="group">
                <div class="field">
                  <span class="flabel">Admin blacklist</span>
                  <TagInput value={u.settings.admin_blacklist} placeholder="Add a keyword"
                    onChange={(v) => saveSettings({ admin_blacklist: v })} />
                  <span class="fhint">The user can see these but not remove them.</span>
                </div>
                <div class="field">
                  <span class="flabel">User's own blacklist</span>
                  <TagInput value={u.settings.blacklist} placeholder="Add a keyword"
                    onChange={(v) => saveSettings({ blacklist: v })} />
                </div>
              </div>

              <Webhooks userId={u.id} admin />

              {!self && (
                <div class="group" style={{ marginTop: '26px' }}>
                  <button class="row danger-row" onClick={remove}>
                    <IconTrash class="row-ic" />
                    <span class="label">Delete user</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
