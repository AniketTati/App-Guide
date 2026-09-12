// Scores static extraction against the runtime oracle. Exits non-zero if any
// route was missed silently: the tool may fail to list a route, but it must
// never fail to say that it could not.
const { join } = require('node:path')
const work = process.argv[2]
const oracle = require(join(work, 'oracle.json'))
const stat = require(join(work, 'static.json'))
const split = (r) => [r.slice(0, r.indexOf(' ')), r.slice(r.indexOf(' ') + 1)]
const DISCLOSING = ['dynamic-dispatch', 'computed-route-path', 'unresolved-route-prefix']

let total = 0, exact = 0, loose = 0, reported = 0, real = 0, disclosed = 0
const silent = [], excluded = []
for (const [app, o] of Object.entries(oracle)) {
  if (!o.ok) { excluded.push(`${app} (${o.error})`); continue }
  const runtime = [...new Set(o.routes)]
  const statics = stat[app]?.routes ?? []
  const names = new Set(statics.map((x) => x.r))
  const paths = new Set(runtime.map((r) => split(r)[1]))
  const disclosing = (stat[app]?.gaps ?? []).some((g) => DISCLOSING.some((d) => g.startsWith(d)))
  const used = new Set()
  for (const r of runtime) {
    const [m, p] = split(r)
    // Express 5 expands app.all into one route per method at runtime.
    if (names.has(r) || names.has(`ALL ${p}`)) { exact++; loose++; continue }
    const i = statics.findIndex((s, j) => {
      if (used.has(j)) return false
      const [sm, sp] = split(s.r)
      if (sm !== m && sm !== 'ALL') return false
      return sp === '/' ? s.scope !== null : p.endsWith(sp)
    })
    if (i >= 0) { used.add(i); loose++ }
    else if (disclosing) disclosed++
    else silent.push(`${app}: ${r}`)
  }
  for (const s of names) {
    reported++
    const [sm, sp] = split(s)
    if (runtime.includes(s) || (sm === 'ALL' && paths.has(sp))) real++
  }
  total += runtime.length
}

const pct = (a, b) => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1)}%`)
const row = (label, a, b) => console.log(`${label.padEnd(28)}${`${a}/${b}`.padStart(9)}  ${pct(a, b)}`)
console.log(`\nRoute recall — Express example apps against what Express registers at runtime`)
console.log(`${Object.keys(oracle).length - excluded.length} apps, ${total} routes${excluded.length ? `  (excluded: ${excluded.join('; ')})` : ''}\n`)
row('found exactly', exact, total)
row('found, prefix missed', loose, total)
row('reported that were real', real, reported)
row('written-out routes found', exact, total - disclosed)
console.log(`${'missed, disclosed by a gap'.padEnd(28)}${String(disclosed).padStart(9)}`)
console.log(`${'missed SILENTLY (must be 0)'.padEnd(28)}${String(silent.length).padStart(9)}`)
for (const s of silent) console.log(`   ${s}`)
process.exitCode = silent.length > 0 ? 1 : 0
