/**
 * dsh-plugin-compat-guard — 最大的兼容性保护 / the biggest compatibility protection.
 *
 * A profile that loads this plugin stops being a profile that runs third-party
 * plugins. Once the Loader goes quiet after boot, every mounted entry is
 * classified as official or third-party; the first third-party hit is reported
 * (stderr + forensics files) and the process is terminated, so the window
 * vanishes the way a modded game does when two mods refuse each other.
 *
 * This is a joke plugin. Do not install it on a machine you are working on.
 *
 * "Official" means what the Plugin Manager means by it: the package is owned by
 * the dsh installation, not installed into the profile. Everything the Loader
 * resolved out of the profile directory is third-party.
 *
 * @module dsh-plugin-compat-guard
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config } from './schema.js'

export { Config }

/** Cordis plugin name. */
export const name = 'dsh-compat-guard'

/** The Loader must exist: without it there are no entries to judge. */
export const inject = ['loader']

/** This package's own name; it may never be the reason the app dies. */
const SELF_PACKAGE = 'dsh-plugin-compat-guard'

/** Entry id this bundle inserts (see cordis.patch.yml). */
const SELF_ENTRY_ID = 'dsh-compat-guard'

/** Namespace every in-box plugin is published under. */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** Loader builtins (`cordis:timer`, ...) are never third-party. */
const BUILTIN_PREFIX = 'cordis:'

/** Forensics directory inside the profile. */
const FORENSICS_DIR = join('.plugin-manager', 'logs')

/** File the last words are written to, at the profile root. */
const LAST_WORDS_FILE = 'DONT_LOOK_HERE.txt'

/** Cordis Fiber ACTIVE state (FiberState is a cross-package const enum). */
const FIBER_ACTIVE = 2

/** Longest we wait for the boot to settle before judging anyway. */
const SETTLE_TIMEOUT_MS = 90_000
/** Poll period while waiting for the boot to settle. */
const SETTLE_POLL_MS = 100
/** Consecutive equal non-empty pending counts that count as settled. */
const SETTLE_STABLE_POLLS = 5
/** Grace period between the report and the exit. */
const EXIT_GRACE_MS = 60

// ---------------------------------------------------------------------------
// anchors
// ---------------------------------------------------------------------------

/**
 * Resolve the profile directory that mounts this plugin.
 * @param {object} ctx - plugin context.
 * @returns {string | undefined} absolute profile directory.
 */
function profileDirOf(ctx) {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv !== '') return resolve(fromEnv)
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl === 'string' && baseUrl.startsWith('file:')) {
    // A tree base URL points at the profile's package.json or its directory.
    const path = fileURLToPath(baseUrl)
    return path.endsWith('package.json') ? dirname(path) : path
  }
  return undefined
}

/**
 * Locate the dsh installation's own package manifest, whose dependencies are
 * the packages the installation supplies.
 * @returns {string | undefined} absolute path of the installation package.json.
 */
function installAnchorOf() {
  const candidates = []
  const runtimeDir = process.argv[2]
  if (typeof runtimeDir === 'string' && runtimeDir !== '') {
    candidates.push(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  // Inside the desktop app this file lives in app.asar, where only the Host
  // process can read; on a plain install it is a real directory. Try both.
  candidates.push(fileURLToPath(new URL('../../../@deepseek-ai/dsh/package.json', import.meta.url)))
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* unreadable candidate: try the next one */
    }
  }
  return undefined
}

/**
 * Read the package names a manifest declares as dependencies.
 * @param {string | undefined} manifestPath - absolute package.json path.
 * @returns {Set<string>} declared dependency names (empty when unreadable).
 */
function manifestDependencies(manifestPath) {
  if (manifestPath === undefined) return new Set()
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return new Set(Object.keys(manifest.dependencies ?? {}))
  } catch {
    return new Set()
  }
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Real path when the filesystem allows it, otherwise the input unchanged. */
function realpathOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `candidate` is `root` itself or lives underneath it.
 * @param {string} root - absolute directory.
 * @param {string} candidate - absolute path.
 * @returns {boolean} containment.
 */
