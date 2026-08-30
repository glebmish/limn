import { readDevHooks } from './boot-params'

// ES imports are hoisted above statements, so setting window.limnDev directly in
// main.tsx would run AFTER `import App from './App'` (which transitively imports
// ./dev, which reads window.limnDev at module-evaluation time). This module has no
// other imports, so importing it first in main.tsx guarantees the assignment below
// runs before any other renderer module evaluates.
window.limnDev = readDevHooks(window.location.search)
