# Architecture and technical reference

**LLM Gateway Desktop** — an Electron application that supervises a local, Anthropic-compatible
HTTP gateway and gives it a graphical interface: provider CRUD, health and cost telemetry, and the
`~/.claude/settings.json` wiring that points Claude Code at the gateway.

*Document revision: 2026-09-01. Companion documents: `PLAN.md` (design rationale and roadmap),
`EXECUTION.md` (what has actually been run), `CLAUDE.md` (working rules for contributors and
agents), `gateway-src/VENDOR.md` (how the vendored gateway is refreshed).*

---

## 1. At a glance

| Property | Value |
| --- | --- |
| Application code | CommonJS main process, vanilla ESM renderer — no framework, no bundler |
| Compiled code | Only `gateway-src/` (TypeScript → `build/gateway/`, ESM) |
| Size | main ≈ 1,730 lines · renderer ≈ 3,340 lines · preload 79 lines · vendored gateway ≈ 1,957 lines |
| Electron | pinned to `42.10.1` exactly (native-addon ABI constraint, §10) |
| Native dependency | `better-sqlite3` 12.11.1, used only by the gateway child process |
| Supported platform | Linux (deb, AppImage). Autostart and packaging are Linux-specific |
| Network exposure | loopback only — the gateway binds `127.0.0.1`; the renderer makes no network requests at all |
| Test suite | `node --test` over the main-process modules that own files (60 tests) |

The gateway itself is **not authored here**. Its TypeScript source is vendored from
`hasnat-shohag/llm-gateway-for-claude-code` into `gateway-src/` so this repository builds
standalone. The application compiles that source, runs it as a child process, and consumes its
existing read-only HTTP endpoints. It never modifies the gateway's request path.

---

## 2. System context

```
┌────────────┐   ANTHROPIC_BASE_URL      ┌──────────────────────┐   provider key    ┌──────────────┐
│ Claude Code│ ────────────────────────▶ │  gateway (child)     │ ────────────────▶ │ provider 1..n│
│   (CLI)    │      127.0.0.1:<port>     │  Fastify, ESM, Node  │   bearer/x-api-key│  (HTTPS)     │
└────────────┘ ◀──────────────────────── └──────────────────────┘ ◀──────────────── └──────────────┘
                       response                  ▲       │
                                        supervise │       │ /health /stats /providers /usage*
                                                  │       ▼
                                        ┌──────────────────────────┐
                                        │  Desktop app (Electron)  │
                                        │  main · preload · UI     │
                                        └──────────────────────────┘
                                                  │
                                  reads/writes    ▼
                        providers.json · settings.json · usage.db · ~/.claude/settings.json
```

Two planes, deliberately separated:

- **Data plane** — Claude Code's requests, handled entirely by the gateway child process. The
  desktop app is not in this path and cannot slow it down or break it.
- **Control plane** — configuration, supervision, and telemetry. The app owns this and touches the
  data plane only through files the gateway watches and through read-only HTTP endpoints.

---

## 3. Process model

```
main (CommonJS, Node)  ──IPC──▶  preload (allowlist)  ──▶  renderer (vanilla ESM, app:// scheme)
      │
      └── utilityProcess.fork ──▶ build/gateway/index.js (ESM) ──▶ 127.0.0.1:<port>
```

| Process | Privileges | Responsibility |
| --- | --- | --- |
| **Main** | filesystem, network, credentials | Window and tray lifecycle, gateway supervision, all file I/O, all HTTP to the gateway, IPC validation |
| **Preload** | `contextBridge` only | Exposes ~26 *named* channels — never a generic `invoke`. Not a trust boundary; `ipc.js` re-validates every payload |
| **Renderer** | none | Presentation and interaction only. `connect-src 'none'` removes the network surface entirely |
| **Gateway child** | filesystem, outbound HTTPS | Serves the Anthropic-compatible API, selects providers, records usage |

The gateway runs as a **child process, never in-process**: it calls `process.exit(1)` on invalid
configuration, on a failed listen, and on an unexpected `uncaughtException`. In-process, any of
those would take the whole application down with it.

---

## 4. Module map

