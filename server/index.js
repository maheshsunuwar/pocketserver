'use strict';
// PocketHost: turn an Android phone into a self-hosting server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { state, save, flush } = require('./store');
const auth = require('./auth');
const S = require('./supervisor');
const apps = require('./apps');
const dbs = require('./databases');
const tunnels = require('./tunnels');
const stats = require('./stats');
const VERSION = require('../package.json').version;

const PORT = Number(process.env.POCKETHOST_PORT || state.settings.port || 7777);
const UI_DIR = path.join(__dirname, '..', 'ui');
const MAX_BODY = 1024 * 1024;

// ---------- tiny router ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: !!opts.raw });
}

function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new U.HttpError(413, 'Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const clientIp = (req) => req.socket.remoteAddress || '';

// ---------- auth ----------
route('POST', '/api/login', async (req, res, p, body) => {
  const ip = clientIp(req);
  auth.checkRate(ip);
  if (!auth.verify(body.password)) {
    auth.recordFailure(ip);
    throw new U.HttpError(401, 'Wrong password.');
  }
  auth.clearFailures(ip);
  send(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(auth.createSession()) });
}, { auth: false });

route('POST', '/api/logout', async (req, res) => {
  auth.logout(req);
  send(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie('', 0) });
});

route('GET', '/api/me', async (req) => ({
  loggedIn: auth.isLoggedIn(req), version: VERSION,
}), { auth: false });

// ---------- overview & stats ----------
function usageFor(appList, dbList) {
  const keys = [...appList.map((a) => a.id), ...dbList.map((d) => d.id)];
  const u = stats.usage(keys);
  for (const x of [...appList, ...dbList]) x.usage = u[x.id] || null;
}
route('GET', '/api/overview', async () => {
  const appList = apps.list();
  const dbList = dbs.list();
  usageFor(appList, dbList);
  return {
    version: VERSION, port: PORT, stats: stats.snapshot(), apps: appList, databases: dbList,
    initialPassword: !!state.settings.initialPassword,
    namedTunnel: { configured: !!state.settings.cloudflareToken, status: S.info('tunnel-main').status },
  };
});
route('GET', '/api/stats', async () => stats.snapshot());

// ---------- apps ----------
route('GET', '/api/apps', async () => apps.list());
route('POST', '/api/apps', async (req, res, p, body) => apps.create(body));
route('GET', '/api/apps/:id', async (req, res, p) => {
  const a = apps.one(p.id);
  a.usage = stats.usage([a.id])[a.id] || null;
  return a;
});
route('PATCH', '/api/apps/:id', async (req, res, p, body) => apps.update(p.id, body));
route('DELETE', '/api/apps/:id', async (req, res, p) => { await apps.remove(p.id); return { ok: true }; });
route('POST', '/api/apps/:id/deploy', async (req, res, p) => { apps.one(p.id); apps.deploy(p.id).catch(() => {}); return { ok: true }; });
route('POST', '/api/apps/:id/start', async (req, res, p) => { apps.one(p.id); apps.start(p.id).catch(() => {}); return { ok: true }; });
route('POST', '/api/apps/:id/stop', async (req, res, p) => { await apps.stop(p.id); return { ok: true }; });
route('POST', '/api/apps/:id/restart', async (req, res, p) => { await apps.restart(p.id); return { ok: true }; });
route('POST', '/api/apps/:id/public', async (req, res, p, body) => apps.setPublic(p.id, !!body.enabled));
route('POST', '/api/hooks/:id', async (req, res, p, raw, query) => apps.webhook(p.id, req, raw, query), { auth: false, raw: true });

// ---------- databases ----------
route('GET', '/api/databases', async () => dbs.list());
route('POST', '/api/databases', async (req, res, p, body) => dbs.create(body));
route('GET', '/api/databases/:id', async (req, res, p) => dbs.one(p.id));
route('PATCH', '/api/databases/:id', async (req, res, p, body) => dbs.update(p.id, body));
route('DELETE', '/api/databases/:id', async (req, res, p) => { await dbs.remove(p.id); return { ok: true }; });
route('POST', '/api/databases/:id/start', async (req, res, p) => { dbs.one(p.id); dbs.start(p.id).catch(() => {}); return { ok: true }; });
route('POST', '/api/databases/:id/stop', async (req, res, p) => { await dbs.stop(p.id); return { ok: true }; });
route('POST', '/api/databases/:id/restart', async (req, res, p) => { dbs.one(p.id); dbs.restart(p.id).catch(() => {}); return { ok: true }; });

