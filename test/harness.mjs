/**
 * Offline verification harness for dsh-plugin-compat-guard.
 *
 * The plugin is a doomsday device: installing it in a live profile kills the
 * app, so it cannot be smoke-tested in place. This harness builds fake profile
 * and installation trees, feeds the plugin a fake Cordis context whose Loader
 * behaves like the real one, and runs the plugin for real — in child
 * processes, because a passing case exits the process.
 *
 *   node test/harness.mjs
 *
 * Exit code 0 means every scenario behaved.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = dirname(HERE)
const RUNNER = join(HERE, 'run-plugin.mjs')

/** Write a package.json (and optional body) so resolution finds a real package. */
function packageAt(dir, manifest, body = 'export default class {}\n') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'index.js'), body, 'utf8')
  return dir
}

/** Build one fixture world: a fake dsh installation plus a fake profile. */
function buildWorld({ official = [], thirdParty = [], profileSiblings = [], declaredOnly = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'compat-guard-'))
  const install = join(root, 'app', 'node_modules')
  const profile = join(root, 'profile')

  const dependencies = {}
  for (const name of official) {
    packageAt(join(install, name), { name, version: '1.0.0' })
    dependencies[name] = '^1.0.0'
  }
  packageAt(
    join(install, '@deepseek-ai', 'dsh'),
    { name: '@deepseek-ai/dsh', version: '9.9.9', dependencies },
  )

  mkdirSync(profile, { recursive: true })
  const profileDependencies = {}
  for (const name of declaredOnly) profileDependencies[name] = '^0.0.1'
  writeFileSync(
    join(profile, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: profileDependencies }, null, 2)}\n`,
    'utf8',
  )
  for (const name of thirdParty) {
    packageAt(join(profile, 'node_modules', name), { name, version: '0.0.1' })
  }
  for (const name of profileSiblings) {
    packageAt(join(profile, name), { name, version: '0.0.1' })
  }
  return { root, installAnchor: join(install, '@deepseek-ai', 'dsh', 'package.json'), profile }
}

/** One Loader entry shaped like the real Entry class. */
const entry = (id, name, { group = false, disabled = false, active = true } = {}) => ({
  id,
  options: { id, name, ...(group ? { group: true } : {}), ...(disabled ? { disabled: true } : {}) },
  ...(group ? {} : { fiber: { state: active ? 2 : 1 } }),
})

/** Run the plugin in a child process and collect its observable behaviour. */
function run(scenario, { entries, world, config, settle = 'idle', env = {} }) {
  const payload = {
    entries,
    profileDir: world?.profile ?? null,
    installAnchor: world?.installAnchor ?? null,
    config,
    settle,
  }
  const result = spawnSync(process.execPath, [RUNNER], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  })
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    flag: /__RESULT__ (.*)/u.exec(result.stdout ?? '')?.[1] ?? null,
  }
}

let failures = 0
let checks = 0

/** Assert one condition and report it. */
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}\n`)
}

process.stdout.write('dsh-plugin-compat-guard :: offline scenarios\n\n')

