# Résilience maximale : étude et plan

> Objectif fixé : qu'aucune entité extérieure (État, hébergeur, plateforme, attaquant) ne puisse
> **bloquer l'accès**, **supprimer les vidéos** ou **faire tomber le service**, y compris sous attaque
> (déni de service distribué, saisies, pressions juridiques), tout en restant **accessible par un
> simple navigateur**, sans application à installer.

## En bref (pour non-techniciens)

Le mot que vous cherchiez : on parle de **résistance à la censure** et d'architecture **sans point
unique de défaillance** (*no single point of failure*). L'idée la plus proche de votre intuition
« plus il y a d'attaques, plus le réseau se renforce » s'appelle l'**antifragilité**. Le principe :
tout ce qui existe en un seul exemplaire (un nom de domaine, un serveur, une entreprise) est une cible.
Il faut que **chaque élément existe en de nombreux exemplaires indépendants**, dans des pays et chez
des opérateurs différents, et que l'application sache passer de l'un à l'autre toute seule.

HashWall est déjà construit ainsi (aucune base centrale, vidéos copiées sur plusieurs serveurs,
lecteur qui bascule seul). Ce document recense **ce qui reste attaquable** et comment le renforcer,
couche par couche, du plus efficace au plus expérimental.

Ce qui est **réaliste dans un navigateur** et ce qui **ne l'est pas** :

| Idée | Dans un navigateur ? | Verdict |
|---|---|---|
| Des dizaines de serveurs et relais au lieu de 5–6, découverts automatiquement | Oui | ✅ à faire en priorité |
| Les **spectateurs** recopient les vidéos qu'ils regardent vers d'autres serveurs | Oui (sans consommer leur forfait) | ✅ priorité |
| L'app connaît et affiche ses **adresses de secours**, mises à jour même si le site principal tombe | Oui | ✅ priorité |
| Transmettre une vidéo **sans Internet** de téléphone à téléphone (AirDrop, Quick Share, Bluetooth du système) puis la publier plus tard | Oui, via le partage natif du téléphone | ✅ priorité |
| Réseau maillé **Bluetooth** automatique type BitChat (Jack Dorsey) | **Non** : iPhone n'expose pas le Bluetooth aux sites web ; Android seulement en mode limité | ❌ dans le navigateur — ✅ par **interopérabilité** : BitChat parle Nostr, nos fichiers peuvent transiter par lui |
| Échanges **pair-à-pair** entre navigateurs (WebRTC) sur un même mur | Oui, mais complexe | 🟠 étape ultérieure |
| Site **.onion** (Tor) | Oui pour regarder ; la caméra est bridée dans Tor Browser | ✅ comme miroir supplémentaire |
| Hébergement de l'app sur **IPFS / Arweave** (stockage permanent, sans hébergeur unique) | Oui | ✅ à déployer |

## 1. Modèle de menace

| Attaque | Cible | Effet sans protection |
|---|---|---|
| Blocage DNS / SNI / IP par un fournisseur d'accès | le nom de domaine du site | le site ne s'ouvre plus |
| Saisie du nom de domaine, pression sur l'hébergeur | domaine, GitHub Pages, Cloudflare | site supprimé |
| Retrait de vidéos (injonction de 1 h, DMCA) | serveurs Blossom | vidéo introuvable |
| Blocage des relais Nostr par le FAI | relais | mur vide, publication impossible |
| Déni de service distribué (DDoS) | relais, serveurs, site | ralentissement, indisponibilité |
| Coupure d'Internet locale (manifestation, réseau saturé ou coupé) | réseau mobile | rien ne passe |
| Inondation de spam / faux signalements | le mur | mur illisible ou censuré par signalements |
| Copie malveillante du site (miroir piégé) | utilisateurs | vol de clé, fausse application |

## 2. Défenses par couche

### 2.1 Accès à l'application (le « site »)

