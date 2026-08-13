#!/bin/sh
set -eu

assert_port_5173_free() {
  if ss -ltn '( sport = :5173 )' | grep -q ':5173'; then
    printf '%s\n' 'Port 5173 is already listening' >&2
    return 1
  fi
}

require_m0_go() {
  found=0
  while IFS= read -r line; do
    if [ "$line" = '## Decision: GO' ]; then
      found=1
      break
    fi
  done < docs/research/m0-results.md
  if [ "$found" -ne 1 ]; then
    printf '%s\n' 'M0 report does not contain an exact ## Decision: GO heading' >&2
    return 1
  fi
}

npm run build:fixtures
npm run typecheck
npm run test:unit
npm run test:web:unit
npm run verify:package
npm run test:cli:smoke
assert_port_5173_free
npm run test:web -- --full
assert_port_5173_free
assert_port_5173_free
npm run test:m0
assert_port_5173_free
require_m0_go
