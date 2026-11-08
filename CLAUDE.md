# Notes for AI coding assistants (and humans)

PocketServer turns an Android phone into a self-hosting server: a Coolify-style dashboard running in Termux,
with no root and no Docker daemon. Read `CONTRIBUTING.md` first. It has the ground rules and a map of the code.
This file covers how to test and the Android surprises we already ran into, so you don't rediscover them.

## Ground rules (short version)

- `server/` uses only Node's standard library: no npm packages, no build step. `ui/` is plain HTML/CSS/JS.
- Never put user text into `innerHTML`. Use the `h()` helper in `ui/app.js`.
- Every reading of `/proc`, `/sys` or `getprop` must be optional. Android blocks many of them.
- UI wording is plain and friendly. Many users have never run a server.
- Shell commands built from user input are quoted with `shq()` (apps.js), or passed as argument arrays.
  SQL uses psql variables (`:'v'` / `:"v"`) or MariaDB hex literals. See `server/dbdata.js`.

## Testing

### On your computer (fast loop)

```sh
npm run dev                                     # http://127.0.0.1:7799, data in ./.dev-data
dev/api.sh GET /apps                            # API call; logs in with .dev-data/initial-password
node dev/screenshot.mjs --width 390 apps settings   # screenshots + prints any JS errors (--theme dark|light)
node dev/preview.mjs http://<phone-ip>:7777         # this checkout's ui/ with a phone's real data, on :7788
```

macOS and Linux both work. Things that only exist on Android (Termux packages, battery, `getprop`) are skipped.

### On a phone (the real test)

You need:
1. The **GitHub build** of Termux, plus Termux:API (not the Play Store or F-Droid builds). It's a debug build, so
   `adb shell run-as com.termux` works.
2. Wireless debugging (Android 11+) or USB debugging, and `adb connect <ip>:<port>`.

```sh
export PH_DEVICE=<ip>:<port>         # from `adb devices`
dev/push.sh --install --samples      # first time: copy this checkout to the phone and install it
dev/push.sh                          # after each change: copy and restart
dev/phone.sh 'pocketserver logs'       # run any command inside Termux
PH_BASE=http://<phone-ip>:7777 PH_PASSWORD=<password> dev/api.sh GET /apps
```

`--samples` creates small git repos on the phone at `~/sample-apps/{node,static,flask,crash}`. To test deploys
without the internet, enter that path as the repository. `crash` is supposed to fail.

**Important caveat:** `dev/phone.sh` runs commands under a different Android security context than the Termux
app (SELinux `runas_app`). So PocketServer started through it behaves differently:
- Termux:API calls (battery) hang.
- PostgreSQL's `initdb` hangs at `postgres --check`.

To test those, run `pocketserver restart` in the Termux app on the phone itself.

### Before you finish a change

- `node --check` every JS file you touched, and run the server locally.
- For UI changes, take screenshots at 390 and 1280 width and check the console output.
- For anything Android-specific, test on a phone and say in the PR what you tested there.

## Android and Termux surprises (already solved, don't undo)

- **Node fails with "CANNOT LINK EXECUTABLE" on a fresh Termux.** Packages are out of date. `install.sh` runs
  `pkg upgrade` (with `--force-confold`), not just `pkg update`.
- **`process.execPath` can be `/apex/.../linker64`.** termux-exec may start programs through Android's loader,
  so programs that re-run themselves break. The real path is in `TERMUX_EXEC__PROC_SELF_EXE`.
  - Syncthing: fixed with `STMONITORED=1`.
  - code-server: fixed with a `--require` shim. See both recipes in `server/catalog.js`.
- **Apps can't read `ro.lineage.*` and similar ROM properties.** `stats.js` gets the ROM name from
  `ro.build.flavor`.
- **Termux:API can fail for a while and then work again.** Battery readings retry with backoff instead of giving up.
- **Android kills background processes** (the "phantom process killer", Android 12+). Fixes for users are in
  `docs/android-setup.md` and `pocketserver doctor`.
- **Programs that refuse to run as the Android user.** Gitea/Forgejo check `RUN_USER`, so leave it out of
  app.ini. Forgejo reserves the username `admin`.
- **Two PocketServer instances.** If one is already running, a second one exits with code 98 before touching
  anything. `killStale()` only runs after the port is bound, and the watchdog gives up after repeated 98s.
  Keep that order.
- **`pkill -f pattern` can kill your own shell**, because the pattern is in its command line. Use the anchored
  `pgrep` patterns in `bin/pocketserver`.
- **VS Code Remote-SSH doesn't support Android.** For editing over SSH, point people to the "SSH FS"
  extension or the code-server catalog app.
- **Docker images run through `udocker`** (rootless, no daemon). It has no init system and no compose, so
  multi-container or s6-based images won't work. Prefer native Termux packages (`pkg search <name>`).
- **The Android loader rejects some prebuilt Linux binaries** (glibc). Use the Termux package, or a
  Docker image through udocker.

## Adding a catalog app

See "Adding an app to the catalog" in `CONTRIBUTING.md`.
- Install commands run on every redeploy, so they must be safe to re-run. Use marker files for one-time steps.
- Templates you can use: `{{password}}`, `{{secret}}`, `{{data}}`, `{{url}}`, and `{{port}}` (Docker only).
- Test the install, the first login and a restart on a real phone before adding a recipe.

## Things an assistant should ask before doing

Installing APKs on someone's phone, deploying code or images from the internet, opening public tunnels, and
pushing to GitHub all have effects outside this repo. Ask the person first.
