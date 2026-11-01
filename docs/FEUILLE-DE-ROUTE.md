# Feuille de route

État au 1ᵉʳ novembre 2026. Les choix de conception ci-dessous sont **déjà tranchés** : une session
suivante peut les exécuter tels quels. Chaque tâche donne les fichiers à modifier, les étapes, les tests
et les critères d'acceptation. Mettre à jour les cases à cocher dans le commit qui livre la tâche.

Effort conseillé : 🟢 moyen suffit (tout est spécifié) · 🟠 élevé conseillé (incertitudes techniques).

| # | Tâche | Priorité | État |
|---|---|---|---|
| 1 | Protocole de validation sur vrais appareils | P0 | ⏳ à faire par l'utilisateur |
| 2 | Compléter la sonde (`/report`, CORS des erreurs, `Sunset`, calendriers, explorateurs) | P0 | ✅ livré |
| 3 | Voix anonymisée (FR-08) — vocodeur à canaux | P1 | ✅ livré (`media/voice.ts`, mesure hors ligne) |
| 4 | Signalements résistants aux fausses clés (Web of Trust + preuve de travail) | P1 | ✅ livré |
| 5 | Floutage des visages sur iPhone (MediaPipe) | P1 | ✅ livré (modèle *full range* + tuiles) |
| 6 | « Charger plus » (pagination des murs anciens) | P2 | ✅ livré |
| 7 | Horodatage OpenTimestamps | P2 | ✅ livré — sur l'empreinte du **fichier**, pas NIP-03 (voir ANGLES-MORTS §8) |
| 8 | **Résilience maximale** (miroirs, réplication par les spectateurs, hors ligne, P2P) | P0 | 📄 étude : `docs/RESILIENCE.md` |
| — | Décisions hors code (licence, juridique, collectif de modération, domaine) | P0 | — |

> Les sections 3 à 7 ci-dessous décrivent la conception d'origine ; l'implémentation livrée la suit,
> aux écarts près signalés dans `docs/ANGLES-MORTS.md` §8.

---

## 1. Protocole de validation sur vrais appareils 🟢

Rien à coder : une grille à faire remplir à l'utilisateur, résultats à reporter dans
`docs/ANGLES-MORTS.md` §6. Toujours sur un hashtag de test (`#testhashwall`) et des scènes neutres.

