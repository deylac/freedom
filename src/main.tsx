import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { registerServiceWorker } from './lib/sw-status'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Service worker : coquille applicative en cache pour relancer la PWA même si le domaine
// est bloqué ensuite. Désactivé en développement et pendant les tests de bout en bout.
window.addEventListener('load', () => registerServiceWorker(import.meta.env.PROD && import.meta.env.MODE !== 'e2e'))
