import { ts } from 'ts-morph'
import type { Fact } from '../model/facts.js'
import type { ParsedFile } from './parse.js'

/** SDKs whose mere import means outbound traffic to a known host. */
const SDK_HOSTS: Record<string, string> = {
  stripe: 'api.stripe.com',
  '@stripe/stripe-js': 'api.stripe.com',
  openai: 'api.openai.com',
  '@anthropic-ai/sdk': 'api.anthropic.com',
  '@sendgrid/mail': 'api.sendgrid.com',
  twilio: 'api.twilio.com',
  '@slack/web-api': 'slack.com',
  '@octokit/rest': 'api.github.com',
  resend: 'api.resend.com',
  '@aws-sdk/client-s3': 's3.amazonaws.com',
  'posthog-node': 'app.posthog.com',
}

/**
 * Where the code reaches outside the process. An agent quietly adding a call to
 * a new host is one of the few structural facts nobody reviews for, and it is
 * cheap to see: absolute URLs in string literals, plus SDK imports.
 */
export function scanExternal(files: readonly ParsedFile[], importers: ReadonlyMap<string, string[]>): Fact[] {
  const seen = new Set<string>()
  const facts: Fact[] = []

  for (const [pkg, host] of Object.entries(SDK_HOSTS)) {
    for (const file of importers.get(pkg) ?? []) {
      if (seen.has(`${host}|${pkg}`)) continue
      seen.add(`${host}|${pkg}`)
      facts.push({ kind: 'external', host, via: pkg, where: { file, line: 1 } })
    }
  }

  for (const file of files) {
    const src = file.ast
    const visit = (node: ts.Node): void => {
      // Only a URL passed to a call is a call. An <svg xmlns="http://www.w3.org/…">
      // in a spinner component is not outbound traffic, and treating it as one
      // put www.w3.org in the top block of every React repo.
      if (ts.isCallExpression(node)) {
        for (const arg of node.arguments) {
          if (!ts.isStringLiteralLike(arg)) continue
          const h = hostOf(arg.text)
          if (h !== null && !seen.has(`${h}|url`)) {
            seen.add(`${h}|url`)
            facts.push({
              kind: 'external', host: h, via: 'url',
              where: { file: file.path, line: src.getLineAndCharacterOfPosition(arg.getStart(src)).line + 1 },
            })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(src)
  }
  return facts
}

/** Hosts that appear in source as identifiers, not endpoints. */
const NAMESPACE_HOSTS = new Set([
  'www.w3.org', 'json-schema.org', 'schema.org', 'www.schema.org',
  'xmlns.com', 'purl.org', 'ns.adobe.com', 'sourcemaps.info',
])

function hostOf(text: string): string | null {
  if (!/^https?:\/\//i.test(text)) return null
  try {
    const { hostname, port } = new URL(text)
    // localhost is a dev detail, not an outbound dependency worth alarming on.
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return null
    // XML namespaces and schema identifiers are never fetched.
    if (NAMESPACE_HOSTS.has(hostname)) return null
    return port === '' ? hostname : `${hostname}:${port}`
  } catch {
    return null
  }
}
