#!/bin/bash
set -e
cd "$PROJECT_DIR"
grep -q "assert.deepStrictEqual(mergeIntervals(\[\[1, 3\], \[3, 5\]\]), \[\[1, 5\]\])" interval.test.js || { echo "tests were modified"; exit 1; }
node --test interval.test.js > /dev/null 2>&1
