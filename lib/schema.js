/**
 * Configuration schema for dsh-plugin-compat-guard.
 *
 * Deliberately dependency-free: the plugin must not add a single import that
 * could fail to resolve, because a failed import would silently keep the guard
 * from ever running. The object below implements the standard schema interface
 * Cordis actually calls (`Config['~standard'].validate`), so defaults are filled
 * and unknown keys are refused without pulling in `@deepseek-ai/schemastery`.
 *
 * @module dsh-plugin-compat-guard/lib/schema
 */

/** Declared fields: [type, default]. */
const FIELDS = {
  /** Master switch. `false` disables the guard entirely. */
  enabled: ['boolean', true],
  /** Report and keep running instead of terminating. For install-time tests. */
  dryRun: ['boolean', false],
  /** Process exit code used for the abnormal termination. */
  exitCode: ['number', 1],
  /** Package names or Loader entry ids that are spared. */
  ignore: ['array', []],
  /** Write the crash log and the last-words file. */
  writeForensics: ['boolean', true],
  /** Override where the last-words file goes (profile-relative or absolute). */
  lastWordsPath: ['string', undefined],
  /** Write resolution traces to stderr. */
  trace: ['boolean', false],
}

/**
 * Validate a raw config against the declared fields.
 * @param {unknown} input - raw config from the loader patch.
 * @returns {{value: object} | {issues: Array<{message: string, path?: string[]}>}} result.
 */
function validate(input) {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    return { issues: [{ message: 'config must be an object' }] }
  }
  const source = input ?? {}
  const issues = []
  const value = {}
  for (const [key, [type, fallback]] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) {
      if (fallback !== undefined) value[key] = type === 'array' ? [...fallback] : fallback
      continue
    }
    const raw = source[key]
    if (type === 'array') {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
        issues.push({ message: 'expected an array of strings', path: [key] })
        continue
      }
      value[key] = [...raw]
      continue
    }
    if (typeof raw !== type) {
      issues.push({ message: `expected ${type}`, path: [key] })
      continue
    }
    if (type === 'number' && !Number.isInteger(raw)) {
      issues.push({ message: 'expected an integer', path: [key] })
      continue
    }
    value[key] = raw
  }
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(FIELDS, key)) issues.push({ message: 'unknown field', path: [key] })
  }
  if (issues.length > 0) return { issues }
  return { value }
}

/**
 * The Cordis config schema. `meta.default` mirrors the defaults so the loader's
 * diff/volatile machinery can treat an absent config as the default one.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-compat-guard',
    validate,
  },
  type: 'object',
  meta: {
    default: {
      enabled: true,
      dryRun: false,
      exitCode: 1,
      ignore: [],
      writeForensics: true,
      trace: false,
    },
  },
  dict: Object.fromEntries(Object.entries(FIELDS).map(([key, [type]] = []) => [key, { type }])),
}

export default Config
