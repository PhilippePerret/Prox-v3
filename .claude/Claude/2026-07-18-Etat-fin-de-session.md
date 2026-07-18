# État au 2026-07-18 — à lire en premier

## À reprendre en premier

**Essai en live obligatoire — rien de ce qui suit n'a été testé à l'écran ce soir**, uniquement
raisonné/relu dans le code. "Tout ça" à essayer couvre concrètement :

1. **Rendu de base** : les deux pages s'affichent (dernier point confirmé en live par
   l'utilisateur), badges bien positionnés (avant/après recalés sur `placeWordAt`, référence
   pixel-perfect dans `test.js.bak`).
2. **Couleur des badges** : rouge/orange/vert selon la distance, calculée par rapport au seuil
   du CANON (pas 1500 fixe) — `SEUIL_PER_CANON` peuplé avec les 7 conjonctions de coordination
   (mais/ou/et/donc/or/ni/car) à 300, pour avoir du répétitif visible dès le texte de test.
3. **Système curseur/exergue — entièrement réécrit ce soir, jamais vérifié à l'écran :**
   - Clic sur un mot ou sur une lettre dans le texte → doit positionner un curseur clignotant
     (`.fake-cursor`) à l'endroit cliqué, sur la bonne page (gauche ou droite).
   - Flèches clavier (gauche/droite/haut/bas, Alt+flèche, Home/End, Cmd+flèche) → doivent déplacer
     ce curseur normalement.
   - Un mot qui a une proximité avant et/ou après doit allumer (opacité pleine, `.badge.active`)
     son ou ses badges dès que le curseur passe dedans (clic ou flèche) — **0, 1 ou 2 badges** selon
     que le mot a une proximité avant, après, les deux, ou aucune.
   - Clic direct sur un badge → allume UNIQUEMENT ce badge et son partenaire (l'autre bout de la
     même paire), même si le curseur texte n'est pas dessus. Reclic sur un badge déjà allumé →
     l'éteint (toggle).
   - Cas à vérifier en particulier : mot avec proximité AVANT et APRÈS en même temps (canon à
     3+ occurrences rapprochées) — les deux badges doivent s'allumer ensemble depuis ce mot.

## Ce qui a été fait ce soir (chronologique)

**Diagnostic + déblocage de l'affichage (rien ne s'affichait au début de session) :**
- `test.js` ligne ~1197 : `for (tokenIdx, len = ...)` → `ReferenceError` en mode strict
  (`len` jamais déclaré). Corrigé.
- `token.id` → `token.i` (alias SQL réel, cf. `db.py::tokens_from`) : la comparaison avec
  `firstTokenId` ne matchait jamais, `indexFirstToken` restait `undefined`.
- `Br()` retournait une variable jamais déclarée (`bt` au lieu de `br`).
- `spreadRect()` ajoutée : `DOMRect` a ses champs en accesseurs sur le prototype, `{...rect}` ou
  mutation directe (`rect.left += x`) ne marche pas en strict mode.
- `.page` recevait une hauteur CSS auto (grandit avec son contenu) → `PageBottom` mesuré une fois
  avant tout texte donnait un plancher minuscule, dépassé dès la 2e ligne. Fixé : hauteur de
  `.page` forcée à celle de `#pages` (bornée par le flex layout du body, stable).
- Ordre de reset de `badgeX` sur wrap naturel CSS corrigé (se faisait après le calcul de
  `shiftX` au lieu d'avant → 1er mot d'une ligne héritait à tort du décalage de la ligne
  précédente).

