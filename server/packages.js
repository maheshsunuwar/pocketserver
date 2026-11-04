'use strict';
// Installs missing runtimes on demand (Termux packages), so a Python or Go app "just works".
const { which, run, isTermux } = require('./util');

// command → Termux package that provides it
const TERMUX_PKG = {
  node: 'nodejs-lts', npm: 'nodejs-lts', python: 'python', go: 'golang', cargo: 'rust', php: 'php',
  composer: 'composer', git: 'git', cloudflared: 'cloudflared', postgres: 'postgresql', initdb: 'postgresql',
  psql: 'postgresql', mariadbd: 'mariadb', 'mariadb-install-db': 'mariadb', mariadb: 'mariadb',
  'redis-server': 'redis', 'termux-battery-status': 'termux-api',
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

module.exports = { ensure };
