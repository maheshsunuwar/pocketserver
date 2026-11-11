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
const gitkey = require('./gitkey');

const STATIC_SERVER = path.join(__dirname, 'static-serve.js');
const ANDROID_NODE = path.join(__dirname, 'android-node.js');
const POLL_MS = 2 * 60 * 1000;
const appDir = (id) => path.join(U.paths.apps, id);
const srcDir = (id) => path.join(appDir(id), 'src');
const dataDir = (id) => path.join(appDir(id), 'data');
const containerName = (id) => `pocketserver-${id}`;
const lanUrl = (port) => `http://${(U.localIPs()[0] || {}).address || 'localhost'}:${port}`;
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
  if (isNew) a.source = ['command', 'docker'].includes(input.source) ? input.source : 'git';
  if (a.source === 'docker') {
    a.docker = a.docker || { volumes: [] };
    if (isNew || input.image !== undefined) {
      const img = String(input.image || '').trim();
      if (!img) throw U.bad('Enter a Docker image, like louislam/uptime-kuma:2.');
      if (img.startsWith('-') || !/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(img)) throw U.bad("That doesn't look like a Docker image name.");
      if (a.docker.image !== img) changed.source = true;
      a.docker.image = img;
    }
    if (input.containerPort !== undefined) {
      const cp = input.containerPort === null || input.containerPort === '' ? null : Number(input.containerPort);
      if (cp !== null && (!Number.isInteger(cp) || cp < 1 || cp > 65535)) throw U.bad('Container port must be a number between 1 and 65535.');
      if (a.docker.containerPort !== cp) changed.run = true;
      a.docker.containerPort = cp;
    }
    if (input.volumes !== undefined) {
      const vols = (Array.isArray(input.volumes) ? input.volumes : String(input.volumes).split('\n')).map((v) => String(v).trim()).filter(Boolean);
      for (const v of vols) if (!v.startsWith('/') || v.includes('..') || /[\s:]/.test(v)) throw U.bad(`Volumes are folders inside the container, like /data. "${v}" isn't one.`);
      if (JSON.stringify(vols) !== JSON.stringify(a.docker.volumes)) changed.run = true;
      a.docker.volumes = vols;
    }
    if (input.command !== undefined) {
      const c = String(input.command || '').trim();
      if ((a.docker.command || '') !== c) changed.run = true;
      a.docker.command = c;
    }
  }
  if (a.source === 'git') {
    if (isNew || input.repo !== undefined) {
      const r = gitkey.normalize(input.repo);
      if (!r) throw U.bad('Enter a Git repository URL.');
      if (r.startsWith('-') || /\s/.test(r) || !/^(https?:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(r)) {
        throw U.bad('Use a GitHub link, an https:// URL or a git@ SSH URL.');
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
  if (a.source === 'docker' && changed.start) changed.run = true;
  if (input.env !== undefined) {
    const env = parseEnv(input.env);
    if (JSON.stringify(env) !== JSON.stringify(a.env || {})) changed.run = true;
    a.env = env;
  }
  if (input.databases !== undefined) {
    if (!Array.isArray(input.databases)) throw U.bad('databases must be a list of database ids.');
    const ids = [...new Set(input.databases.map(String))];
    for (const dbId of ids) if (!state.databases[dbId]) throw U.bad('One of those databases no longer exists. Reload the page.');
    if (JSON.stringify(ids) !== JSON.stringify(a.databases || [])) changed.run = true;
    a.databases = ids;
  }
  if (input.autoDeploy !== undefined) a.autoDeploy = !!input.autoDeploy;
  return changed;
}

/**
 * Connection settings for the databases connected to an app, under the names most frameworks read.
 * Built at each start, so a database's new port or password reaches the app on restart.
 */
function linkedEnv(a) {
  const env = {};
  const set = (k, v) => { if (!(k in env)) env[k] = String(v); };
  for (const dbId of a.databases || []) {
    const d = state.databases[dbId];
    if (!d) continue;
    const url = require('./databases').TYPES[d.type].url(d, '127.0.0.1');
    if (d.type === 'postgres') {
      set('DATABASE_URL', url);
      set('POSTGRES_URL', url);
      Object.entries({ PGHOST: '127.0.0.1', PGPORT: d.port, PGUSER: 'postgres', PGPASSWORD: d.password, PGDATABASE: d.dbName }).forEach(([k, v]) => set(k, v));
    } else if (d.type === 'mariadb') {
      set('DATABASE_URL', url);
      set('MYSQL_URL', url);
      Object.entries({ MYSQL_HOST: '127.0.0.1', MYSQL_PORT: d.port, MYSQL_USER: 'app', MYSQL_PASSWORD: d.password, MYSQL_DATABASE: d.dbName }).forEach(([k, v]) => set(k, v));
    } else if (d.type === 'redis') {
      set('REDIS_URL', url);
      Object.entries({ REDIS_HOST: '127.0.0.1', REDIS_PORT: d.port, REDIS_PASSWORD: d.password }).forEach(([k, v]) => set(k, v));
    }
  }
  return env;
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
    docker: a.docker || null, credentials: a.credentials || null, catalog: a.catalog || null,
    dependsOn: a.dependsOn || [], dataDir: dataDir(a.id),
    databases: (a.databases || []).filter((dbId) => state.databases[dbId]), linkedEnv: linkedEnv(a), detected: a.detected || null,
  };
}

// Packages without prebuilt Android wheels/binaries get compiled on the phone. When a step fails
// because a compiler is missing, install it and try once more.
const TOOLCHAINS = [
  { bin: 'cargo', name: 'Rust', re: /Rust not found|can't find Rust compiler|cargo: (command )?not found|rustc.*not found|Cargo, the Rust package manager, is not installed/i },
  { bin: 'clang', name: 'a C compiler', re: /unable to execute '?(clang|gcc|cc)'?|(clang|gcc|cc): (command )?not found|command '(clang|gcc|cc)' failed|No such file or directory: '(cc|gcc|clang)'/i },
  { bin: 'make', name: 'make', re: /make: (command )?not found|No such file or directory: 'make'/i },
];
async function finishStart(a, t0, reason, sha, commit, log) {
  const id = a.id;
  log(`Waiting for the app to listen on port ${a.port}…`);
  // Docker images can take a while on first start (unpacking, migrations).
  const wait = a.source === 'docker' ? 5 * 60e3 : 90000;
  const up = await U.waitPort(a.port, wait, () => { const i = S.info(id); return i.status !== 'stopped' && i.restarts < 3; });
  if (!up && S.info(id).restarts >= 3) throw new Error('The app keeps crashing right after it starts. Check the logs above.');
  a.lastDeploy = { ok: true, at: Date.now(), sha, commit, seconds: Math.round((Date.now() - t0) / 1000), reason, listening: up };
  log(up
    ? `✓ Deployed in ${a.lastDeploy.seconds}s. Listening on port ${a.port}.`
    : a.source === 'docker'
      ? `⚠ The container started but isn't answering on port ${a.port}. Check the container port in Settings, and the logs above.`
      : `⚠ The app started but isn't answering on port ${a.port}. Make sure it listens on the PORT environment variable (and 0.0.0.0).`);
  if (a.public && a.public.enabled && S.info('tunnel-' + id).status !== 'running') tunnels.enableApp(a).catch(() => {});
}

/** Apps installed with a database wait until it's ready (it may still be installing). */
async function waitForDatabases(a, log) {
  for (const dbId of new Set([...(a.dependsOn || []), ...(a.databases || [])])) {
    const d = state.databases[dbId];
    if (!d) continue;
    const ready = () => d.initialized && S.info(dbId).status === 'running';
    if (ready()) continue;
    log(`Waiting for the database "${d.name}" to be ready…`, 'sys');
    const until = Date.now() + 15 * 60e3;
    while (!ready()) {
      if (d.error && !require('./databases').isStarting(dbId)) throw new Error(`The database "${d.name}" failed to start: ${d.error}`);
      if (Date.now() > until) throw new Error(`The database "${d.name}" isn't ready after 15 minutes. Check its logs.`);
      await U.sleep(2000);
    }
  }
}

const PLATFORM = { arm64: 'linux/arm64', arm: 'linux/arm/v7', x64: 'linux/amd64' }[process.arch] || 'linux/arm64';

/**
 * Docker apps run through proot, which some phone kernels break: any container that starts a second
 * process hangs forever (termux/proot#417, kernels missing the upstream ptrace_stop freezer fix, seen on
 * LineageOS 24 with 4.14 kernels). Checked once, in a few seconds, so a deploy fails with a clear
 * reason instead of hanging.
 */
let prootWorks;
async function checkProot() {
  if (prootWorks === undefined) {
    prootWorks = await U.run('timeout', ['-s', 'KILL', '10', 'proot', 'sh', '-c', 'echo ok | cat'], { timeout: 15000, label: 'proot check' })
      .then((out) => /ok/.test(out), () => false);
  }
  if (!prootWorks) {
    throw new Error("Docker apps can't run on this phone: its kernel has a bug that makes proot (which runs the containers) hang. "
      + 'Phones with a stock kernel (Samsung, Pixel...) are fine. Native apps and databases are not affected. '
      + 'Details: https://github.com/termux/proot/issues/417');
  }
}

/** udocker names a container only when create finishes. Remove the unnamed ones a failed create left. */
async function removeUnnamedContainers(img) {
  const out = await U.run('udocker', ['ps'], { label: 'udocker ps', timeout: 30000 }).catch(() => '');
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f-]{36})\s+\S+\s+\S+\s+(\S+)\s*$/.exec(line.trim()); // id, P, M, image (no name)
    if (m && m[2] === img) await U.run('udocker', ['rm', m[1]], { label: 'udocker rm', timeout: 60000 }).catch(() => {});
  }
}

