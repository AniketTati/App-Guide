/**
 * JSON.stringify's array replacer is a *recursive property allow-list*, not a
 * key-order hint — passing Object.keys(obj) silently deletes every nested
 * object's contents. Sort the keys instead.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]))
}
