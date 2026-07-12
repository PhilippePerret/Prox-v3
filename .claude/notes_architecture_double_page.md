# Architecture double-page — modèle "liseuse" (décidé 2026-06-17)

## Principe

N colonnes indépendantes (2 ou 3 selon largeur d'écran), chacune un DOM-editor normal.
Le texte est géré au niveau application, pas au niveau Qt layout engine.

## Structures de données

(JAMAIS VALIDÉ PAR LE CONCEPTEUR)

```python
_master_text: str           # source de vérité — texte complet
_pages: list[str]           # tranches courantes (page 0, 1, 2, ...)
_page_offsets: list[int]    # offset de début de chaque page dans _master_text
_visible_start: int         # index de la première page visible
visible_widgets: list[QTextEdit]  # 2 ou 3 widgets
```

## Unité de gestion : le MOT (décidé 2026-06-17)

Le texte actif (≤ 1000 mots) est géré comme une suite de mots, pas de caractères bruts.
C'est cohérent : Prox traite déjà des mots avec leur canon (lemme spaCy).

```python
_active_words: list[Word]     # ~1000 mots, chacun a .text, .canon, .offset_in_master
_pages: list[list[Word]]      # chaque page = slice de _active_words
```