### 4.1 Main process (`main/`)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `main.js` | 259 | Window, tray, app lifecycle, `app://` protocol handler. Closing the window hides to tray; only explicit quit exits |
| `supervisor.js` | 228 | Forks the gateway, port probing, exponential-backoff restarts, log rotation |
| `ipc.js` | 230 | The named channel surface; re-validates every payload |
| `claude-settings.js` | 192 | `~/.claude/settings.json` merge, expressed as plan-then-apply |
| `providers-store.js` | 186 | Read / mask / merge / validate / write `providers.json` |
| `paths.js` | 122 | Every absolute path in one place, handed to the child as environment variables |
| `provider-probe.js` | 103 | One-shot direct request to a single provider, bypassing the gateway |
| `autostart.js` | 96 | XDG autostart entry (Linux only) |
| `schema.js` | 79 | Dynamic `import()` of the compiled gateway's own zod schema (CJS → ESM) |
| `gateway-client.js` | 78 | HTTP client for `/health`, `/stats`, `/providers`, `/usage*`, with a 2-second memo |
| `settings-store.js` | 72 | port / strategy / logLevel / pollMs / setupCompleted / theme, in userData |
| `theme.js` | 47 | Theme preference expressed purely as `nativeTheme.themeSource` |
| `claude-account.js` | 38 | Claude Code login **presence** check only |

### 4.2 Renderer (`renderer/`)

Plain functions over a single shared `state` object; no framework, no reactive layer.

| Module | Lines | Responsibility |
| --- | --- | --- |
| `styles.css` | 859 | One `:root` block plus one `prefers-color-scheme` query — no `[data-theme]` selector |
| `providers.js` | 493 | Provider list, add/edit dialog, probe, reorder |
| `settings.js` | 306 | Port, strategy, log level, autostart, theme, Claude Code routing toggle |
| `app.js` | 304 | Frameless titlebar, tab routing, banner, status bar |
| `dashboard.js` | 284 | Health, request stats, cost summary, CSV export |
| `dom.js` | 279 | Element helper (`el`, `field`, …) |
| `charts.js` | 248 | Inline SVG charts drawn at 1:1 through one shared `ResizeObserver` |
| `icons.js` | 185 | Authored 16 px icon set |
| `onboarding.js` | 176 | First-run flow; replaces all three tabs |
| `store.js` | 134 | One poll loop for every view, paused while the window is hidden |
| `index.html` | 72 | Markup and the Content-Security-Policy |

### 4.3 Vendored gateway (`gateway-src/`)

| Module | Lines | Responsibility |
| --- | --- | --- |
| `proxy.ts` | 607 | Request lifecycle: header construction, sanitization, failover, streaming, usage capture |
| `usage-tracker.ts` | 299 | SQLite persistence and cost aggregation |
| `utils.ts` | 181 | Retry classification, header helpers, passthrough terminal-status rule |
| `config.ts` | 179 | Environment and `providers.json` schemas (zod), hot reload |
| `server.ts` | 133 | Fastify routes and the `/stats` projection |
| `types.ts` | 128 | Shared types, including `AuthStyle` |
| `sanitize-learner.ts` | 100 | Per-provider sanitize mode, learned at runtime or pinned by config |
| `health.ts` | 98 | Consecutive-failure counting and cooldown |
| `provider-manager.ts` | 78 | Selection strategies: `random`, `round-robin`, `weighted` |
| `index.ts` / `logger.ts` / `metrics.ts` | 154 | Bootstrap, pino logger, latency reservoir |

---

## 5. Trust and data boundaries

```
   renderer                     preload                      main                    child
┌──────────────┐  named       ┌──────────┐  ipcMain.handle ┌───────────────┐  env  ┌──────────┐
│ masks only   │ ───────────▶ │ allowlist│ ──────────────▶ │ full secrets  │ ────▶ │ gateway  │
│ sk-abc…1234  │  channels    │ 26 calls │   re-validated  │ providers.json│       │          │
└──────────────┘              └──────────┘                 └───────────────┘       └──────────┘
```

