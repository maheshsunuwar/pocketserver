'use strict';
/* PocketServer dashboard — plain JS, no build step. All user text goes in via textContent (never innerHTML). */

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

/** Like el.replaceChildren, but skips null/false (replaceChildren would print "null"). */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

// The session key (see server/auth.js). Kept per origin, so apps on the phone's other ports can't read it.
let memoryKey = '';
const sessionKey = {
  get() { try { return localStorage.getItem('ps_key') || ''; } catch { return memoryKey; } },
  set(k) { memoryKey = k || ''; try { if (k) localStorage.setItem('ps_key', k); else localStorage.removeItem('ps_key'); } catch {} },
};

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-pocketserver': '1', 'x-pocketserver-key': sessionKey.get() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && url !== '/login') { showLogin(); throw new Error('Please log in.'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, kind === 'error' ? 6000 : 3500);
}

// Line icons, drawn on a 24px grid.
const ICONS = {
  plus: 'M12 5v14M5 12h14',
  out: 'M7 17 17 7M8 7h9v9',
  right: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4',
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  gear: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  deploy: 'M12 15V4M7 9l5-5 5 5M5 20h14',
  play: 'M8 5.5v13l10.5-6.5z',
  stop: 'M7 7h10v10H7z',
  restart: 'M4 12a8 8 0 1 0 2.34-5.66M4 4v5h5',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  box: 'M12 3 4 7v10l8 4 8-4V7zM4 7l8 4 8-4M12 11v10',
  terminal: 'M5 17l5-5-5-5M12 19h7',
};
function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}
/** Colored letter tile for an app or database. The color comes from the name, so it stays the same. */
function monogram(name, { large = false, glyph = null } = {}) {
  let n = 0;
  for (const ch of String(name)) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  const letters = String(name).replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
  const text = letters.length > 1 && letters[1] ? letters[0][0] + letters[1][0] : (letters[0] || '?').slice(0, 1);
  return h('span', { class: 'mono-icon' + (large ? ' lg' : ''), style: `--h:${n % 360}`, 'aria-hidden': 'true' }, glyph ? icon(glyph) : text);
}

const bytes = (n) => {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const duration = (s) => {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
};
const ago = (t) => {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const lanUrl = (port) => `${location.protocol}//${location.hostname}:${port}`;
const STATUS = { running: 'Running', stopped: 'Stopped', crashed: 'Crashed', deploying: 'Deploying', starting: 'Starting' };
const statusEl = (s) => h('span', { class: 'status ' + s }, STATUS[s] || s);

async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      // Plain-http dashboards (the usual case on a LAN) can't use the clipboard API.
      const ta = h('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied', 'ok');
  } catch { toast("Couldn't copy. Select the text and copy it manually.", 'error'); }
}
function copyField(value, { secret = false } = {}) {
  const input = h('input', { type: secret ? 'password' : 'text', value, readonly: true, onfocus: (e) => e.target.select() });
  return h('div', { class: 'copy' },
    input,
    secret ? h('button', { class: 'btn small', type: 'button', onclick: (e) => { input.type = input.type === 'password' ? 'text' : 'password'; e.target.textContent = input.type === 'password' ? 'Show' : 'Hide'; } }, 'Show') : null,
    h('button', { class: 'btn small', type: 'button', onclick: () => copy(value) }, 'Copy'));
}
function field(label, input, help) {
  return h('div', { class: 'field' }, h('label', null, label), input, help ? h('div', { class: 'help' }, help) : null);
}
function busy(btn, fn) {
  return async (e) => {
    if (e) e.preventDefault();
    btn.disabled = true;
    // Only show a spinner if it takes a moment, so quick actions don't flicker.
    const spin = setTimeout(() => btn.classList.add('loading'), 250);
    try { await fn(); } catch (err) { if (err.message !== 'Please log in.') toast(err.message, 'error'); } finally { clearTimeout(spin); btn.classList.remove('loading'); btn.disabled = false; }
  };
}

// ---------- routing ----------
let cleanups = [];
let routeToken = 0;
const onCleanup = (fn) => cleanups.push(fn);
const every = (ms, fn) => { const t = setInterval(fn, ms); onCleanup(() => clearInterval(t)); };
const go = (path) => { location.hash = '#' + path; };

function view() {
  const token = routeToken;
  return {
    alive: () => token === routeToken,
    render(node) { if (token === routeToken) fill(document.getElementById('main'), node); },
  };
}

async function router() {
  cleanups.forEach((f) => { try { f(); } catch {} });
  cleanups = [];
  routeToken++;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === (parts[0] || 'home')));
  const v = view();
  try {
    if (!parts.length) await Dashboard(v);
    else if (parts[0] === 'apps' && parts[1] === 'new') NewApp(v);
    else if (parts[0] === 'apps' && parts[1]) await AppPage(v, parts[1], parts[2] || 'logs');
    else if (parts[0] === 'databases' && parts[1] === 'new') NewDatabase(v);
    else if (parts[0] === 'databases' && parts[1]) await DbPage(v, parts[1], parts[2] || 'data');
    else if (parts[0] === 'settings') await Settings(v);
    else go('/');
  } catch (e) {
    if (e.message !== 'Please log in.') v.render(h('div', { class: 'empty' }, h('p', null, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to dashboard')));
  }
}

// ---------- shell & login ----------
let shellShown = false;
function showShell() {
  shellShown = true;
  fill(document.getElementById('app'),
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: 'icon.svg', alt: '' }), 'PocketServer'),
      h('span', { class: 'device-chip', id: 'device-name', title: 'Online' }),
      h('nav', { class: 'nav' },
        h('a', { href: '#/', 'data-r': 'home', title: 'Dashboard' }, icon('home'), h('span', null, 'Dashboard')),
        h('a', { href: '#/settings', 'data-r': 'settings', title: 'Settings' }, icon('gear'), h('span', null, 'Settings')),
        h('button', { title: 'Log out', onclick: async () => { await api('POST', '/logout').catch(() => {}); sessionKey.set(''); showLogin(); } }, icon('logout'), h('span', null, 'Log out')))),
    h('main', { id: 'main' }));
  api('GET', '/settings').then((st) => { const el = document.getElementById('device-name'); if (el) el.textContent = st.device.name; }).catch(() => {});
}

