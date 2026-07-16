import type { FastifyRequest, FastifyReply } from 'fastify'
import { request as undiciRequest } from 'undici'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import type { GatewayConfig, RequestStats } from './types.js'
import { generateRequestId, shouldRetry, removeAuthHeaders, sanitizeHeaders } from './utils.js'
import { createLogger } from './logger.js'

/**
 * Forward upstream response headers to the Fastify reply.
 *
 * Rules:
 *  - Skip hop-by-hop headers (transfer-encoding, connection, keep-alive).
 *  - Skip content-length — we stream the body so the length may differ.
 *  - DO NOT strip content-encoding — undici does not decompress the body stream
 *    for us (it's forwarded raw/untouched), so we MUST preserve the encoding
 *    header so the client (e.g., Claude CLI) knows how to decompress it.
 */
function forwardHeaders(
  reply: FastifyReply,
  headers: Record<string, string | string[] | undefined>
) {
  const HOP_BY_HOP = new Set([
    'transfer-encoding',
    'connection',
    'keep-alive',
    'server',
    'x-powered-by',
    'content-length',
  ])

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    reply.header(key, value)
  }
}

export function createProxyHandler(
  providerManager: ProviderManager,
  healthTracker: HealthTracker,
  config: GatewayConfig,
  stats?: RequestStats
) {
  const log = createLogger(config.logLevel, config.nodeEnv)

  return async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = generateRequestId()
    const startTime = Date.now()
    let retryCount = 0
    const attempted = new Set<string>()
    const originalHeaders = req.headers as Record<string, string>
    const method = req.method
    const url = req.url

    let lastError: Error | null = null
    let lastStatusCode = 500

    // Keep trying providers until all have been attempted once.
    // We ask the manager to exclude already-tried providers so the
    // selection strategy doesn't keep handing back the same one.
    while (attempted.size < providerManager.providerCount()) {
      const provider = providerManager.selectExcluding(attempted)
      if (!provider) break
      attempted.add(provider.name)

      try {
        const targetUrl = `${provider.baseUrl}${url}`

        // Build headers: strip auth + hop-by-hop, then inject provider key
        let headers = removeAuthHeaders(sanitizeHeaders(originalHeaders))
        headers['host'] = new URL(provider.baseUrl).host

        // Inject auth header according to the provider's declared style:
        //   'x-api-key' (default) — standard Anthropic SDK header
        //   'bearer'              — Authorization: Bearer <key> (AgentRouter)
        const authStyle = provider.authStyle ?? 'x-api-key'
        if (authStyle === 'bearer') {
          headers['authorization'] = `Bearer ${provider.apiKey}`
        } else {
          headers['x-api-key'] = provider.apiKey
        }

        // Drop beta-feature flags that third-party providers don't support.
        // Forwarding unknown beta flags (e.g., interleaved-thinking-2025-05-14)
        // can cause free/proxy endpoints to return malformed responses or trigger
        // Anthropic's upstream policy filters.
        delete headers['anthropic-beta']

        // Inject anthropic-version if the client didn't send it.
        // Some providers require this header; without it they may return a
        // silent 200 with an empty or invalid body.
        if (!headers['anthropic-version']) {
          headers['anthropic-version'] = '2023-06-01'
        }

        // Tell the upstream we accept uncompressed so we never have to deal
        // with decompression ourselves.
        headers['accept-encoding'] = 'identity'

        const body = req.body ? JSON.stringify(req.body) : undefined
        if (body) {
          headers['content-length'] = String(Buffer.byteLength(body))
          // Ensure correct content-type for JSON payloads
          headers['content-type'] = 'application/json'
        }

        const response = await undiciRequest(targetUrl, {
          method,
          headers,
          body,
          // headersTimeout: time to establish the connection and receive the
          // first byte of response headers.  Short — if the provider doesn't
          // respond quickly it's probably down.
          headersTimeout: config.requestTimeout,
          // bodyTimeout: time allowed for the streaming body after headers.
          // Must be long enough to cover large completions.  0 = no timeout.
          bodyTimeout: config.streamTimeout,
        })

        if (response.statusCode >= 200 && response.statusCode < 300) {
          // Guard 1: content-type check.
          // Some providers (via Cloudflare) return HTML error pages with a 200
          // status.  Claude Code cannot parse HTML as an SSE stream and reports
          // "empty or malformed response".  Detect and retry.
          const ct = (response.headers['content-type'] as string | undefined) ?? ''
          if (ct.includes('text/html')) {
            healthTracker.recordFailure(provider.name)
            lastStatusCode = response.statusCode
            retryCount++
            log.warn({ requestId, provider: provider.name, contentType: ct },
              'provider returned HTML at 200 — retrying next provider')
            await response.body.dump()
            continue
          }

          // Guard 2: empty-body check.
          // Some providers quietly exhaust their quota and reply 200 with an
          // empty body (content-length: 0).  Detect and retry.
          const cl = response.headers['content-length']
          if (cl !== undefined && cl !== null && Number(cl) === 0) {
            healthTracker.recordFailure(provider.name)
            lastStatusCode = response.statusCode
            retryCount++
            log.warn({ requestId, provider: provider.name },
              'provider returned 200 with empty body — retrying next provider')
            await response.body.dump()
            continue
          }

          healthTracker.recordSuccess(provider.name)
          const latency = Date.now() - startTime
          if (stats) {
            stats.total++
            stats.perProvider[provider.name] ??= { requests: 0, errors: 0 }
            stats.perProvider[provider.name].requests++
            stats.latencies.push(latency)
            stats.retries += retryCount
          }

          log.info({
            requestId,
            provider: provider.name,
            method,
            url,
            status: response.statusCode,
            latency,
            retryCount,
          }, 'request completed')

          reply.code(response.statusCode)
          forwardHeaders(reply, response.headers)

          // reply.send() with a Readable stream is the correct Fastify way to
          // stream a body — it writes the HTTP head (status + headers) first,
          // then pipes the body.  Do NOT use reply.hijack() here: hijack skips
          // Fastify's head-writing path, so the status line and headers set
          // above are never sent, and the client receives an empty/malformed
          // response.
          return reply.send(response.body)
        }

        if (shouldRetry(response.statusCode)) {
          healthTracker.recordFailure(provider.name)
          lastStatusCode = response.statusCode
          retryCount++
          // Drain the body so the connection is released back to the pool
          await response.body.dump()
          continue
        }

        // Non-retryable error — forward as-is
        healthTracker.recordFailure(provider.name)
        const latency = Date.now() - startTime
        if (stats) {
          stats.total++
          stats.perProvider[provider.name] ??= { requests: 0, errors: 0 }
          stats.perProvider[provider.name].errors++
          stats.latencies.push(latency)
          stats.retries += retryCount
        }

        log.warn({
          requestId,
          provider: provider.name,
          method,
          url,
          status: response.statusCode,
          latency,
          retryCount,
        }, 'non-retryable error')

        reply.code(response.statusCode)
        forwardHeaders(reply, response.headers)
        return reply.send(response.body)

      } catch (err) {
        healthTracker.recordFailure(provider.name)
        lastError = err as Error
        retryCount++
      }
    }

    if (stats) {
      stats.total++
      stats.retries += retryCount
    }

    log.error({
      requestId,
      method,
      url,
      retryCount,
      lastError: lastError?.message,
      lastStatusCode,
    }, 'all providers exhausted')

    reply.code(503)
    reply.send({
      error: 'all providers failed',
      requestId,
      retries: retryCount,
      details: lastError?.message ?? `HTTP ${lastStatusCode}`,
    })
  }
}