| Boundary | Enforcement | What it prevents |
| --- | --- | --- |
| Full API keys never leave main | `providers-store.js`, `preload.js` | The renderer receives masks and returns the sentinel `__UNCHANGED__`; a payload containing the mask character is rejected outright |
| Renderer makes no network request | `index.html` CSP `connect-src 'none'`, `gateway-client.js` | Removes the CORS surface; all data arrives over IPC |
| Renderer served over `app://`, not `file://` | `main.js` protocol handler | Chromium gives `file://` pages an opaque origin, which blocks ES module imports. The handler containment-checks every path against `renderer/` |
| No inline styles | CSP `style-src 'self'` | Runtime colors go through `style.setProperty` (CSSOM) or SVG presentation attributes |
| `~/.claude/.credentials.json` is never read | `claude-account.js` | Single-use rotating refresh tokens, plus Anthropic's terms. Presence only |
| Gateway binds loopback | `supervisor.js` sets `HOST=127.0.0.1` | The gateway holds plaintext provider keys and proxies anything that reaches it |

---

## 6. Control plane

### 6.1 Supervision state machine

```
        ┌─────────┐   start()   ┌──────────┐  listening   ┌─────────┐
        │ stopped │ ──────────▶ │ starting │ ───────────▶ │ running │
        └─────────┘             └──────────┘              └─────────┘
             ▲                       │                        │
             │ stop()                │ port occupied          │ exit(code)
             │                       ▼                        ▼
             │                ┌──────────────┐          ┌─────────┐
             └──────────────── │ port-in-use │          │ crashed │
                              └──────────────┘          └─────────┘
                              no retry — the UI            backoff restart
                              offers the next free port    500 ms → ×2 → 30 s cap
```

- **Port probe uses `exclusive: true`.** Node sets `SO_REUSEADDR` by default, so without it the
  probe succeeds against a live listener and the supervisor forks into a restart loop instead of
  reporting the conflict.
- **`port-in-use` deliberately does not retry.** Retrying cannot free a port. `findFreePort()` scans
  up to 20 ports from the configured one so the UI can offer a one-click fix.
- Running the application while a separate gateway already holds the port is a *supported state*,
  not a failure.
- Child stdout/stderr are appended to `logs/gateway.log`, rotated at 2 MB.

Environment handed to the child at fork time (`supervisor.js:buildEnv`):

| Variable | Source | Changing it requires |
| --- | --- | --- |
| `HOST` | hard-coded `127.0.0.1` | — |
| `PORT` | settings store | restart (automatic on port change) |
| `PROVIDERS_PATH` | `paths.js` | — |
| `USAGE_DB_PATH` | `paths.js` | — |
| `STRATEGY` | settings store | **gateway restart** — read from env at fork |
| `LOG_LEVEL` | settings store | **gateway restart** — read from env at fork |
| `NODE_ENV` | hard-coded `production` | — |

Gateway defaults *not* overridden by the app: `REQUEST_TIMEOUT` 60,000 ms, `STREAM_TIMEOUT`
300,000 ms, `HEALTH_FAILURE_THRESHOLD` 3, `HEALTH_COOLDOWN_MS` 60,000 ms.

### 6.2 Provider write path

```
renderer draft ──▶ ipc providers:save ──▶ merge with stored keys ──▶ zod validate (gateway's own schema)
                                                    │                          │
                                        __UNCHANGED__ resolves to           reject → error to UI,
                                        the stored secret                  file untouched
                                                    ▼
                                     write providers.json IN PLACE
                                                    │
                                        gateway fs.watch ──▶ "providers.json hot-reloaded"
```

Two invariants carry this path:

1. **Write in place — never temp-file-plus-rename.** The gateway's `fs.watch` binds to the inode; a
   rename makes hot reload go deaf, and nothing reports an error.
2. **Validate with the gateway's own zod schema, never a copy** (`schema.js` dynamically imports
   `providersArraySchema` from the compiled output). The gateway silently ignores a file it rejects,
   so a drifted copy would let the UI display a provider list the gateway never adopted.

A `.bak` sibling is kept, and key ordering is normalised to
`name, baseUrl, apiKey, enabled, weight, authStyle, sanitize`.

### 6.3 Claude Code wiring

`claude-settings.js` is a **plan-then-apply** pair: `plan(route)` computes the next file, the diff,
and any warnings; `apply(route)` writes it after copying the current file to a timestamped
`settings.json.bak-<ISO>` sibling.

Rules encoded there:

