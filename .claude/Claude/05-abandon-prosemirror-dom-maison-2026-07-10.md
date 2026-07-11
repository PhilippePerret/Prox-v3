# Abandon de ProseMirror — éditeur DOM maison — 2026-07-10

## Décision

Après un mois de bugs difficiles à isoler avec ProseMirror (clic bloqué par un repère posé sur un
mot répété, collision des badges avec la justification CSS, survol souris introuvable),
**ProseMirror est abandonné**. Nouvelle direction : éditeur 100% maison — chaque mot/ponctuation
dans son propre `<span>`, position et justification calculées à la main.

Le fichier `04-nouvelle-direction-2026-06-18.md` (PyWebview + ProseMirror) est donc lui-même
dépassé sur la partie éditeur JS. `app/static/prox.js`, `prox.css`, `index.html` restent en l'état
(dernière version fonctionnelle connue avec ProseMirror) mais ne sont plus la cible.

## Fait, confirmé, indépendant de ProseMirror

Deux limites de plateforme (PyWebview + WKWebView sur macOS), vérifiées rigoureusement, à garder
en tête quelle que soit l'architecture d'éditeur choisie :
- `mousemove` et `mouseover`/`mouseout` (survol passif de la souris, sans clic) ne se déclenchent
  jamais dans cette fenêtre — testé au niveau `document`, phase capture, aucun événement sur
  plusieurs secondes de mouvement, même après avoir activé `acceptsMouseMovedEvents` côté fenêtre
  native macOS.
- `webview.start(debug=True)` (Web Inspector) fait planter l'application au démarrage dans cet
  environnement.
- Le glissé souris (bouton enfoncé + déplacement), en revanche, **fonctionne** — confirmé dans le
  nouvel éditeur de test (voir plus bas). C'est un mécanisme différent (mouseDragged natif) de la
  survol passive.
- Piste non vérifiée mais concrète : `/Users/philippeperret/Programmes/Board` est une appli Swift
  native (WKWebView + `isInspectable = true`, pas de crash d'inspecteur) — suggère que les deux
  limites ci-dessus pourraient venir spécifiquement de la bibliothèque Python PyWebview, pas de
  WKWebView en tant que tel. À vérifier un jour si utile.

## Méthode de travail imposée par l'utilisateur

Chaque comportement précis de l'éditeur est testé, seul, dans la vraie fenêtre PyWebview, avant
d'écrire l'éditeur définitif. Liste complète des comportements à valider (34 au total, un par
ligne, formulés "on fait X → il se passe Y") : voir le plan sauvegardé à
`/Users/philippeperret/.claude/plans/modular-beaming-meerkat.md`.

Fichiers de test (indépendants de l'appli principale, pas besoin de spaCy) :
- `app/static/test.html`, `app/static/test.css`, `app/static/test.js`
- `app/test_pywebview.py` — lanceur minimal (`python -m app.test_pywebview`)
- `test.command` — double-clic pour lancer

## État des tests (au 2026-07-10 soir)

Confirmés fonctionnels par l'utilisateur :
- Curseur au clic (tests 1-5) — position via `caretRangeFromPoint` + mesure `Range` (pas
  `coordsAtPos`, jamais fiable pour la hauteur).
- Sélection complète (tests 6-15) — glissé souris, Maj+clic, Maj+flèches, Alt+flèches (saut de
  mot), double-clic (mot), triple-clic (ligne visuelle, détectée par comparaison de rectangles).
- Frappe clavier de base (insertion, backspace/delete avec fusion/scission de mots automatique —
  le modèle édite `fullText` comme une simple chaîne, pas de cas particulier nécessaire).
- Entrée (saut de paragraphe) — un `\n` dans `fullText`, comme n'importe quel caractère.

**Bug ouvert, non résolu** : après avoir pressé Entrée en début de mot, le mot passe bien à la
ligne suivante, mais le curseur affiché reste visuellement sur l'ancienne ligne. Tracé à la main
sans trouver la cause exacte (le calcul d'index semble correct sur le papier). Un journal de
diagnostic silencieux est déjà branché (`window.pywebview.api.debug_log`, écrit dans
`/tmp/prox_test_debug.log`, relu via `cat`) — à utiliser en rejouant ce scénario précis (curseur en
tout début d'un mot, toucher Entrée) avant de continuer à deviner.

Pas encore testés : saisie composée/accents (test 26), copier-coller (27), annuler/rétablir
(28-30), justification maison + espacement des badges (31-32, le cœur du problème initial),
survol souris sur badge (33, indépendant), branchement de l'analyse Python (34).

## Contrat Python à préserver (ne change pas)

- `window.pywebview.api.analyze(text)` → liste de
  `{offset_a, forme_a, offset_b, forme_b, distance}`
- `proxJS.init(data)` reçoit au démarrage `{text, total_words, total_chars, seuil}`
- `app/engine.py` (ProxEngine) : ne pas toucher.

## Points de méthode/communication à respecter (voir aussi la mémoire globale Claude)

- Jamais de code montré à l'utilisateur, jamais de numéro de ligne comme moyen d'explication —
  langage clair, l'utilisateur a 40 ans de développement web mais ne regarde pas ce code-ci.
- Jamais d'ordre déguisé ("clique sur X") — formuler en besoin ("j'aurais besoin de X") ou, si une
  action de l'utilisateur est vraiment nécessaire, "pourrais-tu X, s'il te plaît ?" (forme exacte
  donnée par l'utilisateur).
- Aucun jargon/anglicisme technique pour nommer les choses (ex. "spike" rejeté) — dire "on teste".
- Ne jamais demander à l'utilisateur de distinguer "ancienne/nouvelle version du code" — c'est mon
  travail de savoir ce qui tourne, pas le sien.
- Ne pas transformer une correction cosmétique mineure en point de vérification séparé — l'intégrer
  et enchaîner sur le test suivant.
