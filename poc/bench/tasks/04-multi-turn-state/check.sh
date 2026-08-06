#!/bin/bash
set -e
got=$(tr -d '[:space:]' < "$PROJECT_DIR/answer.txt")
[ "$got" = "auth,notify" ] || { echo "got: $got"; exit 1; }
