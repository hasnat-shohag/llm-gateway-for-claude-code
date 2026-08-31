# Desktop app — execution log

State of the `desktop/` app as verified on 2026-08-30, on Ubuntu (GNOME/Wayland, x64, Node 22).
`PLAN.md` covers what it is and where it is going; this file covers what has actually been run,
what the packaging constraints turned out to be, and what is still unproven.

## What was verified

| Check | Command | Result |
| --- | --- | --- |
| Gateway typecheck | `npm run typecheck` (repo root) | clean |
| Gateway tests | `npm test` (repo root) | 3 files, 3 pass |
| Gateway compiles for the app | `desktop/ npm run build:gateway` | `build/gateway/` + ESM marker written |
| Desktop main-process tests | `desktop/ npm test` | 59 tests, 58 pass, 1 skipped (a non-Linux-only case) |
| Icon generation | `desktop/ npm run gen:icon` | `build-resources/icon.png`, 1024×1024 RGBA |
| Packaging (AppImage) | `desktop/ npm run dist` | `release/LLM Gateway-0.1.0.AppImage` (~124 MB) |
| Packaging (deb) | same run | **fails on this host**: fpm needs `ar` (`binutils`), which is not installed |
| App launch | `desktop/ npm start` | window + tray, renderer loaded, no errors |
| Packaged app launch | `release/linux-unpacked/llm-gateway --user-data-dir=<tmp>` | booted, supervised gateway answered `/health` on its configured port |
| Supervised gateway | `curl 127.0.0.1:<port>/health`, `/providers` | `{"status":"ok"}`, provider list served |
| First-run migration | — | repo-root `providers.json` copied into `userData` |
| Own database | — | `userData/usage.db` created by the child, not the repo copy |
| Clean shutdown | `SIGTERM` to the main process | child exited, port released, no orphan |
| Packaged bundle contents | `asar list` + `find app.asar.unpacked` | compiled gateway (13 files, incl. the ESM marker) inside the asar; `better_sqlite3.node` unpacked beside it |

Test coverage is on the main-process modules that own files or make irreversible changes:
`schema.js` (validation via the gateway's own zod schema), `providers-store.js` (masking, merge,
conflict guard, in-place write, `.bak`), `claude-settings.js` (merge/plan/apply, credential
rules, backups), `settings-store.js` (coercion), `autostart.js` (XDG entry). Electron is stubbed
by injecting a fake `app` into `require.cache`; `~/.claude` is sandboxed through
`CLAUDE_CONFIG_DIR`.

## What is not proven

- **A real proxied request through the app's gateway.** A synthetic `curl` to
  `POST /v1/messages` failed with `all providers failed / HTTP 403` — but the same request
  against a separately running dev gateway on port 8080 failed identically, so this is the
  request being rejected by the upstreams (no real Claude Code client credential or
  fingerprint), not a fault in the app's supervision. The proxy path itself is the unmodified
  gateway code, which the Docker setup exercises daily.
- **The UI beyond "it rendered".** There is no automated renderer test and no screenshot-based
  check; the window was confirmed to load and the renderer to run (it wrote its Local Storage),
  but each panel's behavior has only been exercised by hand.
- **deb installation.** The deb target has never produced an artifact on this host: fpm shells
  out to `ar`, which lives in `binutils` and is not installed (`Need executable 'ar' to convert
  dir to deb`). Install `binutils` — or build the deb elsewhere — before trusting the
  `/usr/bin/llm-gateway` symlink, the installed icon name, or the `.desktop` association, all of
  which are currently inferred from electron-builder's configuration rather than observed. The
  AppImage is unaffected and does build.
- **macOS and Windows.** Not built and not run. `electron-builder.yml` defines Linux targets
  only, and `autostart.js` reports `supported: false` off Linux.

## Constraints discovered while packaging

Four of these cost real time; all four are load-bearing.

1. **Electron must stay on 42.x.** `better-sqlite3` 12.11.1 publishes Electron prebuilds up to
   ABI 146 (Electron 42). Electron 43 is ABI 148, so `electron-builder install-app-deps` finds no
   prebuild, falls back to `node-gyp`, and fails with `not found: make` on a host without a
   compiler. The dependency is pinned exactly (`"electron": "42.10.1"`) for that reason. Bumping
   it means either waiting for a matching prebuild or accepting `make` + `g++` + `python3` as
   build requirements.
2. **`@electron/rebuild` caches its work in `build/Release/.forge-meta`.** Deleting
   `better_sqlite3.node` without deleting that marker makes `install-app-deps` a no-op — it
   prints `finished` and does nothing, and the resulting package silently ships with no native
   addon. Verify the addon by *opening a database* in plain Node: `require('better-sqlite3')`
   alone does not load the binding, so it succeeds either way. With a correct Electron build,
   `new (require('better-sqlite3'))(':memory:')` under plain Node must fail with a
   `NODE_MODULE_VERSION` error.
3. **Electron's Wayland backend segfaults here.** `new BrowserWindow()` dies with `SIGSEGV`
   before `ready-to-show` under GNOME/mutter, so the app never appears. Only a real
   command-line `--ozone-platform=x11` avoids it: Ozone is selected during Electron's startup,
   before the app's JS runs, so `app.commandLine.appendSwitch('ozone-platform', …)` is too late,
   and neither `--ozone-platform-hint=x11` nor `ELECTRON_OZONE_PLATFORM_HINT=x11` helped (all
   three measured). The flag therefore lives in the `start` script and in
   `linux.executableArgs`; passing `--ozone-platform=wayland` after it opts back into Wayland.
4. **electron-builder metadata that is not optional.** `linux.desktopName` was removed in
   electron-builder 25+ (it is `desktopName` in `package.json` plus `linux.syncDesktopName`),
   the deb target refuses to build without `homepage` and a `maintainer`, and `*.node` must be
   in `asarUnpack` because `process.dlopen` cannot load a native addon from inside an asar.
5. **The deb target needs `binutils` on the build host.** fpm shells out to `ar`; without it the
   AppImage still builds and only the deb step fails. Nothing in the repo can work around this —
   it is a host package.

## Notes for whoever picks this up

- `settings-store.js` coerces field-wise against its defaults, so an unrecognized patch value
  resets that field rather than keeping the previous one. Unreachable through IPC (which
  validates first), and the test documents it rather than treating it as a bug.
- Two `providers.json` files exist once the app has run: the repo's (used by Docker) and
  `userData/providers.json` (used by the app). They are copied once at first run and never
  synced again.
- Everything the app writes lives under `~/.config/llm-gateway-desktop/` on Linux
  (`providers.json`, `providers.json.bak`, `settings.json`, `usage.db*`, `logs/gateway.log`).
  Deleting that directory is a clean factory reset.
- `~/.claude/settings.json` is only ever touched from an explicit UI action or the tray toggle,
  and each write leaves a timestamped `.bak-…` sibling next to it.
