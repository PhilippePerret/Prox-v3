---
name: respecter-decisions-actees
description: Ne jamais reproduire l'ancienne approche déjà écartée ; s'appuyer strictement sur ce qui a été décidé et acté ; ne prendre aucune décision structurante seul
metadata:
  type: feedback
---

Quand une décision technique a été prise et actée (ex. dans `_dev/Bible/__SPEC__.md`), s'appuyer dessus à la lettre pour toute proposition ou implémentation suivante. Ne pas revenir, même partiellement, à une approche déjà écartée. Ne jamais trancher seul un point structurant (architecture, terminologie du domaine, choix technique) — le signaler et attendre validation.

**Why:** Correction en session (2026-07-13) : après décision actée sur la techno DOM-editor (Python), une explication de mise en œuvre a réintroduit du flou en présentant JS comme une extension/nouveauté alors que son rôle (interaction webview) était déjà évident et non remis en cause — perçu comme un retour à l'ancienne façon de faire sans tenir compte de ce qui avait été fixé. Consigne : "respecte CHAQUE CHOIX À LA LETTRE et tu ne prends AUCUNE décision importante dans ton coin".

**How to apply:** Avant de proposer une mise en œuvre, relire ce qui est déjà acté (specs, tables de décision datées) et s'y tenir explicitement plutôt que de reformuler/réinterpréter. Sur tout point non tranché (ex. terminologie "fenêtre" vs pages visibles/cachées), poser la question ou signaler l'ambiguïté au lieu de choisir une définition seul.
