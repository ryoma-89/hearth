/**
 * GUI-editable settings. Only a small allow-list can be changed from the
 * browser; everything else (providers, keys, security roots) stays in
 * hearth.yaml. Edits are applied to the YAML document (comments preserved),
 * validated by loading the result as a complete config, written atomically,
 * and then applied to the running daemon.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { loadConfig } from '../config/load.ts'
import { MODE_NAMES, type HearthConfig } from '../config/types.ts'

export interface EditableSettings {
  defaultMode: string
  defaultModel: string
  'queue.maxConcurrentTasks': number
  'queue.maxConcurrentInference': number
  'web.search': string
  'web.searxngURL': string
  'security.deleteMode': string
}

export const EDITABLE_KEYS = ['defaultMode', 'defaultModel', 'queue.maxConcurrentTasks', 'queue.maxConcurrentInference', 'web.search', 'web.searxngURL', 'security.deleteMode'] as const
export type EditableKey = (typeof EDITABLE_KEYS)[number]

export class SettingsError extends Error {}

export function currentSettings(config: HearthConfig): EditableSettings {
  return {
    defaultMode: config.defaultMode,
    defaultModel: `${config.defaultModel.provider}/${config.defaultModel.model}`,
    'queue.maxConcurrentTasks': config.queue.maxConcurrentTasks,
    'queue.maxConcurrentInference': config.queue.maxConcurrentInference,
    'web.search': config.web.search,
    'web.searxngURL': config.web.searxngURL,
    'security.deleteMode': config.security.deleteMode,
  }
}

function checkValue(key: EditableKey, value: unknown, config: HearthConfig): unknown {
  const int = (min: number, max: number) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new SettingsError(`${key} must be an integer between ${min} and ${max}`)
    return value
  }
  const oneOf = (allowed: readonly string[]) => {
    if (typeof value !== 'string' || !allowed.includes(value)) throw new SettingsError(`${key} must be one of ${allowed.join(', ')}`)
    return value
  }
  switch (key) {
    case 'defaultMode':
      return oneOf(MODE_NAMES)
    case 'defaultModel': {
      const ids = Object.values(config.providers).flatMap(p => [`${p.name}/auto`, ...p.models.map(m => `${p.name}/${m.id}`)])
      return oneOf(ids)
    }
    case 'queue.maxConcurrentTasks':
    case 'queue.maxConcurrentInference':
      return int(1, 8)
    case 'web.search':
      return oneOf(['none', 'searxng', 'duckduckgo'])
    case 'web.searxngURL':
      if (typeof value !== 'string' || (value !== '' && !/^https?:\/\//.test(value))) throw new SettingsError('web.searxngURL must be empty or an http(s) URL')
      return value
    case 'security.deleteMode':
      return oneOf(['backup', 'deny', 'allow'])
  }
}

/**
 * Validate, persist, and return the reloaded configuration.
 * @param config - the running configuration (provides the file path).
 * @param patch - key/value changes from the GUI.
 * @param targetFile - config file to write.
 * @returns the freshly loaded configuration.
 */
export function applySettings(config: HearthConfig, patch: Record<string, unknown>, targetFile: string): HearthConfig {
  const keys = Object.keys(patch)
  if (keys.length === 0) throw new SettingsError('no settings given')
  for (const k of keys) if (!(EDITABLE_KEYS as readonly string[]).includes(k)) throw new SettingsError(`${k} cannot be changed from the GUI; edit hearth.yaml`)
  const doc = parseDocument(existsSync(targetFile) ? readFileSync(targetFile, 'utf8') : '{}\n')
  if (doc.errors.length) throw new SettingsError(`hearth.yaml has YAML errors: ${doc.errors[0]!.message}`)
  for (const k of keys as EditableKey[]) doc.setIn(k.split('.'), checkValue(k, patch[k], config))
  const tmp = `${targetFile}.${process.pid}.tmp`
  writeFileSync(tmp, doc.toString(), 'utf8')
  let reloaded: HearthConfig
  try {
    reloaded = loadConfig({ path: tmp })
  } catch (error) {
    rmSync(tmp, { force: true })
    throw new SettingsError((error as Error).message)
  }
  renameSync(tmp, targetFile)
  reloaded.sourcePath = targetFile
  return reloaded
}