- **Merge, never replace.** That file also holds permissions, hooks, and MCP configuration.
- **Touch only the two keys we own** (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`), and remove one
  only if it still holds the value we wrote — so a hand-edited value is never silently discarded.
- **Write no gateway credential when the subscription is the credential in play.** The *absence* of
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` is what keeps the subscription as the active
  credential, which is what makes a `passthrough` provider work. That absence is only withheld when
  something can actually use it: `claudeSettings.usesSubscription()` requires both a login
  (`claudeAccount.detect()` not reporting `loggedIn === false`) **and** an enabled `passthrough`
  provider (`providersStore.hasEnabledPassthrough()`, read straight off `providers.json` because
  `plan()` is synchronous). Otherwise the placeholder `llm-gateway-local` is written —
  recognisable, so "route off" knows it is safe to remove.

  A login alone is not enough: Claude Code pointed at a custom `ANTHROPIC_BASE_URL` with nothing in
  `env` runs its OAuth login flow rather than talking to the gateway, so withholding the placeholder
  with no passthrough provider enabled costs a login prompt on every new session and buys nothing.
  An unparseable `providers.json` reads as "yes, in use", because a false negative there would
  overwrite a working subscription credential.
- A **provider save rewrites the file** when routing is on (`ipc.js` → `providers:save`): enabling or
  disabling a passthrough provider flips which side of the rule above applies. `apply(true)` is a
  no-op when the plan holds no changes, so it only writes when that actually changed.
- A **port change rewrites the file** when routing is on (`ipc.js` → `gateway:usePort`): the port is
  stored there as a literal, so moving the gateway would otherwise silently break Claude Code.

Claude Code reads settings only at startup, so the UI must say that a change needs a restart.

### 6.4 IPC surface

| Namespace | Channels |
| --- | --- |
| `providers` | `list`, `save`, `probe` |
| `gateway` | `state`, `health`, `stats`, `enabledNames`, `restart`, `usePort`, `suggestPort` |
| `usage` | `summary`, `cost`, `export` |
| `settings` | `get`, `update`, `setAutostart` |
| `claude` | `status`, `account`, `plan`, `apply` |
| `win` / `shell` | `minimize`, `toggleMaximize`, `close`, `isMaximized`, `openLog`, `openExternal` |
| push events | `gateway:state-changed`, `win:maximize-changed` |

---

## 7. Data plane — request lifecycle

The path a single Claude Code request takes through the gateway (`gateway-src/proxy.ts`):

```
client request
   │
   ├─ generate requestId
   │
   ▼
while (attempted < providerCount):          ← each provider is tried at most once per request
   │
   ├─ providerManager.selectExcluding(attempted)      strategy: random | round-robin | weighted
   │      skips providers in health cooldown
   │
   ├─ modesFor(provider):
   │      passthrough      → [false]              never sanitized, never flipped
   │      learned/pinned   → [mode]
   │      unlearned        → [guess, !guess]      one flip available to discover the mode
   │
   ├─ build headers
   │      passthrough  → forward the client's Authorization verbatim, keep anthropic-beta
   │      bearer       → strip client auth, set  Authorization: Bearer <providerKey>
   │      x-api-key    → strip client auth, set  x-api-key: <providerKey>
   │      always       → host rewrite, anthropic-version fallback, accept-encoding: identity
   │
   ├─ send upstream, then classify the response:
   │      2xx                        → stream through, capture usage, done
   │      passthrough 401/403/429    → TERMINAL: forward to the client, no failover
   │      400/401 (non-passthrough)  → sanitize mismatch: flip mode, retry the SAME provider
   │      retryable (5xx, 403, 429, Cloudflare 52x) → record failure, next provider
   │      other                      → non-retryable: forward status as-is
   │
   └─ transport error → record failure, next provider
   │
   ▼
all providers exhausted → 503 {"error":"all providers failed","requestId","retries","details"}
```

### 7.1 Why passthrough terminates instead of failing over

`utils.ts:isTerminalForPassthrough` returns true for 429, 401, and 403. Failing over on those is
actively harmful:

- **429** — the *subscription's* own quota is exhausted. Failing over would spend money on a paid
  third-party provider without being asked.
- **401 / 403** — the claude.ai login expired or lacks access. Only `/login` fixes it; no retry
  against any provider can succeed, and the client needs to see the real error.

Consequence worth internalising: **a passthrough provider is the only provider whose auth error can
reach the client verbatim.** Every non-passthrough 401 is absorbed by the sanitize flip, and every
403 fails over.

### 7.2 The sanitize learner

Some third-party proxies reject requests that still carry Claude Code's fingerprint (beta flags,
system-prompt markers); others reject requests that have had it stripped. `sanitize-learner.ts`
records one boolean per provider, learned from the first mismatch and reused afterwards. A
`sanitize` value in `providers.json` pins the mode and opts the provider out of learning.
Passthrough is always `[false]`: sanitizing would strip `anthropic-beta`, which also carries the
OAuth capability the upstream requires, and the resulting 401 would be misread as a mismatch —
converging the learner on the wrong mode.

