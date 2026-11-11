'use strict';
// Works out how to install, build and start an app from the files in its folder
// (a small, Docker-free take on buildpacks / Nixpacks).
const fs = require('fs');
const path = require('path');

const has = (dir, f) => fs.existsSync(path.join(dir, f));
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
const readJSON = (dir, f) => { try { return JSON.parse(read(dir, f)); } catch { return null; } };

const FRONTEND_TOOLS = ['vite', 'react-scripts', '@angular/cli', 'parcel', '@vue/cli-service', 'webpack-cli', '@sveltejs/vite-plugin-svelte', 'astro', '@11ty/eleventy', 'gatsby'];
// A start script that only runs a development server or file watcher. On a server we build once and
// serve the result instead: dev servers ignore $PORT, try to open a browser and use lots of memory.
const DEV_START = /\b(dev|watch|serve)\b|--open\b|--watch\b|\b(vite|nodemon|ng serve|astro dev|webpack serve|webpack-dev-server|parcel(?! build)|gatsby develop|react-scripts start)\b/;

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

  // Follow `npm run x` chains, so "start": "npm run dev" is seen as the dev script it runs.
  const resolve = (s, depth = 0) => {
    const m = depth < 5 && /^(?:npm|pnpm|yarn)(?: run)? ([\w:-]+)$/.exec((s || '').trim());
    return m && scripts[m[1]] ? resolve(scripts[m[1]], depth + 1) : s;
  };
  const startCmd = resolve(scripts.start);
  const bin = `PATH="$PWD/node_modules/.bin:$PATH"`;
  const frontend = FRONTEND_TOOLS.some((t) => deps[t]) || ['index.html', 'src/index.html', 'public/index.html'].some((f) => has(dir, f));
  if (scripts.start && scripts.build && /\bnext dev\b/.test(startCmd)) {
    plan.start = `${bin} next start`; // Next.js reads $PORT
  } else if (scripts.start && scripts.build && /\bnuxt dev\b/.test(startCmd)) {
    plan.start = 'node .output/server/index.mjs';
  } else if (scripts.start && scripts.build && DEV_START.test(startCmd) && frontend) {
    plan.type = 'static';
    plan.staticDir = 'auto';
  } else if (scripts.start && !scripts.prestart && !scripts.poststart) {
    // Run the start script directly. Keeping npm/yarn alive as a wrapper costs ~60 MB per app.
    plan.start = `${bin} ${scripts.start}`;
  } else if (scripts.start) plan.start = pm === 'npm' ? 'npm start' : `${pm} start`;
  else if (scripts.build && (frontend || !['server.js', 'index.js', 'app.js', 'main.js'].some((f) => has(dir, f)))) {
    plan.type = 'static';
    plan.staticDir = 'auto'; // dist/, build/ or out/ — resolved after the build
  } else {
    const main = pkg.main || ['server.js', 'index.js', 'app.js', 'main.js'].find((f) => has(dir, f)) || 'index.js';
    plan.start = `node ${JSON.stringify(main)}`;
  }
  return plan;
}

const PY_SERVERS = ['uvicorn', 'gunicorn', 'hypercorn', 'daphne', 'flask', 'streamlit', 'waitress-serve'];
const PYDEPS = path.join(__dirname, 'pydeps.py');

