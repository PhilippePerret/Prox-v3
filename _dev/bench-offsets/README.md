# Banc d'essai — offset + gap par mot

Dossier isolé, ne fait pas partie de l'app (rien dans `app/` ne dépend de ces fichiers).
Sert à choisir, de manière chiffrée, la meilleure manière (la plus rapide) de procéder à l’analyse et la construction d’un texte analysé par Spacy..

**Le texte de plus d’un million de caractères se trouve dans un fichier** (le système de « répétitions » ci-dessous a été refusé pour bêtise brute). Ce fichier ce trouve également dans ce dossier.

Ce texte a été analysé par `spaCy` et **l’analyse a été persistée** dans un fichier qui sera utilisé comme base de référence pour tous les essais de ce banc.

Les essais consistent à :

- charger les données d’analyse spacy du texte,
- pour JS en SPLIT-SPACE, il faut également charger le texte complet,
- produire une constante TOKENS qui reprend les informations spacy (canon toujours défini, jamais vide),
- produire un document HTML (python) ou un DOM (JS) du texte complet, où chaque mot est un span définissant `data-canon=<canon>`.

Chaque opération générale sera chronométrée pour produire un benchmark lisible et précis (cf. plus bas).

---

Ce banc d’essais aura **deux systèmes de chargement du texte** : 

1. par chargement complet d’un coup (`READ-FULL-TEXT`)
2. par lecture en streaming (`READ-STREAMING`

Chaque banc d’essai aura **deux langages de traitement** :

1. en python (`PY`)
   _Note : tous les bancs en python devont compter le temps de chargement du document HTML final._
2. en JavaScript (`JS`)

**Trois techniques algorithmiques** seront utilisées :

- **`SPLIT-SPACE`** — Le texte est découpé en paragraphes (`\n`) et espaces pour être reconstitué dans le fichiers HTML/DOM. L’analyse est effectuée à côté par spaCy.
- **`SPACE-CSS`** — Le texte est tokenizé par _spaCy_. Il est ensuite parcouru en compartant les offsets et les longeurs de mots pour repérer les espaces. La formule `spa = <offset mot suivant> - (<ofset mot> + <longueur mot>)` retourne 1 en cas d’espace et 0 dans le cas contraire. Cela donne une classe `s<spa>` (« s0 » ou « s1 ») qui est attribué à chaque span de mot/ponct.
  _Note : quand on dit « longueur de mot » ci-dessus, il s’agit évidemment de nombre de caractère (faut être débile pour penser à autre chose)_
- **`SPACE-CALC`** — (« espace par calcul »). Même formule que ci-dessus, mais au-lieu d’affecter une classe CSS particulière, une espace est ajoutée au flux.



> **Ce banc d’essais sera _impérativement_ effectué en passant le texte par `spaCy`**. Mais l’analyse sera enregistrée une fois pour toutes (en fonction cependant des paramètres de l’analyse s’il y en a — par exemple pour obtenir en données la longueur des mots) dans une base ou autre fichier persistgant que chaque test utilisera.

Ces conditions dessinent donc les **12 tests** à produire, **AVEC CES NOMS EXACTS** : 

**NE PAS METTRE « BANC D’ESSAI » AVANT CES TITRES !!!** (mettre juste un « BANC D’ESSAIS » général comme titre principal).

1. `READ-FULL-TEXT/SPLIT-SPACE/JS`
2. `READ-FULL-TEXT/SPLIT-SPACE/PY`
3. `READ-STREAMING/SPLIT-SPACE/JS`
4. `READ-STREAMING/SPLIT-SPACE/PY`
1. `READ-FULL-TEXT/SPACE-CSS/JS`
2. `READ-FULL-TEXT/SPACE-CSS/PY`
3. `READ-STREAMING/SPACE-CSS/JS`
4. `READ-STREAMING/SPACE-CSS/PY`
1. `READ-FULL-TEXT/SPACE-CALC/JS`
2. `READ-FULL-TEXT/SPACE-CALC/PY`
3. `READ-STREAMING/SPACE-CALC/JS`
4. `READ-STREAMING/SPACE-CALC/PY`

Pour chacun de ces tests on fera apparaitre : 

- temps de chargement de l’analyse spaCy (`Spacy analyse loading`)
- temps de production de TOKENS complet (`Tokens Fullfillment`)
- temps de production du code HTML (`HTML building`)
- temps de chargement du document HTML en l’ouvrant dans un navigateur (avec attente du document complet) (`Html doc loading`) — mettre à 0 pour JS si aucune ouverture n’est nécessaire.

---



***La suite, gardée à titre consignatoire, a été rédigée par Claude et ne doit donc pas être utilisée ni suivi.***



## Les 3 techniques (mêmes algorithmes en Python et en JS)

- **BE1 `TOKEN SPACY`** : un seul passage sur tout le texte avec une regex (mots = suites de
  caractères non-espace). L'offset de chaque mot vient directement de la position du match
  (calculé par le moteur regex, pas par nous). Le `gap` (0 si le mot est collé à un retour à la
  ligne/à la fin du texte, 1 si suivi d'une espace normale) est déduit après coup par soustraction
  entre deux offsets consécutifs : `gap = offset_suivant - offset - longueur_du_mot`.
- **T2 `SPLIT JS`** : découpage classique, paragraphe par paragraphe (`split('\n')`) puis
  mot par mot (`split(' ')`). Le `gap` est connu directement par la position dans la boucle
  (dernier mot d'un paragraphe → 0, sinon → 1), sans repasser par une soustraction d'offsets.
  Aucune chaîne "reconstruite" nulle part — seul le `gap` (0/1) est gardé.
- **T3 `split_with_space_rebuild`** : même découpage que T2, mais reconstruit en plus, mot après
  mot, une chaîne où l'espace/le saut de ligne est explicitement rajouté (comme le faisait le
  code d'origine avec ses noeuds texte espace séparés). Sert à isoler le coût de cette
  reconstruction en plus du simple calcul d'offset/gap.

`largeur du mot` = nombre de caractères (`len(forme)` / `forme.length`), pas une mesure à l'écran.
Aucun DOM ni aucune mesure visuelle dans ce banc d'essai — le DOM n'intervient que plus tard,
uniquement pour le placement des badges et la justification (hors sujet ici).

Chaque technique reconstruit le texte d'origine à partir de ses tokens+gaps et vérifie l'égalité
avec un `assert` (Python) / `throw` (JS) — si une technique a un bug d'offset, le script plante
au lieu de donner un résultat silencieusement faux.

## Lancer

Python (nécessite l'interpréteur avec spaCy pour cohérence avec le reste du projet, mais ce banc d'essai n'utilise pas spaCy lui-même) (ET POURQUOI DONC PUTAIN ?????!!!!:
```
/opt/homebrew/opt/python@3.11/bin/python3.11 _dev/bench-offsets/lib/bench.py [repetitions]
```

JS (Node, sans navigateur) :
```
node _dev/bench-offsets/lib/bench.js [repetitions]
```

`repetitions` (optionnel, défaut 100) : nombre de fois où `assets/texte-modele.txt` (9380 mots)
est répété pour atteindre la taille voulue — 100 ≈ 938 000 mots, 300 ≈ 2,8 millions de mots.

Le script Python mesure en plus, séparément, le coût "ouverture complète du document" (lecture du
fichier + répétition + technique, à froid) pour les 3 techniques — pas seulement le calcul isolé.
