'use strict';
// One-click databases using native Termux packages: PostgreSQL, MariaDB (MySQL) and Redis.
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { state, save } = require('./store');
const S = require('./supervisor');
const pkgs = require('./packages');
const ports = require('./ports');

const dbDir = (id) => path.join(U.paths.dbs, id);
const working = new Set();

const TYPES = {
  postgres: {
    label: 'PostgreSQL', defaultPort: 5432, needs: ['initdb', 'postgres', 'psql'],
    async init(d, dir, log) {
      const pwfile = path.join(dir, '.pw');
      fs.writeFileSync(pwfile, d.password, { mode: 0o600 });
      try {
        // initdb normally takes seconds. If Android blocks the shared-memory check it can
        // hang forever, so give up after 3 minutes with a useful message.
        await U.run('initdb', ['-D', path.join(dir, 'data'), '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${pwfile}`, '-E', 'UTF8', '--locale=C'],
          { onLine: log, label: 'initdb', timeout: 3 * 60 * 1000 });
      } catch (e) {
        if (/SIGKILL/.test(e.message)) {
          throw new Error('PostgreSQL setup got stuck (initdb did not finish in 3 minutes). Try again, and if it keeps happening, open an issue with the logs.');
        }
        throw e;
      } finally { fs.rmSync(pwfile, { force: true }); }
    },
    cmd: (d, dir) => `exec postgres -D ${q(path.join(dir, 'data'))} -p ${d.port} -k ${q(dir)} -c listen_addresses=${d.lan ? "'*'" : 'localhost'}`,
    async setup(d, dir, log) {
      await U.run('psql', ['-h', '127.0.0.1', '-p', String(d.port), '-U', 'postgres', '-c', `CREATE DATABASE "${d.dbName}"`],
        { env: { ...process.env, PGPASSWORD: d.password }, onLine: log, label: 'create database' });
    },
    url: (d, host) => `postgresql://postgres:${encodeURIComponent(d.password)}@${host}:${d.port}/${d.dbName}`,
  },
  mariadb: {
    label: 'MariaDB (MySQL)', defaultPort: 3306, needs: ['mariadbd', 'mariadb-install-db', 'mariadb'],
    async init(d, dir, log) {
      await U.run('mariadb-install-db', [`--datadir=${path.join(dir, 'data')}`, '--auth-root-authentication-method=socket', `--auth-root-socket-user=${require('os').userInfo().username}`, '--skip-test-db'], { onLine: log, label: 'mariadb-install-db' });
    },
    cmd: (d, dir) => `exec mariadbd --datadir=${q(path.join(dir, 'data'))} --port=${d.port} --socket=${q(path.join(dir, 'mysql.sock'))} --bind-address=${d.lan ? '0.0.0.0' : '127.0.0.1'} --skip-name-resolve`,
    async setup(d, dir, log) {
      const pw = d.password.replace(/'/g, "''");
      const sql = `CREATE DATABASE IF NOT EXISTS \`${d.dbName}\`; CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY '${pw}'; GRANT ALL ON \`${d.dbName}\`.* TO 'app'@'%'; FLUSH PRIVILEGES;`;
      await U.run('mariadb', [`--socket=${path.join(dir, 'mysql.sock')}`, '-u', require('os').userInfo().username, '-e', sql], { onLine: log, label: 'create database' });
    },
    url: (d, host) => `mysql://app:${encodeURIComponent(d.password)}@${host}:${d.port}/${d.dbName}`,
  },
  redis: {
    label: 'Redis', defaultPort: 6379, needs: ['redis-server'],
    async init(d, dir) { writeRedisConf(d, dir); },
    cmd: (d, dir) => { writeRedisConf(d, dir); return `exec redis-server ${q(path.join(dir, 'redis.conf'))}`; },
    async setup() {},
    url: (d, host) => `redis://:${encodeURIComponent(d.password)}@${host}:${d.port}`,
  },
};

function writeRedisConf(d, dir) {
  // Password lives in a private config file instead of the command line.
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'redis.conf'), [
    `port ${d.port}`, `bind ${d.lan ? '0.0.0.0' : '127.0.0.1'}`, `requirepass ${d.password}`,
    `dir ${path.join(dir, 'data')}`, 'appendonly yes', 'protected-mode no', 'save 300 10',
  ].join('\n') + '\n', { mode: 0o600 });
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function get(id) {
  const d = state.databases[id];
  if (!d) throw new U.HttpError(404, 'Database not found.');
  return d;
}

function view(d) {
  const t = TYPES[d.type];
  const p = S.info(d.id);
  const ip = (U.localIPs()[0] || {}).address;
  return {
    id: d.id, name: d.name, type: d.type, typeLabel: t.label, port: d.port, lan: !!d.lan, dbName: d.dbName,
    password: d.password, createdAt: d.createdAt, desired: d.desired, initialized: !!d.initialized, error: d.error || null,
    status: working.has(d.id) ? 'starting' : p.status, pid: p.pid, startedAt: p.startedAt, restarts: p.restarts,
    urls: { local: t.url(d, '127.0.0.1'), lan: d.lan && ip ? t.url(d, ip) : null },
  };
}

async function create(input) {
  const type = String(input.type || '');
  const t = TYPES[type];
  if (!t) throw U.bad('Pick PostgreSQL, MariaDB or Redis.');
  const name = String(input.name || '').trim() || t.label;
  if (name.length > 60) throw U.bad('That name is too long.');
  const d = {
    id: U.id(), type, name, createdAt: Date.now(), password: U.secret(18), lan: !!input.lan,
    dbName: (U.slug(name).replace(/-/g, '_') || 'app').replace(/^(\d)/, '_$1'), desired: 'running', initialized: false,
  };
  d.port = input.port ? ports.validate(input.port, d.id) : await ports.allocate(t.defaultPort, d.id);
  state.databases[d.id] = d;
  save();
  start(d.id).catch(() => {});
  return view(d);
}

async function start(id) {
  const d = get(id);
  const t = TYPES[d.type];
  const dir = dbDir(id);
  const log = (l) => S.log(id, l, 'out');
  d.desired = 'running';
  d.error = null;
  save();
  if (working.has(id)) return;
  working.add(id);
  S.bus.emit('status', id, 'starting');
  try {
    await pkgs.ensure(t.needs, log);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!d.initialized) {
      S.log(id, `Setting up ${t.label}…`, 'sys');
      fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
      await t.init(d, dir, log);
    }
    S.start(id, { cmd: t.cmd(d, dir), cwd: dir, env: process.env });
    if (!await U.waitPort(d.port, 60000, () => S.info(id).status !== 'stopped')) throw new Error(`${t.label} didn't start listening on port ${d.port}. See the logs.`);
    if (!d.initialized) {
      await t.setup(d, dir, log);
      d.initialized = true;
      S.log(id, `✓ ${t.label} is ready.`, 'sys');
    }
  } catch (e) {
    d.error = e.message;
    S.log(id, `✗ ${e.message}`, 'err');
  } finally {
    working.delete(id);
    save();
    S.bus.emit('status', id, S.info(id).status);
  }
}