function showLogin() {
  cleanups.forEach((f) => { try { f(); } catch {} });
  cleanups = [];
  routeToken++;
  shellShown = false;
  const pw = h('input', { type: 'password', placeholder: 'Dashboard password', autocomplete: 'current-password', autofocus: true });
  const err = h('div', { class: 'error-text' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Log in');
  const form = h('form', {
    onsubmit: busy(btn, async () => {
      err.textContent = '';
      try {
        const r = await api('POST', '/login', { password: pw.value });
        sessionKey.set(r.key);
        showShell();
        router();
      } catch (e) { err.textContent = e.message; pw.select(); }
    }),
  }, h('div', { class: 'field' }, pw), btn, err);
  fill(document.getElementById('app'),
    h('div', { class: 'login' }, h('div', { class: 'login-box' },
      h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'PocketServer'),
      h('h1', null, 'Welcome back'),
      h('p', { class: 'lead' }, 'Log in to manage the apps on this phone.'),
      form,
      h('p', { class: 'foot' }, 'Forgot it? Run ', h('code', null, 'pocketserver password'), ' in Termux.'))));
  setTimeout(() => pw.focus(), 50);
}

// ---------- dashboard ----------
// Recent CPU and memory readings for the sparklines. Kept across page changes.
const HIST = { cpu: [], mem: [] };
const HIST_LEN = 40;
function remember(key, value) {
  if (value == null || Number.isNaN(value)) return;
  HIST[key].push(value);
  if (HIST[key].length > HIST_LEN) HIST[key].shift();
}

let sparkId = 0;
function sparkline(values) {
  if (values.length < 2) return h('div', { class: 'spark' }); // keeps the panel even until there's data
  const NS = 'http://www.w3.org/2000/svg';
  const W = 100, H = 26;
  // Zoom in on the recent range so small changes are visible, but never past 0–100.
  const lo = Math.max(0, Math.min(...values) - 8);
  const hi = Math.min(100, Math.max(...values) + 8);
  const span = Math.max(hi - lo, 10);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 2 - ((v - lo) / span) * (H - 4)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const id = 'spark' + (++sparkId);
  const svg = el('svg', { class: 'spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const grad = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el('stop', { offset: 0, class: 'g0' }), el('stop', { offset: 1, class: 'g1' }));
  const defs = el('defs', {});
  defs.append(grad);
  svg.append(defs, el('path', { class: 'area', d: `${line}L${W} ${H}L0 ${H}Z`, fill: `url(#${id})` }), el('path', { class: 'line', d: line }));
  return svg;
}

function meter(label, value, unit, hint, { pct = null, tone = '', spark = null } = {}) {
  return h('div', { class: 'meter' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value, unit ? h('small', null, unit) : null),
    h('div', { class: 'hint', title: hint || '' }, hint || ' '),
    spark ? sparkline(spark)
      : pct != null ? h('div', { class: 'track ' + tone }, h('i', { style: `width:${Math.max(2, Math.min(100, pct))}%` })) : null);
}

function meters(s) {
  const out = [];
  const cpu = s.cpu.usage ?? s.cpu.clock;
  remember('cpu', cpu);
  if (s.cpu.usage != null) out.push(meter('CPU', s.cpu.usage, '%', `${s.device.cores} cores`, { spark: HIST.cpu }));
  else if (s.cpu.clock != null) out.push(meter('CPU speed', s.cpu.clock, '%', `of max · ${s.device.cores} cores`, { spark: HIST.cpu }));
  else out.push(meter('CPU', s.device.cores || '—', 'cores', 'Usage hidden by Android'));
  if (s.memory && s.memory.total) {
    const used = s.memory.total - s.memory.available;
    const pct = (100 * used) / s.memory.total;
    remember('mem', pct);
    out.push(meter('Memory', bytes(used), null, `of ${bytes(s.memory.total)} · ${Math.round(pct)}%`, { spark: HIST.mem }));
  }
  if (s.storage) {
    const used = s.storage.total - s.storage.free;
    const pct = (100 * used) / s.storage.total;
    out.push(meter('Storage', bytes(s.storage.free), 'free', `${bytes(used)} of ${bytes(s.storage.total)} used`, { pct, tone: pct > 90 ? 'bad' : pct > 80 ? 'warn' : '' }));
  }
  if (s.battery) {
    const b = s.battery;
    const hint = [b.charging ? 'Charging' : b.charging === false ? 'On battery' : null, b.temp != null ? `${b.temp.toFixed(0)}°C` : null].filter(Boolean).join(' · ');
    out.push(meter('Battery', b.level, '%', hint, { pct: b.level, tone: b.level < 20 ? 'bad' : b.charging ? 'good' : '' }));
  }
  if (s.temperature != null) out.push(meter('CPU temperature', s.temperature.toFixed(0), '°C', s.temperature > 75 ? 'Running hot' : 'Normal', { pct: s.temperature, tone: s.temperature > 75 ? 'bad' : s.temperature > 60 ? 'warn' : '' }));
  return out;
}

function usageText(u) {
  if (!u) return null;
  return `${u.cpu != null ? u.cpu + '% · ' : ''}${bytes(u.memory)}`;
}

function row(href, kids) {
  return h('div', { class: 'item', role: 'link', tabindex: 0, onclick: () => go(href), onkeydown: (e) => { if (e.key === 'Enter') go(href); } }, kids, icon('right', 'chev'));
}
const stopClick = (e) => e.stopPropagation();

/** Short label for how an app runs. Catalog apps don't need one: their name says what they are. */
const appKind = (a) => (a.source === 'docker' ? 'docker' : a.catalog ? null : a.type);

function appRow(a) {
  const d = a.lastDeploy;
  const failed = d && !d.ok;
  const desc = d ? (failed ? `Deploy failed: ${d.error}` : `${d.commit || 'Deployed'} · ${ago(d.at)}`) : 'Not deployed yet';
  const r = row('/apps/' + a.id, [
    monogram(a.name),
    h('div', { class: 'main' },
      h('div', { class: 'name' }, a.name, appKind(a) ? h('span', { class: 'kind' }, appKind(a)) : null),
      h('div', { class: 'desc' + (failed ? ' err' : ''), title: desc }, desc)),
    statusEl(a.status),
    a.status === 'running'
      ? h('a', { class: 'addr', href: lanUrl(a.port), target: '_blank', rel: 'noopener', onclick: stopClick, title: 'Open on your Wi-Fi' }, `${location.hostname}:${a.port}`)
      : h('span', { class: 'addr faint' }, `port ${a.port}`),
    h('span', { class: 'use' }, a.status === 'running' ? usageText(a.usage) : ''),
  ]);
  return r;
}

function dbRow(d) {
  const failed = d.error && d.status !== 'running';
  return row('/databases/' + d.id, [
    monogram(d.typeLabel, { glyph: 'db' }),
    h('div', { class: 'main' },
      h('div', { class: 'name' }, d.name, h('span', { class: 'kind' }, d.typeLabel)),
      h('div', { class: 'desc' + (failed ? ' err' : '') }, failed ? d.error : d.lan ? 'Open to devices on your Wi-Fi' : 'Only apps on this phone can connect')),
    statusEl(failed ? 'failed' : d.status),
    h('span', { class: 'addr' }, `127.0.0.1:${d.port}`),
    h('span', { class: 'use' }, d.status === 'running' ? usageText(d.usage) : ''),
  ]);
}

async function Dashboard(v) {
  const root = h('div');
  const draw = (d) => {
    const s = d.stats;
    const chip = document.getElementById('device-name');
    if (chip) chip.textContent = s.device.name;
    const specs = [s.device.android ? `Android ${s.device.android}` : null, s.device.rom, s.device.arch, `Node ${s.device.node}`].filter(Boolean);
    fill(root,
      d.initialPassword ? h('div', { class: 'banner' }, "You're still using the password generated at install.", h('a', { class: 'btn small', href: '#/settings' }, 'Change password')) : null,
      h('div', { class: 'device-head' },
        h('div', null,
          h('h1', null, s.device.name),
          h('div', { class: 'specs' }, specs.map((x, i) => [i ? h('span', { class: 'sep' }) : null, h('span', null, x)]))),
        h('div', { class: 'uptime' }, `Up ${duration(s.uptime)}`, s.ips[0] ? ` · ${s.ips[0].address}` : '')),
      h('div', { class: 'meters' }, meters(s)),
      h('div', { class: 'section-head' },
        h('h2', null, 'Apps', h('span', { class: 'count' }, d.apps.length || '')),
        h('a', { class: 'btn primary small', href: '#/apps/new' }, icon('plus'), 'New app')),
      d.apps.length
        ? h('div', { class: 'list' }, d.apps.map(appRow))
        : h('div', { class: 'empty' }, h('p', null, 'No apps yet. Install one from the catalog, or deploy your own code from Git.'), h('a', { class: 'btn primary', href: '#/apps/new' }, icon('plus'), 'New app')),
      h('div', { class: 'section-head' },
        h('h2', null, 'Databases', h('span', { class: 'count' }, d.databases.length || '')),
        h('a', { class: 'btn small', href: '#/databases/new' }, icon('plus'), 'New database')),
      d.databases.length
        ? h('div', { class: 'list' }, d.databases.map(dbRow))
        : h('div', { class: 'empty' }, h('p', null, 'PostgreSQL, MariaDB and Redis, set up in one click.'), h('a', { class: 'btn', href: '#/databases/new' }, icon('plus'), 'New database')));
  };
  v.render(h('div', { class: 'skeleton', style: 'height:150px;margin-top:66px' }));
  draw(await api('GET', '/overview'));
  v.render(root);
  every(3000, async () => { try { const d = await api('GET', '/overview'); if (v.alive()) draw(d); } catch {} });
}

// ---------- new app ----------
function NewApp(v) {
  const tabs = h('div', { class: 'segmented' });
  const body = h('div');
  const show = (k) => {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    fill(body, k === 'catalog' ? catalogPicker() : k === 'docker' ? dockerForm() : sourceForm(k));
  };
  [['catalog', 'App catalog'], ['git', 'Git repository'], ['docker', 'Docker image'], ['command', 'Command']]
    .forEach(([k, label]) => tabs.append(h('button', { type: 'button', 'data-k': k, onclick: () => show(k) }, label)));
  v.render(h('div', null,
    h('a', { class: 'back', href: '#/' }, icon('left'), 'Dashboard'),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'New app'),
      h('div', { class: 'sub' }, 'Install a ready-made app, deploy your own code, or run a Docker image.'))),
    tabs, body));
  show('catalog');
}

function catalogPicker() {
  const grid = h('div', { class: 'grid tiles' }, [1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'skeleton', style: 'height:150px' })));
  const filter = h('input', { type: 'text', placeholder: 'Search apps', 'aria-label': 'Search apps' });
  let all = [];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const items = all.filter((r) => !q || `${r.name} ${r.description} ${r.category}`.toLowerCase().includes(q));
    const section = (title, help, list) => list.length ? [
      h('div', { class: 'cat-group' }, h('h2', null, title), h('span', null, help)),
      list.map(catalogTile)] : null;
    fill(grid,
      section('Runs natively', 'Built for Android. Fast and light.', items.filter((r) => r.kind === 'native')),
      section('Docker images', 'Experimental. Runs through udocker, slower, and some images won\'t work.', items.filter((r) => r.kind === 'docker')),
      !items.length ? h('div', { class: 'empty', style: 'grid-column:1/-1;margin-top:16px' }, h('p', null, 'Nothing matches. Try the Docker image or Git repository tab instead.')) : null);
  };
  filter.addEventListener('input', draw);
  api('GET', '/catalog').then((r) => { all = r; draw(); }).catch((e) => fill(grid, h('div', { class: 'banner bad', style: 'grid-column:1/-1' }, e.message)));
  return h('div', null,
    h('div', { class: 'catalog-tools' }, h('div', { class: 'search' }, icon('search'), filter)),
    grid,
    h('p', { class: 'faint', style: 'margin-top:28px' }, 'Want an app that isn\'t here? Use the Docker image tab with its name from Docker Hub, or the Git repository tab.'));
}

function catalogTile(r) {
  return h('button', { class: 'app-card', type: 'button', onclick: () => installDialog(r) },
    h('div', { class: 'top' }, monogram(r.name), h('div', null, h('div', { class: 'name' }, r.name), h('div', { class: 'cat' }, r.category))),
    h('p', null, r.description),
    h('div', { class: 'tags' },
      r.kind === 'docker' ? h('span', { class: 'badge warn' }, 'Docker · experimental') : h('span', { class: 'badge ok' }, 'Native'),
      r.needsDb ? h('span', { class: 'badge' }, `+ ${r.needsDb === 'postgres' ? 'PostgreSQL' : r.needsDb}`) : null));
}

