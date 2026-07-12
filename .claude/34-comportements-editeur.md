# Liste des 34 comportements à valider — éditeur DOM maison

Contenu original (`~/.claude/plans/modular-beaming-meerkat.md`, formulation exacte "on fait X → il
se passe Y" par item) perdu — fichier écrit hors projet, effacé en fin de session. Reconstitution
ci-dessous d'après le résumé de `_dev/Claude/05-abandon-prosemirror-dom-maison-2026-07-10.md`,
groupée par catégorie, PAS la formulation d'origine item par item.

## Confirmé fonctionnel (utilisateur)

1. Curseur au clic — position via `caretRangeFromPoint` + mesure `Range`
2. Sélection par glissé souris
3. Sélection Maj+clic
4. Sélection Maj+flèches
5. Sélection Alt+flèches (saut de mot)
6. Double-clic (sélection mot)
7. Triple-clic (sélection ligne visuelle, comparaison de rectangles)
8. Frappe clavier — insertion
9. Frappe clavier — backspace/delete avec fusion de mots
10. Frappe clavier — backspace/delete avec scission de mots
11. Entrée — saut de paragraphe (`\n` dans `fullText`)

## Confirmé fonctionnel (utilisateur)

18. Espacement des badges / placement des mots (avant/après, GAP, décalage) — algo conçu et
    validé par l'utilisateur (`placeWordAt`, `test.js`), testé dans tous les sens. Ce point n'est
    PAS ouvert, ne plus le lister comme "pas encore testé".

## Pas encore testé

14. Copier-coller
15. Annuler (undo)
16. Rétablir (redo)
17. Justification maison
19. Survol souris sur badge (indépendant du problème mousemove/mouseover global)
20. Branchement de l'analyse Python (`window.pywebview.api.analyze(text)`)
