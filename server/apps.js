'use strict';
// Applications: create, deploy from Git (or a plain command), run, auto-deploy on new commits.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');
const { state, save } = require('./store');
const S = require('./supervisor');
const { detect, resolveStaticDir } = require('./detect');
const pkgs = require('./packages');
const ports = require('./ports');
const tunnels = require('./tunnels');

const STATIC_SERVER = path.join(__dirname, 'static-serve.js');
const POLL_MS = 2 * 60 * 1000;
const appDir = (id) => path.join(U.paths.apps, id);
const srcDir = (id) => path.join(appDir(id), 'src');
const deploying = new Set();
const pending = new Set();

function get(id) {
  const a = state.apps[id];
  if (!a) throw new U.HttpError(404, 'App not found.');
  return a;
}

function parseEnv(env) {
  if (typeof env === 'string') {
    const out = {};
    for (const raw of env.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) throw U.bad(`This environment line needs KEY=value: "${line.slice(0, 40)}"`);
      let v = line.slice(i + 1).trim();
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      out[line.slice(0, i).trim().replace(/^export\s+/, '')] = v;
    }
    env = out;
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw U.bad('Environment must be KEY=value lines.');
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw U.bad(`"${k}" isn't a valid variable name.`);
    env[k] = String(v);
  }
  return env;
}

/** Validates user input and copies it onto the app. Returns which kinds of things changed. */
function applyInput(a, input, isNew) {
  const changed = { source: false, build: false, start: false, run: false };
  if (isNew || input.name !== undefined) {
    const n = String(input.name || '').trim();
    if (!n) throw U.bad('Give the app a name.');
    if (n.length > 60) throw U.bad('That name is too long.');
    a.name = n;
  }
  if (isNew) a.source = input.source === 'command' ? 'command' : 'git';
  if (a.source === 'git') {
    if (isNew || input.repo !== undefined) {
      const r = String(input.repo || '').trim();
      if (!r) throw U.bad('Enter a Git repository URL.');
      if (r.startsWith('-') || /\s/.test(r) || !/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(r)) {
        throw U.bad('Use an https:// or git@ repository URL.');
      }
      if (a.repo !== r) changed.source = true;
      a.repo = r;
    }
    if (input.branch !== undefined) {
      const b = String(input.branch).trim();
      if (b && (!/^[\w./-]+$/.test(b) || b.startsWith('-'))) throw U.bad('That branch name has unexpected characters.');
      if ((a.branch || '') !== b) changed.source = true;
      a.branch = b;
    }
    if (input.subdir !== undefined) {
      const s = String(input.subdir).trim().replace(/^\/+|\/+$/g, '');
      if (s.split('/').includes('..')) throw U.bad('Subdirectory can\'t contain "..".');
      if ((a.subdir || '') !== s) changed.build = true;
      a.subdir = s;
    }
  }
  a.commands = a.commands || {};
  for (const k of ['install', 'build', 'start']) {
    if (input[k] === undefined) continue;
    const v = String(input[k]).trim();
    if ((a.commands[k] || '') !== v) changed[k === 'start' ? 'start' : 'build'] = true;
    a.commands[k] = v;
  }
  if (a.source === 'command' && !a.commands.start) throw U.bad('Enter the command that starts your app.');
  if (input.env !== undefined) {
    const env = parseEnv(input.env);
    if (JSON.stringify(env) !== JSON.stringify(a.env || {})) changed.run = true;
    a.env = env;
  }
  if (input.autoDeploy !== undefined) a.autoDeploy = !!input.autoDeploy;
  return changed;
}

function view(a) {
  const p = S.info(a.id);
  return {
    id: a.id, name: a.name, source: a.source, repo: a.repo, branch: a.branch || '', subdir: a.subdir || '',
    commands: a.commands || {}, env: a.env || {}, port: a.port, autoDeploy: !!a.autoDeploy,
    webhookSecret: a.webhookSecret, public: a.public || { enabled: false, url: null },
    type: a.plan ? a.plan.type : null, lastDeploy: a.lastDeploy || null, createdAt: a.createdAt,
    desired: a.desired, status: deploying.has(a.id) ? 'deploying' : p.status,
    pid: p.pid, startedAt: p.startedAt, restarts: p.restarts,
    tunnel: S.info('tunnel-' + a.id).status,
  };
}

