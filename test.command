#!/bin/bash
cd "$(dirname "$0")"
python3.11 -m app.test_pywebview 2>&1 | tee /tmp/prox_test_error.log
code=${PIPESTATUS[0]}
echo "——— app terminée, code de sortie ${code} ———" >> /tmp/prox_test_error.log
