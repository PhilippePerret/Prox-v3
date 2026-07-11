# Journal — éditeur DOM (bugs / remarques / avancées)

## 2026-07-11

- Point 12 (liste `34-comportements-editeur.md`) — Entrée en début de mot : curseur passe bien à la
  nouvelle ligne (confirmé par log : idx=110, rect top passe de 112 à 164). Note du 2026-07-10
  disait bug ouvert — comportement actuel déjà correct. Aucune modification faite par Claude cette
  session sur `test.js` (fichier toujours untracked, aucun diff) : la correction, si elle a eu
  lieu, est antérieure et non tracée.

- Nouveau : après avoir coupé un paragraphe en deux (Entrée en milieu de texte), la ligne du dessus
  (devenue dernière ligne du premier paragraphe) reste justifiée au lieu de s'aligner à gauche
  (comportement attendu d'une dernière ligne de paragraphe justifié).
  Cause repérée dans `test.css` ligne 18 : `text-align-last: justify;` sur `#page` — cette règle
  s'applique à la dernière ligne de chaque boîte de bloc, y compris chaque `.para`, donc à la
  dernière ligne de CHAQUE paragraphe, pas seulement à la dernière ligne du texte entier.

- Nouveau : après la coupure de paragraphe (Entrée), curseur en tout début de la nouvelle ligne,
  "←" ne remonte pas à la ligne précédente.
  Piste (lecture de code seulement, pas confirmée par un log/observation en direct — l'inspecteur
  web plante dans cette fenêtre, cf. note du 2026-07-10) : dans `rebuildDOM` (`test.js`), quand un
  paragraphe se termine par un espace (cas normal ici : le texte avant "mot" finit par un espace),
  `paraText.split(' ')` produit un dernier élément vide (`""`), qui devient un `<span class="word">`
  SANS aucun texte dedans (pas de `firstChild`). Ce span vide occupe exactement l'index où se
  trouve le caractère `\n` (même position que le segment de rupture qui suit). `segmentAt` le
  trouve avant le segment de rupture pour cet index, et `charIndexToDom` demande alors
  `seg.node.firstChild` sur ce span vide → `null` → passé à `getCaretRect(null, ...)` qui accède à
  `node.nodeType` sur `null` : exception JS. À confirmer par un `debug_log` ciblé ou autre moyen si
  utile.

  → Fix tenté (à vérifier par l'utilisateur) : `test.css` — suppression de
  `text-align-last: justify;` (ligne 18). `test.js` `rebuildDOM` — plus de span/segment vide créé
  pour l'espace final d'un paragraphe.

- Nouveau : après coupure de paragraphe, "←"/"→" autour du saut de ligne demandent chacun une
  pression en trop (une position "avalée" sans effet visuel) — sensation d'un caractère invisible
  avant le premier mot du nouveau paragraphe.
  Cause : à l'index exact du retour à la ligne, le segment espace (fin de l'ancien paragraphe) et
  le segment de rupture revendiquent la même frontière ; `segmentAt` retenait l'espace, dont la
  logique de rendu regardait alors le mot APRÈS le saut au lieu de rester en fin de ligne
  précédente.
  → Fix tenté (à vérifier) : `rectForIndex` (`test.js`) force le rendu "fin de ligne précédente"
  dès que l'index correspond au début d'un segment de rupture, indépendamment du segment que
  `segmentAt` aurait choisi.
  → Insuffisant : l'espace invisible (largeur nulle en fin de ligne justifiée) fait toujours
  qu'une des deux positions adjacentes ne bouge rien à l'écran — le fix précédent a juste déplacé
  le problème de l'autre côté du saut de ligne.
  → Fix tenté #2 (à vérifier) : nouvelle fonction `visualStep` (`test.js`) — pour ←/→ (pas
  Alt+flèche), si le déplacement d'un caractère ne change pas le rectangle affiché à l'écran, on
  saute directement d'un caractère de plus. Chaque pression doit produire un mouvement visible.

- Lag ressenti entre pression flèche et déplacement visible du curseur, dès le départ (indépendant
  de la position). Pistes testées :
  1. `logCursor` appelait `debug_log` à chaque déplacement (aller-retour JS↔Python↔disque) —
     coupé temporairement (`DEBUG_LOG_ENABLED = false` dans `test.js`) pour tester. Résultat de
     l'utilisateur : "difficile à dire", pas de nette amélioration.
  2. Hypothèse retenue : le clignotement du curseur (`test.css`, `@keyframes blink`) avait une
     phase invisible de 500ms sur un cycle de 1s, indépendante des déplacements — si une flèche est
     pressée pendant cette phase, le curseur semble ne pas bouger jusqu'à la fin du cycle.
     → Fix tenté (à vérifier) : phase invisible réduite à 150ms (`0%,84% opacity:1` /
     `85%,100% opacity:0`) et redémarrage du clignotement à chaque déplacement (`renderCursor` dans
     `test.js`, reset de `cursorEl.style.animation`), pour que le curseur soit toujours visible
     juste après un mouvement.

