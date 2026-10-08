// Shapes returned by the backend. docs/backend-spec.md section 7 is the contract.

export type View = 'inbox' | 'archived' | 'history'

export interface FileInfo {
  name: string
  size: number
  mime: string
  is_image: boolean
  url: string
  download_url: string
}

export interface Note {
  /** Only on the detail endpoint: my custom actions with placeholders filled in. */
  actions?: NoteAction[]
  id: number
  created_at: string
  type: 'message' | 'photo' | 'document'
  text: string | null
  markdown: boolean
  topics: string[]
  file: FileInfo | null
  read: boolean
  archived: boolean
  read_at: string | null
  archived_at: string | null
  truncated: boolean
}

export interface Page {
  items: Note[]
  next_before: number | null
  /** Only set when the request used `page`. */
  total: number | null
  unread: number
}

export interface TopicCount { topic: string; key: string; count: number; unread: number }

export interface UserSettings {
  topics_mode: 'all' | 'only'
  topics: string[]
  blacklist: string[]
  admin_blacklist: string[]
  /** Topics pinned to the home filter row, in order. Empty shows every topic. */
  feed_topics: string[]
  /** Custom buttons on the notification page. url may hold {{placeholders}}. */
  actions: NoteAction[]
}

export interface NoteAction { name: string; url: string }

export interface Me {
  user: { id: number; username: string; is_admin: boolean }
  settings: UserSettings
  unread: number
}

export interface Device {
  id: number
  user_agent: string | null
  created_at: string
  last_ok_at: string | null
  last_error: string | null
  fail_count: number
  endpoint_host: string
  service: PushService
}

export type PushService = 'google' | 'apple' | 'mozilla' | 'microsoft' | 'other'

export interface Webhook {
  id: number
  user_id: number
  name: string
  enabled: boolean
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers: Record<string, string>
  body_kind: 'json' | 'text'
  body: string
  topics: string[]
  use_proxy: boolean
  created_at: string
  last_ok_at: string | null
  last_error: string | null
  fail_count: number
}

export type WebhookIn = Pick<Webhook, 'name' | 'enabled' | 'url' | 'method' | 'headers' | 'body_kind' | 'body' | 'topics' | 'use_proxy'>

export type JobStatus = 'pending' | 'failed' | 'sent'
export type JobKind = 'push' | 'webhook'

export interface DeliveryItem {
  kind: JobKind
  id: number
  status: JobStatus
  attempts: number
  error: string | null
  created_at: string
  sent_at: string | null
  notification: { id: number; type: string; preview: string } | null
  user: { id: number; username: string } | null
  target: string
}

export interface QueueCounts { pending: number; failed_24h: number; sent_24h: number }

export interface DeliveryPage {
  items: DeliveryItem[]
  next_before: string | null
  counts: { push: QueueCounts; webhook: QueueCounts }
}

export interface AdminUser {
  id: number
  username: string
  is_admin: boolean
  disabled: boolean
  created_at: string
  settings: UserSettings
  subscriptions: number
  webhooks: number
  delivered: number
  unread: number
}

export interface Route_ { topic: string; key: string; user_ids: number[]; users: string[] }

export interface SiteSettings {
  registration_open: boolean
  invite_only: boolean
  invite_code: string
  push_interval_sec: number
  proxy_url: string
  push_proxy: Record<PushService, boolean>
  push: QueueCounts & { interval: number }
  webhook: QueueCounts
  vapid_public_key: string
}
