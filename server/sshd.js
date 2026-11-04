'use strict';
// Optional SSH server, so you can edit app files from VS Code (SSH FS / SFTP) or open a terminal.
// Runs its own sshd with its own config: key logins only, keys managed from the dashboard.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');
const { state, save } = require('./store');
const S = require('./supervisor');
const pkgs = require('./packages');
const ports = require('./ports');

const KEY = 'sshd';
const dir = path.join(U.paths.home, 'sshd');
const conf = () => (state.settings.ssh = state.settings.ssh || { enabled: false, port: 8022, keys: [] });

function parseKey(line) {
  const m = String(line || '').trim().match(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/=]{40,})(?:\s+(.{0,200}))?$/);
  if (!m) return null;
  const fp = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(m[2], 'base64')).digest('base64').replace(/=+$/, '');
  return { type: m[1], data: m[2], comment: (m[3] || '').trim(), fingerprint: fp, addedAt: Date.now() };
}

function writeConfig(c) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Own host key, generated once, so the fingerprint stays the same across restarts.
  const hostKey = path.join(dir, 'ssh_host_ed25519_key');
  const authKeys = path.join(dir, 'authorized_keys');
  fs.writeFileSync(authKeys, c.keys.map((k) => `${k.type} ${k.data} ${k.comment}`.trim()).join('\n') + '\n', { mode: 0o600 });
  const sftp = ['/data/data/com.termux/files/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/libexec/sftp-server', '/usr/lib/ssh/sftp-server', '/opt/homebrew/libexec/sftp-server']
    .find((f) => fs.existsSync(f)) || 'internal-sftp';
  fs.writeFileSync(path.join(dir, 'sshd_config'), [
    `Port ${c.port}`,
    `HostKey ${hostKey}`,
    `AuthorizedKeysFile ${authKeys}`,
    `PidFile ${path.join(dir, 'sshd.pid')}`,
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'PermitEmptyPasswords no',
    'StrictModes no', // Termux home folders don't have the permissions sshd expects
    'PrintMotd no',
    `Subsystem sftp ${sftp}`,
  ].join('\n') + '\n', { mode: 0o600 });
  return hostKey;
}

async function apply() {
  const c = conf();
  if (!c.enabled) { await S.stop(KEY); return; }
  await pkgs.ensure(['sshd', 'ssh-keygen']);
  const hostKey = writeConfig(c);
  if (!fs.existsSync(hostKey)) await U.run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], { label: 'ssh-keygen' });
  const sshd = U.which('sshd') || '/usr/sbin/sshd';
  await S.stop(KEY);
  S.start(KEY, { cmd: `exec ${sshd} -D -e -f '${path.join(dir, 'sshd_config')}'`, cwd: os.homedir(), env: process.env });
}

function hostFingerprint() {
  try {
    const pub = fs.readFileSync(path.join(dir, 'ssh_host_ed25519_key.pub'), 'utf8').trim().split(/\s+/)[1];
    return 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('base64').replace(/=+$/, '');
  } catch { return null; }
}

function view() {
  const c = conf();
  return {
    enabled: c.enabled, port: c.port, status: S.info(KEY).status, user: os.userInfo().username,
    home: os.homedir(), appsDir: U.paths.apps, hostFingerprint: hostFingerprint(),
    keys: c.keys.map(({ type, comment, fingerprint, addedAt }) => ({ type, comment, fingerprint, addedAt })),
  };
}

async function update(input) {
  const c = conf();
  const before = JSON.stringify(c);
  try { change(c, input); } catch (e) { state.settings.ssh = JSON.parse(before); throw e; }
  save();
  await apply();
  return view();
}

function change(c, input) {
  if (input.addKey !== undefined) {
    const lines = String(input.addKey).split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw U.bad('Paste a public key.');
    for (const line of lines) {
      if (/PRIVATE KEY/.test(line)) throw U.bad("That's a private key. Paste the public one: the .pub file.");
      const k = parseKey(line);
      if (!k) throw U.bad("That doesn't look like an SSH public key. It should start with ssh-ed25519 or ssh-rsa.");
      if (!c.keys.some((x) => x.fingerprint === k.fingerprint)) c.keys.push(k);
    }
  }
  if (input.removeKey !== undefined) c.keys = c.keys.filter((k) => k.fingerprint !== input.removeKey);
  if (input.port !== undefined && Number(input.port) !== c.port) c.port = ports.validate(input.port, KEY);
  if (input.enabled !== undefined) c.enabled = !!input.enabled;
  if (c.enabled && !c.keys.length) {
    if (input.enabled) throw U.bad('Add your public key first, so only you can log in.');
    c.enabled = false; // removed the last key: nobody can log in, so turn SSH off
  }
}

function restore() { if (conf().enabled) apply().catch((e) => S.log(KEY, `✗ ${e.message}`, 'err')); }

module.exports = { view, update, restore, KEY, _test: { parseKey } };
