# LLM Gateway

A local HTTP proxy gateway that sits between Claude Code and multiple Anthropic-compatible API providers. Load-balances across providers, retries failed requests on the next provider, and tracks provider health with automatic cooldown.

## Requirements

- Node.js >= 22

## Installation

```bash
git clone <repo-url>
cd llm-gateway
npm install
```

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### providers.json

`providers.json` is **not committed to the repository** (it contains API keys and is gitignored). You must create it in the project root before starting the gateway:

```bash
cp providers.example.json providers.json
```

Then edit it with your real providers. It must be a JSON **array** of provider objects:

```json
[
  {
    "name": "My Provider",
    "baseUrl": "https://your-provider.com",
    "apiKey": "sk-xxxxx",
    "enabled": true,
    "weight": 1,
    "authStyle": "x-api-key"
  },
  {
    "name": "Bearer Auth Provider",
    "baseUrl": "https://another-provider.com",
    "apiKey": "sk-yyyyy",
    "enabled": true,
    "weight": 2,
    "authStyle": "bearer"
  }
]
```

| Field       | Required | Description                                              |
|-------------|----------|----------------------------------------------------------|
| `name`      | yes      | Unique provider name (used in stats and logs)            |
| `baseUrl`   | yes      | Provider base URL, no trailing slash (request path is appended as-is) |
| `apiKey`    | yes      | API key injected into upstream requests                  |
| `enabled`   | yes      | Set `false` to skip this provider                        |
| `weight`    | yes      | Positive integer, used by the `weighted` strategy        |
| `authStyle` | no       | `x-api-key` (default, Anthropic-style header) or `bearer` (`Authorization: Bearer <key>`) |

Notes:

- The file is validated on load — a missing required field, an invalid URL, or a non-positive `weight` will fail startup with a validation error.
- The gateway watches the file and hot-reloads on change, no restart needed. If an edit produces invalid JSON or fails validation, the change is ignored and the previous provider list stays active.
- The provider must expose an Anthropic-compatible API (e.g. `POST /v1/messages`), since the gateway forwards Claude Code's requests verbatim.

### Environment Variables

| Variable                  | Default   | Description                      |
|---------------------------|-----------|----------------------------------|
| `PORT`                    | `8080`    | Server port                      |
| `STRATEGY`                | `random`  | Provider selection strategy      |
| `REQUEST_TIMEOUT`         | `30000`   | Request timeout in ms            |
| `STREAM_TIMEOUT`          | `300000`  | Streaming body timeout in ms     |
| `HEALTH_FAILURE_THRESHOLD`| `3`       | Consecutive failures to mark unhealthy |
| `HEALTH_COOLDOWN_MS`      | `60000`   | Cooldown period in ms            |
| `LOG_LEVEL`               | `info`    | Pino log level                   |
| `NODE_ENV`                | `development` | Environment mode             |
| `USAGE_DB_PATH`           | `./usage.db` | Path to the SQLite usage database |

### Provider Selection Strategies

- `random` — pick a random provider
- `round-robin` — cycle through providers in order
- `weighted` — weighted random selection

## Running

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Docker

**Recommended: use Docker Compose** (handles build tools, volumes, and restart policy automatically):

```bash
# Development (live-reload, source bind-mounted)
docker compose up -d --build

# Production
docker compose --profile prod up -d --build
```

> **Upgrading the image?** If you're upgrading from an older image that didn't install `better-sqlite3`, the container's `node_modules` anonymous volume may be stale. Run this once to wipe it and start fresh:
> ```bash
> docker compose down -v && docker compose up -d
> ```
> The `usage-data` named volume (your token history) is preserved — only the `node_modules` anonymous volume is removed.

**Manual `docker run`** (if not using Compose):

```bash
docker build --target dev -t llm-gateway:dev .
docker run -d \
  --name llm-gateway \
  -p 8080:8080 \
  -v $(pwd)/providers.json:/app/providers.json \
  -v llm-gateway-usage:/app/data \
  --env-file .env \
  llm-gateway:dev
```

To update providers at runtime, edit the mounted `providers.json` — the gateway hot-reloads automatically without a container restart.

## Adding Providers