### 7.3 Health tracking

`health.ts` counts consecutive failures per provider; at the threshold (default 3) the provider is
marked unhealthy and given a cooldown (default 60 s), during which selection skips it. Cooldown
expiry is cleared lazily by `getProviders()`, so `snapshot()` normalises the state before exposing
it to `/stats` (`cooldownRemainingMs`).

### 7.4 Usage capture

Usage is parsed **inside the SSE transform** (`proxy.ts:157-206`): `message_start` supplies input
and cache tokens, `message_delta` accumulates output tokens, and the transform's `flush()` records
exactly once, only on clean completion — a truncated or aborted stream is a failed delivery and must
not contribute cost. There is deliberately no `error` handler that records usage.

**Implication:** non-streaming responses are proxied correctly but contribute **no** usage row.
Claude Code streams, so real traffic is metered; a non-streaming client is invisible in the
dashboard. See §12.

### 7.5 Observed trace (2026-08-31, five enabled `bearer` providers, `weighted`)

Four non-streaming test requests plus one streaming request from a live Claude Code session:

```
e566eef8  JW HS   200  rc=0  san=true   request completed
0878401d  TK Hera 403  rc=0  → GR HS 403 rc=1 → JW HS 200 rc=2
b6b7578a  TK Hera 403  rc=0  → JW HS 200 rc=1
6e5eeed0  AR 1    401  sanitize mismatch → flip → GR HS 403 → AR 3 OU 401 flip
                        → TK Hera 403 → JW HS 403 → all providers exhausted → 503
7b5d76c1  GR HS   200  rc=0  san=true   request completed + usage recorded
```

Three of the four test requests succeeded; the fourth exhausted all five providers and returned
`503 … "details":"HTTP 403"`. `AR 3 OU` reached three consecutive failures and entered a ~60 s
cooldown. Only the streaming request produced a `usage recorded` line. The test requests carried no
Claude Code fingerprint headers, which is why the 403 rate is higher than in real sessions — a
property of the harness, not of the gateway.

---

## 8. Telemetry and storage

### 8.1 Gateway HTTP surface (read-only, consumed by `gateway-client.js`)

| Route | Purpose |
| --- | --- |
| `GET /health` | `{"status":"ok"}` — liveness, 1.5 s timeout from the app |
| `GET /stats` | totals, per-provider requests/errors, retries, latency (mean/p50/p95 over the last 1024), unhealthy list, health snapshot, learned sanitize modes |
| `GET /providers` | enabled provider names |
| `GET /usage` | recent calls |
| `GET /usage/export` | CSV |
| `GET /usage/cost`, `GET /usage/cost/:date` | daily total plus per-provider and per-model splits |

Anything **not** matched by a route is proxied upstream as a normal request — an unknown path such
as `/usage/recent` becomes a real provider call, not a 404. The app memoises responses for 2 seconds
so the 5-second poll loop cannot amplify into request storms.

### 8.2 SQLite (`usage.db`, WAL mode)

```sql
CREATE TABLE IF NOT EXISTS api_calls (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp          TEXT    NOT NULL,
  date               TEXT    NOT NULL,
  provider           TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_calls_date ON api_calls(date);
```

### 8.3 Logs

The gateway logs newline-delimited JSON (pino) to stdout; the supervisor appends it to
`logs/gateway.log` with its own `[supervisor]` lines interleaved. Messages worth grepping for:
`request completed`, `usage recorded`, `provider returned retryable status code — retrying next`,
`sanitize mismatch — flipping mode and retrying same provider`, `passthrough provider returned a
terminal status — forwarding to client instead of failing over`, `all providers exhausted`,
`providers.json hot-reloaded`.

---

## 9. Renderer design notes

- **Theming is `nativeTheme.themeSource` and nothing else.** The stylesheet has one `:root` block
  and one `prefers-color-scheme` query, no `[data-theme]` selector, so a stored `light` / `dark`
  preference works by making Chromium report a different OS preference.
