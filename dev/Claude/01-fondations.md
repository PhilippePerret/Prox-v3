# Prox — Fondations

_Document de travail — session 2026-06-16_

---

## Ce qu'est Prox

Un outil d'**analyse et correction des proximités lexicales** dans un texte littéraire.

- Visualise les trop grandes proximités entre mots de même canon
- Permet de corriger directement dans l'outil
- Exporte le texte corrigé dans le format d'origine (sans double saisie)

Ce n'est **pas** un correcteur de style, un analyseur stylistique, ni un éditeur de texte général. C'est un outil très ciblé : les répétitions de proximité, rien d'autre.

---

## Jargon retenu

| Terme | Définition |
|---|---|
| **canon** | Forme canonique (lemme) d'un mot. "ferai", "faisant", "fait" → canon "faire" |
| **distance** | Écart en caractères entre deux occurrences du même canon |
| **proximité** | Distance entre deux mots de même canon — neutre |
| **répétition** | Proximité trop grande = distance < seuil → problème à corriger |
| **poids** | Coefficient (0.0–1.0) d'un canon, modifie son seuil effectif |
| **profil** | Fichier de poids précalculé pour un contexte (époque, genre, auteur) |

---

## Workflow utilisateur

```
1. Import    →  ouvre un .odt / .docx dans Prox
                la mise en forme est préservée en interne

2. Travail   →  corrige les répétitions dans l'éditeur Prox
                état de session sauvegardé automatiquement

3. Export    →  Prox régénère le .odt / .docx avec les corrections
                mise en forme intacte

4. Reprise   →  on peut rouvrir le fichier exporté dans Prox
                l'état de session est retrouvé sans friction
```

---

## Stack technique

| Composant | Technologie | Raison |
|---|---|---|
| UI / éditeur | **Python + Qt** (PySide6) | Gestion curseur/sélection native, vraie qualité éditeur |
| Lemmatisation | **spaCy** (modèle fr) | Robuste, déjà utilisé dans versions précédentes |
| Parsing .odt | **odfpy** | Accès XML interne, round-trip sans perte |
| Parsing .docx | **python-docx** | Idem |
| Poids / profils | Fichiers YAML/JSON | Simples, éditables à la main, chargés au démarrage |

---

## Concept central : l'index

Chaque mot du texte est **indexé** à sa position en caractères (offset absolu depuis le début du document). La distance entre deux occurrences = simple soustraction d'entiers. Pas de comptage de mots à la volée.

```
texte  = "Le chat noir mangea le petit chat blanc..."
index  :  0  3   7   12  19  22  28   32   37

"chat" → occurrences : [3, 32]
distance = 32 - 3 - len("chat") = 25 caractères
```

---

## Seuil et poids

**Seuil de base** : 1500 caractères (≈ 1 page, ≈ 250 mots)

**Seuil effectif** par canon : `seuil_effectif = 1500 × poids`

Exemples de poids :
- "le", "la", "les", "un", "une" → poids ≈ 0.02 (quasi ignorés)
- "mais", "donc", "car" → poids ≈ 0.15
- "adjectif courant" → selon profil
- mot rare, fort → poids ≈ 1.0 (seuil plein)

Une répétition est signalée si : `distance < 1500 × poids`

---

## Profils de poids

L'utilisateur choisit un profil au démarrage. Le profil est un fichier précalculé, externe à Prox.

Exemples de profils envisagés :
- Littérature contemporaine française
- Littérature classique XIXe siècle
- Essai / non-fiction
- Par auteur spécifique

Le calcul des profils est un **outil séparé** (voir `02-outil-profils.md`). Prox consomme les profils, ne les calcule pas.

---

## Persistance

Deux niveaux :

**Session** (lié à un document) :
- répétitions ignorées
- position courante dans le texte
- mode d'affichage actif

**Configuration** (globale ou par projet) :
- profil de poids choisi
- seuil personnalisé
- mots exclus manuellement
- autres préférences UI

---

## Modes d'affichage

| Mode | Comportement |
|---|---|
| **Sans distraction** | Texte brut. Au passage sur un mot, affiche la distance avec l'occurrence avant/après du même canon. |
| **Complet** | Toutes les répétitions visibles dans la fenêtre sont annotées inline. |
| **Niveau** | Curseur de seuil : n'affiche que les répétitions sous un seuil défini par l'utilisateur. |

---

## Navigation clavier (ébauche)

| Raccourci | Action |
|---|---|
| `→` / `←` | Occurrence suivante / précédente du même canon |
| `↓` / `↑` | Répétition suivante / précédente (canon différent) |
| `⌘G` | Aller à la répétition la plus grave (distance minimale) |
| `⌘I` | Ignorer cette répétition |
| à définir | Changer de mode d'affichage |

---

## Fenêtre de travail

Affiche ~3 pages autour du point chaud courant (≈ 6000 caractères / 600 mots). Pas tout le document — concentration sur la zone active.

---

## Ce qui reste à définir

- Format exact des fichiers de profils (YAML ?)
- Format du fichier de session
- Structure de l'index en mémoire (dict canon → liste d'offsets ?)
- Gestion des modifications en temps réel (recalcul partiel de l'index)
- Format des annotations inline dans Qt
- API entre le moteur d'analyse et l'UI
