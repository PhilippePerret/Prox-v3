# État au 2026-07-13 — à lire en premier

## Décisions actées (cf. `_dev/Bible/__SPEC__.md`, table "État des lieux")

- **DOM-editor (placement mots/badges, édition interactive) : JS**, continuité de `app/static/test.js`. Vérifié via l'API réelle de `pywebview` (`webview.window.Window`) : seules `evaluate_js`/`run_js`/`load_html`/`load_css`/`load_url` exposées côté Python, aucune lecture de géométrie DOM (`getBoundingClientRect`, `caretRangeFromPoint` n'existent que dans le moteur de rendu JS). PySide6/Qt natif écarté (retour en arrière, déjà abandonné il y a plusieurs mois).
- Python reste limité à l'analyse spaCy (`ProxEngine`, `app/engine.py`, ne pas modifier).
- Pagination (spec `Requis` de `__SPEC__.md`) : app n'analyse JAMAIS tout le texte d'un coup. Fenêtre = ce qui est VISIBLE = **3000 caractères en 2 pages** (pas 6000 — terminologie "fenêtre" précisée par l'utilisateur). + 3000 caractères cachés après (nom pas encore fixé — "virtuelles" proposé par l'utilisateur, à confirmer). Premier chargement : depuis position 0, pas de portion cachée avant. Rechargement : portion cachée avant + après existe aussi (détail exact 1500/1500/1500/1500 vs 2000/4000 pas totalement réconcilié — ne pas trancher seul, redemander).
- Analyse complète du texte tourne en tâche de fond pendant l'inactivité, persistée en base (SQLite pressenti, pas encore implémenté), rechargée au lieu d'être refaite.

## Code modifié aujourd'hui

- `app/test_pywebview.py` : ajout `TestAPI.load_window()` — lit `assets/texte-modele.txt`, retourne `{texte_complet, fin_visible}` (3000 visibles + 3000 cachés après, constantes `VISIBLE_LEN`/`HIDDEN_LEN`).
- `app/static/test.js` : `fullText` (portion visible/éditable) et `hiddenTail` (portion cachée, jamais affichée/éditable, envoyée en plus à `analyze()` pour les proximités) remplacent l'ancien texte de stress généré aléatoirement (`generateStressText`, supprimé). `TOKENS` passé de `const` à `let` (reconstruit après chargement réel). Algorithme de placement des badges (`placeWordAt`, `syncParagraph`, `rebuildDOM`, `segments`) **non touché**, réutilisé tel quel.
- Lancé (`python -m app.test_pywebview`) : démarre sans erreur. **Pas de vérification visuelle possible dans cette session (pas d'accès display)**.

## À REPRENDRE EN PREMIER

**Constat de l'utilisateur en fin de session** : "on n'avait pas nos deux pages mais seulement un grand éditeur qui prenait toute la fenêtre." → **La couche DONNÉES (3000 visible / 3000 caché) est en place, mais la mise en page visuelle en 2 pages/colonnes n'existe pas** : `app/static/test.css`/`test.html` n'ont qu'un seul conteneur `#page`/`#text` en flux continu, pas deux colonnes séparées. `config.py` a déjà une constante `PAGE_GUTTER` (40) qui suggère que ce découpage était prévu mais jamais câblé.

**Premier travail de demain** : construire réellement la mise en page 2 pages (CSS colonnes ou deux conteneurs `#page-gauche`/`#page-droite`), sans toucher à l'algorithme de placement des badges (`placeWordAt`) — voir comment il gère déjà les retours à la ligne forcés (`rightLimit`, insertion de `<br>`) pour comprendre s'il faut l'adapter à une largeur de colonne au lieu de la largeur de `#page` entière.

## Autres notes

- `_dev/bench-offsets/` rangé et fonctionnel (racine : `benchmark.command`, `README.md`, `report.html` ; tout le reste dans `lib/`). Canon jamais vide partout. `report.html` trié par perf, arrondi, surlignage vert par colonne.
- Feedbacks utilisateur notés : `.claude/feedbacks/opinion-quand-demandee.md`, `.claude/feedbacks/respecter-decisions-actees.md`.
- Le fichier `_dev/Todo.md` porte la mention "NE DOIT PAS ÊTRE LU PAR CLAUDE" — ne pas l'ouvrir.
