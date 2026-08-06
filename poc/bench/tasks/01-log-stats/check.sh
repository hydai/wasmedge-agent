#!/bin/bash
set -e
printf '7 db_timeout\n4 io_fail\n2 auth_denied\n' > /tmp/expected-01.$$
diff <(grep -v '^\s*$' "$PROJECT_DIR/report.md" | sed 's/[[:space:]]*$//') /tmp/expected-01.$$
rm -f /tmp/expected-01.$$
