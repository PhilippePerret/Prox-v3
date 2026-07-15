# État au 2026-07-14 — à lire en premier

## Où on en est

Session sur 2 pages / badges. **Pas encore confirmé fonctionnel** — dernier fix posé juste avant le
break, log vidé juste avant, aucun relancement rapporté depuis.

## Reprise immédiate

1. Relancer `./test.command`.
2. Lire `/tmp/prox_test_debug.log` (vidé en fin de session précédente, ne contiendra que ce
   nouveau lancement).
3. Chercher la ligne `applyRepetitions: badges dans le DOM apres rebuildDOM = N`.
   - **N > 0 mais rien de visible à l'écran** : les badges existent dans le DOM, c'est un problème
     de rendu visuel (position/CSS/z-index) — nécessite une inspection DevTools réelle (pywebview
     `debug=True` ou équivalent), plus la peine de deviner par les logs seuls.
   - **N = 0** : le problème est encore en amont, dans `placeWordAt`/`syncParagraph` — revoir leur
     version page-aware (paramètre `page` ajouté cette session, cf. plus bas).

## Bugs trouvés et corrigés cette session (tous vérifiés par le raisonnement/logs, PAS par un
lancement visuel réel — pas d'accès display dans cet environnement)

1. **CSS clipping** (`app/static/test.css`) : `#pages` est un flex container à hauteur fixe ;
   `.page` (enfant flex) était étiré à cette hauteur par le `align-items: stretch` implicite +
   `overflow: hidden` — coupait le texte avant même d'atteindre les badges. Fix : `align-items:
   flex-start` sur `#pages`, `overflow:hidden` retiré de `.page` (déplacé sur `#pages`, même rôle
   que l'ancien `body { overflow:hidden }`).
2. **Race modèle spaCy** : `analyze()` appelé une fois au boot (`test.js`), avant la fin du
   chargement spaCy en tâche de fond (~3-4s) → renvoyait `[]` sans jamais relancer. Fix : polling
   JS (`pollModelReady()`, toutes les 1s sur `is_model_ready()`) plutôt qu'un push Python→JS
   (`evaluate_js` depuis un thread annexe, tenté d'abord, abandonné — invérifiable sans lancer
   l'app, remplacé par une mécanique plus simple à vérifier par les logs).
3. **Modèles absents retentés à chaque lancement** : `fr_core_news_lg`/`md` pas installés sur cette
   machine (seul `fr_core_news_sm` l'est), 2 `OSError` à chaque boot avant de tomber sur le bon.
   Fix : nouveau module partagé `app/spacy_model.py` (`load_best_model()`), cache le nom du modèle
   qui a fonctionné dans `app/.spacy_model_cache`, réessaie celui-là en premier. Utilisé par
   `app/test_pywebview.py` ET `app/prox_pywebview.py`. Vérifié en direct (hors webview) : 3.76s →
   0.43s au 2e appel.
4. **`rebuildDOM` ne posait jamais les badges au premier chargement** : ne retouche un paragraphe
   (donc ses badges) que si son TEXTE a changé. Mais `applyRepetitions` change les données de badge
   (`TOKENS[i].before/after`) sans jamais toucher `fullText` — donc rien ne se passait tant qu'aucune
   frappe n'avait eu lieu sur ce paragraphe précis (d'où l'observation utilisateur : "j'édite un
   bout de texte, les badges autour apparaissent"). Fix : paramètre `force` sur `rebuildDOM`, passé
   à `true` depuis `applyRepetitions`.
5. **Crash JS réel** (trouvé via `/tmp/prox_test_debug.log`, capté par le handler `window.addEventListener('error', ...)` déjà en place) : `TypeError: null is not an object (evaluating
   'node.nodeType')` dans `getCaretRect`. Cause : un mot vide (`""`, produit par `split(' ')` sur un
   double espace dans le texte) donne un `<span>` sans `firstChild` — `seg.node.firstChild` vaut
   `null`, passé tel quel à `getCaretRect`. Fix : nouvelle fonction `wordNode(seg)` (fallback sur
   le span lui-même si vide), substituée à tous les `seg.node.firstChild` utilisés pour mesurer un
   mot (`charIndexToDom`, `rectForIndex`, `lineBoundsAt`, `lineBoundsAtTop`, `allLineTops`).

## Instrumentation temporaire en place (à retirer une fois le bug confirmé résolu)

Dans `app/static/test.js` : `dlog()` (trace inconditionnelle vers `debug_log`), `logError()`
(catch sur `analyze().then()`/`applyRepetitions`), et le comptage de badges DOM en fin
d'`applyRepetitions`. Tout passe par `window.pywebview.api.debug_log()` →
`/tmp/prox_test_debug.log`. Ne pas oublier de nettoyer ces traces une fois le problème résolu et
confirmé par l'utilisateur — pas avant.

## Décisions actées cette session

- Split gauche/droite : **par paragraphe entier**, jamais un paragraphe fragmenté entre les deux
  pages (décision utilisateur 2026-07-14, réponse à la question sur le découpage mot/caractère —
  étendue au paragraphe pour la robustesse de l'implémentation). Frontière choisie par
  `computeSplitParaIndex()` : le paragraphe dont la fin est la plus proche de la moitié de
  `fullText`. Conséquence acceptée : pages pas exactement symétriques en nombre de caractères
  (contrairement au chiffre 1500/1500 de `__SPEC__.md`, qui reste une valeur approximative selon
  le texte lui-même — "valeur approximative" déjà noté dans `__SPEC__.md`).
- Pas de détection de débordement vertical (pagination dynamique façon traitement de texte) —
  hors scope pour l'instant, non demandé, non implémenté.

## Fichiers touchés cette session

- `app/static/test.html`, `app/static/test.css`, `app/static/test.js` — refonte 2 pages
  (conteneurs `.page[data-side=left/right]`, structure `PAGES`/`PAGE_LEFT`/`PAGE_RIGHT` côté JS,
  tout ce qui était `pageEl`/`textEl`/`badgeLayer`/`selLayer`/`cursorEl` global devient page-aware).
- `app/test_pywebview.py`, `app/prox_pywebview.py` — utilisent `app/spacy_model.py` au lieu de
  dupliquer la boucle de chargement spaCy.
- `app/spacy_model.py` — nouveau, module partagé.
- `app/.spacy_model_cache` — nouveau, fichier de cache (contient juste le nom du modèle, ex.
  `fr_core_news_sm`).

## Autres notes (reprises de la session précédente, toujours valables)

- `_dev/Todo.md` porte "NE DOIT PAS ÊTRE LU PAR CLAUDE" — ne pas ouvrir.
- `app/static/test.js.bak` : fichier de sauvegarde ancien, inerte, repéré cette session, pas
  touché — pollution potentielle à nettoyer un jour mais pas urgent.
