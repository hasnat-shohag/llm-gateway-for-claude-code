import type { FastifyRequest, FastifyReply } from 'fastify'
import { request as undiciRequest, Agent } from 'undici'
import { Transform, Readable } from 'stream'
import { ProviderManager } from './provider-manager.js'
import { HealthTracker } from './health.js'
import type { GatewayConfig, RequestStats } from './types.js'
import { generateRequestId, shouldRetry, removeAuthHeaders, sanitizeHeaders, sanitizeRequestBody } from './utils.js'
import { createLogger } from './logger.js'
import { UsageTracker, calculateCost } from './usage-tracker.js'

// ---------------------------------------------------------------------------
// Shared undici connection pool
// ---------------------------------------------------------------------------
// The default global undici dispatcher caps concurrent connections per origin
// low, so several Claude Code sessions hitting the gateway at once queue behind
// one another and can trip body timeouts.  A dedicated Agent with a higher
// per-origin connection count keeps concurrent requests from starving.
const dispatcher = new Agent({
  connections: 64,
  pipelining: 0,
})

/**
 * Read the first chunk of an undici body stream, then return a fresh Readable
 * that replays that chunk followed by the rest of the stream.  Lets us inspect
 * whether a 200 response actually carries a body before committing status +
 * headers to the client (so we can still fail over on an empty/aborted stream).
 *
 * Returns `{ empty: true }` when the stream ends with no bytes.
 */
async function peekBody(
  body: Readable
): Promise<{ empty: true } | { empty: false; firstChunk: Buffer; stream: Readable }> {
  const iterator = body[Symbol.asyncIterator]()
  let first: IteratorResult<Buffer>
  try {
    first = await iterator.next()
  } catch {
    // Stream errored before yielding anything — treat as empty so we fail over.
    body.destroy()
    return { empty: true }
  }

  if (first.done || !first.value || first.value.length === 0) {
    return { empty: true }
  }

  const firstChunk = first.value
  const replay = Readable.from(
    (async function* () {
      yield firstChunk
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    })()
  )
  // Propagate downstream errors so callers/pipe consumers see the abort.
  body.on('error', (err) => replay.destroy(err))

  return { empty: false, firstChunk, stream: replay }
}

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

// ---------------------------------------------------------------------------
// SSE stream interceptor
// ---------------------------------------------------------------------------
// Creates a Transform stream that passes every byte through to the client
// unchanged while scanning for the two SSE events that carry token usage:
//   - message_start  → input_tokens, model
//   - message_delta  → output_tokens (in the top-level usage object)
// After the stream ends (or errors) the collected data is persisted via
// UsageTracker.record().
// ---------------------------------------------------------------------------
function createUsageInterceptor(
  provider: string,
  usageTracker: UsageTracker,
  log: ReturnType<typeof createLogger>
): Transform {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let model = 'unknown'
  // Buffer incomplete SSE lines across chunk boundaries
  let lineBuffer = ''

  const flush = () => {
    if (inputTokens === 0 && outputTokens === 0) return   // nothing to record
    try {
      const now = new Date()
      const costUsd = calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
      usageTracker.record({
        timestamp:        now.toISOString(),
        date:             now.toISOString().slice(0, 10),
        provider,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd,
      })
      log.info({ provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd },
        'usage recorded')
    } catch (err) {
      log.warn({ err }, 'failed to record usage')
    }
  }

  const parseLine = (line: string) => {
    // SSE data lines start with 'data: '
    if (!line.startsWith('data: ')) return
    const raw = line.slice(6).trim()
    if (raw === '[DONE]') return
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>
      if (obj.type === 'message_start') {
        const msg = obj.message as Record<string, unknown> | undefined
        if (msg?.model) model = String(msg.model)
        const usage = msg?.usage as Record<string, number> | undefined
        if (usage) {
          inputTokens       += usage.input_tokens                ?? 0
          cacheReadTokens   += usage.cache_read_input_tokens     ?? 0
          cacheWriteTokens  += usage.cache_creation_input_tokens ?? 0
        }
      } else if (obj.type === 'message_delta') {
        const usage = obj.usage as Record<string, number> | undefined
        if (usage) {
          outputTokens += usage.output_tokens ?? 0
        }
      }
    } catch {
      // Non-JSON data line — skip
    }
  }

  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      // Pass chunk through to client immediately
      this.push(chunk)
      // Parse lines from the chunk (handle partial lines across chunks)
      const text = lineBuffer + chunk.toString('utf8')
      const lines = text.split('\n')
      // The last element may be an incomplete line — keep it in the buffer
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        parseLine(line.replace(/\r$/, ''))
      }
      callback()
    },
    flush(callback) {
      // Process any remaining buffered content
      if (lineBuffer) parseLine(lineBuffer.replace(/\r$/, ''))
      flush()
      callback()
    },
  })

  // Also catch stream errors so tokens are still saved on abrupt close
  transform.on('error', () => flush())

  return transform
}