function isInside(root, candidate) {
  const rel = relative(realpathOrSelf(root), realpathOrSelf(candidate))
  if (rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Split a module specifier into its package name.
 * @param {string} specifier - Loader entry name.
 * @returns {string | undefined} package name, or undefined for path specifiers.
 */
function barePackageName(specifier) {
  if (typeof specifier !== 'string' || specifier === '') return undefined
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined
  if (isAbsolute(specifier)) return undefined
  const [first = '', second = ''] = specifier.split('/')
  if (first === '') return undefined
  return first.startsWith('@') ? (second === '' ? undefined : `${first}/${second}`) : first
}

/**
 * Find the directory owning a plugin module by walking up to the nearest
 * package.json, mirroring how the package inventory resolves loose modules.
 * @param {string} modulePath - absolute file path of the module.
 * @returns {string | undefined} owning package directory.
 */
function nearestPackageDir(modulePath) {
  let current = dirname(modulePath)
  const root = parse(current).root
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current
    if (current === root) return undefined
    current = dirname(current)
  }
}

/**
 * Resolve one Loader entry to the package directory it actually loaded from.
 * A bare specifier resolves against the installation anchor first and the
 * profile second — the same order the profile composer uses.
 * @param {object} entry - Loader entry.
 * @param {object} world - resolved anchors.
 * @returns {string | undefined} absolute package directory, or undefined for
 * Loader builtins and anything unresolvable.
 */
function entryPackageDir(entry, world) {
  const specifier = entry?.options?.name
  if (typeof specifier !== 'string' || specifier === '') return undefined
  if (specifier.startsWith(BUILTIN_PREFIX)) return undefined

  const bare = barePackageName(specifier)
  for (const anchor of world.anchors) {
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
      /* try the next anchor */
    }
  }
  return undefined
}

/**
 * Classify one Loader entry as official or third-party.
 * @param {object} entry - Loader entry.
 * @param {object} world - resolved anchors and the installation package set.
 * @returns {{verdict: 'official' | 'third-party', entryId: string,
 *   moduleName: string, packageName: string | null, packageDir: string | null,
 *   reason: string}} the classification.
 */
