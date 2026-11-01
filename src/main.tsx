import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Service worker : coquille applicative en cache pour relancer la PWA même si le domaine
// est bloqué ensuite. Désactivé en développement et pendant les tests de bout en bout.
if (import.meta.env.PROD && import.meta.env.MODE !== 'e2e' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      /* contexte non sécurisé ou passerelle qui refuse les SW : l'application reste utilisable */
    })
  })
}
