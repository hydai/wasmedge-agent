#!/bin/bash
set -e
cd "$PROJECT_DIR"
grep -q "retries must be the integer 3" validate.js || { echo "validate.js modified"; exit 1; }
node validate.js | grep -q "config valid"