async function stop(id) {
  const d = get(id);
  d.desired = 'stopped';
  save();
  await S.stop(id);
}

async function restart(id) {
  await S.stop(id);
  await start(id);
}

async function update(id, input) {
  const d = get(id);
  let restartNeeded = false;
  if (input.name !== undefined) { const n = String(input.name).trim(); if (n) d.name = n.slice(0, 60); }
  if (input.lan !== undefined && !!input.lan !== !!d.lan) { d.lan = !!input.lan; restartNeeded = true; }
  if (input.port !== undefined && Number(input.port) !== d.port) { d.port = ports.validate(input.port, d.id); restartNeeded = true; }
  save();
  if (restartNeeded && d.desired === 'running') restart(id).catch(() => {});
  return view(d);
}

async function remove(id) {
  get(id);
  await S.stop(id);
  S.forget(id);
  S.dropLogs(id);
  fs.rmSync(dbDir(id), { recursive: true, force: true });
  delete state.databases[id];
  save();
}

function restore() {
  for (const d of Object.values(state.databases)) if (d.desired === 'running') start(d.id).catch(() => {});
}

const list = () => Object.values(state.databases).sort((x, y) => x.createdAt - y.createdAt).map(view);
const one = (id) => view(get(id));

module.exports = { list, one, create, start, stop, restart, update, remove, restore, TYPES };
