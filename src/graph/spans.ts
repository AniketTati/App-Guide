import { ts } from 'ts-morph'

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'route'])

/**
 * Where each route's own code is in its file: the call that registers it, and
 * the handler it names when this file defines that handler — above the
 * routes, below them, anywhere. Keyed by the line the route is registered on.
 * A line in no route's span — a helper, an import — belongs to none of them.
 */
export function routeSpans(file: string, text: string, lines: readonly number[]): Map<number, [number, number][]> {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (pos: number): number => src.getLineAndCharacterOfPosition(pos).line + 1
  const span = (n: ts.Node): [number, number] => [lineOf(n.getStart(src)), lineOf(n.getEnd())]
  const wanted = new Set(lines)

  // Functions and constants this file defines, by name.
  const defined = new Map<string, ts.Node>()
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) defined.set(n.name.text, n)
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) defined.set(n.name.text, n)
    ts.forEachChild(n, collect)
  }
  collect(src)

  const handlerOf = (call: ts.CallExpression): ts.Expression | undefined => {
    for (const a of call.arguments) {
      if (ts.isObjectLiteralExpression(a)) {
        for (const p of a.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'handler') return p.initializer
      }
    }
    return call.arguments[call.arguments.length - 1]
  }
  const nameOf = (e: ts.Expression | undefined): string | null => {
    if (e === undefined) return null
    if (ts.isIdentifier(e)) return e.text
    if (ts.isPropertyAccessExpression(e)) return e.name.text
    return null
  }

  const out = new Map<number, [number, number][]>()
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && METHODS.has(n.expression.name.text)) {
      const at = lineOf(n.getStart(src))
      if (wanted.has(at) && !out.has(at)) {
        const spans: [number, number][] = [span(n)]
        const own = defined.get(nameOf(handlerOf(n)) ?? '')
        if (own !== undefined) spans.push(span(own))
        out.set(at, spans)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(src)
  return out
}
