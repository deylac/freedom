# Angles morts du PRD et du dossier d'architecture

Analyse menée pendant l'implémentation. Pour chaque point : le problème, son impact, et ce que fait
(ou ne fait pas) le code. Les références `fichier:ligne` pointent vers l'implémentation.

Légende : ✅ traité dans le code · ⚠️ atténué, limite résiduelle · ❌ non traité / hors de portée d'un client web

---

## 1. Contradictions et erreurs factuelles dans les documents

| # | Problème | Impact | Traitement |
|---|---|---|---|
| 1.1 | **Débit incompatible avec la taille** : FR-03 vise 2,5–3,5 Mbps, le test d'acceptation exige < 20 Mo. 3,5 Mbps × 60 s ≈ 26 Mo. 20 Mio ≈ 2,79 Mbps *tout compris*. | Rejet par nostr.build (palier gratuit 20 Mio), échec du test d'acceptation n°2. | ✅ 2 Mbps vidéo + 96 kbps audio (~16 Mo) et un profil « réseau saturé » à 1 Mbps (`src/config.ts`). MediaRecorder dépasse parfois sa cible : la marge est volontaire. |
| 1.2 | **Time-to-Wall < 4 s en 4G** pour 16–20 Mo : il faut ≥ 40 Mbps *montants*. En manifestation, la 4G montante tombe souvent sous 1 Mbps (2 à 3 minutes d'envoi). | KPI inatteignable, risque de déception ou de mauvais arbitrage (qualité trop basse). | ⚠️ Mesuré honnêtement : la v1 de l'événement part dès la fin de l'envoi primaire (pas d'attente des miroirs), la progression est affichée, le profil 1 Mbps divise la durée par deux. **Recommandation** : redéfinir le KPI comme « < 4 s après la fin de l'envoi » ou passer à un envoi segmenté progressif (hors Blossom standard). |
| 1.3 | **Firefox et `video/webm;codecs="avc1…"`** : Firefox n'encode pas de H.264 dans du WebM via MediaRecorder (c'est une particularité de Chrome). | Négociation inopérante sur Firefox. | ✅ Repli VP8/Opus, placé avant le H.264-en-WebM car bien plus largement lisible (`src/lib/media/mime.ts`). |
| 1.4 | **`image …?poster`** est une fonction propre à nostr.build, pas à Blossom. | Vignettes cassées sur tous les autres serveurs (et sur les miroirs). | ✅ La vignette est capturée depuis le canvas (JPEG), envoyée comme blob à part entière, répliquée et déclarée en `image` multiples. |
| 1.5 | **« Le canvas détruit les métadonnées GPS »** : vrai, mais MediaRecorder n'en écrit de toute façon jamais. Le vrai risque est l'import d'un fichier depuis la galerie (qui, lui, contient GPS, modèle, numéro de série). | Faux sentiment de sécurité si l'on ajoute un jour l'import de fichiers. | ✅ Aucun import de fichier n'existe. Défense en profondeur : le conteneur MP4 est nettoyé *en place* avant le hash (dates `mvhd/tkhd/mdhd` à zéro, boîtes `udta`/`meta` neutralisées — `©xyz` est la position GPS QuickTime) sans modifier aucune taille de boîte (`src/lib/media/mp4-scrub.ts`). ⚠️ Si un import est ajouté, il devra ré-encoder via le canvas. |
| 1.6 | **Spécifications incomplètes** : NIP-56 impose un tag `e` dès qu'un `x` est présent ; NIP-71 rend `title` obligatoire et prévoit `published_at` ; BUD-11 recommande les tags `server` pour empêcher le rejeu des jetons. | Événements non conformes, signalements ignorés par certains clients. | ✅ Implémentés (`src/lib/nostr/events.ts`, `src/lib/blossom/client.ts`). Les URLs d'imeta conservent l'extension `.mp4/.webm` (BUD-02 l'impose d'ailleurs côté serveur). |
| 1.7 | **Proofmode (`proof-version`, `verification-level: verified_mobile`)** suppose une attestation matérielle (App Attest / Play Integrity) **impossible depuis un navigateur**. | Revendiquer « vérifié » serait mensonger, un risque majeur pour le persona journaliste. | ❌ Volontairement non émis. La fiche « Résilience » explique ce que prouve (date, clé) et ne prouve pas (identité, lieu, mise en scène) la signature. Piste : horodatage OpenTimestamps (NIP-03). |
| 1.8 | **« Le fragment n'est visible ni du serveur ni du FAI »** : vrai pour le serveur web, mais les relais reçoivent `#t:["14octobre"]` avec l'IP du spectateur, les serveurs Blossom voient l'IP de qui filme, et le FAI voit (DNS/SNI) qu'on contacte des relais Nostr. | Promesse de confidentialité surévaluée pour des personnes exposées. | ⚠️ Les CGU le disent et recommandent VPN/Tor. Aucun service tiers (QR, polices, analytics) n'est contacté ; `Referrer-Policy: no-referrer` partout. |
| 1.9 | **« 0 point de blocage »** : les relais et serveurs *par défaut* sont des points de centralisation de fait ; s'ils tombent ou filtrent, le mur est vide pour les nouveaux venus. | Résilience réelle dépendante d'une liste figée dans le code. | ⚠️ Listes surchargeables au build (`VITE_*`) et par l'utilisateur ; les serveurs de l'auteur (kind 10063) sont toujours consultés. Voir §6. |
| 1.10 | **Analyse juridique** (absence de statut d'hébergeur/éditeur, exception TCO) : non vérifiée. Choisir les relais/serveurs par défaut et afficher un mur thématique peut être qualifié de rôle éditorial ; des injonctions peuvent viser le nom de domaine du front-end. | Risque juridique pour l'éditeur du site. | ❌ Hors du périmètre du code : **à faire valider par un avocat** (LCEN, DSA, droit à l'image) avant lancement. |

## 2. Sécurité et vie privée

| # | Problème | Traitement |
|---|---|---|
| 2.1 | **Défi NIP-42 en lecture signé avec la clé de publication** : relierait l'IP et les murs consultés à l'identité qui publie. | ✅ Une clé « lecteur » éphémère, jamais stockée, répond aux défis des abonnements ; la clé de publication ne sert qu'aux publications (`src/lib/nostr/signer.ts`, `pool.ts`). |
| 2.2 | **Passerelle IPFS par chemin** (`https://passerelle/ipfs/<cid>/`) : tous les sites IPFS partagent la même origine, donc le même `localStorage` → n'importe quelle page IPFS peut lire la nsec. | ✅ Détection de `/ipfs/` et `/ipns/` : stockage en mémoire uniquement + avertissement (`src/lib/storage/local.ts`). Déployer de préférence sur une passerelle par sous-domaine. |
| 2.3 | **Saisie du téléphone** : clé, liste des vidéos publiées et fichiers en attente sont des preuves. | ✅ Bouton « Tout effacer », option « ne pas garder les clés de suppression », octets effacés de la file dès la publication terminée. ⚠️ Le navigateur peut conserver des copies en cache disque. |
| 2.4 | **Corrélation de toutes les vidéos d'une même clé** (une clé générée « au premier lancement »). | ✅ « Nouvelle identité anonyme » + option « nouvelle identité à chaque vidéo » ; chaque vidéo garde sa propre clé pour pouvoir être supprimée. |
| 2.5 | **Vol de la nsec par XSS** (clé dans `localStorage`). | ✅ CSP stricte (`script-src 'self'`, pas d'inline) en `<meta>` et en en-têtes, URLs média limitées à `https:`, pas de `dangerouslySetInnerHTML`. |
| 2.6 | **Générateur de QR en ligne** : enverrait le hashtag et l'IP à un tiers. | ✅ QR généré localement (`qrcode-generator`). |
| 2.7 | **Rejeu des jetons Blossom** (surtout `delete`). | ✅ Jetons restreints par `x` et `server` ; jeton de suppression valable 5 minutes. |
| 2.8 | **Écraser la liste kind 10063 d'un utilisateur NIP-07** (événement remplaçable) détruirait sa configuration existante. | ✅ La liste n'est publiée que pour les identités locales générées par l'app. Même précaution pour les listes de masquage : le masquage reste local. |
| 2.9 | **Personnes filmées** : un visage reconnaissable peut exposer un manifestant. | ⚠️ CGU explicites + filtre « Visages floutés » via l'API Shape Detection (`FaceDetector`, disponible seulement sur certains Chrome) ; à défaut ou en cas d'échec, **repli sûr : image entière pixelisée**. Persistance de 700 ms pour éviter qu'un visage manqué une image apparaisse. La détection reste imparfaite (profils, foule). |

## 3. Modération

| # | Problème | Traitement |
|---|---|---|
| 3.1 | **Attaque Sybil** : « 3 signalements de clés distinctes » ne coûte rien (les clés sont gratuites). Un seul acteur peut flouter n'importe quelle vidéo — une censure à bas coût. | ⚠️ Le seuil ne fait que **flouter de façon réversible** (« Afficher quand même »), jamais supprimer ; l'auteur ne compte pas contre lui-même ; un seul signalement d'un modérateur de confiance suffit. Pistes : pondération Web of Trust, preuve de travail NIP-13 sur les signalements. |
| 3.2 | **Signalements perdus après mise à jour** : un événement adressable change d'`id` à chaque version (et HashWall republie la v2 avec les miroirs). Un signalement par `e` viserait une version obsolète. | ✅ Les signalements portent `e`, `a` et `x` ; le client agrège par adresse, par hash et par tous les `id` connus de la vidéo (`src/lib/wall-store.ts`). |
| 3.3 | **Inondation du mur** (aucun compte = création de clés à volonté). | ✅ Plafond de 12 clips par auteur et par mur, dates futures rejetées (épinglage), durée déclarée > 61 s rejetée, dédoublonnage par SHA-256. ⚠️ Un attaquant multipliant les clés reste possible : la couche 3 (listes de modérateurs) est indispensable. |
| 3.4 | **Republication d'une vidéo par une autre clé** (appropriation). | ✅ Dédoublonnage par hash : seule la publication la plus ancienne est affichée. |
| 3.5 | **Limite de 60 s purement côté client** : n'importe qui peut publier un 34236 plus long avec le même hashtag. | ✅ Rejet des durées déclarées > 61 s et lecture plafonnée à 61 s quel que soit le fichier. |
| 3.6 | **Contenus gravissimes (CSAM)** : la couche 1 dépend entièrement des serveurs Blossom ; un mur public sans compte est une cible. | ❌ Le client signale aux serveurs (BUD-09) mais ne peut pas analyser les images. **Recommandation forte** : opérer ou s'adosser à une liste de modération kind 10000 maintenue par un collectif identifié avant le lancement (`VITE_MODERATORS`), et choisir des serveurs par défaut qui filtrent par hash. |
| 3.7 | `content-warning` : « ne rien précharger ». | ✅ Ni vidéo ni vignette ne sont chargées avant le clic « Afficher quand même ». L'auteur peut lui-même marquer sa vidéo comme sensible avant publication. |

## 4. Résilience et anti-censure

| # | Problème | Traitement |
|---|---|---|
| 4.1 | **`handleBrokenMedia` ne réagit qu'à l'événement `error`** : un serveur dont l'IP est mise en « trou noir » ne produit d'erreur qu'après 20 à 75 s ; la position de lecture est perdue. | ✅ Lecteur dédié : bascule sur erreur **et** après 7 s sans données, reprise à la même position, candidats = `url` → `fallback` → serveurs kind 10063 de l'auteur → serveurs configurés (`src/components/ResilientVideo.tsx`). Le SDK reste utilisé pour les vignettes (`handleMediaFallbacks`), les URIs BUD-10 et l'extraction de hash. Testé : 0,3 s (requête bloquée) et 7,2 s (trou noir). |
| 4.2 | **nostr-tools n'essaie plus un relais injoignable au premier contact** (il ne reconnecte qu'après une première connexion réussie). | ✅ Supervision par relais avec backoff, relance immédiate au retour du réseau et au retour de l'onglet au premier plan (`LiveSubscription`). |
| 4.3 | **`PUT /mirror` n'est pas implémenté partout.** | ✅ Repli automatique : envoi direct du fichier local au serveur miroir (testé avec un serveur sans BUD-04). |
| 4.4 | **Les URLs de secours ne sont connues qu'après publication** (ou il faut attendre les miroirs, ce qui retarde le mur). | ✅ Publication v1 immédiate, puis v2 avec `fallback` sous **le même tag `d`** : remplacement, pas de doublon (vérifié sur le relais de test). Le `d` est dérivé du hash : une nouvelle tentative ne crée jamais de doublon. |
| 4.5 | **Perte de la vidéo** si le réseau coupe ou si l'onglet est fermé pendant l'envoi. | ✅ File d'attente IndexedDB, reprise automatique au lancement et au retour du réseau, bouton « Réessayer ». |
| 4.6 | **Écran verrouillé / appli changée pendant l'enregistrement** : `requestAnimationFrame` s'arrête, la vidéo gèle. | ✅ Arrêt propre de l'enregistrement (la partie filmée est conservée) + Wake Lock pendant la capture et l'envoi. |
| 4.7 | **Domaine bloqué après la première visite.** | ✅ Service worker « coquille applicative » : la PWA installée se relance même si le domaine ne répond plus (réseau d'abord, cache en secours, délai 4 s). Il ne met jamais en cache les médias ni les relais. |
| 4.8 | **Miroirs et IPFS** : chemins absolus = application cassée sous `/ipfs/<cid>/`. | ✅ `base: './'`, manifeste et service worker relatifs, routage par fragment. Le QR code utilise l'origine courante (miroir ou passerelle). |

## 5. Compatibilité mobile

| # | Problème | Traitement |
|---|---|---|
| 5.1 | iOS ne décode pas une `<video>` masquée (`display:none`) : `drawImage` dessinerait du noir. | ✅ La vidéo brute reste dans le DOM, sous le canvas, en opacité nulle. |
| 5.2 | Navigateurs intégrés (Instagram, Facebook, WhatsApp) : caméra souvent bloquée — or le QR code est souvent partagé par ces applis. | ✅ Détection et message « Ouvrez dans Safari/Chrome ». |
| 5.3 | WebM illisible sur les anciens iOS. | ✅ Sélection de variante via `canPlayType`, préférence MP4. ⚠️ Une vidéo WebM publiée depuis Firefox reste illisible sur un vieil iPhone. |
| 5.4 | Autoplay mobile : seulement en muet et `playsinline`. | ✅ Lecture muette par défaut, son au toucher. Seul le clip actif et ses voisins chargent la vidéo. |
| 5.6 | **Autoplay refusé ≠ serveur en panne** (constaté sur iPhone en mode économie d'énergie) : Safari refuse alors toute lecture automatique, même muette. Le lecteur prenait l'absence de données pour un blocage serveur, basculait sur tous les miroirs puis déclarait la vidéo « introuvable ». | ✅ Le délai de bascule ne court que pendant une tentative de lecture en cours ; un refus `NotAllowedError` affiche un bouton « Lire » sans changer de serveur. Test de non-régression qui échoue sur l'ancien lecteur. |
| 5.5 | Re-snap CSS : une nouveauté insérée au-dessus du clip regardé resterait invisible. | ✅ Si l'on regardait le premier clip, le flux remonte sur la nouveauté ; sinon une pastille « ↑ N nouvelles vidéos » apparaît, sans déplacer ce qu'on regarde. |

## 6. Ce qui n'a PAS pu être vérifié ici

> **Tests réels (iPhone, 5G, 1ᵉʳ nov. 2026) + sonde GitHub Actions** (`scripts/probe-servers.mjs`,
> lancée chaque lundi) : 6/6 relais connectés et à jour. Côté Blossom :
>
> | Serveur | Clé inconnue | Constat |
> |---|---|---|
> | nostr.download | ✅ | rapide, CORS complet, plages d'octets → **primaire par défaut** |
> | cdn.nostrcheck.me | ✅ | CORS complet |
> | blossom.nostr.build, blossom.band | ✅ | antivirus : réponse > 30 s après réception |
> | blossom.primal.net | ✅ au HEAD | réponses d'erreur sans en-têtes CORS (illisibles par le navigateur) |
> | blosstr.com | ❌ 403 | « No active subscription » : payant, retiré |
> | 24242.io, cdn.satellite.earth, files.sovbit.host | ❌ | refus ou CORS incompatible |
>
> Trois défauts découverts et corrigés grâce à ces tests (chacun couvert par un test de bout en
> bout qui échoue sur l'ancien code) :
> 1. **Autoplay refusé pris pour une panne** (mode économie d'énergie d'iOS) — voir §5.6.
> 2. **Envoi abandonné sur un serveur lent** : le détecteur de blocage attendait des octets alors que
>    le fichier était déjà parti et que le serveur l'analysait. Le délai de blocage ne s'applique plus
>    qu'à la transmission ; l'attente de réponse a son propre délai (120 s).
> 3. **Nouveaux clips bloqués derrière la réplication des anciens** : la file était unique et la
>    réplication séquentielle (jusqu'à plusieurs minutes). Désormais deux voies indépendantes
>    (publication urgente / réplication en arrière-plan), `/mirror` en parallèle sur tous les serveurs,
>    serveurs muets mis de côté 30 min, vignette jamais bloquante.
>
> Autre piège corrigé : l'ancienne liste de serveurs par défaut était **figée dans le stockage local**
> des utilisateurs ; seuls les réglages réellement modifiés sont désormais enregistrés.

- **Relais et serveurs Blossom réels** : le conteneur de développement ne peut pas les joindre ; ils sont vérifiés par la sonde GitHub Actions et par des tests sur téléphone (ci-dessus). Restent à vérifier : `/report` (BUD-09) et la conservation dans le temps (en-tête `Sunset`).
- **Vrais téléphones** : tests réalisés dans Chromium (caméra simulée) uniquement. Safari iOS (captureStream + MediaRecorder MP4) et Chrome Android doivent être testés sur appareil.
- **exiftool** indisponible : le test forensique inspecte le binaire (absence de `©xyz`, `GPS`, `Make`, `Model`, `udta`…, dates MP4 à zéro). Refaire le test n°3 du PRD avec exiftool sur un fichier issu d'un iPhone.

## 7. Reste à faire (V1.1 et au-delà)

- FR-08 : **voix anonymisée** (changement de hauteur en Web Audio) non implémentée.
- Liste de modération par défaut opérée par un collectif identifié ; pondération Web of Trust / NIP-13 des signalements.
- Horodatage OpenTimestamps (NIP-03) pour renforcer la valeur probante.
- Envoi segmenté / HLS : inutile pour 60 s, nécessaire si la durée augmente.
- **Choisir une licence** (le PRD parle d'open source ; AGPL-3.0 conseillée pour qu'un fork hébergé reste ouvert) et la publier.

## 8. Constats du lot « fonctionnalités avancées » (1ᵉʳ nov. 2026)

| # | Constat | Traitement |
|---|---|---|
| 8.1 | **MediaPipe envoie une télémétrie à Google** (`odml.pa.googleapis.com`, toutes les 60 s) : elle aurait révélé l'IP de quiconque active le floutage. Un worker chargé depuis un fichier n'hérite pas de la CSP de la page. | ✅ URL neutralisée au build (le build échoue si elle change), worker interdisant toute requête hors origine, test E2E « aucune requête externe ». |
| 8.2 | Les modèles officiels MediaPipe ne sont pas sur npm ; ceux de l'ancien paquet n'ont pas les métadonnées exigées ; l'ancien paquet exigerait `'unsafe-eval'`. | ✅ Modèle officiel récupéré par GitHub Actions (`fetch-models.yml`), SHA-256 figé et vérifié à l'usage. |
| 8.3 | Détection : sans découpage, rien sous 61 px de large ; avec tuiles de 360 px, jusqu'à ~23 px. Profils et visages masqués restent difficiles. | ⚠️ Tuiles + persistance + marges ; échec fermé (pixelisation totale) tant que l'image n'est pas entièrement analysée. iOS < 17 : pas d'`OffscreenCanvas` WebGL → pixelisation totale. |
| 8.4 | **NIP-03 inadapté** : il horodate l'id d'un événement ; nos événements adressables sont remplacés (v1 → v2), la preuve viserait un événement disparu. NIP-03 est en outre « unrecommended ». | ✅ Horodatage de l'empreinte du **fichier**, preuve `.ots` standard dans `imeta` (vérifiable avec `ots verify`). |
| 8.5 | Une preuve OTS contient des URL de calendriers : la suivre aveuglément permettrait de pister l'IP des spectateurs. | ✅ Liste blanche de calendriers ; vérification uniquement sur clic. |
| 8.6 | Les calendriers OTS renvoient leurs 404 sans CORS (illisibles) mais leurs 200 avec CORS : la mise à niveau depuis un navigateur est possible (vérifié sur une vraie preuve de 2016). | ✅ |
| 8.7 | Voix : un décalage de hauteur serait réversible. | ✅ Vocodeur à porteuse fixe ; mesuré : sortie à 110 Hz quelle que soit l'entrée. Limite : mots, accent et débit restent identifiants. |
| 8.8 | Preuve de travail des signalements : 20 bits ≈ quelques secondes sur téléphone mais une fraction de seconde sur un PC. | ⚠️ Ralentisseur seulement ; la protection réelle vient des modérateurs et de leurs contacts. |
