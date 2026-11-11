'use strict';
// Things you'd otherwise type in Termux: restart, update, and tidying up Docker storage.
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { state } = require('./store');

const ROOT = path.resolve(__dirname, '..');
const UDOCKER_HOME = path.join(require('os').homedir(), '.udocker');
const underWatchdog = () => process.env.POCKETSERVER_WATCHDOG === '1';
const isGit = () => fs.existsSync(path.join(ROOT, '.git'));

function info() {
  return { canRestart: underWatchdog(), canUpdate: isGit(), version: require('../package.json').version };
}

/** Exits after replying. The watchdog started by `pocketserver start` brings the server back. */
function restart(shutdown) {
  if (!underWatchdog()) throw U.bad('PocketServer was started without the pocketserver command, so it can\'t restart itself. Restart it where you started it.');
  setTimeout(() => shutdown('restart from the dashboard'), 300);
  return { ok: true };
}

async function checkUpdate() {
  if (!isGit()) throw U.bad("This copy wasn't installed from GitHub, so it can't update itself. Re-run the installer.");
  await U.run('git', ['fetch', '--quiet'], { cwd: ROOT, timeout: 60000, label: 'git fetch' });
  const behind = Number((await U.run('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd: ROOT, label: 'git rev-list' })).trim()) || 0;
  const latest = behind ? (await U.run('git', ['log', '-1', '--pretty=%s', '@{u}'], { cwd: ROOT })).trim() : null;
  return { behind, latest };
}

async function update(shutdown) {
  if (!isGit()) throw U.bad("This copy wasn't installed from GitHub, so it can't update itself. Re-run the installer.");
  const out = await U.run('git', ['pull', '--ff-only'], { cwd: ROOT, timeout: 5 * 60e3, label: 'git pull' })
    .catch((e) => { throw U.bad(`Update failed: ${(e.output || e.message).trim().split('\n').pop()}`); });
  const changed = !/Already up to date/i.test(out);
  if (changed) restart(shutdown);
  return { ok: true, changed, version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version };
}

// ---------- Docker (udocker) storage ----------

function duBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += fs.lstatSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

/** udocker ps: id, P, M, names (a Python list, empty when unnamed), image. */
async function containers() {
  const out = await U.run('udocker', ['ps'], { label: 'udocker ps', timeout: 60000 }).catch(() => '');
  return out.split('\n').slice(1).map((l) => l.trim()).filter((l) => /^[0-9a-f-]{36}\s/.test(l)).map((l) => {
    const parts = l.split(/\s+/);
    return { id: parts[0], image: parts[parts.length - 1], names: (l.match(/[\w.-]+(?=')/g) || []) };
  });
}

async function images() {
  const out = await U.run('udocker', ['images'], { label: 'udocker images', timeout: 60000 }).catch(() => '');
  return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
}

/** udocker jobs whose PocketServer is gone (left by a crash or restart), with everything they started. */
function strayJobs() {
  if (!fs.existsSync('/proc')) return [];
  const procs = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
      procs.push({ pid: Number(d), ppid, cmd });
    } catch {}
  }
  const roots = procs.filter((p) => /\budocker\b.*\b(create|pull|run)\b/.test(p.cmd) && p.ppid === 1);
  const out = new Set();
  const add = (pid) => { if (out.has(pid)) return; out.add(pid); procs.filter((p) => p.ppid === pid).forEach((p) => add(p.pid)); };
  roots.forEach((r) => add(r.pid));
  return [...out];
}

const appContainer = (name) => /^pocketserver-([0-9a-f]+)$/.exec(name);
const usedImages = () => new Set(Object.values(state.apps).filter((a) => a.source === 'docker' && a.docker).map((a) => a.docker.image));

async function docker() {
  if (!U.which('udocker')) return { installed: false };
  const cs = await containers();
  const unused = cs.filter((c) => !c.names.length || c.names.every((n) => appContainer(n) && !state.apps[appContainer(n)[1]]));
  const used = usedImages();
  const imgs = await images();
  return {
    installed: true,
    works: require('./apps').dockerWorks(),
    bytes: duBytes(UDOCKER_HOME),
    containers: cs.length,
    leftoverContainers: unused.length,
    images: imgs.map((name) => ({ name, used: used.has(name) })),
    strayJobs: strayJobs().length,
  };
}

/**
 * Removes what PocketServer left behind: stuck udocker jobs, unnamed containers from failed installs,
 * containers of deleted apps, and images no app uses. Containers you named yourself are kept.
 */
async function cleanDocker({ images: removeImages = true } = {}) {
  if (!U.which('udocker')) throw U.bad('Docker (udocker) isn\'t installed.');
  if (Object.values(state.apps).some((a) => a.source === 'docker' && require('./apps').isDeploying(a.id))) {
    throw U.bad('A Docker app is installing right now. Try again when it finishes.');
  }
  const before = duBytes(UDOCKER_HOME);
  const jobs = strayJobs();
  for (const pid of jobs) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  let removedContainers = 0;
  for (const c of await containers()) {
    const leftover = !c.names.length || c.names.every((n) => appContainer(n) && !state.apps[appContainer(n)[1]]);
    if (!leftover) continue;
    await U.run('udocker', ['rm', c.id], { label: 'udocker rm', timeout: 5 * 60e3 }).then(() => { removedContainers++; }, () => {});
  }
  const removedImages = [];
  if (removeImages) {
    const used = usedImages();
    for (const img of await images()) {
      if (used.has(img)) continue;
      await U.run('udocker', ['rmi', img], { label: 'udocker rmi', timeout: 5 * 60e3 }).then(() => removedImages.push(img), () => {});
    }
  }
  return { stoppedJobs: jobs.length, removedContainers, removedImages, freedBytes: Math.max(0, before - duBytes(UDOCKER_HOME)) };
}

module.exports = { info, restart, checkUpdate, update, docker, cleanDocker };
