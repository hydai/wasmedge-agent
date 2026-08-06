#!/bin/bash
set -e
cd "$PROJECT_DIR"
if grep -rn "calc_total" src tests; then echo "old name still present"; exit 1; fi
grep -rqn "total_of" src || { echo "new name missing in src"; exit 1; }
grep -rqn "total_of" tests || { echo "new name missing in tests"; exit 1; }
cargo test --release -q > /dev/null 2>&1
