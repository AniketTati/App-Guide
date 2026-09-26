/** "3h ago", "2 days ago" — for when something last moved. */
export function ago(iso: string | null): string {
  if (iso === null) return ''
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 90) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 14 ? `${d} days ago` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export const clock = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
