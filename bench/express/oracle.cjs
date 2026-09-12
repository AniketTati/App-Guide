// Ground truth: every route Express ACTUALLY registered, read at runtime.
const exampleDir = process.argv[2]
const root = process.argv[3]
process.chdir(exampleDir)

// Collect every app Express creates, however it is mounted. vhost() and a
// prefix-less use() both hide sub-apps from a walk that starts at the export.
const libPath = require.resolve(root + '/lib/express')
const orig = require(libPath)
const allApps = []
function wrapped() { const a = orig.apply(this, arguments); allApps.push(a); return a }
Object.assign(wrapped, orig)
require.cache[libPath].exports = wrapped
delete require.cache[require.resolve(root)]
const express = require(root)
const Router = require(require.resolve('router', { paths: [root] }))

// Express 5 does not keep the mount prefix as a string on the layer.
const mounts = new Map()
const subapps = []
const oUse = Router.prototype.use
Router.prototype.use = function (a, ...rest) {
  if (typeof a === 'string') for (const h of rest.flat(Infinity)) if (typeof h === 'function' && Array.isArray(h.stack)) mounts.set(h, a)
  return oUse.call(this, a, ...rest)
}
const oAppUse = express.application.use
express.application.use = function (a, ...rest) {
  if (typeof a === 'string') for (const h of rest.flat(Infinity)) if (h && typeof h.handle === 'function' && typeof h.set === 'function') subapps.push([h, a])
  return oAppUse.call(this, a, ...rest)
}
express.application.listen = function () { return { close() {}, address() { return {} } } }

let exported
try { exported = require(require.resolve(exampleDir)) }
catch (e) { console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e).split('\n')[0] })); process.exit(0) }
const app = exported && exported.router ? exported : allApps[0] || null
if (!app) { console.log(JSON.stringify({ ok: false, error: 'no app created' })); process.exit(0) }

const join = (a, b) => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
const out = new Set()
function walk(stack, prefix) {
  for (const l of stack) {
    if (l.route) {
      const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path]
      for (const [m, on] of Object.entries(l.route.methods)) if (on) for (const p of paths) if (typeof p === 'string') out.add(`${m === '_all' ? 'ALL' : m.toUpperCase()} ${join(prefix, p)}`)
    } else if (l.handle && Array.isArray(l.handle.stack)) {
      walk(l.handle.stack, join(prefix, mounts.get(l.handle) || ''))
    }
  }
}
const walked = new Set()
const visit = (a, prefix) => { if (!walked.has(a) && a.router) { walked.add(a); walk(a.router.stack, prefix) } }
visit(app, '')
for (const [sub, prefix] of subapps) visit(sub, prefix)
for (const a of allApps) visit(a, '')
console.log(JSON.stringify({ ok: true, apps: allApps.length, routes: [...out].sort() }))
process.exit(0)
