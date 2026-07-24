# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local HTTP proxy that sits between Claude Code and multiple Anthropic-compatible API providers. It load-balances across providers, fails over to the next provider on error, tracks provider health with cooldown, auto-learns per-provider request sanitization, and records token usage/cost to SQLite. Everything is streaming (SSE) end to end.

## Commands

```bash
npm run dev        # live-reload dev server (node --watch + tsx), reads .env
npm run build      # tsc → dist/
npm start          # run compiled dist/index.js
npm run typecheck  # tsc --noEmit

# Tests: there is no test runner/framework and no `test` script.
# Test files are standalone node:assert self-checks run directly:
npx tsx src/sanitize-learner.test.ts
```

Running via Docker (the intended production path): `docker compose up -d --build` (dev, source bind-mounted) or `docker compose --profile prod up -d --build`. `providers.json` hot-reloads without a restart.

## Setup requirements

- `providers.json` (gitignored, contains API keys) must exist in the project root before start — a JSON **array** of provider objects. Validated by zod on load; invalid config fails startup, and an invalid hot-reload edit is ignored (previous list stays active). See README for the field table.
- Node >= 22 (uses `node --watch`, native fetch-era undici).
- ESM project (`"type": "module"`) — **imports must use `.js` extensions** even for `.ts` source files (`verbatimModuleSyntax` + bundler resolution).

## Architecture

Request flow: `index.ts` (bootstrap, graceful shutdown, `providers.json` watcher) → `server.ts` (Fastify routes + observability endpoints) → `proxy.ts` (the core: `app.all('/*')` forwards everything else upstream).

Key collaborators, all constructed once and threaded through:
- **ProviderManager** (`provider-manager.ts`) — selection strategy (`random`/`round-robin`/`weighted`) over the enabled+healthy set. `selectExcluding()` drives failover so the same provider isn't retried.
- **HealthTracker** (`health.ts`) — consecutive-failure counter → mark unhealthy → cooldown window. In-memory, resets on restart.
- **SanitizeLearner** (`sanitize-learner.ts`) — per-provider boolean, in-memory, resets on restart.
- **UsageTracker** (`usage-tracker.ts`) — SQLite (better-sqlite3, WAL) store + the `calculateCost` pricing table.

### The two non-obvious mechanisms

**Auto-learned sanitization.** There is no single correct "sanitize the request or not" answer: some upstreams (AgentRouter) reject *sanitized* requests with 401 "unauthorized client detected"; others (FreeModel) break on the untouched Claude Code fingerprint. So there is no `sanitize` default operators must guess — the gateway learns it. It starts sanitizing ON; on a mismatch-signature failure (400/401, see `looksLikeSanitizeMismatch`) it flips the mode and retries the **same provider once**, then remembers whichever mode produced a real success. A provider can be pinned via `sanitize` in `providers.json` (then never flipped). Sanitization itself (`sanitizeHeaders`/`sanitizeRequestBody` in `utils.ts`) strips client-fingerprint headers and scrubs identity/policy-trigger patterns from the system prompt. Learned modes are visible at `GET /stats`.

**Success is committed lazily, not at status-200.** A provider can return 200 and then truncate the SSE stream. `proxy.ts` therefore does NOT record health-success or usage at commit time:
- Before committing status+headers it runs three guards (`peekBody`): reject HTML-at-200 (Cloudflare error pages), reject empty/aborted bodies, reject bodies whose first bytes are `<`. Any of these → failover to the next provider.
- Health success fires only on the client-facing stream's clean `end`; a mid-stream `error` records a health *failure* (penalizing chronic truncation). Guarded so exactly one fires.
- Usage/cost is recorded in the `createUsageInterceptor` Transform's `flush()`, which runs only on clean completion — a truncated stream records zero cost. Do not add an error-path that records usage.

Both of these exist because third-party proxies lie about success in ways a naive proxy would forward to the client as "empty or malformed response". Preserve them when editing `proxy.ts`.

### Other things worth knowing

- **Pricing** (`usage-tracker.ts` `PRICING`) is prefix-matched against the model name — more specific prefixes must come before shorter ones (e.g. `claude-opus-4-8` before `claude-opus-4`). Cost is priced against the **client-requested** model, not the model name the upstream reports in `message_start` (some proxies substitute their own). Update the table when Anthropic changes prices.
- **`accept-encoding: identity`** is forced upstream — undici forwards the body raw without decompressing, so we never handle decompression; do not strip `content-encoding` from forwarded headers.
- `shouldRetry` (`utils.ts`) treats 400/401/402/403 as retryable so a bad key/quota fails over to another provider — broader than typical proxies, intentional.
- The process-level `uncaughtException` handler in `index.ts` deliberately swallows `HTTPParserError` (undici emitting on a dropped upstream connection after the response was already sent) to keep the server up; anything else re-throws.
- `HEAD /` and `GET /health` are answered locally — proxying Claude Code's startup connectivity probe returns provider Cloudflare error pages the client can't parse.
