#!/bin/bash
cd "$(dirname "$0")"
python3.11 -m app.test_pywebview 2>&1 | tee /tmp/prox_test_error.log
if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo ""
    echo "——— ERREUR — log : /tmp/prox_test_error.log ———"
    read
else
    exit 0
fi
