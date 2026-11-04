'use strict';
// Keeps long-running processes (apps, databases, tunnels) alive and records their logs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { paths, SHELL, lines, sleep } = require('./util');
const { state, save } = require('./store');

const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------- logs ----------
const MAX_LINES = 1000;
const MAX_FILE = 5 * 1024 * 1024;
const logs = new Map();
const logFile = (key) => path.join(paths.logs, key.replace(/[^\w.-]/g, '_') + '.log');

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function logOf(key) {
  let L = logs.get(key);
  if (L) return L;
  const file = logFile(key);
  L = { file, lines: [], size: 0, stream: null };
  try {
    L.size = fs.statSync(file).size;
    let raw = readTail(file, 96 * 1024).split('\n');
    if (L.size > 96 * 1024) raw = raw.slice(1); // first line was cut in half
    L.lines = raw.filter(Boolean).slice(-400).map((raw) => {
      const m = raw.match(/^(\S+) (out|err|sys) (.*)$/);
      return m ? { t: Date.parse(m[1]) || 0, s: m[2], m: m[3] } : { t: 0, s: 'out', m: raw };
    });
  } catch {}
  logs.set(key, L);
  return L;
}

function log(key, msg, src = 'out') {
  const L = logOf(key);
  const line = { t: Date.now(), s: src, m: String(msg).slice(0, 4000) };
  L.lines.push(line);
  if (L.lines.length > MAX_LINES) L.lines.splice(0, L.lines.length - MAX_LINES);
  if (!L.stream) {
    L.stream = fs.createWriteStream(L.file, { flags: 'a', mode: 0o600 });
    L.stream.on('error', () => { L.stream = null; });
  }
  const rec = `${new Date(line.t).toISOString()} ${src} ${line.m}\n`;
  L.stream.write(rec);
  L.size += Buffer.byteLength(rec);
  if (L.size > MAX_FILE) {
    L.stream.end();
    L.stream = null;
    L.size = 0;
    try { fs.renameSync(L.file, L.file + '.1'); } catch {}
  }
  bus.emit('log:' + key, line);
}

const history = (key) => logOf(key).lines;

function dropLogs(key) {
  const L = logs.get(key);
  if (L && L.stream) L.stream.end();
  logs.delete(key);
  for (const f of [logFile(key), logFile(key) + '.1']) { try { fs.unlinkSync(f); } catch {} }
}

// ---------- processes ----------
const procs = new Map();

function info(key) {
  const p = procs.get(key);
  if (!p) return { status: 'stopped', pid: null, startedAt: null, restarts: 0 };
  return { status: p.status, pid: p.pid || null, startedAt: p.startedAt || null, restarts: p.restarts };
}

function setStatus(p, status) {
  p.status = status;
  bus.emit('status', p.key, status);
}

/**
 * Starts (or replaces the spec of) a supervised process.
 * spec: { cmd, cwd, env, onLine?(line) }
 */
function start(key, spec) {
  let p = procs.get(key);
  if (p && p.child) { p.spec = spec; return; }
  if (!p) { p = { key, restarts: 0, backoff: 1000 }; procs.set(key, p); }
  clearTimeout(p.timer);
  p.wanted = true;
  p.spec = spec;
  p.restarts = 0;
  p.backoff = 1000;
  launch(p);
}

function launch(p) {
  const { cmd, cwd, env } = p.spec;
  log(p.key, `$ ${cmd}`, 'sys');
  let child;
  try {
    fs.mkdirSync(cwd, { recursive: true });
    child = spawn(SHELL, ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(p.key, `Couldn't start: ${e.message}`, 'err');
    return scheduleRestart(p);
  }
  p.child = child;
  p.pid = child.pid;
  p.startedAt = Date.now();
  state.pids[p.key] = child.pid;
  save();
  setStatus(p, 'running');
  const onLine = (src) => (l) => {
    log(p.key, l, src);
    if (p.spec.onLine) { try { p.spec.onLine(l); } catch {} }
  };
  lines(child.stdout, onLine('out'));
  lines(child.stderr, onLine('err'));
  child.on('error', (e) => log(p.key, `Process error: ${e.message}`, 'err'));
  child.on('exit', (code, sig) => {
    if (p.child !== child) return;
    p.child = null;
    p.pid = null;
    delete state.pids[p.key];
    save();
    log(p.key, `Process exited (${sig || 'code ' + code})`, 'sys');
    if (p.exitWaiters) { p.exitWaiters.forEach((f) => f()); p.exitWaiters = null; }
    if (!p.wanted) { setStatus(p, 'stopped'); return; }
    if (Date.now() - p.startedAt > 60000) p.backoff = 1000; // it ran fine for a while: restart quickly
    scheduleRestart(p);
  });
}

function scheduleRestart(p) {
  setStatus(p, 'crashed');
  p.restarts++;
  const wait = p.backoff;
  p.backoff = Math.min(p.backoff * 2, 60000);
  log(p.key, `Restarting in ${Math.round(wait / 1000)}s…`, 'sys');
  p.timer = setTimeout(() => { if (p.wanted && !p.child) launch(p); }, wait);
}

function killGroup(pid, sig) {
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

/** Stops a process: SIGTERM to its whole process group, SIGKILL if it hasn't exited in time. */
async function stop(key, timeout = 8000) {
  const p = procs.get(key);
  if (!p) return;
  p.wanted = false;
  clearTimeout(p.timer);
  if (!p.child) { setStatus(p, 'stopped'); return; }
  const pid = p.pid;
  const exited = new Promise((r) => { (p.exitWaiters = p.exitWaiters || []).push(r); });
  killGroup(pid, 'SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(timeout).then(() => false)]);
  if (!done) {
    killGroup(pid, 'SIGKILL');
    await Promise.race([exited, sleep(2000)]);
  }
}

async function restart(key, spec) {
  await stop(key);
  start(key, spec || procs.get(key).spec);
}

function forget(key) {
  procs.delete(key);
}

/** After a crash of PocketHost itself, children may still be alive. Kill them before starting fresh. */
function killStale() {
  for (const pid of Object.values(state.pids || {})) killGroup(pid, 'SIGKILL');
  state.pids = {};
  save();
}

async function stopAll() {
  await Promise.all([...procs.keys()].map((k) => stop(k, 5000)));
}

const pidOf = (key) => (procs.get(key) || {}).pid || null;

module.exports = { bus, log, history, dropLogs, info, start, stop, restart, forget, killStale, stopAll, pidOf };
