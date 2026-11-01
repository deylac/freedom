/**
 * État du service worker, rendu visible (audit F05 : une erreur d'installation était avalée et
 * le mode hors ligne promis ne fonctionnait pas, sans que personne ne le voie).
 */
export type ServiceWorkerState =
  | { status: 'actif' }
  | { status: 'installation' }
  | { status: 'désactivé'; reason: string }
  | { status: 'échec'; reason: string }

let state: ServiceWorkerState = { status: 'désactivé', reason: 'pas encore démarré' }

export const serviceWorkerState = (): ServiceWorkerState => state

export function registerServiceWorker(enabled: boolean): void {
  if (!enabled) {
    state = { status: 'désactivé', reason: 'mode développement ou test' }
    return
  }
  if (!('serviceWorker' in navigator)) {
    state = { status: 'désactivé', reason: 'navigateur ou contexte non sécurisé' }
    return
  }
  state = { status: 'installation' }
  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      state = { status: 'actif' }
    })
    .catch((err: unknown) => {
      // Passerelle qui refuse les SW, navigation privée… : l'application reste utilisable en ligne.
      state = { status: 'échec', reason: err instanceof Error ? err.message : String(err) }
      console.warn('[HashWall] service worker indisponible :', state.reason)
    })
}
