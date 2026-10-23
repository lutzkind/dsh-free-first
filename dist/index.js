/**
 * DeepSeek Harness native free-first routing.
 *
 * Free-first owns one question: is the configured free route usable right now?
 * It selects the route in the agent loop's `agent/request` waterfall, turns a
 * conservative free-route failure into the same-step retry on the paid
 * fallback, and returns managed sessions to free after a confirmed recovery.
 * Paid timing remains owned by `@lutzkind/dsh-offpeak` through its `offpeak`
 * service; this plugin never waits on a peak window by itself.
 */
import { FreeFirstEngine } from './engine.js';
import { FreeFirstStateStore, resolveDshHome } from './state.js';
import { freeRouteUsable } from './health.js';
import { join } from 'node:path';
export const name = 'dsh-free-first';
export const inject = ['llm', 'commands'];
const DEFAULT_BACKOFF = [60_000, 120_000, 300_000, 600_000, 900_000];
function route(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`dsh-free-first: ${label} must be an object with provider and model`);
    }
    const candidate = value;
    if (typeof candidate.provider !== 'string' || candidate.provider.trim() === ''
        || typeof candidate.model !== 'string' || candidate.model.trim() === '') {
        throw new Error(`dsh-free-first: ${label} requires non-empty provider and model`);
    }
    return { provider: candidate.provider, model: candidate.model };
}
function positiveInteger(value, label) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`dsh-free-first: ${label} must be a positive integer`);
    }
    return value;
}
function validateConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('dsh-free-first: config must be an object');
    }
    const config = value;
    const allowed = new Set([
        'free', 'fallback', 'preferAsDefault', 'respectExplicitModelSelection', 'reasoningEffort',
        'backoffMs', 'maxCooldownMs', 'jitterRatio', 'routeRejectRetryMs', 'probeLeaseMs', 'statePath',
    ]);
    for (const key of Object.keys(config)) {
        if (!allowed.has(key))
            throw new Error(`dsh-free-first: unknown config key "${key}"`);
    }
    if (config.preferAsDefault !== undefined && typeof config.preferAsDefault !== 'boolean') {
        throw new Error('dsh-free-first: preferAsDefault must be a boolean');
    }
    if (config.respectExplicitModelSelection !== undefined && typeof config.respectExplicitModelSelection !== 'boolean') {
        throw new Error('dsh-free-first: respectExplicitModelSelection must be a boolean');
    }
    if (config.reasoningEffort !== undefined && typeof config.reasoningEffort !== 'string') {
        throw new Error('dsh-free-first: reasoningEffort must be a string');
    }
    const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF;
    if (!Array.isArray(backoffMs) || backoffMs.length === 0) {
        throw new Error('dsh-free-first: backoffMs must be a non-empty array');
    }
    const maxCooldownMs = positiveInteger(config.maxCooldownMs ?? 900_000, 'maxCooldownMs');
    const jitterRatio = config.jitterRatio ?? 0.1;
    if (typeof jitterRatio !== 'number' || !Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
        throw new Error('dsh-free-first: jitterRatio must be between 0 and 1');
    }
    return {
        free: route(config.free ?? { provider: 'opencode-go', model: 'beam-free' }, 'free'),
        fallback: route(config.fallback ?? { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, 'fallback'),
        preferAsDefault: config.preferAsDefault ?? true,
        respectExplicitModelSelection: config.respectExplicitModelSelection ?? true,
        ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
        backoffMs: backoffMs.map((value, index) => positiveInteger(value, `backoffMs[${index}]`)),
        maxCooldownMs,
        jitterRatio,
        routeRejectRetryMs: positiveInteger(config.routeRejectRetryMs ?? 300_000, 'routeRejectRetryMs'),
        probeLeaseMs: positiveInteger(config.probeLeaseMs ?? 120_000, 'probeLeaseMs'),
        ...(config.statePath === undefined ? {} : { statePath: config.statePath }),
    };
}
function routeOf(session) {
    return session.requestHeader?.()?.config;
}
function withRoute(config, next, reasoningEffort) {
    const { reasoningEffort: _inherited, ...rest } = config;
    return {
        ...rest,
        provider: next.provider,
        model: next.model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function formatStatus(engine, sessionId, session) {
    const state = engine.state();
    const health = state.health;
    const now = Date.now();
    const route = routeOf(session);
    const lines = [
        `Free-first: ${engine.config.free.provider}/${engine.config.free.model} -> ${engine.config.fallback.provider}/${engine.config.fallback.model}`,
        `Free route health: ${health.state === 'healthy' ? 'HEALTHY' : 'COOLDOWN'}`,
    ];
    if (health.state === 'cooldown') {
        lines.push(`Cooldown reason: ${health.cooldownReason ?? 'unknown'}`);
        lines.push(`Cooldown remaining: ${health.cooldownUntil === undefined ? 'unknown' : formatDuration(health.cooldownUntil - now)}`);
        lines.push(`Cooldown until: ${health.cooldownUntil === undefined ? 'unknown' : new Date(health.cooldownUntil).toISOString()}`);
        lines.push(`Consecutive failures: ${health.failures}; backoff level ${health.level}`);
    }
    if (health.probe !== undefined) {
        lines.push(`Recovery probe: ${health.probe.sessionId === sessionId ? 'this session' : health.probe.sessionId} (lease ${health.probe.until > now ? formatDuration(health.probe.until - now) : 'expired'})`);
    }
    if (route !== undefined)
        lines.push(`Last committed route: ${route.provider}/${route.model}`);
    const managed = engine.isManaged(session);
    lines.push(`This session managed: ${managed ? 'yes' : 'no (explicit or unrelated model)'}`);
    if (route !== undefined) {
        lines.push(`Next request: ${managed
            ? (freeRouteUsable(health, now) ? `${engine.config.free.provider}/${engine.config.free.model} (if probe available)` : `${engine.config.fallback.provider}/${engine.config.fallback.model}`)
            : `${route.provider}/${route.model} (unchanged)`}`);
    }
    lines.push(`Recovery: automatic after a confirmed free success; no background traffic.`);
    return lines.join('\n');
}
function handleCommand(engine, invocation) {
    const args = invocation.rawInput.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (args.length === 0 || args[0] === 'status') {
        return {
            kind: 'success',
            text: formatStatus(engine, invocation.agent.session.id, invocation.agent.session),
        };
    }
    if (args[0] === 'reset') {
        return engine.reset().then(() => ({
            kind: 'success',
            text: 'Free-route cooldown cleared. Managed sessions return to free on their next request; no probe traffic is sent.',
        }));
    }
    if (args[0] === 'help') {
        return {
            kind: 'success',
            text: 'Usage: /free-first [status|reset|help]\n\n  status  health, cooldown, current route, fallback and recovery state\n  reset   clear the shared cooldown and wake waiting requests',
        };
    }
    return { kind: 'error', text: 'Usage: /free-first [status|reset|help]' };
}
export async function apply(ctx, rawConfig) {
    const config = validateConfig(rawConfig);
    const store = new FreeFirstStateStore(config.statePath ?? join(resolveDshHome(), 'free-first', 'state.json'));
    await store.load();
    const engine = new FreeFirstEngine({ store, config });
    ctx.effect(() => () => engine.dispose(), 'dsh-free-first engine');
    ctx.on('agent/request', async (payload, next) => {
        const resolved = await next();
        const session = payload.agent.session;
        const original = { provider: resolved.provider, model: resolved.model };
        let guard = 0;
        while (guard++ < 16) {
            const selection = await engine.selectRoute(session, original);
            if (!selection.managed)
                return resolved;
            if (selection.route.provider === engine.config.free.provider
                && selection.route.model === engine.config.free.model) {
                return withRoute(resolved, engine.config.free, engine.config.reasoningEffort);
            }
            const offpeak = ctx.get('offpeak');
            if (offpeak === undefined || typeof offpeak.evaluate !== 'function' || typeof offpeak.waitUntilAllowed !== 'function') {
                return withRoute(resolved, engine.config.fallback, engine.config.reasoningEffort);
            }
            const paid = engine.config.fallback;
            if (offpeak.evaluate(paid.provider, paid.model, session.id).allowed) {
                return withRoute(resolved, paid, engine.config.reasoningEffort);
            }
            const controller = new AbortController();
            const onAbort = () => controller.abort(payload.signal.reason);
            payload.signal.addEventListener('abort', onAbort, { once: true });
            try {
                const freeWait = engine.waitForChange(controller.signal, session.id).then(() => 'free');
                const paidWait = offpeak.waitUntilAllowed({
                    provider: paid.provider,
                    model: paid.model,
                    sessionId: session.id,
                    kind: 'primary',
                    signal: controller.signal,
                }).then(() => 'paid');
                await Promise.race([freeWait, paidWait]);
            }
            finally {
                payload.signal.removeEventListener('abort', onAbort);
                controller.abort(new Error('free-first route decision settled'));
            }
            payload.signal.throwIfAborted();
        }
        return withRoute(resolved, engine.config.fallback, engine.config.reasoningEffort);
    });
    ctx.on('agent/request-error', async (payload, next) => {
        const session = payload.agent.session;
        const route = routeOf(session);
        if (route === undefined)
            return next();
        const result = await engine.recordFailure(session, payload.failure, route);
        if (!result.failover)
            return next();
        ctx.logger.warn(`dsh-free-first: ${route.provider}/${route.model} unavailable (${result.reason}); retrying the same step on ${engine.config.fallback.provider}/${engine.config.fallback.model}`);
        return { kind: 'retry' };
    }, { prepend: true });
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message' || event.data?.interrupted === true)
            return;
        const source = event.data?.message?.source ?? event.data?.source;
        if (typeof source?.provider !== 'string' || typeof source.model !== 'string')
            return;
        void engine.recordSuccess(session, { provider: source.provider, model: source.model }).catch((error) => {
            ctx.logger.warn(`dsh-free-first: could not record free-route recovery: ${String(error)}`);
        });
    });
    ctx.commands.register({
        name: 'free-first',
        description: 'Inspect or reset free-route health and paid fallback state',
        handler: (invocation) => handleCommand(engine, invocation),
    });
    ctx.logger.info(`dsh-free-first: loaded (${config.free.provider}/${config.free.model} -> ${config.fallback.provider}/${config.fallback.model})`);
}
