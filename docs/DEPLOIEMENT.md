# Déploiement

HashWall se compile en fichiers statiques (`npm run build` → `dist/`). Tous les chemins sont
relatifs : le même build fonctionne à la racine d'un domaine, dans un sous-dossier, sur un miroir ou
sous `/ipfs/<cid>/`.

## Variables de build

Copier `.env.example` en `.env` (ou les définir dans la CI) :

| Variable | Rôle |
|---|---|
| `VITE_RELAYS` | Relais Nostr par défaut (séparés par des virgules ou espaces) |
| `VITE_BLOSSOM_SERVERS` | Serveurs Blossom par ordre de préférence |
| `VITE_MODERATORS` | npub / hex des collectifs de modération (listes kind 10000) |
| `VITE_FEATURED_TAGS` | Murs mis en avant sur l'accueil |
| `VITE_REPORT_THRESHOLD` | Signalements (clés distinctes) avant floutage (défaut 3) |

## Cloudflare Pages

- Commande de build : `npm ci && npm run build` — dossier de sortie : `dist`.
- Le fichier `public/_headers` est appliqué automatiquement (CSP complémentaire, `Referrer-Policy:
  no-referrer`, `Permissions-Policy` qui **interdit la géolocalisation**, pas de cache sur `sw.js`).

## IPFS (miroir anti-blocage DNS)

```bash
npm run build
ipfs add -r --cid-version=1 dist        # note le CID du dossier
# DNSLink : enregistrement TXT _dnslink.votre-domaine = "dnslink=/ipfs/<CID>"
```

- Préférer les **passerelles par sous-domaine** (`https://<cid>.ipfs.dweb.link/`) : chaque site a
  sa propre origine. Sur une passerelle « par chemin » (`/ipfs/<cid>/`), l'application détecte
  l'origine partagée et refuse de stocker la clé secrète (elle reste en mémoire).
- Publier le CID avec chaque version pour que les utilisateurs puissent vérifier ce qu'ils exécutent.

## GitHub Pages

Le workflow `.github/workflows/pages.yml` (déclenchement manuel) publie `dist/` sur GitHub Pages.
Activer Pages dans *Settings → Pages → Source : GitHub Actions* au préalable.

## Service worker

Le service worker met en cache la coquille applicative uniquement (jamais les vidéos ni les relais).
Une fois la PWA visitée, elle se relance même si le domaine est bloqué ou hors ligne. Les mises à jour
sont prises au chargement suivant (navigation « réseau d'abord »).

## Liste de contrôle avant production

- [ ] **Valider chaque serveur Blossom par défaut** depuis un vrai réseau : `HEAD /upload` avec une clé
      inconnue → 200 ? taille maximale ? `PUT /mirror` ? `PUT /report` ? CORS (y compris `X-Reason`) ?
      Rejet des fichiers avec GPS ? Juridictions différentes pour les miroirs ?
- [ ] **Valider chaque relais par défaut** : écriture autorisée pour une clé neuve, kind 34236 accepté,
      pas de NIP-42 obligatoire ni de paiement.
- [ ] Tester sur **iPhone (Safari)** et **Android (Chrome)** : capture 60 s, lecture croisée, PWA installée.
- [ ] Refaire le **test forensique avec exiftool** sur des fichiers produits par de vrais téléphones.
- [ ] Mettre en place une **liste de modération** (`VITE_MODERATORS`) opérée par un collectif identifié.
- [ ] Faire valider l'**analyse juridique** (LCEN, DSA, droit à l'image, CGU).
- [ ] Choisir et publier la **licence**.
- [ ] Nom de domaine + miroir IPFS + au moins un domaine miroir ; publier les CID.
