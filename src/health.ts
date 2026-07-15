import type { ProviderConfig, ProviderHealth } from './types.js'

export class HealthTracker {
  private state: Map<string, ProviderHealth> = new Map()
  private threshold: number
  private cooldownMs: number

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold
    this.cooldownMs = cooldownMs
  }

  getProviders(providers: ProviderConfig[]): ProviderConfig[] {
    const now = Date.now()
    return providers.filter((p) => {
      const h = this.state.get(p.name)
      if (!h || !h.unhealthy) return p.enabled
      if (h.cooldownUntil !== null && now >= h.cooldownUntil) {
        h.unhealthy = false
        h.consecutiveFailures = 0
        h.cooldownUntil = null
        return p.enabled
      }
      return false
    })
  }

  recordSuccess(providerName: string) {
    this.state.set(providerName, {
      consecutiveFailures: 0,
      unhealthy: false,
      cooldownUntil: null,
    })
  }

  recordFailure(providerName: string) {
    const h = this.state.get(providerName) ?? {
      consecutiveFailures: 0,
      unhealthy: false,
      cooldownUntil: null,
    }
    h.consecutiveFailures++
    if (h.consecutiveFailures >= this.threshold) {
      h.unhealthy = true
      h.cooldownUntil = Date.now() + this.cooldownMs
    }
    this.state.set(providerName, h)
  }

  getUnhealthy(): string[] {
    const now = Date.now()
    const result: string[] = []
    for (const [name, h] of this.state) {
      if (h.unhealthy && h.cooldownUntil !== null && now < h.cooldownUntil) {
        result.push(name)
      }
    }
    return result
  }
}
