# Contributing to PocketServer

Thanks for helping. PocketServer aims to stay **small and dependency-free**, so it installs in seconds on any phone.

## Ground rules

- **No npm dependencies** in `server/`. Node's standard library only. A native module that needs compiling would break installs on many phones.
- **No build step** for the dashboard (`ui/`). It's plain HTML, CSS and JS.
- Never put user-controlled text into `innerHTML`. Use the `h()` helper, which sets text safely.
- Everything must work on **Android without root**. Many `/proc` and `/sys` files are blocked for apps there, so make every reading optional.
- Keep wording in the UI plain and friendly. Many users aren't sysadmins.

## Running locally

```sh
npm run dev          # http://localhost:7799, data in ./.dev-data
```

This works on macOS and Linux. Runtimes aren't auto-installed outside Termux, so have `git`, `node`, etc. on your PATH.

## Testing on a phone

Install the GitHub build of Termux. It's a debug build, so `adb shell run-as com.termux` works. Connect over
wireless debugging, then:

```sh
export PH_DEVICE=<ip>:<port>        # from `adb devices`
dev/push.sh --install --samples     # copy this checkout to the phone, install it, add sample repos
dev/push.sh                         # after each change
dev/phone.sh 'pocketserver logs'      # run a command inside Termux
```

`dev/api.sh` calls the dashboard API and `dev/screenshot.mjs` takes screenshots. `CLAUDE.md` explains the
caveats of testing over adb and the Android quirks we've already worked around. Read it before changing
anything Android-specific.

## Code map

| File | What it does |
|---|---|
| `server/index.js` | HTTP server, routes, auth checks, live logs (SSE) |
| `server/apps.js` | Create, deploy, start and stop apps; auto-deploy polling; webhooks |
| `server/detect.js` | Figures out install/build/start commands from a repo |
| `server/supervisor.js` | Runs processes, restarts on crash, stores logs |
| `server/databases.js` | PostgreSQL / MariaDB / Redis |
| `server/dbdata.js` | Data browser: tables, rows, SQL console, Redis keys |
| `server/gitkey.js` | The phone's SSH key for private repos |
| `server/catalog.js` | One-click app recipes (native Termux packages and Docker images) |
| `server/sshd.js` | Optional SSH server for terminals and VS Code |
| `server/tunnels.js` | Cloudflare quick tunnels and named tunnels |
| `server/stats.js` | Phone stats with Android-safe fallbacks |
| `ui/app.js` | The dashboard |
| `bin/pocketserver` | CLI and watchdog |
| `install.sh` | Termux installer |
| `dev/` | Test scripts and sample apps for developing on a phone |

## Adding an app to the catalog

Add a recipe to `server/catalog.js`. Prefer a Termux package (`pkg search <name>`): it's built for Android and needs no Docker. Commands get `$PORT`, `$APP_DATA` (a private folder that survives redeploys) and `$APP_URL`. Install commands run on every redeploy, so make them safe to re-run. Test it on a phone, and put any Android workaround in a comment (see Syncthing's `STMONITORED`).

## Device reports

Open an issue with the phone model, Android version, which steps from `docs/android-setup.md` you needed, and how long it has stayed up. This is one of the most useful things you can contribute.
