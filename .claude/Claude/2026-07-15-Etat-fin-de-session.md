# État au 2026-07-15 — à lire en premier

## Où on en est

Session longue, deux fronts : (1) badges/affichage `test.js` réellement fonctionnels pour la
première fois, (2) début d'une base SQLite (`app/db.py`) par document. Splash + barre de titre
dynamique ajoutés. Dernière action avant la pause : barre de titre portée dans
`test_pywebview.py`, **pas encore confirmée par un lancement réel**.

## Reprise immédiate

1. Relancer `./test.command`. Vérifier : splash sans barre de titre → texte+badges avec barre de
   titre (mécanisme `_set_titlebar`, PyObjC, `NSWindowStyleMaskTitled`, copié de
   `prox_pywebview.py` où il existait déjà et fonctionnait — raté par une recherche grep trop
   étroite avant d'être trouvé).
2. `DEBUG_START_MOT_ID = 356` (haut de `test_pywebview.py`) : ne fonctionne qu'au **second**
   lancement après un lancement où ce mot a déjà été vu (la base ne couvre que le dernier
   segment analysé, pas tout le livre — voir "Limite connue" plus bas). Si le premier lancement
   de la reprise part encore de 0, relancer une deuxième fois avant de conclure à un bug.

## Bugs trouvés et corrigés cette session (test.js)

1. `syncParagraph` ignorait le paramètre `force` transmis par `rebuildDOM(true)` — badges jamais
   posés du tout (retour anticipé avant tout `placeWordAt`). Fix : `force` désormais transmis et
   respecté (saute l'early-return texte-inchangé et le `stabilized`-break).
2. `buildTokens` : comptait un espace après le dernier mot de CHAQUE paragraphe (qui n'existe pas
   — c'est un `\n`) → dérive cumulative d'1 caractère par paragraphe traversé.
3. `applyRepetitions` : matching offset en égalité stricte ratait les mots élidés (`j'ai`,
   `l'Invisible` — spaCy scinde, JS garde le mot entier) → remplacé par recherche par plage
   (offset contenu dans le mot).
4. `placeWordAt` : `pageEl.getBoundingClientRect()` + `getComputedStyle` recalculés à CHAQUE mot
   (531 fois) alors qu'identiques pour toute une page/passe → hissés dans `syncParagraph`, calculés
   une fois par paragraphe.
5. `#pages.hidden` utilisait `display:none` → mesures DOM (`getBoundingClientRect`) toutes à zéro
   pendant que `placeWordAt` tournait avant le premier reveal → tous les mots un par ligne, badges
   empilés en haut à gauche. Fix : `visibility:hidden` (garde la boîte de layout).

## Perf — ce qui a été mesuré, pas deviné

Log horodaté (`dlog`, `performance.now()` JS + `time.time()` Python, préfixe `[Nms]`/`[PY t]` sur
chaque ligne de `/tmp/prox_test_debug.log`) a isolé le vrai coût : ~4000ms = chargement spaCy en
tâche de fond (une fois par lancement de process), ~240ms = IPC + calcul Python + boucle DOM
`placeWordAt` complète (531 mots, 162 badges). Hypothèse initiale (coût `getBoundingClientRect`
par mot) fausse — la boucle DOM entière ne prend que 20ms.

Banc `_dev/bench-offsets/` NE mesure PAS ça : aucun DOM, aucun spaCy live, juste calcul
offset/gap en chaîne pure — pas comparable au coût réel observé.

## Splash (décision utilisateur 2026-07-15)

Texte+badges cachés jusqu'à modèle spaCy chargé ET première analyse résolue (`reveal()` dans
`applyRepetitions`, un seul déclenchement, `revealed` flag). `test.html` (`#splash` + `#pages`
avec classe `.hidden`), `test.css` (styles splash, `visibility:hidden`), `test.js`
(`startWithRealText` ne construit plus rien avant modèle prêt, `pollModelReady` inchangé sinon).

## Fenêtre de lecture (décision utilisateur 2026-07-15)

Validée : 2000 (caché avant) + 1500 (page gauche) + 1500 (page droite) + 2000 (caché après) =
7000 caractères. Première ouverture (position 0) : pas de portion cachée avant (évident).
`test_pywebview.py` : `VISIBLE_LEN=3000`, `HIDDEN_AFTER=2000` branchés. `HIDDEN_BEFORE=2000`
**déclaré, jamais utilisé** — nécessite la fonctionnalité "réouverture à une position enregistrée"
(pas implémentée, pas de persistance de position hors `historique_lecture`, voir plus bas).

## Base SQLite — `app/db.py` (une base par document, décision utilisateur 2026-07-15)

Schéma actuel :
- `canons(id, canon, ignored)` — lemme, global au document.
- `mots(id, longueur, canon_id, ignored)` — **TOUS les tokens** du texte, dans l'ordre, mots ET
  ponctuation (décision explicite : ne jamais filtrer avant stockage, même les mots que
  `ProxEngine` ignore pour le calcul des répétitions — ceux-là sont juste marqués `ignored=1`,
  jamais absents de la séquence). `id` **sans** `AUTOINCREMENT` (corrigé cette session : avec
  `AUTOINCREMENT`, SQLite ne réutilise jamais un id après `DELETE FROM mots`, cassant le principe
  "section toujours indexée depuis 0" — `MAX(id)` grimpait sans fin alors que la table ne
  contenait qu'un seul segment à la fois).
- `historique_lecture(id, first_mot_id, date, start_prox_count, end_prox_count, start_prox_taux,
  end_prox_taux)` — log, une ligne par point de suivi. `start_prox_taux`/`end_prox_taux` :
  échelle 0.00–1.00 (2 décimales), distance 1500→mini, distance 0→maxi, formule actuelle
  `1 - distance/1500` moyennée (formule libre selon l'utilisateur, seules les bornes comptent).

Câblage dans `test_pywebview.py::analyze()` : à chaque appel, `db.replace_mots(self._db, doc)`
(doc spaCy récupéré séparément — `engine.py` ne l'expose pas et ne doit pas être modifié, donc
re-tokenisation redondante du même texte, coût accepté). Historique : 1er `analyze()` de la
session = `start_session()` (nouvelle ligne), suivants = `update_session_end()` sur la même ligne.

**Point non résolu, signalé mais pas câblé** : l'utilisateur a précisé que CHAQUE navigation
(page suivante, page N, "prochaine proximité d'un mot") doit créer une NOUVELLE ligne
`historique_lecture`, pas mettre à jour l'existante — mais aucune fonctionnalité de navigation
n'existe encore dans `test.js` (seulement l'édition sur place). Le jour où navigation est codée,
il faudra `self._session_id = None` avant chaque saut pour forcer une nouvelle ligne.

**Limite connue, signalée, pas résolue** : `mots` est un cache du DERNIER segment analysé, pas un
index du livre entier. `db.offset_of_mot()`/`DEBUG_START_MOT_ID` ne fonctionnent que pour un id
déjà vu dans un segment précédemment analysé (persiste d'un lancement à l'autre via le fichier
`.db`, mais ne couvre jamais tout le livre d'un coup). Un vrai "aller n'importe où" demande
l'analyse complète en tâche de fond mentionnée dans `__SPEC__.md` (pas implémentée).

**Imprécision résiduelle connue, pas corrigée (consigne explicite : ne pas complexifier)** :
`offset_of_mot()` suppose 1 caractère de séparateur après chaque token (`longueur+1`) — faux
quand un mot est collé à sa ponctuation (`dit-il`, `sommes,`) → dérive de quelques caractères par
transition collée. Mesuré : 2 caractères d'écart sur un exemple de 17 tokens avec 2 transitions
collées. Pas de colonne `gap` ajoutée (proposée, rejetée par l'utilisateur comme sur-ingénierie).

## Barre de titre dynamique (portée depuis `prox_pywebview.py`, PAS encore testée)

`prox_pywebview.py` cachait déjà la barre de titre au démarrage et la réaffichait à la fin du
chargement du modèle spaCy (`_set_titlebar`, PyObjC, bit `NSWindowStyleMaskTitled`). Ce
mécanisme n'existait PAS dans `test_pywebview.py` — porté cette session (même fonction, mêmes
points d'appel : caché dans `on_loaded`, réaffiché en fin de `_load_model()`). Jamais vérifié
visuellement (pas d'accès display dans les sessions Claude) — **premier test à faire à la
reprise**.

## Icônes

10 SVG dans `icons/` (5 versions fines `icon-*.svg` + 5 versions grasses `icon-*-v2.svg`, accent
rouge-orange `#FF5A36`), fond blanc coin-arrondi macOS. Aucune choisie/validée.

## Autres notes

- `_dev/Todo.md` porte "NE DOIT PAS ÊTRE LU PAR CLAUDE" — ne pas ouvrir.
- Timeline/pageline (visualisation position dans le livre) : existe dans l'ancien code
  (`app/static/prox.js` ~lignes 466/476/698, `#footer`/`#pageline` dans `index.html`, styles
  `prox.css`) — stack pywebview/ProseMirror abandonné pour l'éditeur mais ce fichier-là n'a pas
  été détruit. Jamais porté dans `test.html`/`test.js`. Signalé à l'utilisateur, pas de décision
  de portage prise.
- Instrumentation `dlog`/`logError`/horodatage : laissée en place, utilisateur a dit que ça ne le
  dérange pas pour l'instant ("des tests d'efficacité seront encore à faire").
- `.claude/feedbacks/respecter-decisions-actees.md` : récidive notée cette session (décision
  d'implémentation prise seul — persistance position en JSON — rejetée, corrigée).
- Reste de `__SPEC__.md` (import .odt/.docx, poids/profils, mots exclus, export, analyse
  contextuelle, édition interactive à retester) : explicitement reporté par l'utilisateur
  ("on verra ça plus tard").
