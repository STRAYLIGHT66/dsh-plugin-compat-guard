/**
 * Child-process runner for the offline harness.
 *
 * Reads one JSON scenario from stdin, builds a fake Cordis context, and runs
 * the plugin for real. A "should die" scenario really does kill this process,
 * which is why the harness never runs the plugin in its own event loop.
 *
 * The scenario's `installAnchor` is exposed by pointing argv[2] at the fake
 * runtime root, exactly the way the desktop host passes its runtime directory.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const payload = JSON.parse(readFileSync(0, 'utf8'))

if (payload.installAnchor !== null) {
  // installAnchorOf() probes <argv[2]>/node_modules/@deepseek-ai/dsh/package.json
  // so give it the directory two levels above the fake anchor.
  process.argv[2] = join(payload.installAnchor, '..', '..', '..')
} else {
  process.argv[2] = ''
}

if (payload.profileDir === null) delete process.env.DSH_PROFILE_DIR
else process.env.DSH_PROFILE_DIR = payload.profileDir

const logger = () => ({
  info: () => {},
  warn: () => {},
  debug: () => {},
  error: () => {},
})

const ctx = {
  baseUrl: undefined,
  logger,
  loader: {
    entries() {
      return payload.entries
    },
    getTasks() {
      if (payload.settle === 'busy') return [1, 2, 3]
      if (payload.settle === 'none') return undefined
      return []
    },
  },
}

apply(ctx, payload.config)
process.stdout.write('__RESULT__ survived-apply\n')
