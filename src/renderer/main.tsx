import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/wf.css'
import './styles/review.css'
import './styles/document.css'
import './styles/app.css'
import './styles/repo.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
