'use strict';
// Installs missing runtimes on demand (Termux packages), so a Python or Go app "just works".
const fs = require('fs');
const path = require('path');
const { which, run, isTermux, PREFIX, paths } = require('./util');

// command → Termux package that provides it
const TERMUX_PKG = {
  node: 'nodejs-lts', npm: 'nodejs-lts', python: 'python', go: 'golang', cargo: 'rust', php: 'php',
  composer: 'composer', git: 'git', cloudflared: 'cloudflared', postgres: 'postgresql', initdb: 'postgresql',
  psql: 'postgresql', mariadbd: 'mariadb', 'mariadb-install-db': 'mariadb', mariadb: 'mariadb',
  'redis-server': 'redis', 'termux-battery-status': 'termux-api', ssh: 'openssh', clang: 'clang', make: 'make', udocker: 'udocker', proot: 'proot',
  syncthing: 'syncthing', navidrome: 'navidrome', gitea: 'gitea', forgejo: 'forgejo', miniflux: 'miniflux', gotify: 'gotify',
  pocketbase: 'pocketbase', dufs: 'dufs', 'transmission-daemon': 'transmission', 'ssh-keygen': 'openssh', sshd: 'openssh',
};
const NPM_GLOBAL = { pnpm: 'pnpm', yarn: 'yarn' };

const installing = new Map(); // package → promise, so two deploys don't run pkg at once

async function ensure(bins, onLine = () => {}) {
  for (const bin of bins) {
    if (which(bin)) continue;
    if (NPM_GLOBAL[bin]) {
      onLine(`Installing ${bin} with npm…`);
      await once('npm:' + bin, () => run('npm', ['install', '-g', NPM_GLOBAL[bin]], { onLine, label: `npm install -g ${bin}` }));
      continue;
    }
    const pkg = TERMUX_PKG[bin];
    if (!isTermux || !pkg) throw new Error(`"${bin}" is not installed on this device.${pkg ? ` Install the "${pkg}" package.` : ''}`);
    onLine(`Installing ${pkg} (provides ${bin})…`);
    await once(pkg, () => run('pkg', ['install', '-y', pkg], {
      onLine, label: `pkg install ${pkg}`, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    }));
    if (!which(bin)) throw new Error(`Installed ${pkg} but "${bin}" still isn't available.`);
  }
}

function once(key, fn) {
  if (!installing.has(key)) installing.set(key, fn().finally(() => installing.delete(key)));
  return installing.get(key);
}

/**
 * pnpm 11+ installs a launcher without a #! line that its native binary normally replaces. There's no
 * native binary for Android, so it stays. Shells still run it, but programs that start pnpm themselves
 * (turbo, nx) get "Exec format error". Returns a folder with proper launchers to put first on PATH.
 */
function shimDir() {
  if (!isTermux) return null;
  const dir = path.join(paths.home, 'bin');
  const pkg = path.join(PREFIX, 'lib', 'node_modules', 'pnpm');
  for (const name of ['pnpm', 'pnpx']) {
    const target = path.join(pkg, 'bin', `${name}.mjs`);
    if (!fs.existsSync(target)) continue;
    let head = '';
    try { head = fs.readFileSync(path.join(pkg, name), 'latin1').slice(0, 2); } catch {}
    if (head === '#!' || head === '\x7fE') continue; // a real script or the native binary: fine as it is
    fs.mkdirSync(dir, { recursive: true });
    // Settings go in the launcher too: turbo hands its tasks only a few environment variables.
    // They stop pnpm from switching to the native build a project's "packageManager" names.
    const text = `#!${path.join(PREFIX, 'bin', 'sh')}\n`
      + ': "${npm_config_manage_package_manager_versions:=false}" "${npm_config_pm_on_fail:=ignore}"\n'
      + 'export npm_config_manage_package_manager_versions npm_config_pm_on_fail\n'
      + `exec node ${JSON.stringify(target)} "$@"\n`;
    const file = path.join(dir, name);
    try { if (fs.readFileSync(file, 'utf8') === text) continue; } catch {}
    fs.writeFileSync(file, text, { mode: 0o755 });
  }
  return dir;
}

module.exports = { ensure, shimDir };
