// Non-Pack runtime entry for the Zaohua platform SDK.
// Game Builder compiles this module during a production build and awaits
// initialize() before dynamically importing the engine bundle. Never move this
// call into a *.pack.ts (Pack apply runs after app.start()) or a custom HTML
// entry (HTML entries are not compiled).
//
// Publishing adaptation (PC): declare ONLY capabilities actually implemented
// here. The Builder validation plan selects its checks from this list, so an
// unimplemented capability would create a check that can never pass.
// `user.current` + `storage` back the platform identity / one-key KV save;
// initialize() runs their connectivity checks before the engine is imported.
import { initialize, game, lifecycle, user, storage } from 'zaohua-platform-sdk'

await initialize({
  capabilities: ['game.loading', 'game.lifecycle', 'user.current', 'storage'],
})

// The engine bundle is imported only after this module resolves, so this is
// still before the real loading work.
game.loading({ phase: 'engine-boot' })

// The main-window shell owns the BroadcastChannel to the Engine Worker, so the
// adapter lives in meta-ui/shell-bridge.js: a pause must really stop the arena,
// not just flip a flag. The fallback keeps the handshake valid if a build ever
// strips the injected shell. Keep it registered for the whole playable life.
const shellAdapter = globalThis.MetaShell?.platformAdapter
let fallbackPaused = false
const fallbackAdapter = {
  pause: () => { fallbackPaused = true },
  resume: () => { fallbackPaused = false },
  getState: () => ({ paused: fallbackPaused }),
}
lifecycle.register(shellAdapter ?? fallbackAdapter)

// `game.loaded()` marks the real playable boundary: the Engine Worker has
// booted and the single-page shell is interactive. The Worker broadcasts
// `ready` as soon as its channel exists; this module runs BEFORE the engine
// bundle is imported, so the listener is in place in time.
let loadedSent = false
if (typeof BroadcastChannel !== 'undefined') {
  const channel = new BroadcastChannel('forgeax-arena-run')
  channel.onmessage = (event) => {
    if (loadedSent) return
    const msg = event.data
    if (!msg || typeof msg !== 'object' || msg.type !== 'ready') return
    loadedSent = true
    game.loaded()
    channel.close()
  }
}

// Platform identity + KV save. The injected classic shell scripts run BEFORE
// this deferred module, so MetaAccount / MetaShell.mountPlatformStore already
// exist. initialize() above has already run the user.current and storage
// connectivity checks; here we resolve the real user and the saved blob once,
// then hand both down so the shell never has to await a Promise.
const SAVE_KEY = globalThis.MetaAccount?.SAVE_KEY ?? 'forgeax.save.v1'
const profile = await user.getCurrent()
const initial = await storage.get(SAVE_KEY)
const mountPlatformStore = globalThis.MetaShell?.mountPlatformStore
if (typeof mountPlatformStore === 'function') {
  mountPlatformStore({
    userId: profile.id,
    displayName: profile.name,
    initial,
    read: () => storage.get(SAVE_KEY),
    write: (envelope) => storage.set(SAVE_KEY, envelope),
  })
}
