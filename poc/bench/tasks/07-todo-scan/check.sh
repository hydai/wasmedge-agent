#!/bin/bash
set -e
expected=$(printf -- '- src/app.js:5 TODO cache rendered output\n- src/app.js:12 TODO exit code handling\n- src/store.js:7 TODO return a defensive copy\n- src/util.js:3 FIXME escape separator characters')
got=$(grep -v '^\s*$' "$PROJECT_DIR/todos.md" | sed 's/[[:space:]]*$//')
[ "$got" = "$expected" ] || { echo "got:"; echo "$got"; echo "want:"; echo "$expected"; exit 1; }