function installDialog(r) {
  const name = h('input', { type: 'text', value: r.name, maxlength: 60 });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, `Install ${r.name}`);
  const close = openModal(h('form', {
    onsubmit: busy(btn, async () => {
      const a = await api('POST', `/catalog/${r.id}/install`, { name: name.value });
      close();
      toast(`Installing ${r.name}…`, 'ok');
      go('/apps/' + a.id + '/logs');
    }),
  },
  h('div', { class: 'page-head', style: 'margin-bottom:14px' }, h('div', { class: 'title' }, monogram(r.name, { large: true }), h('div', null, h('h3', { style: 'margin:0;font-size:17px' }, r.name), h('div', { class: 'faint', style: 'font-size:12.5px' }, r.category)))),
  h('p', { class: 'muted' }, r.description, ' ', r.website ? h('a', { href: r.website, target: '_blank', rel: 'noopener' }, 'Website') : null),
  r.kind === 'docker' ? h('div', { class: 'banner', style: 'margin:0 0 14px' }, `Runs the ${r.image} Docker image through udocker. This is experimental: the first install downloads the image and can take several minutes, and it uses more memory than native apps.`) : null,
  r.needsDb ? h('p', { class: 'muted' }, 'A PostgreSQL database will be created for it.') : null,
  r.claim ? h('div', { class: 'banner', style: 'margin:0 0 14px' }, CLAIM_TEXT) : null,
  r.notes ? h('p', { class: 'faint' }, r.notes) : null,
  field('Name', name),
  h('div', { class: 'form-actions' }, btn, h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancel'))));
}

function dockerForm() {
  const image = h('input', { type: 'text', placeholder: 'louislam/uptime-kuma:2', spellcheck: 'false', autocomplete: 'off' });
  const name = h('input', { type: 'text', placeholder: 'my-app', maxlength: 60 });
  const cport = h('input', { type: 'number', placeholder: '80', min: 1, max: 65535 });
  const volumes = h('textarea', { placeholder: '/data', spellcheck: 'false', style: 'min-height:70px' });
  const command = h('input', { type: 'text', placeholder: 'Image default', spellcheck: 'false' });
  const env = h('textarea', { placeholder: 'TZ=Europe/London', spellcheck: 'false', style: 'min-height:90px' });
  image.addEventListener('input', () => {
    const m = image.value.trim().match(/([^/:@]+)(?::[^/]*)?$/);
    if (m && !name.dataset.touched) name.value = m[1];
  });
  name.addEventListener('input', () => { name.dataset.touched = '1'; });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Pull and run');
  const err = h('div', { class: 'error-text' });
  const form = h('form', {
    onsubmit: busy(btn, async () => {
      err.textContent = '';
      try {
        const a = await api('POST', '/apps', { source: 'docker', image: image.value, name: name.value, containerPort: cport.value ? Number(cport.value) : null, volumes: volumes.value, command: command.value, env: env.value });
        toast('Pulling the image…', 'ok');
        go('/apps/' + a.id + '/logs');
      } catch (e) { err.textContent = e.message; throw e; }
    }),
  },
  field('Image', image, 'From Docker Hub or another registry. It must be published for arm64 (most popular images are).'),
  field('Name', name),
  field('Container port', cport, 'The port the app listens on inside the container (from the image\'s docs, e.g. 80, 3000, 8080). PocketServer maps it to a free port on the phone.'),
  field('Volumes', volumes, 'Folders inside the container to keep between updates, one per line, e.g. /data. They are stored in the app\'s data folder.'),
  h('details', { class: 'advanced' }, h('summary', null, 'Advanced: command'), field('Command', command, 'Overrides the image\'s CMD.')),
  field('Environment variables', env, 'One KEY=value per line, as in docker run -e.'),
  h('div', { class: 'form-actions' }, btn, h('a', { class: 'btn ghost', href: '#/' }, 'Cancel')), err);
  setTimeout(() => image.focus(), 50);
  return h('div', { class: 'grid two' }, h('div', { class: 'card' }, form),
    h('div', { class: 'card' }, h('h3', null, 'Docker on a phone (experimental)'),
      h('ul', { class: 'steps' },
        h('li', null, 'Images run with ', h('strong', null, 'udocker'), ', without Docker or root. There is no isolation between containers.'),
        h('li', null, 'Images that need to be the main system process (s6-overlay, systemd), like many linuxserver.io images and Home Assistant, don\'t work.'),
        h('li', null, 'docker-compose files aren\'t supported. Run each service as its own app and connect them with environment variables.'),
        h('li', null, 'Native apps from the catalog are faster and use less memory. Prefer them when available.'))));
}

function sourceForm(source) {
  const name = h('input', { type: 'text', placeholder: 'my-app', maxlength: 60 });
  const repo = h('input', { type: 'text', placeholder: 'https://github.com/you/your-app  or  you/your-app', autocomplete: 'off', spellcheck: 'false' });
  const branch = h('input', { type: 'text', placeholder: 'Default branch' });
  const subdir = h('input', { type: 'text', placeholder: 'Leave empty for the repo root' });
  const install = h('input', { type: 'text', placeholder: 'Auto-detected', spellcheck: 'false' });
  const build = h('input', { type: 'text', placeholder: 'Auto-detected', spellcheck: 'false' });
  const start = h('input', { type: 'text', placeholder: source === 'command' ? 'node bot.js' : 'Auto-detected', spellcheck: 'false' });
  const port = h('input', { type: 'number', placeholder: 'Pick automatically', min: 1024, max: 65535 });
  const env = h('textarea', { placeholder: 'DATABASE_URL=postgresql://…\nSECRET_KEY=…', spellcheck: 'false' });
  const auto = h('input', { type: 'checkbox', checked: true });
  repo.addEventListener('input', () => {
    const m = repo.value.trim().match(/([^/:]+?)(\.git)?\/?$/);
    if (m && !name.dataset.touched) name.value = m[1];
  });
  name.addEventListener('input', () => { name.dataset.touched = '1'; });
  const isGit = source === 'git';
  const startField = field('Start command', start, 'Your app must listen on the PORT environment variable.');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, isGit ? 'Create and deploy' : 'Create and start');
  const err = h('div', { class: 'error-text' });
  const form = h('form', {
    onsubmit: busy(btn, async () => {
      err.textContent = '';
      try {
        const body = { source, name: name.value, env: env.value, install: install.value, build: build.value, start: start.value, autoDeploy: auto.checked };
        if (isGit) Object.assign(body, { repo: repo.value, branch: branch.value, subdir: subdir.value });
        if (port.value) body.port = Number(port.value);
        const a = await api('POST', '/apps', body);
        toast('App created. Deploying…', 'ok');
        go('/apps/' + a.id + '/logs');
      } catch (e) { err.textContent = e.message; throw e; }
    }),
  },
  isGit ? [
    field('Repository', repo, h('span', null, 'A GitHub link, or just ', h('code', null, 'you/app'), '. Private repo? Use its SSH address (', h('code', null, 'git@github.com:you/app.git'), ') and add this phone\'s key in ', h('a', { href: '#/settings' }, 'Settings → Git access'), '.')),
    h('div', { class: 'row' }, field('Branch', branch), field('Folder', subdir, 'For monorepos'))]
    : [h('p', { class: 'muted' }, 'Run any program that keeps running, like a bot or a binary you copied to the phone. It runs from its own folder; $APP_DATA is a folder for its data.'), startField],
  field('Name', name),
  h('details', { class: 'advanced' }, h('summary', null, isGit ? 'Advanced: commands and port' : 'Advanced: install command and port'),
    h('div', { class: 'row' }, field('Install command', install), isGit ? field('Build command', build) : null),
    isGit ? startField : null, field('Port', port)),
  field('Environment variables', env, 'One KEY=value per line. PORT is set for you.'),
  isGit ? h('label', { class: 'check' }, auto, h('span', null, 'Redeploy automatically when I push', h('small', null, 'Checks the repository for new commits every 2 minutes. Works behind any router.'))) : null,
  h('div', { class: 'form-actions' }, btn, h('a', { class: 'btn ghost', href: '#/' }, 'Cancel')), err);
  setTimeout(() => (isGit ? repo : start).focus(), 50);
  return h('div', { class: 'grid two' },
    h('div', { class: 'card' }, form),
    isGit ? h('div', { class: 'card' }, h('h3', null, 'How it works'),
      h('ol', { class: 'steps' },
        h('li', null, h('strong', null, 'Clone. '), 'PocketServer pulls your repository onto the phone.'),
        h('li', null, h('strong', null, 'Detect. '), 'It looks for package.json, requirements.txt, go.mod, Cargo.toml, composer.json, a Procfile or index.html, and installs the runtime if it is missing.'),
        h('li', null, h('strong', null, 'Build and run. '), 'Dependencies are installed, the build runs, and your app starts with ', h('code', null, 'PORT'), ' set. It is restarted if it crashes.'),
        h('li', null, h('strong', null, 'Share. '), 'Open it on your Wi-Fi straight away, or turn on a free public URL from the app page.')),
      h('p', { class: 'faint', style: 'margin-top:12px' }, 'Only a Dockerfile? Use the Docker image tab with a published image instead.')) : null);
}

// ---------- logs panel ----------
// Many programs log everything to stderr, so stderr alone isn't shown as an error. Lines that look
// like errors or warnings are highlighted instead.
function lineTone(l) {
  if (l.s === 'sys') return /^✗/.test(l.m) ? 'bad' : 'sys';
  if (/\b(level=(error|fatal)|error|fatal|panic|exception|traceback|segfault|ERR!)\b|^✗/i.test(l.m) && !/\b(level=(info|debug)|0 errors?|no errors?)\b/i.test(l.m)) return 'bad';
  if (/\b(level=warn(ing)?|warn(ing)?|deprecated)\b/i.test(l.m) && !/level=(info|debug)/i.test(l.m)) return 'warn';
  return 'out';
}
function logPanel(key, { onStatus } = {}) {
  const term = h('div', { class: 'terminal' }, h('div', { class: 'placeholder' }, 'Connecting…'));
  const live = h('span', { class: 'live off' }, 'Connecting');
  let follow = true;
  term.addEventListener('scroll', () => { follow = term.scrollHeight - term.scrollTop - term.clientHeight < 40; });
  const add = (l) => {
    const first = term.firstChild;
    if (first && first.classList && first.classList.contains('placeholder')) term.replaceChildren();
    term.append(h('div', { class: 'ln ' + lineTone(l) }, h('time', null, clock(l.t)), l.m));
    while (term.childNodes.length > 2000) term.firstChild.remove();
    if (follow) term.scrollTop = term.scrollHeight;
  };
  const es = new EventSource('/api/logs/' + encodeURIComponent(key) + '?k=' + encodeURIComponent(sessionKey.get()));
  es.addEventListener('history', (e) => {
    term.replaceChildren();
    const arr = JSON.parse(e.data);
    if (!arr.length) term.append(h('div', { class: 'placeholder' }, 'No logs yet.'));
    arr.forEach(add);
    follow = true;
    term.scrollTop = term.scrollHeight;
    live.className = 'live';
    live.textContent = 'Live';
  });
  es.onmessage = (e) => add(JSON.parse(e.data));
  es.addEventListener('status', () => { if (onStatus) onStatus(); });
  es.onerror = () => { live.className = 'live off'; live.textContent = 'Reconnecting…'; };
  onCleanup(() => es.close());
  return h('div', null,
    h('div', { class: 'term-bar' }, live, h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost small', onclick: () => { follow = true; term.scrollTop = term.scrollHeight; } }, 'Jump to end'),
      h('button', { class: 'btn ghost small', onclick: () => term.replaceChildren(h('div', { class: 'placeholder' }, 'Cleared. New lines will appear here.')) }, 'Clear view')),
    term);
}

// ---------- app page ----------
async function AppPage(v, id, tab) {
  let a = await api('GET', '/apps/' + id);
  const head = h('div');
  const action = (label, path, cls, done, ic) => {
    const b = h('button', { class: 'btn small ' + (cls || '') }, ic ? icon(ic) : null, label);
    b.addEventListener('click', busy(b, async () => { await api('POST', `/apps/${id}/${path}`); toast(done, 'ok'); refresh(); }));
    return b;
  };
  const drawHead = () => {
    const running = a.status === 'running';
    fill(head, 
      h('a', { class: 'back', href: '#/' }, icon('left'), 'Dashboard'),
      h('div', { class: 'page-head' },
        h('div', { class: 'title' },
          monogram(a.name, { large: true }),
          h('div', { style: 'min-width:0' },
            h('h1', null, a.name),
            h('div', { class: 'sub' },
              statusEl(a.status),
              appKind(a) ? h('span', { class: 'meta-mono' }, appKind(a)) : null,
              h('span', { class: 'meta-mono' }, `:${a.port}`),
              running && a.usage ? h('span', { class: 'meta-mono' }, usageText(a.usage)) : null,
              running && a.startedAt ? h('span', { class: 'meta-mono' }, `up ${duration((Date.now() - a.startedAt) / 1000)}`) : null,
              a.restarts ? h('span', { class: 'meta-mono' }, `${a.restarts} restarts`) : null))),
        h('div', { class: 'actions' },
          running || a.status === 'crashed' || a.status === 'deploying'
            ? action('Stop', 'stop', 'ghost', 'Stopped', 'stop')
            : action('Start', 'start', 'ghost', 'Starting', 'play'),
          running || a.status === 'crashed' ? action('Restart', 'restart', '', 'Restarted', 'restart') : null,
          action(a.source === 'git' || a.catalog ? 'Redeploy' : a.source === 'docker' ? 'Pull & redeploy' : 'Apply & restart', 'deploy', '', 'Deploy started', 'deploy'),
          running ? h('a', { class: 'btn small primary', href: lanUrl(a.port), target: '_blank', rel: 'noopener' }, 'Open', icon('out')) : null)),
      a.lastDeploy && !a.lastDeploy.ok && a.status !== 'deploying'
        ? h('div', { class: 'banner bad' }, `Last deploy failed: ${a.lastDeploy.error}`) : null,
      h('div', { class: 'tabs' }, [['logs', 'Logs'], ['env', 'Environment'], ['public', 'Public URL'], ['settings', 'Settings']]
        .map(([k, label]) => h('a', { href: `#/apps/${id}/${k}`, class: tab === k ? 'on' : '' }, label))));
  };
  const refresh = async () => { try { const x = await api('GET', '/apps/' + id); if (v.alive()) { a = x; drawHead(); } } catch {} };
  drawHead();

  let body;
  if (tab === 'env') body = appEnvTab(a);
  else if (tab === 'public') body = appPublicTab(a, refresh);
  else if (tab === 'settings') body = appSettingsTab(a);
  else body = h('div', null, claimBanner(a), appInfo(a), deployInfo(a), logPanel(id, { onStatus: refresh }));

  v.render(h('div', null, head, body));
  every(3000, refresh);
}

const CLAIM_TEXT = 'This app gives admin rights to whoever opens it first. Open it right after installing and create your account, before anyone else on your Wi-Fi does, and before turning on a public URL.';
// Remembered per browser: whether you said you've created your account in a "first visitor is admin" app.
const claimed = {
  has(id) { try { return localStorage.getItem('ps_claimed_' + id) === '1'; } catch { return false; } },
  set(id) { try { localStorage.setItem('ps_claimed_' + id, '1'); } catch {} },
};
function claimBanner(a) {
  if (!a.catalog || !a.catalog.claim || claimed.has(a.id)) return null;
  const box = h('div', { class: 'banner' },
    h('span', { style: 'flex:1;min-width:200px' }, h('strong', null, 'Create your account now. '), 'Until you do, anyone on your Wi-Fi who opens this app first becomes its admin.'),
    a.status === 'running' ? h('a', { class: 'btn small', href: lanUrl(a.port), target: '_blank', rel: 'noopener' }, 'Open', icon('out')) : null,
    h('button', { class: 'btn small ghost', onclick: () => { claimed.set(a.id); box.remove(); } }, 'I\'ve created it'));
  return box;
}

/** Login details and notes for apps installed from the catalog. */
function appInfo(a) {
  const c = a.credentials;
  const notes = a.catalog && a.catalog.notes;
  if (!c && !notes) return null;
  const url = lanUrl(a.port) + (c && c.path ? c.path : '');
  return h('div', { class: 'card info-card' },
    c ? h('div', { class: 'creds' },
      h('div', null, h('div', { class: 'label' }, 'Address'), h('a', { href: url, target: '_blank', rel: 'noopener' }, url.replace(/^https?:\/\//, ''), icon('out'))),
      c.username ? h('div', null, h('div', { class: 'label' }, 'Username'), copyField(c.username)) : null,
      h('div', null, h('div', { class: 'label' }, 'Password'), copyField(c.password, { secret: true }))) : null,
    notes ? h('p', { class: 'faint', style: c ? 'margin:12px 0 0' : 'margin:0' }, notes) : null);
}

function deployInfo(a) {
  if (!a.lastDeploy) return null;
  const d = a.lastDeploy;
  return h('div', { class: 'deploy-line' },
    h('span', { class: d.ok ? 'ok' : 'no' }, d.ok ? 'Deployed' : 'Failed'),
    d.sha ? h('code', { class: 'faint' }, d.sha.slice(0, 7)) : null,
    d.commit ? h('span', null, d.commit) : null,
    h('span', { class: 'faint' }, `${ago(d.at)} · took ${d.seconds}s · ${d.reason}`));
}

function appEnvTab(a) {
  const ta = h('textarea', { spellcheck: 'false', style: 'min-height:260px' });
  ta.value = Object.entries(a.env).map(([k, val]) => `${k}=${val}`).join('\n');
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save and restart');
  return h('div', { class: 'grid two' },
    h('form', { class: 'card', onsubmit: busy(btn, async () => { await api('PATCH', '/apps/' + a.id, { env: ta.value }); toast('Saved. Restarting the app…', 'ok'); }) },
      field('Environment variables', ta, 'One KEY=value per line. Lines starting with # are ignored.'), btn),
    h('div', { class: 'card' }, h('h3', null, 'Set for you'),
      h('dl', { class: 'kv' },
        h('dt', null, 'PORT'), h('dd', null, h('code', null, a.port), ' — listen on this'),
        h('dt', null, 'HOST'), h('dd', null, h('code', null, '0.0.0.0')),
        h('dt', null, 'NODE_ENV'), h('dd', null, h('code', null, 'production'), ' (while running)')),
      h('p', { class: 'faint', style: 'margin-top:12px' }, 'Variables you set here override these.')));
}

function appPublicTab(a, refresh) {
  const pub = a.public || {};
  const toggle = h('button', { class: 'btn ' + (pub.enabled ? '' : 'primary') }, pub.enabled ? 'Turn off public URL' : 'Get a free public URL');
  toggle.addEventListener('click', busy(toggle, async () => {
    if (!pub.enabled && a.catalog && a.catalog.claim && !claimed.has(a.id)
      && !confirm('Anyone on the internet who opens this app before you create your account becomes its admin. Have you created your account?')) return;
    if (!pub.enabled && a.catalog && a.catalog.claim) claimed.set(a.id);
    await api('POST', `/apps/${a.id}/public`, { enabled: !pub.enabled });
    toast(pub.enabled ? 'Public URL turned off' : 'Starting tunnel… the address appears in a few seconds', 'ok');
    router();
  }));
  const hookUrl = `${location.origin}/api/hooks/${a.id}`;
  return h('div', null,
    h('div', { class: 'grid two' },
      h('div', { class: 'card' },
        h('h3', null, 'Public URL'),
        h('p', null, 'Share your app with anyone on the internet through Cloudflare Tunnel. Free, no account, no router setup, and it works on mobile data too.'),
        pub.enabled
          ? (pub.url
            ? h('div', { class: 'field' }, copyField(pub.url), h('div', { class: 'help' }, h('a', { href: pub.url, target: '_blank', rel: 'noopener' }, 'Open'), ' · The address changes if the tunnel restarts. Use your own domain (Settings) for a permanent one.'))
            : h('p', { class: 'muted' }, 'Getting an address… (status: ', a.tunnel, ')'))
          : null,
        toggle),
      h('div', { class: 'card' },
        h('h3', null, 'On your Wi-Fi'),
        h('p', null, 'Any device on the same network can already open it:'),
        copyField(lanUrl(a.port)),
        h('p', { class: 'faint', style: 'margin-top:10px' }, 'Tip: give the phone a fixed IP in your router (a "DHCP reservation") so this address never changes.'))),
    pub.enabled ? h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', null, 'Tunnel logs'), logPanel('tunnel-' + a.id, { onStatus: refresh })) : null,
    a.source === 'git' ? h('div', { class: 'card', style: 'margin-top:16px' },
      h('h3', null, 'Deploy webhook (optional)'),
      h('p', null, 'PocketServer already checks for new commits every 2 minutes. For instant deploys, add this webhook in GitHub, GitLab or Gitea. It only works if this dashboard is reachable from the internet, for example through your own domain.'),
      h('dl', { class: 'kv' },
        h('dt', null, 'Payload URL'), h('dd', null, copyField(hookUrl)),
        h('dt', null, 'Secret'), h('dd', null, copyField(a.webhookSecret, { secret: true })),
        h('dt', null, 'Content type'), h('dd', null, h('code', null, 'application/json'))),
      h('p', { class: 'faint', style: 'margin-top:10px' }, 'GitLab: put the secret in "Secret token". Other services: POST to ', h('code', null, 'Payload URL?token=<secret>'), '.')) : null);
}

function appSettingsTab(a) {
  const c = a.commands || {};
  const inp = (value, placeholder, type = 'text') => h('input', { type, value: value ?? '', placeholder, spellcheck: 'false' });
  const name = inp(a.name);
  const repo = inp(a.repo);
  const branch = inp(a.branch, 'Default branch');
  const subdir = inp(a.subdir, 'Repo root');
  const install = inp(c.install, 'Auto-detected');
  const build = inp(c.build, 'Auto-detected');
  const start = inp(c.start, a.source === 'git' ? 'Auto-detected' : '');
  const port = inp(a.port, '', 'number');
  const dk = a.docker || {};
  const image = inp(dk.image, 'image:tag');
  const cport = inp(dk.containerPort, 'Same as the port', 'number');
  const volumes = h('textarea', { spellcheck: 'false', style: 'min-height:70px', placeholder: '/data' }); volumes.value = (dk.volumes || []).join('\n');
  const dcmd = inp(dk.command, 'Image default');
  const auto = h('input', { type: 'checkbox', checked: a.autoDeploy });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const del = h('button', { class: 'btn danger', type: 'button' }, icon('trash'), 'Delete app');
  del.addEventListener('click', busy(del, async () => {
    if (!confirm(`Delete "${a.name}"? Its files and logs on the phone are removed. This can't be undone.`)) return;
    await api('DELETE', '/apps/' + a.id);
    toast('App deleted', 'ok');
    go('/');
  }));
  const form = h('form', {
    class: 'card',
    onsubmit: busy(btn, async () => {
      const body = { name: name.value, port: Number(port.value), autoDeploy: auto.checked };
      if (a.source === 'docker') Object.assign(body, { image: image.value, containerPort: cport.value ? Number(cport.value) : null, volumes: volumes.value, command: dcmd.value });
      else Object.assign(body, { install: install.value, build: build.value, start: start.value });
      if (a.source === 'git') Object.assign(body, { repo: repo.value, branch: branch.value, subdir: subdir.value });
      await api('PATCH', '/apps/' + a.id, body);
      toast('Saved. Changes are applied automatically.', 'ok');
    }),
  },
  field('Name', name),
  a.source === 'git' ? [field('Repository URL', repo), h('div', { class: 'row' }, field('Branch', branch), field('Folder', subdir))] : null,
  a.source === 'docker' ? [
    field('Image', image, 'Changing it pulls the new image and recreates the container. Volumes are kept.'),
    field('Container port', cport, 'The port the app listens on inside the container.'),
    field('Volumes', volumes, 'Folders inside the container to keep, one per line.'),
    field('Command', dcmd)] : [
    h('div', { class: 'row' }, field('Install command', install), a.source === 'git' ? field('Build command', build) : null),
    field('Start command', start)],
  field('Port', port, a.source === 'docker' ? 'The port on the phone.' : 'Your app reads this from the PORT environment variable.'),
  a.source === 'git' ? h('label', { class: 'check' }, auto, h('span', null, 'Redeploy automatically when I push', h('small', null, 'Checks for new commits every 2 minutes.'))) : null,
  btn);
  return h('div', { class: 'grid two' }, form,
    h('div', null,
      h('div', { class: 'card' }, h('h3', null, 'Details'),
        h('dl', { class: 'kv' },
          h('dt', null, 'App ID'), h('dd', null, h('code', null, a.id)),
          h('dt', null, 'Detected'), h('dd', null, a.type || '—'),
          h('dt', null, 'Data folder'), h('dd', null, h('code', null, a.dataDir)),
          h('dt', null, 'Created'), h('dd', null, new Date(a.createdAt).toLocaleString()))),
      h('div', { class: 'card danger-zone' }, h('h3', null, 'Danger zone'), h('p', null, 'Stops the app and deletes its code, build files and logs from the phone.'), del)));
}

// ---------- databases ----------
const DB_TYPES = [
  { type: 'postgres', label: 'PostgreSQL', note: 'The all-rounder relational database' },
  { type: 'mariadb', label: 'MariaDB', note: 'MySQL-compatible, for WordPress, Laravel…' },
  { type: 'redis', label: 'Redis', note: 'Fast key-value store, caches, queues' },
];

function NewDatabase(v) {
  let type = 'postgres';
  const name = h('input', { type: 'text', placeholder: 'PostgreSQL', maxlength: 60 });
  const lan = h('input', { type: 'checkbox' });
  const choices = h('div', { class: 'choices' });
  const draw = () => fill(choices, ...DB_TYPES.map((t) => h('button', {
    type: 'button', class: 'choice' + (t.type === type ? ' on' : ''),
    onclick: () => { type = t.type; name.placeholder = t.label; draw(); },
  }, monogram(t.label, { glyph: 'db' }), h('span', null, h('strong', null, t.label), h('small', null, t.note)))));
  draw();
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create database');
  const err = h('div', { class: 'error-text' });
  v.render(h('div', null,
    h('a', { class: 'back', href: '#/' }, icon('left'), 'Dashboard'),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'New database'), h('div', { class: 'sub' }, 'Installed and set up for you. A strong password is generated.'))),
    h('form', {
      class: 'card', style: 'max-width:640px',
      onsubmit: busy(btn, async () => {
        err.textContent = '';
        try {
          const d = await api('POST', '/databases', { type, name: name.value, lan: lan.checked });
          toast('Setting up the database…', 'ok');
          go('/databases/' + d.id);
        } catch (e) { err.textContent = e.message; throw e; }
      }),
    }, choices, field('Name', name),
    h('label', { class: 'check' }, lan, h('span', null, 'Allow connections from other devices on my Wi-Fi', h('small', null, 'Off: only apps on this phone can connect (safer).'))),
    btn, err)));
}

async function DbPage(v, id, tab) {
  let d = await api('GET', '/databases/' + id);
  const head = h('div');
  const conn = h('div');
  const action = (label, path, done) => {
    const b = h('button', { class: 'btn small' }, label);
    b.addEventListener('click', busy(b, async () => { await api('POST', `/databases/${id}/${path}`); toast(done, 'ok'); refresh(); }));
    return b;
  };
  const del = h('button', { class: 'btn small danger ghost' }, icon('trash'), 'Delete');
  del.addEventListener('click', busy(del, async () => {
    if (!confirm(`Delete "${d.name}" and all its data? This can't be undone.`)) return;
    await api('DELETE', '/databases/' + id);
    toast('Database deleted', 'ok');
    go('/');
  }));
  let wasRunning = d.status === 'running';
  const drawHead = () => {
    const running = d.status === 'running';
    fill(head,
      h('a', { class: 'back', href: '#/' }, icon('left'), 'Dashboard'),
      h('div', { class: 'page-head' },
        h('div', { class: 'title' }, monogram(d.typeLabel, { large: true, glyph: 'db' }),
          h('div', { style: 'min-width:0' }, h('h1', null, d.name), h('div', { class: 'sub' }, statusEl(d.error && !running ? 'failed' : d.status), h('span', { class: 'meta-mono' }, d.typeLabel.toLowerCase()), h('span', { class: 'meta-mono' }, `:${d.port}`)))),
        h('div', { class: 'actions' },
          running ? action('Restart', 'restart', 'Restarting') : null,
          running || d.status === 'starting' || d.status === 'crashed' ? action('Stop', 'stop', 'Stopped') : action('Start', 'start', 'Starting'),
          del)),
      d.error && !running ? h('div', { class: 'banner bad' }, d.error) : null,
      h('div', { class: 'tabs' }, [['data', d.type === 'redis' ? 'Keys' : 'Data'], ['connect', 'Connect'], ['logs', 'Logs']]
        .map(([k, label]) => h('a', { href: `#/databases/${id}/${k}`, class: tab === k ? 'on' : '' }, label))));
  };
  let lastConnKey = '';
  const drawConn = () => {
    const key = JSON.stringify([d.urls, d.lan, d.port]);
    if (key === lastConnKey) return; // don't rebuild while the user may be selecting text
    lastConnKey = key;
    const user = d.type === 'postgres' ? 'postgres' : d.type === 'mariadb' ? 'app' : '—';
    const lanToggle = h('input', { type: 'checkbox', checked: d.lan });
    lanToggle.addEventListener('change', async () => {
      try { d = await api('PATCH', '/databases/' + id, { lan: lanToggle.checked }); toast('Saved. Restarting the database…', 'ok'); drawConn(); } catch (e) { toast(e.message, 'error'); lanToggle.checked = !lanToggle.checked; }
    });
    fill(conn, h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', null, 'Connect from your apps'),
        h('p', null, 'Put this in your app\'s environment, for example as ', h('code', null, d.type === 'redis' ? 'REDIS_URL' : 'DATABASE_URL'), '.'),
        copyField(d.urls.local, { secret: true }),
        d.urls.lan ? h('div', { style: 'margin-top:14px' }, h('p', null, 'From other devices on your Wi-Fi (TablePlus, DBeaver…):'), copyField(d.urls.lan, { secret: true })) : null),
      h('div', { class: 'card' }, h('h3', null, 'Details'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Host'), h('dd', null, h('code', null, '127.0.0.1')),
          h('dt', null, 'Port'), h('dd', null, h('code', null, d.port)),
          d.type !== 'redis' ? [h('dt', null, 'Database'), h('dd', null, h('code', null, d.dbName)), h('dt', null, 'User'), h('dd', null, h('code', null, user))] : null,
          h('dt', null, 'Password'), h('dd', null, copyField(d.password, { secret: true }))),
        h('label', { class: 'check', style: 'margin:14px 0 0' }, lanToggle, h('span', null, 'Allow connections from other devices on my Wi-Fi', h('small', null, 'Restarts the database. Needed for desktop apps like TablePlus or DBeaver.'))))));
  };
  const body = h('div');
  const drawBody = () => {
    if (tab === 'connect') { drawConn(); fill(body, conn); return; }
    if (tab === 'logs') { fill(body, logPanel(id, { onStatus: refresh })); return; }
    if (d.status !== 'running' || !d.initialized) {
      fill(body, h('div', { class: 'empty' }, h('p', null, d.status === 'starting' ? 'The database is starting. Its data appears here once it is running.' : 'Start the database to see its data.')));
      return;
    }
    fill(body, d.type === 'redis' ? redisBrowser(id) : sqlBrowser(id, d));
  };
  const refresh = async () => {
    try {
      const x = await api('GET', '/databases/' + id);
      if (!v.alive()) return;
      d = x; drawHead();
      if (tab === 'connect') drawConn();
      const running = d.status === 'running' && d.initialized;
      if (tab === 'data' && running !== wasRunning) drawBody(); // only redraw the browser when it starts/stops
      wasRunning = running;
    } catch {}
  };
  wasRunning = d.status === 'running' && d.initialized;
  drawHead();
  drawBody();
  v.render(h('div', null, head, body));
  every(4000, refresh);
}

