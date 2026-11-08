// Try dashboard changes against a phone's real data without installing them on the phone.
// Serves ui/ from this checkout and forwards /api to the phone's PocketServer.
//   node dev/preview.mjs http://<phone-ip>:7777      then open http://localhost:7788
// Log in with the phone's dashboard password. Edit ui/ files and reload the page to see changes.
// Server changes (server/*.js) aren't previewed: the API is still the phone's.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const target = new URL(process.argv[2] || process.env.PH_BASE || '');
const port = Number(process.env.PORT || 7788);
const ui = new URL('../ui/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  if (req.url.startsWith('/api')) {
    const p = http.request({ host: target.hostname, port: target.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `Can't reach the phone: ${e.message}` })); });
    req.pipe(p);
    return;
  }
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ui, path.normalize(rel));
  if (!file.startsWith(ui)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Preview: http://localhost:${port}  (API from ${target.origin})`));
