#!/bin/bash
set -e
cd "$PROJECT_DIR"
out=$(node wordfreq.js text.txt 4)
expected=$(printf '7 the\n4 cat\n4 sat\n2 dog')
[ "$out" = "$expected" ] || { echo "got:"; echo "$out"; echo "want:"; echo "$expected"; exit 1; }
