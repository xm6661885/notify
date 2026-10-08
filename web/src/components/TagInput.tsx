// Editable list of short strings shown as removable chips (topics, blacklist keywords).

import { useState } from 'preact/hooks'
import { IconBack, IconChevron, IconClose, IconPlus } from './icons'

export function TagInput({ value, onChange, placeholder, prefix = '', suggestions = [], disabled, sortable }: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  prefix?: string
  suggestions?: string[]
  disabled?: boolean
  /** Show move-earlier / move-later buttons on each chip. */
  sortable?: boolean
}) {
  const [draft, setDraft] = useState('')

  const add = (raw: string) => {
    // Comma, newline or Chinese comma separated input adds several at once.
    const parts = raw.split(/[,，\n]/).map((s) => s.trim()).map((s) => (prefix ? s.replace(/^#+/, '') : s)).filter(Boolean)
    if (!parts.length) return
    const have = new Set(value.map((v) => v.toLowerCase()))
    const next = [...value]
    for (const p of parts) if (!have.has(p.toLowerCase())) { next.push(p); have.add(p.toLowerCase()) }
    onChange(next)
    setDraft('')
  }

  const move = (i: number, d: number) => {
    const next = [...value]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    onChange(next)
  }

  const free = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase())).slice(0, 12)

  return (
    <div class={`tags ${disabled ? 'disabled' : ''} ${sortable ? 'sortable' : ''}`}>
      {value.length > 0 && (
        <div class="tags-list">
          {value.map((t, i) => (
            <span key={t} class="chip removable">
              {sortable && !disabled && (
                <button type="button" class="tag-move" aria-label={`Move ${t} earlier`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <IconBack width={14} height={14} />
                </button>
              )}
              <span class="tag-text">{prefix}{t}</span>
              {sortable && !disabled && (
                <button type="button" class="tag-move" aria-label={`Move ${t} later`} disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                  <IconChevron width={14} height={14} />
                </button>
              )}
              {!disabled && (
                <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
                  <IconClose width={14} height={14} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <form class="tags-add" onSubmit={(e) => { e.preventDefault(); add(draft) }}>
          <input class="input" value={draft} placeholder={placeholder} enterKeyHint="done" autocapitalize="none"
            autocorrect="off" spellcheck={false}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onBlur={() => { if (draft.trim()) add(draft) }} />
          <button type="submit" class="icon-btn accent" aria-label="Add" disabled={!draft.trim()}><IconPlus /></button>
        </form>
      )}
      {!disabled && free.length > 0 && (
        <div class="tags-suggest">
          {free.map((s) => (
            <button type="button" key={s} class="chip dashed" onClick={() => add(s)}>{prefix}{s}</button>
          ))}
        </div>
      )}
    </div>
  )
}
