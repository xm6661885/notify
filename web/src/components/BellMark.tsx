// Brand mark: a soft pink bell with a little swing. Used on boot, login and empty states.

export function BellMark({ ring = false }: { ring?: boolean }) {
  return (
    <svg class={`bellmark ${ring ? 'ring' : ''}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle class="bm-halo" cx="32" cy="32" r="30" />
      <g class="bm-bell">
        <path class="bm-body" d="M32 12c-8.3 0-14 6.4-14 14.6v8.6c0 2.4-1.2 4.6-3.2 6L13.5 42c-1 .7-.5 2.3.7 2.3h35.6c1.2 0 1.7-1.6.7-2.3l-1.3-.8c-2-1.4-3.2-3.6-3.2-6v-8.6C46 18.4 40.3 12 32 12Z" />
        <path class="bm-shine" d="M24.5 24.5c.6-3.6 3.2-6.4 6.6-7.2" />
        <circle class="bm-clapper" cx="32" cy="49.5" r="4.2" />
        <circle class="bm-top" cx="32" cy="10.5" r="2.6" />
      </g>
    </svg>
  )
}
