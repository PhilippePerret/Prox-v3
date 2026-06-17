# Questions ouvertes — à trancher

_Document de travail — session 2026-06-16_

Ces points n'ont pas encore été décidés. À aborder dans l'ordre lors des prochaines sessions.

---

## Architecture interne

- **Format de l'index en mémoire** : `dict[canon → list[offset]]` ? Ou structure plus riche incluant le mot original, le contexte ?
- **Recalcul en temps réel** : quand l'utilisateur modifie un mot dans l'éditeur, comment recalcule-t-on l'index ? Recalcul partiel (zone modifiée uniquement) ou recalcul global ? À quel rythme (debounce) ?
- **Séparation moteur / UI** : le moteur d'analyse (index, calcul distances, profils) sera une classe Python pure, sans dépendance Qt. L'UI Qt consomme le moteur via une API claire. À formaliser.

---

## Format des fichiers

- **Profils de poids** : YAML ? JSON ? Structure exacte ?
- **Fichier de session** : stocké où ? Nom dérivé du document source ? Format ?
- **Configuration globale** : fichier unique ou plusieurs fichiers (un par "projet") ?

---

## Gestion des modifications

- Quand on remplace un mot dans Prox, est-ce toujours un remplacement simple (1 mot → 1 mot) ou peut-on supprimer / ajouter plusieurs mots ? La spec dit "édition complexe" — comment Qt gère ça et comment l'index se met à jour ?
- Cas limite : on remplace "il marchait" par "il avançait d'un pas lourd" — l'offset de tous les mots suivants change. Recalcul global inévitable dans ce cas ?

---

## UI Qt — points techniques

- Les **annotations inline** (étiquettes de distance avant/après) : `QTextCharFormat` avec tooltip ? Ou widget custom dans le flux du texte ? À prototyper tôt.
- Le **popup au survol** (ignorer, actions rapides) : `QToolTip` custom ou `QMenu` contextuel ?
- Le **curseur de niveau** (mode Niveau) : `QSlider` dans une barre d'outils ?

---

## Périmètre de la première version

À décider : qu'est-ce qui est dans la v1 et qu'est-ce qui attend ?

Candidats v1 : import .odt, éditeur, modes affichage, navigation clavier, export .odt, session, profil par défaut.

Candidats v2+ : import .docx, outil profils, profils multiples, calibration IA, mode "écriture directe".
