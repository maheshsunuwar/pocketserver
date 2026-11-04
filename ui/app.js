'use strict';
/* PocketHost dashboard — plain JS, no build step. All user text goes in via textContent (never innerHTML). */

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

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-pockethost': '1' },
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
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
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
    try { await fn(); } catch (err) { if (err.message !== 'Please log in.') toast(err.message, 'error'); } finally { btn.disabled = false; }
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
    else if (parts[0] === 'databases' && parts[1]) await DbPage(v, parts[1]);
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
      h('a', { class: 'brand', href: '#/' }, h('img', { src: 'icon.svg', alt: '' }), 'PocketHost', h('small', { id: 'device-name' })),
      h('nav', { class: 'nav' },
        h('a', { href: '#/', 'data-r': 'home' }, 'Dashboard'),
        h('a', { href: '#/settings', 'data-r': 'settings' }, 'Settings'),
        h('button', { onclick: async () => { await api('POST', '/logout').catch(() => {}); showLogin(); } }, 'Log out'))),
    h('main', { id: 'main' }));
  api('GET', '/settings').then((st) => { const el = document.getElementById('device-name'); if (el) el.textContent = st.device.name; }).catch(() => {});
}

function showLogin() {
  cleanups.forEach((f) => { try { f(); } catch {} });
  cleanups = [];
  routeToken++;
  shellShown = false;
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', autofocus: true });
  const err = h('div', { class: 'error-text' });
  const btn = h('button', { class: 'btn primary', style: 'width:100%', type: 'submit' }, 'Log in');
  const form = h('form', {
    onsubmit: busy(btn, async () => {
      err.textContent = '';
      try {
        await api('POST', '/login', { password: pw.value });
        showShell();
        router();
      } catch (e) { err.textContent = e.message; pw.select(); }
    }),
  }, field('Password', pw), btn, err);
  fill(document.getElementById('app'),
    h('div', { class: 'login' }, h('div', { class: 'card' },
      h('div', { class: 'brand' }, h('img', { src: 'icon.svg', alt: '' }), 'PocketHost'),
      h('p', { class: 'muted' }, 'Your phone, your server.'),
      form,
      h('p', { class: 'faint', style: 'font-size:12.5px;margin:6px 0 0' }, 'Forgot it? Run ', h('code', null, 'pockethost password'), ' in Termux.'))));
  setTimeout(() => pw.focus(), 50);
}

// ---------- dashboard ----------
function statCard(label, value, unit, hint, pct, tone) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value, unit ? h('small', null, unit) : null),
    h('div', { class: 'hint', title: hint || '' }, hint || ' '),
    pct != null ? h('div', { class: 'bar ' + (tone || '') }, h('i', { style: `width:${Math.max(2, Math.min(100, pct))}%` })) : null);
}

function statCards(s) {
  const cards = [];
  if (s.cpu.usage != null) cards.push(statCard('CPU', s.cpu.usage, '%', `${s.device.cores} cores`, s.cpu.usage, s.cpu.usage > 85 ? 'bad' : ''));
  else if (s.cpu.clock != null) cards.push(statCard('CPU clock', s.cpu.clock, '%', `of max speed · ${s.device.cores} cores`, s.cpu.clock));
  else cards.push(statCard('CPU', s.device.cores || '—', ' cores', 'Usage hidden by Android'));
  if (s.memory && s.memory.total) {
    const used = s.memory.total - s.memory.available;
    const pct = (100 * used) / s.memory.total;
    cards.push(statCard('Memory', bytes(used), null, `of ${bytes(s.memory.total)}`, pct, pct > 90 ? 'bad' : pct > 75 ? 'warn' : ''));
  }
  if (s.storage) {
    const used = s.storage.total - s.storage.free;
    const pct = (100 * used) / s.storage.total;
    cards.push(statCard('Storage', bytes(s.storage.free), ' free', `${bytes(used)} of ${bytes(s.storage.total)} used`, pct, pct > 90 ? 'bad' : ''));
  }
  if (s.battery) {
    const b = s.battery;
    const hint = [b.charging ? 'Charging' : b.charging === false ? 'On battery' : null, b.temp != null ? `${b.temp.toFixed(0)}°C` : null].filter(Boolean).join(' · ');
    cards.push(statCard('Battery', b.level, '%', hint, b.level, b.level < 20 ? 'bad' : b.charging ? 'good' : ''));
  }
  const temp = s.temperature ?? (s.battery && s.battery.temp);
  if (temp != null) cards.push(statCard('Temperature', temp.toFixed(0), '°C', s.temperature != null ? 'CPU' : 'Battery', null));
  cards.push(statCard('Uptime', duration(s.uptime), null, s.ips[0] ? `IP ${s.ips[0].address}` : 'No network address found'));
  return cards;
}

