# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Electron desktop app that supervises a local LLM gateway — an Anthropic-compatible HTTP proxy
that load-balances Claude Code across multiple providers — and gives it a GUI: provider CRUD,
health, token cost, and the `~/.claude/settings.json` wiring that points Claude Code at it.

The gateway is not written here. Its TypeScript source is **vendored** into `gateway-src/` from
`https://github.com/hasnat-shohag/llm-gateway-for-claude-code` so this repository builds standalone;
`gateway-src/VENDOR.md` records the upstream commit and the refresh procedure. The app compiles that
source to `build/gateway/`, runs it as a child process, and talks to its existing read-only HTTP
endpoints. It never modifies the gateway's request path.

CommonJS, no bundler, no framework, no build step for the app's own code — only the vendored
gateway is compiled.

## Commands

```bash
npm install          # postinstall runs electron-builder install-app-deps (native ABI rebuild)
npm start            # build:gateway, then electron . --ozone-platform=x11
npm test             # build:gateway, then node --test test/*.test.js (60 tests)
npm run typecheck    # tsc --noEmit over gateway-src/
npm run build:gateway  # tsc -p tsconfig.gateway.json + the ESM marker script
npm run dist         # deb + AppImage into release/
npm run gen:icon     # regenerate build-resources/icon.png

# One test file, or one test by name:
node --test test/providers-store.test.js
node --test --test-name-pattern 'masks' test/providers-store.test.js
```

`build:gateway` is a dependency of `start`, `test`, and `dist` — nothing runs against a stale
`build/gateway/`. Tests need it because `main/schema.js` imports the compiled gateway's zod schema.

Running the app while a separate gateway already holds port 8080 is a supported state, not a
failure: the supervisor reports `port-in-use` and the UI offers the next free port.

## Architecture

Three processes, and the boundaries between them are the design:

```
main (CommonJS, Node)  ──IPC──  preload (allowlist)  ──  renderer (vanilla ESM, app:// scheme)
      │
      └── utilityProcess.fork → build/gateway/index.js (ESM) → 127.0.0.1:<port>
```

**Main process** (`main/`, ~1,400 lines): the only place with filesystem, network, and credential
access.

- `main.js` — window, tray, app lifecycle. Closing the window hides to tray; only explicit quit exits.
- `supervisor.js` — forks the gateway, exponential backoff restarts (500 ms → 30 s), port probing,
  log rotation at 2 MB.
- `paths.js` — every absolute path in one place, handed to the child as env vars, because the gateway
  resolves its files relative to cwd and cwd is arbitrary in a packaged app.
- `providers-store.js` — read/mask/merge/validate/write `providers.json`.
- `schema.js` — dynamic `import()` of the compiled gateway's `providersArraySchema` (CJS → ESM).
- `settings-store.js` — port / strategy / logLevel / pollMs / setupCompleted in userData.
- `claude-settings.js` — the `~/.claude/settings.json` merge, as plan-then-apply.
- `claude-account.js` — login *presence* check only.
- `provider-probe.js` — one-shot direct request to one provider, bypassing the gateway.
- `gateway-client.js` — HTTP client for `/health`, `/stats`, `/providers`, `/usage*`, with a 2 s memo.
- `autostart.js` — XDG autostart entry (Linux only).
- `ipc.js` — the named channels, re-validating every payload.

**Renderer** (`renderer/`): plain functions over a single shared `state` object. `store.js` owns one
poll loop for every view, paused while the window is hidden. `app.js` owns the frameless titlebar, tab
routing, the banner, and the status bar; `providers.js` / `dashboard.js` / `settings.js` are the three
tabs; `onboarding.js` replaces all three on first run; `charts.js` renders inline SVG; `icons.js` is
the authored 16px icon set; `dom.js` is the element helper.

- `main/theme.js` — the whole theming mechanism is `nativeTheme.themeSource`. The stylesheet has one
  `:root` block and one `prefers-color-scheme` media query, no `[data-theme]` selector, so a stored
  `light` / `dark` preference works by making Chromium lie about the OS preference.