Add entries to `providers.json` (see [providers.json](#providersjson) for the format). The gateway hot-reloads when the file changes — no restart needed.

## Claude Code Setup

Add to `~/.claude/settings.json` or your project's `.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "dummy",
    "ANTHROPIC_BASE_URL": "http://localhost:8080",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "allow": [],
    "deny": []
  },
  "apiKeyHelper": "echo dummy"
}
```

## Endpoints

| Method | Path                  | Description                                              |
|--------|-----------------------|----------------------------------------------------------|
| GET    | `/health`             | Health check (`{"status":"ok"}`)                         |
| GET    | `/stats`              | Totals, per-provider usage, retries, average latency, unhealthy providers |
| GET    | `/providers`          | List enabled provider names                              |
| GET    | `/usage`              | Token usage & cost summary for today + recent calls + day history |
| GET    | `/usage?date=YYYY-MM-DD` | Usage for a specific date                             |
| GET    | `/usage?limit=100`    | Adjust number of recent calls returned (default 50)      |
| GET    | `/usage/export`       | Download today's usage as CSV                            |
| GET    | `/usage/export?date=YYYY-MM-DD` | Download a specific day's usage as CSV        |
| ALL    | `/*`                  | Proxy to selected provider                               |

## How It Works

- **Provider selection** — each request picks a provider using the configured `STRATEGY`.
- **Failover** — on network errors or retryable HTTP statuses, the request is retried on the next untried provider until all are exhausted, then a `503` is returned.
- **Health tracking** — after `HEALTH_FAILURE_THRESHOLD` consecutive failures a provider is marked unhealthy and skipped for `HEALTH_COOLDOWN_MS`.
- **Streaming** — responses are streamed without buffering, so SSE (Claude streaming) works transparently.
- **Auth injection** — client auth headers are stripped; each provider's key is injected per its `authStyle`.
- **Token tracking** — SSE responses are transparently intercepted to extract token counts and cost, persisted to a local SQLite database.

## Token Usage & Cost Tracking

The gateway automatically intercepts every streaming response and extracts token usage reported by the upstream provider. Data is stored in a local SQLite file (`usage.db` by default, or `USAGE_DB_PATH` in `.env`).

### Check today's usage

```bash
curl http://localhost:8080/usage | python3 -m json.tool
```

Example response:

```json
{
  "today": {
    "date": "2026-07-17",
    "totalCalls": 12,
    "totalInputTokens": 48200,
    "totalOutputTokens": 9400,
    "totalCacheReadTokens": 12000,
    "totalCacheWriteTokens": 0,
    "totalCostUsd": 0.285,
    "byProvider": [
      {
        "provider": "Agent Router 1",
        "calls": 8,
        "inputTokens": 32000,
        "outputTokens": 6200,
        "cacheReadTokens": 12000,
        "cacheWriteTokens": 0,
        "costUsd": 0.19
      }
    ]
  },
  "recentCalls": [ ... ],
  "history": [
    { "date": "2026-07-17", "totalCalls": 12, "totalCostUsd": 0.285 },
    { "date": "2026-07-16", "totalCalls": 35, "totalCostUsd": 0.812 }
  ]
}
```

### Export to CSV

```bash
# Today
curl http://localhost:8080/usage/export -o usage-today.csv

# Specific date
curl "http://localhost:8080/usage/export?date=2026-07-16" -o usage-2026-07-16.csv
```

### Pricing table

Costs are calculated using Anthropic's public pricing (USD per 1M tokens):

| Model prefix          | Input   | Output   | Cache Read | Cache Write |
|-----------------------|---------|----------|------------|-------------|
| `claude-opus-4`       | $15.00  | $75.00   | $1.50      | $18.75      |
| `claude-sonnet-4`     | $3.00   | $15.00   | $0.30      | $3.75       |
| `claude-haiku-3-5`    | $0.80   | $4.00    | $0.08      | $1.00       |
| `claude-haiku-3`      | $0.25   | $1.25    | $0.03      | $0.30       |

To update prices, edit `PRICING` in `src/usage-tracker.ts`.

### Docker — persisting usage.db

When running via Docker Compose, the SQLite database is stored in a named volume (`usage-data`) so it survives container restarts and image rebuilds. The database path inside the container is `/app/data/usage.db`.

To inspect the volume or back it up:

```bash
# Where Docker stores the volume on disk
docker volume inspect llm-gateway_usage-data

# Copy the database out of the container
docker cp llm-gateway-gateway-dev-1:/app/data/usage.db ./usage-backup.db
```
