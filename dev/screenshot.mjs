// Take screenshots of dashboard pages with a headless Chrome-family browser. No npm packages.
//   node dev/screenshot.mjs --base http://127.0.0.1:7799 --password XXX --out shots --width 390 apps databases '#/settings'
// Each page is a hash route (without '#/'). Add '!!<js>' to run JavaScript on the page before the shot,
// e.g. 'apps/new!!document.querySelector("button").click()'.
// Uses PH_BROWSER if set, otherwise the first Chrome/Chromium/Brave/Edge it finds.
// JavaScript errors on the page are printed, so this also works as a quick smoke test.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args.splice(i, 2)[1]; };
const base = opt('base', 'http://127.0.0.1:7799').replace(/\/$/, '');
const out = path.resolve(opt('out', 'shots'));
const width = Number(opt('width', '1280'));
let password = opt('password', process.env.PH_PASSWORD);
if (!password) try { password = fs.readFileSync(new URL('../.dev-data/initial-password', import.meta.url), 'utf8').trim(); } catch {}
const pages = args.length ? args : [''];

const candidates = [
  process.env.PH_BROWSER,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser',
].filter(Boolean);
const browserPath = candidates.find((p) => fs.existsSync(p));
if (!browserPath) { console.error('No Chrome-family browser found. Set PH_BROWSER to its path.'); process.exit(1); }

fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-shot-'));
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(browserPath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { browser.kill(); fs.rmSync(profile, { recursive: true, force: true }); process.exit(code); };

let targets;
for (let i = 0; i < 40 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
if (!targets) { console.error('The browser did not start.'); done(1); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));

let id = 0; let errors = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') { errors++; console.log('JS error:', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { errors++; console.log('console.error:', m.params.args.map((a) => a.value ?? a.description).join(' ')); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, `w${width}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
  console.log('saved', file);
};

await send('Runtime.enable');
const mobile = width < 600;
await send('Emulation.setDeviceMetricsOverride', { width, height: mobile ? 900 : 1000, deviceScaleFactor: mobile ? 2 : 1, mobile });
await send('Page.navigate', { url: base + '/' }); await sleep(1500);
if (password) {
  await shot('login');
  await send('Runtime.evaluate', { awaitPromise: true, expression:
    `fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','x-pockethost':'1'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.status)` });
}
for (const [n, entry] of pages.entries()) {
  const [route, js] = entry.split('!!');
  const hash = route.replace(/^#?\/?/, '');
  await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
  await send('Page.navigate', { url: `${base}/#/${hash}` }); await sleep(2500);
  if (js) {
    const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true });
    if (r.result?.exceptionDetails) { errors++; console.log('Your !! script failed:', r.result.exceptionDetails.exception?.description); }
    await sleep(1500);
  }
  await shot((hash.replace(/\W+/g, '_') || 'home') + (js ? `-${n}` : ''));
}
ws.close();
done(errors ? 1 : 0);
