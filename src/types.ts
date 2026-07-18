/** How the gateway injects the API key into upstream requests.
 * - `x-api-key`  (default) — standard Anthropic SDK header
 * - `bearer`     — Authorization: Bearer <key>  (required by AgentRouter)
 */
export type AuthStyle = 'x-api-key' | 'bearer'

export interface ProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  enabled: boolean
  weight: number
  /** Defaults to 'x-api-key' if omitted */
  authStyle?: AuthStyle
  sanitize?: boolean
}

export interface ProviderHealth {
  consecutiveFailures: number
  unhealthy: boolean
  cooldownUntil: number | null
}

export interface RequestStats {
  total: number
  perProvider: Record<string, { requests: number; errors: number }>
  retries: number
  latencies: number[]
}

/** A single completed API call record stored in SQLite */
export interface UsageRecord {
  id?: number
  timestamp: string        // ISO-8601
  date: string             // YYYY-MM-DD
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface ProviderDailyStats {
  provider: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export interface DailySummary {
  date: string
  totalCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUsd: number
  byProvider: ProviderDailyStats[]
}

export interface StrategyType {
  name: string
  select(providers: ProviderConfig[]): ProviderConfig | null
}

export type StrategyName = 'random' | 'round-robin' | 'weighted'

export interface GatewayConfig {
  port: number
  strategy: StrategyName
  /** Timeout (ms) for establishing a connection + receiving response headers. */
  requestTimeout: number
  /** Timeout (ms) for the full streaming body after headers are received. */
  streamTimeout: number
  healthFailureThreshold: number
  healthCooldownMs: number
  logLevel: string
  nodeEnv: string
}

export interface ProxyContext {
  requestId: string
  provider: ProviderConfig
  url: string
  method: string
  startTime: number
  retryCount: number
}
