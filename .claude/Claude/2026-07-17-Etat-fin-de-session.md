# État au 2026-07-17 — à lire en premier

## À reprendre en premier

- Reconstruire `segments` (offset caractère → nœud DOM) en structure réellement optimisée — PAS un
  tableau plat à parcours linéaire (rejeté ce soir, forme cible non décidée, à redemander).
- AVANT ça : `test_pywebview.py::load_window()` renvoie encore `{tokens, total_chars, start_offset}`
  (anciens noms) alors que `textRender()` (JS) attend `{TOKENS, total_chars, firstTokenId}` — sans
  ce raccord, aucun test live possible (splash bloqué, promesse rejetée silencieusement, pas de
  handler `unhandledrejection` dans `test.js`).
- Puis continuer le remplacement pas à pas de l'ancien pipeline DOM par les fonctions de
  l'utilisateur (voir plus bas).

## Nouveau pipeline (`app/static/test.js`), en cours, écrit majoritairement par l'utilisateur

`textRender()` (point d'entrée) → `prepareTokens()` (une passe : offsets `o`/`om`, proximités par
canon `Map<canon_id,{seuil,last}>`, `token.bef`/`token.aft`) → `buildDOM()` (une passe : mots,
paragraphes, pages en remplissage dynamique, badges — portage pièce par pièce de l'ancien
`placeWordAt`, style `Div()`/`Span()`/`Br()`/`px()`). Manque encore : `segments`, suivi par-mot
(paraStates-like), synchro de `fullText`.

## Nettoyage

4 fonctions mortes supprimées (0 appelant vivant) : `merde_claude_applyProximites`,
`merde_claude_buildTokenIndex`, `merde_claude_markOrphanBadges`, `merde_claude_startWithRealText`.
Reste tout le sous-système curseur/frappe/sélection de l'ancien modèle (`quickSync*`, `insertText`,
`setCursor`, `segmentAt`, etc.) — vivant (câblé au clavier/souris) mais déconnecté (opère sur
`fullText`/`TOKENS` jamais alimentés par le nouveau pipeline). Prochaine cible de nettoyage, pas
fait ce soir.

## `app/db.py`

Colonne `is_alphanum` ajoutée à `tokens` (alias `t`). Pas de migration (décision : phase
d'expérimentation, on refait la table). `assets/texte-modele.db` supprimé pour forcer régénération.

## Rappel

L'utilisateur édite `test.js` en direct en parallèle de Claude — toujours relire le fichier juste
avant un edit, ne jamais supposer son état à partir d'un tour précédent.