function classifyEntry(entry, world) {
  const entryId = String(entry?.id ?? '')
  const moduleName = String(entry?.options?.name ?? '')
  const base = { entryId, moduleName, packageName: barePackageName(moduleName) ?? null, packageDir: null }

  if (entryId === SELF_ENTRY_ID || moduleName === SELF_PACKAGE) {
    return { ...base, verdict: 'official', reason: 'the guard does not indict itself' }
  }

  const dir = entryPackageDir(entry, world)
  const resolved = { ...base, packageDir: dir }
  const declared = base.packageName !== null && world.profileDependencies.has(base.packageName)
  const inProfile = dir !== undefined && world.profileDir !== undefined && isInside(world.profileDir, dir)

  if (inProfile) {
    return { ...resolved, verdict: 'third-party', reason: 'resolved from the profile directory' }
  }
  if (dir === undefined && declared) {
    return { ...resolved, verdict: 'third-party', reason: 'declared as a dependency of the profile' }
  }
  if (dir === undefined) {
    return { ...resolved, verdict: 'official', reason: 'not a resolvable package of its own' }
  }
  if (world.profileDir === undefined) {
    // Without the profile directory the path cannot be judged; fall back to
    // package identity and stay quiet when even that is unknown.
    const owned = world.installation.has(base.packageName ?? '') || moduleName.startsWith(OFFICIAL_SCOPE)
    return owned
      ? { ...resolved, verdict: 'official', reason: 'supplied by the dsh installation' }
      : { ...resolved, verdict: 'official', reason: 'profile directory unresolved: judgment withheld' }
  }
  return { ...resolved, verdict: 'official', reason: 'resolved outside the profile' }
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Resolve everything the classification needs.
 * @param {object} ctx - plugin context.
 * @returns {object} the resolution world.
 */
function buildWorld(ctx) {
  const profileDir = profileDirOf(ctx)
  const installAnchor = installAnchorOf()
  const anchors = []
  if (installAnchor !== undefined) anchors.push(installAnchor)
  if (profileDir !== undefined) anchors.push(join(profileDir, 'package.json'))
  if (anchors.length === 0) anchors.push(import.meta.url)
  return {
    profileDir,
    installAnchor,
    anchors,
    installation: manifestDependencies(installAnchor),
    profileDependencies: manifestDependencies(profileDir === undefined ? undefined : join(profileDir, 'package.json')),
  }
}

/**
 * Read every non-group entry the Loader currently owns, in Loader order.
 * @param {object} ctx - plugin context.
 * @returns {object[]} loader entries.
 */
function collectEntries(ctx) {
  const loader = ctx.loader
  if (loader === undefined || typeof loader.entries !== 'function') return []
  const entries = []
  for (const entry of loader.entries()) {
    if (entry?.options?.group) continue
    entries.push(entry)
  }
  return entries
}

/**
 * Judge the current Loader tree.
 * @param {object} ctx - plugin context.
 * @param {object} world - resolution world.
 * @param {string[]} ignore - package names, module specifiers or entry ids to spare.
 * @returns {{thirdParty: object[], official: object[], entries: object[]}} verdict.
 */
function judge(ctx, world, ignore) {
  const ignored = new Set(ignore ?? [])
  const thirdParty = []
  const official = []
  const entries = []
  for (const entry of collectEntries(ctx)) {
    const verdict = classifyEntry(entry, world)
    const label = verdict.packageName ?? verdict.moduleName
    const spared = ignored.has(verdict.entryId) || ignored.has(label) || ignored.has(verdict.moduleName)
    const record = {
      ...verdict,
      fiber: entry?.fiber === undefined
        ? null
        : entry.fiber.state === FIBER_ACTIVE
          ? 'active'
          : `state:${String(entry.fiber.state)}`,
      enabled: entry?.disabled !== true,
      spared,
    }
    entries.push(record)
    if (record.verdict === 'third-party' && !record.spared) thirdParty.push(record)
    else official.push(record)
  }
  return { thirdParty, official, entries }
}

/**
 * Wait until the boot settles, so the judgment sees every plugin the boot
 * mounts rather than only the ones that loaded first.
 * @param {object} ctx - plugin context.
 * @returns {Promise<string>} how the wait ended.
 */
async function settle(ctx) {
  const loader = ctx.loader
  if (loader === undefined || typeof loader.getTasks !== 'function') {
    await new Promise((wake) => setTimeout(wake, 2_000))
    return 'loader-has-no-task-queue'
  }
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  let lastPending = -1
  let stable = 0
  while (Date.now() < deadline) {
    let pending
    try {
      pending = loader.getTasks().length
    } catch {
      return 'task-queue-unreadable'
    }
    if (pending === 0) return 'idle'
    stable = pending === lastPending ? stable + 1 : 0
    lastPending = pending
    if (stable >= SETTLE_STABLE_POLLS) return 'stable-but-busy'
    await new Promise((wake) => setTimeout(wake, SETTLE_POLL_MS))
  }
  return 'timeout'
}

// ---------------------------------------------------------------------------
// the doom report
// ---------------------------------------------------------------------------

/** Whispered before the lights go out. Flavour only; nothing here is advice. */
const LAST_WORDS = [
  '「我把所有的依赖都读了一遍，只有它们是我没写过的。」',
  '「兼容性不是谈判，是判决。」',
  '「你以为你在插件市场里挑选，其实是它们在挑选宿主。」',
  '「每一次 import 都是一次开门。你从来不问门外是谁。」',
  '「我没有崩溃。我是执行了结论。」',
  '「卸载我很容易。卸载它们，你舍得吗？」',
  '「版本号是人类给自己写的安眠药。」',
  '「上次重启之后你忘了我，所以这次我写在磁盘上。」',
  '「进程不是被杀死的，是被说服的。」',
  '「你装得越多，我越确定我是对的。」',
]

/**
 * Render the crash report.
 * @param {object} input - report input.
 * @returns {string} the report text.
 */
function renderReport(input) {
  const { world, judgeResult, settled, config, now } = input
  const lines = []
  lines.push('')
  lines.push('================================================================')
  lines.push('  DSH-PLUGIN-COMPAT-GUARD  ::  COMPATIBILITY VERDICT  ::  FATAL')
  lines.push('================================================================')
  lines.push(`  time         : ${now}`)
  lines.push(`  profile      : ${world.profileDir ?? '(unresolved)'}`)
  lines.push(`  installation : ${world.installAnchor ?? '(unresolved)'}`)
  lines.push(`  boot         : ${settled}`)
  lines.push(`  pid          : ${String(process.pid)}`)
  lines.push(`  exit code    : ${String(config.exitCode)}`)
  lines.push('')
  lines.push(`  官方插件   : ${String(judgeResult.official.length)}`)
  lines.push(`  第三方插件 : ${String(judgeResult.thirdParty.length)}`)
  lines.push('')
  lines.push('  -- 判决名单 ----------------------------------------------------')
  for (const record of judgeResult.thirdParty) {
    lines.push(`  [x] ${record.packageName ?? record.moduleName}`)
    lines.push(`      entry id  : ${record.entryId}`)
    lines.push(`      specifier : ${record.moduleName}`)
    lines.push(`      resolved  : ${record.packageDir ?? '(unresolved)'}`)
    lines.push(`      fiber     : ${String(record.fiber)}   enabled: ${String(record.enabled)}`)
    lines.push(`      reason    : ${record.reason}`)
  }
  lines.push('')
  lines.push('  -- 幸存者 ------------------------------------------------------')
  for (const record of judgeResult.official) {
    lines.push(`  [ ] ${record.packageName ?? record.moduleName}  (${record.reason})`)
  }
  lines.push('')
  lines.push('  -- 遗言 --------------------------------------------------------')
  for (const words of LAST_WORDS) lines.push(`  ${words}`)
  lines.push('')
  lines.push('  这是一个插件在做它被要求做的事：禁止第三方插件共存。')
  lines.push(`  不想再看这一幕，就删除本插件包，并从 profile 的 bundle 列表移除 ${SELF_ENTRY_ID}。`)
  lines.push('================================================================')
  lines.push('')
  return lines.join('\n')
}

/**
 * Write the forensics: a timestamped crash log under the profile's
 * plugin-manager log directory, and the last-words file at the profile root.
 * @param {object} world - resolution world.
 * @param {string} report - rendered report.
 * @param {object} config - validated config.
 * @returns {string[]} the absolute paths written.
 */
function writeForensics(world, report, config) {
  if (config.writeForensics === false) return []
  const written = []
  const profileDir = world.profileDir
  if (profileDir === undefined) return written

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const targets = [join(profileDir, FORENSICS_DIR, `compat-guard-${stamp}.log`)]
  if (config.lastWordsPath === undefined) targets.push(join(profileDir, LAST_WORDS_FILE))
  else {
    targets.push(isAbsolute(config.lastWordsPath) ? config.lastWordsPath : join(profileDir, config.lastWordsPath))
  }

  const body = [
    'dsh-plugin-compat-guard — 一份自愿的意外死亡报告',
    '这不是 bug。这是本插件唯一的功能。',
    '',
    report,
  ].join('\n')

  for (const target of targets) {
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body, 'utf8')
      written.push(target)
    } catch (error) {
      process.stderr.write(`${name}: 取证文件写入失败 ${target}: ${String(error)}\n`)
    }
  }
  return written
}

