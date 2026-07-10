Les textes ont été récupérés au format Scrivener à [http://abu.cnam.fr/](http://abu.cnam.fr/) (il y en a encore pleins à récupérer).

Pour lancer l’analyse d’un texte :

- ouvrir un Terminal à ce dossier et taper : 

  ~~~zsh
  prox-env
  ~~~

- puis :

  ~~~zsh
  python3 text_analyzer.py -t "TITRE" -y ANNEEE -a "AUTEUR" -l 'fr' FICHIER.txt
  
  # Exemple à remplir et copier-coller
  TITRE='Daphnis et Chloé'
  AUTEUR='Longus'
  ANNEE='250ajc'
  ROOT="Longus-Daphnis_et_Chloe"
  
  python3 text_analyzer.py -t "$TITRE" -y $ANNEE -a "$AUTEUR" -l 'fr' textes/$ROOT.txt
  ~~~
  
  > Toutes les informations sont requises.
