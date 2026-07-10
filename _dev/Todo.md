NE DOIT PAS ÊTRE LU PAR CLAUDE

# Todo list

- pouvoir désactiver l’affichage des proximités — et dans ce cas, un raccourci permettra de les afficher (peut-être seulement autour du curseur et sur toute la portion si MAJ tenue)
- Au démarrage, l’application ne doit analyser QUE la partie « active » du texte (les ~ 4 premières pages à la première ouverture du texte, les 2 pages autour de la portion active si réouverture).
  Ensuite, quand cette partie est affichée, on peut s’arrêter ou poursuivre un peut les pages autour pour être prêt. Surtout la première fois (les autres fois, une maximum d’informations auront été enregistrées, comme le nombre de répétions complètes, etc.



## Fonctionnement général :

Au démarrage : l’app cherche si le texte possède une DB SQLite. Si oui, il s’en sert pour retrouver notamment la dernier point affiché (page ? offset ?)

Sinon : elle procède à l’analyse des premières pages seulement et les affiche. Elle poursuit l’analyse en background, chaque fois qu’il n’y a rien à faire.

Il enregistre le texte tokenisé dans la base (je ne sais pas encore sous quelle forme.