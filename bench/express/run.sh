#!/usr/bin/env bash
# Measures route recall against what Express actually registers at runtime,
# using Express's own example apps as the corpus. `pnpm bench:recall`
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORK="${APPGUIDE_BENCH_WORK:-$REPO/.bench-work}"
REF="${EXPRESS_REF:-v5.2.1}"
mkdir -p "$WORK"

if [ ! -d "$WORK/express/examples" ]; then
  echo "cloning express $REF ..."
  git clone --depth 1 --branch "$REF" --quiet https://github.com/expressjs/express.git "$WORK/express"
  (cd "$WORK/express" && npm install --silent --no-audit --no-fund)
fi

# A per-app time limit. macOS ships no GNU `timeout` — which is exactly the
# bug that made the first run of this benchmark load 0 of 25 apps.
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }

echo "reading what Express registers at runtime ..."
mkdir -p "$WORK/errors"
printf '{' > "$WORK/oracle.json"; first=1
for dir in "$WORK"/express/examples/*/; do
  name=$(basename "$dir")
  res=$(cd "$WORK/express" && limit 8 node "$HERE/oracle.cjs" "$dir" "$WORK/express" 2>"$WORK/errors/$name.txt" | tail -1 || true)
  if [ -z "$res" ]; then
    msg=$(grep -m1 -E "Error|Cannot" "$WORK/errors/$name.txt" | tr '"' "'" | cut -c1-120 || true)
    res="{\"ok\":false,\"error\":\"${msg:-no output}\"}"
  fi
  [ $first -eq 0 ] && printf ',' >> "$WORK/oracle.json"; first=0
  printf '"%s":%s' "$name" "$res" >> "$WORK/oracle.json"
done
printf '}' >> "$WORK/oracle.json"

echo "reading them statically ..."
(cd "$REPO" && APPGUIDE_BENCH=1 APPGUIDE_BENCH_WORK="$WORK" pnpm exec vitest run bench/express/extract.test.ts >/dev/null)

node "$HERE/score.cjs" "$WORK"