| Scénario | iPhone Safari (normal) | iPhone (économie d'énergie) | Android Chrome | Desktop Chrome/Firefox/Safari |
|---|---|---|---|---|
| Ouverture `…/#testhashwall` : badge « N Relais actifs » vert | ✅ (1ᵉʳ nov.) | | | |
| Filmer 10 s, publication auto : « Publiée », ≥ 1 miroir | | | | |
| Diagnostic : primaire = nostr.download, miroirs réussis | | | | |
| Lecture d'une vidéo filmée sur **un autre** OS | | ✅ bouton « Lire » | | |
| Arrêt automatique à 60 s (une fois par OS) | | | | |
| Écran verrouillé pendant l'enregistrement → partie conservée | | | | |
| Mode avion pendant l'envoi → reprise au retour du réseau | | | | |
| Installation PWA puis relance hors ligne | | | | |
| Signaler une vidéo → masquée ; Réglages → réafficher | | | | |
| Supprimer sa vidéo (Réglages → Mes vidéos) | | | | |
| Fichier téléchargé inspecté avec **exiftool** : pas de GPS / modèle | | | | |

Points d'attention connus : Firefox enregistre en WebM (lisible sur iOS ≥ 17.4 seulement) ;
Android peut proposer plusieurs caméras arrière (on prend `facingMode: environment`).

## 2. Compléter la sonde 🟢

Fichier : `scripts/probe-servers.mjs` (se relance à chaque push qui le modifie, et chaque lundi).
Ajouter, par serveur :
- `OPTIONS /report` (méthode PUT, en-têtes `content-type`) → BUD-09 utilisable depuis le navigateur ?
- `HEAD /<hash inexistant>.mp4` et lire `access-control-allow-origin` : **Primal ne renvoie pas d'ACAO
  sur ses erreurs**, d'où « bloquée par CORS » dans le diagnostic. Marquer `cors-erreurs: KO`.
- En-tête `Sunset` sur le blob de test (durée de conservation annoncée, BUD-01).
- Résumé final en tableau Markdown (une ligne par serveur) pour copier-coller dans ANGLES-MORTS.

Critère : le journal de l'action contient le tableau ; aucun envoi ni publication.
Règle si la liste par défaut change : voir l'invariant n°6 de `CLAUDE.md` (`LEGACY_DEFAULT_BLOSSOM_SERVERS`).

## 3. Voix anonymisée (FR-08) — vocodeur à canaux 🟢

**Décision : vocodeur à canaux avec porteuse fixe (« voix robot »), pas un simple changement de
hauteur.** Raison : un décalage de hauteur est **réversible** (re-décaler restitue une voix
reconnaissable, et la prosodie reste) ; le vocodeur jette l'excitation d'origine (hauteur et timbre)
et ne garde que l'enveloppe spectrale grossière → non réversible, paroles encore compréhensibles.
Limite à afficher : les mots prononcés, l'accent et le débit peuvent toujours identifier.

Uniquement des nœuds Web Audio natifs (pas d'AudioWorklet) → fonctionne sur iOS Safari.

### Fichier `src/lib/media/voice.ts` (à créer)
```ts
/** Construit le vocodeur entre `input` et `output` (testable avec un OfflineAudioContext). */
export function buildVocoder(ctx: BaseAudioContext, input: AudioNode, output: AudioNode): { start(): void } {
  const pre = ctx.createBiquadFilter(); pre.type = 'highpass'; pre.frequency.value = 80
  input.connect(pre)
  const carrier = ctx.createOscillator(); carrier.type = 'sawtooth'; carrier.frequency.value = 110 // fixe
  const noise = ctx.createBufferSource(); noise.buffer = whiteNoise(ctx, 2); noise.loop = true
  const sum = ctx.createGain(); sum.gain.value = 8
  const rectifier = absCurve(1024) // Float32Array : x ↦ |x| sur [-1, 1]
  for (const f of logSpaced(150, 6500, 18)) {
    const analysis = bandpass(ctx, f, 7)
    const rect = ctx.createWaveShaper(); rect.curve = rectifier
    const env = ctx.createBiquadFilter(); env.type = 'lowpass'; env.frequency.value = 30
    pre.connect(analysis).connect(rect).connect(env)
    const synth = bandpass(ctx, f, 7)
    const vca = ctx.createGain(); vca.gain.value = 0
    ;(f > 3800 ? noise : carrier).connect(synth).connect(vca) // bruit pour les sifflantes
    env.connect(vca.gain) // modulation à fréquence audio du gain
    vca.connect(sum)
  }
  const comp = ctx.createDynamicsCompressor()
  sum.connect(comp).connect(output)
  return { start: () => { carrier.start(); noise.start() } }
}

export function createRobotVoice(ctx: AudioContext, track: MediaStreamTrack): { track: MediaStreamTrack; close(): void }
// source = ctx.createMediaStreamSource(new MediaStream([track])) ; dest = ctx.createMediaStreamDestination()
// buildVocoder(ctx, source, dest).start() ; return { track: dest.stream.getAudioTracks()[0], close: () => ctx.close() }
```

### Intégration
- `src/lib/media/recorder.ts` : champ `voice: 'natural' | 'robot'`. Dans `start()` (appelé depuis le
  clic → geste utilisateur, exigé par iOS) : si `robot`, `new AudioContext()`, `await ctx.resume()`,
  utiliser la piste du vocodeur à la place de `this.audioTrack` ; fermer le contexte dans `onstop`/`close()`.
- **Échec fermé** (invariant n°3) : si la création échoue, lever une `CaptureError` « voix anonymisée
  indisponible » au lieu d'enregistrer la voix brute.
- `src/components/CaptureScreen.tsx` : bouton à côté du filtre visages (icône micro barré + libellé
  « Voix robot ») ; dans l'aperçu, afficher « ✓ voix anonymisée ». Le choix reste pour la session.
- `TermsModal` : une ligne sur la voix robot et sa limite.

### Tests
- Vitest ne peut pas exécuter Web Audio. Ajouter `e2e/voice.mjs` (lancé par `e2e/run.mjs` ou à part) :
  dans une page Chromium, `OfflineAudioContext(1, 48000 * 3, 48000)`, entrée = oscillateur en dents de
  scie dont la fréquence **monte de 100 à 220 Hz**, modulé en amplitude à 3 Hz.
  - f0 de la sortie (autocorrélation sur fenêtres de 50 ms, ignorer les fenêtres silencieuses) :
    **constante à 110 ± 5 Hz** quelle que soit l'entrée → la hauteur d'origine a disparu.
  - Corrélation entre l'enveloppe RMS d'entrée et de sortie **> 0,6** → le rythme de parole est conservé.
- E2E existant : enregistrer avec « Voix robot » activée → la publication réussit, la piste audio existe.

Critères d'acceptation : les deux mesures ci-dessus passent ; test d'écoute par l'utilisateur sur
iPhone (compréhensible, non reconnaissable) ; aucune régression des 18 tests E2E.

## 4. Signalements résistants aux fausses clés 🟢

**Problème** : aujourd'hui, N signalements de clés distinctes floutent une vidéo ; créer N clés est gratuit.

**Décision : seuls les signalements « vérifiés » comptent pour le seuil.** Un signalement est vérifié si :
1. son auteur est un **modérateur** configuré → floutage immédiat (déjà en place) ;
2. ou son auteur est **suivi par un modérateur** (Web of Trust de profondeur 1 : kind 3 des modérateurs) ;
3. ou l'événement porte une **preuve de travail NIP-13 ≥ 20 bits** (`getPow(event.id)` de `nostr-tools/nip13`).

Les autres sont affichés (« N signalements non vérifiés » dans la fiche de résilience) mais ne floutent
pas. Honnêteté à documenter : 20 bits ≈ 1 million de hachages, quelques secondes sur téléphone mais
une fraction de seconde sur un PC — c'est un ralentisseur ; la vraie protection reste le Web of Trust.

### Étapes
- `src/lib/wall-store.ts` : `ingestReport` mémorise aussi `pow` par signalement ; nouvel ingest des
  kind 3 des modérateurs → `trusted: Set<pubkey>` (union des tags `p`).
- `src/hooks/useWall.ts` : ajouter `kinds: [3]` pour `authors: moderators` dans l'abonnement principal.
- `src/lib/moderation/policy.ts` : `evaluateClip` reçoit `{ reason, pow, trusted }` par auteur ;
  `verified = trusted || pow >= REPORT_POW_BITS` ; seuil appliqué au nombre de vérifiés.
- `src/lib/pow.worker.ts` (nouveau) : reçoit l'événement non signé (avec `pubkey`), appelle
  `minePow(event, 20)`, renvoie l'événement avec le tag `nonce`. Instancier avec
  `new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' })` (compatible CSP
  `worker-src 'self'` et `base: './'`). Signer **après** le minage (l'id ne change pas).
- `src/lib/publish.ts` → `reportClip` : miner avant de signer ; le menu affiche « Calcul anti-spam… »
  (le masquage local reste immédiat).
- Constante `REPORT_POW_BITS = 20` dans `config.ts`.

### Tests (Vitest)
- 3 signalements sans PoW de clés inconnues → visible ; 3 avec PoW ≥ 20 → averti ;
  1 d'une clé suivie par un modérateur + 2 avec PoW → averti ; signalement d'un modérateur → averti.
- Le worker n'est pas testable sous Node : tester la fonction pure de minage avec une difficulté de 8.

## 5. Floutage des visages sur iPhone (MediaPipe) 🟠

**Problème** : l'API `FaceDetector` n'existe ni dans Safari ni dans Firefox ; sur iPhone, l'option
« Visages floutés » pixelise donc toute l'image (échec fermé, voulu).

**Plan retenu** : `@mediapipe/tasks-vision` (détecteur BlazeFace), **auto-hébergé** :
- Version : en choisir une publiée depuis **au moins deux semaines** (la 1.2.0 date du 27 oct. 2026 :
  prendre la précédente au moment de l'installation). Le paquet npm contient les fichiers `wasm/`.
- Modèle `blaze_face_short_range.tflite` : hébergé sur `storage.googleapis.com`, **injoignable depuis le
  conteneur cloud**. Le récupérer via une action GitHub (étape `curl` dans `pages.yml`, avec contrôle
  d'un SHA-256 figé dans le dépôt) ou depuis l'ordinateur de l'utilisateur, puis le servir depuis
  `public/models/`.
- Copier `wasm/` vers `public/mediapipe/` au build (petit plugin Vite ou script `prebuild`).
- **CSP** : ajouter `'wasm-unsafe-eval'` à `script-src` (`vite.config.ts`) — rien d'autre.
- Chargement **paresseux** au premier passage sur le filtre (≈ 10 Mo) ; ne pas l'ajouter au précache du
  service worker, mais à un cache d'exécution dédié (`/mediapipe/`, `/models/`).
- Détection en mode `VIDEO` sur une image réduite (largeur 320 px), 10–15 Hz, `minDetectionConfidence`
  0,3 (préférer les faux positifs), marge de 35 %, persistance 700 ms (déjà dans `recorder.ts`).
- Ordre : `FaceDetector` natif si présent, sinon MediaPipe, sinon pixelisation totale.
- Limite à afficher : le modèle « short range » détecte mal les visages à plus de ~2 m (foule) →
  conseiller « Image pixelisée » pour les plans larges.

Pourquoi effort élevé : hébergement du modèle hors du conteneur, poids du WASM sur réseau saturé,
qualité de détection à valider sur des scènes réelles (aucun test automatique fiable sans vidéo de
visages ; prévoir une vidéo de test libre de droits et `--use-file-for-fake-video-capture`).

## 6. « Charger plus » 🟢

Le mur charge les 200 derniers événements. Ajouter en bas du flux et de la grille un bouton
« Vidéos plus anciennes » : `queryOnce(relays, { kinds: WALL_KINDS, '#t': [tag], until: plusAncien.createdAt, limit: 100 })`
puis `store.ingest`. Désactiver le bouton quand une requête renvoie 0 événement nouveau.
Étendre `annotationTargets(limit)` au nombre de clips chargés (plafond 400) en découpant les filtres
par paquets de 150 valeurs. Test E2E : publier 3 clips, limiter l'historique à 2 (option de test),
vérifier que le bouton fait apparaître le 3ᵉ.

## 7. Horodatage OpenTimestamps (NIP-03) 🟠

Renforce la valeur probante (persona journaliste) : prouver qu'une vidéo existait avant un bloc Bitcoin.
Publier un kind 1040 contenant la preuve `.ots` de l'id de l'événement. Inconnues : CORS des serveurs
calendrier, poids de la bibliothèque JavaScript, vérification côté client (en-têtes de blocs). Faire
d'abord une sonde (cf. §2) avant de coder.

---

## Décisions hors code (à prendre par l'éditeur)
- [ ] **Licence** (AGPL-3.0 conseillée) — tant qu'elle manque, le code public reste « tous droits réservés ».
- [ ] **Validation juridique** (LCEN, DSA, droit à l'image, CGU) avant tout lancement public.
- [ ] **Collectif de modération** : publier une liste kind 10000 et renseigner `VITE_MODERATORS`.
- [ ] **Nom de domaine** + miroir IPFS (passerelle par sous-domaine) ; publier les CID.
- [ ] Redéfinir le KPI « Time-to-Wall < 4 s » : irréaliste pour 16 Mo en 4G saturée (ANGLES-MORTS §1.2).

## Dette technique connue
- `blossom-client-sdk` importe `@noble/hashes/sha2` dynamiquement (`helpers/blob.js`) → petit fichier
  `sha2-*.js` séparé, inutilisé en pratique. Avec `skipWaiting`, un onglet resté ouvert pendant une mise
  à jour ne pourrait plus le charger. Sans effet aujourd'hui ; à surveiller si l'on utilise d'autres
  fonctions du SDK (sinon : importer les sous-modules précis ou retarder `skipWaiting`).
- blossom.primal.net : réponses d'erreur sans en-têtes CORS ; laissé en dernier de la liste.
- Les filtres d'annotations (signalements, suppressions, listes de serveurs) visent les 150 clips les
  plus récents (voir §6).
- La grille desktop n'est pas virtualisée (à faire au-delà de ~300 clips affichés).
- Le nettoyage MP4 ne traite pas le WebM (pas de date écrite par Chrome/Firefox à ce jour ; vérifier
  avec exiftool lors du protocole §1).