- **Charts measure their container and draw at 1:1** through one shared `ResizeObserver`, rather
  than scaling a fixed `viewBox` — a scaled viewBox scales the 10 px tick text with it. Hosts must
  be unobserved when detached: `observe()` holds a strong reference, and the dashboard rebuilds its
  charts every 5 s tick.
- **`startPolling` ticks once before starting the interval.** Otherwise every gateway-derived cell
  shows a skeleton for a full interval after boot, and an occluded window — whose ticks are skipped
  — never fills them in at all.
- **Every element hidden by the `hidden` attribute needs its own `[hidden] { display: none }`
  rule.** Any author `display` beats the UA sheet, so `.tabs`, `.field`, `.view`, `.banner`, and
  `.notice` each opt out explicitly. Without it the element stays on screen with no error anywhere.
- `scripts/cdp-shot.js` screenshots the running window over CDP for inspection with real data:
  `node scripts/cdp-shot.js <ws-url> <out.png> [tab] [dark|light|system] [scrollY]`. Tab ids are
  `providers`, `dashboard`, `settings`; the labels read Providers / Usage / Setup.

---

## 10. Build and packaging

```
tsconfig.json              compiler options mirrored from upstream
   │                       ESM · moduleResolution: bundler · verbatimModuleSyntax
   ▼                       (which is why gateway-src imports carry .js extensions on .ts files)
tsconfig.gateway.json      adds gateway-src → build/gateway
   ▼
scripts/finalize-gateway-build.js
   └─ writes a nested package.json marking build/gateway as {"type":"module"}
      without it Node resolves the output as CJS and dies on the first import
```

`build:gateway` is a dependency of `start`, `test`, and `dist`, so nothing ever runs against a stale
`build/gateway/`. The tests need it because `main/schema.js` imports the compiled gateway's schema.

| Command | Effect |
| --- | --- |
| `npm install` | postinstall runs `electron-builder install-app-deps` (native ABI rebuild) |
| `npm start` | `build:gateway`, then `electron . --ozone-platform=x11` |
| `npm test` | `build:gateway`, then `node --test test/*.test.js` |
| `npm run typecheck` | `tsc --noEmit` over `gateway-src/` |
| `npm run dist` | deb + AppImage into `release/` |

Packaging constraints, each one load-bearing:

- **Electron pinned to `42.10.1`.** `better-sqlite3` 12.11.1 ships Electron prebuilds up to ABI 146
  (Electron 42); Electron 43 is ABI 148, so `install-app-deps` falls back to `node-gyp` and fails on
  a host without `make`.
- **`--ozone-platform=x11` must be a real command-line argument.** Electron's Wayland backend
  segfaults on window creation under GNOME/mutter, and Ozone is selected before the application's
  JavaScript runs — `app.commandLine.appendSwitch`, `--ozone-platform-hint=x11`, and
  `ELECTRON_OZONE_PLATFORM_HINT=x11` are all too late (measured). It lives in the `start` script and
  in `linux.executableArgs`.
- **`asarUnpack` for `*.node`** — `process.dlopen` cannot load a native addon from inside an asar.
- **Verify the native addon by opening a database**, not by requiring the module. Under plain Node,
  `new (require('better-sqlite3'))(':memory:')` must *fail* with a `NODE_MODULE_VERSION` error when
  the Electron build is correct. `@electron/rebuild` also caches in `build/Release/.forge-meta`, so
  deleting the `.node` without that marker makes `install-app-deps` a silent no-op.
- **The deb target needs `binutils`** on the build host (fpm shells out to `ar`); the AppImage does
  not.
- `linux.executableName: llm-gateway` is load-bearing three times: the deb's `/usr/bin` symlink that
  `autostart.js` looks for, the installed icon name the autostart entry's `Icon=` must match, and
  `desktopName` + `linux.syncDesktopName` for window/tray association.

---

## 11. Runtime layout

Everything the application writes lives under `~/.config/llm-gateway-desktop/` on Linux:

| Path | Contents |
| --- | --- |
| `providers.json` | Provider list with plaintext keys — the file the gateway watches |
| `providers.json.bak` | Previous revision, written before each save |
| `settings.json` | `port`, `strategy`, `logLevel`, `pollMs`, `setupCompleted`, `theme` |
| `usage.db`, `usage.db-shm`, `usage.db-wal` | SQLite usage database (WAL) |
| `logs/gateway.log` | Gateway JSON log plus `[supervisor]` lines, rotated at 2 MB |