// ---------- data browser (PostgreSQL / MariaDB) ----------
const cellText = (val) => (val === null ? 'NULL' : val.length > 120 ? val.slice(0, 120) + '…' : val);

function sqlBrowser(id, d) {
  let tables = [];
  let current = null; // { schema, name, view }
  let page = { offset: 0, limit: 50 };
  const list = h('div', { class: 'table-list' }, h('div', { class: 'faint' }, 'Loading…'));
  const grid = h('div', { class: 'data-main' });
  const showSchema = () => new Set(tables.map((t) => t.schema)).size > 1;
  const tname = (t) => (t.schema && showSchema() ? `${t.schema}.${t.name}` : t.name);
  const qs = () => `table=${encodeURIComponent(current.name)}${current.schema ? '&schema=' + encodeURIComponent(current.schema) : ''}`;

  const loadTables = async () => {
    tables = await api('GET', `/databases/${id}/tables`);
    if (current && !tables.some((t) => t.name === current.name && t.schema === current.schema)) current = null;
    if (!current && tables.length) current = tables[0];
    drawList();
    if (current) await loadRows(); else fill(grid, h('div', { class: 'empty' }, h('p', null, 'No tables yet.'), h('p', { class: 'faint' }, 'Create one with SQL below, or let your app create its tables.')));
  };
  const drawList = () => fill(list,
    h('div', { class: 'table-list-head' }, 'Tables', h('button', { class: 'btn ghost small', title: 'Reload', onclick: () => loadTables().catch((e) => toast(e.message, 'error')) }, icon('refresh'))),
    tables.length ? tables.map((t) => h('button', {
      class: 'table-item' + (current === t ? ' on' : ''),
      onclick: () => { current = t; page.offset = 0; drawList(); loadRows().catch((e) => toast(e.message, 'error')); },
    }, tname(t), t.view ? h('span', { class: 'faint' }, ' view') : null)) : h('div', { class: 'faint', style: 'padding:6px 8px' }, 'None'));

  const loadRows = async () => {
    fill(grid, h('div', { class: 'faint' }, 'Loading…'));
    const r = await api('GET', `/databases/${id}/rows?${qs()}&limit=${page.limit}&offset=${page.offset}`);
    drawRows(r);
  };
  const drawRows = (r) => {
    const editable = r.editable && !current.view;
    const from = r.total ? r.offset + 1 : 0;
    const to = r.offset + r.rows.length;
    const nav = h('div', { class: 'data-bar' },
      h('strong', null, tname(current)),
      h('span', { class: 'faint' }, `${from}–${to} of ${r.total}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', disabled: r.offset === 0, onclick: () => { page.offset = Math.max(0, r.offset - r.limit); loadRows().catch((e) => toast(e.message, 'error')); } }, icon('left'), 'Prev'),
      h('button', { class: 'btn small', disabled: to >= r.total, onclick: () => { page.offset = r.offset + r.limit; loadRows().catch((e) => toast(e.message, 'error')); } }, 'Next', icon('right')),
      !current.view ? h('button', { class: 'btn small primary', onclick: () => rowEditor(r.columns, null) }, icon('plus'), 'Add row') : null);
    const table = h('table', { class: 'data' },
      h('thead', null, h('tr', null, r.columns.map((c) => h('th', { title: c.type }, c.name, c.pk ? h('span', { class: 'pk', title: 'Primary key' }, 'PK') : null, h('small', null, c.type))))),
      h('tbody', null, r.rows.length ? r.rows.map((row) => h('tr', {
        class: editable ? 'clickable' : '',
        onclick: editable ? () => rowEditor(r.columns, row) : null,
      }, r.columns.map((c) => h('td', { class: row[c.name] === null ? 'null' : '' }, cellText(row[c.name])))))
        : h('tr', null, h('td', { colspan: r.columns.length, class: 'faint' }, 'No rows.'))));
    fill(grid, nav,
      !r.editable && !current.view ? h('div', { class: 'banner info' }, 'This table has no primary key, so rows can only be changed with SQL below.') : null,
      h('div', { class: 'table-wrap' }, table),
      editable ? h('p', { class: 'faint', style: 'margin:8px 0 0;font-size:12.5px' }, 'Click a row to edit or delete it.') : null);
  };

  /** Opens the edit form for a row, or an empty form to add one (row = null). */
  const rowEditor = (columns, row) => {
    const isNew = !row;
    const inputs = columns.map((c) => {
      const val = row ? row[c.name] : null;
      const long = c.type && /text|json|char\(\d{3,}|xml|array|\[\]|blob/i.test(c.type) || (val && (val.length > 60 || val.includes('\n')));
      const input = long ? h('textarea', { spellcheck: 'false', style: 'min-height:80px' }) : h('input', { type: 'text', spellcheck: 'false' });
      input.value = val ?? '';
      // New rows: empty + "default" means the column is left out so the database fills it in.
      const hasDefault = isNew && (c.default != null || c.auto || c.nullable);
      const nullBox = h('input', { type: 'checkbox', checked: isNew ? hasDefault : val === null });
      const sync = () => { input.disabled = nullBox.checked; };
      nullBox.addEventListener('change', sync); sync();
      const label = isNew ? (c.default != null || c.auto ? 'default' : 'NULL') : 'NULL';
      const showBox = isNew ? hasDefault : c.nullable;
      return { c, input, nullBox, showBox, el: h('div', { class: 'field' },
        h('label', null, c.name, ' ', h('span', { class: 'faint', style: 'font-weight:400' }, c.type), c.pk ? h('span', { class: 'faint' }, ' · primary key') : null),
        input,
        showBox ? h('label', { class: 'check', style: 'margin:6px 0 0' }, nullBox, h('span', null, label)) : null) };
    });
    const save = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add row' : 'Save');
    const remove = isNew ? null : h('button', { class: 'btn danger', type: 'button' }, 'Delete row');
    const key = {};
    if (row) for (const c of columns.filter((x) => x.pk)) key[c.name] = row[c.name];
    const base = { table: current.name, schema: current.schema };
    const close = openModal(h('form', {
      onsubmit: busy(save, async () => {
        const values = {};
        for (const f of inputs) {
          const next = f.showBox && f.nullBox.checked ? null : f.input.value;
          if (isNew) { if (!(f.showBox && f.nullBox.checked)) values[f.c.name] = next; } else if (next !== row[f.c.name]) values[f.c.name] = next;
        }
        if (!isNew && !Object.keys(values).length) { close(); return; }
        await api('POST', `/databases/${id}/rows`, isNew ? { ...base, op: 'insert', values } : { ...base, op: 'update', key, values });
        toast(isNew ? 'Row added' : 'Saved', 'ok');
        close();
        await loadRows();
      }),
    },
    h('h3', null, isNew ? `Add a row to ${current.name}` : `Edit row in ${current.name}`),
    inputs.map((f) => f.el),
    h('div', { class: 'form-actions' }, save, h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancel'), h('span', { class: 'spacer' }), remove)));
    if (remove) remove.addEventListener('click', busy(remove, async () => {
      if (!confirm('Delete this row? This can\'t be undone.')) return;
      await api('POST', `/databases/${id}/rows`, { ...base, op: 'delete', key });
      toast('Row deleted', 'ok');
      close();
      await loadRows();
    }));
  };

  // SQL console
  const sql = h('textarea', { spellcheck: 'false', placeholder: d.type === 'postgres' ? 'select * from users limit 10;' : 'SELECT * FROM users LIMIT 10;', style: 'min-height:90px' });
  const out = h('div');
  const run = h('button', { class: 'btn primary small', type: 'submit' }, 'Run');
  const runSql = busy(run, async () => {
    fill(out, h('div', { class: 'faint' }, 'Running…'));
    try {
      const r = await api('POST', `/databases/${id}/query`, { sql: sql.value });
      fill(out,
        r.message ? h('div', { class: 'faint', style: 'margin-bottom:6px' }, r.message) : null,
        r.columns && r.columns.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', null, h('tr', null, r.columns.map((c) => h('th', null, c)))),
          h('tbody', null, r.rows.map((row) => h('tr', null, row.map((x) => h('td', { class: x === null ? 'null' : '' }, cellText(x)))))))) : null,
        r.truncated ? h('div', { class: 'faint' }, 'Showing the first 1000 rows.') : null);
      if (/\b(create|drop|alter|rename)\b/i.test(sql.value)) await loadTables(); else if (current && /\b(insert|update|delete|truncate)\b/i.test(sql.value)) await loadRows();
    } catch (e) { fill(out, h('pre', { class: 'sql-error' }, e.message)); }
  });
  sql.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runSql(e); });
  const consoleCard = h('form', { class: 'card', style: 'margin-top:16px', onsubmit: runSql },
    h('div', { class: 'data-bar' }, h('strong', null, 'SQL'), h('span', { class: 'faint' }, `runs on ${d.dbName} · Ctrl/⌘ + Enter`), h('span', { class: 'spacer' }), run),
    sql, h('div', { style: 'margin-top:10px' }, out));

  loadTables().catch((e) => fill(grid, h('div', { class: 'banner' }, e.message)));
  return h('div', null, h('div', { class: 'data-layout' }, list, h('div', { class: 'card data-card' }, grid)), consoleCard);
}

function openModal(content) {
  const box = h('div', { class: 'modal card' }, content);
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } }, box);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  document.addEventListener('keydown', onKey);
  onCleanup(close);
  document.body.append(overlay);
  setTimeout(() => { const f = box.querySelector('input:not([disabled]), textarea:not([disabled])'); if (f) f.focus(); }, 30);
  return close;
}

// ---------- Redis browser ----------
function redisBrowser(id) {
  let keys = []; let cursor = null; let total = 0; let selected = null;
  const match = h('input', { type: 'text', placeholder: 'Filter, e.g. user:*', spellcheck: 'false' });
  const list = h('div', { class: 'key-list' });
  const detail = h('div', { class: 'data-main' }, h('div', { class: 'faint' }, 'Pick a key to see its value.'));

  const load = async (more = false) => {
    const r = await api('GET', `/databases/${id}/keys?match=${encodeURIComponent(match.value || '*')}&cursor=${more ? cursor : '0'}`);
    keys = more ? [...keys, ...r.keys] : r.keys;
    cursor = r.cursor; total = r.total;
    drawList();
  };
  const drawList = () => fill(list,
    h('div', { class: 'table-list-head' }, `${total} key${total === 1 ? '' : 's'}`, h('button', { class: 'btn ghost small', title: 'Reload', onclick: () => load().catch((e) => toast(e.message, 'error')) }, icon('refresh'))),
    keys.map((k) => h('button', { class: 'table-item' + (selected === k.name ? ' on' : ''), onclick: () => openKey(k.name) },
      h('span', { class: 'key-name' }, k.name), h('span', { class: 'badge' }, k.type))),
    cursor ? h('button', { class: 'btn ghost small', style: 'width:100%', onclick: () => load(true).catch((e) => toast(e.message, 'error')) }, 'Load more') : null,
    !keys.length ? h('div', { class: 'faint', style: 'padding:6px 8px' }, 'No keys found.') : null);

  const openKey = async (name) => {
    selected = name; drawList();
    let k;
    try { k = await api('GET', `/databases/${id}/key?key=${encodeURIComponent(name)}`); } catch (e) { toast(e.message, 'error'); return; }
    const delBtn = h('button', { class: 'btn small danger' }, 'Delete key');
    delBtn.addEventListener('click', busy(delBtn, async () => {
      if (!confirm(`Delete "${name}"?`)) return;
      await api('POST', `/databases/${id}/key`, { key: name, op: 'del' });
      toast('Deleted', 'ok'); selected = null; fill(detail, h('div', { class: 'faint' }, 'Pick a key to see its value.')); await load();
    }));
    const head = h('div', { class: 'data-bar' }, h('strong', { class: 'key-name' }, name), h('span', { class: 'badge accent' }, k.type),
      k.length != null ? h('span', { class: 'faint' }, `${k.length} items`) : null,
      h('span', { class: 'faint' }, k.ttl != null ? `expires in ${duration(k.ttl)}` : 'no expiry'), h('span', { class: 'spacer' }), delBtn);
    let bodyEl;
    if (k.type === 'string') bodyEl = stringEditor(name, k.value, k.ttl);
    else if (k.type === 'hash') bodyEl = hashEditor(name, k.value);
    else if (Array.isArray(k.value)) {
      bodyEl = h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, k.type === 'zset' ? [h('th', null, 'member'), h('th', null, 'score')] : [h('th', null, '#'), h('th', null, 'value')])),
        h('tbody', null, k.value.map((x, i) => h('tr', null, k.type === 'zset' ? [h('td', null, cellText(x[0])), h('td', null, x[1])] : [h('td', { class: 'faint' }, i), h('td', null, cellText(x))])))));
      bodyEl = h('div', null, bodyEl, k.length > k.value.length ? h('p', { class: 'faint' }, `Showing ${k.value.length} of ${k.length}. Use a command below to see more.`) : null);
    } else bodyEl = h('p', { class: 'muted' }, `Viewing ${k.type} keys isn't supported here yet. Use a command below.`);
    fill(detail, head, bodyEl);
  };

  const stringEditor = (name, value, ttl) => {
    const ta = h('textarea', { spellcheck: 'false', style: 'min-height:160px' }); ta.value = value ?? '';
    const ttlIn = h('input', { type: 'number', min: 0, placeholder: 'No expiry', value: ttl ?? '' });
    const save = h('button', { class: 'btn primary small', type: 'submit' }, 'Save');
    return h('form', { onsubmit: busy(save, async () => {
      await api('POST', `/databases/${id}/key`, { key: name, op: 'set', value: ta.value, ttl: ttlIn.value ? Number(ttlIn.value) : 0 });
      toast('Saved', 'ok'); await openKey(name);
    }) }, ta, h('div', { class: 'row', style: 'margin-top:10px;align-items:end' }, field('Expire after (seconds)', ttlIn), h('div', { class: 'field' }, save)));
  };

  const hashEditor = (name, pairs) => {
    const fieldIn = h('input', { type: 'text', placeholder: 'field', spellcheck: 'false' });
    const valIn = h('input', { type: 'text', placeholder: 'value', spellcheck: 'false' });
    const add = h('button', { class: 'btn small primary', type: 'submit' }, 'Set field');
    const rows = pairs.map(([f, val]) => {
      const rm = h('button', { class: 'btn ghost small', type: 'button', title: 'Delete field' }, '✕');
      rm.addEventListener('click', busy(rm, async () => { await api('POST', `/databases/${id}/key`, { key: name, op: 'hdel', field: f }); await openKey(name); }));
      return h('tr', { class: 'clickable', onclick: (e) => { if (e.target === rm) return; fieldIn.value = f; valIn.value = val; valIn.focus(); } },
        h('td', null, cellText(f)), h('td', null, cellText(val)), h('td', { style: 'width:1%' }, rm));
    });
    return h('div', null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, 'field'), h('th', null, 'value'), h('th', null, ''))), h('tbody', null, rows))),
      h('form', { class: 'row', style: 'margin-top:10px;align-items:center', onsubmit: busy(add, async () => {
        await api('POST', `/databases/${id}/key`, { key: name, op: 'hset', field: fieldIn.value, value: valIn.value });
        toast('Saved', 'ok'); await openKey(name);
      }) }, fieldIn, valIn, add),
      h('p', { class: 'faint', style: 'font-size:12.5px;margin-top:6px' }, 'Click a field to edit it.'));
  };

  const newKey = h('button', { class: 'btn small primary' }, icon('plus'), 'New key');
  newKey.addEventListener('click', () => {
    const name = h('input', { type: 'text', placeholder: 'my:key', spellcheck: 'false' });
    const value = h('textarea', { spellcheck: 'false', style: 'min-height:100px' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Create');
    const close = openModal(h('form', { onsubmit: busy(save, async () => {
      await api('POST', `/databases/${id}/key`, { key: name.value, op: 'set', value: value.value });
      toast('Key created', 'ok'); close(); await load(); await openKey(name.value);
    }) }, h('h3', null, 'New string key'), field('Name', name), field('Value', value),
    h('div', { class: 'form-actions' }, save, h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancel'))));
  });

  // Command console
  const cmd = h('input', { type: 'text', placeholder: 'e.g. GET user:1   or   KEYS *', spellcheck: 'false', class: 'mono' });
  const out = h('div');
  const run = h('button', { class: 'btn primary small', type: 'submit' }, 'Run');
  const consoleCard = h('form', { class: 'card', style: 'margin-top:16px', onsubmit: busy(run, async () => {
    try {
      const r = await api('POST', `/databases/${id}/query`, { sql: cmd.value });
      fill(out, h('pre', { class: 'reply' }, typeof r.reply === 'string' ? r.reply : JSON.stringify(r.reply, null, 2)));
      await load();
    } catch (e) { fill(out, h('pre', { class: 'sql-error' }, e.message)); }
  }) }, h('div', { class: 'data-bar' }, h('strong', null, 'Command'), h('span', { class: 'faint' }, 'any Redis command'), h('span', { class: 'spacer' }), run), cmd, h('div', { style: 'margin-top:10px' }, out));

  let t;
  match.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load().catch((e) => toast(e.message, 'error')), 300); });
  load().catch((e) => fill(detail, h('div', { class: 'banner' }, e.message)));
  return h('div', null,
    h('div', { class: 'data-bar', style: 'margin-bottom:12px' }, h('div', { style: 'flex:1;max-width:360px' }, match), h('span', { class: 'spacer' }), newKey),
    h('div', { class: 'data-layout' }, list, h('div', { class: 'card data-card' }, detail)),
    consoleCard);
}

// ---------- settings ----------
async function Settings(v) {
  const s = await api('GET', '/settings');
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Change password');
  const pwForm = h('form', {
    class: 'card',
    onsubmit: busy(pwBtn, async () => {
      if (pw.value !== pw2.value) throw new Error("The new passwords don't match.");
      const r = await api('POST', '/settings/password', { current: cur.value, password: pw.value });
      sessionKey.set(r.key);
      toast('Password changed. Other devices were logged out.', 'ok');
      cur.value = pw.value = pw2.value = '';
    }),
  }, h('h3', null, 'Password'),
  s.initialPassword ? h('p', null, 'You are using the password generated at install. Pick your own.') : null,
  field('Current password', cur), field('New password', pw, 'At least 8 characters.'), field('Repeat new password', pw2), pwBtn);

  const token = h('input', { type: 'password', placeholder: s.cloudflareToken || 'eyJhIjoi…', autocomplete: 'off' });
  const cfBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Save token');
  const cfRemove = s.cloudflareToken ? h('button', { class: 'btn danger', type: 'button' }, 'Remove') : null;
  if (cfRemove) cfRemove.addEventListener('click', busy(cfRemove, async () => { await api('POST', '/settings/cloudflare', { token: '' }); toast('Removed', 'ok'); router(); }));
  const cfForm = h('form', {
    class: 'card',
    onsubmit: busy(cfBtn, async () => { await api('POST', '/settings/cloudflare', { token: token.value }); toast('Saved. Connecting the tunnel…', 'ok'); router(); }),
  }, h('h3', null, 'Your own domains (Cloudflare Tunnel)'),
  h('p', null, 'Permanent addresses like app.yourdomain.com, with HTTPS. Free with a Cloudflare account and a domain on Cloudflare.'),
  h('ol', { class: 'steps' },
    h('li', null, 'In the Cloudflare dashboard open ', h('strong', null, 'Zero Trust → Networks → Tunnels'), ' and create a tunnel (type "Cloudflared").'),
    h('li', null, 'Copy the token from the install command (the long text after ', h('code', null, '--token'), ') and paste it below.'),
    h('li', null, 'Under ', h('strong', null, 'Public hostnames'), ', add one per app, pointing to ', h('code', null, 'http://localhost:<app port>'), '. Add one pointing to ', h('code', null, `http://localhost:${s.port}`), ' to reach this dashboard (and webhooks) from anywhere.')),
  s.cloudflareToken ? h('p', null, 'Tunnel status: ', statusEl(s.namedTunnel)) : null,
  field('Tunnel token', token),
  h('div', { class: 'form-actions' }, cfBtn, cfRemove));

  const phone = h('div', { class: 'card' }, h('h3', null, 'Keep the server running'),
    h('p', null, 'Android likes to stop background apps. Do these once so your apps stay up:'),
    h('ol', { class: 'steps' },
      h('li', null, h('strong', null, 'Battery: '), 'Settings → Apps → Termux → Battery → ', h('strong', null, 'Unrestricted'), ' (or "Don\'t optimize").'),
      h('li', null, h('strong', null, 'Start on boot: '), 'install the ', h('strong', null, 'Termux:Boot'), ' app from the same place you got Termux and open it once. The installer already added the boot script.'),
      h('li', null, h('strong', null, 'Android 12 and newer: '), 'Android can kill apps that start many processes. On Android 14+, turn on Developer options → ', h('strong', null, 'Disable child process restrictions'), '. On 12–13, run this once from a computer: ',
        h('code', null, 'adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"')),
      h('li', null, h('strong', null, 'Battery health: '), 'a phone on the charger 24/7 can swell its battery. Turn on your phone\'s charge limit (often called "Protect battery", "Optimized charging" or "Charging control") to stop at ~80%.'),
      h('li', null, h('strong', null, 'Fixed address: '), 'reserve an IP for the phone in your router so its Wi-Fi address stays the same.')),
    h('p', { class: 'faint' }, 'Run ', h('code', null, 'pocketserver doctor'), ' in Termux to check your setup.'));

  const about = h('div', { class: 'card' }, h('h3', null, 'About'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Version'), h('dd', null, s.version),
      h('dt', null, 'Device'), h('dd', null, s.device.name),
      h('dt', null, 'Android'), h('dd', null, s.device.android || '—'),
      h('dt', null, 'Architecture'), h('dd', null, s.device.arch),
      h('dt', null, 'Node.js'), h('dd', null, s.device.node),
      h('dt', null, 'Dashboard port'), h('dd', null, s.port),
      h('dt', null, 'Data folder'), h('dd', null, h('code', null, s.dataDir))),
    h('p', { class: 'faint', style: 'margin-top:12px' }, 'Update with ', h('code', null, 'pocketserver update'), '.'));

  v.render(h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'))),
    h('div', { class: 'grid two' }, h('div', null, sshCard(), pwForm, cfForm), h('div', null, gitCard(), phone, about))));
}

