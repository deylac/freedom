# Capacité : 10 000 personnes connectées en même temps

HashWall n'a **pas de serveur à lui** : la charge se répartit sur trois couches indépendantes.
Ce document chiffre chacune pour 10 000 visiteurs simultanés et liste ce qui a été fait pour tenir.

## 1. Le site (fichiers statiques)

| Élément | Taille (gzip) | 10 000 visiteurs |
|---|---|---|
| Première visite (HTML + JS + CSS) | ≈ 170 Ko | ≈ 1,7 Go au total |
| Visites suivantes | 0 (service worker) | négligeable |
| Floutage après coup (expérimental, à la demande) | ≈ 4 Mo (moteur + modèle) | seulement pour qui l'utilise |

- **GitHub Pages** : quota indicatif de 100 Go/mois et limitation possible en cas de pic ; suffisant pour
  un lancement, **pas pour un pic viral durable**. Recommandé : un hébergeur sans limite de bande
  passante sur le statique (Cloudflare Pages) comme adresse principale, GitHub Pages et les autres en
  miroirs (voir `docs/RESILIENCE.md` et le workflow `mirrors.yml`).

## 2. L'index (relais Nostr)

- **Avant** : chaque visiteur lisait les 16 relais → 10 000 visiteurs = 160 000 connexions WebSocket
  permanentes, ~10 000 par relais. Les petits relais communautaires ne tiennent pas.
- **Maintenant** : chaque visiteur **lit 6 relais tirés au hasard** (toujours les mêmes pendant sa visite)
  et **publie sur les 16**. Charge par relais : ≈ 3 750 connexions (testé : répartition à ± 30 % sur
  10 000 tirages). Une vidéo publiée partout reste visible de tous.
- Tendances de l'accueil : requête ponctuelle sur 3 relais seulement.
- Chaque mur = 2 abonnements multiplexés sur ces connexions (vidéos, annotations par lots de 150).

## 3. Les vidéos (serveurs Blossom)

C'est la couche la plus sollicitée : une vidéo de 30 s ≈ 4 Mo ; regardée par 10 000 personnes = 40 Go.

- **Répartition** : chaque visiteur commence par une copie **différente** parmi celles déclarées par
  l'auteur (rotation par visite) au lieu de tous charger le serveur principal (testé : 1/3 chacun pour
  3 copies). Bascule automatique inchangée si la copie ne répond pas.
- **Préchargement limité** : seule la vidéo à l'écran est chargée entièrement ; les voisines, seulement
  leurs métadonnées.
- **Préservation par les spectateurs** : sur une vidéo virale, 10 000 spectateurs demandant chacun des
  copies = attaque involontaire. Désormais : 1 spectateur sur 20, délai aléatoire de 5 à 60 s, et plus
  aucune copie au-delà de 6 serveurs connus.
- Limite réelle : les serveurs Blossom gratuits peuvent ralentir ou refuser un trafic massif. Le plus
  efficace pour l'éditeur : **un serveur Blossom derrière un CDN** (ou un Blossom payant) ajouté en tête
  de liste, la réplication et la rotation faisant le reste.

### Alléger les fichiers : mesurer avant de changer de format

Réglage actuel : 720 × 1280, 30 i/s, H.264 **Baseline** à 2 Mbit/s + son 96 kbit/s ≈ **16 Mo par
minute**. Pistes, par ordre de sûreté :

1. H.264 **High**, 1,5 Mbit/s, son 64 kbit/s ≈ 11,5 Mo/min (−30 %), lisible partout.
2. **Double version** : H.264 optimisé (universel, part en premier) + **HEVC** ≈ 8,5 Mo/min (−45 à
   −50 %) envoyé ensuite dans la voie de réplication, sur moins de serveurs. Chaque spectateur ne
   télécharge que la version que son appareil sait lire. Rentable dès quelques vues ; décisif sur les
   vidéos virales, qui sont celles qui saturent les serveurs.
3. AV1 : écarté pour l'instant (encodage logiciel trop lent sur la plupart des Android, lecture
   limitée aux iPhone 15 Pro et plus récents).

Les gains annoncés par la littérature (30 à 50 %) viennent d'encodeurs lents de serveurs ; ceux d'un
téléphone en direct sont plus faibles. D'où le **banc d'essai** (Réglages → Diagnostic → « Banc
d'essai des formats vidéo ») : sonde de ce que l'appareil sait enregistrer, encoder en matériel et
lire, puis 20 s filmées **simultanément** dans chaque format (même image, tailles comparables, et
preuve que deux encodeurs tournent en parallèle). Rapport texte à transmettre ; rien n'est envoyé.
Décision à prendre sur les mesures réelles (iPhone, Android milieu de gamme).

## 4. Le navigateur de chaque visiteur

- Mur viral (centaines de vidéos, flux en direct) : le fil ne rend que **3 vidéos de part et d'autre**
  de celle à l'écran ; la grille (ordinateur) affiche des **lots de 60**. Testé : 200 vidéos dans le fil,
  6 médias rendus (contre 202 avant).
- Historique initial : 200 vidéos ; plafond de 12 vidéos par auteur (anti-inondation).

## 5. Ce qui reste à surveiller

- Relais qui imposent un quota par adresse IP (réseaux d'opérateurs mobiles derrière un même NAT).
- Serveurs Blossom gratuits sous forte charge : prévoir un serveur dédié avant un lancement médiatisé.
- Pas de test de charge réel possible depuis l'environnement de développement (réseau fermé) :
  à faire avant un lancement (ex. 500 navigateurs automatisés répartis sur plusieurs machines).
