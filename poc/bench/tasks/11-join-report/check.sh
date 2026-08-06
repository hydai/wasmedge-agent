#!/bin/bash
set -e
expected=$(printf '305 Initech\n230 Globex\n225 Acme Corp\n10 Umbrella')
got=$(grep -v '^\s*$' "$PROJECT_DIR/spend.md" | sed 's/[[:space:]]*$//')
[ "$got" = "$expected" ] || { echo "got:"; echo "$got"; echo "want:"; echo "$expected"; exit 1; }