function envFor(a, cwd, plan, runtime) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('POCKETHOST_')) delete env[k];
  env.PORT = String(a.port);
  env.HOST = '0.0.0.0';
  if (runtime) env.NODE_ENV = 'production'; // not during install: npm would skip devDependencies needed to build
  if (plan && plan.pathPrefix) {
    env.PATH = path.join(cwd, plan.pathPrefix) + ':' + env.PATH;
    env.VIRTUAL_ENV = path.join(cwd, '.venv');
  }
  return Object.assign(env, a.env || {});
}

function startProc(a) {
  if (!a.plan) return false;
  // A plain-command app can have its start command edited without a redeploy.
  const cmd = a.source === 'command' ? a.commands.start : a.plan.start;
  S.start(a.id, { cmd, cwd: a.plan.cwd, env: envFor(a, a.plan.cwd, a.plan, true) });
  return true;
}

async function create(input) {
  const a = {
    id: U.id(), createdAt: Date.now(), env: {}, autoDeploy: true, desired: 'running',
    webhookSecret: U.secret(18), public: { enabled: false, url: null },
  };
  applyInput(a, input, true);
  a.port = input.port ? ports.validate(input.port, a.id) : await ports.allocate(3001, a.id);
  state.apps[a.id] = a;
  save();
  deploy(a.id, 'first deploy').catch(() => {});
  return view(a);
}

async function update(id, input) {
  const a = get(id);
  const before = JSON.stringify(a);
  let changed;
  try {
    changed = applyInput(a, input, false);
    if (input.port !== undefined && Number(input.port) !== a.port) {
      a.port = ports.validate(input.port, a.id);
      changed.run = true;
    }
  } catch (e) {
    Object.assign(a, JSON.parse(before)); // leave the app untouched on bad input
    throw e;
  }
  if (changed.source) a.repoChanged = true;
  save();
  if (a.desired === 'running') {
    const redeploy = changed.source || changed.build || (changed.start && a.source === 'git');
    if (redeploy) {
      deploy(id, 'settings changed').catch(() => {});
    } else if ((changed.run || changed.start) && !deploying.has(id)) {
      await S.stop(id);
      if (!startProc(a)) deploy(id, 'settings changed').catch(() => {});
      if (a.public && a.public.enabled) tunnels.enableApp(a).catch(() => {});
    }
  }
  return view(a);
}