function usageText(u) {
  if (!u) return null;
  return `${u.cpu != null ? u.cpu + '% CPU · ' : ''}${bytes(u.memory)}`;
}

function appTile(a) {
  const stop = (e) => e.stopPropagation();
  return h('div', { class: 'card tile', role: 'link', tabindex: 0, onclick: () => go('/apps/' + a.id), onkeydown: (e) => { if (e.key === 'Enter') go('/apps/' + a.id); } },
    h('div', { class: 'tile-top' }, h('span', { class: 'name' }, a.name), statusEl(a.status)),
    h('div', { class: 'meta' },
      a.type ? h('span', { class: 'badge accent' }, a.type) : null,
      h('span', null, `port ${a.port}`),
      a.status === 'running' ? h('span', null, usageText(a.usage)) : null),
    a.lastDeploy ? h('div', { class: 'commit' }, a.lastDeploy.ok ? (a.lastDeploy.commit || 'Deployed') : `Deploy failed: ${a.lastDeploy.error}`, ' · ', ago(a.lastDeploy.at)) : null,
    h('div', { class: 'links' },
      a.status === 'running' ? h('a', { href: lanUrl(a.port), target: '_blank', rel: 'noopener', onclick: stop }, `${location.hostname}:${a.port} ↗`) : null,
      a.public && a.public.url ? h('a', { href: a.public.url, target: '_blank', rel: 'noopener', onclick: stop }, 'Public URL ↗') : null));
}

function dbTile(d) {
  return h('div', { class: 'card tile', role: 'link', tabindex: 0, onclick: () => go('/databases/' + d.id), onkeydown: (e) => { if (e.key === 'Enter') go('/databases/' + d.id); } },
    h('div', { class: 'tile-top' }, h('span', { class: 'name' }, d.name), statusEl(d.error && d.status !== 'running' ? 'failed' : d.status)),
    h('div', { class: 'meta' },
      h('span', { class: 'badge accent' }, d.typeLabel),
      h('span', null, `port ${d.port}`),
      d.lan ? h('span', null, 'Wi-Fi access on') : null,
      d.status === 'running' ? h('span', null, usageText(d.usage)) : null),
    d.error ? h('div', { class: 'commit' }, d.error) : null);
}

async function Dashboard(v) {
  const root = h('div');
  const draw = (d) => {
    const s = d.stats;
    document.getElementById('device-name').textContent = s.device.name;
    fill(root, 
      d.initialPassword ? h('div', { class: 'banner' }, "You're still using the password generated at install.", h('a', { class: 'btn small', href: '#/settings' }, 'Change password')) : null,
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', null, s.device.name),
        h('div', { class: 'sub' }, [s.device.android ? `Android ${s.device.android}` : null, s.device.rom, s.device.arch, `Node ${s.device.node}`].filter(Boolean).join(' · ')))),
      h('div', { class: 'grid stats' }, statCards(s)),
      h('div', { class: 'section-head' },
        h('h2', null, 'Applications', h('span', { class: 'count' }, d.apps.length || '')),
        h('a', { class: 'btn primary small', href: '#/apps/new' }, '+ New app')),
      d.apps.length
        ? h('div', { class: 'grid tiles' }, d.apps.map(appTile))
        : h('div', { class: 'empty' }, h('p', null, 'No apps yet. Deploy one from a Git repository and PocketHost will build and run it.'), h('a', { class: 'btn primary', href: '#/apps/new' }, 'Deploy your first app')),
      h('div', { class: 'section-head' },
        h('h2', null, 'Databases', h('span', { class: 'count' }, d.databases.length || '')),
        h('a', { class: 'btn small', href: '#/databases/new' }, '+ New database')),
      d.databases.length
        ? h('div', { class: 'grid tiles' }, d.databases.map(dbTile))
        : h('div', { class: 'empty' }, h('p', null, 'PostgreSQL, MariaDB and Redis, one click each.'), h('a', { class: 'btn', href: '#/databases/new' }, 'Create a database')));
  };
  draw(await api('GET', '/overview'));
  v.render(root);
  every(3000, async () => { try { const d = await api('GET', '/overview'); if (v.alive()) draw(d); } catch {} });
}

