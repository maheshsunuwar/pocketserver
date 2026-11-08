'use strict';
// Shared helpers: paths, running commands, ports, ids.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOME = path.resolve(process.env.POCKETSERVER_HOME || path.join(os.homedir(), '.pocketserver'));
const paths = {
  home: HOME,
  apps: path.join(HOME, 'apps'),
  dbs: path.join(HOME, 'databases'),
  logs: path.join(HOME, 'logs'),
  state: path.join(HOME, 'state.json'),
  initialPassword: path.join(HOME, 'initial-password'),
};
for (const p of [paths.home, paths.apps, paths.dbs, paths.logs]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });

const PREFIX = process.env.PREFIX || '';
const isTermux = PREFIX.includes('com.termux');
const SHELL = isTermux ? path.join(PREFIX, 'bin', 'sh') : '/bin/sh';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = () => crypto.randomBytes(5).toString('hex');
const secret = (n = 24) => crypto.randomBytes(n).toString('base64url');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);

/** Calls cb for every complete line written to a stream. */
function lines(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d.replace(/\r(?!\n)/g, '\n');
    const parts = buf.split(/\r?\n/);
    buf = parts.pop();
    if (buf.length > 8000) { parts.push(buf); buf = ''; }
    for (const p of parts) if (p.trim()) cb(p);
  });
  stream.on('end', () => { if (buf.trim()) cb(buf); });
}

/** Runs a program to completion. Resolves with its output, rejects on a non-zero exit. */
function run(file, args, { cwd, env, onLine, timeout = 30 * 60 * 1000, label } = {}) {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try {
      child = spawn(file, args, { cwd, env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    const feed = (l) => { out += l + '\n'; if (out.length > 200000) out = out.slice(-100000); if (onLine) onLine(l); };
    lines(child.stdout, feed);
    lines(child.stderr, feed);
    const timer = timeout ? setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout) : null;
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else {
        const e = new Error(`${label || file} failed (${sig || 'exit code ' + code})`);
        e.output = out;
        reject(e);
      }
    });
  });
}
const sh = (cmd, opts = {}) => run(SHELL, ['-c', cmd], { label: opts.label || cmd, ...opts });

function which(bin) {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue;
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '0.0.0.0');
  });
}
function portOpen(port, host = '127.0.0.1', timeout = 1000) {
  return new Promise((res) => {
    const s = net.connect(port, host);
    const t = setTimeout(() => { s.destroy(); res(false); }, timeout);
    s.once('connect', () => { clearTimeout(t); s.end(); res(true); });
    s.once('error', () => { clearTimeout(t); res(false); });
  });
}
async function waitPort(port, ms = 30000, stillWanted = () => true) {
  const end = Date.now() + ms;
  while (Date.now() < end && stillWanted()) {
    if (await portOpen(port)) return true;
    await sleep(700);
  }
  return false;
}

/** Android-safe list of this device's IPv4 addresses (os.networkInterfaces fails on Android 11+). */
let ipCache = { at: 0, list: [] };
function localIPs() {
  if (Date.now() - ipCache.at < 30000) return ipCache.list;
  let list = [];
  try {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address });
    }
  } catch {}
  if (!list.length) {
    for (const cmd of [['ifconfig'], ['ip', '-4', '-o', 'addr', 'show']]) {
      try {
        const out = execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        let name = '';
        for (const line of out.split('\n')) {
          // ifconfig: "wlan0: flags=..." then an indented "inet 10.0.0.5 ..." line.
          // ip -o:    "3: wlan0    inet 10.0.0.5/24 ..." on one line.
          const head = line.match(/^(?:\d+:\s+)?([A-Za-z0-9_.@-]+):?\s/);
          if (head && !/^\s/.test(line)) name = head[1].replace(/@.*/, '');
          const inet = line.match(/inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)/);
          if (inet && name && !inet[1].startsWith('127.')) list.push({ name, address: inet[1] });
        }
        if (list.length) break;
      } catch {}
    }
  }
  // Prefer Wi-Fi, then anything else.
  list.sort((a, b) => (b.name.startsWith('wlan') - a.name.startsWith('wlan')));
  ipCache = { at: Date.now(), list };
  return list;
}

function getprop(name) {
  try { return execFileSync('getprop', [name], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { return ''; }
}

module.exports = {
  paths, isTermux, SHELL, PREFIX, sleep, id, secret, slug, HttpError, bad,
  lines, run, sh, which, portFree, portOpen, waitPort, localIPs, getprop,
};
