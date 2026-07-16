import crypto from 'crypto'

export function generateRequestId(): string {
  return crypto.randomUUID()
}

export function shouldRetry(statusCode: number): boolean {
  // Standard transient errors + Cloudflare edge errors (520-526, 524).
  // Also retry on provider auth/rate-limiting/model errors (400, 401, 403) so we fail over to other keys.
  return [
    400, 401, 403,          // Client errors (bad key, rate limits, unsupported models)
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

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers }

  // Standard hop-by-hop / routing headers
  delete result['host']
  delete result['connection']
  delete result['content-length']
  delete result['transfer-encoding']

  // Strip Stainless SDK telemetry headers injected by the Anthropic SDK / Claude
  // Code CLI.  These fingerprint the request as coming from Claude Code itself and
  // can cause Anthropic's policy filters to fire when the request is re-proxied
  // through a third-party endpoint.
  for (const key of Object.keys(result)) {
    if (key.toLowerCase().startsWith('x-stainless-')) {
      delete result[key]
    }
  }

  return result
}
