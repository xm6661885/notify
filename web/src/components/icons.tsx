// Inline SVG icon set (stroke icons, 24x24). No emoji anywhere in the UI.

import type { JSX } from 'preact'

type P = JSX.SVGAttributes<SVGSVGElement>

function I(paths: JSX.Element, props: P) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true" {...props}>
      {paths}
    </svg>
  )
}

export const IconBack = (p: P) => I(<path d="m15 18-6-6 6-6" />, p)

export const IconChevron = (p: P) => I(<path d="m9 18 6-6-6-6" />, p)

export const IconChevronDown = (p: P) => I(<path d="m6 9 6 6 6-6" />, p)

export const IconPlus = (p: P) => I(<path d="M12 5v14M5 12h14" />, p)

export const IconClose = (p: P) => I(<path d="M18 6 6 18M6 6l12 12" />, p)

export const IconCheck = (p: P) => I(<path d="M20 6 9 17l-5-5" />, p)

export const IconImage = (p: P) =>
  I(<><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" /></>, p)

export const IconFile = (p: P) =>
  I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>, p)

export const IconSettings = (p: P) =>
  I(<><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></>, p)

export const IconMore = (p: P) =>
  I(<><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>, p)

export const IconTrash = (p: P) =>
  I(<><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>, p)

export const IconEdit = (p: P) =>
  I(<><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>, p)

export const IconImport = (p: P) =>
  I(<><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>, p)

export const IconSearch = (p: P) => I(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>, p)

export const IconGlobe = (p: P) =>
  I(<><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>, p)

export const IconAgents = (p: P) =>
  I(<><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 4.5a3.2 3.2 0 0 1 0 6.2" /><path d="M21 20a6 6 0 0 0-4-5.65" /></>, p)

export const IconShield = (p: P) => I(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />, p)

export const IconQuestion = (p: P) =>
  I(<><circle cx="12" cy="12" r="10" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>, p)

export const IconCopy = (p: P) =>
  I(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>, p)

export const IconLogout = (p: P) =>
  I(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>, p)

export const IconBolt = (p: P) => I(<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />, p)

export const IconLock = (p: P) =>
  I(<><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, p)

export const IconDownload = IconImport
export const IconArchive = (p: P) =>
  I(<><rect x="2.5" y="4" width="19" height="4.5" rx="1.5" /><path d="M4.5 8.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5" /><path d="M10 12.5h4" /></>, p)
export const IconUnarchive = (p: P) =>
  I(<><rect x="2.5" y="4" width="19" height="4.5" rx="1.5" /><path d="M4.5 8.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5" /><path d="m9.5 14.5 2.5-2.5 2.5 2.5" /><path d="M12 12v5" /></>, p)
export const IconBell = (p: P) =>
  I(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>, p)
export const IconBellOff = (p: P) =>
  I(<><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5" /><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="m2 2 20 20" /></>, p)
export const IconHistory = (p: P) =>
  I(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>, p)
export const IconHash = (p: P) => I(<><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" /></>, p)
export const IconCheckAll = (p: P) => I(<><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></>, p)
export const IconDot = (p: P) => I(<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />, p)
export const IconMail = (p: P) =>
  I(<><rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><path d="m3 7 9 6 9-6" /></>, p)
export const IconMailOpen = (p: P) =>
  I(<><path d="M21.5 10v8a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-8l9.5-6.5z" /><path d="m3 10 9 6 9-6" /></>, p)
export const IconSelect = (p: P) =>
  I(<><rect x="3" y="3" width="18" height="18" rx="5" /><path d="m8 12 3 3 5-6" /></>, p)
export const IconUser = (p: P) => I(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>, p)
export const IconShare = (p: P) =>
  I(<><path d="M12 3v12" /><path d="m8 7 4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></>, p)
export const IconPlusSquare = (p: P) =>
  I(<><rect x="3" y="3" width="18" height="18" rx="4" /><path d="M12 8v8M8 12h8" /></>, p)
export const IconPhone = (p: P) => I(<><rect x="6" y="2.5" width="12" height="19" rx="3" /><path d="M11 18.5h2" /></>, p)
export const IconMonitor = (p: P) => I(<><rect x="2.5" y="3.5" width="19" height="13" rx="2.5" /><path d="M8 21h8M12 16.5V21" /></>, p)
export const IconSend = (p: P) => I(<><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></>, p)
export const IconKey = (p: P) =>
  I(<><circle cx="7.5" cy="15.5" r="4.5" /><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2" /></>, p)
export const IconRoute = (p: P) =>
  I(<><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="5" r="2.5" /><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5" /></>, p)
export const IconWebhook = (p: P) =>
  I(<><path d="M9.5 8.5a3.5 3.5 0 1 1 5 3.2L17 16" /><circle cx="17.5" cy="17" r="2.5" /><path d="M5.5 14.5 8 19h6.5" /><circle cx="6" cy="17" r="2.5" /><path d="M12 6.5 8.5 13" /></>, p)
export const IconRefresh = (p: P) =>
  I(<><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 20v-4h-4" /></>, p)
export const IconAlert = (p: P) =>
  I(<><path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>, p)
