'use strict';
// Helper commands for bin/pocketserver that touch state while the server is stopped.
const crypto = require('crypto');
const fs = require('fs');
const { state } = require('./store');
const U = require('./util');

const [cmd, arg] = process.argv.slice(2);

if (cmd === 'password') {
  const auth = require('./auth');
  const pw = arg && arg !== '--random' ? arg : crypto.randomBytes(9).toString('base64url');
  auth.setPassword(pw);
  if (!arg || arg === '--random') {
    // Same as a fresh install: show it once, ask to change it in the dashboard.
    state.settings.initialPassword = true;
    require('./store').flush();
    fs.writeFileSync(U.paths.initialPassword, pw + '\n', { mode: 0o600 });
  }
  console.log(pw);
} else if (cmd === 'url') {
  const port = Number(process.env.POCKETSERVER_PORT || state.settings.port || 7777);
  const ips = U.localIPs();
  if (!ips.length) console.log(`http://localhost:${port}`);
  for (const ip of ips) console.log(`http://${ip.address}:${port}`);
} else if (cmd === 'port') {
  const p = Number(arg);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) { console.error('Port must be between 1024 and 65535.'); process.exit(1); }
  state.settings.port = p;
  require('./store').flush();
  console.log(`Dashboard port set to ${p}.`);
} else {
  console.error('Usage: node cli.js password [new|--random] | url | port <n>');
  process.exit(1);
}
