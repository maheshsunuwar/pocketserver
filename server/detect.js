'use strict';
// Works out how to install, build and start an app from the files in its folder
// (a small, Docker-free take on buildpacks / Nixpacks).
const fs = require('fs');
const path = require('path');

const has = (dir, f) => fs.existsSync(path.join(dir, f));
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
const readJSON = (dir, f) => { try { return JSON.parse(read(dir, f)); } catch { return null; } };

const FRONTEND_TOOLS = ['vite', 'react-scripts', '@angular/cli', 'parcel', '@vue/cli-service', 'webpack-cli', '@sveltejs/vite-plugin-svelte'];

function procfileWeb(dir) {
  const m = read(dir, 'Procfile').match(/^web:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function node(dir) {
  const pkg = readJSON(dir, 'package.json') || {};
  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  let pm = 'npm';
  if (has(dir, 'pnpm-lock.yaml')) pm = 'pnpm';
  else if (has(dir, 'yarn.lock')) pm = 'yarn';
  // bun doesn't run on Android, so bun projects fall back to npm.

  const install = {
    npm: (has(dir, 'package-lock.json') || has(dir, 'npm-shrinkwrap.json')) ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund',
    pnpm: 'pnpm install --frozen-lockfile',
    yarn: 'yarn install --frozen-lockfile',
  }[pm];
  const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} run ${s}`);
  const plan = { type: 'node', needs: ['node', pm], install, build: scripts.build ? run('build') : null };

  if (scripts.start) plan.start = pm === 'npm' ? 'npm start' : `${pm} start`;
  else if (scripts.build && FRONTEND_TOOLS.some((t) => deps[t])) {
    plan.type = 'static';
    plan.staticDir = 'auto'; // dist/, build/ or out/ — resolved after the build
  } else {
    const main = pkg.main || ['server.js', 'index.js', 'app.js', 'main.js'].find((f) => has(dir, f)) || 'index.js';
    plan.start = `node ${JSON.stringify(main)}`;
  }
  return plan;
}

function python(dir) {
  const reqs = read(dir, 'requirements.txt').toLowerCase() + read(dir, 'pyproject.toml').toLowerCase();
  const plan = {
    type: 'python',
    needs: ['python'],
    pathPrefix: '.venv/bin',
    install: 'python -m venv .venv && .venv/bin/pip install --upgrade pip && '
      + (has(dir, 'requirements.txt') ? '.venv/bin/pip install -r requirements.txt' : '.venv/bin/pip install .'),
  };
  const projectWsgi = fs.readdirSync(dir).find((d) => has(path.join(dir, d), 'wsgi.py') && has(dir, 'manage.py'));
  if (has(dir, 'manage.py')) {
    plan.build = 'python manage.py collectstatic --noinput || true';
    plan.start = reqs.includes('gunicorn') && projectWsgi
      ? `python manage.py migrate --noinput && gunicorn ${projectWsgi}.wsgi --bind 0.0.0.0:$PORT`
      : 'python manage.py migrate --noinput && python manage.py runserver 0.0.0.0:$PORT --noreload';
    return plan;
  }
  const entry = ['main.py', 'app.py', 'server.py', 'wsgi.py'].find((f) => has(dir, f));
  const mod = entry ? entry.replace(/\.py$/, '') : 'main';
  const src = entry ? read(dir, entry) : '';
  if (/FastAPI\s*\(/.test(src) || (reqs.includes('fastapi') && !reqs.includes('flask'))) {
    plan.start = `uvicorn ${mod}:app --host 0.0.0.0 --port $PORT`;
  } else if (/Flask\s*\(/.test(src) || reqs.includes('flask')) {
    plan.start = reqs.includes('gunicorn') ? `gunicorn ${mod}:app --bind 0.0.0.0:$PORT` : `flask --app ${mod} run --host 0.0.0.0 --port $PORT`;
  } else {
    plan.start = `python ${entry || 'main.py'}`;
  }
  return plan;
}

function rust(dir) {
  const name = (read(dir, 'Cargo.toml').match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/) || [])[1] || 'app';
  return { type: 'rust', needs: ['cargo'], build: 'cargo build --release', start: `./target/release/${name}` };
}

function php(dir) {
  const plan = { type: 'php', needs: ['php'] };
  if (has(dir, 'composer.json')) { plan.needs.push('composer'); plan.install = 'composer install --no-dev --optimize-autoloader --no-interaction'; }
  const root = has(dir, 'public/index.php') || has(dir, 'public/index.html') ? 'public' : '.';
  plan.start = `php -S 0.0.0.0:$PORT -t ${root}`;
  return plan;
}

/** Returns { type, needs[], install?, build?, start?, staticDir?, pathPrefix?, error? } */
function detect(dir) {
  let plan;
  if (has(dir, 'package.json')) plan = node(dir);
  else if (has(dir, 'requirements.txt') || has(dir, 'pyproject.toml')) plan = python(dir);
  else if (has(dir, 'go.mod')) plan = { type: 'go', needs: ['go'], build: 'go build -o .pockethost-bin .', start: './.pockethost-bin' };
  else if (has(dir, 'Cargo.toml')) plan = rust(dir);
  else if (has(dir, 'composer.json') || has(dir, 'index.php') || has(dir, 'public/index.php')) plan = php(dir);
  else if (has(dir, 'index.html')) plan = { type: 'static', needs: [], staticDir: '.' };
  else if (has(dir, 'Dockerfile')) plan = { type: 'unknown', needs: [], error: "Only a Dockerfile was found. Docker can't run on Android without root, so set the install, build and start commands under Advanced." };
  else plan = { type: 'unknown', needs: [], error: "Couldn't tell what kind of app this is. Set a start command under Advanced." };

  const web = procfileWeb(dir);
  if (web) { plan.start = web; delete plan.staticDir; delete plan.error; if (plan.type === 'static') plan.type = 'procfile'; }
  return plan;
}

/** Where a frontend build put its files. */
function resolveStaticDir(dir, staticDir) {
  if (staticDir && staticDir !== 'auto') return path.resolve(dir, staticDir);
  for (const d of ['dist', 'build', 'out', 'public']) if (has(dir, path.join(d, 'index.html'))) return path.join(dir, d);
  return null;
}

module.exports = { detect, resolveStaticDir };
