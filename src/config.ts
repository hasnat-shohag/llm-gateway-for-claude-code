import { readFileSync, watch } from 'fs'
import { resolve } from 'path'
import { z } from 'zod'
import type { GatewayConfig, ProviderConfig } from './types.js'

const providerSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  enabled: z.boolean(),
  weight: z.number().int().positive(),
  authStyle: z.enum(['x-api-key', 'bearer']).default('x-api-key'),
  sanitize: z.boolean().optional(),
})

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  STRATEGY: z.enum(['random', 'round-robin', 'weighted']).default('random'),
  /** Connect + headers timeout. Raise if providers are slow to respond. */
  REQUEST_TIMEOUT: z.coerce.number().int().positive().default(60000),
  /** Body/stream timeout. Must be long enough for large completions. */
  STREAM_TIMEOUT: z.coerce.number().int().positive().default(300000),
  HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  HEALTH_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
})

export function loadEnvConfig(): GatewayConfig {
  const parsed = envSchema.parse({
    PORT: process.env.PORT,
    STRATEGY: process.env.STRATEGY,
    REQUEST_TIMEOUT: process.env.REQUEST_TIMEOUT,
    STREAM_TIMEOUT: process.env.STREAM_TIMEOUT,
    HEALTH_FAILURE_THRESHOLD: process.env.HEALTH_FAILURE_THRESHOLD,
    HEALTH_COOLDOWN_MS: process.env.HEALTH_COOLDOWN_MS,
    LOG_LEVEL: process.env.LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
  })

  return {
    port: parsed.PORT,
    strategy: parsed.STRATEGY,
    requestTimeout: parsed.REQUEST_TIMEOUT,
    streamTimeout: parsed.STREAM_TIMEOUT,
    healthFailureThreshold: parsed.HEALTH_FAILURE_THRESHOLD,
    healthCooldownMs: parsed.HEALTH_COOLDOWN_MS,
    logLevel: parsed.LOG_LEVEL,
    nodeEnv: parsed.NODE_ENV,
  }
}

export function loadProviders(filePath?: string): ProviderConfig[] {
  const path = resolve(filePath ?? 'providers.json')
  const raw = readFileSync(path, 'utf-8')
  const parsed = JSON.parse(raw)
  return z.array(providerSchema).parse(parsed)
}

export function watchProviders(
  filePath: string,
  onChange: (providers: ProviderConfig[]) => void
) {
  const path = resolve(filePath)
  watch(path, (eventType) => {
    if (eventType === 'change') {
      try {
        const providers = loadProviders(path)
        onChange(providers)
      } catch {
        // Logged by caller; invalid config is ignored silently here
      }
    }
  })
}
