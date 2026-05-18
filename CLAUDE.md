# Project guide for Claude

PIN-based employee time-clock kiosk. Single-file React app (Vite + PWA) deployed to Vercel at `bbckiosk.vercel.app`. Designed for an iPad 10th gen (820×1180) in portrait, wall-mounted on a tablet stand. Repo: https://github.com/appledonkey/bbckiosk.

## Read these before you change anything

- **`src/App.jsx`** — entire app, ~2000 lines, **single-file by intent**. Don't split into multiple files or extract components into separate modules. Helper components (`ReasonChips`, `SectionHead`, `PinRevealCard`) are defined inside the main `ClockInKiosk` function and close over state via lexical scope.
- **`src/pin.js`** — PBKDF2-SHA256 hash/verify helpers (Web Crypto). Used for both employee PINs and the admin recovery code.
- **`src/storage.js`** — `localStorage` shim implementing `get/set/delete/list`. `get` **throws** on missing key (per spec); every caller in App.jsx wraps in `try/catch`. The console will spam "Key not found" errors on first load — that's by design.

## Build / deploy / run

```
npm install
npm run dev      # Vite dev server, port 5173
npm run build    # production build → dist/
npm run preview  # serve dist/, port 4173
```

Vercel auto-deploys `main` branch via GitHub integration. Production URL: `bbckiosk.vercel.app`. **HTTPS is mandatory** — the app refuses to run without `crypto.subtle` (Web Crypto, secure-context only). `localhost` is treated as secure for dev.

## Architecture invariants — do NOT change

**Single-file React component.** All UI in `src/App.jsx`. No splitting allowed beyond the existing pin.js / storage.js / main.jsx.

**Inline styles only.** No CSS files, no CSS modules, no Tailwind, no styled-components. The styles live in a `useMemo`'d `S` object inside the component (recomputes only when `scale` changes). The styles object is defined *inside* the component (closes over `s`, `SIZE`, `touchMin`, `fontMin`).

**No TypeScript, no ESLint config, no test framework, no UI libraries.** The project is intentionally minimal.

**No media queries / breakpoints.** UI scaling is continuous via the `useScale` hook → `s()` / `touchMin()` / `fontMin()` helpers → `SIZE` constant → memoized `S` object. Adding breakpoints breaks this model.

**PWA manifest locks portrait orientation.** Don't try to handle landscape; the manifest enforces it and we don't design for landscape rotations.

## Order in the component body (critical)

```
1. const scale = useScale();                  // <-- top, with state
2. const [state, setState] = useState(...);   // <-- all state declarations
3. useEffect(...)                              // <-- effects
4. useCallback / handlers                      // <-- handlers
5. useMemo for computed values                 // <-- computed values
6. const s = (px) => Math.round(px * scale);   // <-- scaling helpers
7. const touchMin = (px) => Math.max(44, s(px));
8. const fontMin = (px) => Math.max(11, s(px));
9. const SIZE = { ... };                       // <-- plain const, uses s/touchMin/fontMin
10. const S = useMemo(() => ({ ... }), [scale]); // <-- deps: [scale] ONLY
11. if (!crypto.subtle) return ...              // <-- conditional returns AFTER all hooks
12. if (!fontsLoaded || !booted) return ...
13. const panelStyle = { ...S.panel, ... };
14. return <JSX>
```

**Critical:** `S = useMemo` deps array is `[scale]` alone. Do NOT add `s`, `SIZE`, etc. — those are recreated each render so their identities would invalidate the memo every time, defeating the purpose. The closure captures the values fine.

## Scaling system

