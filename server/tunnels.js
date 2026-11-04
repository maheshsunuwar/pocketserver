'use strict';
// Public URLs through Cloudflare Tunnel: no port forwarding, works on mobile data and behind any router.
//  - Quick tunnel per app: free random https://xxxx.trycloudflare.com address, no account needed.
//  - Named tunnel (optional): paste a Cloudflare tunnel token in Settings to use your own domains.
const { state, save } = require('./store');
const S = require('./supervisor');
const pkgs = require('./packages');
const { paths } = require('./util');

async function enableApp(a) {
  await pkgs.ensure(['cloudflared'], (l) => S.log('tunnel-' + a.id, l, 'out'));
  a.public = { enabled: true, url: null };
  save();
  const key = 'tunnel-' + a.id;
  await S.stop(key);
  S.start(key, {
    cmd: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:${a.port}`,
    cwd: paths.home,
    env: process.env,
    onLine: (l) => {
      const m = l.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && a.public && a.public.url !== m[0]) {
        a.public.url = m[0];
        save();
        S.bus.emit('status', a.id, 'public-url');
      }
    },
  });
}

async function disableApp(a) {
  a.public = { enabled: false, url: null };
  save();
  await S.stop('tunnel-' + a.id);
}

async function applyNamedTunnel() {
  const token = state.settings.cloudflareToken;
  await S.stop('tunnel-main');
  if (!token) return;
  await pkgs.ensure(['cloudflared'], (l) => S.log('tunnel-main', l, 'out'));
  S.start('tunnel-main', {
    cmd: 'cloudflared tunnel --no-autoupdate run',
    cwd: paths.home,
    env: { ...process.env, TUNNEL_TOKEN: token }, // via env so it never shows in the process list
  });
}

module.exports = { enableApp, disableApp, applyNamedTunnel };
