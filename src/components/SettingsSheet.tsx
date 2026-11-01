import { useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_BLOSSOM_SERVERS, DEFAULT_RELAYS, QUALITY_PROFILES, SOURCE_URL, type QualityProfile } from '../config'
import { usePersonalVersion, useSettings } from '../hooks/basics'
import { normalizeRelay, normalizeServer } from '../lib/blossom/urls'
import { relativeTime } from '../lib/format'
import { forgetIdentity, getOrCreateIdentity, hasExtension, identityPubkey, newIdentity, nsecOf, npubOf, parsePubkey, shortNpub } from '../lib/nostr/signer'
import { deleteMyClip } from '../lib/publish'
import { persistentStorageAvailable, wipeLocalKeys } from '../lib/storage/local'
import { wipeOutbox } from '../lib/storage/outbox'
import { clearLocalModeration, getLastDiagnostics, getMyClips } from '../lib/storage/personal'
import { DiagnosticList } from './PublishTray'
import { updateSettings } from '../lib/storage/settings'
import { IconTrash } from './icons'
import { Button, copyText, Sheet, Toggle, useToast } from './ui'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  )
}

const lines = (s: string) => s.split(/[\s,]+/).map((l) => l.trim()).filter(Boolean)

export function SettingsSheet({ onClose, onRescue, onImport }: { onClose: () => void; onRescue?: () => void; onImport?: () => void }) {
  const settings = useSettings()
  const toast = useToast()
  usePersonalVersion()
  const [pubkey, setPubkey] = useState(identityPubkey)
  const [showNsec, setShowNsec] = useState(false)
  const [relaysText, setRelaysText] = useState(settings.relays.join('\n'))
  const [serversText, setServersText] = useState(settings.blossomServers.join('\n'))
  const [moderatorsText, setModeratorsText] = useState(settings.moderators.map(npubOf).join('\n'))
  const [deleting, setDeleting] = useState<string | null>(null)
  const myClips = getMyClips()
  const lastDiagnostics = getLastDiagnostics()
  const nsec = useMemo(() => (showNsec ? nsecOf(getOrCreateIdentity()) : ''), [showNsec, pubkey])

  const saveNetwork = () => {
    const relays = [...new Set(lines(relaysText).map(normalizeRelay).filter((r): r is string => !!r))]
    const servers = [...new Set(lines(serversText).map(normalizeServer).filter((s): s is string => !!s))]
    if (relays.length === 0 || servers.length === 0) {
      toast('Il faut au moins un relais (wss://) et un serveur Blossom (https://)', 'error')
      return
    }
    updateSettings({ relays, blossomServers: servers })
    setRelaysText(relays.join('\n'))
    setServersText(servers.join('\n'))
    toast('Réseau enregistré', 'ok')
  }

  const saveModerators = () => {
    const entries = lines(moderatorsText)
    const parsed = entries.map(parsePubkey)
    if (parsed.some((p) => !p)) {
      toast('Clé invalide : utilisez des npub… ou des clés hexadécimales', 'error')
      return
    }
    updateSettings({ moderators: [...new Set(parsed as string[])] })
    toast('Modérateurs enregistrés', 'ok')
  }

  const panic = async () => {
    if (!confirm('Effacer définitivement la clé, la liste de vos vidéos, les envois en attente et les réglages de cet appareil ?')) return
    forgetIdentity()
    wipeLocalKeys()
    await wipeOutbox()
    location.reload()
  }

  return (
    <Sheet title="Réglages" onClose={onClose} wide>
      <div className="space-y-5">
        {!persistentStorageAvailable() && (
          <p className="rounded-xl border border-rec/40 bg-rec/10 p-3 text-sm text-white/90">
            Stockage local désactivé (passerelle IPFS partagée ou navigation privée) : votre clé n’existe que dans cet onglet.
            Préférez une passerelle par sous-domaine (…ipfs.dweb.link) ou le domaine principal.
          </p>
        )}

        <Section title="Identité anonyme">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-white">{settings.useExtension && hasExtension() ? 'Extension NIP-07' : shortNpub(pubkey)}</span>
            <button className="text-xs text-accent" onClick={async () => toast((await copyText(npubOf(pubkey))) ? 'npub copiée' : 'Copie impossible', 'ok')}>
              copier
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                newIdentity()
                setPubkey(identityPubkey())
                setShowNsec(false)
                toast('Nouvelle identité créée : vos prochaines vidéos ne seront pas reliables aux précédentes', 'ok')
              }}
            >
              Nouvelle identité anonyme
            </Button>
            <Button variant="ghost" onClick={() => setShowNsec((s) => !s)}>
              {showNsec ? 'Masquer la clé secrète' : 'Afficher la clé secrète'}
            </Button>
          </div>
          {showNsec && (
            <p className="mt-2 break-all rounded-xl border border-rec/40 bg-night p-3 font-mono text-xs text-rec">
              {nsec}
              <span className="mt-1 block font-sans text-white/70">Ne la partagez jamais : elle permet de publier et supprimer en votre nom.</span>
            </p>
          )}
          <Toggle
            checked={settings.rotateIdentity}
            onChange={(v) => updateSettings({ rotateIdentity: v })}
            label="Nouvelle identité à chaque vidéo"
            hint="Aucune corrélation possible entre vos vidéos. Recommandé si vous êtes exposé·e."
          />
          {hasExtension() && (
            <Toggle
              checked={settings.useExtension}
              onChange={(v) => updateSettings({ useExtension: v })}
              label="Signer avec mon extension Nostr (Alby, nos2x…)"
              hint="Attention : vos vidéos seront rattachées à votre identité Nostr publique."
            />
          )}
        </Section>

        <Section title="Publication">
          <Toggle
            checked={settings.autoPublish}
            onChange={(v) => updateSettings({ autoPublish: v })}
            label="Publication automatique après 3 s d’aperçu"
            hint="Sinon, un bouton « Publier » est requis."
          />
          <fieldset className="mt-2 space-y-1">
            <legend className="mb-1 text-sm text-white">Qualité d’enregistrement</legend>
            {(Object.keys(QUALITY_PROFILES) as QualityProfile[]).map((q) => (
              <label key={q} className="flex items-center gap-2 text-sm text-white/90">
                <input type="radio" name="quality" checked={settings.quality === q} onChange={() => updateSettings({ quality: q })} className="accent-[#00F0FF]" />
                {QUALITY_PROFILES[q].label}
              </label>
            ))}
          </fieldset>
          <Toggle
            checked={settings.keepDeletionKeys}
            onChange={(v) => updateSettings({ keepDeletionKeys: v })}
            label="Garder la possibilité de supprimer mes vidéos"
            hint="Conserve les clés sur cet appareil. Désactivez si le téléphone risque d’être saisi."
          />
        </Section>

        <Section title={`Mes vidéos (${myClips.length})`}>
          {myClips.length === 0 ? (
            <p className="text-sm text-muted">Aucune vidéo publiée depuis cet appareil.</p>
          ) : (
            <ul className="max-h-60 space-y-1.5 overflow-y-auto">
              {myClips.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-3 rounded-lg bg-night/70 px-3 py-2 text-sm">
                  <a href={`#${encodeURIComponent(c.tag)}`} onClick={onClose} className="min-w-0 truncate text-white hover:text-accent">
                    #{c.tag} <span className="text-xs text-muted">{relativeTime(c.publishedAt)} · {c.servers.length} serveur{c.servers.length > 1 ? 's' : ''}</span>
                  </a>
                  <button
                    disabled={!c.sk || deleting === c.key}
                    title={c.sk ? 'Demander la suppression (NIP-09 + serveurs média)' : 'Clé non conservée'}
                    aria-label="Supprimer cette vidéo"
                    className="shrink-0 rounded-lg p-1.5 text-rec disabled:opacity-30"
                    onClick={async () => {
                      if (!confirm('Demander la suppression de cette vidéo sur les relais et serveurs ? Les copies déjà téléchargées ailleurs ne peuvent pas être effacées.')) return
                      setDeleting(c.key)
                      try {
                        const r = await deleteMyClip(c)
                        toast(`Suppression demandée : ${r.relays} relais, ${r.servers} fichiers supprimés`, 'ok')
                      } catch (err) {
                        toast(err instanceof Error ? err.message : String(err), 'error')
                      } finally {
                        setDeleting(null)
                      }
                    }}
                  >
                    <IconTrash size={18} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Résilience">
          <Toggle
            checked={settings.autoPreserve}
            onChange={(v) => updateSettings({ autoPreserve: v })}
            label="Préserver les vidéos que je regarde"
            hint="Après 5 s de visionnage, demande à d’autres serveurs de copier la vidéo (de serveur à serveur : rien ne passe par votre forfait). Plus une vidéo est vue, plus elle est difficile à supprimer. Signé par une clé jetable."
          />
          {onRescue && (
            <Button variant="ghost" className="mt-3" onClick={onRescue}>
              Adresses de secours (si ce site est bloqué)
            </Button>
          )}
          {onImport && (
            <Button variant="ghost" className="mt-2" onClick={onImport}>
              Publier une vidéo reçue (paquet hors ligne)
            </Button>
          )}
        </Section>

        <Section title="Réseau">
          <label className="block text-sm text-white">
            Relais Nostr (un par ligne)
            <textarea value={relaysText} onChange={(e) => setRelaysText(e.target.value)} rows={4} spellCheck={false} className="mt-1 w-full rounded-xl border border-line bg-night p-2 font-mono text-xs text-white focus:border-accent focus:outline-none" />
          </label>
          <label className="mt-3 block text-sm text-white">
            Serveurs Blossom, par ordre de préférence
            <textarea value={serversText} onChange={(e) => setServersText(e.target.value)} rows={4} spellCheck={false} className="mt-1 w-full rounded-xl border border-line bg-night p-2 font-mono text-xs text-white focus:border-accent focus:outline-none" />
          </label>
          <div className="mt-2 flex gap-2">
            <Button onClick={saveNetwork}>Enregistrer</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRelaysText(DEFAULT_RELAYS.join('\n'))
                setServersText(DEFAULT_BLOSSOM_SERVERS.join('\n'))
              }}
            >
              Valeurs par défaut
            </Button>
          </div>
        </Section>

        <Section title="Diagnostic du dernier envoi">
          {lastDiagnostics ? (
            <>
              <p className="mb-2 text-xs text-muted">
                #{lastDiagnostics.tag} · {relativeTime(Math.floor(lastDiagnostics.at / 1000))}
              </p>
              <DiagnosticList items={lastDiagnostics.items} />
            </>
          ) : (
            <p className="text-sm text-muted">Aucun envoi terminé sur cet appareil.</p>
          )}
        </Section>

        <Section title="Modération">
          <label className="flex items-center justify-between gap-4 text-sm text-white">
            Flouter après N signalements (clés distinctes)
            <input
              type="number"
              min={1}
              max={20}
              value={settings.reportThreshold}
              onChange={(e) => updateSettings({ reportThreshold: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
              className="w-20 rounded-lg border border-line bg-night px-2 py-1.5 text-white"
            />
          </label>
          <label className="mt-3 block text-sm text-white">
            Collectifs de modération de confiance (npub, un par ligne)
            <span className="block text-xs text-muted">Leurs listes de masquage (kind 10000) sont appliquées et un seul de leurs signalements suffit à flouter.</span>
            <textarea value={moderatorsText} onChange={(e) => setModeratorsText(e.target.value)} rows={3} spellCheck={false} className="mt-1 w-full rounded-xl border border-line bg-night p-2 font-mono text-xs text-white focus:border-accent focus:outline-none" />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={saveModerators}>
              Enregistrer les modérateurs
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                clearLocalModeration()
                toast('Vidéos et auteurs masqués réaffichés', 'ok')
              }}
            >
              Réafficher ce que j’ai masqué
            </Button>
          </div>
        </Section>

        <Section title="Données de cet appareil">
          <Button variant="danger" onClick={panic}>
            Tout effacer maintenant
          </Button>
          <p className="mt-2 text-xs text-muted">Clé secrète, liste de vos vidéos, envois en attente et réglages. Irréversible.</p>
        </Section>

        <p className="text-xs text-muted">
          HashWall {__APP_VERSION__} ·{' '}
          <a href={SOURCE_URL} target="_blank" rel="noreferrer noopener" className="text-accent">
            code source
          </a>
        </p>
      </div>
    </Sheet>
  )
}
