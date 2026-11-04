#!/bin/bash
# Call the dashboard's API, logging in first if needed.
#   PH_BASE=http://<phone-ip>:7777 PH_PASSWORD=... dev/api.sh GET /apps
#   dev/api.sh POST /catalog/dufs/install '{}'
# Defaults to the local dev server (npm run dev) and its password in .dev-data.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${PH_BASE:-http://127.0.0.1:7799}"
PW="${PH_PASSWORD:-$(cat "$ROOT/.dev-data/initial-password" 2>/dev/null || true)}"
JAR="${TMPDIR:-/tmp}/pockethost-cookies-$(printf %s "$BASE" | cksum | cut -d' ' -f1)"
[ $# -ge 2 ] || { echo "usage: dev/api.sh METHOD /path [json]" >&2; exit 2; }
H=(-H 'x-pockethost: 1' -H 'content-type: application/json')
call() { curl -s -b "$JAR" -c "$JAR" -X "$1" "${H[@]}" ${3:+-d "$3"} "$BASE/api$2"; }
if [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "${H[@]}" "$BASE/api/apps")" = 401 ]; then
  [ -n "$PW" ] || { echo "Set PH_PASSWORD to the dashboard password." >&2; exit 1; }
  call POST /login "$(printf '{"password":%s}' "$(printf %s "$PW" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")" >/dev/null
fi
call "$@"; echo