export function createProxyHandler(
  providerManager: ProviderManager,
  healthTracker: HealthTracker,
  config: GatewayConfig,
  stats?: RequestStats,
  usageTracker?: UsageTracker
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
        const shouldSanitize = provider.sanitize !== false
        let headers = removeAuthHeaders(sanitizeHeaders(originalHeaders, shouldSanitize))
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
        if (shouldSanitize) {
          delete headers['anthropic-beta']
        }

        // Inject anthropic-version if the client didn't send it.
        // Some providers require this header; without it they may return a
        // silent 200 with an empty or invalid body.
        if (!headers['anthropic-version']) {
          headers['anthropic-version'] = '2023-06-01'
        }

        // Tell the upstream we accept uncompressed so we never have to deal
        // with decompression ourselves.
        headers['accept-encoding'] = 'identity'

        const sanitizedBody = req.body
          ? (shouldSanitize ? sanitizeRequestBody(req.body) : req.body)
          : undefined
        const body = sanitizedBody ? JSON.stringify(sanitizedBody) : undefined
        if (body) {
          headers['content-length'] = String(Buffer.byteLength(body))
          // Ensure correct content-type for JSON payloads
          headers['content-type'] = 'application/json'
        }

        const response = await undiciRequest(targetUrl, {
          method,
          headers,
          body,
          dispatcher,
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

          // Guard 2: peek the body before committing status + headers.
          // Some providers quietly exhaust their quota and reply 200 with an
          // empty body, or drop the connection before the first byte.  A
          // content-length check alone misses chunked SSE streams (no
          // content-length header), so read the first chunk and only commit
          // the response to the client once we know real bytes exist.
          const peeked = await peekBody(response.body as unknown as Readable)
          if (peeked.empty) {
            healthTracker.recordFailure(provider.name)
            lastStatusCode = response.statusCode
            retryCount++
            log.warn({ requestId, provider: provider.name },
              'provider returned 200 with empty/aborted body — retrying next provider')
            continue
          }

          // Guard 3: first-bytes sniff.
          // Cloudflare error pages sometimes arrive with a JSON/SSE
          // content-type, so also check the leading bytes.  A valid Anthropic
          // response starts with '{' (JSON mode) or an SSE field name
          // ("event:"/"data:").  '<' means HTML regardless of the header.
          const head = peeked.firstChunk.toString('utf8', 0, Math.min(64, peeked.firstChunk.length)).trimStart()
          if (head.startsWith('<')) {
            healthTracker.recordFailure(provider.name)
            lastStatusCode = response.statusCode
            retryCount++
            log.warn({ requestId, provider: provider.name, head: head.slice(0, 40) },
              'provider returned HTML body at 200 — retrying next provider')
            peeked.stream.destroy()
            ;(response.body as unknown as Readable).destroy()
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

          // Wrap the body in a usage-intercepting Transform if the response
          // looks like an SSE stream (text/event-stream).  For all other
          // content types (e.g. plain JSON) pipe through unchanged — we can
          // add JSON-mode parsing later if needed.
          if (usageTracker && ct.includes('text/event-stream')) {
            const interceptor = createUsageInterceptor(provider.name, usageTracker, log)
            return reply.send(peeked.stream.pipe(interceptor))
          }

          return reply.send(peeked.stream)
        }

        if (shouldRetry(response.statusCode)) {
          healthTracker.recordFailure(provider.name)
          lastStatusCode = response.statusCode
          retryCount++
          log.warn({
            requestId,
            provider: provider.name,
            status: response.statusCode,
            retryCount,
          }, 'provider returned retryable status code — retrying next')
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
        log.warn({
          requestId,
          provider: provider.name,
          error: lastError.message,
          retryCount,
        }, 'provider request failed — retrying next')
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
