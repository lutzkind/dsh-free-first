/** Durable free-route health and managed-session records. */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { initialHealth } from './health.js';
const STATE_VERSION = 1;
const MAX_SESSIONS = 500;
export function resolveDshHome(env = process.env) {
    const configured = env.DSH_HOME?.trim();
    return configured ? configured : join(homedir(), '.dsh');
}
export function defaultFreeFirstState() {
    return { version: STATE_VERSION, health: initialHealth(), sessions: {} };
}
function sanitizeHealth(value) {
    if (typeof value !== 'object' || value === null)
        return initialHealth();
    const candidate = value;
    if (candidate.state !== 'healthy' && candidate.state !== 'cooldown')
        return initialHealth();
    const health = {
        state: candidate.state,
        level: Number.isInteger(candidate.level) ? Math.max(0, candidate.level) : 0,
        failures: Number.isInteger(candidate.failures) ? Math.max(0, candidate.failures) : 0,
    };
    if (typeof candidate.cooldownUntil === 'number')
        health.cooldownUntil = candidate.cooldownUntil;
    if (typeof candidate.cooldownReason === 'string')
        health.cooldownReason = candidate.cooldownReason;
    if (typeof candidate.lastFailureAt === 'number')
        health.lastFailureAt = candidate.lastFailureAt;
    if (typeof candidate.lastFailureCode === 'string')
        health.lastFailureCode = candidate.lastFailureCode;
    if (typeof candidate.lastHealthyAt === 'number')
        health.lastHealthyAt = candidate.lastHealthyAt;
    if (typeof candidate.probe === 'object' && candidate.probe !== null
        && typeof candidate.probe.sessionId === 'string'
        && typeof candidate.probe.until === 'number') {
        health.probe = {
            sessionId: candidate.probe.sessionId,
            until: candidate.probe.until,
        };
    }
    return health;
}
function sanitize(value) {
    if (typeof value !== 'object' || value === null)
        return defaultFreeFirstState();
    const candidate = value;
    if (candidate.version !== STATE_VERSION)
        return defaultFreeFirstState();
    const sessions = {};
    if (typeof candidate.sessions === 'object' && candidate.sessions !== null) {
        for (const [id, record] of Object.entries(candidate.sessions)) {
            if (id.length === 0 || typeof record !== 'object' || record === null)
                continue;
            const managed = record;
            if (managed.managed !== true || typeof managed.since !== 'number')
                continue;
            sessions[id] = {
                managed: true,
                since: managed.since,
                movedToFallback: managed.movedToFallback === true,
            };
        }
    }
    return {
        version: STATE_VERSION,
        health: sanitizeHealth(candidate.health),
        sessions: trimSessions(sessions),
    };
}
function trimSessions(sessions) {
    const entries = Object.entries(sessions).sort((left, right) => left[1].since - right[1].since);
    if (entries.length <= MAX_SESSIONS)
        return sessions;
    return Object.fromEntries(entries.slice(entries.length - MAX_SESSIONS));
}
/** One atomic JSON document under `$DSH_HOME/free-first/state.json`. */
export class FreeFirstStateStore {
    path;
    state;
    writeChain = Promise.resolve();
    constructor(path = join(resolveDshHome(), 'free-first', 'state.json')) {
        this.path = path;
    }
    async load() {
        if (this.state)
            return this.state;
        try {
            this.state = sanitize(JSON.parse(await readFile(this.path, 'utf8')));
        }
        catch {
            this.state = defaultFreeFirstState();
        }
        return this.state;
    }
    current() {
        return this.state ?? defaultFreeFirstState();
    }
    async update(change) {
        const current = await this.load();
        const next = sanitize(change(structuredClone(current)));
        this.state = next;
        this.writeChain = this.writeChain.then(() => this.write(next));
        await this.writeChain;
        return next;
    }
    async write(state) {
        const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
    }
    async flush() {
        await this.writeChain;
    }
}