**Repositionnement des badges (comparaison avec `test.js.bak::placeWordAt`, référence pixel-perfect signalée par l'utilisateur) :**
- Badge "avant" : était au-dessus du mot, doit être en-dessous (même verticale que "après").
- Badge "après" : était au bord gauche du mot, doit être à son centre + `GAP/4`.
- Centrage du mot par rapport à son badge avant, test de dépassement de ligne, un seul
  `marginLeft` posé puis remesure DOM (au lieu d'un patch manuel de `rect`) — tout recalé sur
  l'algo de référence.
- `BADGE_GAP` (=8) séparé de `GAP` (=12, inchangé) : `GAP` pour centre-mot/bord-badge,
  `BADGE_GAP` pour badge→mot suivant. Décision utilisateur.
- Un token qui n'est pas un mot (ponctuation) n'hérite plus jamais du `badgeX` d'un mot
  précédent — évite l'espace visible avant une virgule collée à son mot.

**Couleur par seuil de canon :**
- `db.py::tokens_from` : jointure sur `canons`, `token.c` devient le TEXTE du lemme (au lieu de
  `canon_id`, entier fragile car dépendant de l'ordre d'insertion dans la base — décision
  utilisateur explicite après un premier essai rejeté).
- `SEUIL_PER_CANON` peuplé (conjonctions de coordination, seuil 300), clé = lemme texte.
- `prepareTokens` mémorise le seuil réel par badge (`befSeuil`/`aftSeuil`) ; `buildNewBadge` pose
  `--badge-rgb` via `repColor(valeur, seuil)` (fonction déjà existante, jamais branchée sur le
  nouveau pipeline avant ce soir).

**Système curseur/exergue (le plus gros morceau, tout untested) :**
- `prepareTokens` génère un id de paire (`befPair`/`aftPair`) partagé entre les 2 occurrences
  d'une proximité — lu partout dans l'ancien code mort mais jamais généré nulle part, même avant.
- `segments` transformé en table indexée par caractère (accès direct `segments[idx]`, O(1)) —
  remplace un scan linéaire, sur demande explicite de l'utilisateur ("pourri"). Chaque segment
  porte aussi `nextSeg`/`prevSeg` (voisin de lecture), pour ne plus dépendre de
  `segments.indexOf`. `wordSegmentsList` (liste des mots uniquement) construite en parallèle,
  pendant la même boucle — pas de passe de filtre séparée.
- Adapté en conséquence : `segmentAt`, `nearestWord`, `rectForIndex`, `describePosition`,
  `wordSegments`, `clampIdx`, `paragraphBoundsAt`, `nextWordBoundary`.
- `buildDOM` alimente `segments`/`wordSegmentsList` dans sa boucle existante (mot, espace,
  saut de paragraphe) via un helper `addSegment`.
- `buildNewBadge` pose `data-pair` (lu par le handler de clic déjà existant dans le code mort,
  jamais alimenté avant).
- `pageForIdx` réécrite en géométrique (`closest('.page')`) — dépendait de `paraStates`, toujours
  vide avec le nouveau pipeline (donc toujours retombait sur la page gauche).
- `updateCursorPairs` lit `segmentAt(cursorIdx).token.befPair/aftPair` directement — chaque
  segment-mot porte une référence directe vers son `token` (pas de tableau global séparé,
  choix fait exprès pour éviter un effet de bord).
- `fullText` volontairement PAS peuplé : vérifié inutile pour tout ce périmètre, seule sa
  longueur comptait dans les fonctions utiles, déjà couverte par `segments.length`.

## Pas touché

- Tout le sous-système de frappe/édition (`insertText`, `backspace`, `deleteForward`,
  `merde_claude_rebuildDOM`, `scheduleRebuild`...) : reste mort, hors périmètre ce soir.
- `updatePageLine` (widget pied de page, position dans le livre entier) : dépend de
  `fullText.length`, qui reste `0` puisque `fullText` n'est pas peuplé — déjà cassé avant ce
  soir (fullText n'était déjà jamais peuplé), pas aggravé, pas réparé non plus.
- `tokenAt()` : devenue orpheline (plus aucun appelant) depuis la réécriture de
  `updateCursorPairs` — laissée en place, pas supprimée.

## Rappel

L'utilisateur édite `test.js` en direct en parallèle de Claude — toujours relire le fichier juste
avant un edit, ne jamais supposer son état à partir d'un tour précédent.
