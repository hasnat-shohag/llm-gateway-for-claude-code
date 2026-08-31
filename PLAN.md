# Desktop app — plan

The desktop app is a manager for the gateway that already lives in `../src`. It exists so the
gateway can be operated by someone who does not want to run `docker compose`, hand-edit
`providers.json`, or read `~/.claude/settings.json`. The gateway itself is unchanged: the app
compiles the same TypeScript source, runs it as a child process, and talks to its existing
read-only HTTP endpoints.

## Goals

1. **Run the gateway unattended.** Start it on login, keep it alive across crashes, and make its
   state legible (running / starting / port-in-use / crashed) from a tray icon.
2. **Edit providers safely.** Add, edit, reorder, enable, weight, and delete providers without
   ever producing a `providers.json` the gateway will reject, and without exposing stored API
   keys to the UI layer.
3. **Wire Claude Code up and back down.** Point `ANTHROPIC_BASE_URL` at the gateway — and undo
   that — by merging into `~/.claude/settings.json` rather than rewriting it.
4. **Show what it costs.** Surface the usage/cost data the gateway already records in SQLite:
   daily totals, per-provider split, recent calls, CSV export.

## Non-goals

- No provider-key discovery, no account creation, no marketplace of providers.
- No editing of the gateway's proxy behavior from the UI. Sanitize mode can be pinned per
  provider because that already exists as config; nothing else about the request path is
  exposed.
- No reading, storing, or refreshing of Claude Code's OAuth credential. Presence is detected;
  contents are never touched (see `main/claude-account.js` for why this is a hard line).
- No remote access. The gateway binds `127.0.0.1` only, and the renderer has no network
  capability at all.

## Architecture

```
Electron main process
├── supervisor.js        utilityProcess.fork(build/gateway/index.js), backoff restarts, log rotation
├── paths.js             every absolute path (userData, logs, ~/.claude), passed to the child as env
├── providers-store.js   read/merge/validate/write providers.json; masks keys
├── schema.js            imports the gateway's own zod schema out of build/gateway/config.js
├── settings-store.js    port / strategy / logLevel / pollMs, persisted in userData
├── claude-settings.js   the ~/.claude/settings.json merge (plan → apply)
├── claude-account.js    login presence check, contents never read
├── provider-probe.js    one-shot direct request to a single provider, bypassing the gateway
├── autostart.js         XDG autostart entry (Linux)
├── gateway-client.js    HTTP client for /health, /stats, /providers, /usage*
└── ipc.js               the named IPC channels, re-validating every payload

preload/preload.js       contextBridge allowlist — no generic invoke, no fs, no net

renderer/ (vanilla ESM, no framework, no build step)
├── app.js               tab routing, status bar, banners
├── store.js             one poll loop shared by all views
├── providers.js         provider table + edit/probe dialogs
├── dashboard.js         usage tiles, cost chart, per-provider split, recent calls
├── settings.js          Claude Code wiring, port/strategy, autostart
├── charts.js            inline SVG bar / stacked-bar charts
└── dom.js               element helper, modal, formatters
```

The gateway is compiled by `tsconfig.gateway.json` into `build/gateway/`, and
`scripts/finalize-gateway-build.js` drops a nested `package.json` marking that subtree as ESM —
the app is CommonJS, so without it Node would resolve the gateway's `.js` files as CJS and fail
on the first `import`.

## Invariants worth preserving

These are the decisions that are easy to break with an innocent-looking edit.

| Invariant | Where | Why |
| --- | --- | --- |
| `providers.json` is written **in place**, never temp-file-plus-rename | `providers-store.js` | The gateway's `fs.watch` binds to the inode; a rename makes hot reload go deaf. |
| Validation uses the gateway's own zod schema, not a copy | `schema.js` | A rejected file is silently ignored by the gateway's watcher, so the UI would show state the gateway never adopted. |
| Full API keys never leave the main process | `providers-store.js`, `preload.js` | The renderer only ever sees masks plus an `__UNCHANGED__` sentinel. |
| No gateway credential is written when a Claude Code login exists | `claude-settings.js` | Setting `ANTHROPIC_AUTH_TOKEN` overrides the subscription and breaks the `passthrough` provider. |
| Only our two keys in `~/.claude/settings.json` are touched, and only removed if they still hold the value we wrote | `claude-settings.js` | That file also holds permissions, hooks, and MCP config. |
| The gateway runs as a child process, not in-process | `supervisor.js` | The gateway calls `process.exit(1)` on bad config or a failed listen; in-process that would kill the app. |
| The renderer makes no network requests | `index.html` CSP, `gateway-client.js` | `connect-src 'none'` removes the CORS surface entirely; all data arrives over IPC. |
| Port changes rewrite `~/.claude/settings.json` when routing is on | `ipc.js` (`gateway:usePort`) | The port is stored there as a literal, so moving the gateway would otherwise silently break Claude Code. |

## Phases

- **Phase 1 — process lifecycle.** Window, tray, supervisor, log file with rotation, port
  conflict detection with a one-click "use the next free port". *Done.*
- **Phase 2 — providers.** Read/mask/merge/validate/write, conflict guard, reorder, per-provider
  sanitize pin, direct probe. *Done.*
- **Phase 3 — usage.** Tiles, 14-day cost chart, per-provider stacked split, recent calls, CSV
  export through a native save dialog. *Done.*
- **Phase 4 — setup.** Claude Code wiring with a plan/diff dialog before writing, account
  detection, port/strategy/log-level controls, autostart. *Done.*
- **Phase 5 — packaging.** `electron-builder` deb + AppImage, native-module unpacking, generated
  icon. *Done — see `EXECUTION.md` for the two constraints that shaped it.*
- **Phase 6 — tests and docs.** `node --test` coverage for the main-process modules that own
  files, plus this document and `EXECUTION.md`. *Done.*

## Next

Roughly in the order that adds the most value per unit of work.

1. **First-run wizard.** `settings.setupCompleted` is already persisted and nothing reads it yet.
   A three-step wizard (add a provider → route Claude Code → show the tray) would replace the
   current "figure out the Setup tab" flow.
2. **macOS and Windows targets.** `electron-builder.yml` only defines `linux`. `autostart.js`
   returns `supported: false` off Linux, where `app.setLoginItemSettings` is the right call
   instead. `claude-account.js` already reports `loggedIn: null` for the macOS Keychain case.
3. **Health history.** `/stats` health is in-memory and resets when the gateway restarts, so the
   UI can only show "now". Persisting a small failure log would let the dashboard explain
   *why* a provider keeps cooling down.
4. **Provider import/export.** A JSON import that runs through the same validation path, so a
   curated list can move between machines without hand-copying keys.
5. **Auto-update.** `electron-updater` needs a publish target and code signing; worth doing only
   once there is somewhere to publish to.
6. **Renderer tests.** The views are plain functions over `state`, so a DOM harness could cover
   them; today only the main process is tested.