// ---------- new app ----------
function NewApp(v) {
  let source = 'git';
  const name = h('input', { type: 'text', placeholder: 'my-app', maxlength: 60 });
  const repo = h('input', { type: 'text', placeholder: 'https://github.com/you/your-app', autocomplete: 'off', spellcheck: 'false' });
  const branch = h('input', { type: 'text', placeholder: 'Default branch' });
  const subdir = h('input', { type: 'text', placeholder: 'Leave empty for the repo root' });
  const install = h('input', { type: 'text', placeholder: 'Auto-detected', spellcheck: 'false' });
  const build = h('input', { type: 'text', placeholder: 'Auto-detected', spellcheck: 'false' });
  const start = h('input', { type: 'text', placeholder: 'Auto-detected', spellcheck: 'false' });
  const port = h('input', { type: 'number', placeholder: 'Pick automatically', min: 1024, max: 65535 });
  const env = h('textarea', { placeholder: 'DATABASE_URL=postgresql://…\nSECRET_KEY=…', spellcheck: 'false' });
  const auto = h('input', { type: 'checkbox', checked: true });
  repo.addEventListener('input', () => {
    const m = repo.value.trim().match(/([^/:]+?)(\.git)?\/?$/);
    if (m && !name.dataset.touched) name.value = m[1];
  });
  name.addEventListener('input', () => { name.dataset.touched = '1'; });

  const gitFields = h('div', null,
    field('Repository URL', repo, 'Public repos work as-is. For a private repo use https://<token>@github.com/you/app.git'),
    h('div', { class: 'row' }, field('Branch', branch), field('Folder', subdir, 'For monorepos')));
  const startField = field('Start command', start, 'Your app must listen on the PORT environment variable.');
  const cmdNote = h('p', { class: 'muted' }, 'Run any program that keeps running, like a bot or a binary you copied to the phone. It runs from its own folder.');
  const advanced = h('details', { class: 'advanced' }, h('summary', null, 'Advanced: commands and port'),
    h('div', { class: 'row' }, field('Install command', install), field('Build command', build)),
    startField, field('Port', port));
  const commandFields = h('div', { hidden: true }, cmdNote);
  const autoField = h('label', { class: 'check' }, auto, h('span', null, 'Redeploy automatically when I push', h('small', null, 'Checks the repository for new commits every 2 minutes. Works behind any router.')));

  const seg = h('div', { class: 'segmented' });
  const setSource = (s) => {
    source = s;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === s));
    gitFields.hidden = s !== 'git';
    commandFields.hidden = s !== 'command';
    autoField.hidden = s !== 'git';
    if (s === 'command') { commandFields.append(startField); start.placeholder = 'node bot.js'; }
    else { advanced.append(startField); start.placeholder = 'Auto-detected'; }
  };
  seg.append(
    h('button', { type: 'button', 'data-s': 'git', class: 'on', onclick: () => setSource('git') }, 'Git repository'),
    h('button', { type: 'button', 'data-s': 'command', onclick: () => setSource('command') }, 'Command'));

  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create and deploy');
  const err = h('div', { class: 'error-text' });
  const form = h('form', {
    onsubmit: busy(btn, async () => {
      err.textContent = '';
      try {
        const body = { source, name: name.value, env: env.value, install: install.value, build: build.value, start: start.value, autoDeploy: auto.checked };
        if (source === 'git') Object.assign(body, { repo: repo.value, branch: branch.value, subdir: subdir.value });
        if (port.value) body.port = Number(port.value);
        const a = await api('POST', '/apps', body);
        toast('App created. Deploying…', 'ok');
        go('/apps/' + a.id + '/logs');
      } catch (e) { err.textContent = e.message; throw e; }
    }),
  },
  seg, gitFields, commandFields, field('Name', name), advanced,
  field('Environment variables', env, 'One KEY=value per line. PORT is set for you.'),
  autoField,
  h('div', { class: 'form-actions' }, btn, h('a', { class: 'btn ghost', href: '#/' }, 'Cancel')), err);

  v.render(h('div', null,
    h('a', { class: 'back', href: '#/' }, '← Dashboard'),
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'New app'),
      h('div', { class: 'sub' }, 'Node, Python, Go, Rust, PHP and static sites are detected automatically.'))),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, form),
      h('div', { class: 'card' }, h('h3', null, 'How it works'),
        h('ol', { class: 'steps' },
          h('li', null, h('strong', null, 'Clone. '), 'PocketHost pulls your repository onto the phone.'),
          h('li', null, h('strong', null, 'Detect. '), 'It looks for package.json, requirements.txt, go.mod, Cargo.toml, composer.json, a Procfile or index.html, and installs the runtime if it is missing.'),
          h('li', null, h('strong', null, 'Build and run. '), 'Dependencies are installed, the build runs, and your app starts with ', h('code', null, 'PORT'), ' set. It is restarted if it crashes.'),
          h('li', null, h('strong', null, 'Share. '), 'Open it on your Wi-Fi straight away, or turn on a free public URL from the app page.')),
        h('p', { class: 'faint', style: 'margin-top:12px' }, 'Want to try it? Use ', h('code', null, 'https://github.com/heroku/node-js-getting-started')),
        h('p', { class: 'faint' }, "Docker images can't run on Android without root, so apps run directly on the phone instead.")))));
  setTimeout(() => repo.focus(), 50);
}

