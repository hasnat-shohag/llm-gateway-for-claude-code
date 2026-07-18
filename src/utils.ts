import crypto from 'crypto'

export function generateRequestId(): string {
  return crypto.randomUUID()
}

export function shouldRetry(statusCode: number): boolean {
  // Standard transient errors + Cloudflare edge errors (520-526, 524).
  // Also retry on provider auth/rate-limiting/model errors (400, 401, 402, 403) so we fail over to other keys.
  return [
    400, 401, 402, 403,     // Client errors (bad key, usage limits, unsupported models)
    429,                    // Too Many Requests
    500, 502, 503, 504,     // Standard server errors
    520, 521, 522, 523,     // Cloudflare: unknown/refused/timed-out/unreachable origin
    524, 525, 526,          // Cloudflare: gateway timeout / SSL handshake / invalid cert
  ].includes(statusCode)
}

export function removeAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers }
  delete result['authorization']
  delete result['x-api-key']
  return result
}

export function injectAuthHeaders(
  headers: Record<string, string>,
  apiKey: string,
  originalHeaders: Record<string, string>
): Record<string, string> {
  const result = { ...headers }
  if (originalHeaders['x-api-key']) {
    result['x-api-key'] = apiKey
  } else {
    result['authorization'] = `Bearer ${apiKey}`
  }
  return result
}

export function sanitizeHeaders(headers: Record<string, string>, shouldSanitize: boolean = true): Record<string, string> {
  const result = { ...headers }

  // Standard hop-by-hop / routing headers
  delete result['host']
  delete result['connection']
  delete result['content-length']
  delete result['transfer-encoding']

  if (shouldSanitize) {
    // Strip Stainless and Anthropic client telemetry/metadata headers injected by
    // the Anthropic SDK / Claude Code CLI. These fingerprint the request and can
    // trigger Anthropic's upstream policy filters when proxied.
    for (const key of Object.keys(result)) {
      const lowerKey = key.toLowerCase()
      if (lowerKey.startsWith('x-stainless-') || lowerKey.startsWith('x-anthropic-')) {
        if (lowerKey !== 'x-api-key') {
          delete result[key]
        }
      }
    }

    // Rewrite User-Agent to standard browser format if it contains Claude signature
    if (result['user-agent'] && /claude/i.test(result['user-agent'])) {
      result['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }

  return result
}

export function sanitizeRequestBody(body: any): any {
  if (!body || typeof body !== 'object') {
    return body
  }

  // Deep clone or shallow copy depending on use. Fastify body is safe to copy shallowly first
  const result = { ...body }

  // Strip metadata as some third-party providers return 400 Bad Request if it's forwarded
  if ('metadata' in result) {
    delete result.metadata
  }

  // Strip x-anthropic-billing-header from the system prompt
  if (result.system) {
    const billingHeaderRegex = /x-anthropic-billing-header:[^\r\n]*\r?\n?/gi

    if (typeof result.system === 'string') {
      result.system = result.system.replace(billingHeaderRegex, '').trim()
    } else if (Array.isArray(result.system)) {
      result.system = result.system
        .map((block: any) => {
          if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            return {
              ...block,
              text: block.text.replace(billingHeaderRegex, '').trim()
            }
          }
          return block
        })
        // Filter out empty text blocks
        .filter((block: any) => {
          if (block && typeof block === 'object' && block.type === 'text') {
            return block.text.length > 0
          }
          return true
        })
    }
  }

  return result
}