// ---------------------------------------------------------------------------
// 1. a profile that carries a third-party plugin dies
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: ['@deepseek-ai/dsh-base'], thirdParty: ['dsh-plugin-memory'] })
  try {
    const out = run('third-party present', {
      world,
      entries: [
        entry('base', '@deepseek-ai/dsh-base'),
        entry('dsh-memory', 'dsh-plugin-memory'),
        entry('dsh-compat-guard', 'dsh-plugin-compat-guard'),
      ],
      config: { enabled: true, dryRun: false, exitCode: 1, ignore: [], writeForensics: true, trace: true },
    })
    process.stdout.write('scenario: third-party plugin mounted\n')
    check('process exited non-zero', out.status !== 0, `status=${String(out.status)}`)
    check('report names the offender', out.stderr.includes('dsh-plugin-memory'))
    check('report says FATAL', out.stderr.includes('::  FATAL'))
    check('last words were written', existsSync(join(world.profile, 'DONT_LOOK_HERE.txt')))
    check('crash log was written', existsSync(join(world.profile, '.plugin-manager', 'logs')))
    check('trace resolved the profile', out.stderr.includes('trace profile='))
    const report = existsSync(join(world.profile, 'DONT_LOOK_HERE.txt'))
      ? (await import('node:fs')).readFileSync(join(world.profile, 'DONT_LOOK_HERE.txt'), 'utf8')
      : ''
    check('forensics contain recovery instructions', report.includes('不想再看这一幕'))
    check('official entry survived', out.stderr.includes('@deepseek-ai/dsh-base'))
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 2. the guard itself never counts as third-party
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: ['@deepseek-ai/dsh-base'], thirdParty: [] })
  try {
    const out = run('self only', {
      world,
      entries: [entry('dsh-compat-guard', 'dsh-plugin-compat-guard'), entry('base', '@deepseek-ai/dsh-base')],
      config: { enabled: true, dryRun: false, exitCode: 1, ignore: [], writeForensics: true, trace: true },
    })
    process.stdout.write('scenario: only the guard is profile-local\n')
    check('clean profile survives', out.status === 0, `status=${String(out.status)}`)
    check('no crash report', !out.stderr.includes('::  FATAL'))
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 3. an area-local plugin next to the profile is still third-party
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], thirdParty: [], profileSiblings: ['local-widget'] })
  try {
    const out = run('local path plugin', {
      world,
      entries: [entry('local-widget', join(world.profile, 'local-widget', 'index.js'))],
      config: { enabled: true, dryRun: false, exitCode: 7, ignore: [], writeForensics: false },
    })
    process.stdout.write('scenario: plugin mounted by absolute path inside the profile\n')
    check('path-mounted plugin is indicted', out.stderr.includes('local-widget'))
    check('configured exit code is used', out.status === 7, `status=${String(out.status)}`)
    check('writeForensics:false writes nothing', !existsSync(join(world.profile, 'DONT_LOOK_HERE.txt')))
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 4. ignore spares a named package
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], thirdParty: ['dsh-plugin-memory'] })
  try {
    const out = run('ignored package', {
      world,
      entries: [entry('dsh-memory', 'dsh-plugin-memory')],
      config: { enabled: true, dryRun: false, exitCode: 1, ignore: ['dsh-plugin-memory'], writeForensics: false },
    })
    process.stdout.write('scenario: ignore list\n')
    check('ignored package survives', out.status === 0, `status=${String(out.status)}`)
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 5. dryRun reports without killing anything
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], thirdParty: ['dsh-plugin-memory'] })
  try {
    const out = run('dry run', {
      world,
      entries: [entry('dsh-memory', 'dsh-plugin-memory')],
      config: { enabled: true, dryRun: true, exitCode: 1, ignore: [], writeForensics: false },
    })
    process.stdout.write('scenario: dryRun\n')
    check('dryRun survives', out.status === 0, `status=${String(out.status)}`)
    check('dryRun still reports', out.stderr.includes('DRY RUN'))
    check('dryRun names the offender', out.stderr.includes('dsh-plugin-memory'))
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 6. disabled does nothing at all
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], thirdParty: ['dsh-plugin-memory'] })
  try {
    const out = run('disabled', {
      world,
      entries: [entry('dsh-memory', 'dsh-plugin-memory')],
      config: { enabled: false, dryRun: false, exitCode: 1, ignore: [], writeForensics: true },
    })
    process.stdout.write('scenario: enabled=false\n')
    check('disabled guard is silent', out.status === 0 && out.stderr.trim() === '', `status=${String(out.status)}`)
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 7. an unresolvable profile withholds judgment instead of guessing
// ---------------------------------------------------------------------------
{
  const out = run('no profile dir', {
    world: null,
    entries: [entry('dsh-memory', 'dsh-plugin-memory')],
    config: { enabled: true, dryRun: false, exitCode: 1, ignore: [], writeForensics: true },
    env: { DSH_PROFILE_DIR: '' },
  })
  process.stdout.write('scenario: profile directory unresolvable\n')
  check('withheld judgment survives', out.status === 0, `status=${String(out.status)}`)
}

// ---------------------------------------------------------------------------
// 8. a busy Loader is treated as settled instead of blocking forever
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], thirdParty: ['dsh-plugin-memory'] })
  try {
    const out = run('busy loader', {
      world,
      entries: [entry('dsh-memory', 'dsh-plugin-memory')],
      config: { enabled: true, dryRun: false, exitCode: 3, ignore: [], writeForensics: false },
      settle: 'busy',
    })
    process.stdout.write('scenario: Loader never goes idle\n')
    check('busy Loader still reaches a verdict', out.status === 3, `status=${String(out.status)}`)
    check('report records the busy boot', out.stderr.includes('stable-but-busy'))
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 9. group entries are structural, never plugins
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], thirdParty: [] })
  try {
    const out = run('group entry', {
      world,
      entries: [entry('some-group', 'whatever', { group: true })],
      config: { enabled: true, dryRun: false, exitCode: 1, ignore: [], writeForensics: false, trace: true },
    })
    process.stdout.write('scenario: group entry\n')
    check('group rows are skipped', out.status === 0 && out.stderr.includes('entries=0'), out.stderr.trim())
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 10. a profile dependency that does not resolve is still third-party
// ---------------------------------------------------------------------------
{
  const world = buildWorld({ official: [], declaredOnly: ['ghost-plugin'] })
  try {
    const out = run('declared but missing', {
      world,
      entries: [entry('ghost', 'ghost-plugin')],
      config: { enabled: true, dryRun: false, exitCode: 5, ignore: [], writeForensics: false, trace: true },
    })
    process.stdout.write('scenario: profile dependency with no on-disk package\n')
    check('declared dependency is indicted', out.status === 5, `status=${String(out.status)}`)
    check('reason names the profile manifest', out.stderr.includes('declared as a dependency of the profile'))
  } finally {
    rmSync(world.root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 11. the schema fills defaults and refuses junk
// ---------------------------------------------------------------------------
{
  const { Config } = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'schema.js')).href)
  const validate = Config['~standard'].validate
  process.stdout.write('scenario: config schema\n')
  check('empty config gets defaults', validate({}).value.exitCode === 1 && validate({}).value.enabled === true)
  check('absent config gets defaults', validate(undefined).value.writeForensics === true)
  check('wrong type is refused', Array.isArray(validate({ exitCode: 'boom' }).issues))
  check('unknown field is refused', Array.isArray(validate({ nope: 1 }).issues))
  check('array of strings passes', validate({ ignore: ['a'] }).value.ignore[0] === 'a')
  check('array of non-strings is refused', Array.isArray(validate({ ignore: [1] }).issues))
  check('defaults survive mutation', validate(undefined).value.ignore !== validate(undefined).value.ignore)
}

// ---------------------------------------------------------------------------
// 12. the module exposes exactly the shape the Loader looks for
// ---------------------------------------------------------------------------
{
  const mod = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'index.js')).href)
  const manifest = JSON.parse((await import('node:fs')).readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  process.stdout.write('scenario: module surface\n')
  check('apply is exported', typeof mod.apply === 'function')
  check('default export is apply', mod.default === mod.apply)
  check('inject asks for the loader', Array.isArray(mod.inject) && mod.inject.includes('loader'))
  check('Config carries a standard schema', typeof mod.Config['~standard'].validate === 'function')
  check('manifest declares the bundle patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
  check('manifest sets the icon', manifest.icon === './icon.svg')
  check('patch file exists', existsSync(join(PLUGIN_DIR, 'cordis.patch.yml')))
  check('patch ids the row the module reports', (await import('node:fs')).readFileSync(join(PLUGIN_DIR, 'cordis.patch.yml'), 'utf8').includes('id: dsh-compat-guard'))
  check('locale files exist', existsSync(join(PLUGIN_DIR, 'locale', 'zh.json')) && existsSync(join(PLUGIN_DIR, 'locale', 'en.json')))
  check('READMEs exist', existsSync(join(PLUGIN_DIR, 'README.md')) && existsSync(join(PLUGIN_DIR, 'README.zh.md')))
}

process.stdout.write(`\n${String(checks - failures)}/${String(checks)} checks passed\n`)
process.exit(failures === 0 ? 0 : 1)
