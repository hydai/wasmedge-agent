#!/bin/bash
set -e
expected=$(printf 'auth_denied 0 1\ndb_timeout 5 2\nio_fail 3 6')
got=$(grep -v '^\s*$' "$PROJECT_DIR/summary.md" | sed 's/[[:space:]]*$//')
[ "$got" = "$expected" ] || { echo "got:"; echo "$got"; echo "want:"; echo "$expected"; exit 1; }