- Charts measure their container and draw at 1:1 through one shared `ResizeObserver`, rather than
  scaling a fixed `viewBox` — a scaled viewBox scales the 10px tick text with it.
- `scripts/cdp-shot.js` screenshots the running window over CDP, for looking at the real renderer with
  real data in it: `node scripts/cdp-shot.js <ws-url> <out.png> [tab] [dark|light|system] [scrollY]`.
  Tab ids are `providers`, `dashboard`, `settings` — the labels read Providers / Usage / Setup.

**Build pipeline:** `tsconfig.json` holds the compiler options mirrored from upstream (ESM,
`moduleResolution: bundler`, `verbatimModuleSyntax` — which is why `gateway-src` imports carry `.js`
extensions on `.ts` files). `tsconfig.gateway.json` extends it with the `gateway-src` → `build/gateway`
mapping. `scripts/finalize-gateway-build.js` then writes a nested `package.json` marking that subtree
`"type": "module"`; without it Node resolves the output as CJS and dies on the first `import`.

## Invariants that fail silently if broken

Each of these prevents a specific failure that produces no error message.

| Rule | Where | Why |
| --- | --- | --- |
| Write `providers.json` **in place** — never temp-file-plus-rename | `providers-store.js` | The gateway's `fs.watch` binds to the inode; a rename makes hot reload go deaf. |
| Validate with the gateway's own zod schema, never a copy | `schema.js` | The gateway ignores a file it rejects, so a drifted copy would let the UI show a provider list the gateway never adopted. |
| Full API keys never leave the main process | `providers-store.js`, `preload.js` | The renderer sees masks (`sk-abc…1234`) and returns `__UNCHANGED__`; a payload containing the mask character is rejected. |
| Write no gateway credential when a Claude Code login exists | `claude-settings.js` | The *absence* of `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` is what keeps the subscription active, which is what makes a `passthrough` provider work. |
| Touch only the two keys we own in `~/.claude/settings.json`, and remove one only if it still holds the value we wrote | `claude-settings.js` | That file also holds permissions, hooks, and MCP config. Every write leaves a timestamped `.bak-…` sibling. |
| Never read `~/.claude/.credentials.json` | `claude-account.js` | Single-use rotating refresh tokens, plus Anthropic's terms. Presence only. |
| Run the gateway as a child process, never in-process | `supervisor.js` | It calls `process.exit(1)` on bad config, a failed listen, or an unexpected `uncaughtException`. |
| `exclusive: true` on the port probe | `supervisor.js` | Node sets `SO_REUSEADDR` by default, so without it the probe succeeds against a live listener and the supervisor forks into a restart loop instead of reporting the conflict. |
| `port-in-use` deliberately does not retry | `supervisor.js` | Retrying cannot free a port; the UI offers a free one instead. |
| A port change rewrites `~/.claude/settings.json` when routing is on | `ipc.js` (`gateway:usePort`) | The port is stored there as a literal, so moving the gateway would otherwise silently break Claude Code. |
| The renderer makes no network request | `index.html` CSP, `gateway-client.js` | `connect-src 'none'` removes the CORS surface entirely; all data arrives over IPC. |
| The renderer is served over `app://`, not `file://` | `main.js` | Chromium gives `file://` pages an opaque origin, which blocks ES module imports outright. The protocol handler containment-checks every path against `renderer/`. |
| `preload.js` exposes named channels, never a generic `invoke` | `preload/preload.js` | The preload boundary is not a trust boundary — `ipc.js` re-validates anyway. |
| `strategy` and `logLevel` need a gateway restart | `ipc.js` (`settings:update`) | Both are read from env at fork time. |
| Do not edit `gateway-src/` to change gateway behavior | `gateway-src/VENDOR.md` | Fix it upstream and re-copy, or the schema-reuse invariant above becomes a lie. |
| Every element hidden by the `hidden` attribute needs its own `[hidden] { display: none }` rule | `styles.css` | Any author `display` beats the UA sheet, so `.tabs`, `.field`, `.view`, `.banner`, `.notice` each opt out explicitly. Without it the element stays on screen with no error anywhere. |
| No inline `style=""` in the renderer | `index.html` CSP | `style-src 'self'` with no `'unsafe-inline'`. Runtime colors go through `style.setProperty` (CSSOM) or SVG presentation attributes. |
| `ResizeObserver` hosts must be unobserved when detached | `charts.js` | `observe()` holds a strong reference and the dashboard rebuilds its charts on every 5 s tick, so a discarded host would never be collected. Detaching fires an observation, which is where the entry is dropped. |
| `startPolling` ticks once before starting the interval | `store.js` | Otherwise every gateway-derived cell skeletons for a full interval after boot, and an occluded window (which the tick skips) never fills them in at all. |