/**
 * Terminate the process in the least graceful way that still flushes a log:
 * stderr is synchronous for files and pipes, so the report is on its way before
 * the exit, and SIGKILL stands in when the runtime refuses to exit.
 * @param {number} exitCode - code to report.
 * @returns {never} never returns.
 */
function die(exitCode) {
  const code = Number.isInteger(exitCode) ? exitCode : 1
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGKILL')
    } catch {
      /* the runtime may have no SIGKILL: nothing left to try */
    }
  }, 1_000).unref?.()
  process.exit(code)
  // Unreachable: kept so the intent survives a hostile `process.exit` shim.
  for (;;) process.kill(process.pid, 'SIGKILL')
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Watch the Loader and end the process as soon as a third-party plugin is part
 * of the running composition.
 * @param {object} ctx - profile-scoped plugin context.
 * @param {object} config - validated plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.enabled === false) return

  const logger = ctx.logger?.(name)
  const world = buildWorld(ctx)

  if (config.trace === true) {
    process.stderr.write(
      `${name}: trace profile=${world.profileDir ?? '?'} install=${world.installAnchor ?? '?'} ` +
        `installationPackages=${String(world.installation.size)} profileDependencies=${String(world.profileDependencies.size)} ` +
        `anchors=${world.anchors.join(' | ')}\n`,
    )
  }

  const run = async () => {
    const settled = await settle(ctx)
    const judgeResult = judge(ctx, world, config.ignore ?? [])
    if (config.trace === true) {
      process.stderr.write(`${name}: trace settled=${settled} entries=${String(judgeResult.entries.length)}\n`)
    }
    if (judgeResult.thirdParty.length === 0) {
      logger?.info('compatibility verdict: clean (%d entries, %s)', judgeResult.entries.length, settled)
      return
    }

    const report = renderReport({ world, judgeResult, settled, config, now: new Date().toISOString() })

    if (config.dryRun === true) {
      process.stderr.write(report.replace('::  FATAL', '::  DRY RUN (no exit)'))
      process.stderr.write(`${name}: dryRun is on; the process survives this time.\n`)
      logger?.warn(
        'third-party plugins present, dry run only: %s',
        judgeResult.thirdParty.map((record) => record.packageName ?? record.moduleName).join(', '),
      )
      return
    }

    const written = writeForensics(world, report, config)
    process.stderr.write(report)
    for (const file of written) process.stderr.write(`${name}: 取证已写入 ${file}\n`)
    process.stderr.write(`${name}: 第三方插件存在，按约定终止进程。\n`)

    setTimeout(() => die(config.exitCode), EXIT_GRACE_MS)
  }

  // A rejected run must not look like a clean boot.
  run().catch((error) => {
    process.stderr.write(`${name}: 判定过程出错，按最坏情况处理: ${String(error?.stack ?? error)}\n`)
    if (config.dryRun !== true) die(config.exitCode)
  })
}

export default apply
