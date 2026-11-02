# HashWall — consignes pour Claude Code

Mur vidéo citoyen de 60 s : PWA 100 % client (React 19 + TypeScript + Vite 8 + Tailwind 4),
index Nostr (NIP-71, kind 34236), stockage Blossom. Lire d'abord :
- `docs/FEUILLE-DE-ROUTE.md` — prochaines tâches, **choix de conception déjà tranchés**, critères d'acceptation ;
- `docs/ANGLES-MORTS.md` — risques connus, ce qui a été vérifié en conditions réelles ;
- `docs/RESILIENCE.md` — anti-censure : ce qui est livré (R1–R4) et ce qui reste (R5 multi-origines, R6 P2P).

## Langue
Interface, documentation, messages de commit et commentaires : **français**. Identifiants de code en anglais.

## Commandes
```bash
npm run typecheck      # tsc --noEmit
npm test               # Vitest (src/**/*.test.ts) — ~155 tests, < 5 s
npm run build          # dist/ (CSP injectée, sw.js généré)
npm run e2e            # build e2e + Playwright : relais et 7 serveurs Blossom simulés (~5 min)
E2E_FULL=1 npm run e2e # même chose avec la vraie limite de 60 s
E2E_ONLY="Visages" node e2e/run.mjs  # un seul scénario indépendant (après npm run build:e2e)
```
Avant tout push : `typecheck`, `test`, `e2e` verts.

## Environnement cloud (session Claude Code web/mobile)
- Le réseau sortant du conteneur **bloque** les relais Nostr, les serveurs Blossom et `*.github.io`.
  Ne pas réessayer ni contourner. Pour observer le réel :
  - **Sonde** `scripts/probe-servers.mjs` (lecture seule) exécutée par `.github/workflows/probe.yml` :
    elle se déclenche **par un push modifiant ce script ou ce workflow** (le déclenchement manuel par
    l'API est refusé à l'intégration : 403). Lire le résultat avec les outils MCP GitHub
    `actions_list` (list_workflow_jobs) puis `get_job_logs` (`return_content: true`).
  - **Tests sur téléphone** par l'utilisateur sur https://deylac.github.io/freedom/ ; lui demander
    une capture de Réglages → « Diagnostic du dernier envoi ».
- Déploiement : **chaque push sur `main` dont la CI réussit** publie GitHub Pages (`pages.yml` attend
  `ci.yml`, typecheck + tests + build + E2E : compter ~8 min). Une CI rouge = rien n'est publié.
  Suivre l'état via l'API publique : `curl -s https://api.github.com/repos/deylac/freedom/actions/workflows/pages.yml/runs?per_page=1`.
- Playwright : utiliser le paquet du projet (`playwright@1.63.0`, même version que le Chromium
  préinstallé dans `/opt/pw-browsers`). Ne jamais lancer `playwright install` ici.

## Carte du code
| Domaine | Fichiers |
|---|---|
| Routage `#hashtag` | `src/lib/hashtag.ts`, `src/hooks/basics.ts` |
| Identité, NIP-07, NIP-19 | `src/lib/nostr/signer.ts` |
| Relais (supervision, NIP-42) | `src/lib/nostr/pool.ts` (`LiveSubscription`, `publishEvent`) |
| Événements NIP-71/92/56/09, BUD-03 | `src/lib/nostr/events.ts` |
| Client Blossom | `src/lib/blossom/client.ts`, `urls.ts`, `health.ts` (serveurs mis de côté) |
| Capture canvas, MIME, nettoyage MP4 | `src/lib/media/` (visages : détecteur YuNet `yunet.ts` + `face-worker.ts`, `face-tracker`, `face-history`, second passage `face-pass` + `face-plan`) |
| Publication (2 voies), file IndexedDB | `src/lib/publish.ts`, `src/lib/storage/outbox.ts` |
| État du mur, modération | `src/lib/wall-store.ts`, `src/lib/moderation/policy.ts` |
| Lecteur anti-censure | `src/components/ResilientVideo.tsx` |
| Résilience (R1–R3) | `src/lib/preserve.ts`, `mirrors.ts`, `bundle.ts`, `components/RescueSheet.tsx`, `NetworkBanner.tsx`, `BundleSheets.tsx` — voir `docs/RESILIENCE.md` |
| Écrans | `src/components/` (`WallView`, `CaptureScreen`, `SettingsSheet`, `PublishTray`…) |
| Config par défaut | `src/config.ts` (+ variables `VITE_*`, voir `.env.example`) |

## Invariants — ne pas casser
1. **Tag `d` = `hw-` + 16 premiers hex du SHA-256 de la vidéo** (`clipIdentifier`). Les republications
   (v2 avec `fallback`) gardent ce `d` : c'est ce qui évite les doublons.
2. **Jamais de requête vers un tiers non choisi par l'utilisateur** (CDN, polices, analytics, API de QR).
   CSP stricte : `script-src 'self'`, pas de script inline. Toute URL média reçue doit passer
   `isAllowedMediaUrl` (https uniquement).
