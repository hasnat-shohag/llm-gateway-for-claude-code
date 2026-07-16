import 'dotenv/config'
import { createServer } from './server.js'
import { createLogger } from './logger.js'
import { HealthTracker } from './health.js'
import type { ProviderConfig } from './types.js'
import { loadEnvConfig, loadProviders, watchProviders } from './config.js'
import { UsageTracker } from './usage-tracker.js'

const config = loadEnvConfig()
const log = createLogger(config.logLevel, config.nodeEnv)

let providers: ProviderConfig[]
try {
  providers = loadProviders()
} catch (err) {
  log.error({ err }, 'failed to load providers.json')
  process.exit(1)
}
const healthTracker = new HealthTracker(config.healthFailureThreshold, config.healthCooldownMs)
const usageTracker = new UsageTracker()

const { app } = createServer(config, providers, healthTracker, usageTracker)

// Gracefully close the SQLite connection on exit
process.on('exit', () => usageTracker.close())
process.on('SIGINT',  () => { usageTracker.close(); process.exit(0) })
process.on('SIGTERM', () => { usageTracker.close(); process.exit(0) })

watchProviders('providers.json', (newProviders) => {
  providers = newProviders
  ;(app as any).updateProviders(newProviders)
  log.info('providers.json hot-reloaded')
})

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  log.info(`LLM Gateway listening on port ${config.port}`)
} catch (err) {
  log.error(err, 'failed to start server')
  process.exit(1)
}
