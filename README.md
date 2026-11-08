<p align="center"><img src="ui/icon.svg" width="72" alt=""></p>

<h1 align="center">PocketServer</h1>

<p align="center"><b>Turn any Android phone into a self-hosting server, with a Coolify-style dashboard.</b><br>
No root. No Docker. No wiping your phone.</p>

---

That old phone in your drawer has an 8-core CPU, gigabytes of RAM, a battery backup and Wi-Fi. PocketServer turns it into a little server: deploy your apps from Git, run databases, and share them on the internet, all from a dashboard in your browser.

## Features

- **One-click app catalog.** Syncthing, Navidrome, Gitea, Forgejo, Miniflux, Gotify, PocketBase, Dufs and Transmission run natively (Android builds from Termux), with an admin login generated for you. Uptime Kuma, Vaultwarden, Memos, ntfy, Actual, linkding and IT Tools run from their Docker images (experimental).
- **Docker images, without Docker.** Paste an image name like `louislam/uptime-kuma:2` and it runs through [udocker](https://github.com/indigo-dc/udocker) (no root). Experimental: images that need to be PID 1 (s6-overlay, systemd) don't work, and there is no compose.
- **Deploy from Git.** Paste a repo URL. PocketServer clones it, detects the stack, installs dependencies, builds and runs it.
- **Auto-detects** Node.js, Python (Django, Flask, FastAPI), Go, Rust, PHP, static sites, frontend builds (Vite, React, Angular…) and `Procfile`s. Missing runtimes are installed for you.
- **Auto-deploy on push.** Checks your repo for new commits every 2 minutes, so it works behind any home router. Webhooks for GitHub, GitLab and Gitea are supported too.
- **Keeps apps running.** Restarts on crash with backoff, brings everything back after a reboot, and shows live logs in the browser.
- **One-click databases:** PostgreSQL, MariaDB (MySQL) and Redis, with generated passwords and ready-made connection URLs.
- **Browse and edit your data** in the dashboard: tables, rows and an SQL console for PostgreSQL and MariaDB; keys, hashes, lists and a command box for Redis.
- **Private repos:** the phone gets its own SSH key. Add it to a repo as a read-only deploy key and deploy with the `git@…` address.
- **Edit from VS Code:** turn on the built-in SSH server (key logins only) and open the phone's files with the SSH FS extension, or use any terminal.
- **Free public URLs** through Cloudflare Tunnel. No port forwarding, works on mobile data. You can also use your own domain with HTTPS.
- **Phone stats:** memory, storage, battery, temperature, and per-app CPU and memory.
- **Lightweight:** plain Node.js with **zero npm dependencies**. It runs on Android 7+ (arm64, armv7, x86_64) and the dashboard itself uses about 55 MB of RAM.

## Install

You need an Android phone (7.0 or newer) and Wi-Fi.

1. **Install Termux** from [F-Droid](https://f-droid.org/packages/com.termux/) or [GitHub](https://github.com/termux/termux-app/releases).
   The old Google Play version is outdated. Don't mix sources: Termux and its add-ons must all come from the same place.
2. Open Termux and run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/OWNER/pocketserver/main/install.sh | bash
   ```

3. Open the address it prints (like `http://192.168.1.50:7777`) on your computer and log in with the password it shows.

Then do the one-time [phone setup](docs/android-setup.md) so Android doesn't put your server to sleep. In short:
- Set Termux battery usage to **Unrestricted**.
- Install **Termux:Boot** so PocketServer starts after a reboot.
- On Android 12+, lift the background process limit.

## Using it

| Task | How |
|---|---|
| Deploy an app | Dashboard → **New app** → paste the GitHub link (or just `you/app`) |
| Private repo | Settings → **Git access**: add the phone's key to the repo's *Deploy keys*, then deploy `git@github.com:you/app.git` |
| See or edit data | Database → **Data** (or **Keys** for Redis) |
| Edit files from VS Code | Settings → **SSH and VS Code**: add your computer's public key, turn on SSH, then connect with the SSH FS extension |
| Environment variables | App → **Environment** |
| Share on the internet | App → **Public URL** → *Get a free public URL* |
| Your own domain | Settings → **Your own domains** (Cloudflare Tunnel token) |
| Database | Dashboard → **New database**, then copy the connection URL into your app's environment |
| Monorepo | Set **Folder** when creating the app |
| Custom commands | **Advanced** → install / build / start |

Your app must listen on the port in the `PORT` environment variable, on `0.0.0.0`. Most frameworks do this already.

### Command line

```
pocketserver start | stop | restart | status
pocketserver logs          # PocketServer's own log
pocketserver password      # reset the dashboard password
pocketserver port 8080     # change the dashboard port
pocketserver doctor        # check your phone setup
pocketserver update
```

## How it compares to Coolify

Coolify runs everything in Docker. On Android, Docker needs root plus a custom kernel, because stock phone kernels leave out the container features (PID/IPC namespaces, device cgroups). PocketServer runs apps directly inside Termux instead:

| | Coolify | PocketServer |
|---|---|---|
| Runs on | Linux server/VPS | Any Android phone (no root) |
| Isolation | Docker containers | Separate processes and folders |
| Docker images | ✅ | ⚠️ Experimental, through udocker (no isolation, no compose) |
| One-click apps | ✅ Many | ✅ 16 (9 native, 7 Docker) |
| Git deploys, env vars, logs | ✅ | ✅ |
| Databases | Many | PostgreSQL, MariaDB, Redis |
| Public URLs | Your domain + Traefik | Free Cloudflare quick tunnels or your domain |

**What works on a phone:** web apps, APIs, bots, small sites, home dashboards and databases for personal use.<br>
**Not a good fit:** images that need a full init system (Home Assistant, many linuxserver.io images), heavy machine-learning workloads, or high-traffic production sites.

## Security

- The dashboard is protected by a password: scrypt-hashed, rate-limited logins, HttpOnly SameSite cookies and a header-based CSRF check.
- It's only reachable on your local network unless you choose to expose it through a tunnel.
- Databases listen on `localhost` only, unless you turn on Wi-Fi access.
- Apps run as the Termux user inside Android's app sandbox. They can't touch other apps' data, but they can see each other's files. Only deploy code you trust.
- Report security issues privately (see [SECURITY.md](SECURITY.md)).

## Where things live

```
~/pocketserver/          PocketServer itself
~/.pocketserver/
  state.json           settings, apps, databases (private)
  apps/<id>/src        your app's code
  databases/<id>/      database data
  logs/                logs (rotated at 5 MB)
```

## Contributing

PocketServer is deliberately simple: Node.js with no dependencies, and a no-build vanilla-JS dashboard.

```sh
git clone https://github.com/OWNER/pocketserver && cd pocketserver
npm run dev     # http://localhost:7799, data kept in ./.dev-data
```

It runs on macOS and Linux too, which makes development easy. Device reports are especially welcome: tell us which phones work well and which vendor settings were needed. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Roadmap ideas:**
- One-click apps (Uptime Kuma, n8n, Gitea…)
- Backups to S3/Drive
- Scheduled jobs
- Tailscale integration
- Multiple phones as one cluster
- Optional Docker support for rooted phones

## License

MIT
