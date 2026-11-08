# Phone setup: keeping your server running

Android is built to save battery, so it stops apps working in the background. Do these steps once after installing PocketServer. Run `pocketserver doctor` in Termux to see what applies to your phone.

## 1. Let Termux run in the background

**Settings → Apps → Termux → Battery → Unrestricted** (or "Don't optimize").

`pocketserver start` also takes a *wake lock*, so the CPU keeps running with the screen off. You'll see a Termux notification while it's active. Don't swipe it away.

## 2. Start automatically after a reboot

Install **Termux:Boot** from the same place you got Termux (F-Droid or GitHub), then **open it once**. The PocketServer installer already created `~/.termux/boot/pocketserver`.

## 3. Android 12 and newer: the "phantom process killer"

Android 12+ kills apps that start more than 32 background processes. A few apps plus a database can reach that, and when it happens your apps die with `signal 9`.

- **Android 14 and newer:** Settings → System → Developer options → turn on **Disable child process restrictions**.
  To get Developer options, tap *Build number* 7 times in *About phone*.
- **Android 12L / 13:** Developer options → **Disable child process restrictions** if your phone has it. Otherwise, run this once from a computer with [adb](https://developer.android.com/tools/releases/platform-tools):
  ```sh
  adb shell "/system/bin/device_config set_sync_disabled_for_tests persistent; /system/bin/device_config put activity_manager max_phantom_processes 2147483647"
  adb shell settings put global settings_enable_monitor_phantom_procs false
  ```
- **Android 12.0:** only the `device_config` commands above work.

## 4. Brand-specific settings

Some manufacturers add their own app killers on top of Android's. See [dontkillmyapp.com](https://dontkillmyapp.com) for your brand. Common ones:

| Brand | What to change |
|---|---|
| Samsung | Settings → Battery → Background usage limits → add Termux to **Never sleeping apps** |
| Xiaomi / Redmi / POCO | App info → Termux → **Autostart** on, Battery saver → **No restrictions**; lock Termux in recents |
| OnePlus / OPPO / realme | Battery → Termux → **Allow background activity**; turn off "Deep optimization"/"Sleep standby optimization" |
| Huawei / Honor | Battery → App launch → Termux → **Manage manually**, enable all three |
| Pixel / LineageOS / stock Android | Steps 1–3 are enough |

## 5. Protect the battery

A phone that stays plugged in 24/7 can swell its battery over months.

- **Use your phone's charge limit**, often called *Protect battery* (Samsung), *Adaptive/Optimized charging*, *Charging control* (LineageOS) or *Battery Care*. Set it to about 80%.
- No limit option? A smart plug on a schedule works too.
- Keep the phone somewhere cool and out of its case.

## 6. Networking

- **Fixed address:** in your router, reserve an IP (a "DHCP reservation") for the phone, so the dashboard URL never changes.
- **Access from anywhere:**
  - *Cloudflare Tunnel:* use the free public URL per app, or your own domain in Settings.
  - *Tailscale:* install the Tailscale Android app, then open `http://<phone's tailscale IP>:7777` from your other devices. This is private, with no public URL.
- **Mobile data works too:** public URLs go out through Cloudflare, so no inbound ports are needed.

## 7. Performance tips

- Set the screen timeout to the minimum and turn the brightness down. The server keeps running with the screen off.
- Turn off things you don't need, like Bluetooth, location and sync.
- Build steps (`npm install`, `cargo build`) are the slowest part. Running apps is light.
- For Python packages with native code (numpy, Pillow…), install the Termux build first, for example `pkg install python-numpy`, or install `build-essential` so pip can compile.
