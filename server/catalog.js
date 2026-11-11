'use strict';
// One-click apps. Each recipe becomes a normal PocketServer app (logs, restarts, public URL…).
//  - "native" recipes use Termux packages built for Android: fast and reliable.
//  - "docker" recipes run the official image through udocker: experimental, slower.
// In commands, $PORT, $APP_DATA (the app's private data folder) and $APP_URL are set at runtime.
// In env values, {{password}}, {{secret}}, {{data}} and {{url}} are filled in once at install;
// {{port}} in Docker env/commands is filled in each time the app starts.
const U = require('./util');
const apps = require('./apps');
const dbs = require('./databases');

const giteaLike = (bin, label, user) => ({
  kind: 'native',
  packages: [bin],
  env: { ADMIN_PASSWORD: '{{password}}' },
  credentials: { username: user },
  install: `set -e
CONF="$APP_DATA/custom/conf/app.ini"
if [ ! -f "$CONF" ]; then
  mkdir -p "$APP_DATA/custom/conf" "$APP_DATA/data" "$APP_DATA/log"
  cat > "$CONF" <<EOF
APP_NAME = ${label}
RUN_MODE = prod
WORK_PATH = $APP_DATA
[server]
HTTP_ADDR = 0.0.0.0
HTTP_PORT = $PORT
ROOT_URL = $APP_URL/
DISABLE_SSH = true
OFFLINE_MODE = true
[database]
DB_TYPE = sqlite3
PATH = $APP_DATA/data/${bin}.db
[repository]
ROOT = $APP_DATA/repositories
[log]
ROOT_PATH = $APP_DATA/log
MODE = console
[security]
INSTALL_LOCK = true
[service]
DISABLE_REGISTRATION = true
EOF
fi
${bin} migrate --work-path "$APP_DATA" --config "$CONF"
# Create the admin once. A marker file makes this safe to re-run on redeploy.
if [ ! -f "$APP_DATA/.admin-created" ]; then
  ${bin} admin user create --admin --username ${user} --password "$ADMIN_PASSWORD" --email ${user}@example.com --must-change-password=false --work-path "$APP_DATA" --config "$CONF"
  touch "$APP_DATA/.admin-created"
fi`,
  start: `exec ${bin} web --work-path "$APP_DATA" --config "$APP_DATA/custom/conf/app.ini" --port "$PORT"`,
});