Deleting that directory is a clean factory reset. A `providers.json` at the repository root (or
`GATEWAY_PROVIDERS_SEED`) is only a first-run migration source; `providers.example.json` shows the
shape.

Outside that directory, exactly one file is touched: `~/.claude/settings.json`, always merged and
always backed up to a timestamped sibling.

---

## 12. Failure modes and runbook

| Symptom | Cause | Resolution |
| --- | --- | --- |
| Status shows `port-in-use` | Another gateway or application holds the port | Accept the UI's suggested free port; the settings write also rewrites `~/.claude/settings.json` when routing is on |
| Claude Code shows an invalid-API-key error mid-session | A `passthrough` provider forwarded a credential the upstream rejected — typically `ANTHROPIC_API_KEY` is set in `~/.claude/settings.json`, so Claude Code sends that instead of the subscription. Terminal for passthrough, so it reaches the client verbatim | Remove `ANTHROPIC_API_KEY` and keep only `ANTHROPIC_BASE_URL`, then restart Claude Code — or disable the passthrough provider |
| Error appears only after several successful calls | Selection is `random` / `weighted`; the failure surfaces on the tick that happens to pick the broken provider | Read the log by `requestId`, not by wall-clock adjacency |
| `503 {"error":"all providers failed"}` | Every enabled provider was attempted and none succeeded; `details` carries the last status | Check `/stats` for `unhealthyProviders` and cooldowns; probe individual providers from the Providers tab |
| Provider disappears from rotation for ~60 s | 3 consecutive failures → health cooldown | Expected. `cooldownRemainingMs` in `/stats` shows the remainder |
| Dashboard cost lower than expected | Usage is recorded from the SSE stream only (§7.4) | Streaming clients are metered; non-streaming ones are not |
| `/stats` shows `errors: 0` despite visible failures | `perProvider.errors` increments only on the non-retryable branch (`proxy.ts:489`); retryable failover and sanitize flips are counted only in `retries` | Use the log for a true failure count |
| Edits to `providers.json` are ignored by the gateway | Either the file failed schema validation (the gateway ignores a file it rejects) or it was replaced by rename, breaking `fs.watch` | Check the log for `providers.json hot-reloaded`; save through the app, which writes in place |
| Element that should be hidden stays visible | Missing `[hidden] { display: none }` rule for that selector | Add the rule; there is no error to find |

---

## 13. Known limitations

- **Non-streaming requests contribute no usage rows** (§7.4). Correct for Claude Code, incomplete
  for other clients.
- **`/stats` per-provider error counts understate failures** — retryable failover and sanitize flips
  are invisible there.
- **Unknown HTTP paths are proxied upstream rather than 404'd**, so a typo in an operator query
  costs a real provider call.
- **Linux only.** `autostart.js` returns `supported: false` elsewhere; `app.setLoginItemSettings`
  would be the macOS/Windows path.
- **No renderer tests.** Coverage is limited to main-process modules that own files or make
  irreversible changes.
- **`strategy` and `logLevel` need a gateway restart**, since both are read from the environment at
  fork time.

---

## 14. Testing

`node --test` over the main-process modules that own files or make irreversible changes:
`providers-store`, `claude-settings`, `settings-store`, `schema`, `autostart` — 60 tests.

Electron is stubbed by injecting a fake `app` into `require.cache` **before** the first
`require('electron')` (`test/helpers/electron-stub.js`), with each install getting a fresh `mkdtemp`
root; `~/.claude` is sandboxed through `CLAUDE_CONFIG_DIR`. The `providers-store` tests seed the
temporary `userData/providers.json` first, so `ensureProvidersFile()`'s migration never copies real
keys into the sandbox. One test is skipped off-Linux by design.

```bash
node --test test/providers-store.test.js
node --test --test-name-pattern 'masks' test/providers-store.test.js
```

---

## 15. Contribution rule that outranks the rest

**Do not edit `gateway-src/` to change gateway behaviour.** Fix it upstream and re-copy per
`gateway-src/VENDOR.md`. The application validates configuration with the gateway's *own* schema; as
soon as the vendored copy diverges from upstream, that guarantee becomes a lie and the UI can start
showing a provider list the gateway never adopted.
