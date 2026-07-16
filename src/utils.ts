import crypto from 'crypto'

export function generateRequestId(): string {
  return crypto.randomUUID()
}

export function shouldRetry(statusCode: number): boolean {
  return [429, 500, 502, 503, 504].includes(statusCode)
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
