import { useEffect, useRef, useState } from 'preact/hooks'
import { api, ApiError } from '../lib/api'
import { me, unread } from '../lib/store'
import { BellMark } from '../components/BellMark'
import { IconKey, IconLock, IconUser } from '../components/icons'

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [cfg, setCfg] = useState<{ registration_open: boolean; invite_only: boolean } | null>(null)
  const [username, setUsername] = useState(() => localStorage.getItem('nt_last_user') || '')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [shake, setShake] = useState(0)
  const userRef = useRef<HTMLInputElement>(null)
  const pwRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.publicConfig().then(setCfg).catch(() => setCfg({ registration_open: false, invite_only: false }))
    // Only autofocus on wide screens: on phones focusing pops the keyboard over the card.
    if (matchMedia('(pointer: fine)').matches) setTimeout(() => (username ? pwRef : userRef).current?.focus(), 400)
  }, [])

  const fail = (msg: string) => { setErr(msg); setShake((s) => s + 1) }

  const submit = async (e: Event) => {
    e.preventDefault()
    if (busy) return
    const u = username.trim()
    if (!u || !pw) return
    if (mode === 'register' && pw !== pw2) { fail('The two passwords do not match.'); return }
    setBusy(true)
    setErr('')
    try {
      const m = mode === 'login' ? await api.login(u, pw) : await api.register(u, pw, code.trim() || undefined)
      localStorage.setItem('nt_last_user', m.user.username)
      unread.value = m.unread
      me.value = m
    } catch (ex) {
      const status = ex instanceof ApiError ? ex.status : 0
      if (mode === 'login') {
        fail(status === 429 ? 'Too many attempts. Try again in a few minutes.'
          : status === 403 ? 'This account is disabled.'
          : status === 0 ? (ex as Error).message : 'Wrong username or password.')
        setPw('')
      } else {
        fail((ex as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const canRegister = !!cfg?.registration_open
  const swap = () => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); setPw(''); setPw2('') }

  return (
    <div class="page login enter-fade">
      <div class="login-blob b1" />
      <div class="login-blob b2" />
      <form class="login-card" onSubmit={submit} key={mode}>
        <div class="login-mark"><BellMark ring /></div>
        <h1 class="login-title">{mode === 'login' ? 'Notify' : 'Create account'}</h1>
        <p class="login-sub">{mode === 'login' ? 'Sign in to see your notifications.' : 'Pick a username and a password.'}</p>
        <div class={`login-fields ${err ? 'err' : ''}`} key={shake} style={shake ? { animation: 'shake 0.45s' } : {}}>
          <label class="login-field">
            <IconUser />
            <input ref={userRef} type="text" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck={false}
              placeholder="Username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
              aria-label="Username" />
          </label>
          <label class="login-field">
            <IconLock />
            <input ref={pwRef} type="password" autocomplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} aria-label="Password" />
          </label>
          {mode === 'register' && (
            <label class="login-field">
              <IconLock />
              <input type="password" autocomplete="new-password" placeholder="Repeat password" value={pw2}
                onInput={(e) => setPw2((e.target as HTMLInputElement).value)} aria-label="Repeat password" />
            </label>
          )}
          {mode === 'register' && cfg?.invite_only && (
            <label class="login-field">
              <IconKey />
              <input type="text" autocomplete="off" autocapitalize="none" spellcheck={false} placeholder="Invite code" value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)} aria-label="Invite code" />
            </label>
          )}
        </div>
        <div class="login-err" aria-live="polite">{err}</div>
        <button class="btn primary block login-btn" type="submit" disabled={!username.trim() || !pw || busy}>
          {busy ? <span class="spinner" /> : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        {(canRegister || mode === 'register') && (
          <button type="button" class="login-switch" onClick={swap}>
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        )}
      </form>
    </div>
  )
}
