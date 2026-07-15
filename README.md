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
| `HEALTH_FAILURE_THRESHOLD`| `3`       | Consecutive failures to mark unhealthy |
| `HEALTH_COOLDOWN_MS`      | `60000`   | Cooldown period in ms            |
| `LOG_LEVEL`               | `info`    | Pino log level                   |
| `NODE_ENV`                | `development` | Environment mode             |

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

Build the image:

```bash
docker build -t llm-gateway .
```

Run the container (mount `providers.json` from host):

```bash
docker run -d \
  --name llm-gateway \
  -p 8080:8080 \
  -v $(pwd)/providers.json:/app/providers.json \
  -e STRATEGY=round-robin \
  -e LOG_LEVEL=info \
  llm-gateway
```

Environment variables can be set via `-e` flags or an env file:

```bash
docker run -d \
  --name llm-gateway \
  -p 8080:8080 \
  -v $(pwd)/providers.json:/app/providers.json \
  --env-file .env \
  llm-gateway
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

| Method | Path        | Description                                          |
|--------|-------------|------------------------------------------------------|
| GET    | `/health`   | Health check (`{"status":"ok"}`)                     |
| GET    | `/stats`    | Totals, per-provider usage, retries, average latency, unhealthy providers |
| GET    | `/providers`| List enabled provider names                          |
| ALL    | `/*`        | Proxy to selected provider                           |

## How It Works

- **Provider selection** — each request picks a provider using the configured `STRATEGY`.
- **Failover** — on network errors or retryable HTTP statuses, the request is retried on the next untried provider until all are exhausted, then a `503` is returned.
- **Health tracking** — after `HEALTH_FAILURE_THRESHOLD` consecutive failures a provider is marked unhealthy and skipped for `HEALTH_COOLDOWN_MS`.
- **Streaming** — responses are streamed without buffering, so SSE (Claude streaming) works transparently.
- **Auth injection** — client auth headers are stripped; each provider's key is injected per its `authStyle`.
