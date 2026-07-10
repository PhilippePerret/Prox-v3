# Direction technique — décision 2026-06-18

## ABANDON DE Qt/PySide6 POUR L'UI

**Décision prise le 2026-06-18.** L'approche Qt (QTextEdit) est abandonnée pour l'interface éditeur. Raisons :
- Position des badges sous les mots en texte justifié : non fiable (`cursorRect` Qt saute en fin de ligne)
- Dernière ligne d'un éditeur justifié : impossible à justifier avec l'API publique Qt
- Gestion du double éditeur (PG/PD) : trop de contournements fragiles

**Le code Qt existant (`app/main.py`, `app/engine.py`, `app/config.py`) reste dans le dépôt mais n'est plus la cible.**

---

## NOUVELLE STACK

| Couche | Technologie | Rôle |
|--------|------------|------|
| Fenêtre native | **PyWebview v6** | Encapsule WKWebView macOS (moteur Safari, zéro Mo supplémentaire) |
| Éditeur | **ProseMirror** (JS) | Éditeur de texte riche, API Decoration pour badges, `coordsAtPos()` fiable |
| Analyse | **ProxEngine** (Python, inchangé) | Lemmatisation spaCy, détection répétitions |
| Bridge | `window.evaluate_js()` | Python → JS (résultats d'analyse) |
| Import/Export | `python-docx` + `odfpy` | Chargement .docx/.odt, export avec styles préservés (chantier futur) |

---

## ARCHITECTURE CIBLE

```
ProxWindow (PyWebview)
│
├── window.html  ← interface HTML chargée dans WKWebView
│   ├── ProseMirror EditorView (page gauche)
│   ├── ProseMirror EditorView (page droite)  
│   ├── Plugin pagination : détecte overflow, coupe au mot, alimente PD
│   └── Plugin badges : Decoration.widget() sur chaque mot en proximité
│
└── prox_app.py  ← API Python exposée à JS via pywebview
    ├── load_text(path)      → parse ODT/DOCX, retourne JSON de mots
    ├── analyze(text)        → ProxEngine, retourne liste répétitions
    └── save(path, edits)    → reconstruit ODT/DOCX avec corrections
```

---

## PRINCIPES BADGES (décidés, non négociables)

- Badge = `Decoration.widget()` ProseMirror, placé **dans le flux du texte** après le mot cible → suit le mot naturellement dans tout reflow.
- Badge au bord bas de page → retourné au-dessus de la ligne (`placement: 'above'`).
- Couleur : gradient HSV vert (loin) → rouge vif (proche), S=255, V variable (160→220).
- Badge actif (survol ou curseur sur le mot) : fond opaque, texte blanc.
- Badge inactif : fond transparent, bordure colorée visible.
- `←{dist}` : répétition en amont. `{dist}→` : répétition en aval.

---

## ÉTAT DU TRAVAIL — 2026-06-18

### Fait
- [x] `app/engine.py` : ProxEngine complet, lemmatisation spaCy, détection répétitions — **NE PAS TOUCHER**
- [x] `app/config.py` : constantes (seuils, police, marges) — réutilisables
- [x] `assets/texte-modele.txt` : texte de test Maupassant (54242 chars) — ok
- [x] Architecture double-page définie et validée
- [x] Décision PyWebview + ProseMirror prise

### Fait — fin session 2026-06-18
1. [x] PyWebview 6.2.1 installé (`pip install pywebview`)
2. [x] `app/prox_pywebview.py` — fenêtre PyWebview, API Python (`analyze()`), chargement spaCy en thread, push résultats vers JS via `evaluate_js(proxJS.init(data))`
3. [x] `app/static/index.html` — squelette HTML, ProseMirror via CDN (unpkg)
4. [x] `app/static/prox.js` — schéma minimal, deux EditorView, plugin pagination (binary search + reflow), plugin badges (Decoration.widget), navigation PG/PD, bridge Python→JS
5. [x] `app/static/prox.css` — styles pages, badges (avec `.flip` pour bord bas), footer, splash

### Fait — session 2026-06-18 (suite, après compaction contexte)
6. [x] `app/__init__.py` créé (manquait — `python -m app.prox_pywebview` plantait)
7. [x] ProseMirror bundlé offline : `app/static/vendor/prosemirror-bundle.js` (495 Ko, IIFE, esbuild)
     — Les fichiers npm sont des ES modules avec imports bare : incompatibles `<script src>` sans bundler
     — Solution : esbuild bundle → globals `window.prosemirrorModel` etc.
8. [x] `app/static/index.html` mis à jour → charge `vendor/prosemirror-bundle.js` (plus de CDN requis)
9. [x] `app/static/prox.js` réécrit intégralement. Bugs corrigés :
     - Overflow check : `view.dom.parentElement` → `view.dom` (.ProseMirror lui-même)
     - Layout bug : `#editor-pg/pd` manquaient `flex:1 + display:flex + min-height:0`
       → sans ça, `scrollHeight === clientHeight` toujours, binary search mettait tout dans PG
     - Badges via `Decoration.widget` supprimé → remplacé par `coordsAtPos()` + `<span>` dans `.page-wrap`
       → élimine le problème du containing-block CSS (badge positionné par rapport à .ProseMirror, pas au mot)
     - `updateBadges` : offset PD corrigé (espace séparateur PG+PD = +1)
     - Guard `window.pywebview?.api` ajouté dans `runAnalysis`
10. [x] `app/static/prox.css` mis à jour :
     - `#editor-pg, #editor-pd { flex:1; display:flex; flex-direction:column; min-height:0; overflow:hidden }`
     - `.prox-badge` : `position:absolute` dans `.page-wrap` (correct maintenant)
     - Suppression `.prox-word` (inutile avec nouvelle approche badges)

### Fait — session 2026-06-18 (3ème passe, après premier test utilisateur)
11. [x] Premier test utilisateur — résultats :
     - Splash OK, texte affiché PG+PD ✓, navigation ▶/◀ fonctionne ✓
     - Badges absents (cause inconnue → debug=True activé pour voir console)
     - Curseur saute en bas à chaque frappe → reflow 0ms réinitialisait la sélection ProseMirror
     - PD ne se refillait pas après suppression → _bufStart supprimé par erreur
     - Navigation aller-retour imparfaite → pas de pile d'historique
12. [x] `app/static/prox.js` — fixes :
     - Reflow debounce : 0ms → 300ms (frappe fluide)
     - `doReflow` : sauvegarde/restauration curseur avant/après tout setText
     - `_bufStart` restauré + underflow PD ← buffer fonctionnel
     - Navigation : pile `_navHistory` + `_navIdx` → aller-retour exact
     - `runAnalysis` : console.log pour déboguer les badges
     - `updateBadges` : console.log count PG/PD
13. [x] `app/prox_pywebview.py` : debug=True → Web Inspector Safari disponible
14. [x] `app/static/index.html` : splash "Analyse de votre texte en cours…"
15. [x] BUG CRITIQUE : boucle infinie reflow
     - `doReflow()` appelle `setText()` → déclenche `onEdit()` → `scheduleReflow()` → `doReflow()` à nouveau
     - Conséquence : `_analysisTimer` remis à zéro indéfiniment → `runAnalysis()` ne s'exécute jamais → badges absents, console silencieuse
     - Fix : flag `_inReflow = true` au début de `doReflow()` et `fillEditors()`, bloque `onEdit()` pendant tous les setText internes
16. [x] Fixes visuels après 1er test utilisateur :
     - `prox.css` : `.page-wrap` manquait `min-height:0` → scroll parasite en bas de PG
     - `prox.css` : `text-align-last: justify` (dernière ligne justifiée)
     - `prox.js` : `repColor` revu — gradient 3 points vert(H=120)→orange(H=30)→rouge(H=0)
       évite le jaune ocre du gradient linéaire H=120→0
     - `prox.js` : `applyBadgesToView` réécrit — badges créés invisibles, puis en rAF :
       flip bottom, stacking anti-chevauchement par ligne (sort + décalage droite)

### À TESTER MAINTENANT — commencer ici (état après item 21)
```
python3.11 -m app.prox_pywebview
```
⚠️ `python3.11` obligatoire (python3 = 3.14, pas de webview).

**Ce qu'on attend :**
- Splash → texte Maupassant PG+PD, footer "Page 1 / N · X mots"
- Mots répétés : **soulignement coloré permanent** (border-bottom, même sans survol)
- Badges colorés sous les mots
- **Survol d'un mot souligné** : fond coloré + text-shadow sur le mot ET son pair, badges pairs actifs
- **Survol d'un badge** : même comportement
- **Curseur dans un mot souligné** : même exergue automatique
- Couleurs : vert (loin du seuil) → orange → rouge (proche du seuil)

**Pas encore fait :**
- Transfert curseur PG→PD par flèche droite en fin de PG
- Navigation clavier entre pages

### Fait — session 2026-06-18 (4ème passe, hover + exergue mot)
17. [x] `Decoration.inline()` ProseMirror sur chaque mot répété → span `.prox-word`
     - Soulignement coloré permanent (border-bottom) = lien visuel badge↔mot
     - `data-rep-idx` sur le span → même logique d'appairage que les badges
     - `--badge-rgb` en custom property CSS inline → couleur partagée badge/mot
18. [x] Hover sur LE MOT (`.prox-word`) déclenche l'exergue — pas seulement le badge
     - mouseover/mouseout réagissent à `.prox-badge, .prox-word`
     - Transition douce entre éléments du même groupe (relatedTarget check)
19. [x] Curseur dans un mot annoté → exergue automatique
     - `updateCursorHighlight(view, decoKey)` appelé dans `dispatchTransaction` si sélection change
     - `DecorationSet.find(from-1, from+1)` → trouve la décoration sous le curseur
20. [x] Exergue mot = background semi-transparent + text-shadow (simule gras sans reflow)
     - `font-weight: bold` interdit : change la largeur des caractères → décale tout le texte
     - `text-shadow: 0 0 0.5px` = effet visuel "faux gras", zéro impact layout
21. [x] `clearWordDecos()` appelé à chaque changement de page et chaque édition

### Intentions UX notées (à implémenter plus tard)
- Curseur PG→PD via flèche droite en fin de PG (transfert clavier)
- Import ODT/DOCX (python-docx, odfpy)
- Export ODT/DOCX avec styles préservés
- Profils de seuil par mot
- Timeline / pageline

### À faire — plus tard (ne pas anticiper)
- Import ODT/DOCX (python-docx, odfpy)
- Export ODT/DOCX avec styles préservés
- Profils de seuil par mot
- Navigation clavier PG↔PD
- Timeline / pageline

---

## CONTRAINTES UTILISATEUR (absolues)

- L'utilisateur **ne code pas**. Claude écrit tout.
- Numéroter chaque point dans les réponses multi-points.
- Ne jamais lancer `python test_*.py` — l'utilisateur lance lui-même.
- Keyboard-first (pas zéro-souris, mais clavier prime).
- Ne jamais juger les choix techniques. Donner les faits, l'utilisateur décide.
- Ne jamais qualifier un problème de "vrai/réel/important".
- Terme officiel : **badge** (pas "étiquette").
- PG = page gauche, PD = page droite.

---

## FICHIERS CLÉS À LIRE EN SESSION

```
./Bible/__SPEC__.md          ← spec fonctionnelle complète
./dev/Claude/04-nouvelle-direction-2026-06-18.md  ← CE FICHIER (direction technique)
./app/engine.py              ← ProxEngine (ne pas toucher)
./app/config.py              ← constantes réutilisables
```
