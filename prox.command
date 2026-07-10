#!/bin/bash
cd "$(dirname "$0")"
python3.11 -m app.prox_pywebview 2>&1 | tee /tmp/prox2_error.log
if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo ""
    echo "——— ERREUR — log : /tmp/prox2_error.log ———"
    read
else
    exit 0
fi
