# Kiosk Deployment Guide

This guide covers deploying the Time Clock app to a dedicated tablet or desktop running in kiosk mode.

## Prerequisites — HTTPS is required

The app uses the Web Crypto API (`crypto.subtle`) for PIN hashing. Browsers only expose this on **secure contexts** — that is, pages served over HTTPS or from `http://localhost`. The app will refuse to run otherwise and display "This kiosk requires HTTPS — contact your administrator."

If you're hosting the kiosk on a public domain, use Let's Encrypt or your cloud provider's TLS.

If you're hosting on your local network (e.g., one PC in the back office serving tablets on the LAN), the simplest path is **Caddy** with an internal CA:

```
# Caddyfile
clock.lan {
    tls internal
    reverse_proxy localhost:8080
}
```

Run `caddy run` and Caddy generates a self-signed root certificate. Install that root cert on each kiosk device (Caddy prints the path on first run) so the tablets trust `https://clock.lan`. After that, full HTTPS with no warnings.

Build the app once (`npm run build`) and serve the `dist/` folder with any static host — Caddy can do this directly with `file_server`, or use `npx serve dist` behind Caddy.

---

## Scenario 1 — Android tablet with Fully Kiosk Browser (recommended)

[Fully Kiosk Browser](https://www.fully-kiosk.com/) is the de-facto kiosk launcher for Android. Free tier is sufficient for this use case; the paid PLUS license unlocks the remote admin features.

### Install and configure

1. Install Fully Kiosk Browser from the Play Store.
2. Open it, dismiss the welcome dialog.
3. Tap the gear icon → **Web Content Settings**:
   - **Start URL**: `https://your-kiosk-host/`
   - **Disable JavaScript Alerts**: off (the app uses no alerts but leave it default)
4. **Universal Launcher**:
   - **Run on Device Boot**: ON
   - **Re-launch on Screen Unlock**: ON
5. **Toolbars and Appearance**:
   - **Show Address Bar**: OFF
   - **Show Action Bar**: OFF
   - **Show Navigation Bar**: OFF
   - **Disable Status Bar**: ON
6. **Kiosk Mode** (this is the big one):
   - Toggle **Enable Kiosk Mode** ON
   - Set a 6-digit **Kiosk Exit Gesture PIN** (different from any employee PIN — this is the *admin's* escape hatch from Fully, not the app)
   - **Disable Other Apps**: ON
   - **Disable Status Bar Pulldown**: ON
   - **Disable Volume Buttons**: optional, recommend ON
7. **Device Management → Screen**:
   - **Keep Screen On**: ON
   - **Screen Saver Timeout**: 0 (never)
   - **Display Brightness**: set to a fixed value (auto-brightness causes flicker on darker UIs)
8. **Power Settings**:
   - **Plug-In Power Management**: ON if mains-powered (recommended for kiosks)

Restart Fully. The kiosk should boot directly into the app, with no way for an employee to exit without the gesture PIN.

### Updates

When you ship a new app version, Fully reloads the URL on its next launch and the service worker picks up the update automatically.

---

## Scenario 2 — iPad with Safari + Guided Access

iPad doesn't have a kiosk browser equivalent to Fully, but the built-in **Guided Access** feature works well for single-app lockdown.

### Install the PWA

1. Open Safari on the iPad. Navigate to your kiosk URL.
2. Tap the share icon → **Add to Home Screen**. Name it "Time Clock" and confirm.
3. Close Safari. From the home screen, tap the new Time Clock icon. It launches in standalone (no Safari chrome) thanks to the PWA manifest.

### Enable Guided Access

1. **Settings → Accessibility → Guided Access** → toggle ON.
2. **Passcode Settings** → Set Guided Access Passcode. Pick a 6-digit code only you know.
3. **Time Limits** → leave default.
4. **Accessibility Shortcut** → optional but recommended (lets you triple-click the side button to start/end a session).

### Start a Guided Access session

1. Open the Time Clock home-screen app.
2. Triple-click the side button.
3. Guided Access overlay appears. Tap **Start** (top-right).
4. The iPad is now locked to the Time Clock app — no swipe-up, no app switcher, no escape.

To exit: triple-click side button, enter the Guided Access passcode.

### Auto-start on boot

Guided Access does **not** survive a reboot — if the iPad restarts, you'll have to manually re-enter Guided Access. To minimize reboots:

- **Settings → Battery** → leave the device plugged in.
- **Settings → General → AutoLock** → Never.
- Disable iOS auto-updates (or schedule them for off-hours).

For a fully unattended deployment, consider Apple Business Manager + Single App Mode via MDM — that survives reboots — but that's a heavier lift than Guided Access.

---

## Scenario 3 — Desktop / Linux kiosk

Useful when you have a spare laptop, mini-PC, or Raspberry Pi connected to a wall-mounted display.

### Chromium kiosk mode (Linux or Windows)

Launch flag:

```
chromium --kiosk --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --no-first-run https://your-kiosk-host/
```

Key flags:
- `--kiosk` — full-screen, no chrome, no exit shortcut (other than Alt+F4 or Ctrl+W which you can disable at the OS level)
- `--disable-pinch` — disable pinch-zoom on touchscreens
- `--overscroll-history-navigation=0` — disable swipe-back gesture
- `--noerrdialogs` — suppress crash dialogs
- `--no-first-run` — skip the welcome wizard

On Firefox, use `firefox --kiosk URL`.

### Auto-start on boot (Linux, systemd)

Create `/etc/systemd/system/kiosk.service`:

```ini
[Unit]
Description=Time Clock Kiosk
After=graphical.target

[Service]
Type=simple
User=kiosk
Environment=DISPLAY=:0
ExecStart=/usr/bin/chromium --kiosk --disable-pinch --noerrdialogs --no-first-run https://your-kiosk-host/
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
```

Then:
```
sudo systemctl enable kiosk
sudo systemctl start kiosk
```

For a Raspberry Pi, also disable the screen blanking in `/boot/config.txt` (`hdmi_blanking=0`) and disable the screensaver in your DE.

### Auto-start on boot (Windows)

Put a `.bat` shortcut in `shell:startup` (Win+R, type `shell:startup`):

```bat
@echo off
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --disable-pinch https://your-kiosk-host/
```

For real lockdown on Windows, use **Assigned Access** (Settings → Accounts → Family & other users → Set up a kiosk). This locks a user account to a single UWP or browser app.

---

## Backup strategy

The app stores all data in the browser's `localStorage`. That means:
- All data lives on **one device**. If the tablet is lost, stolen, or factory-reset, the data is gone.
- The app's built-in **Settings → Backup & Restore → Download Backup** produces a JSON file with everything.

**Recommended cadence**: weekly backup, after payroll close. The admin downloads the file to a USB drive or emails it to themselves. For higher reliability, add a calendar reminder or build out automated cloud sync (out of scope for v1).

If you replace the tablet, install the app fresh on the new device, then **Settings → Backup & Restore → Restore from File** to import the backup.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "This kiosk requires HTTPS" | App loaded over `http://` | Serve over HTTPS or `http://localhost` |
| Permanent black screen | Fonts CDN unreachable + 3s fallback hasn't fired yet | Wait 3 seconds; app continues with system fonts |
| App doesn't update after deploy | Service worker cached old shell | Pull-to-refresh in the browser, or close and reopen the kiosk launcher |
| Employee forgot their PIN | Admin resets it from the Team tab | Admin → Team → Reset PIN → share the new temp PIN with the employee |
| Forgot the admin PIN | No recovery flow exists | Wipe app data (`localStorage.clear()` from devtools, if accessible) — wizard runs again. Restore from backup if needed. |