- `getScale()` computes `min(w/820, h/1180)` clamped to **`[0.7, 2.0]`** (floor was 0.55 pre-v1.2.1).
- `useScale()` is a real custom hook, defined at module level above the component. Throttled via `requestAnimationFrame`. Logs `[scale] X.XXX @ WxH` on every change.
- Inside the component: `s(px) = Math.round(px * scale)`. Used for most dimensions.
- `touchMin(px) = Math.max(44, s(px))` — interactive element widths/heights. 44 = Apple HIG minimum.
- `fontMin(px) = Math.max(11, s(px))` — font sizes ≤14 base. 11 = readability floor.
- Inner panel `maxWidth: min(max(480, s(480))px, calc(100vw - s(24)px))` — viewport-aware so phones don't get tiny cards.

## Storage keys

| Key | Shape | Notes |
|---|---|---|
| `kiosk-employees` | `[{id,name,pinSalt,pinHash,email,phone,needsPinChange,active,schedule}]` | `pin` plaintext field migrated to `pinHash` in v1.0.0. Never reintroduce. |
| `kiosk-admin-pin` | `{salt, hash}` | Plaintext migrated to hash. No `DEFAULT_ADMIN_PIN` exists — wizard creates it. |
| `kiosk-admin-recovery` | `{salt, hash}` | 12-char alphanumeric recovery code, hashed in canonical no-hyphen form. |
| `kiosk-setup-state` | `{step}` | Wizard progress for crash recovery. Cleared on Finish Setup. |
| `kiosk-worksite` | `{lat, lng, radius}` | Absent = geofence disabled. Applied to employee punches only (admin login exempt). |
| `kiosk-business-name` | string | ≤60 chars, trimmed. Shown above clock + in `document.title`. |
| `kiosk-entries:YYYY-MM` | array of entries | One key per month. Loaded for current+prev month at boot. |
| `kiosk-audit:YYYY-MM` | array of audit events | Per-month audit log. |
| `kiosk-corrections:YYYY-MM` | array of corrections | Per-month employee correction requests. |
| `kiosk-archive:YYYY-MM` | array | Archived entries (after 90-day archive operation). |

## VIEWS and SETUP_STEPS

```js
VIEWS = { PIN, ACTION, SUCCESS, ADMIN, ADMIN_LOGIN, PIN_SETUP, SETUP, RECOVER_PIN }
SETUP_STEPS = { WELCOME, ADMIN_PIN, ADMIN_PIN_CONFIRM, RECOVERY_CODE, BUSINESS_NAME, ADD_EMPLOYEE, SHOW_TEMP_PIN }
```

Wizard order: `WELCOME → ADMIN_PIN → ADMIN_PIN_CONFIRM → RECOVERY_CODE → BUSINESS_NAME → ADD_EMPLOYEE → SHOW_TEMP_PIN → ADD_EMPLOYEE (loop)`. `BUSINESS_NAME` is optional (Skip available); resume-on-crash skips it.

`RECOVER_PIN` flow: `enter_code → set_pin → confirm_pin` (sub-stages in `recoverStage` state) → post-recover reveal card → admin.

## Don'ts (will break things)

- **Don't add `'DM Mono'` or `'Instrument Sans'` anywhere.** Replaced by `Outfit` in v1.1.2. The whole app uses one font; tabular numeric alignment is provided by `font-variant-numeric: tabular-nums` inherited from `S.container`.
- **Don't unset `fontVariantNumeric` on the container.** Removing it breaks number alignment in tables and clocks.
- **Don't reintroduce `const DEFAULT_ADMIN_PIN`.** Removed in v1.0.0; wizard creates the admin PIN.
- **Don't scale**: `border-width` (always `1px`), `opacity`, `em` letter-spacing (already relative), `transition` durations, `z-index`, `box-shadow` blur/spread, `100vh`/`100%`/`100vw`/`vmin`, the grain `background-size`, the `BURN_IN_RANGE` pixel offset, any `0` value, or the QR source generation size (always 180px — only the `<img>` display size scales).
- **Don't add a breakpoint or media query.** Continuous scaling is the model.
- **Don't write a Save/Done global button on Settings or Team tabs.** There's no pending state — every action persists immediately. Adding fake save buttons creates the illusion of unsaved work.
- **Don't use Math.random for security-relevant randomness.** Temp PINs use `crypto.getRandomValues` (the admin-Team `addEmployee` still uses Math.random — minor, not yet fixed).
- **Don't redesign the pay-period table as cards.** It's a 15-day grid by design. Admin reads payroll data sitting down.
- **Don't shrink the kiosk's QR reveal size below 140px** — scannability floor.

