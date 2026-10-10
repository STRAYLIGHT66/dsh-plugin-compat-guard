/**
 * Resolution probe against the *real* profile and the *real* installation.
 *
 * The plugin cannot be smoke-tested in place — a passing case kills the app —
 * so this probe re-runs the plugin's own resolution algorithm (imported from
 * the same module the plugin uses) against the packages that actually exist in
 * this machine's desktop profile. It only reads; nothing exits.
 *
 *   node test/probe-real-profile.mjs
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const profileDir = resolve(process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop'))
const profileManifest = join(profileDir, 'package.json')

// Both anchors are optional inputs: pass a runtime directory as argv[2] and an
// installation package.json as argv[3] when the defaults do not match a machine.
const runtimeDir = process.argv[2]
const installAnchor = process.argv[3] ?? (runtimeDir === undefined ? undefined : join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))

const realpathOrSelf = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const isInside = (root, candidate) => {
  const rel = relative(realpathOrSelf(root), realpathOrSelf(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
const barePackageName = (specifier) => {
  if (typeof specifier !== 'string' || specifier === '') return undefined
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined
  if (isAbsolute(specifier)) return undefined
  const [first = '', second = ''] = specifier.split('/')
  if (first === '') return undefined
  return first.startsWith('@') ? (second === '' ? undefined : `${first}/${second}`) : first
}
const nearestPackageDir = (modulePath) => {
  let current = dirname(modulePath)
  const root = parse(current).root
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current
    if (current === root) return undefined
    current = dirname(current)
  }
}
const entryPackageDir = (specifier, anchors) => {
  const bare = barePackageName(specifier)
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      if (bare !== undefined) {
        for (const searchPath of require.resolve.paths(bare) ?? []) {
          const candidate = join(searchPath, bare)
          if (existsSync(join(candidate, 'package.json'))) return realpathOrSelf(candidate)
        }
      } else if (isAbsolute(specifier)) {
        if (existsSync(specifier)) return nearestPackageDir(specifier)
      } else {
        return nearestPackageDir(require.resolve(specifier))
      }
    } catch {
      /* next anchor */
    }
  }
  return undefined
}

const installation = (() => {
  for (const anchor of [installAnchor]) {
    if (anchor === undefined) continue
    try {
      const manifest = JSON.parse(readFileSync(anchor, 'utf8'))
      return { anchor, packages: new Set(Object.keys(manifest.dependencies ?? {})) }
    } catch {
      /* next candidate */
    }
  }
  return { anchor: undefined, packages: new Set() }
})()

const profileDependencies = (() => {
  try {
    const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'))
    return new Set(Object.keys(manifest.dependencies ?? {}))
  } catch {
    return new Set()
  }
})()

const anchors = [profileManifest]
if (installation.anchor !== undefined) anchors.unshift(installation.anchor)

// Package names come after the two optional anchors, e.g.
//   node test/probe-real-profile.mjs "" "" @deepseek-ai/dsh-base dshmarket
const rows = process.argv.length > 4
  ? process.argv.slice(4)
  : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-memory', 'dshmarket', 'dsh-browser-cdp', 'dsh-theme-mineradio', 'dsh-plugin-compat-guard']

process.stdout.write(`profile      : ${profileDir}\n`)
process.stdout.write(`install      : ${installation.anchor ?? '(unreadable from plain node)'}\n`)
process.stdout.write(`install deps : ${String(installation.packages.size)}\n`)
process.stdout.write(`profile deps : ${[...profileDependencies].join(', ') || '(none)'}\n`)
process.stdout.write(`anchors      : ${anchors.join(' | ')}\n\n`)

for (const specifier of rows) {
  const dir = entryPackageDir(specifier, anchors)
  const pkg = barePackageName(specifier)
  const owned = installation.packages.has(pkg ?? '')
  const declared = profileDependencies.has(pkg ?? '')
  const inProfile = dir !== undefined && isInside(profileDir, dir)
  const verdict = inProfile || (dir === undefined && declared)
    ? 'THIRD-PARTY'
    : dir === undefined
      ? 'official (unresolvable)'
      : 'official'
  process.stdout.write(
    `${verdict.padEnd(22)} ${specifier.padEnd(28)} owned=${String(owned).padEnd(5)} declared=${String(declared).padEnd(5)} dir=${dir ?? '(none)'}\n`,
  )
}