function gitCard() {
  const box = h('div', null, h('p', { class: 'faint' }, 'Loading…'));
  api('GET', '/settings/git-key').then((r) => fill(box,
    copyField(r.publicKey),
    h('ol', { class: 'steps', style: 'margin-top:14px' },
      h('li', null, 'On GitHub, open your repository → ', h('strong', null, 'Settings → Deploy keys → Add deploy key'), '. (GitLab: Settings → Repository → Deploy keys.)'),
      h('li', null, 'Paste the key above. Leave "Allow write access" off.'),
      h('li', null, 'Deploy using the SSH address, like ', h('code', null, 'git@github.com:you/app.git'), '.')),
    h('p', { class: 'faint', style: 'margin:0' }, 'Public repos need none of this: paste the link, or just ', h('code', null, 'you/app'), '.'))).catch((e) => fill(box, h('p', { class: 'error-text' }, e.message)));
  return h('div', { class: 'card' }, h('h3', { id: 'git' }, 'Git access (private repos)'),
    h('p', null, 'This phone has its own SSH key. Add it to a private repository once, and PocketServer can deploy it and pick up new commits.'),
    box);
}

function sshCard() {
  const box = h('div', null, h('p', { class: 'faint' }, 'Loading…'));
  const draw = (st) => {
    const ip = (st.ips[0] || {}).address || location.hostname;
    const keyIn = h('textarea', { spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA… you@laptop', style: 'min-height:70px' });
    const addBtn = h('button', { class: 'btn small', type: 'submit' }, 'Add key');
    const toggle = h('button', { class: 'btn ' + (st.enabled ? '' : 'primary') }, st.enabled ? 'Turn off SSH' : 'Turn on SSH');
    toggle.addEventListener('click', busy(toggle, async () => { draw(await api('POST', '/settings/ssh', { enabled: !st.enabled })); toast(st.enabled ? 'SSH turned off' : 'SSH is on', 'ok'); }));
    const sshCmd = `ssh -p ${st.port} ${st.user}@${ip}`;
    const sshConfig = `Host pocketserver\n  HostName ${ip}\n  Port ${st.port}\n  User ${st.user}`;
    fill(box,
      h('p', null, 'Open a terminal on the phone, or edit your apps\' files from VS Code on your computer. Logins use SSH keys only, never passwords.'),
      h('div', { class: 'field' }, h('label', null, 'Computers allowed to log in'),
        st.keys.length ? h('div', { class: 'key-rows' }, st.keys.map((k) => {
          const rm = h('button', { class: 'btn ghost small', title: 'Remove' }, 'Remove');
          rm.addEventListener('click', busy(rm, async () => { if (!confirm(`Remove ${k.comment || k.fingerprint}?`)) return; draw(await api('POST', '/settings/ssh', { removeKey: k.fingerprint })); }));
          return h('div', { class: 'key-row' }, h('div', null, h('strong', null, k.comment || k.type), h('div', { class: 'faint mono' }, k.fingerprint)), rm);
        })) : h('p', { class: 'faint', style: 'margin:0' }, 'None yet.')),
      h('form', { onsubmit: busy(addBtn, async () => { draw(await api('POST', '/settings/ssh', { addKey: keyIn.value })); toast('Key added', 'ok'); }) },
        field('Add your computer\'s public key', keyIn, h('span', null, 'On a Mac or Linux, copy it with ', h('code', null, 'pbcopy < ~/.ssh/id_ed25519.pub'), '. No key yet? Run ', h('code', null, 'ssh-keygen -t ed25519'), ' first.')),
        addBtn),
      h('div', { style: 'margin:16px 0' }, st.enabled ? h('p', null, 'Status: ', statusEl(st.status), ' on port ', h('code', null, st.port)) : null, toggle),
      st.enabled ? h('div', null,
        h('h4', null, 'Terminal'), copyField(sshCmd),
        h('h4', null, 'VS Code'),
        h('ol', { class: 'steps' },
          h('li', null, 'Add this to ', h('code', null, '~/.ssh/config'), ' on your computer:', h('pre', { class: 'reply', style: 'margin-top:6px' }, sshConfig)),
          h('li', null, 'In VS Code, install the ', h('strong', null, 'SSH FS'), ' extension (by Kelvin Schoofs).'),
          h('li', null, 'Run ', h('strong', null, 'SSH FS: Create a SSH FS configuration'), ', set host ', h('code', null, 'pocketserver'), ' and root ', h('code', null, st.appsDir), ', then connect.')),
        h('p', { class: 'faint' }, 'Your apps\' code is in ', h('code', null, st.appsDir + '/<app id>/src'), '. Edits there are overwritten by the next deploy, so commit and push your changes for anything you want to keep. VS Code\'s own "Remote - SSH" doesn\'t support Android, which is why SSH FS is used.'),
        st.hostFingerprint ? h('p', { class: 'faint', style: 'margin:0' }, 'Phone\'s fingerprint, to check on first connect: ', h('code', null, st.hostFingerprint)) : null,
        h('details', { class: 'advanced', style: 'margin-top:10px' }, h('summary', null, 'SSH logs'), logPanel('sshd'))) : null);
  };
  api('GET', '/settings/ssh').then(draw).catch((e) => fill(box, h('p', { class: 'error-text' }, e.message)));
  return h('div', { class: 'card' }, h('h3', null, 'SSH and VS Code'), box);
}

// ---------- boot ----------
window.addEventListener('hashchange', () => { if (shellShown) router(); });
(async () => {
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin', headers: { 'x-pocketserver-key': sessionKey.get() } }).then((r) => r.json());
    if (!me.loggedIn) { showLogin(); return; }
    showShell();
    router();
  } catch {
    document.getElementById('app').replaceChildren(h('div', { class: 'boot' }, "Can't reach PocketServer. Is it running?"));
  }
})();
