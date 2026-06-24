import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/wf.css'
import './styles/review.css'
import './styles/document.css'
import './styles/app.css'
import './styles/repo.css'

function render(): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

// In Electron the preload has already set window.api. Served over the web there is
// no preload, so install the HTTP/SSE-backed client (same RendererApi) before render.
// (window.api is declared non-optional for call sites; at boot on the web it isn't
// set yet, hence the runtime check.)
if ((window as { api?: unknown }).api) {
  render()
} else {
  void import('./web-api').then(({ installWebApi }) => { installWebApi(); render() })
}
