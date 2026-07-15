import Fastify from 'fastify'
import type { GatewayConfig, ProviderConfig, RequestStats } from './types.js'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import { createProxyHandler } from './proxy.js'
import { createLogger } from './logger.js'

export function createServer(
  config: GatewayConfig,
  providers: ProviderConfig[],
  healthTracker: HealthTracker
) {
  const log = createLogger(config.logLevel, config.nodeEnv)
  const providerManager = new ProviderManager(providers, healthTracker, config.strategy)

  const stats: RequestStats = {
    total: 0,
    perProvider: {},
    retries: 0,
    latencies: [],
  }

  const app = Fastify({
    logger: false,
  })

  ;(app.decorate as unknown as (name: string, value: unknown) => void)(
    'updateProviders',
    (newProviders: ProviderConfig[]) => {
      providerManager.updateProviders(newProviders)
    }
  )

  app.get('/health', async () => {
    return { status: 'ok' }
  })

  app.get('/stats', async () => {
    const avgLatency = stats.latencies.length > 0
      ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length
      : 0

    return {
      totalRequests: stats.total,
      providerUsage: stats.perProvider,
      retries: stats.retries,
      averageLatency: Math.round(avgLatency),
      unhealthyProviders: healthTracker.getUnhealthy(),
    }
  })

  app.get('/providers', async () => {
    return providerManager.getProviderNames()
  })

  app.all('/*', createProxyHandler(providerManager, healthTracker, config, stats))

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not found' })
  })

  return { app, stats, log }
}
