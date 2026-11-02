# Miroirs automatisés : contrer le blocage d'un nom de domaine

HashWall est un site **statique** : n'importe quel hébergeur de fichiers peut le servir, et le `#mur`
fonctionne à n'importe quelle adresse. Bloquer `deylac.github.io` ne bloque donc ni les vidéos (Blossom)
ni l'index (Nostr) : il suffit d'ouvrir **une autre adresse**. Ce document décrit comment ces adresses
sont créées, vérifiées et annoncées **automatiquement**.

## 1. Le principe : des miroirs qui se connaissent les uns les autres

1. À chaque version validée par la CI, le workflow `.github/workflows/mirrors.yml` publie le même site
   sur **tous les hébergeurs configurés** (Cloudflare Pages, Netlify, Codeberg Pages en Allemagne,
   IPFS) en plus de GitHub Pages.
2. Chaque copie **embarque la liste des adresses fixes** (`HASHWALL_MIRRORS`) : depuis n'importe quel
   miroir, Réglages → « Adresses de secours » montre tous les autres.
3. Le workflow **vérifie** ensuite quels miroirs répondent, puis publie la **liste signée** par la clé du
   projet sur Nostr (kind 30078). Une application déjà installée la récupère au démarrage par les
   relais : elle apprend les nouvelles adresses (y compris l'adresse IPFS, qui change à chaque version)
   **même si toutes les anciennes sont bloquées**. Une liste signée par une autre clé est ignorée.
4. Tous les jours à 4 h 17 UTC, le workflow se relance : redéploiement, nouvelle vérification,
   republication de la liste (les relais peuvent oublier les vieux événements).
5. Dans l'application, « Tester depuis mon réseau » indique quels miroirs sont joignables **depuis la
   connexion de la personne** (le blocage dépend souvent du fournisseur d'accès).

Un hébergeur non configuré est simplement ignoré : rien n'est cassé tant qu'aucun secret n'est fourni.

## 2. Ce que l'éditeur doit configurer (une seule fois)

Dans GitHub : *Settings → Secrets and variables → Actions*. Les **secrets** sont chiffrés ; les
**variables** sont des valeurs non secrètes.

| Hébergeur | Compte à créer | Secrets | Variables | Adresse obtenue |
|---|---|---|---|---|
| Clé du projet (liste signée) | — | `HASHWALL_PROJECT_NSEC` (nsec1…) | `HASHWALL_PROJECT_NPUB` (npub1…) | — |
| Cloudflare Pages | cloudflare.com (gratuit, bande passante illimitée sur le statique) | `CLOUDFLARE_API_TOKEN` (droit « Pages : Edit »), `CLOUDFLARE_ACCOUNT_ID` | `CF_PAGES_PROJECT` (ex. `hashwall`) | `https://hashwall.pages.dev/` |
| Netlify | netlify.com (gratuit) | `NETLIFY_AUTH_TOKEN` | `NETLIFY_SITE_ID` | `https://<nom>.netlify.app/` |
| Codeberg Pages (UE, associatif) | codeberg.org + dépôt vide (ex. `hashwall/pages`) | `CODEBERG_TOKEN` (droit d'écriture du dépôt) | `CODEBERG_REPO` (`utilisateur/depot`) | `https://utilisateur.codeberg.page/depot/` |
| IPFS (Pinata) | pinata.cloud (offre gratuite) | `PINATA_JWT` | — | `https://<cid>.ipfs.dweb.link/` (change à chaque version, annoncée par la liste signée) |

Puis déclarer les adresses **fixes** dans la variable `HASHWALL_MIRRORS` (séparées par des espaces,
libellé facultatif après `|`) :

```
https://deylac.github.io/freedom/|GitHub https://hashwall.pages.dev/|Cloudflare https://hashwall.netlify.app/|Netlify https://hashwall.codeberg.page/pages/|Codeberg (UE)
```

Facultatif : `HASHWALL_SITE_URL` (adresse principale pour les aperçus de liens sur les réseaux
sociaux) et `HASHWALL_MIRRORS_EXTRA` (adresses gérées à la main, ex. `http://xxxx.onion/|Tor`).

**La clé du projet** est la pièce maîtresse : elle seule peut annoncer des miroirs. La générer hors
ligne (ex. `node -e "…generateSecretKey…"` ou un client Nostr), la confier à 2–3 personnes de confiance,
et ne la mettre que dans le secret GitHub. Si elle fuit : en créer une nouvelle et republier
l'application (l'ancienne clé ne peut pas être révoquée sur Nostr).

## 3. Pour aller plus loin (hors automatisation)

- **Noms de domaine dans plusieurs pays** (`.fr`, `.ch`, `.is`…), chacun pointé vers Cloudflare Pages ou
  Netlify : ajoutés à `HASHWALL_MIRRORS`, ils deviennent des miroirs comme les autres.
- **Tor (.onion)** : un petit serveur (même un Raspberry Pi) qui sert le dossier `dist/` derrière un
  service caché Tor ; l'adresse va dans `HASHWALL_MIRRORS_EXTRA`. Lecture possible dans Tor Browser
  (la caméra y est bridée).
- **Forks** : n'importe qui peut forker le dépôt et activer GitHub Pages : c'est un miroir de plus,
  mais il ne sera annoncé par l'application que si la clé du projet l'ajoute à la liste signée
  (protection contre les miroirs piégés).
- **Arweave** : stockage permanent payé une fois (quelques euros par version), servi par de nombreuses
  passerelles. Non automatisé (portefeuille requis).

## 4. Limites honnêtes

- Une personne qui n'a **jamais** ouvert HashWall et dont le domaine est bloqué doit recevoir une autre
  adresse par un autre canal (bouche-à-oreille, QR code de l'écran « Adresses de secours », réseaux
  sociaux) : aucun site ne peut s'annoncer à quelqu'un qui ne peut pas le joindre.
- Le blocage par adresse IP des grands hébergeurs (Cloudflare, Netlify) est coûteux pour un censeur
  (il bloquerait des milliers d'autres sites) : c'est ce qui rend ces miroirs efficaces.
- Le workflow vérifie la joignabilité **depuis GitHub** ; « Tester depuis mon réseau » la vérifie
  depuis celui de l'utilisateur.
