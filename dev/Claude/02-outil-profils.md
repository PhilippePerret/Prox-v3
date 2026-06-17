# Outil de calcul des profils de poids

_Document de travail — session 2026-06-16_

---

## Principe

Outil **séparé de Prox**, qui produit des fichiers de profils consommés par Prox.

Le poids d'un canon reflète sa fréquence relative dans un corpus de "bons textes" du registre choisi. Plus un mot est fréquent dans ce corpus, plus son poids est faible (il est "attendu", sa répétition proche est moins gênante).

Formule de base : inspirée du **TF-IDF** (inverse document frequency).

---

## Usage envisagé

```
1. L'utilisateur alimente un répertoire avec des textes de référence
   (fichiers .txt, .odt, .docx — un corpus)

2. L'outil analyse le corpus :
   - lemmatise chaque mot (spaCy)
   - calcule la fréquence relative de chaque canon
   - en dérive un poids normalisé entre 0.0 et 1.0

3. Produit un fichier de profil (ex: "litterature-xixe.yaml")

4. L'utilisateur peut relancer l'outil à tout moment
   pour affiner le profil avec de nouveaux textes
```

---

## Apprentissage continu

L'outil est conçu pour être alimenté **progressivement** :
- Chaque nouveau texte ajouté affine les poids
- Les profils peuvent être segmentés par genre, époque, auteur
- L'utilisateur choisit ensuite le profil dans Prox

---

## Exemple concret

Corpus "XIXe siècle" (Balzac, Hugo, Zola…) → adjectifs très fréquents → poids faible → Prox signale moins leurs répétitions.

Corpus "Contemporain" (Ernaux, Houellebecq…) → adjectifs plus rares → poids plus élevé → Prox les signale davantage.

---

## Ce qui reste à définir

- Format du corpus (répertoire de fichiers plats ?)
- Format de sortie des profils (YAML probablement)
- Modèle spaCy à utiliser (fr_core_news_sm / md / lg ?)
- Normalisation des poids (échelle log ? linéaire ?)
- Interface : ligne de commande suffit pour cet outil