// ---------- logs panel ----------
function logPanel(key, { onStatus } = {}) {
  const term = h('div', { class: 'terminal' }, h('div', { class: 'placeholder' }, 'Connecting…'));
  const live = h('span', { class: 'live off' }, 'Connecting');
  let follow = true;
  term.addEventListener('scroll', () => { follow = term.scrollHeight - term.scrollTop - term.clientHeight < 40; });
  const add = (l) => {
    const first = term.firstChild;
    if (first && first.classList && first.classList.contains('placeholder')) term.replaceChildren();
    term.append(h('div', { class: 'ln ' + (l.s || 'out') }, h('time', null, clock(l.t)), l.m));
    while (term.childNodes.length > 2000) term.firstChild.remove();
    if (follow) term.scrollTop = term.scrollHeight;
  };
  const es = new EventSource('/api/logs/' + encodeURIComponent(key));
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
  const action = (label, path, cls, done) => {
    const b = h('button', { class: 'btn small ' + (cls || '') }, label);
    b.addEventListener('click', busy(b, async () => { await api('POST', `/apps/${id}/${path}`); toast(done, 'ok'); refresh(); }));
    return b;
  };
  const drawHead = () => {
    const running = a.status === 'running';
    fill(head, 
      h('a', { class: 'back', href: '#/' }, '← Dashboard'),
      h('div', { class: 'page-head' },
        h('div', null,
          h('h1', null, a.name),
          h('div', { class: 'sub' },
            statusEl(a.status),
            a.type ? h('span', { class: 'badge accent' }, a.type) : null,
            h('span', null, `port ${a.port}`),
            running && a.usage ? h('span', null, usageText(a.usage)) : null,
            running && a.startedAt ? h('span', null, `up ${duration((Date.now() - a.startedAt) / 1000)}`) : null,
            a.restarts ? h('span', null, `${a.restarts} restarts`) : null)),
        h('div', { class: 'actions' },
          running ? h('a', { class: 'btn small', href: lanUrl(a.port), target: '_blank', rel: 'noopener' }, 'Open ↗') : null,
          action(a.source === 'git' ? 'Redeploy' : 'Apply & restart', 'deploy', 'primary', 'Deploy started'),
          running || a.status === 'crashed' ? action('Restart', 'restart', '', 'Restarted') : null,
          running || a.status === 'crashed' || a.status === 'deploying'
            ? action('Stop', 'stop', '', 'Stopped')
            : action('Start', 'start', '', 'Starting'))),
      a.lastDeploy && !a.lastDeploy.ok && a.status !== 'deploying'
        ? h('div', { class: 'banner' }, `Last deploy failed: ${a.lastDeploy.error}`) : null,
      h('div', { class: 'tabs' }, [['logs', 'Logs'], ['env', 'Environment'], ['public', 'Public URL'], ['settings', 'Settings']]
        .map(([k, label]) => h('a', { href: `#/apps/${id}/${k}`, class: tab === k ? 'on' : '' }, label))));
  };
  const refresh = async () => { try { const x = await api('GET', '/apps/' + id); if (v.alive()) { a = x; drawHead(); } } catch {} };
  drawHead();

  let body;
  if (tab === 'env') body = appEnvTab(a);
  else if (tab === 'public') body = appPublicTab(a, refresh);
  else if (tab === 'settings') body = appSettingsTab(a);
  else body = h('div', null, deployInfo(a), logPanel(id, { onStatus: refresh }));

  v.render(h('div', null, head, body));
  every(3000, refresh);
}