## Conventions

**Semver:** features = minor (1.1 → 1.2). Polish / visual fixes / bug fixes with no behavior change = patch (1.2.0 → 1.2.1).

**Commits:** single-feature, multi-line body. Always include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer. Use HEREDOC for multi-line messages. Tag every release `vX.Y.Z` (`git tag -a vX.Y.Z -m "vX.Y.Z"`), push tag separately (`git push origin vX.Y.Z`).

**When to commit:** only when the user explicitly asks. If unclear, ask first. Each release is a single commit (no per-feature splits retroactively).

**Audit log conventions:** every meaningful state change emits an audit event via `addAudit(action, detail)`. Action names use `snake_case`. Detail includes the affected entity name where applicable.

## Release inventory

| Version | What |
|---|---|
| v1.0.0 | Initial release. PBKDF2 PIN hashing, plaintext migration, first-run wizard, factory reset, audit log, CSV/JSON export, PWA. |
| v1.1.0 | QR temp PINs (`qrcode` lib, gated reveal, 30s countdown), email/phone employee fields, currently-on-the-clock panel, dynamic scaling system. |
| v1.1.1 | Visual polish pass (chip styles, full-width Confirm, tab underline, etc.). |
| v1.1.2 | Unified typography (Outfit), tabular-nums via container, SVG backspace icon. |
| v1.1.3 | Font inheritance bug fix (fontFamily on container). |
| v1.1.4 | Section label legibility + row-action button gap. |
| v1.2.0 | **Geofencing** (hard block, employee punches only), **business name**, **admin PIN recovery** (12-char code, wizard step, Forgot PIN flow, auto-regen on use). |
| v1.2.1 | Phone-fit: scale floor 0.55→0.7, viewport-aware panel maxWidth. |

## Known accepted trade-offs

- **Cross-day shifts that span midnight reject as missing-punch.** Intentional — protects payroll from inflated 16h+ pairs when someone forgets to clock out.
- **`getCurrentPosition` fail-closed in geofence.** Permission denied / timeout / no GPS = blocked punch. Admin must disable geofence to unblock.
- **Vertical void on phones (~200px each side).** Accepted. Reducing it further would require breakpoints or vertical anchoring that hurts tablet view.
- **Inner panel renders briefly before storage loads.** Masked by `if (!fontsLoaded || !booted) return <div style={S.container}/>` — gives an empty dark screen until both fonts and storage are ready.
- **`scale` recomputes the entire styles object on resize.** `S = useMemo(..., [scale])` ensures rebuilds happen only on actual scale change, not every render.

## Files

```
src/App.jsx              entire app (~2000 lines)
src/pin.js               PBKDF2 hash/verify
src/storage.js           localStorage shim (throws on missing key by spec)
src/main.jsx             entry, attaches window.storage
index.html               minimal shell, system-font fallback CSS
vite.config.js           PWA config, defines __APP_VERSION__ and __BUILD_DATE__
public/icon-{192,512}.png PWA icons
KIOSK-SETUP.md           Android (Fully Kiosk) / iPad (Guided Access) / Linux deployment guide
README.md                quick start
CLAUDE.md                this file
.claude/launch.json      preview server configs for the dev workflow
```

## When in doubt

- The user values direct, structured critique over agreement. Push back when something is wrong, even when it's their idea.
- Before implementing on suggested changes, surface ambiguities or scope-creep risks.
- This is a finished, deployed product. Don't propose architectural overhauls. Small, targeted changes only.
