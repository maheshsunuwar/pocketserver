#!/usr/bin/env bash
# PocketServer installer for Termux (Android). Also works on regular Linux/macOS for development.
#   curl -fsSL https://raw.githubusercontent.com/maheshsunuwar/pocketserver/main/install.sh | bash
set -euo pipefail

REPO="${POCKETSERVER_REPO:-https://github.com/maheshsunuwar/pocketserver.git}"
BRANCH="${POCKETSERVER_BRANCH:-main}"
DEST="${POCKETSERVER_DIR:-$HOME/pocketserver}"

b=$'\e[1m'; g=$'\e[32m'; y=$'\e[33m'; r=$'\e[31m'; o=$'\e[0m'
step() { printf '\n%s==>%s %s\n' "$b" "$o" "$*"; }
ok()   { printf '%s✓%s %s\n' "$g" "$o" "$*"; }
warn() { printf '%s!%s %s\n' "$y" "$o" "$*"; }
die()  { printf '%s✗%s %s\n' "$r" "$o" "$*"; exit 1; }

IS_TERMUX=0
[ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *com.termux* ]] && IS_TERMUX=1

printf '%s\n' "${b}PocketServer${o} — turn this phone into a server"

if [ "$IS_TERMUX" = 1 ]; then
  step "Installing packages (this can take a few minutes the first time)"
  export DEBIAN_FRONTEND=noninteractive
  # Upgrade, not just update: a fresh Termux has old libraries, and new packages
  # like nodejs fail to start against them ("CANNOT LINK EXECUTABLE").
  yes | pkg upgrade -y -o Dpkg::Options::=--force-confold >/dev/null 2>&1 \
    || pkg upgrade -y -o Dpkg::Options::=--force-confold
  if ! command -v node >/dev/null; then pkg install -y nodejs-lts || pkg install -y nodejs; fi
  pkg install -y git termux-tools
  # Optional extras. Failures here aren't fatal: PocketServer installs what it needs later.
  pkg install -y cloudflared >/dev/null 2>&1 && ok "cloudflared (public URLs)" || warn "cloudflared isn't available yet; public URLs will install it later"
  pkg install -y termux-api >/dev/null 2>&1 || true
else
  warn "Not running in Termux. Installing in development mode."
  command -v node >/dev/null || die "Install Node.js 18+ first."
  command -v git >/dev/null || die "Install git first."
fi

major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || die "Node.js $(node -v) is too old. PocketServer needs Node 18 or newer."
ok "Node.js $(node -v)"

if { [ -d "$HOME/.pockethost" ] && [ ! -L "$HOME/.pockethost" ]; } || [ -x "$HOME/pockethost/bin/pockethost" ]; then
  # Earlier versions were called PocketHost. Move the data over and keep a link at the old path,
  # because apps' config files can contain absolute paths into it.
  step "Moving your data from PocketHost (the old name)"
  [ -x "$HOME/pockethost/bin/pockethost" ] && "$HOME/pockethost/bin/pockethost" stop >/dev/null 2>&1 || true
  if [ -d "$HOME/.pockethost" ] && [ ! -L "$HOME/.pockethost" ] && [ ! -e "$HOME/.pocketserver" ]; then
    mv "$HOME/.pockethost" "$HOME/.pocketserver"
    ln -s "$HOME/.pocketserver" "$HOME/.pockethost"
  fi
  rm -f "${PREFIX:-/nonexistent}/bin/pockethost" "$HOME/.termux/boot/pockethost" "$HOME/.local/bin/pockethost"
  [ -x "$HOME/pockethost/bin/pockethost" ] && rm -rf "$HOME/pockethost"
  ok "Your apps, databases and settings were kept"
fi

step "Getting PocketServer"
if [ -n "${POCKETSERVER_SRC:-}" ]; then
  # Local copy (used when testing an unreleased version).
  mkdir -p "$DEST"
  cp -R "$POCKETSERVER_SRC"/. "$DEST"/
  ok "Copied from $POCKETSERVER_SRC"
elif [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only
  ok "Updated $DEST"
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DEST"
  ok "Downloaded to $DEST"
fi
chmod +x "$DEST/bin/pocketserver"

step "Setting up the pocketserver command"
if [ "$IS_TERMUX" = 1 ]; then
  ln -sf "$DEST/bin/pocketserver" "$PREFIX/bin/pocketserver"
  mkdir -p "$HOME/.termux/boot"
  cat >"$HOME/.termux/boot/pocketserver" <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
# Started by the Termux:Boot app after the phone restarts.
termux-wake-lock
pocketserver start
EOF
  chmod +x "$HOME/.termux/boot/pocketserver"
  ok "Boot script added (needs the Termux:Boot app)"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$DEST/bin/pocketserver" "$HOME/.local/bin/pocketserver"
  ok "Linked to ~/.local/bin/pocketserver (make sure it's on your PATH)"
fi

step "Starting PocketServer"
"$DEST/bin/pocketserver" start

cat <<EOF

${b}Almost done.${o} So Android doesn't stop your server:
  1. Settings → Apps → Termux → Battery → ${b}Unrestricted${o}
  2. Install ${b}Termux:Boot${o} (same place you got Termux) and open it once, to start on boot
  3. Run ${b}pocketserver doctor${o} for anything else your phone needs
EOF
