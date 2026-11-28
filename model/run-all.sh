#!/usr/bin/env bash
# Run every one-invariant config against its spec; print one verdict line each.
cd "$(dirname "$0")"
# check.sh runs the checker named by EVERYSTATE under the memory ceiling EVERYSTATE_MEMORY.
for cfg in *-*.cfg; do
  # The spec is the longest leading run of capitalised words that names a .tla file:
  # ClaimsSettled-X.cfg checks Claims.tla, LifecycleHerdrRemovesEmpty-X.cfg checks Lifecycle.tla.
  base=${cfg%.cfg}; spec=${base%%-*}
  while [ ! -f "$spec.tla" ] && [ -n "$spec" ]; do spec=$(printf '%s' "$spec" | sed -E 's/[A-Z][a-z]*$//'); done
  out=$(./check.sh -json -workers auto -config "$cfg" "$spec.tla" 2>&1); code=$?
  last=$(printf '%s\n' "$out" | tail -1)
  if printf '%s' "$last" | jq -e . >/dev/null 2>&1; then
    printf '%s\texit %s\t%s\n' "$cfg" "$code" "$(printf '%s' "$last" | jq -c '{status,name,distinct,trace:[.trace[]?.action]}')"
  else
    printf '%s\texit %s\t%s\n' "$cfg" "$code" "$(printf '%s\n' "$out" | tail -5 | tr '\n' ' ')"
  fi
done
