# Uninstalling PocketServer

## 1. Remove PocketServer and its data

Works the same on Android (Termux), Linux and macOS:

```sh
pocketserver uninstall
```

It asks you to type `delete`, then:

- stops the dashboard and every app and database,
- deletes `~/.pocketserver`: your apps' code, their data, databases, logs, settings and SSH keys,
- deletes the installed code in `~/pocketserver`,
- removes the `pocketserver` command and the Termux:Boot start script,
- removes the containers of Docker apps.

**This deletes your databases and app data.** Back up anything you want to keep first, for example
with the database's Connect tab or by copying `~/.pocketserver/apps/<app id>/data`.

If you developed PocketServer from a clone of the repository, the uninstaller leaves that clone alone.
Delete it yourself if you want to, along with the `.dev-data` folder inside it, which holds the
local dev server's data.

## 2. Remove the packages it installed (optional)

PocketServer installs software when it first needs it. It doesn't remove it, because you may use it
for other things.

### Android (Termux)

Remove the packages you don't need:

```sh
pkg uninstall nodejs-lts git cloudflared termux-api openssh \
  postgresql mariadb redis python golang rust php composer clang make udocker proot \
  syncthing navidrome gitea forgejo miniflux gotify pocketbase dufs transmission code-server tur-repo
```

`pkg` skips any you never installed. Then clear the caches:

```sh
rm -rf ~/.npm ~/.cache/pip ~/.cargo ~/go ~/.udocker
```

`~/.udocker` holds the downloaded Docker images, which can be large.

**To remove everything at once,** uninstall the Termux app itself, or clear its storage under
Settings → Apps → Termux → Storage → Clear storage. This deletes every file and package in Termux,
including anything unrelated to PocketServer. Also uninstall Termux:API and Termux:Boot if you
installed them for PocketServer.

**If you changed Android settings** for PocketServer, you can undo them:

- Battery: Settings → Apps → Termux → Battery → back to **Optimized**.
- Android 14+: Developer options → turn **Disable child process restrictions** off.
- Android 12–13, if you used the adb commands:
  ```sh
  adb shell "/system/bin/device_config delete activity_manager max_phantom_processes; /system/bin/device_config set_sync_disabled_for_tests none"
  adb shell settings put global settings_enable_monitor_phantom_procs true
  ```

### Linux and macOS

PocketServer doesn't install packages outside Termux, so there's nothing more to remove. Node.js,
git and any databases came from your own package manager (apt, dnf, Homebrew…). Remove them with it
if you no longer need them. `~/.local/bin` may be left empty, which is harmless.