async function deploy(id, reason = 'manual') {
  const a = get(id);
  const log = (m, src = 'sys') => S.log(id, m, src);
  if (deploying.has(id)) {
    pending.add(id);
    log('A deploy is already running. Another one will start when it finishes.');
    return;
  }
  deploying.add(id);
  a.desired = 'running';
  S.bus.emit('status', id, 'deploying');
  const t0 = Date.now();
  log(`━━━ Deploy started (${reason}) ━━━`);
  let sha = null;
  let commit = null;
  try {
    let cwd;
    if (a.source === 'git') {
      await pkgs.ensure(['git'], (l) => log(l, 'out'));
      const src = srcDir(id);
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      if (a.repoChanged) { fs.rmSync(src, { recursive: true, force: true }); delete a.repoChanged; }
      if (!fs.existsSync(path.join(src, '.git'))) {
        fs.rmSync(src, { recursive: true, force: true });
        fs.mkdirSync(appDir(id), { recursive: true });
        const args = ['clone', '--depth', '1'];
        if (a.branch) args.push('--branch', a.branch);
        args.push('--', a.repo, src);
        log(`Cloning ${a.repo}${a.branch ? ` (branch ${a.branch})` : ''}`);
        await U.run('git', args, { env, onLine: (l) => log(l, 'out'), label: 'git clone', timeout: 15 * 60e3 });
      } else {
        log('Pulling the latest code');
        await U.run('git', ['fetch', '--depth', '1', 'origin', a.branch || 'HEAD'], { cwd: src, env, onLine: (l) => log(l, 'out'), label: 'git fetch', timeout: 15 * 60e3 });
        await U.run('git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: src, env, label: 'git reset' });
        await U.run('git', ['clean', '-fdx', '-e', 'node_modules', '-e', '.venv', '-e', 'vendor', '-e', 'target'], { cwd: src, env, label: 'git clean' });
      }
      sha = (await U.run('git', ['rev-parse', 'HEAD'], { cwd: src })).trim();
      commit = (await U.run('git', ['log', '-1', '--pretty=%s'], { cwd: src })).trim();
      a.attemptedSha = sha;
      log(`Commit ${sha.slice(0, 7)}: ${commit}`);
      cwd = a.subdir ? path.join(src, a.subdir) : src;
      if (!fs.existsSync(cwd)) throw new Error(`Folder "${a.subdir}" wasn't found in the repository.`);
    } else {
      cwd = path.join(appDir(id), 'work');
      fs.mkdirSync(cwd, { recursive: true });
    }

    const auto = a.source === 'git' ? detect(cwd) : { type: 'command', needs: [] };
    const c = a.commands || {};
    const plan = { ...auto, install: c.install || auto.install || null, build: c.build || auto.build || null, start: c.start || auto.start || null };
    if (c.start) { delete plan.staticDir; delete plan.error; }
    if (a.source === 'git') log(`Detected app type: ${auto.type}`);
    if (plan.error && !plan.start && !plan.staticDir) throw new Error(plan.error);

    await pkgs.ensure(plan.needs || [], (l) => log(l, 'out'));
    const buildEnv = envFor(a, cwd, plan, false);
    if (plan.install) {
      log(`Installing dependencies: ${plan.install}`);
      await U.sh(plan.install, { cwd, env: buildEnv, onLine: (l) => log(l, 'out'), label: 'Install step' });
    }
    if (plan.build) {
      log(`Building: ${plan.build}`);
      await U.sh(plan.build, { cwd, env: buildEnv, onLine: (l) => log(l, 'out'), label: 'Build step' });
    }
    if (plan.staticDir) {
      const dir = resolveStaticDir(cwd, plan.staticDir);
      if (!dir) throw new Error('The build finished, but no dist/, build/ or out/ folder with an index.html was found. Set a start command under Advanced.');
      plan.start = `node ${JSON.stringify(STATIC_SERVER)} ${JSON.stringify(dir)}`;
      log(`Serving static files from ${path.relative(cwd, dir) || '.'}/`);
    }
    if (!plan.start) throw new Error('There is no start command. Set one under Advanced.');

    a.plan = { type: plan.type, start: plan.start, cwd, pathPrefix: plan.pathPrefix || null };
    save();
    await S.stop(id);
    startProc(a);
    log(`Waiting for the app to listen on port ${a.port}…`);
    const up = await U.waitPort(a.port, 90000, () => { const i = S.info(id); return i.status !== 'stopped' && i.restarts < 3; });
    if (!up && S.info(id).restarts >= 3) throw new Error('The app keeps crashing right after it starts. Check the logs above.');
    a.lastDeploy = { ok: true, at: Date.now(), sha, commit, seconds: Math.round((Date.now() - t0) / 1000), reason, listening: up };
    log(up
      ? `✓ Deployed in ${a.lastDeploy.seconds}s. Listening on port ${a.port}.`
      : `⚠ The app started but isn't answering on port ${a.port}. Make sure it listens on the PORT environment variable (and 0.0.0.0).`);
    if (a.public && a.public.enabled && S.info('tunnel-' + id).status !== 'running') tunnels.enableApp(a).catch(() => {});
  } catch (e) {
    log(`✗ Deploy failed: ${e.message}`, 'err');
    a.lastDeploy = { ok: false, at: Date.now(), sha, commit, seconds: Math.round((Date.now() - t0) / 1000), reason, error: e.message };
  } finally {
    deploying.delete(id);
    save();
    S.bus.emit('status', id, S.info(id).status);
    if (pending.delete(id) && state.apps[id]) deploy(id, 'queued').catch(() => {});
  }
}

async function start(id) {
  const a = get(id);
  a.desired = 'running';
  save();
  if (!startProc(a)) await deploy(id, 'start');
  if (a.public && a.public.enabled) tunnels.enableApp(a).catch(() => {});
}

async function stop(id) {
  const a = get(id);
  a.desired = 'stopped';
  save();
  pending.delete(id);
  await S.stop(id);
}

async function restart(id) {
  const a = get(id);
  a.desired = 'running';
  save();
  await S.stop(id);
  if (!startProc(a)) await deploy(id, 'restart');
}

async function remove(id) {
  const a = get(id);
  a.desired = 'stopped';
  pending.delete(id);
  await S.stop(id);
  await tunnels.disableApp(a);
  S.forget(id);
  S.forget('tunnel-' + id);
  S.dropLogs(id);
  S.dropLogs('tunnel-' + id);
  fs.rmSync(appDir(id), { recursive: true, force: true });
  delete state.apps[id];
  save();
}

async function setPublic(id, enabled) {
  const a = get(id);
  if (enabled) await tunnels.enableApp(a);
  else await tunnels.disableApp(a);
  return view(a);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** GitHub / GitLab / Gitea push webhooks, or any POST with ?token=<secret>. */
function webhook(id, req, raw, query) {
  const a = state.apps[id];
  if (!a) throw new U.HttpError(404, 'Not found');
  const sig = req.headers['x-hub-signature-256'] || req.headers['x-gitea-signature'];
  let ok = false;
  if (sig) {
    const hex = crypto.createHmac('sha256', a.webhookSecret).update(raw).digest('hex');
    ok = safeEqual(sig.replace(/^sha256=/, ''), hex);
  } else {
    const token = query.get('token') || req.headers['x-gitlab-token'];
    ok = !!token && safeEqual(token, a.webhookSecret);
  }
  if (!ok) throw new U.HttpError(401, 'Bad signature or token.');
  if ((req.headers['x-github-event'] || '') === 'ping') return { ok: true, pong: true };
  try {
    const body = JSON.parse(raw.toString('utf8') || '{}');
    if (a.branch && body.ref && body.ref !== `refs/heads/${a.branch}`) return { ok: true, skipped: `push to ${body.ref}` };
  } catch {}
  deploy(id, 'webhook').catch(() => {});
  return { ok: true, deploying: true };
}

// Checks for new commits every couple of minutes. Works behind home routers, where webhooks can't reach.
let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    for (const a of Object.values(state.apps)) {
      if (a.source !== 'git' || !a.autoDeploy || a.desired !== 'running' || deploying.has(a.id) || !a.attemptedSha) continue;
      if (Date.now() - (a.lastPoll || 0) < POLL_MS) continue;
      a.lastPoll = Date.now();
      try {
        const ref = a.branch ? `refs/heads/${a.branch}` : 'HEAD';
        const out = await U.run('git', ['ls-remote', '--', a.repo, ref], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, label: 'git ls-remote' });
        const sha = out.split(/\s/)[0];
        if (/^[0-9a-f]{40}$/.test(sha) && sha !== a.attemptedSha) {
          S.log(a.id, `New commit ${sha.slice(0, 7)} found on the remote.`, 'sys');
          deploy(a.id, 'new commit').catch(() => {});
        }
      } catch {}
    }
  } finally { polling = false; }
}
setInterval(pollOnce, 30000).unref();

/** On PocketHost start: bring back everything that was running. */
function restore() {
  for (const a of Object.values(state.apps)) {
    delete a.repoChanged;
    if (a.desired !== 'running') continue;
    if (!startProc(a)) deploy(a.id, 'startup').catch(() => {});
    if (a.public && a.public.enabled) tunnels.enableApp(a).catch(() => {});
  }
}

const list = () => Object.values(state.apps).sort((x, y) => x.createdAt - y.createdAt).map(view);
const one = (id) => view(get(id));
const isDeploying = (id) => deploying.has(id);

module.exports = { list, one, create, update, deploy, start, stop, restart, remove, setPublic, webhook, restore, isDeploying };