/** Makes a server command listen on $PORT on all interfaces, whatever port it was written for. */
function onPort(cmd) {
  const tool = cmd.split(/\s+/)[0].replace(/^.*\//, '');
  let c = cmd
    .replace(/(--host[= ])(127\.0\.0\.1|localhost)\b/g, '$10.0.0.0')
    .replace(/(--bind[= ]|\s-b ?)(?:[\w.\[\]:]*:)?\d+\b/g, '$10.0.0.0:$$PORT')
    .replace(/(--port[= ]|--server\.port[= ])\d+\b/g, '$1$$PORT')
    .replace(/\brunserver(?:\s+(?:[\w.]+:)?\d+)?/, 'runserver 0.0.0.0:$$PORT');
  if (tool === 'flask' || tool === 'uvicorn' || tool === 'hypercorn') c = c.replace(/(\s-p ?)\d+\b/, '$1$$PORT');
  if (/^(uvicorn|daphne)$/.test(tool) && !/\$PORT/.test(c)) c += ` --port $PORT${/--host|-b\b/.test(c) ? '' : ' --host 0.0.0.0'}`;
  if (/^(gunicorn|hypercorn)$/.test(tool) && !/\$PORT/.test(c)) c += ' --bind 0.0.0.0:$PORT';
  if (tool === 'flask' && !/\$PORT/.test(c)) c += ' --port $PORT';
  if (tool === 'flask' && !/--host|\s-h\b/.test(c)) c += ' --host 0.0.0.0';
  if (tool === 'streamlit' && !/\$PORT/.test(c)) c += ' --server.port $PORT';
  if (tool === 'streamlit' && !/--server\.address/.test(c)) c += ' --server.address 0.0.0.0';
  return c;
}

/** The start command a project's Docker setup uses: docker-compose `command:` or the Dockerfile's CMD. */
function dockerStart(dir, accept) {
  const found = [];
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    for (const m of read(dir, f).matchAll(/^\s+command:\s*(.+)$/gm)) found.push(m[1]);
  }
  const cmds = [...read(dir, 'Dockerfile').matchAll(/^CMD\s+(.+)$/gim)];
  if (cmds.length) found.push(cmds[cmds.length - 1][1]);
  for (let raw of found) {
    raw = raw.trim();
    let cmd = raw;
    if (raw.startsWith('[')) {
      try { cmd = JSON.parse(raw).map((w) => (/^[\w./:=@,+-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' '); } catch { continue; }
    } else if (/^(['"]).*\1$/.test(raw)) cmd = raw.slice(1, -1);
    cmd = cmd.replace(/^python3(\s)/, 'python$1').replace(/^python -m (uvicorn|gunicorn|flask|streamlit)\b/, '$1');
    if (accept(cmd.split(/\s+/)[0])) return onPort(cmd);
  }
  return null;
}

function python(dir) {
  const reqs = read(dir, 'requirements.txt').toLowerCase() + read(dir, 'pyproject.toml').toLowerCase();
  let install = 'python -m venv .venv && .venv/bin/pip install --upgrade pip && ';
  if (has(dir, 'requirements.txt')) install += '.venv/bin/pip install -r requirements.txt';
  // Some projects can't be installed as a package (no build setup, several top-level folders).
  // Then install just the dependencies listed in pyproject.toml.
  else {
    const py = `.venv/bin/python ${JSON.stringify(PYDEPS)}`;
    const deps = `(.venv/bin/pip install . || (${py} > .pocketserver-reqs.txt && .venv/bin/pip install -r .pocketserver-reqs.txt))`;
    if (has(dir, 'poetry.lock') || has(dir, 'uv.lock')) {
      // Use the versions the project was tested with, like its Docker build would. Old versions can fail
      // to build on the phone's newer Python, so fall back to the newest ones.
      install += `${py} --lock > .pocketserver-lock.txt && (.venv/bin/pip install -c .pocketserver-lock.txt . `
        + `|| (echo "The locked versions didn't install on this phone. Trying the newest versions instead." && ${deps}))`;
    } else install += deps;
  }
  const plan = { type: 'python', needs: ['python'], pathPrefix: '.venv/bin', install };
  const finish = (start) => {
    plan.start = start;
    // The server program itself is often left out of requirements (Docker images install it separately).
    const tool = start.split(/\s+/)[0];
    if (PY_SERVERS.includes(tool) && tool !== 'flask' && !reqs.includes(tool.replace('-serve', ''))) plan.install += ` && .venv/bin/pip install ${tool.replace('-serve', '')}`;
    return plan;
  };

  const projectWsgi = fs.readdirSync(dir).find((d) => has(path.join(dir, d), 'wsgi.py') && has(dir, 'manage.py'));
  if (has(dir, 'manage.py')) {
    plan.build = 'python manage.py collectstatic --noinput || true';
    return finish(reqs.includes('gunicorn') && projectWsgi
      ? `python manage.py migrate --noinput && gunicorn ${projectWsgi}.wsgi --bind 0.0.0.0:$PORT`
      : 'python manage.py migrate --noinput && python manage.py runserver 0.0.0.0:$PORT --noreload');
  }

  // main.py / app.py at the top, or in a usual subfolder (app/main.py → module app.main).
  let entry = null;
  for (const sub of ['', 'app', 'src', 'src/app', 'api', 'backend']) {
    const f = ['main.py', 'app.py', 'server.py', 'wsgi.py', 'asgi.py'].find((n) => has(dir, path.join(sub, n)));
    if (f) { entry = path.join(sub, f); break; }
  }
  if (!entry) {
    const fromDocker = dockerStart(dir, (w) => PY_SERVERS.includes(w) || w === 'python');
    if (fromDocker) return finish(fromDocker);
  }
  const mod = entry ? entry.replace(/\.py$/, '').split(path.sep).join('.') : 'main';
  const src = entry ? read(dir, entry) : '';
  const obj = (src.match(/^(\w+)\s*(?::\s*\w+\s*)?=\s*(?:FastAPI|Flask|Starlette|Quart)\(/m) || [])[1] || 'app';
  if (/FastAPI\s*\(|Starlette\s*\(/.test(src) || (reqs.includes('fastapi') && !reqs.includes('flask'))) {
    return finish(`uvicorn ${mod}:${obj} --host 0.0.0.0 --port $PORT`);
  }
  if (/Flask\s*\(/.test(src) || reqs.includes('flask')) {
    return finish(reqs.includes('gunicorn') ? `gunicorn ${mod}:${obj} --bind 0.0.0.0:$PORT` : `flask --app ${mod} run --host 0.0.0.0 --port $PORT`);
  }
  if (reqs.includes('streamlit') && entry) return finish(`streamlit run ${entry} --server.port $PORT --server.address 0.0.0.0 --server.headless true`);
  return finish(`python ${entry || 'main.py'}`);
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
  else if (has(dir, 'go.mod')) plan = { type: 'go', needs: ['go'], build: 'go build -o .pocketserver-bin .', start: './.pocketserver-bin' };
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

module.exports = { detect, resolveStaticDir, _test: { onPort, dockerStart } };
