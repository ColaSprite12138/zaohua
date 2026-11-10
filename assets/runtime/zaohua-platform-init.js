// Non-Pack runtime entry for the Zaohua platform SDK.
// Game Builder compiles this module during a production build and awaits
// initialize() before dynamically importing the engine bundle. Never move this
// call into a *.pack.ts (Pack apply runs after app.start()) or a custom HTML
// entry (HTML entries are not compiled).
import { initialize } from 'zaohua-platform-sdk'

await initialize({
  capabilities: [],
})
