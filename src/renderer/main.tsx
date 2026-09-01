import './dev-init'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installApiClient } from './api-client'
import { installRouter } from './router'
import { useStore } from './store'
import './styles/wf.css'
import './styles/review.css'
import './styles/document.css'
import './styles/app.css'
import './styles/repo.css'

installApiClient()
// module scope, not an effect: StrictMode double-invokes effects and would install
// a second store subscription + popstate listener.
installRouter(useStore, window)
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
