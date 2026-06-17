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
  
  python3 text_analyzer.py -t 'Bel Ami' -y 1891 -a 'Guy de Maupassant' -l 'fr' textes/Guy_de_Maupassant-Bel_Ami.txt
  ~~~

  > Toutes les informations sont requises.