/** true / false once checked, null before. Checked in the background at startup where proot exists. */
const dockerWorks = () => (prootWorks === undefined ? null : prootWorks);
if (U.isTermux && U.which('proot')) setTimeout(() => checkProot().catch(() => {}), 5000).unref();

async function deployDocker(a, log) {
  const img = a.docker.image;
  await pkgs.ensure(['udocker', 'proot'], (l) => log(l, 'out'));
  await checkProot();
  log(`Pulling ${img} (${PLATFORM})…`);
  await U.run('udocker', ['pull', `--platform=${PLATFORM}`, img], { onLine: (l) => log(l, 'out'), label: 'udocker pull', timeout: 60 * 60e3 })
    .catch((e) => {
      if (/manifest|platform|not found|no image/i.test(e.output || '')) {
        throw new Error(`Couldn't pull ${img} for this phone (${PLATFORM}). Check the name, and that the image is published for ${PLATFORM}.`);
      }
      throw e;
    });
  // Recreate the container on every deploy (like docker compose up): your data lives in volumes.
  await U.run('udocker', ['rm', containerName(a.id)], { label: 'udocker rm' }).catch(() => {});
  log('Creating the container…');
  await U.run('udocker', ['create', `--name=${containerName(a.id)}`, img], { onLine: (l) => log(l, 'out'), label: 'udocker create', timeout: 30 * 60e3 })
    .catch(async (e) => { await removeUnnamedContainers(img); throw e; });
}

