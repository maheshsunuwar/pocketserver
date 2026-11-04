#!/bin/bash
# Run a command on the phone, inside Termux's environment, over adb.
#   dev/phone.sh 'pockethost status'
# Needs the GitHub build of Termux (it's debuggable, so `run-as com.termux` works).
# Set PH_DEVICE to pick a phone when more than one is connected (see `adb devices`).
#
# Caveat: this runs under a different Android security context than the Termux app.
# Termux:API (battery) and PostgreSQL's initdb hang here. Test those from the app itself.
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: dev/phone.sh '<command>'" >&2; exit 2; }
ADB=(adb); [ -n "${PH_DEVICE:-}" ] && ADB=(adb -s "$PH_DEVICE")
P=/data/data/com.termux/files
CMD="cd ~; $*"
"${ADB[@]}" shell "run-as com.termux env -i HOME=$P/home PREFIX=$P/usr TMPDIR=$P/usr/tmp LANG=en_US.UTF-8 TERM=xterm PATH=$P/usr/bin LD_PRELOAD=$P/usr/lib/libtermux-exec.so $P/usr/bin/bash -c $(printf %q "$CMD")"
