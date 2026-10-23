/**
 * Durable free-usage mode override.
 *
 * The mode is deliberately stored in its own small document, not in the health
 * record: a health write must never clobber an explicit operator choice, and
 * clearing the override must not touch availability evidence. Precedence is
 * saved choice > configured mode > `free-first`.
 */

import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const FREE_USAGE_MODES = ['free-first', 'peak-only', 'disabled'] as const

export type FreeUsageMode = typeof FREE_USAGE_MODES[number]

export const MODE_VERSION = 1

export interface ModeRecord {
  version: typeof MODE_VERSION
  mode: FreeUsageMode
  updatedAt: number
}

export function isFreeUsageMode(value: unknown): value is FreeUsageMode {
  return typeof value === 'string' && (FREE_USAGE_MODES as readonly string[]).includes(value)
}

export function decodeMode(value: unknown): FreeUsageMode | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<ModeRecord>
  if (candidate.version !== MODE_VERSION) return undefined
  return isFreeUsageMode(candidate.mode) ? candidate.mode : undefined
}

/** One atomic JSON document under `$DSH_HOME/free-first/mode.json`. */
export class ModeStore {
  readonly path: string
  private record: ModeRecord | undefined
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = path
  }

  async load(): Promise<FreeUsageMode | undefined> {
    if (this.loaded) return this.record?.mode
    this.loaded = true
    try {
      this.record = JSON.parse(await readFile(this.path, 'utf8')) as ModeRecord
    } catch {
      this.record = undefined
    }
    return decodeMode(this.record)
  }

  saved(): FreeUsageMode | undefined {
    return this.record === undefined ? undefined : decodeMode(this.record)
  }

  async save(mode: FreeUsageMode, updatedAt: number): Promise<void> {
    if (!isFreeUsageMode(mode)) throw new Error(`dsh-free-first: invalid mode "${String(mode)}"`)
    this.record = { version: MODE_VERSION, mode, updatedAt }
    this.loaded = true
    const document = this.record
    this.writeChain = this.writeChain.then(() => this.write(document))
    await this.writeChain
  }

  async clear(): Promise<void> {
    this.record = undefined
    this.loaded = true
    this.writeChain = this.writeChain.then(() => rm(this.path, { force: true }))
    await this.writeChain
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private async write(document: ModeRecord): Promise<void> {
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
  }
}
