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
