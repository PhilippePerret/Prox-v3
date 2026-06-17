#!/bin/bash
cd "$(dirname "$0")"
source /Users/philippeperret/Programmes/PROXIMITY/venv/bin/activate
python app/main.py 2>&1 | tee /tmp/prox_error.log
echo ""
echo "——— Prox s'est terminé ——— log : /tmp/prox_error.log ———"
echo "Appuyer sur Entrée pour fermer"
read
