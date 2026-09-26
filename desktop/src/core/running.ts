import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)

/**
 * The local port a piece of work's web app is being served on, if one is
 * running: a process listening on this Mac whose working folder is that
 * work's web app. Read with `lsof`, which only lists; null when nothing is
 * running or `lsof` can't say.
 */
export async function servedAt(workPath: string, appDir: string): Promise<number | null> {
  const dir = join(workPath, appDir)
  try {
    const listening = (await exec('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 5000 })).stdout
    const ports = new Map<string, number[]>()
    let pid = ''
    for (const line of listening.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1)
      else if (line.startsWith('n')) {
        const m = /(?:^|[\]:*])(?:127\.0\.0\.1|\*|\[::1\]|\[::\]|localhost)?:(\d{2,5})$/.exec(line.slice(1))
        if (m !== null && pid !== '') ports.set(pid, [...(ports.get(pid) ?? []), Number(m[1])])
      }
    }
    if (ports.size === 0) return null
    const cwds = (await exec('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', [...ports.keys()].join(','), '-Fpn'], { timeout: 5000 })).stdout
    let at = ''
    const found: number[] = []
    for (const line of cwds.split('\n')) {
      if (line.startsWith('p')) at = line.slice(1)
      else if (line.startsWith('n') && (line.slice(1) === dir || line.slice(1).startsWith(`${dir}/`))) found.push(...(ports.get(at) ?? []))
    }
    return found.length === 0 ? null : Math.min(...found)
  } catch {
    return null
  }
}

/** The web app's folder, from where its router is: apps/web/src/App.tsx -> apps/web. */
export function appDirOf(routerFile: string): string {
  const parts = routerFile.split('/')
  const src = parts.indexOf('src')
  return src > 0 ? parts.slice(0, src).join('/') : parts.length > 2 && /^(apps|packages)$/.test(parts[0]!) ? parts.slice(0, 2).join('/') : ''
}
