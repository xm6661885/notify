// REST helpers. All requests send the session cookie; a 401 flips the app to the login screen.

import { me, netReads, netWrites } from './store'
import type {
  AdminUser, DeliveryPage, Device, JobKind, JobStatus, Me, Note, Page, Route_, SiteSettings, TopicCount, UserSettings, View, Webhook, WebhookIn,
} from './types'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const counter = method === 'GET' ? netReads : netWrites
  counter.value++
  try {
    return await send<T>(method, path, body)
  } finally {
    counter.value--
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'Network error. Check your connection.')
  }
  if (res.status === 401 && path !== '/api/login' && path !== '/api/me/password') me.value = false
  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') msg = data.detail
      else if (Array.isArray(data.detail)) msg = data.detail.map((d: any) => d.msg).join('; ')
    } catch { /* not json */ }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

const get = <T>(p: string) => request<T>('GET', p)
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {})
const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b)
const put = <T>(p: string, b: unknown) => request<T>('PUT', p, b)
const del = <T>(p: string, b?: unknown) => request<T>('DELETE', p, b)

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export interface ListQuery { view: View; q?: string; topic?: string; before?: number | null; limit?: number; page?: number; unread?: boolean }

export const api = {
  publicConfig: () => get<{ registration_open: boolean; invite_only: boolean }>('/api/public/config'),
  login: (username: string, password: string) => post<Me>('/api/login', { username, password }),
  register: (username: string, password: string, invite_code?: string) =>
    post<Me>('/api/register', { username, password, invite_code }),
  logout: () => post<{ ok: boolean }>('/api/logout'),
  me: () => get<Me>('/api/me'),
  changePassword: (current_password: string, new_password: string) =>
    post<{ ok: boolean }>('/api/me/password', { current_password, new_password }),
  saveSettings: (s: Partial<Pick<UserSettings, 'topics_mode' | 'topics' | 'blacklist' | 'feed_topics' | 'actions'>>) => put<Me>('/api/me/settings', s),

  list: (q: ListQuery) => get<Page>(`/api/notifications${qs({ view: q.view, q: q.q, topic: q.topic, before: q.before, limit: q.limit, page: q.page, unread: q.unread ? 1 : undefined })}`),
  note: (id: number) => get<Note>(`/api/notifications/${id}`),
  setState: (ids: number[], s: { read?: boolean; archived?: boolean }) =>
    post<{ updated: number; unread: number }>('/api/notifications/state', { ids, ...s }),
  readAll: (view: View = 'inbox', topic?: string) =>
    post<{ updated: number; unread: number }>('/api/notifications/read-all', { view, topic: topic || undefined }),
  topics: (view: View) => get<{ topics: TopicCount[] }>(`/api/topics${qs({ view })}`),

  publicKey: () => get<{ public_key: string }>('/api/push/public-key'),
  subscribe: (sub: PushSubscriptionJSON) => post<{ ok: boolean; id: number }>('/api/push/subscriptions', sub),
  unsubscribe: (endpoint: string) => del<{ ok: boolean }>('/api/push/subscriptions', { endpoint }),
  devices: () => get<{ items: Device[] }>('/api/push/subscriptions'),
  testPush: (endpoint?: string) => post<{ queued: number; position: number }>('/api/push/test', { endpoint }),

  users: () => get<{ items: AdminUser[] }>('/api/admin/users'),
  createUser: (username: string, password: string, is_admin = false) =>
    post<AdminUser>('/api/admin/users', { username, password, is_admin }),
  updateUser: (id: number, p: Partial<{ is_admin: boolean; disabled: boolean; password: string; settings: Partial<UserSettings> }>) =>
    patch<AdminUser>(`/api/admin/users/${id}`, p),
  deleteUser: (id: number) => del<{ ok: boolean }>(`/api/admin/users/${id}`),
  routes: () => get<{ items: Route_[] }>('/api/admin/routes'),
  saveRoute: (topic: string, user_ids: number[]) => put<Route_>('/api/admin/routes', { topic, user_ids }),
  deleteRoute: (key: string) => del<{ ok: boolean }>(`/api/admin/routes/${encodeURIComponent(key)}`),
  siteSettings: () => get<SiteSettings>('/api/admin/settings'),
  saveSiteSettings: (p: Partial<Omit<SiteSettings, 'push' | 'webhook' | 'vapid_public_key'>>) => patch<SiteSettings>('/api/admin/settings', p),
  knownTopics: () => get<{ topics: string[] }>('/api/admin/known-topics'),

  webhooks: (uid: number) => get<{ items: Webhook[] }>(`/api/users/${uid}/webhooks`),
  createWebhook: (uid: number, w: WebhookIn) => post<Webhook>(`/api/users/${uid}/webhooks`, w),
  updateWebhook: (uid: number, id: number, w: Partial<WebhookIn>) => patch<Webhook>(`/api/users/${uid}/webhooks/${id}`, w),
  deleteWebhook: (uid: number, id: number) => del<{ ok: boolean }>(`/api/users/${uid}/webhooks/${id}`),
  testWebhook: (uid: number, id: number) =>
    post<{ ok: boolean; status: number | null; error: string | null }>(`/api/users/${uid}/webhooks/${id}/test`),

  delivery: (q: { status: JobStatus | 'all'; kind: JobKind | 'all'; before?: string | null; limit?: number }) =>
    get<DeliveryPage>(`/api/admin/delivery${qs({ status: q.status, kind: q.kind, before: q.before, limit: q.limit })}`),
  retryJob: (kind: JobKind, id: number) => post<{ ok: boolean }>('/api/admin/delivery/retry', { kind, id }),
  retryAll: (kind: JobKind | 'all') => post<{ retried: number }>('/api/admin/delivery/retry-all', { kind }),
  clearFailed: (kind: JobKind | 'all') => del<{ deleted: number }>('/api/admin/delivery/failed', { kind }),
}
