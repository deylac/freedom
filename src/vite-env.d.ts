/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_RELAYS?: string
  readonly VITE_BLOSSOM_SERVERS?: string
  readonly VITE_MODERATORS?: string
  readonly VITE_FEATURED_TAGS?: string
  readonly VITE_REPORT_THRESHOLD?: string
}