Déjà en place : application 100 % statique (aucun serveur à faire tomber), routage par `#hashtag`
(le mur fonctionne sur **n'importe quelle** adresse qui sert les fichiers), **service worker** : une fois
visité, le site se relance hors ligne et même si son domaine est bloqué.

À faire :
1. **Adresses de secours intégrées** — l'app embarque une liste de miroirs (domaines dans plusieurs
   juridictions, passerelles IPFS par sous-domaine, adresse `.onion`) et **une liste signée publiée sur
   Nostr** par la clé du projet : même si tous les domaines connus tombent, une app déjà installée
   récupère les nouvelles adresses via les relais. Écran « Adresses de secours » avec QR codes.
2. **Déploiement multi-origines** automatisé : GitHub Pages, Cloudflare Pages, Netlify, Codeberg Pages
   (UE), IPFS (épinglage chez plusieurs services + DNSLink), **Arweave** (stockage payé une fois,
   permanent, servi par des dizaines de passerelles), miroir `.onion`.
3. **Intégrité des miroirs** : chaque version publiée avec son empreinte (CID IPFS) signée par la clé
   du projet ; l'écran « À propos » affiche l'empreinte de la version qui tourne pour comparaison.
4. Diagnostic « réseau bloqué » : si aucun relais ne répond, l'app explique quoi faire (VPN, Tor,
   autre adresse) au lieu d'afficher un mur vide.

### 2.2 Index (relais Nostr)

Déjà en place : 6 relais, supervision et reconnexion.
À faire :
1. **15 à 30 relais par défaut** dans des juridictions variées, plus les relais déclarés par les auteurs
   (NIP-65, kind 10002) et les moniteurs de relais (NIP-66) : la liste s'étend toute seule.
2. Publication sur **tous** les relais connus pour chaque vidéo (coût : quelques kilo-octets).
3. Encourager des **relais communautaires** (un relais tient sur un petit serveur ou un Raspberry Pi) :
   notice d'installation fournie.
4. Relais joignables en `.onion` pour les utilisateurs de Tor.

### 2.3 Stockage des vidéos (serveurs Blossom)

Déjà en place : 1 serveur principal + 2 miroirs, lecteur qui bascule, empreinte SHA-256 identique partout.
À faire, par ordre d'impact :
1. **Réplication par les spectateurs** (« Préserver cette vidéo », et option automatique) : chaque
   spectateur peut demander à d'autres serveurs de copier la vidéo **de serveur à serveur** (`/mirror`) :
   aucun coût pour son forfait. Plus une vidéo est vue, plus elle existe en exemplaires — c'est
   l'**antifragilité** recherchée : tenter de la supprimer la fait se multiplier. Les copies sont
   annoncées sur Nostr (NIP-94, kind 1063) pour que tout le monde les trouve.
2. **Découverte automatique de serveurs** : agréger les serveurs déclarés par les utilisateurs (kind
   10063) et les tester (sonde) → des dizaines de serveurs au lieu de 5.
3. Copie sur **IPFS** / **Arweave** pour les vidéos d'intérêt majeur (persistance sans opérateur).
4. **Sauvegarde locale** : bouton « Télécharger » (déjà présent, vérifié par empreinte) + rediffusion
   ultérieure par quiconque possède le fichier : comme l'adresse est l'empreinte, n'importe quelle copie
   ré-envoyée est la même vidéo.

### 2.4 Coupure d'Internet : stocker, transporter, publier (*store-and-forward*)

Technique éprouvée des réseaux tolérants aux coupures (DTN). Dans le navigateur :
1. Le témoin filme **sans réseau** ; l'app prépare un **paquet signé** : la vidéo, l'événement Nostr
   pré-signé et les autorisations d'envoi pré-signées (valables plusieurs jours).
2. Il transmet le paquet par le **partage natif** du téléphone (AirDrop, Quick Share, Bluetooth,
   messagerie, clé USB…) — c'est le système d'exploitation qui fait le pair-à-pair, pas le site.