// ---------- settings ----------
route('GET', '/api/settings', async () => ({
  port: PORT,
  cloudflareToken: state.settings.cloudflareToken ? '••••' + state.settings.cloudflareToken.slice(-4) : '',
  namedTunnel: S.info('tunnel-main').status,
  initialPassword: !!state.settings.initialPassword,
  version: VERSION,
  device: stats.deviceInfo(),
  dataDir: U.paths.home,
}));
route('POST', '/api/settings/password', async (req, res, p, body) => {
  if (!auth.verify(body.current)) throw new U.HttpError(400, 'Your current password is wrong.');
  auth.setPassword(body.password);
  send(res, 200, { ok: true }, { 'set-cookie': auth.sessionCookie(auth.createSession()) });
});
route('POST', '/api/settings/cloudflare', async (req, res, p, body) => {
  const token = String(body.token || '').trim();
  if (token && !/^[A-Za-z0-9_\-=.]{40,}$/.test(token)) throw U.bad("That doesn't look like a Cloudflare tunnel token.");
  state.settings.cloudflareToken = token || undefined;
  save();
  await tunnels.applyNamedTunnel();
  return { ok: true };
});

// ---------- live logs (Server-Sent Events) ----------
function logKeyAllowed(key) {
  const id = key.replace(/^tunnel-/, '');
  return key === 'tunnel-main' || !!state.apps[id] || !!state.databases[id];
}
function streamLogs(req, res, key) {
  if (!logKeyAllowed(key)) throw new U.HttpError(404, 'No such log.');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`event: history\ndata: ${JSON.stringify(S.history(key).slice(-500))}\n\n`);
  const onLine = (l) => res.write(`data: ${JSON.stringify(l)}\n\n`);
  const onStatus = (k) => { if (k === key || 'tunnel-' + k === key) res.write(`event: status\ndata: ${JSON.stringify(k)}\n\n`); };
  S.bus.on('log:' + key, onLine);
  S.bus.on('status', onStatus);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); S.bus.off('log:' + key, onLine); S.bus.off('status', onStatus); });
}

// ---------- static UI ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function serveUi(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let file = path.join(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(UI_DIR, 'index.html');
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { send(res, 400, { error: 'Bad URL' }); return; }
  const pathname = url.pathname;
  try {
    if (!pathname.startsWith('/api/')) { serveUi(req, res, pathname); return; }

    if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
      if (!auth.isLoggedIn(req)) throw new U.HttpError(401, 'Please log in.');
      streamLogs(req, res, decodeURIComponent(pathname.slice('/api/logs/'.length)));
      return;
    }

    const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
    if (!r) throw new U.HttpError(404, 'Not found.');
    if (r.auth) {
      if (!auth.isLoggedIn(req)) throw new U.HttpError(401, 'Please log in.');
      // Blocks cross-site form posts: browsers can't add this header without CORS, which we never allow.
      if (req.method !== 'GET' && req.headers['x-pockethost'] !== '1') throw new U.HttpError(403, 'Missing request header.');
    }
    const m = pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    let body = raw;
    if (!r.raw) {
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw U.bad('Invalid JSON.'); }
    }
    const result = await r.handler(req, res, params, body, url.searchParams);
    if (!res.headersSent) send(res, 200, result === undefined ? { ok: true } : result);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || 'Something went wrong.' });
    else res.end();
  }
});

function main() {
  auth.ensurePassword();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Is PocketHost already running?`);
      process.exit(98); // tells the watchdog not to keep retrying
    }
    console.error(e.message);
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    // Only clean up leftover app processes once we know we're the only PocketHost.
    // Doing it earlier let a duplicate instance kill the running one's apps.
    S.killStale();
    const ip = (U.localIPs()[0] || {}).address || 'localhost';
    console.log(`PocketHost ${VERSION} running on http://${ip}:${PORT}`);
    apps.restore();
    dbs.restore();
    tunnels.applyNamedTunnel().catch((e) => console.error('Named tunnel:', e.message));
  });
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${sig}, stopping apps…`);
  server.close();
  await S.stopAll();
  flush();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => console.error('Uncaught:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled:', e));

main();
