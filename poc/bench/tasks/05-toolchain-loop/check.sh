#!/bin/bash
set -e
cd "$PROJECT_DIR"
grep -q "mode tie picks smallest value" stats.test.js || { echo "tests were modified"; exit 1; }
node --test stats.test.js > /dev/null 2>&1
