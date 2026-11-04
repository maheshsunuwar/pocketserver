#!/usr/bin/env bash
# PocketHost installer for Termux (Android). Also works on regular Linux/macOS for development.
#   curl -fsSL https://raw.githubusercontent.com/OWNER/pockethost/main/install.sh | bash
set -euo pipefail

REPO="${POCKETHOST_REPO:-https://github.com/OWNER/pockethost.git}"
BRANCH="${POCKETHOST_BRANCH:-main}"
DEST="${POCKETHOST_DIR:-$HOME/pockethost}"

b=$'\e[1m'; g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; o=$'\e[0m'
step() { printf '\n%s==>%s %s\n' "$b" "$o" "$*"; }
ok()   { printf '%s✓%s %s\n' "$g" "$o" "$*"; }
warn() { printf '%s!%s %s\n' "$y" "$o" "$*"; }
die()  { printf '%s✗%s %s\n' "$r" "$o" "$*"; exit 1; }

IS_TERMUX=0
[ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *com.termux* ]] && IS_TERMUX=1

printf '%s\n' "${b}PocketHost${o} — turn this phone into a server"

if [ "$IS_TERMUX" = 1 ]; then
  step "Installing packages (this can take a few minutes the first time)"
  export DEBIAN_FRONTEND=noninteractive
  yes | pkg update -y >/dev/null 2>&1 || pkg update -y
  if ! command -v node >/dev/null; then pkg install -y nodejs-lts || pkg install -y nodejs; fi
  pkg install -y git termux-tools
  # Optional extras. Failures here aren't fatal: PocketHost installs what it needs later.
  pkg install -y cloudflared >/dev/null 2>&1 && ok "cloudflared (public URLs)" || warn "cloudflared isn't available yet; public URLs will install it later"
  pkg install -y termux-api >/dev/null 2>&1 || true
else
  warn "Not running in Termux. Installing in development mode."
  command -v node >/dev/null || die "Install Node.js 18+ first."
  command -v git >/dev/null || die "Install git first."
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || die "Node.js $(node -v) is too old. PocketHost needs Node 18 or newer."
ok "Node.js $(node -v)"

step "Getting PocketHost"
if [ -n "${POCKETHOST_SRC:-}" ]; then
  # Local copy (used when testing an unreleased version).
  mkdir -p "$DEST"
  cp -R "$POCKETHOST_SRC"/. "$DEST"/
  ok "Copied from $POCKETHOST_SRC"
elif [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
  ok "Updated $DEST"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DEST"
  ok "Downloaded to $DEST"
fi
chmod +x "$DEST/bin/pockethost"

step "Setting up the pockethost command"
if [ "$IS_TERMUX" = 1 ]; then
  ln -sf "$DEST/bin/pockethost" "$PREFIX/bin/pockethost"
  mkdir -p "$HOME/.termux/boot"
  cat >"$HOME/.termux/boot/pockethost" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
# Started by the Termux:Boot app after the phone restarts.
termux-wake-lock
pockethost start
EOF
  chmod +x "$HOME/.termux/boot/pockethost"
  ok "Boot script added (needs the Termux:Boot app)"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DEST/bin/pockethost" "$HOME/.local/bin/pockethost"
  ok "Linked to ~/.local/bin/pockethost (make sure it's on your PATH)"
fi

step "Starting PocketHost"
"$DEST/bin/pockethost" start

cat <<EOF

${b}Almost done.${o} So Android doesn't stop your server:
  1. Settings → Apps → Termux → Battery → ${b}Unrestricted${o}
  2. Install ${b}Termux:Boot${o} (same place you got Termux) and open it once, to start on boot
  3. Run ${b}pockethost doctor${o} for anything else your phone needs
EOF
