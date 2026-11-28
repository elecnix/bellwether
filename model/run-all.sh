#!/usr/bin/env bash
# Run every one-invariant config against its spec; print one verdict line each.
cd "$(dirname "$0")"
ES=${EVERYSTATE:-everystate}
for cfg in *-*.cfg; do
  base=${cfg%.cfg}; spec=${base%%-*}; spec=${spec%HerdrRemovesEmpty}; spec=${spec%NoStrayNoResend}
  out=$("$ES" -json -workers auto -config "$cfg" "$spec.tla" 2>&1); code=$?
  last=$(printf '%s\n' "$out" | tail -1)
  if printf '%s' "$last" | jq -e . >/dev/null 2>&1; then
    printf '%s\texit %s\t%s\n' "$cfg" "$code" "$(printf '%s' "$last" | jq -c '{status,name,distinct,trace:[.trace[]?.action]}')"
  else
    printf '%s\texit %s\t%s\n' "$cfg" "$code" "$(printf '%s\n' "$out" | tail -5 | tr '\n' ' ')"
  fi
done
