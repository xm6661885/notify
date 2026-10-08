// Step-by-step help for turning on web push on each platform. Opens on the tab for this device.

import { useState } from 'preact/hooks'
import { back, navigate } from '../lib/router'
import { enablePush, pushBusy, pushState } from '../lib/push'
import { toast, toastError } from '../lib/store'
import { platform, standalone } from '../lib/util'
import { BackButton, Segmented, TopBar, useScrolled } from '../components/ui'
import { IconMore, IconPlusSquare, IconShare } from '../components/icons'

type Tab = 'ios' | 'android' | 'mac' | 'desktop'

interface Step { title: string; body: preact.ComponentChildren }

const inline = (Icon: (p: any) => preact.JSX.Element) => <span class="inline-ic"><Icon /></span>

const STEPS: Record<Tab, { intro: string; steps: Step[]; note?: string }> = {
  ios: {
    intro: 'iPhone and iPad can receive web push from iOS 16.4 on, but only from an app added to the Home Screen.',
    steps: [
      { title: 'Open this site in Safari', body: <>Other browsers on iOS can add to the Home Screen too since iOS 16.4, but Safari is the most reliable.</> },
      { title: <>Tap Share {inline(IconShare)}</> as any, body: <>It is in the toolbar at the bottom (or top right on iPad).</> },
      { title: <>Choose Add to Home Screen {inline(IconPlusSquare)}</> as any, body: <>Scroll the share sheet down if you do not see it. Keep the name Notify and tap Add.</> },
      { title: 'Open Notify from the Home Screen icon', body: <>Push only works inside the installed app, not in the Safari tab. Sign in again there if asked.</> },
      { title: 'Turn on Web push', body: <>Go to Settings and turn on Web push, then tap Allow. A test notification arrives in a few seconds.</> },
    ],
    note: 'If you tapped Don\'t Allow, open the iOS Settings app, then Notifications, then Notify, and turn on Allow Notifications. Focus modes can also hide notifications.',
  },
  android: {
    intro: 'Chrome, Edge, Firefox and Samsung Internet on Android support web push directly in the browser.',
    steps: [
      { title: 'Open this site in Chrome', body: <>Sign in with your account.</> },
      { title: 'Optional: install the app', body: <>Tap the menu {inline(IconMore)} and choose Add to Home screen or Install app. It opens full screen like a native app.</> },
      { title: 'Turn on Web push', body: <>Go to Settings and turn on Web push, then tap Allow.</> },
    ],
    note: 'If notifications stop arriving, check that the browser is allowed to send notifications in Android settings and is not restricted by battery optimisation.',
  },
  mac: {
    intro: 'Safari 16 and later on macOS 13 and later, Chrome, Edge and Firefox all support web push.',
    steps: [
      { title: 'Open this site and sign in', body: <>In Safari you can also choose File, then Add to Dock, to get a separate app window.</> },
      { title: 'Turn on Web push', body: <>Go to Settings and turn on Web push, then click Allow in the browser prompt.</> },
      { title: 'Allow banners in macOS', body: <>Open System Settings, then Notifications, pick your browser (or the Notify app from the Dock) and allow notifications.</> },
    ],
    note: 'Chrome and Edge only deliver pushes while the browser is running (it can be in the background with no windows open). Safari and Dock apps receive them even when closed.',
  },
  desktop: {
    intro: 'Chrome, Edge and Firefox on Windows and Linux support web push.',
    steps: [
      { title: 'Open this site and sign in', body: <>Optional: click the install icon in the address bar to install Notify as an app.</> },
      { title: 'Turn on Web push', body: <>Go to Settings and turn on Web push, then click Allow.</> },
      { title: 'Check system notifications', body: <>On Windows, open Settings, then System, then Notifications and make sure your browser is allowed. Turn off Do not disturb.</> },
    ],
    note: 'The browser has to be running in the background to receive pushes. In Chrome, enable Continue running background apps when Google Chrome is closed.',
  },
}

export function Guide() {
  const { scrolled, onScroll } = useScrolled()
  const [tab, setTab] = useState<Tab>(platform())
  const g = STEPS[tab]
  const here = platform() === tab
  const ps = pushState.value
  const canEnable = here && (ps === 'off')

  const enable = async () => {
    try { await enablePush(); toast('Push is on for this device') } catch (e) { toastError(e) }
  }

  return (
    <div class="page">
      <TopBar scrolled={scrolled} left={<BackButton onClick={() => back()} />}>
        {scrolled && <span class="fade-in">Get notifications</span>}
      </TopBar>
      <div class="page-scroll" onScroll={onScroll}>
        <div class="container guide">
          <h1 class="large-title rise">Get notifications</h1>
          <p class="subtitle rise" style={{ '--i': 1 }}>Each device subscribes on its own. Repeat these steps on every device you want notified.</p>

          <div class="rise" style={{ '--i': 2 }}>
            <Segmented value={tab} onChange={setTab} options={[
              { value: 'ios', label: 'iPhone / iPad' },
              { value: 'android', label: 'Android' },
              { value: 'mac', label: 'Mac' },
              { value: 'desktop', label: 'Windows / Linux' },
            ]} />
          </div>

          <div class="guide-body" key={tab}>
            <p class="guide-intro fade-in">{g.intro}</p>
            {here && (
              <div class={`guide-status fade-in ${ps || ''}`}>
                {ps === 'on' ? 'This device is already subscribed.'
                  : ps === 'needs-install' ? (standalone() ? 'Push is not available in this app yet.' : 'You are in a browser tab. Follow the steps to add Notify to the Home Screen.')
                  : ps === 'denied' ? 'Notifications are blocked for this site on this device. See the note below.'
                  : ps === 'unsupported' ? 'This browser cannot receive web push here.'
                  : 'This device is ready. Turn on push below or in Settings.'}
              </div>
            )}
            <ol class="steps">
              {g.steps.map((s, i) => (
                <li key={i} class="step rise" style={{ '--i': i + 1 }}>
                  <span class="step-n">{i + 1}</span>
                  <div class="step-text">
                    <div class="step-title">{s.title}</div>
                    <div class="step-body">{s.body}</div>
                  </div>
                </li>
              ))}
            </ol>
            {g.note && <p class="guide-note fade-in">{g.note}</p>}
            <div class="guide-actions">
              {canEnable && (
                <button class="btn primary" onClick={enable} disabled={pushBusy.value}>
                  {pushBusy.value ? <span class="spinner" /> : 'Turn on push now'}
                </button>
              )}
              <button class="btn" onClick={() => navigate({ name: 'settings' }, { replace: true })}>Open Settings</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
