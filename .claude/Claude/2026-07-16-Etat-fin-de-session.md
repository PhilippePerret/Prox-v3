# État au 2026-07-16 — à lire en premier

## À FAIRE EN PREMIER DEMAIN (demande explicite de l'utilisateur)

Contrôler l'algorithme de définition des `before`/`after` (proximités) — le retester
systématiquement pour trouver où il se trompe. L'utilisateur n'est pas convaincu qu'il soit
fiable, malgré la vérification faite ce soir sur le cas "dans"/858 (confirmée correcte à ce
moment-là). Pas de cas précis signalé pour l'instant — audit général demandé, pas un bug ponctuel.
Cf. section "Piste non résolue" plus bas pour un candidat déjà identifié (chevauchement de badges
en zone dense, pas encore confirmé comme un bug de données).

## Chaîne de bout en bout — refonte quasi complète aujourd'hui

Le point de départ (session précédente) : mot coupé en tête/fin de fenêtre visible, dû au
découpage du texte par nombre de caractères bruts (`VISIBLE_LEN`, `offset_of_mot` approximatif).
Corrigé en changeant l'unité de base : la fenêtre chargée est maintenant une liste de TOKENS
entiers (jamais un fragment de token), et tout le reste (offset relatif, proximités, avant/après)
se recalcule à partir de cette liste.

### Base (`app/db.py`)
- Table `mots` → `tokens`. Colonnes : `mot` (texte réel du token), `longueur`, `wspace` (séparateur
  RÉEL après le token — `spaCy tok.whitespace_`, jamais un `+1` supposé), `canon_id`, `ignored`.
- `offset_of_mot()` (approximatif) supprimé. `char_offset_before()` ajouté (exact, usage
  affichage seulement — jamais pour découper du texte brut).
- Migration automatique : `historique_lecture.first_mot_id` → `first_token_id` sur une base déjà
  existante (sinon crash `OperationalError`, corrigé ce soir — c'était la cause d'un des crashs
  signalés).

### `app/test_pywebview.py`
- `load_window()` : charge `WINDOW_TOKENS=7200` tokens depuis un id de départ (`tokens_from`),
  plus aucun découpage de texte brut. Bootstrap borné (tokenise un fragment du début du fichier)
  si la base `tokens` est vide — gère le tout premier lancement.
- Retourne aussi `total_chars`/`start_offset` (position dans le livre entier, pour la pageline du
  footer).
- `debug=False` (remis, un essai avec `debug=True` pour ouvrir l'inspecteur WebKit a été fait puis
  annulé sur demande explicite — pas la cause du crash finalement identifié).

### `app/static/test.js` / `test.css` / `test.html`
- Offset relatif + proximités calculés EN JS (`assignOffsets`, `assignProximites` — groupement par
  canon, paires consécutives, écart < seuil), plus en Python pour l'affichage initial. Mesuré :
  différence de perf négligeable en absolu (7000 tokens : ~1.3ms Python vs ~0.2ms JS), mais
  nécessaire pour permettre, plus tard, le recalcul en direct pendant la frappe.
- **Second passage Python (`analyze()`/`pollModelReady`/`requestAnalysis`) entièrement retiré** —
  produisait un rendu incohérent avec le premier passage JS (mots décalés différemment d'un appel
  à l'autre). Un seul rendu maintenant, calculé au chargement.
  **Conséquence non résolue** : la frappe (`insertText`/`scheduleRebuild`) ne recalcule plus AUCUNE
  proximité — les badges restent figés sur ce qu'ils étaient au chargement, même après édition.
  Et la table `tokens` n'est plus jamais réalimentée après le bootstrap (plus d'appel à
  `replace_tokens`) — la fenêtre chargée reste celle du bootstrap tant qu'aucune autre mécanique
  n'est branchée.
- Couleur des badges : 3 couleurs FIXES (rouge/orange/vert par tiers de distance), plus de
  dégradé continu (décision utilisateur — un dégradé produisait trop de cas illisibles).
- Exergue : clic sur un mot (curseur) OU clic sur un badge (toggle) allume la paire (`data-pair`,
  classe `.active`). Rien au survol (retiré sur demande explicite). `#pages.has-exergue` masque
  tous les autres badges quand une paire est active.
- Badges orphelins (partenaire absent du DOM visible) : bordure pointillée (`.badge.orphan`),
  calculé par `markOrphanBadges()` — DOIT tourner APRÈS `clipOverflowParagraphs()` (un partenaire
  cascade par la coupure de page compte comme absent).
- Coupure nette de bas de page (`clipOverflowParagraphs`) : deux bugs trouvés et corrigés ce soir
  avant que ça fonctionne vraiment — (1) la limite était mesurée sur la hauteur de `.page`
  lui-même, qui n'est jamais bornée (`align-items:flex-start`, grandit avec son contenu) au lieu
  du conteneur `#pages` (borné par flex) ; (2) la référence de coupure doit être le bas du badge
  sous un mot, pas seulement le bas du mot (sinon badge invisible alors que le mot, lui, tenait).
- Footer porté depuis l'ancien `app/static/prox.js`/`prox.css`/`index.html` (jamais présent dans
  `test.html` avant ce soir) : pageline (position proportionnelle dans le livre entier), stats
  (mots/caractères), boutons ◀▶ **présents mais désactivés** — la vraie pagination demanderait que
  `load_window()` accepte un point de départ arbitraire côté Python, pas fait.
- Layout CSS revu : `body` en colonne flex, `#pages` prend l'espace restant (`flex:1;
  min-height:0`), footer en flux normal (plus en `position:fixed` superposé) — élimine
  structurellement le chevauchement footer/texte vu en tout début de session.
- Interligne réduit 68px → 60px (essai "à peine", pour voir si ça récupère des proximités
  actuellement hors fenêtre visible).

## Vocabulaire — interdiction rappelée plusieurs fois ce soir

Ne jamais dire/écrire "répétition"/"reps" (code ou conversation) — toujours "proximité"/"prox".
Appliqué partout dans le code cette session (`applyRepetitions`→`applyProximites`, etc.), sauf
`engine.py::get_repetitions()` (API imposée par ce fichier, qui ne doit pas être modifié).

## Piste non résolue

Chevauchement visuel de badges en zone dense (plusieurs mots proches avec badges avant ET après
chacun) — pas confirmé comme un bug de données (le cas "dans"/858 étudié ce soir avait une donnée
correcte), plausiblement un problème de `placeWordAt`/`marginLeft` qui ne repart pas toujours
d'une mesure "naturelle" propre. Pas creusé plus loin.

## Outil de vérification visuelle (nouveau ce soir)

Chrome headless (`--headless --screenshot`) chargeant `test.html`/`test.css`/`test.js` réels avec
un mock minimal de `window.pywebview.api` et de vrais tokens (extraits de la vraie base) — permet
de voir le rendu réel sans lancer pywebview (pas de display dans ces sessions). Fichiers de travail
dans le dossier scratchpad de session (pas dans le projet, donc perdus d'une session à l'autre) ;
captures utiles copiées dans `_dev/screenshots/2026-07-16-*.png`.

## Autres notes

- `test.command` : ne reste plus ouvert après lancement (testé puis annulé sur demande) — log
  quand même le code de sortie dans `/tmp/prox_test_error.log`.
- `_dev/Todo.md` porte "NE DOIT PAS ÊTRE LU PAR CLAUDE" — ne pas ouvrir.
- Feedback récidive notée cette session : `.claude/feedbacks/` — pas de nouveau fichier créé (déjà
  couvert par l'interdiction 6 existante, doublon refusé par l'utilisateur).
