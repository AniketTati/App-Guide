import { describe, expect, it } from 'vitest'
import { routeSpans } from '../src/graph/spans.js'

describe("a route's own code", () => {
  const FILE = `import { x } from './x.js'
export async function routes(app) {
  app.get('/a', { preHandler: requireUser }, handleA)
  app.get('/b', { preHandler: requireUser }, handleB)
  app.post('/c', {
    preHandler: requireUser,
    handler: async (req) => { return x(req) },
  })
}
async function handleA(req) {
  return 'a'
}
const handleB = async (req) => 'b'
function helper() { return 1 }
`
  const spans = routeSpans('r.ts', FILE, [3, 4, 5])

  it('is the call that registers it, and the handler it names wherever the file defines it', () => {
    expect(spans.get(3)).toEqual([[3, 3], [10, 12]])
    expect(spans.get(4)).toEqual([[4, 4], [13, 13]])
    expect(spans.get(5)).toEqual([[5, 8]])
  })

  it('leaves a helper that no route names to none of them', () => {
    const covered = [...spans.values()].flat().some(([a, b]) => a <= 14 && b >= 14)
    expect(covered).toBe(false)
  })
})