## Platform and packaging constraints

- **Electron is pinned to `42.10.1` exactly.** `better-sqlite3` 12.11.1 ships Electron prebuilds up
  to ABI 146 (Electron 42); Electron 43 is ABI 148, so `install-app-deps` falls back to `node-gyp`
  and fails on a host without `make`. Bumping means waiting for a prebuild or accepting
  `make` + `g++` + `python3` as build requirements.
- **`--ozone-platform=x11` has to be a real command-line argument.** Electron's Wayland backend
  segfaults on window creation under GNOME/mutter, and Ozone is selected before the app's JS runs, so
  `app.commandLine.appendSwitch`, `--ozone-platform-hint=x11`, and `ELECTRON_OZONE_PLATFORM_HINT=x11`
  are all too late (measured). It lives in the `start` script and `linux.executableArgs`.
- **`asarUnpack` for `*.node`** — `process.dlopen` cannot load a native addon from inside an asar.
- **Verify the native addon by opening a database**, not by requiring the module:
  `require('better-sqlite3')` alone does not load the binding. Under plain Node,
  `new (require('better-sqlite3'))(':memory:')` must *fail* with a `NODE_MODULE_VERSION` error when
  the Electron build is correct. `@electron/rebuild` also caches in
  `build/Release/.forge-meta`, so deleting the `.node` without that marker makes `install-app-deps` a
  silent no-op.
- **The deb target needs `binutils`** on the build host (fpm shells out to `ar`). The AppImage builds
  without it. Nothing in the repo can work around this.
- `linux.executableName: llm-gateway` is load-bearing three times over: the deb's `/usr/bin` symlink
  that `autostart.js` looks for, the installed icon name that the autostart entry's `Icon=` must
  match, and `desktopName` in `package.json` + `linux.syncDesktopName` for window/tray association.
- Only Linux targets exist. `autostart.js` returns `supported: false` elsewhere;
  `app.setLoginItemSettings` would be the macOS/Windows path.

## Tests

`node --test` over the main-process modules that own files or make irreversible changes. Electron is
stubbed by injecting a fake `app` into `require.cache` *before* the first `require('electron')`
(`test/helpers/electron-stub.js`), each install getting a fresh `mkdtemp` root; `~/.claude` is
sandboxed through `CLAUDE_CONFIG_DIR`. The `providers-store` tests seed the temp
`userData/providers.json` first so `ensureProvidersFile()`'s migration never copies real keys into the
sandbox. One test is skipped off-Linux by design. There are no renderer tests.

## Runtime layout

Everything the app writes lives under `~/.config/llm-gateway-desktop/` on Linux — `providers.json`,
`providers.json.bak`, `settings.json`, `usage.db*`, `logs/gateway.log`. Deleting that directory is a
clean factory reset. A `providers.json` at the repo root (or `GATEWAY_PROVIDERS_SEED`) is only a
first-run migration source; see `providers.example.json` for the shape.

## Further reading

`ARCHITECTURE.md` — the full technical reference: process model, module map, request lifecycle,
telemetry, packaging, runbook. `PLAN.md` — the design rationale and the roadmap. `EXECUTION.md` —
what has actually been run and what is still unproven. `gateway-src/VENDOR.md` — how to refresh the
vendored gateway.
