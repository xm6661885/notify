// Notification text -> sanitized HTML. Markdown when the sender used --markdown, otherwise
// plain text with links and #topics made tappable. Highlighting is synchronous (common languages).

import { Marked, type TokenizerAndRendererExtension } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'

// Same rule as server/routing.py TOPIC_RE: '#' not preceded by a word char, '/', '&' or '#'.
const TOPIC_RE = /(?<![\p{L}\p{N}_/&#])#([\p{L}\p{N}_][\p{L}\p{N}_-]{0,63})/gu

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

const topicHtml = (t: string) => {
  const name = t.replace(/-+$/, '')
  return `<a class="topic-link" href="/?topic=${encodeURIComponent(name)}" data-topic="${escapeHtml(name)}">#${escapeHtml(name)}</a>`
}

const topicExt: TokenizerAndRendererExtension = {
  name: 'topic',
  level: 'inline',
  start(src) {
    TOPIC_RE.lastIndex = 0
    const m = TOPIC_RE.exec(src)
    return m ? m.index : undefined
  },
  tokenizer(src) {
    const m = /^#([\p{L}\p{N}_][\p{L}\p{N}_-]{0,63})/u.exec(src)
    if (m) return { type: 'topic', raw: m[0], text: m[1] }
  },
  renderer(t) { return topicHtml(t.text) },
}

const marked = new Marked({ gfm: true, breaks: true })
marked.use({
  extensions: [topicExt],
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0]
      let html: string
      try {
        html = language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : text.length < 20000 ? hljs.highlightAuto(text).value : escapeHtml(text)
      } catch {
        html = escapeHtml(text)
      }
      return `<div class="codeblock"><div class="codeblock-head"><span>${escapeHtml(language || 'code')}</span>`
        + `<button type="button" class="copy-code" data-copy>Copy</button></div>`
        + `<pre><code class="hljs">${html}</code></pre></div>`
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens)
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
    image({ href, title, text }) {
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t} loading="lazy" data-view>`
    },
  },
})

const PURIFY = { ADD_ATTR: ['target', 'data-copy', 'data-view', 'data-topic'] }

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}，。；：！？）】」]/g

function renderPlain(text: string) {
  // Escape first, then linkify URLs, then topics outside of the inserted links.
  const parts: string[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    parts.push(topicsIn(escapeHtml(text.slice(last, m.index))))
    const u = m[0]
    parts.push(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`)
    last = m.index! + u.length
  }
  parts.push(topicsIn(escapeHtml(text.slice(last))))
  return `<div class="plain">${parts.join('')}</div>`
}

function topicsIn(escaped: string) {
  // Escaping only adds '&...;' entities; the '&' lookbehind keeps '&#39;' from becoming a topic.
  return escaped.replace(TOPIC_RE, (_, t: string) => topicHtml(t))
}

const cache = new Map<string, string>()

export function renderText(text: string, markdown: boolean): string {
  const key = `${markdown ? 1 : 0}\u0000${text}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const raw = markdown ? (marked.parse(text, { async: false }) as string) : renderPlain(text)
  const html = DOMPurify.sanitize(raw, PURIFY)
  if (cache.size > 200) cache.clear()
  cache.set(key, html)
  return html
}
