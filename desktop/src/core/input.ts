import type { AskInput, Note, NoteTarget } from '../shared/api.js'

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']

/**
 * What "Ask for a change" sends, checked field by field: only text, only
 * within bounds, never anything that names a file or a command. Shared by the
 * app and the development server, so the two can't drift — the app once
 * dropped the preview's hash here, and every add was refused.
 */
export function askInput(json: string): AskInput {
  const raw = JSON.parse(json) as Record<string, unknown>
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const picks = Array.isArray(raw['picks']) ? raw['picks'].slice(0, 40).flatMap((p) => {
    const o = p as Record<string, unknown>
    return (o['kind'] === 'screen' || o['kind'] === 'route') && typeof o['key'] === 'string' ? [{ kind: o['kind'] as 'screen' | 'route', key: o['key'].slice(0, 300) }] : []
  }) : []
  return {
    what: text(raw['what'], 4000),
    why: text(raw['why'], 4000),
    criteria: Array.isArray(raw['criteria']) ? raw['criteria'].slice(0, 20).map((c) => text(c, 1000)) : [],
    picks,
    ...(typeof raw['id'] === 'string' ? { id: raw['id'].slice(0, 8) } : {}),
    ...(typeof raw['severity'] === 'string' && SEVERITIES.includes(raw['severity']) ? { severity: raw['severity'] } : {}),
    ...(typeof raw['hash'] === 'string' && /^[0-9a-f]{1,64}$/.test(raw['hash']) ? { hash: raw['hash'] } : {}),
  }
}

const TARGETS: readonly NoteTarget[] = ['screen', 'table', 'part', 'group', 'job', 'role', 'route', 'product']

/** A note as the page sends it, checked field by field: what it's pinned
 *  to, what it says, and where it was written. Text only, within bounds. */
export function noteInput(json: string, id: string, at: string): Note {
  const raw = JSON.parse(json) as Record<string, unknown>
  const t = (raw['target'] ?? {}) as Record<string, unknown>
  const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const kind = TARGETS.find((k) => k === t['kind'])
  const body = text(raw['text'], 4000).trim()
  if (kind === undefined || body === '') throw new Error('a note needs something to be about, and some words')
  return {
    id, on: text(raw['on'], 600) || 'main', at, sentAt: null, text: body,
    target: { kind, key: text(t['key'], 600), label: text(t['label'], 300) },
  }
}
