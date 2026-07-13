#!/bin/bash
cd "$(dirname "$0")"

PY=/opt/homebrew/opt/python@3.11/bin/python3.11

if [ ! -f lib/spacy_cache.json ]; then
  echo "=================================================="
  echo " Construction du cache spaCy (une seule fois)"
  echo "=================================================="
  "$PY" lib/build_spacy_cache.py
  echo ""
fi

echo "=================================================="
echo " BANCS D'ESSAIS — PY (6/12)"
echo "=================================================="
"$PY" lib/bench.py

echo ""
echo "=================================================="
echo " BANCS D'ESSAIS — JS (6/12)"
echo "=================================================="
node --max-old-space-size=4096 lib/bench.js

echo ""
echo "=================================================="
echo " Tableau comparatif"
echo "=================================================="
"$PY" lib/build_report.py

echo ""
echo "——— Terminé — appuie sur Entrée pour fermer ———"
read
