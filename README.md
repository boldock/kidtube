# KidTube

Un lecteur YouTube pour les enfants qui ne montre **que les chaînes choisies par les parents**.
C'est un site statique (HTML/CSS/JS) : pas de serveur, pas de compte, pas de dépendance.

## Fonctionnalités

- **Accueil** : une carte par chaîne. Avec la clé d'API, chaque carte montre la dernière vidéo (vignette, durée, titre, chaîne, date, début de la description), et un clic la lance. Sans clé, la carte affiche la photo ou l'emoji de la chaîne.
- **Lecteur limité aux chaînes autorisées** : le lecteur `youtube-nocookie.com` joue toutes les vidéos de la chaîne choisie (ou une playlist précise). Le lecteur est isolé (*sandbox* sans popups ni navigation), donc l'enfant ne peut pas partir vers YouTube.
- **Espace parents protégé par un code PIN**, créé au premier accès à ⚙️ :
  - ajouter, retirer et réordonner les chaînes ;
  - limiter le temps d'écran par jour, ajouter 15 min ou remettre le compteur à zéro ;
  - exporter ou importer les réglages en JSON (pour les copier sur un autre appareil) ;
  - clé d'API YouTube facultative, pour afficher les **photos de profil des chaînes** et ajouter une chaîne à partir de son `@pseudo`. Sans clé, chaque tuile affiche son emoji.
- **Liste des vidéos de la chaîne** à côté du lecteur (si une clé d'API est renseignée), avec deux onglets, « 🆕 Récentes » et « ⭐ Populaires ». Un clic lance la vidéo, et les suivantes de la liste s'enchaînent. Les directs et les vidéos non intégrables sont écartés.
- **Installable** sur une tablette ou un téléphone (« Ajouter à l'écran d'accueil »).

Les réglages sont enregistrés dans le navigateur (`localStorage`). Ils sont donc propres à chaque appareil.

## Lancer

YouTube refuse d'afficher le lecteur quand la page est ouverte en `file://`. Il faut donc servir les fichiers par HTTP(S) :

```sh
python3 -m http.server 8000   # puis http://localhost:8000
```

Pour l'héberger gratuitement, utilisez **GitHub Pages** : *Settings → Pages → Deploy from branch → `main` / root*.

## Ajouter une chaîne

Dans ⚙️, collez l'un des éléments suivants :

- l'ID de la chaîne (`UC…`) : sur la chaîne, « plus » → « Partager la chaîne » → « Copier l'ID de la chaîne » ;
- un lien `https://www.youtube.com/channel/UC…` ;
- un lien de playlist (`…?list=PL…`), pour ne proposer qu'une sélection de vidéos ;
- un `@pseudo`, seulement si une clé d'API YouTube Data v3 est renseignée.

La liste par défaut se trouve dans `js/channels.js`.

## Photos des chaînes

Les photos de profil sont récupérées avec l'API YouTube Data v3, qui demande une clé gratuite :

1. Sur [console.cloud.google.com](https://console.cloud.google.com), créez un projet.
2. « API et services » → « Bibliothèque » → activez **YouTube Data API v3**.
3. « Identifiants » → « Créer des identifiants » → « Clé API ».
4. Conseillé : restreignez la clé à cette API et à l'adresse de votre site.
5. Collez la clé dans ⚙️ → Réglages. Les photos se chargent alors toutes seules.

La même clé sert à la liste des vidéos. Pour économiser le quota gratuit de l'API (10 000 unités par jour), les listes sont gardées en cache : 3 h pour les récentes, 24 h pour les populaires. L'onglet « Populaires » coûte environ 100 unités par chaîne et par jour ; « Récentes » environ 2.

Les adresses des photos sont enregistrées avec les chaînes et incluses dans l'export. Une chaîne peut aussi avoir un champ `avatar` dans `js/channels.js`.

## Structure

```
index.html            page unique
css/style.css         styles
js/channels.js        chaînes par défaut
js/app.js             logique (lecteur, PIN, temps d'écran, réglages)
manifest.webmanifest  installation sur l'écran d'accueil
icon.svg              icône
```

## Limites

- Le code PIN et la limite de temps sont stockés côté navigateur. Ils suffisent pour un jeune enfant, mais un utilisateur averti peut les contourner en effaçant les données du site.
- Le temps d'écran est compté tant que le lecteur est ouvert et visible, même quand la vidéo est en pause.
