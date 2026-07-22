/**
 * Learns the correct request-sanitization mode per provider so operators don't
 * have to know it. Some upstreams (e.g. AgentRouter) fingerprint the client and
 * REQUIRE the untouched Claude Code headers/system prompt — sanitizing breaks
 * them (401 "unauthorized client detected"). Others (e.g. FreeModel) break ON
 * those markers and NEED sanitizing. There's no static default that fits both.
 *
 * The gateway starts with a guess (sanitize = true, the safe default for most
 * proxies), and if a request fails with a mismatch signature it flips the mode,
 * retries, and remembers whichever mode produced a real success. State is
 * in-memory and keyed by provider name — same lifecycle as HealthTracker
 * (resets on restart, which is fine: re-learning costs at most one request).
 *
 * The mode is always learned; there is no per-provider config override, since
 * operators can't be expected to know the right value for a given upstream.
 */
export class SanitizeLearner {
  private learned: Map<string, boolean> = new Map()

  /** The default mode to try first when nothing has been learned yet. */
  static readonly DEFAULT_MODE = true

  /** Learned mode for a provider, or the default guess if not yet learned. */
  modeFor(providerName: string): boolean {
    return this.learned.get(providerName) ?? SanitizeLearner.DEFAULT_MODE
  }

  isLearned(providerName: string): boolean {
    return this.learned.has(providerName)
  }

  /** Record the mode that produced a genuine success for this provider. */
  recordSuccess(providerName: string, mode: boolean) {
    this.learned.set(providerName, mode)
  }

  /** Snapshot of learned modes for observability (GET /stats). */
  snapshot(): Record<string, boolean> {
    return Object.fromEntries(this.learned)
  }
}
