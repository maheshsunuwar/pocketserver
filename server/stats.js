'use strict';
// Phone stats. Android restricts much of /proc and /sys for apps, so every reading is optional
// and falls back gracefully (null = "not available on this phone").
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const U = require('./util');
const S = require('./supervisor');

const readNum = (f) => { try { const v = Number(fs.readFileSync(f, 'utf8').trim()); return Number.isFinite(v) ? v : null; } catch { return null; } };
const readStr = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };

// ---- device (cached) ----
let device = null;
function deviceInfo() {
  if (device) return device;
  const model = U.getprop('ro.product.model');
  device = {
    name: model ? `${U.getprop('ro.product.manufacturer')} ${model}`.trim() : os.hostname(),
    android: U.getprop('ro.build.version.release') || null,
    rom: romName(),
    arch: process.arch,
    cores: cpuCount(),
    node: process.version,
    termux: U.isTermux,
  };
  return device;
}
function cpuCount() {
  try {
    const n = fs.readdirSync('/sys/devices/system/cpu').filter((d) => /^cpu\d+$/.test(d)).length;
    if (n) return n;
  } catch {}
  return os.cpus().length || null;
}

// ---- CPU ----
let lastCpu = null;
function cpuUsage() {
  // /proc/stat is blocked for apps on Android 8+, so this often returns null there.
  const txt = readStr('/proc/stat');
  if (!txt) return null;
  const f = txt.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + (f[4] || 0);
  const total = f.reduce((a, b) => a + b, 0);
  let pct = null;
  if (lastCpu && total > lastCpu.total) pct = Math.round(100 * (1 - (idle - lastCpu.idle) / (total - lastCpu.total)));
  lastCpu = { idle, total };
  return pct;
}
function cpuFreq() {
  const n = cpuCount() || 0;
  let sum = 0, max = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const cur = readNum(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
    const mx = readNum(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`);
    if (cur && mx) { sum += cur; max += mx; cnt++; }
  }
  return cnt ? Math.round((100 * sum) / max) : null; // % of max clock speed: a rough "how busy" signal
}

// ---- memory / storage ----
function memory() {
  const txt = readStr('/proc/meminfo');
  if (!txt) return { total: os.totalmem(), available: os.freemem() };
  const kb = (k) => { const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')); return m ? Number(m[1]) * 1024 : null; };
  return { total: kb('MemTotal'), available: kb('MemAvailable') ?? kb('MemFree') };
}
function storage() {
  try {
    const s = fs.statfsSync(U.paths.home);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return null; }
}

// Apps can't read ROM-specific props like ro.lineage.version (SELinux), but
// ro.build.flavor ("lineage_hotdog-userdebug") is readable on most custom ROMs.
const ROMS = { lineage: 'LineageOS', crdroid: 'crDroid', evolution: 'Evolution X', pixelos: 'PixelOS',
  derp: 'DerpFest', aicp: 'AICP', calyx: 'CalyxOS', graphene: 'GrapheneOS', e: '/e/OS', yaap: 'YAAP' };
function romName() {
  const flavor = U.getprop('ro.build.flavor') || U.getprop('ro.system.build.flavor');
  const prefix = (flavor.match(/^([a-z]+)_/) || [])[1];
  if (prefix && ROMS[prefix]) return ROMS[prefix];
  const v = U.getprop('ro.lineage.version');
  return v ? 'LineageOS' : null;
}

// ---- battery & temperature ----
let apiBattery = { at: 0, value: null, failures: 0 };
function batteryFromApi() {
  // Termux:API (optional add-on app) can read the battery even where /sys is blocked.
  if (!U.which('termux-battery-status')) return null;
  // Back off when it fails (Termux:API app missing or not opened yet), but keep retrying.
  const wait = apiBattery.failures ? Math.min(600000, 30000 * 2 ** apiBattery.failures) : 30000;
  if (Date.now() - apiBattery.at > wait) {
    apiBattery.at = Date.now();
    execFile('termux-battery-status', { timeout: 5000 }, (err, out) => {
      if (err) { apiBattery.failures++; return; }
      try { apiBattery.value = JSON.parse(out); apiBattery.failures = 0; } catch { apiBattery.failures++; }
    });
  }
  return apiBattery.value;
}
function battery() {
  const base = '/sys/class/power_supply/battery';
  const capacity = readNum(path.join(base, 'capacity'));
  if (capacity !== null) {
    const temp = readNum(path.join(base, 'temp'));
    const status = readStr(path.join(base, 'status'));
    return { level: capacity, charging: status ? /charging|full/i.test(status) && !/discharging/i.test(status) : null, status, temp: temp !== null ? temp / 10 : null };
  }
  const v = batteryFromApi();
  if (v) return { level: v.percentage, charging: /CHARGING|FULL/.test(v.status || ''), status: v.status, temp: v.temperature ?? null };
  return null;
}
function temperature() {
  let max = null;
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      const type = readStr(`/sys/class/thermal/${z}/type`) || '';
      if (!/cpu|soc|tsens|apc/i.test(type)) continue;
      const t = readNum(`/sys/class/thermal/${z}/temp`);
      if (t !== null && t > 0) { const c = t > 1000 ? t / 1000 : t; if (c < 150 && (max === null || c > max)) max = c; }
    }
  } catch {}
  return max;
}

// ---- per-process usage (only our own processes are visible on Android, which is all we need) ----
let lastProc = { at: 0, ticks: new Map() };
const CLK = 100; // USER_HZ is 100 on Android/Linux
const PAGE = 4096;
function processTable() {
  const table = new Map();
  let pids;
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return table; }
  for (const pid of pids) {
    const stat = readStr(`/proc/${pid}/stat`);
    if (!stat) continue;
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    const ticks = Number(rest[11]) + Number(rest[12]);
    const rss = Number(rest[21]) * PAGE;
    table.set(Number(pid), { ppid, ticks, rss });
  }
  return table;
}
/** CPU % and memory for each supervised key (the process and all its children). */
function usage(keys) {
  const table = processTable();
  const now = Date.now();
  const elapsed = (now - lastProc.at) / 1000;
  const children = new Map();
  for (const [pid, p] of table) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(pid); }
  const out = {};
  const ticksNow = new Map();
  for (const key of keys) {
    const root = S.pidOf(key);
    if (!root || !table.has(root)) continue;
    let ticks = 0, rss = 0;
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop();
      const p = table.get(pid);
      if (!p) continue;
      ticks += p.ticks; rss += p.rss;
      stack.push(...(children.get(pid) || []));
    }
    ticksNow.set(key, ticks);
    const prev = lastProc.ticks.get(key);
    out[key] = { cpu: prev !== undefined && elapsed > 0 ? Math.max(0, Math.round((100 * (ticks - prev)) / CLK / elapsed)) : null, memory: rss };
  }
  lastProc = { at: now, ticks: ticksNow };
  return out;
}

function snapshot() {
  return {
    device: deviceInfo(),
    cpu: { usage: cpuUsage(), clock: cpuFreq(), load: os.loadavg()[0] || null },
    memory: memory(),
    storage: storage(),
    battery: battery(),
    temperature: temperature(),
    uptime: os.uptime(),
    ips: U.localIPs(),
    at: Date.now(),
  };
}

module.exports = { snapshot, usage, deviceInfo };
