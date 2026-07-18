import Fastify from 'fastify'
import type { GatewayConfig, ProviderConfig, RequestStats } from './types.js'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import { createProxyHandler } from './proxy.js'
import { createLogger } from './logger.js'
import { UsageTracker } from './usage-tracker.js'

export function createServer(
  config: GatewayConfig,
  providers: ProviderConfig[],
  healthTracker: HealthTracker,
  usageTracker: UsageTracker
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

  // Claude Code probes `HEAD /` at startup to test connectivity. Answer it
  // locally (Fastify auto-exposes HEAD for GET routes) — proxying the probe to
  // providers returns their Cloudflare error pages (305/403), which the client
  // can't parse and surfaces as "API Error: Failed to parse JSON".
  app.get('/', async () => {
    return { status: 'ok' }
  })

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

  // -------------------------------------------------------------------------
  // Usage / token tracking endpoints
  // -------------------------------------------------------------------------

  app.get('/usage', async (req) => {
    const date = (req.query as Record<string, string | undefined>).date
    const limit = Number((req.query as Record<string, string | undefined>).limit ?? 50)
    return {
      today:       usageTracker.getDailySummary(date),
      recentCalls: usageTracker.getRecentCalls(limit),
      history:     usageTracker.getAllDays(),
    }
  })

  app.get('/usage/export', async (req, reply) => {
    const date = (req.query as Record<string, string | undefined>).date
    const targetDate = date ?? new Date().toISOString().slice(0, 10)
    const csv = usageTracker.exportCsv(targetDate)
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="usage-${targetDate}.csv"`)
    return reply.send(csv)
  })

  /**
   * GET /usage/cost            → cost for today
   * GET /usage/cost?date=YYYY-MM-DD → cost for a specific date
   * GET /usage/cost/YYYY-MM-DD → cost for a specific date (path-param style)
   */
  app.get('/usage/cost', async (req) => {
    const date = (req.query as Record<string, string | undefined>).date
    return usageTracker.getDailyCost(date)
  })

  app.get<{ Params: { date: string } }>('/usage/cost/:date', async (req) => {
    return usageTracker.getDailyCost(req.params.date)
  })

  app.all('/*', createProxyHandler(providerManager, healthTracker, config, stats, usageTracker))

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not found' })
  })

  return { app, stats, log }
}