- Point 13 (accents/saisie composée) :
  - Touche simple ("é") : OK.
  - Alt+lettre ("Option+ç" → "Ç") : ne s'affichait pas — le handler `keydown` excluait tout
    `e.key.length===1` dès que `alt` était pressé, alors que `e.key` contient déjà le caractère
    final composé (rien à faire de spécial). → Fix fait (`test.js`, condition `!alt` retirée) : à
    vérifier.
  - Composition en deux temps (accent qui s'affiche seulement au 2e appui — ex. "^" puis "e" → "ê",
    ou "Alt+n" puis "n" → "ñ" sur clavier Mac, même mécanisme) : seule la 2e touche s'affiche, sans
    l'accent. Piste : ce type de composition est en principe géré nativement par le navigateur via
    les événements `compositionstart`/`compositionupdate`/`compositionend`, mais a priori seulement
    sur un élément éditable (input/textarea/contenteditable) — ici tout est de simples `<span>` non
    éditables, donc ces événements pourraient ne jamais se déclencher. Pas encore de fix tenté :
    demande peut-être une prise de focus sur un input caché pour capter la composition, à voir.

- Changement d'architecture pour la composition (accents, touches mortes) : ajout d'un champ
  `<input>` caché (`#hidden-input`, `test.css` : position fixe -2000/-2000), seule source de vérité
  pour la frappe — garde le focus en permanence (`document`, `keydown` : refocus systématique s'il
  l'a perdu). Le texte tapé/composé y est récupéré via son événement `input` (`flushHiddenInput`
  dans `test.js`), fusionné dans `fullText`, puis le champ est vidé. Le clavier (flèches, Home/End,
  Backspace/Delete, Entrée, Tab) reste géré directement par le `keydown` global comme avant, sans
  passer par le champ caché.
  Tab est branché pour valider une correction (`validateCorrection`, pas encore implémenté — juste
  la touche pour l'instant), Entrée reste le retour à la ligne normal (décision du 2026-07-11, voir
  mémoire projet).
  À tester : composition (accents/touches mortes), frappe normale, Alt+lettre, toutes les
  navigations déjà validées avant ce changement (rien ne devrait avoir changé côté flèches/clic).
  Simplification (2026-07-11) : plus besoin de lire ni vider le contenu du champ caché à chaque
  frappe — le texte tapé/composé est pris directement sur l'événement (`data`), le champ accumule
  sans qu'on s'en serve. Vidage seulement après un temps d'inactivité (debounce), pas à intervalle
  fixe (qui pourrait tomber en pleine frappe).
  Confirmé par l'utilisateur : plus de lag à la frappe (la vidange à chaque touche était bien en
  cause) ; retour à la ligne et suppression du retour à la ligne fonctionnent avec cette nouvelle
  architecture.

- Confirmé par l'utilisateur : "↑"/"↓" (garde la position horizontale), Meta+←/→ (début/fin de
  ligne), Meta+↑/↓ (début/fin de paragraphe — Ctrl+flèches abandonné, intercepté par macOS avant
  d'atteindre l'appli, vérifié par log vide). Entrée supprime maintenant l'espace en fin de
  paragraphe précédent si elle existe.

- Priorité basculée vers l'affichage/comportement des badges (proximités) — algo de placement dans
  `_dev/Bible/adocs/badges.adoc`. Étape 1 (sur 6, découpage validé par l'utilisateur) : badge sous
  un mot, centré, avec un nombre dedans — sans encore GAP/2-badges/anti-chevauchement/espacement
  custom/couleur. Détection de répétition faite en JS local, minimale, juste pour avoir des mots
  répétés à tester (sera remplacée par l'analyse Python réelle).
  Étapes suivantes (déjà actées) : 2. deux badges (avant+après) avec GAP, 3. mot de 2 lettres avec
  un seul badge, 4. espacement mot à mot calculé à la main (abandon du `justify` natif) pour que
  personne ne passe au-dessus d'un badge qui ne lui appartient pas, 5. anti-chevauchement entre
  badges voisins, 6. couleur (dégradé vert/orange/rouge).

  Étape 2 confirmée par l'utilisateur (badge avant/après avec GAP, actualisation en direct).
  Étape 3 : règle abandonnée par l'utilisateur (retirée de `badges.adoc`, "les mots de deux lettres
  subissent le même traitement") — code retiré, sans objet.
  Étape 4 (en cours) : justification calculée à la main faite (espaces en `<span class="space">`,
  largeur distribuée par ligne, dernière ligne de paragraphe non-justifiée). PAS ENCORE fait : la
  partie "aucun mot au-dessus d'un badge qui ne lui appartient pas" — liée à l'anti-chevauchement de
  l'étape 5, pas encore implémentée. Changement de structure DOM associé : les espaces ne sont plus
  des noeuds texte nus mais des `<span>`, `charIndexToDom`/`domToCharIndex` mis à jour en
  conséquence — à surveiller si un comportement déjà validé (clic, sélection, flèches) se
  dérègle.

## Pour plus tard

- "↑"/"↓" ne fait rien : pas de cas `ArrowUp`/`ArrowDown` dans le handler `keydown` de `test.js` —
  le curseur devrait changer de ligne visuelle. Pas encore traité.
