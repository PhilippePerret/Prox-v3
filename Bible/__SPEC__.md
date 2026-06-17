# Proximity

Petit nom : « Prox » (p.e. « *avec Prox, je peux améliorer mon texte* »)

Application dédié à l’amélioration d’un texte par gestion des proximités de mots identiques appelée « répétitions » dans d’autres applications comme Antidote.

Cette application doit permettre de :

- visualiser les trop grandes proximités de mots similaires
- modifier les termes répétés avec effet immédiat sur l’état des proximités

## Jargon métier

| Terme                                                      | Signification                                                | Contexte |
| ---------------------------------------------------------- | ------------------------------------------------------------ | -------- |
| **Distance**                                               | Éloignement, en nombre de caractères et nombre de mots, entre deux termes (souvent de même canon). |          |
| <span style="white-space:nowrap;">**de même canon**</span> | Se dit de **deux termes ayant la même forme canonique**. « fait » et « faisant » sont deux termes *de même canon*. |          |
| **Proximité**                                              | Distance entre deux mots de même canon. Elle s’exprime en nombre de caractères et en nombre de mots. Aspect *neutre* de la distance entre deux mots/expressions. On parle de ***trop grande proximité*** pour parler de rapprochement trop grand entre deux termes. | Tous     |
| **Répétition**                                             | Aspect négatif de la *proximité*. Elle peut être *simple* ou *double* (répétition avant et après). |          |
| **canon**                                                  | forme canonique du mot. « faire » est le *canon* de « ferai » | Tous     |

---

## État des lieux

Stack décidé (session 2026-06-16) — voir `../dev/Claude/01-fondations.md` pour le détail.

| Composant | Technologie |
|---|---|
| UI / éditeur | Python + PySide6 |
| Lemmatisation | spaCy (modèle fr) |
| Parsing .odt | odfpy |
| Parsing .docx | python-docx |
| Poids / profils | YAML/JSON |



---

## Requis

- Pouvoir travailler avec un texe provenant de LibreOffice (extension LibreOffice ?). Pouvoir travailler un texte stylisé, formaté à base de style, en tout cas, comme Word ou LibreOffice.
- Pouvoir traiter des textes immenses sans difficulté,
- concentration (cache) sur quatre pages maximum (= 6000 caractères / 600 mots)
- édition avec effet immédiat : on remplace/modifie un mot, l’application alerte immédiatement sur les répétitions,
- édition complexe ne se limitant pas à remplacer un mot par un autre : possibilité de supprimer plusieurs mots à un endroit et d’en ajouter plusieurs à un autre,
- poids différents suivant les mots,
- possibilité de définir des mots à exclure,
- possibilité de définir le poids de certaines proximités
- analyse intelligente (le proximité peut être un effet, dans certains contextes -  un mot utilisé seulement deux fois dans un texte de 300 pages et dont les répétitions sont TRÈS proches est presque à coup sûr un effet — mais si la proximité est faible, ça révèle peut-être une répétition)
