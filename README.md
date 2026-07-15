# LLM Gateway

A local HTTP proxy gateway that sits between Claude Code and multiple Anthropic-compatible API providers.

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

Edit `providers.json` with your API providers:

```json
[
  {
    "name": "My Provider",
    "baseUrl": "https://your-provider.com",
    "apiKey": "sk-xxxxx",
    "enabled": true,
    "weight": 1
  }
]
```

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

Add entries to `providers.json`. The gateway hot-reloads when the file changes — no restart needed.

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

| Method | Path        | Description                  |
|--------|-------------|------------------------------|
| GET    | `/health`   | Health check                 |
| GET    | `/stats`    | Request statistics           |
| GET    | `/providers`| List enabled providers       |
| ALL    | `/*`        | Proxy to selected provider   |

## Architecture

The gateway proxies requests without buffering, preserving streaming responses and SSE.
