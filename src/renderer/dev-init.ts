import { readDevHooks } from './boot-params'

// ES imports are hoisted above statements, so setting window.limnDev directly in
// main.tsx would run AFTER `import App from './App'` (which transitively imports
// ./dev, which reads window.limnDev at module-evaluation time). This module has no
// other imports, so importing it first in main.tsx guarantees the assignment below
// runs before any other renderer module evaluates.
// The server injects <meta name="limn-dev" content="1"> into index.html only when it
// was started with LIMN_DEV_HOOKS=1 (see serveStatic in src/server/http.ts), so a
// production service ignores `?dev=` entirely.
window.limnDev = readDevHooks(window.location.search, document.querySelector('meta[name="limn-dev"]') != null)
