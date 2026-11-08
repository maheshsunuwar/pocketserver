#!/bin/bash
# Copy this checkout to the phone and restart PocketServer there.
#   dev/push.sh            update an existing install (~/pocketserver) and restart
#   dev/push.sh --install  first time: run install.sh from this checkout
#   dev/push.sh --samples  also make git repos of dev/sample-apps at ~/sample-apps/<name> on the phone,
#                          so you can deploy them by entering that path as the repository
set -euo pipefail
cd "$(dirname "$0")/.."
ADB=(adb); [ -n "${PH_DEVICE:-}" ] && ADB=(adb -s "$PH_DEVICE")
TAR=$(mktemp -t pocketserver.XXXXXX).tar
trap 'rm -f "$TAR"' EXIT
COPYFILE_DISABLE=1 tar -cf "$TAR" --exclude .git --exclude .dev-data --exclude node_modules .
"${ADB[@]}" push "$TAR" /data/local/tmp/pocketserver.tar >/dev/null
"${ADB[@]}" shell chmod 644 /data/local/tmp/pocketserver.tar
if [ "${1:-}" = --install ] || [ "${2:-}" = --install ]; then
  dev/phone.sh 'rm -rf ~/ph-src && mkdir ~/ph-src && tar -xf /data/local/tmp/pocketserver.tar -C ~/ph-src && POCKETSERVER_SRC=~/ph-src bash ~/ph-src/install.sh'
else
  dev/phone.sh 'tar -xf /data/local/tmp/pocketserver.tar -C ~/pocketserver && pocketserver restart'
fi
"${ADB[@]}" shell rm -f /data/local/tmp/pocketserver.tar
if [ "${1:-}" = --samples ] || [ "${2:-}" = --samples ]; then
  dev/phone.sh 'set -e; for d in ~/pocketserver/dev/sample-apps/* ~/ph-src/dev/sample-apps/*; do [ -d "$d" ] || continue; n=$(basename "$d"); rm -rf ~/sample-apps/$n; mkdir -p ~/sample-apps; cp -R "$d" ~/sample-apps/$n; (cd ~/sample-apps/$n && git init -q && git add -A && git -c user.name=dev -c user.email=dev@localhost commit -qm sample); echo "~/sample-apps/$n"; done' || true
fi
