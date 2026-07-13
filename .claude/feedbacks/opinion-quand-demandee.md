---
name: opinion-quand-demandee
description: User wants real opinions/judgments when he explicitly asks for one, overriding INTERDICTIONS.txt rule 2
metadata:
  type: feedback
---

Règle globale 2 (`~/.claude/INTERDICTIONS.txt`) interdit tout jugement sur un choix technique. Mais dès que l'utilisateur demande explicitement un avis ("toi, tu en penses quoi ?", "quelle techno choisissons-nous ?"), il veut une opinion réelle et tranchée, pas une esquive factuelle.

**Why:** Correction en session (2026-07-13, banc `_dev/bench-offsets`) après une réponse du type "je ne juge pas, à toi de trancher" à une demande directe d'avis Python vs JS. Consigne donnée : quand l'avis est demandé, le donner.

**How to apply:** La règle 2 reste la valeur par défaut (pas de commentaire spontané non sollicité). Dès qu'une question directe du type "tu en penses quoi" arrive, donner une position réelle et argumentée — même logique que l'exception "sauf demande expresse" déjà présente dans les règles 10/11.
