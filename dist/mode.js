/**
 * Durable free-usage mode override.
 *
 * The mode is deliberately stored in its own small document, not in the health
 * record: a health write must never clobber an explicit operator choice, and
 * clearing the override must not touch availability evidence. Precedence is
 * saved choice > configured mode > `free-first`.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export const FREE_USAGE_MODES = ['free-first', 'peak-only', 'disabled'];
export const MODE_VERSION = 1;
export function isFreeUsageMode(value) {
    return typeof value === 'string' && FREE_USAGE_MODES.includes(value);
}
export function decodeMode(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const candidate = value;
    if (candidate.version !== MODE_VERSION)
        return undefined;
    return isFreeUsageMode(candidate.mode) ? candidate.mode : undefined;
}
/** One atomic JSON document under `$DSH_HOME/free-first/mode.json`. */
export class ModeStore {
    path;
    record;
    loaded = false;
    writeChain = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    async load() {
        if (this.loaded)
            return this.record?.mode;
        this.loaded = true;
        try {
            this.record = JSON.parse(await readFile(this.path, 'utf8'));
        }
        catch {
            this.record = undefined;
        }
        return decodeMode(this.record);
    }
    saved() {
        return this.record === undefined ? undefined : decodeMode(this.record);
    }
    async save(mode, updatedAt) {
        if (!isFreeUsageMode(mode))
            throw new Error(`dsh-free-first: invalid mode "${String(mode)}"`);
        this.record = { version: MODE_VERSION, mode, updatedAt };
        this.loaded = true;
        const document = this.record;
        this.writeChain = this.writeChain.then(() => this.write(document));
        await this.writeChain;
    }
    async clear() {
        this.record = undefined;
        this.loaded = true;
        this.writeChain = this.writeChain.then(() => rm(this.path, { force: true }));
        await this.writeChain;
    }
    async flush() {
        await this.writeChain;
    }
    async write(document) {
        const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
    }
}