/**
 * Rust-based npm packages (napi-rs) often have no Android build, but ship a WebAssembly one that npm
 * skips because it's marked for another CPU. Finds which one a failed step was missing.
 */
function missingWasiPackage(output, cwd) {
  const m = /Cannot find module '((?:@[\w.-]+\/)?[\w.-]+)-android-arm(?:64|-eabi)'[\s\S]*?Require stack:\s*\n.*?- (\S+)/.exec(output);
  if (!m) return null;
  const want = `${m[1]}-wasm32-wasi`;
  let dir = path.dirname(m[2].trim());
  for (let i = 0; i < 4 && dir.startsWith(cwd); i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const version = (pkg.optionalDependencies || {})[want];
      // The node_modules folder holding the package that needs it: Node looks there first.
      let into = path.dirname(dir);
      if (path.basename(into).startsWith('@')) into = path.dirname(into);
      if (version && path.basename(into) === 'node_modules') return { spec: `${want}@${version}`, into };
    } catch {}
  }
  return null;
}

/**
 * Installs a WebAssembly package next to the package that needs it. Installed into a separate folder
 * with npm and copied over, so it works the same in npm, pnpm and yarn projects.
 */
async function installWasi({ spec, into }, cwd, env, log) {
  const tmp = path.join(cwd, '.pocketserver-wasi');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await U.run('npm', ['install', '--no-save', '--no-package-lock', '--force', '--no-audit', '--no-fund', spec],
      { cwd: tmp, env, onLine: (l) => log(l, 'out'), label: `npm install ${spec}`, timeout: 15 * 60e3 });
    const copy = (from, to) => {
      for (const name of fs.readdirSync(from)) {
        if (name.startsWith('.')) continue;
        const f = path.join(from, name);
        const t = path.join(to, name);
        if (name.startsWith('@')) { fs.mkdirSync(t, { recursive: true }); copy(f, t); } else if (!fs.existsSync(t)) fs.cpSync(f, t, { recursive: true });
      }
    };
    copy(path.join(tmp, 'node_modules'), into);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runStep(cmd, label, cwd, env, log) {
  const tried = new Set();
  for (;;) {
    try {
      return await U.sh(cmd, { cwd, env, onLine: (l) => log(l, 'out'), label, timeout: 60 * 60e3 });
    } catch (e) {
      const out = e.output || '';
      const wasi = U.isTermux && missingWasiPackage(out, cwd);
      if (wasi && !tried.has(wasi.spec)) {
        tried.add(wasi.spec);
        log(`${wasi.spec.replace(/-wasm32-wasi@.*/, '')} has no Android build. Installing its WebAssembly version and trying again…`, 'sys');
        await installWasi(wasi, cwd, env, log);
        continue;
      }
      const tc = U.isTermux && TOOLCHAINS.find((t) => !tried.has(t.bin) && t.re.test(out));
      if (!tc) throw e;
      tried.add(tc.bin);
      log(`This app needs ${tc.name} to build some of its packages. Installing it (one time, can take a few minutes)…`, 'sys');
      await pkgs.ensure([tc.bin], (l) => log(l, 'out'));
      log(`Retrying: ${cmd}`, 'sys');
    }
  }
}

function envFor(a, cwd, plan, runtime) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('POCKETSERVER_')) delete env[k];
  env.PORT = String(a.port);
  env.HOST = '0.0.0.0';
  env.APP_DATA = dataDir(a.id); // private folder that survives redeploys
  env.APP_URL = lanUrl(a.port);
  // Python packages built with Rust (maturin) refuse to build on Android without this.
  if (U.isTermux && !env.ANDROID_API_LEVEL) env.ANDROID_API_LEVEL = U.getprop('ro.build.version.sdk') || '24';
  // Start programs directly instead of through Android's linker where allowed (see util.canExecDirectly).
  if (U.isTermux && U.canExecDirectly()) env.TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE ??= 'disable';
  const shims = pkgs.shimDir(); // a pnpm launcher that works on Android (see packages.js)
  if (shims) env.PATH = `${shims}:${env.PATH}`;
  // Lets older Rust-based Python packages build for a Python newer than they know about.
  if (U.isTermux && !env.PYO3_USE_ABI3_FORWARD_COMPATIBILITY) env.PYO3_USE_ABI3_FORWARD_COMPATIBILITY = '1';
  if (U.isTermux) env.NODE_OPTIONS = `--require ${JSON.stringify(ANDROID_NODE)} ${env.NODE_OPTIONS || ''}`.trim();
  if (runtime) env.NODE_ENV = 'production'; // not during install: npm would skip devDependencies needed to build
  if (plan && plan.pathPrefix) {
    env.PATH = path.join(cwd, plan.pathPrefix) + ':' + env.PATH;
    env.VIRTUAL_ENV = path.join(cwd, '.venv');
  }
  return Object.assign(env, linkedEnv(a), a.env || {});
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The udocker command that runs a Docker app. Built at each start so env/port edits apply on restart. */
function dockerCmd(a) {
  const d = a.docker;
  const cport = d.containerPort || a.port;
  const fill = (s) => String(s).replace(/\{\{port\}\}/g, String(cport));
  const args = ['exec', 'udocker', '--quiet', 'run', '--nobanner'];
  if (cport !== a.port) args.push(`--publish=${a.port}:${cport}`);
  args.push(`--env=${shq(`PORT=${cport}`)}`);
  for (const [k, v] of Object.entries({ ...linkedEnv(a), ...(a.env || {}) })) args.push(`--env=${shq(`${k}=${fill(v)}`)}`);
  for (const v of d.volumes || []) args.push(`--volume=${shq(`${path.join(dataDir(a.id), 'volumes', v.replace(/^\/+/, '').replace(/\//g, '_'))}:${v}`)}`);
  args.push(containerName(a.id));
  if (d.command) args.push(fill(d.command)); // split by the shell, like docker run's CMD
  return args.join(' ');
}

function startProc(a) {
  if (!a.plan) return false;
  if (a.source === 'docker') {
    for (const v of a.docker.volumes || []) fs.mkdirSync(path.join(dataDir(a.id), 'volumes', v.replace(/^\/+/, '').replace(/\//g, '_')), { recursive: true });
    S.start(a.id, { cmd: dockerCmd(a), cwd: dataDir(a.id), env: { ...process.env } });
    return true;
  }
  // A plain-command app can have its start command edited without a redeploy.
  let cmd = a.source === 'command' ? a.commands.start : a.plan.start;
  // Static sites store the path of PocketServer's file server. Keep it current if PocketServer moved
  // (for example ~/pockethost → ~/pocketserver).
  cmd = cmd.replace(/"[^"]*\/server\/static-serve\.js"/, JSON.stringify(STATIC_SERVER));
  S.start(a.id, { cmd, cwd: a.plan.cwd, env: envFor(a, a.plan.cwd, a.plan, true) });
  return true;
}

async function create(input, { prepare } = {}) {
  const a = {
    id: U.id(), createdAt: Date.now(), env: {}, autoDeploy: true, desired: 'running',
    webhookSecret: U.secret(18), public: { enabled: false, url: null },
  };
  applyInput(a, input, true);
  a.port = input.port ? ports.validate(input.port, a.id) : await ports.allocate(3001, a.id);
  if (prepare) prepare(a); // catalog installs fill in env, credentials and dependencies here
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
    fs.mkdirSync(dataDir(id), { recursive: true });
    await waitForDatabases(a, log);
    if (a.packages && a.packages.length) await pkgs.ensure(a.packages, (l) => log(l, 'out'));
    if (a.source === 'docker') {
      await deployDocker(a, log);
      a.plan = { type: 'docker', start: null, cwd: dataDir(id) };
      save();
      await S.stop(id);
      startProc(a);
      await finishStart(a, t0, reason, null, null, log);
      return;
    }
    if (a.source === 'git') {
      await pkgs.ensure(['git'], (l) => log(l, 'out'));
      const src = srcDir(id);
      const env = await gitkey.env(a.repo);
      if (a.repoChanged) { fs.rmSync(src, { recursive: true, force: true }); delete a.repoChanged; }
      if (!fs.existsSync(path.join(src, '.git'))) {
        fs.rmSync(src, { recursive: true, force: true });
        fs.mkdirSync(appDir(id), { recursive: true });
        const args = ['clone', '--depth', '1'];
        if (a.branch) args.push('--branch', a.branch);
        args.push('--', a.repo, src);
        log(`Cloning ${a.repo}${a.branch ? ` (branch ${a.branch})` : ''}`);
        await U.run('git', args, { env, onLine: (l) => log(l, 'out'), label: 'git clone', timeout: 15 * 60e3 }).catch((e) => { throw gitkey.explain(e, a.repo); });
      } else {
        log('Pulling the latest code');
        await U.run('git', ['fetch', '--depth', '1', 'origin', a.branch || 'HEAD'], { cwd: src, env, onLine: (l) => log(l, 'out'), label: 'git fetch', timeout: 15 * 60e3 }).catch((e) => { throw gitkey.explain(e, a.repo); });
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

    const auto = a.source === 'git' ? detect(cwd) : { type: a.catalog ? a.catalog.id : 'command', needs: [] };
    const c = a.commands || {};
    const plan = { ...auto, install: c.install || auto.install || null, build: c.build || auto.build || null, start: c.start || auto.start || null };
    if (c.start) { delete plan.staticDir; delete plan.error; }
    if (a.source === 'git') log(`Detected app type: ${auto.type}`);
    // Shown in Settings, so people can start from the detected command when they need to change it.
    a.detected = a.source === 'git' ? { install: auto.install || '', build: auto.build || '', start: auto.staticDir ? '' : auto.start || '' } : null;
    if (plan.error && !plan.start && !plan.staticDir) throw new Error(plan.error);

    await pkgs.ensure(plan.needs || [], (l) => log(l, 'out'));
    const buildEnv = envFor(a, cwd, plan, false);
    if (plan.install) {
      log(`Installing dependencies: ${plan.install}`);
      await runStep(plan.install, 'Install step', cwd, buildEnv, log);
    }
    if (plan.build) {
      log(`Building: ${plan.build}`);
      await runStep(plan.build, 'Build step', cwd, buildEnv, log);
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
    await finishStart(a, t0, reason, sha, commit, log);
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
  if (a.source === 'docker') U.run('udocker', ['rm', containerName(id)], { label: 'udocker rm' }).catch(() => {});
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
        const out = await U.run('git', ['ls-remote', '--', a.repo, ref], { env: await gitkey.env(a.repo), timeout: 30000, label: 'git ls-remote' });
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

/** On PocketServer start: bring back everything that was running. */
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

module.exports = { dockerWorks, list, one, create, update, deploy, start, stop, restart, remove, setPublic, webhook, restore, isDeploying, dataDir, _test: { dockerCmd, missingWasiPackage } };
