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
  delete result['host']
  delete result['connection']
  delete result['content-length']
  delete result['transfer-encoding']
  return result
}
