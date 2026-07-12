# Questions ouvertes — à trancher

_Document de travail — session 2026-06-16_

Ces points n'ont pas encore été décidés. À aborder dans l'ordre lors des prochaines sessions.

---

## Architecture interne

- **Format de l'index en mémoire** : `dict[canon → list[offset]]` ? Ou structure plus riche incluant le mot original, le contexte ?
- **Recalcul en temps réel** : quand l'utilisateur modifie un mot dans l'éditeur, comment recalcule-t-on l'index ? Recalcul partiel (zone modifiée uniquement) ou recalcul global ? À quel rythme (debounce) ?
- **Séparation moteur / UI** : le moteur d'analyse (index, calcul distances, profils) sera une classe Python pure, sans dépendance Qt. L'UI Qt consomme le moteur via une API claire. À formaliser.

---
