import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import type { SourceFile } from './files.js'

export interface ParsedFile extends SourceFile {
  ast: ts.SourceFile
}

export interface ParseResult {
  parsed: ParsedFile[]
  gaps: Fact[]
}

/**
 * Parse every file exactly once. Five separate passes over the same bytes cost
 * roughly half the runtime of a tool that runs after every agent session.
 *
 * `setParentNodes: false` because nothing reads `.parent` — every call site
 * already threads the source file explicitly.
 */
export function parseAll(files: readonly SourceFile[]): ParseResult {
  const parsed: ParsedFile[] = []
  const gaps: Fact[] = []

  for (const file of files) {
    const ast = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false)
    // createSourceFile never throws — it error-recovers and stashes the
    // diagnostics. Ignoring them means an unparseable file yields no facts AND
    // no gap, which is a confident all-clear over code we could not read.
    const diagnostics = (ast as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
    if (diagnostics.length > 0) {
      const first = diagnostics[0]
      gaps.push({
        kind: 'gap', reason: 'parse-error', subject: file.path,
        detail: first === undefined ? 'did not parse' : `did not parse: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`,
        where: { file: file.path, line: 1 },
      })
      continue
    }
    parsed.push({ ...file, ast })
  }
  return { parsed, gaps }
}
