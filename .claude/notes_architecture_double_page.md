# Architecture double-page — modèle "liseuse" (décidé 2026-06-17)

## Principe

N colonnes indépendantes (2 ou 3 selon largeur d'écran), chacune un QTextEdit normal.
Le texte est géré au niveau application, pas au niveau Qt layout engine.

## Structures de données

```python
_master_text: str           # source de vérité — texte complet
_pages: list[str]           # tranches courantes (page 0, 1, 2, ...)
_page_offsets: list[int]    # offset de début de chaque page dans _master_text
_visible_start: int         # index de la première page visible
visible_widgets: list[QTextEdit]  # 2 ou 3 widgets
```

## Algorithme overflow (ajout de texte en page i)

```
1. Après edit de page i :
   last_vis = cursorForPosition(QPoint(0, vp_height - 1)).position()
   Si last_vis < len(page_i_text) - 1 :
       overflow = page_i_text[last_vis:]  (coupé au dernier espace)
       page_i_text = page_i_text[:cut]
       page_i+1_text = overflow + page_i+1_text
       → répéter pour page i+1, i+2, ... jusqu'à plus d'overflow
```

## Algorithme underflow (suppression de texte en page i)

```
1. L2 - L1 = diff  (diff < 0 = raccourcissement)
2. Vérifier : cursorRect(last_char).bottom() < vp_height - line_height
3. Si oui : prendre les mots du début de page i+1
   → les injecter en fin de page i
   → répéter pour page i+1 ← page i+2, etc.
```

## Unité de gestion : le MOT (décidé 2026-06-17)

Le texte actif (≤ 1000 mots) est géré comme une suite de mots, pas de caractères bruts.
C'est cohérent : Prox traite déjà des mots avec leur canon (lemme spaCy).

```python
_active_words: list[Word]     # ~1000 mots, chacun a .text, .canon, .offset_in_master
_pages: list[list[Word]]      # chaque page = slice de _active_words
```

**Algorithme reflow (même logique overflow et underflow) :**
```
diff = L2 - L1  (diff de longueur en chars après debounce)

si diff > 0 (page i trop longue = overflow) :
    tant que page_i déborde visuellement :
        déplacer dernier mot de page_i → tête de page_i+1
    propager sur i+1, i+2...

si diff < 0 (page i trop courte = underflow) :
    restant = abs(diff)
    tant que restant > 0 ET il reste des mots en page_i+1 :
        mot = mot_0 de page_i+1
        si len(mot.text) <= restant :
            déplacer mot → fin de page_i
            restant -= len(mot.text)
        sinon : stop  (ne pas couper de mot)
    propager i+1 ← i+2...
```

Debounce sur les changements (pas besoin de réactivité temps-réel).

## Points critiques

- **Frontières de mots** : couper toujours sur espace/ponctuation, jamais mid-word
- **Propagation en chaîne** : boucle jusqu'à stabilisation (max N_pages itérations)
- **Undo/redo** : désactiver undo Qt natif, implémenter undo sur _master_text
- **Curseur P→P+1** : flèche-droite/bas à la dernière position → focus sur widget[i+1], position 0
- **Analyse proximité** : tourner sur _master_text entier, pas sur une page isolée (les répétitions chevauchent souvent les frontières de pages)
- **Badges** : position = offset dans _master_text → convertir en (page_index, offset_in_page) pour savoir quel widget et quelle position dans ce widget afficher l'étiquette

## Avantages vs approche layout custom

- Pas de QAbstractTextDocumentLayout à implémenter (3500 lignes Qt internals)
- Chaque QTextEdit est simple et standard (scroll, curseur, selection → tout natif)
- 3 colonnes trivial à ajouter
- hitTest n'existe pas : chaque widget gère sa propre interaction

## Décision prise par l'utilisateur

Session 2026-06-17. On implémente ce modèle lors de la prochaine session.
