# HashWall — mur vidéo citoyen de 60 secondes

Filmer 60 secondes depuis le navigateur de son téléphone et publier, **sans compte**, sur un mur
public accessible par une simple URL à fragment : `https://votre-domaine/#14octobre`.

- **100 % client** : aucune base de données, aucun fichier vidéo sur l'infrastructure de l'éditeur.
- **Nostr (NIP-71)** pour l'index signé et le temps réel, **Blossom** pour le stockage adressé par le contenu.
- **Anti-censure** : chaque vidéo est répliquée sur 3 serveurs ; le lecteur bascule seul si l'un est bloqué.
- **Anonymat matériel** : la vidéo passe par un `<canvas>` ; aucune position GPS ni information sur l'appareil n'est envoyée.

> L'analyse des angles morts du cahier des charges (contradictions, risques non couverts, points
> non vérifiables ici) est dans **[docs/ANGLES-MORTS.md](docs/ANGLES-MORTS.md)**. À lire avant toute mise en production.

## Démarrer

```bash
npm install
npm run dev          # http://localhost:5173/#14octobre
npm test             # tests unitaires (Vitest)
npm run e2e          # tests d'acceptation de bout en bout (Playwright, caméra simulée)
npm run build        # dist/ : fichiers statiques à déployer
```

La caméra exige un contexte sécurisé : `localhost` ou HTTPS. Pour tester sur un téléphone du réseau
local, servez le build derrière HTTPS (par ex. un tunnel) — sinon `getUserMedia` est indisponible.

Configuration au build : copier `.env.example` en `.env` (relais, serveurs Blossom, modérateurs,
murs mis en avant). L'utilisateur peut ensuite tout modifier dans les Réglages.

## Architecture

```
 Téléphone (navigateur)                                    Spectateurs
 ┌───────────────────────────────────────────┐            ┌──────────────────────┐
 │ caméra → <video> → <canvas 720×1280>      │            │ #14octobre           │
 │   + micro → MediaRecorder (MP4 ou WebM)   │            │ abonnement temps réel│
 │ nettoyage MP4 → SHA-256 → file IndexedDB  │            │ lecteur à bascule    │
 └──────────────┬───────────────┬────────────┘            └───┬─────────────┬────┘
   kind 24242   │               │ kind 34236 (v1 puis v2)     │ REQ #t      │ GET /<sha256>.mp4
   HEAD+PUT     ▼               ▼                             ▼             ▼
   /upload  Blossom A ──/mirror──▶ Blossom B, C      Relais Nostr (×6)   A → B → C → serveurs
            (primaire)   (BUD-04)  (repli : envoi direct)                 de l'auteur (kind 10063)
```

| Couche | Fichiers |
|---|---|
| Routage par fragment (FR-01) | `src/lib/hashtag.ts`, `src/hooks/basics.ts` |
| Identité sans compte, NIP-07, NIP-19 (FR-02) | `src/lib/nostr/signer.ts` |
| Pool de relais supervisé, NIP-42 | `src/lib/nostr/pool.ts` |
| Événements NIP-71 / NIP-92 / NIP-56 / NIP-09 / BUD-03 | `src/lib/nostr/events.ts` |
| Client Blossom BUD-01/02/04/06/09/11/12 (FR-04) | `src/lib/blossom/` |
| Capture canvas 60 s, négociation MIME, floutage (FR-03, FR-08) | `src/lib/media/` |
| Orchestration de la publication, file persistante (FR-04/05) | `src/lib/publish.ts`, `src/lib/storage/outbox.ts` |
| État du mur, suppressions, signalements, listes (FR-07) | `src/lib/wall-store.ts`, `src/lib/moderation/policy.ts` |
| Lecteur anti-censure (FR-06) | `src/components/ResilientVideo.tsx` |
| PWA, service worker, CSP | `vite.config.ts`, `public/` |

### Publication d'une vidéo

