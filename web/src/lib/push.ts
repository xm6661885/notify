// Web Push subscription state for this device.

import { signal } from '@preact/signals'
import { api } from './api'
import { platform, standalone } from './util'

export type PushState =
  | 'unsupported'   // browser has no Push API here (e.g. iOS Safari tab, insecure origin)
  | 'needs-install' // iOS: works only after Add to Home Screen
  | 'denied'        // user blocked notifications
  | 'off'           // supported, not subscribed
  | 'on'            // subscribed and saved on the server

export const pushState = signal<PushState | null>(null)
export const pushBusy = signal(false)

const supported = () =>
  isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

function b64urlToBytes(value: string) {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

async function registration() {
  return navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready)
}

export async function refreshPush(): Promise<PushState> {
  let s: PushState
  if (!supported()) {
    s = platform() === 'ios' && !standalone() ? 'needs-install' : 'unsupported'
  } else if (Notification.permission === 'denied') {
    s = 'denied'
  } else {
    const reg = await registration().catch(() => null)
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
    s = sub && Notification.permission === 'granted' ? 'on' : 'off'
    // Re-save so the server keeps the subscription tied to whoever is signed in on this device.
    if (sub && s === 'on') api.subscribe(sub.toJSON()).catch(() => {})
  }
  pushState.value = s
  return s
}

/** Must run inside a click handler: iOS only shows the permission prompt for a user gesture. */
export async function enablePush() {
  if (!supported()) throw new Error('This browser cannot receive web push here.')
  pushBusy.value = true
  try {
    const keyP = api.publicKey()
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      pushState.value = permission === 'denied' ? 'denied' : 'off'
      throw new Error(permission === 'denied' ? 'Notifications are blocked for this site.' : 'Permission was not granted.')
    }
    const reg = await registration()
    const { public_key } = await keyP
    let sub = await reg.pushManager.getSubscription()
    const key = b64urlToBytes(public_key)
    // A subscription made with an older VAPID key cannot receive our pushes; replace it.
    const cur = sub?.options?.applicationServerKey
    if (sub && cur && !sameBytes(new Uint8Array(cur), key)) { await sub.unsubscribe(); sub = null }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    await api.subscribe(sub.toJSON())
    pushState.value = 'on'
  } finally {
    pushBusy.value = false
  }
}

export async function disablePush() {
  pushBusy.value = true
  try {
    const reg = await registration()
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await api.unsubscribe(sub.endpoint).catch(() => {})
      await sub.unsubscribe()
    }
    pushState.value = 'off'
  } finally {
    pushBusy.value = false
  }
}

export async function currentEndpoint(): Promise<string | undefined> {
  if (!supported()) return undefined
  const reg = await navigator.serviceWorker.getRegistration()
  return (await reg?.pushManager.getSubscription())?.endpoint
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export const PUSH_LABEL: Record<PushState, string> = {
  unsupported: 'Not supported',
  'needs-install': 'Add to Home Screen',
  denied: 'Blocked',
  off: 'Off',
  on: 'On',
}
