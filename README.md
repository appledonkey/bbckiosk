# Time Clock

A PIN-based employee time-clock kiosk for shared tablets — offline-capable PWA with PBKDF2-hashed PINs.

## Quick start

```
npm install
npm run dev      # local development on http://localhost:5173
npm run build    # production build into dist/
```

## Deployment

See [KIOSK-SETUP.md](KIOSK-SETUP.md) for full deployment instructions covering Android (Fully Kiosk Browser), iPad (Guided Access), and desktop/Linux (Chromium kiosk mode).

**HTTPS is required.** The app uses the Web Crypto API (`crypto.subtle`) to hash PINs and will refuse to run on plain `http://`. Use `http://localhost` for dev, HTTPS in production.