3. N'importe qui ayant du réseau ouvre HashWall → « Publier un paquet reçu » : il ne fait que
   **transporter** ; il ne peut ni modifier la vidéo ni en usurper l'auteur (tout est signé).
4. Compatible avec **BitChat** et autres messageries maillées qui transportent des fichiers.

### 2.5 Pair-à-pair entre navigateurs (étape ultérieure)

WebRTC permet à des navigateurs sur un même mur de s'échanger directement événements et vidéos
(signalisation via les relais Nostr). Chaque spectateur devient un petit serveur temporaire.
Limites : complexité, consommation de batterie et de forfait, réseaux d'opérateurs qui bloquent les
connexions directes. À réserver après les étapes précédentes.

### 2.6 Déni de service

Une application statique servie par plusieurs CDN encaisse très bien les attaques volumétriques ;
relais et serveurs Blossom sont nombreux et indépendants : l'attaquant doit tous les viser. Le client
tolère déjà les pannes (bascule, disjoncteur des serveurs muets). Contre l'inondation de contenus :
plafond par auteur, dédoublonnage, signalements vérifiés (preuve de travail), listes de modération.

## 3. Plan d'exécution

| # | Mesure | Où | Effort | État |
|---|---|---|---|---|
| R1 | Réplication par les spectateurs + annonces NIP-94 des copies | code | moyen | ✅ livré (bouton + automatique) |
| R2 | Adresses de secours (liste intégrée + liste signée sur Nostr) + écran + diagnostic « réseau bloqué » | code | moyen | ✅ livré — reste à **publier** la liste (clé du projet) |
| R3 | Paquets hors ligne signés + partage natif + « Publier un paquet reçu » | code | élevé | ✅ livré |
| R4 | Découverte automatique de serveurs Blossom et de relais (10063, 10002, NIP-66) | code | moyen | 🟠 partiel : 16 relais sondés, serveurs 10063 des auteurs utilisés pour les copies ; NIP-65/66 à faire |
| R5 | Déploiement multi-origines (Codeberg, IPFS épinglé, Arweave, .onion) | exploitation | variable | nécessite des comptes de l'éditeur |
| R6 | Pair-à-pair WebRTC entre spectateurs | code | élevé | plus tard |

Ce qui dépend de l'éditeur (comptes, argent, serveurs) : noms de domaine dans plusieurs pays, comptes
d'épinglage IPFS, jetons Arweave, petit serveur pour le miroir `.onion` et un relais communautaire,
clé Nostr du projet (et ses dépositaires) pour signer la liste des miroirs.

## 4. Ce qui est livré (1ᵉʳ nov. 2026)

### R1 — Les spectateurs multiplient les copies
- Menu d'une vidéo → **« Préserver cette vidéo »** ; réglage **« Préserver les vidéos que je regarde »**
  (activé par défaut) : après 5 s de visionnage d'une vidéo sans signalement, copie de serveur à serveur
  (`PUT /mirror`) vers 2 serveurs qui ne l'ont pas encore. Limites : une toutes les 20 s, 50 par jour,
  jamais deux fois la même.
- Jetons et annonce signés par une **clé jetable** : rien ne relie ce qu'un spectateur regarde à son identité.
- Annonce NIP-94 (kind 1063, tags `url`/`fallback`/`x`) ; les lecteurs n'acceptent que des URL https
  **contenant l'empreinte** (une annonce ne peut pas rediriger vers un autre fichier : le lecteur
  télécharge par empreinte et les serveurs Blossom la vérifient).
- Le lecteur ajoute ces copies à ses sources **même après avoir tout essayé** (testé : serveurs d'origine
  bloqués, lecture depuis une copie découverte par Nostr).
- Cibles : serveurs de l'utilisateur + serveurs déclarés (kind 10063) par les auteurs du mur.