const RECIPES = [
  // ---------- native (Termux packages) ----------
  {
    id: 'syncthing', name: 'Syncthing', icon: '🔄', category: 'Files',
    description: 'Sync folders between your phone, computers and other devices. No cloud.',
    website: 'https://syncthing.net',
    kind: 'native', packages: ['syncthing'],
    // STMONITORED: skip Syncthing's self-restart monitor, which can't re-launch itself on Android.
    env: { ADMIN_PASSWORD: '{{password}}', STNODEFAULTFOLDER: '1', STMONITORED: '1' },
    credentials: { username: 'admin' },
    install: '[ -f "$APP_DATA/config.xml" ] || syncthing generate --home="$APP_DATA" --gui-user=admin --gui-password="$ADMIN_PASSWORD"',
    start: 'exec syncthing serve --no-browser --no-restart --home="$APP_DATA" --gui-address="http://0.0.0.0:$PORT"',
    notes: 'Syncthing also uses ports 22000 and 21027 to talk to your other devices. To sync your phone\'s own files, run termux-setup-storage in Termux and add folders under ~/storage.',
  },
  {
    id: 'navidrome', name: 'Navidrome', icon: '🎵', category: 'Media',
    description: 'Your own music streaming server, compatible with Subsonic apps.',
    website: 'https://www.navidrome.org',
    kind: 'native', packages: ['navidrome'],
    // Creates the admin account on first start, so nobody else on the network can claim it first.
    env: { MUSIC_FOLDER: '{{data}}/music', ND_DEVAUTOCREATEADMINPASSWORD: '{{password}}' },
    credentials: { username: 'admin' },
    install: 'mkdir -p "$MUSIC_FOLDER"',
    start: 'exec navidrome --address 0.0.0.0 --port "$PORT" --datafolder "$APP_DATA" --musicfolder "$MUSIC_FOLDER"',
    notes: 'Put music in the MUSIC_FOLDER shown in Environment, or point it at ~/storage/music after running termux-setup-storage.',
  },
  { id: 'gitea', name: 'Gitea', icon: '🍵', category: 'Developer', description: 'Lightweight GitHub-style Git hosting: repos, issues, pull requests.', website: 'https://about.gitea.com', ...giteaLike('gitea', 'Gitea', 'admin') },
  { id: 'forgejo', name: 'Forgejo', icon: '🔨', category: 'Developer', description: 'Community-run Git hosting (a Gitea fork): repos, issues, pull requests.', website: 'https://forgejo.org', ...giteaLike('forgejo', 'Forgejo', 'owner') },
  {
    id: 'miniflux', name: 'Miniflux', icon: '📰', category: 'Reading',
    description: 'Minimalist RSS reader. Fast, keyboard-friendly, works with RSS apps.',
    website: 'https://miniflux.app',
    kind: 'native', packages: ['miniflux'],
    db: { type: 'postgres', env: 'DATABASE_URL', suffix: '?sslmode=disable' },
    env: { RUN_MIGRATIONS: '1', CREATE_ADMIN: '1', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '{{password}}' },
    credentials: { username: 'admin' },
    start: 'LISTEN_ADDR="0.0.0.0:$PORT" BASE_URL="$APP_URL" exec miniflux',
    notes: 'A PostgreSQL database is created for it automatically.',
  },
  {
    id: 'gotify', name: 'Gotify', icon: '🔔', category: 'Notifications',
    description: 'Send push notifications to your phone from scripts and apps.',
    website: 'https://gotify.net',
    kind: 'native', packages: ['gotify'],
    env: {
      GOTIFY_DEFAULTUSER_NAME: 'admin', GOTIFY_DEFAULTUSER_PASS: '{{password}}', GOTIFY_DATABASE_DIALECT: 'sqlite3',
      GOTIFY_DATABASE_CONNECTION: '{{data}}/gotify.db', GOTIFY_UPLOADEDIMAGESDIR: '{{data}}/images', GOTIFY_PLUGINSDIR: '{{data}}/plugins',
    },
    credentials: { username: 'admin' },
    start: 'GOTIFY_SERVER_PORT="$PORT" exec gotify serve',
  },
  {
    id: 'pocketbase', name: 'PocketBase', icon: '🗄️', category: 'Developer',
    description: 'Backend in one file: database, auth, file storage and an admin UI.',
    website: 'https://pocketbase.io',
    kind: 'native', packages: ['pocketbase'],
    env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: '{{password}}' },
    credentials: { username: 'admin@example.com', path: '/_/' },
    install: 'pocketbase superuser upsert "$ADMIN_EMAIL" "$ADMIN_PASSWORD" --dir "$APP_DATA/pb_data"',
    start: 'exec pocketbase serve --http="0.0.0.0:$PORT" --dir="$APP_DATA/pb_data"',
    notes: 'The admin dashboard is at /_/ on the app\'s address.',
  },
  {
    id: 'dufs', name: 'Dufs file server', icon: '📁', category: 'Files',
    description: 'Upload, download and share files from a browser. Supports WebDAV.',
    website: 'https://github.com/sigoden/dufs',
    kind: 'native', packages: ['dufs'],
    env: { ADMIN_PASSWORD: '{{password}}', FILES_DIR: '{{data}}/files' },
    credentials: { username: 'admin' },
    install: 'mkdir -p "$FILES_DIR"',
    start: 'exec dufs --bind 0.0.0.0 --port "$PORT" --auth "admin:$ADMIN_PASSWORD@/:rw" --allow-all "$FILES_DIR"',
    notes: 'Files are stored in the FILES_DIR shown in Environment. Change it to ~/storage/shared to share the phone\'s own files (run termux-setup-storage first).',
  },
  {
    id: 'transmission', name: 'Transmission', icon: '⬇️', category: 'Downloads',
    description: 'BitTorrent client with a web interface.',
    website: 'https://transmissionbt.com',
    kind: 'native', packages: ['transmission-daemon'],
    env: { ADMIN_PASSWORD: '{{password}}', DOWNLOAD_DIR: '{{data}}/downloads' },
    credentials: { username: 'admin' },
    install: 'mkdir -p "$DOWNLOAD_DIR" "$APP_DATA/config"',
    start: 'exec transmission-daemon --foreground --config-dir "$APP_DATA/config" --rpc-bind-address 0.0.0.0 --port "$PORT" --allowed "*.*.*.*" --auth --username admin --password "$ADMIN_PASSWORD" --download-dir "$DOWNLOAD_DIR" --no-portmap',
  },

  {
    id: 'code-server', name: 'VS Code (code-server)', icon: '🧑‍💻', category: 'Developer',
    description: 'The full VS Code editor in your browser, running on the phone. Terminal included.',
    website: 'https://coder.com/docs/code-server/latest/termux',
    kind: 'native',
    env: { PASSWORD: '{{password}}', WORKSPACE: '' },
    credentials: { username: null },
    // code-server lives in the Termux User Repository (tur-repo). The --require shim makes
    // Android look like Linux to VS Code so extensions install (workaround from code-server's docs).
    install: `set -e
if ! command -v code-server >/dev/null; then
  pkg install -y tur-repo
  pkg install -y code-server
fi
cat > "$APP_DATA/android-as-linux.js" <<'EOF'
// Make Android look like Linux so VS Code extensions install.
Object.defineProperty(process, 'platform', { get: () => 'linux' });
// Some Termux setups launch programs through Android's loader, so Node reports the loader as
// its own path and can't start child processes. Termux tells us the real path.
const real = process.env.TERMUX_EXEC__PROC_SELF_EXE;
if (real && /linker(64)?$/.test(process.execPath) && !/linker(64)?$/.test(real)) process.execPath = real;
EOF`,
    start: 'NODE_OPTIONS="--require $APP_DATA/android-as-linux.js" exec code-server --bind-addr "0.0.0.0:$PORT" --auth password --disable-telemetry --disable-update-check --user-data-dir "$APP_DATA/user-data" --extensions-dir "$APP_DATA/extensions" "${WORKSPACE:-$HOME}"',
    notes: 'Opens your Termux home folder; set WORKSPACE in Environment to open another folder. Your apps\' code is in ~/.pocketserver/apps/<app id>/src (redeploys replace it, so push changes to Git). Uses 300–500 MB of memory. Some extensions with native code may not work on Android.',
  },

  // ---------- Docker images (udocker, experimental) ----------
  {
    id: 'uptime-kuma', name: 'Uptime Kuma', icon: '📈', category: 'Monitoring',
    description: 'Monitor websites and services, with alerts and status pages.',
    website: 'https://uptime.kuma.pet',
    kind: 'docker', image: 'louislam/uptime-kuma:2', containerPort: null,
    env: { UPTIME_KUMA_PORT: '{{port}}', UPTIME_KUMA_HOST: '0.0.0.0' }, volumes: ['/app/data'],
    claim: true,
  },
  {
    id: 'vaultwarden', name: 'Vaultwarden', icon: '🔐', category: 'Security',
    description: 'Password manager server that works with the Bitwarden apps.',
    website: 'https://github.com/dani-garcia/vaultwarden',
    kind: 'docker', image: 'vaultwarden/server:latest', containerPort: null,
    env: { ROCKET_PORT: '{{port}}', ROCKET_ADDRESS: '0.0.0.0', ADMIN_TOKEN: '{{secret}}' }, volumes: ['/data'],
    notes: 'Bitwarden apps and the web vault need HTTPS. Turn on a public URL (or your own domain) and use that address. The admin page is at /admin; its token is ADMIN_TOKEN in Environment.',
  },
  {
    id: 'memos', name: 'Memos', icon: '📝', category: 'Notes',
    description: 'Quick notes and a private timeline, with Markdown.',
    website: 'https://usememos.com',
    kind: 'docker', image: 'neosmemo/memos:stable', containerPort: null,
    env: { MEMOS_PORT: '{{port}}', MEMOS_MODE: 'prod' }, volumes: ['/var/opt/memos'],
    claim: true,
  },
  {
    id: 'actual', name: 'Actual Budget', icon: '💰', category: 'Finance',
    description: 'Local-first personal budgeting app.',
    website: 'https://actualbudget.org',
    kind: 'docker', image: 'actualbudget/actual-server:latest', containerPort: null,
    env: { ACTUAL_PORT: '{{port}}' }, volumes: ['/data'],
    claim: true,
    notes: 'Actual needs HTTPS in the browser. Turn on a public URL and open it from there.',
  },
  {
    id: 'linkding', name: 'linkding', icon: '🔖', category: 'Reading',
    description: 'Bookmark manager that is fast and simple.',
    website: 'https://linkding.link',
    kind: 'docker', image: 'sissbruecker/linkding:latest', containerPort: null,
    env: { LD_SERVER_PORT: '{{port}}', LD_SUPERUSER_NAME: 'admin', LD_SUPERUSER_PASSWORD: '{{password}}' }, volumes: ['/etc/linkding/data'],
    credentials: { username: 'admin' },
  },
  {
    id: 'it-tools', name: 'IT Tools', icon: '🧰', category: 'Developer',
    description: 'Handy tools for developers: converters, generators, formatters…',
    website: 'https://it-tools.tech',
    kind: 'docker', image: 'corentinth/it-tools:latest', containerPort: 80, volumes: [],
  },
];