function deployInfo(a) {
  if (!a.lastDeploy) return null;
  const d = a.lastDeploy;
  return h('div', { class: 'term-bar', style: 'margin-bottom:4px' },
    h('span', null, d.ok ? '✓' : '✗', ' ', d.sha ? h('code', null, d.sha.slice(0, 7)) : null, ' ', d.commit || (d.ok ? 'Deployed' : 'Failed')),
    h('span', { class: 'faint' }, `· ${ago(d.at)} · ${d.seconds}s · ${d.reason}`));
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
            ? h('div', { class: 'field' }, copyField(pub.url), h('div', { class: 'help' }, h('a', { href: pub.url, target: '_blank', rel: 'noopener' }, 'Open ↗'), ' · The address changes if the tunnel restarts. Use your own domain (Settings) for a permanent one.'))
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
      h('p', null, 'PocketHost already checks for new commits every 2 minutes. For instant deploys, add this webhook in GitHub, GitLab or Gitea. It only works if this dashboard is reachable from the internet, for example through your own domain.'),
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
  const auto = h('input', { type: 'checkbox', checked: a.autoDeploy });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const del = h('button', { class: 'btn danger', type: 'button' }, 'Delete app');
  del.addEventListener('click', busy(del, async () => {
    if (!confirm(`Delete "${a.name}"? Its files and logs on the phone are removed. This can't be undone.`)) return;
    await api('DELETE', '/apps/' + a.id);
    toast('App deleted', 'ok');
    go('/');
  }));
  const form = h('form', {
    class: 'card',
    onsubmit: busy(btn, async () => {
      const body = { name: name.value, install: install.value, build: build.value, start: start.value, port: Number(port.value), autoDeploy: auto.checked };
      if (a.source === 'git') Object.assign(body, { repo: repo.value, branch: branch.value, subdir: subdir.value });
      await api('PATCH', '/apps/' + a.id, body);
      toast('Saved. Changes are applied automatically.', 'ok');
    }),
  },
  field('Name', name),
  a.source === 'git' ? [field('Repository URL', repo), h('div', { class: 'row' }, field('Branch', branch), field('Folder', subdir))] : null,
  h('div', { class: 'row' }, field('Install command', install), field('Build command', build)),
  field('Start command', start),
  field('Port', port, 'Your app reads this from the PORT environment variable.'),
  a.source === 'git' ? h('label', { class: 'check' }, auto, h('span', null, 'Redeploy automatically when I push', h('small', null, 'Checks for new commits every 2 minutes.'))) : null,
  btn);
  return h('div', { class: 'grid two' }, form,
    h('div', null,
      h('div', { class: 'card' }, h('h3', null, 'Details'),
        h('dl', { class: 'kv' },
          h('dt', null, 'App ID'), h('dd', null, h('code', null, a.id)),
          h('dt', null, 'Detected'), h('dd', null, a.type || '—'),
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
  }, h('strong', null, t.label), h('small', null, t.note))));
  draw();
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create database');
  const err = h('div', { class: 'error-text' });
  v.render(h('div', null,
    h('a', { class: 'back', href: '#/' }, '← Dashboard'),
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

async function DbPage(v, id) {
  let d = await api('GET', '/databases/' + id);
  const head = h('div');
  const conn = h('div');
  const action = (label, path, done) => {
    const b = h('button', { class: 'btn small' }, label);
    b.addEventListener('click', busy(b, async () => { await api('POST', `/databases/${id}/${path}`); toast(done, 'ok'); refresh(); }));
    return b;
  };
  const del = h('button', { class: 'btn small danger' }, 'Delete');
  del.addEventListener('click', busy(del, async () => {
    if (!confirm(`Delete "${d.name}" and all its data? This can't be undone.`)) return;
    await api('DELETE', '/databases/' + id);
    toast('Database deleted', 'ok');
    go('/');
  }));
  const drawHead = () => {
    const running = d.status === 'running';
    fill(head, 
      h('a', { class: 'back', href: '#/' }, '← Dashboard'),
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, d.name), h('div', { class: 'sub' }, statusEl(d.error && !running ? 'failed' : d.status), h('span', { class: 'badge accent' }, d.typeLabel), h('span', null, `port ${d.port}`))),
        h('div', { class: 'actions' },
          running ? action('Restart', 'restart', 'Restarting') : null,
          running || d.status === 'starting' || d.status === 'crashed' ? action('Stop', 'stop', 'Stopped') : action('Start', 'start', 'Starting'),
          del)),
      d.error && !running ? h('div', { class: 'banner' }, d.error) : null);
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
        d.urls.lan ? h('div', { style: 'margin-top:14px' }, h('p', null, 'From other devices on your Wi-Fi:'), copyField(d.urls.lan, { secret: true })) : null),
      h('div', { class: 'card' }, h('h3', null, 'Details'),
        h('dl', { class: 'kv' },
          h('dt', null, 'Host'), h('dd', null, h('code', null, '127.0.0.1')),
          h('dt', null, 'Port'), h('dd', null, h('code', null, d.port)),
          d.type !== 'redis' ? [h('dt', null, 'Database'), h('dd', null, h('code', null, d.dbName)), h('dt', null, 'User'), h('dd', null, h('code', null, user))] : null,
          h('dt', null, 'Password'), h('dd', null, copyField(d.password, { secret: true }))),
        h('label', { class: 'check', style: 'margin:14px 0 0' }, lanToggle, h('span', null, 'Allow connections from other devices on my Wi-Fi', h('small', null, 'Restarts the database.'))))));
  };
  const refresh = async () => { try { const x = await api('GET', '/databases/' + id); if (v.alive()) { d = x; drawHead(); drawConn(); } } catch {} };
  drawHead();
  drawConn();
  v.render(h('div', null, head, conn, h('div', { class: 'section-head' }, h('h2', null, 'Logs')), logPanel(id, { onStatus: refresh })));
  every(4000, refresh);
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
      await api('POST', '/settings/password', { current: cur.value, password: pw.value });
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
    h('p', { class: 'faint' }, 'Run ', h('code', null, 'pockethost doctor'), ' in Termux to check your setup.'));

  const about = h('div', { class: 'card' }, h('h3', null, 'About'),
    h('dl', { class: 'kv' },
      h('dt', null, 'Version'), h('dd', null, s.version),
      h('dt', null, 'Device'), h('dd', null, s.device.name),
      h('dt', null, 'Android'), h('dd', null, s.device.android || '—'),
      h('dt', null, 'Architecture'), h('dd', null, s.device.arch),
      h('dt', null, 'Node.js'), h('dd', null, s.device.node),
      h('dt', null, 'Dashboard port'), h('dd', null, s.port),
      h('dt', null, 'Data folder'), h('dd', null, h('code', null, s.dataDir))),
    h('p', { class: 'faint', style: 'margin-top:12px' }, 'Update with ', h('code', null, 'pockethost update'), '.'));

  v.render(h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'))),
    h('div', { class: 'grid two' }, h('div', null, pwForm, cfForm), h('div', null, phone, about))));
}

// ---------- boot ----------
window.addEventListener('hashchange', () => { if (shellShown) router(); });
(async () => {
  try {
    const me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json());
    if (!me.loggedIn) { showLogin(); return; }
    showShell();
    router();
  } catch {
    document.getElementById('app').replaceChildren(h('div', { class: 'boot' }, "Can't reach PocketHost. Is it running?"));
  }
})();