3. **Échec fermé pour la vie privée** : si un filtre d'anonymisation (visages, voix) ne peut pas
   fonctionner, on pixelise tout / on refuse d'enregistrer — jamais de repli silencieux sur le brut.
4. **Le délai de bascule du lecteur ne court que pendant une tentative de lecture** (`playPending`).
   Un `NotAllowedError` (autoplay refusé) n'est pas une panne serveur.
5. **Voie de publication ≠ voie de réplication** (`Publisher` dans `publish.ts`) : un nouveau clip ne
   doit jamais attendre la copie d'un ancien sur les miroirs.
6. **Réglages : seules les valeurs modifiées par l'utilisateur sont enregistrées.** Quand on change
   une liste par défaut dans `config.ts`, **ajouter l'ancienne liste** à `LEGACY_DEFAULT_BLOSSOM_SERVERS`
   (sinon elle reste figée chez les utilisateurs existants).
7. Ne jamais publier de kind 10063 ni 10000 pour une identité NIP-07 (on écraserait sa liste existante).
8. Ne jamais émettre de tags Proofmode (`proof-version`, `verification-level`) : impossible à prouver
   depuis un navigateur.
9. Base relative (`base: './'`) et routage par fragment : l'app doit marcher sous `/ipfs/<cid>/`.
10. **Détecteur de visages autonome** : YuNet (`public/models/`, empreinte vérifiée par le worker) exécuté
    par ONNX Runtime Web dont le moteur (`dist/ort/`) est servi par le site, jamais par un CDN. Ne jamais
    retirer le garde-fou réseau de `face-worker.ts`. Toute montée de version d'`onnxruntime-web` : vérifier
    que le worker ne contacte que l'origine (E2E « Visages » : aucune requête externe).
11. OpenTimestamps : on horodate l'empreinte du **fichier** ; ne contacter que les calendriers de la
    liste blanche (`settings.otsCalendars`) ; jamais de vérification sans action de l'utilisateur.
12. **Préservation et porteurs : clé jetable.** Une copie demandée par un spectateur (R1) ou un paquet
    relayé par un porteur (R3) ne doit jamais être signé par l'identité de l'utilisateur. Les annonces
    kind 1063 ne sont acceptées que si l'URL est https et **contient l'empreinte**.
13. **Liste des miroirs** (kind 30078, `d=hashwall-mirrors`) : n'accepter que la clé `PROJECT_PUBKEY`.
14. **Paquet hors ligne** : l'événement et l'autorisation sont signés par l'auteur ; le porteur publie
    l'événement **tel quel** (jamais re-signé ni modifié).
15. **Stockage local** : une écriture IndexedDB n'est acquise qu'à `oncomplete` (`putJob` renvoie
    `durable`/`memory`) ; « Tout effacer » ne se termine que sur suppression **effective**. Ne jamais
    retirer une vidéo de « Mes vidéos » (ni sa clé) tant que sa suppression distante n'est pas confirmée.
16. **Visages** : le floutage n'est **jamais automatique** (décision du 2 nov. : pas assez fiable ni
    rapide en conditions réelles). Il se lance **après coup**, à la demande, depuis l'aperçu
    (« Flouter les visages », expérimental) ; l'original est conservé jusqu'à la publication pour
    « Revenir à l'original ». La caméra ne propose que « Sans flou » / « Tout flou ». Second passage
    (`face-pass.ts`, `face-plan.ts`) : rien n'est écrit ni envoyé avant la décision de l'utilisateur.
    L'E2E mesure le **fichier final** (ressemblance < 0,65 ; net ≈ 0,85–0,92).
17. **Montée en charge** (`docs/CAPACITE.md`) : on **publie** sur tous les relais mais on n'en **lit** que
    `READ_RELAYS` (6) tirés par visite (`readRelays`/`useReadRelays`) ; préservation automatique limitée
    (1/20, délai 5–60 s, arrêt à 6 copies) ; rotation des copies vidéo par visite ; fil fenêtré.
18. **Filigrane** incrusté dans chaque vidéo filmée (`CaptureSession.watermark`, `VITE_WATERMARK_NAME`).

## Façon de travailler
- **Chaque défaut constaté en réel = un test de bout en bout qui échoue sur l'ancien code**, puis la
  correction (vérifier l'échec avec `git stash push <fichiers>` → e2e → `git stash pop`).
- Simulateurs dans `e2e/` : `mock-relay.mjs` (NIP-01), `mock-blossom.mjs` (options `mirror`,
  `refuseUploads`, `delayMs`), `mock-ots.mjs` (calendrier + explorateur Bitcoin). Fausse caméra avec
  visages : `e2e/fixtures/face.jpg` (domaine public) converti en Y4M au lancement. En ajouter une option plutôt que de modifier le comportement par défaut.
- Mettre à jour `docs/ANGLES-MORTS.md` (constats réels) et `docs/FEUILLE-DE-ROUTE.md` (cases cochées)
  dans le même commit que le code.
- Commits en français, petits, avec les lignes d'attribution demandées par la session.