function publicView(r) {
  return {
    id: r.id, name: r.name, icon: r.icon, category: r.category, description: r.description, website: r.website,
    kind: r.kind, needsDb: r.db ? r.db.type : null, notes: r.notes || null, image: r.image || null, claim: !!r.claim,
    unavailable: r.kind === 'docker' && apps.dockerWorks() === false
      ? "This phone's kernel can't run Docker apps (proot hangs on it). Native apps work." : null,
  };
}
const list = () => RECIPES.map(publicView);

async function install(id, input = {}) {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new U.HttpError(404, 'That app isn\'t in the catalog.');
  const name = String(input.name || r.name).trim().slice(0, 60) || r.name;
  const password = U.secret(12).replace(/[^A-Za-z0-9]/g, 'x');
  const secret = U.secret(32);

  // A database the app depends on is created first; it starts in the background.
  let db = null;
  if (r.db) db = await dbs.create({ type: r.db.type, name: `${name} database` });

  const fillOnce = (s, a) => s
    .replace(/\{\{password\}\}/g, password).replace(/\{\{secret\}\}/g, secret)
    .replace(/\{\{data\}\}/g, apps.dataDir(a.id))
    .replace(/\{\{url\}\}/g, `http://${(U.localIPs()[0] || {}).address || 'localhost'}:${a.port}`);

  const base = r.kind === 'docker'
    ? { source: 'docker', image: r.image, containerPort: r.containerPort, volumes: r.volumes, command: r.command || '' }
    : { source: 'command', install: r.install || '', start: r.start };

  return apps.create({ ...base, name, autoDeploy: false }, {
    prepare(a) {
      a.env = Object.fromEntries(Object.entries(r.env || {}).map(([k, v]) => [k, fillOnce(v, a)]));
      if (db) {
        a.env[r.db.env] = db.urls.local + (r.db.suffix || '');
        a.dependsOn = [db.id];
      }
      a.packages = r.packages || [];
      // claim: the app gives admin rights to whoever opens it first. The dashboard warns about it.
      a.catalog = { id: r.id, notes: r.notes || null, claim: !!r.claim };
      if (r.credentials) a.credentials = { username: r.credentials.username, password, path: r.credentials.path || '' };
    },
  });
}

module.exports = { list, install, RECIPES };