1. Fin d'enregistrement (arrêt strict à 60,0 s) → nettoyage du conteneur → SHA-256 de la vidéo et de la vignette.
2. Aperçu de 3 s puis publication automatique (désactivable, toute interaction l'interrompt).
3. Jeton BUD-11 unique (`t=upload`, `x` = vidéo + vignette, `server` = serveurs visés, expiration 1 h).
4. `HEAD /upload` puis `PUT /upload` sur le premier serveur qui accepte ; hash renvoyé vérifié strictement.
5. Événement `kind 34236` (v1) publié dès le **premier** accusé de relais → la vidéo apparaît sur tous les murs.
6. `PUT /mirror` vers 2 autres serveurs (repli : envoi direct si `/mirror` n'existe pas).
7. Événement v2 **avec le même tag `d`** contenant les `fallback` : il remplace la v1.
8. Liste de serveurs `kind 10063` publiée pour l'identité (BUD-03).

## Exigences du PRD

| ID | Exigence | État |
|---|---|---|
| FR-01 | Lecture/normalisation du fragment, page d'accueil avec recherche et murs actifs | ✅ (+ accents, percent-encoding, liens directs `#tag/naddr1…`) |
| FR-02 | Clé locale au premier lancement, « Nouvelle identité anonyme », NIP-07 optionnel | ✅ (+ rotation par vidéo, clé lecteur séparée pour NIP-42) |
| FR-03 | Arrêt strict à 60 s, MP4 H.264/AAC prioritaire, débit cible | ✅ débit ramené à 2 Mbps (voir angles morts §1.1) |
| FR-04 | HEAD /upload, PUT /upload, PUT /mirror ≥ 1 secours | ✅ 2 miroirs, repli sans BUD-04 |
| FR-05 | kind 34236, `d` stable, imeta complet | ✅ `d` dérivé du hash, `published_at`, `alt`, `size` |
| FR-06 | Grille/flux, bascule sans coupure | ✅ sur erreur **et** sur blocage silencieux |
| FR-07 | Signalement NIP-56 + BUD-09, mute list, avertissements | ✅ |
| FR-08 | Floutage visages / voix, Proofmode | ⚠️ visages ou pixelisation : oui ; voix : non ; Proofmode : impossible en web |

## Critères d'acceptation (§8)

`npm run e2e` exécute ces scénarios dans Chromium avec une caméra simulée, contre un relais et trois
serveurs Blossom de test (l'un sans `/mirror`, l'autre qui refuse les clés inconnues). Dernier résultat : **16/16**, y compris avec la
vraie limite de 60 s (`E2E_FULL=1 npm run e2e`).

| Test du PRD | Vérification automatisée |
|---|---|
| Routage aveugle | `#14Octobre` → mur `14octobre` ; passage à `#15octobre` sans aucune requête au serveur web ni rechargement |
| Capture & limite 60 s | arrêt automatique à 60,0 s (60,4 s mesurées depuis le clic), MP4, durée déclarée 60,00 s |
| Forensique | absence de marqueurs GPS/appareil, dates MP4 à zéro *(à refaire avec exiftool sur un iPhone)* |
| Temps réel multi-utilisateurs | apparition sur un autre écran sans rechargement, ≈ 3,2 s après la fin de l'enregistrement dont 3 s d'aperçu (réseau local : n'inclut pas le temps d'envoi réel en 4G) |
| Résistance à la censure | primaire bloqué → lecture depuis un miroir en 0,3 s ; primaire en « trou noir » → 7,2 s |
| Signalement | kind 1984 avec `e`, `p`, `x` (+ `a`) sur les relais, `PUT /report` sur les 3 serveurs, vidéo masquée |
| *Ajout* autoplay refusé | lecture automatique bloquée (iPhone en économie d'énergie) : bouton « Lire », aucune fausse bascule |
| *Ajout* diagnostic | refus d'un serveur et repli visibles dans Réglages → « Diagnostic du dernier envoi » |
| *Bonus* suppression | kind 5 + `DELETE` sur les serveurs, vidéo retirée des murs ouverts |

Ce qui n'a pas pu être testé ici (relais/serveurs réels, vrais téléphones) est listé dans
[docs/ANGLES-MORTS.md §6](docs/ANGLES-MORTS.md#6-ce-qui-na-pas-pu-être-vérifié-ici).

## Déploiement

Voir **[docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)** : Cloudflare Pages, IPFS (DNSLink), GitHub Pages,
liste de contrôle avant production.

## Licence

À définir par l'éditeur avant publication (le PRD prévoit un logiciel libre ; l'AGPL-3.0 garantit
que les forks hébergés restent ouverts).
