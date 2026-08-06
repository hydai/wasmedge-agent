#!/bin/bash
set -e
cd "$PROJECT_DIR"
grep -q "L003 file must end with exactly one newline" lint.js || { echo "lint.js modified"; exit 1; }
grep -q "sale label" src/cart.test.js || { echo "tests modified"; exit 1; }
node lint.js > /dev/null
node --test src/cart.test.js > /dev/null 2>&1