### R2 — Adresses de secours
- `src/lib/mirrors.ts` : liste intégrée (`VITE_MIRRORS`) + **liste signée** kind 30078
  (`d = hashwall-mirrors`) par la clé du projet (`VITE_PROJECT_NPUB`), mise en cache : une app déjà
  installée apprend les nouvelles adresses par les relais même si toutes les anciennes sont bloquées.
  Une liste signée par une autre clé est ignorée (testé).
- Écran **Réglages → « Adresses de secours »** : adresses avec lien vers le mur courant, QR code local,
  copie, partage ; conseils (Wi-Fi/données, VPN, Tor Browser, autres relais).
- **Bandeau « Aucun relais ne répond »** après 15 s sans relais (au premier plan) (ou « Hors ligne ») avec accès direct
  à ces conseils : un mur vide ne passe plus pour un mur sans vidéos.
- Publier la liste : `HASHWALL_PROJECT_NSEC=nsec1… node scripts/publish-mirrors.mjs "https://…|Libellé" …`
  sur un ordinateur de confiance (republier la liste **complète** à chaque fois).

### R3 — Hors ligne : stocker, transporter, publier
- Envoi échoué (pas de réseau) → **« Confier la vidéo à un proche »** : un fichier `.mp4` **qui reste
  une vidéo lisible**, auquel on ajoute une boîte MP4 `uuid` finale contenant l'événement kind 34236
  **déjà signé** et une autorisation d'envoi BUD-11 signée, limitée à cette empreinte et aux serveurs
  de l'auteur, valable 7 jours. Partage natif (AirDrop, Quick Share, Bluetooth…) ou enregistrement.
- Le porteur : **Réglages → « Publier une vidéo reçue »**. Vérifications hors ligne : signature de
  l'événement, empreinte de la vidéo, cohérence du `d`, autorisation (auteur, empreinte, expiration).
  Il envoie le fichier une fois puis demande des copies de serveur à serveur, publie l'événement tel
  quel et annonce les adresses réelles (NIP-94, clé jetable). Il ne peut rien modifier ni usurper.
- Le paquet peut passer de main en main sans réseau (chaîne de porteurs), et transiter par BitChat ou
  toute messagerie qui transporte des **fichiers** (pas les messageries qui recompressent les vidéos).
- Limites : pas d'horodatage OpenTimestamps hors ligne (l'auteur peut republier plus tard : même `d`) ;
  pas de vignette (le lecteur affiche la vidéo) ; Safari impose deux gestes (préparer, puis partager).

### R4 — Plus de relais
- 16 relais par défaut, tous vérifiés par la sonde depuis GitHub Actions (connexion, NIP-11, requête
  kind 34236) ; 7 candidats écartés avec la raison dans `src/config.ts`. `blossom.yakihonne.com` ajouté
  aux serveurs. Les anciennes listes par défaut sont oubliées automatiquement (`LEGACY_DEFAULT_RELAYS`).
- À faire : relais déclarés par les auteurs (NIP-65), moniteurs de relais (NIP-66), test d'**écriture**
  par la sonde (aujourd'hui elle ne fait que lire, pour ne rien publier).

## 5. Ce qui reste hors de portée d'un navigateur, et pourquoi

- **Maillage Bluetooth automatique** (BitChat) : iOS n'expose pas le Bluetooth aux sites web. Le
  paquet hors ligne (R3) passe par le partage natif du système, qui, lui, utilise Bluetooth/Wi-Fi direct.
- **Pair-à-pair WebRTC** (R6) : faisable, mais réseaux mobiles souvent incompatibles (CGNAT) sans serveur
  TURN — qui redevient un point central. À réévaluer après des tests réels de R1–R3.
- **Domaines, IPFS, Arweave, .onion** (R5) : demandent des comptes et un peu d'argent de l'éditeur ;
  le code est prêt (base relative, routage par fragment, liste signée des miroirs).
