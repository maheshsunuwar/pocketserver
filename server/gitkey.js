'use strict';
// One SSH key per PocketServer install, used to clone private repos. The user adds the public
// half to GitHub/GitLab as a read-only "deploy key"; the private half never leaves the phone.
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('./util');
const pkgs = require('./packages');

const dir = path.join(U.paths.home, 'ssh');
const keyFile = path.join(dir, 'id_ed25519');
const knownHosts = path.join(dir, 'known_hosts');

async function ensureKey() {
  if (fs.existsSync(keyFile) && fs.existsSync(keyFile + '.pub')) return;
  await pkgs.ensure(['ssh-keygen']);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(keyFile, { force: true });
  fs.rmSync(keyFile + '.pub', { force: true });
  const host = (U.getprop('ro.product.model') || os.hostname()).replace(/[^\w.-]+/g, '-');
  await U.run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `pocketserver@${host}`, '-f', keyFile], { label: 'ssh-keygen' });
}

async function publicKey() {
  await ensureKey();
  return fs.readFileSync(keyFile + '.pub', 'utf8').trim();
}

const isSshUrl = (url) => /^(git@|ssh:\/\/)/.test(url) || /^[\w.-]+@[\w.-]+:/.test(url);

/** Environment for git commands. SSH URLs use PocketServer's key and remember the host on first use. */
async function env(url) {
  const e = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (isSshUrl(url)) {
    await pkgs.ensure(['ssh']);
    await ensureKey();
    const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
    e.GIT_SSH_COMMAND = `ssh -i ${q(keyFile)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${q(knownHosts)}`;
  }
  return e;
}

/** Turns "github.com/you/app" or "you/app" into a full URL. Leaves real URLs alone. */
function normalize(input) {
  const r = String(input || '').trim().replace(/\/+$/, '');
  if (/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(r)) return r;
  if (/^(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/[\w.-]+\/[\w.-]+/i.test(r)) return 'https://' + r;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r}`;
  return r;
}

/** Adds a hint to git errors that usually mean "this repo is private". */
function explain(err, url) {
  const out = `${err.output || ''}\n${err.message}`;
  if (/Repository not found|returned error: 404/i.test(out)) {
    const ssh = isSshUrl(url) ? null : sshUrlFor(url);
    return new Error(`${err.message}. The repository wasn't found. Check the address. If it's private, ${ssh ? `use ${ssh} and ` : ''}add PocketServer's SSH key to it (Settings → Git access).`);
  }
  if (/Permission denied \(publickey\)|Could not read from remote repository|Host key verification failed/i.test(out)) {
    return new Error(`${err.message}. Git couldn't log in. Add PocketServer's SSH key to the repository (Settings → Git access on this dashboard), then redeploy.`);
  }
  if (/could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[13]/i.test(out)) {
    const ssh = sshUrlFor(url);
    return new Error(`${err.message}. The repository wasn't found or is private.${ssh ? ` For a private repo use ${ssh} and add PocketServer's SSH key to it (Settings → Git access).` : ''}`);
  }
  return err;
}

/** https://github.com/you/app(.git) → git@github.com:you/app.git */
function sshUrlFor(url) {
  const m = String(url).match(/^https?:\/\/(?:[^@/]+@)?(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `git@${m[1]}:${m[2]}/${m[3]}.git` : null;
}

module.exports = { publicKey, env, normalize, explain, isSshUrl, sshUrlFor };
