import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/render/markdown.js'
import { alarming, allClear, unsupported } from './render.fixture.js'

describe('markdown', () => {
  it('is forwardable — the summary survives on its own', () => {
    expect(renderMarkdown(alarming())).toContain('Your agent added 3 routes')
  })

  it('carries the denominator, not an adjective', () => {
    const md = renderMarkdown(alarming())
    expect(md).toContain('**1 of 48** routes')
    expect(md).not.toMatch(/danger|critical|severe/i)
  })

  it('never drops the coverage note', () => {
    const md = renderMarkdown(unsupported())
    expect(md).toContain('Not covered')
    expect(md).toContain('hono')
  })

  it('says nothing loudly when nothing happened', () => {
    expect(renderMarkdown(allClear())).toContain('nothing new to the shape')
  })
})
