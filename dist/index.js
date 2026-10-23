/**
 * DeepSeek Harness native free-first routing.
 *
 * Free-first owns one question: is the configured OpenCode Go free route usable
 * right now? It selects the route in the agent loop's `agent/request` waterfall,
 * turns a conservative free-route failure into the same-step retry on the paid
 * OpenCode Go fallback, and returns managed sessions to free after a confirmed
 * recovery. Paid timing remains owned by `@lutzkind/dsh-offpeak` through its
 * `offpeak` service; this plugin never waits on a peak window by itself and
 * never embeds a calendar.
 *
 * Ownership boundary: only `opencode-go` is managed. The direct DeepSeek API
 * (`deepseek/...`) and every unrelated provider pass through untouched, keep
 * their real errors, and are never used as a fallback.
 */
import { FreeFirstEngine, MANAGED_PROVIDER } from './engine.js';
import { FreeFirstStateStore, resolveDshHome } from './state.js';
import { FREE_USAGE_MODES, ModeStore, isFreeUsageMode } from './mode.js';
import { freeRouteUsable } from './health.js';
import { dirname, join } from 'node:path';
export const name = 'dsh-free-first';
export const inject = ['llm', 'commands'];
const DEFAULT_BACKOFF = [60_000, 120_000, 300_000, 600_000, 900_000];
const DEFAULT_FREE = { provider: MANAGED_PROVIDER, model: 'beam-free' };
const DEFAULT_FALLBACK = { provider: MANAGED_PROVIDER, model: 'deepseek-v4.1-flash' };
const DEFAULT_MODE = 'free-first';
const USAGE = [
    'Usage: /free-first [status|reset|mode <free-first|peak-only|disabled|configured>|help]',
    '',
    '  status                    mode, pricing, free health, cooldown, route, recovery',
    '  mode free-first           prefer free whenever it is healthy',
    '  mode peak-only            use free only during a verified OpenCode Go PEAK window',
    '  mode disabled             disable free-first routing; normal DSH routing applies',
    '  mode configured           forget the saved choice and use the configured default',
    '  reset                     clear the shared cooldown and wake waiting requests',
    '',
    'Scope: OpenCode Go only. Direct DeepSeek and every other provider are never',
    'routed, failed over, or delayed by this plugin.',
].join('\n');
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
        'free', 'fallback', 'mode', 'preferAsDefault', 'respectExplicitModelSelection', 'reasoningEffort',
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
    const mode = config.mode ?? DEFAULT_MODE;
    if (!isFreeUsageMode(mode)) {
        throw new Error(`dsh-free-first: mode must be one of ${FREE_USAGE_MODES.join(', ')}`);
    }
    const free = route(config.free ?? DEFAULT_FREE, 'free');
    const fallback = route(config.fallback ?? DEFAULT_FALLBACK, 'fallback');
    for (const [label, candidate] of [['free', free], ['fallback', fallback]]) {
        if (candidate.provider.toLowerCase() !== MANAGED_PROVIDER) {
            throw new Error(`dsh-free-first: ${label}.provider must be "${MANAGED_PROVIDER}"; direct DeepSeek and other providers are unmanaged`);
        }
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
        free,
        fallback,
        mode,
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
function isManagedProvider(provider) {
    return provider.toLowerCase() === MANAGED_PROVIDER;
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
/**
 * Ask the canonical pricing owner for the paid OpenCode Go route. Only a
 * positive PEAK answer may spend free quota; every other state, a missing
 * service, or a failed evaluation is treated as not-PEAK.
 */
function pricingView(ctx, route, sessionId) {
    const service = ctx.get('offpeak');
    if (service === undefined || typeof service.evaluate !== 'function') {
        return { state: 'UNKNOWN', peak: false, source: 'unavailable' };
    }
    try {
        const decision = service.evaluate(route.provider, route.model, sessionId);
        const state = typeof decision?.state === 'string' ? decision.state : 'UNKNOWN';
        return { state, peak: state === 'PEAK', source: 'offpeak' };
    }
    catch {
        return { state: 'UNKNOWN', peak: false, source: 'offpeak' };
    }
}
function modeLabel(mode) {
    switch (mode) {
        case 'free-first': return 'FREE-FIRST';
        case 'peak-only': return 'PEAK-ONLY';
        case 'disabled': return 'DISABLED';
    }
}
function formatStatus(engine, sessionId, session, pricing) {
    const state = engine.state();
    const health = state.health;
    const now = Date.now();
    const route = routeOf(session);
    const managed = engine.isManaged(session);
    const lines = [
        `Free-first: ${engine.config.free.provider}/${engine.config.free.model} -> ${engine.config.fallback.provider}/${engine.config.fallback.model}`,
        `Free usage mode: ${modeLabel(engine.mode)} (${engine.modeSource === 'override' ? 'saved override' : 'configured default'})`,
    ];
    if (engine.modeSource === 'override') {
        lines.push(`Configured mode: ${modeLabel(engine.configuredMode)}`);
    }
    if (engine.mode === 'peak-only') {
        lines.push(`Pricing owner: dsh-offpeak (${pricing.source === 'offpeak' ? 'canonical' : 'unavailable'})`);
        lines.push(`Pricing state: ${pricing.state}${pricing.peak ? ' (free eligible)' : ' (not PEAK; free not used)'}`);
    }
    lines.push(`Free route health: ${health.state === 'healthy' ? 'HEALTHY' : 'COOLDOWN'}`);
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
    if (engine.mode === 'disabled') {
        lines.push('This session managed: no (free-first disabled)');
    }
    else if (route !== undefined && !isManagedProvider(route.provider)) {
        lines.push(`This session managed: no (${route.provider} is outside OpenCode Go)`);
    }
    else {
        lines.push(`This session managed: ${managed ? 'yes' : 'no (explicit or unrelated model)'}`);
    }
    if (engine.mode === 'disabled') {
        lines.push('Next request: normal DSH routing (free-first disabled)');
    }
    else if (route !== undefined) {
        if (!isManagedProvider(route.provider)) {
            lines.push(`Next request: ${route.provider}/${route.model} (unchanged; outside OpenCode Go)`);
        }
        else if (!managed) {
            lines.push(`Next request: ${route.provider}/${route.model} (unchanged)`);
        }
        else if (engine.mode === 'peak-only' && !pricing.peak) {
            lines.push(`Next request: ${engine.config.fallback.provider}/${engine.config.fallback.model} (peak-only: ${pricing.state} is not PEAK)`);
        }
        else {
            lines.push(`Next request: ${managed
                ? (freeRouteUsable(health, now) ? `${engine.config.free.provider}/${engine.config.free.model} (if probe available)` : `${engine.config.fallback.provider}/${engine.config.fallback.model}`)
                : `${route.provider}/${route.model} (unchanged)`}`);
        }
    }
    lines.push('Recovery: automatic after a confirmed free success; no background traffic.');
    lines.push('Scope: OpenCode Go only; deepseek/* and every other provider are never routed, failed over, or delayed by this plugin.');
    return lines.join('\n');
}
function handleCommand(engine, invocation, ctx) {
    const args = invocation.rawInput.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    const session = invocation.agent.session;
    const pricing = pricingView(ctx, engine.config.fallback, session.id);
    if (args.length === 0 || args[0] === 'status') {
        return { kind: 'success', text: formatStatus(engine, session.id, session, pricing) };
    }
    if (args[0] === 'help')
        return { kind: 'success', text: USAGE };
    if (args[0] === 'reset') {
        return engine.reset().then(() => ({
            kind: 'success',
            text: 'Free-route cooldown cleared. Managed sessions return to free on their next request; no probe traffic is sent.',
        }));
    }
    if (args[0] === 'mode') {
        const requested = args[1];
        if (requested === undefined || args.length > 2)
            return { kind: 'error', text: USAGE };
        if (requested === 'configured') {
            return engine.clearModeOverride().then(() => ({
                kind: 'success',
                text: `Saved free usage mode cleared. Effective mode is ${modeLabel(engine.mode)} (configured default).`,
            }));
        }
        if (!isFreeUsageMode(requested))
            return { kind: 'error', text: USAGE };
        return engine.setMode(requested).then(() => ({
            kind: 'success',
            text: `Free usage mode set to ${modeLabel(engine.mode)} and saved. ${modeText(engine.mode)}`,
        }));
    }
    return { kind: 'error', text: USAGE };
}
function modeText(mode) {
    switch (mode) {
        case 'free-first':
            return 'Free is preferred whenever it is healthy.';
        case 'peak-only':
            return 'Free is used only when dsh-offpeak positively reports an OpenCode Go PEAK window; every other state uses the paid OpenCode Go route.';
        case 'disabled':
            return 'Free-first routing is off; normal DSH routing applies. dsh-offpeak is unchanged.';
    }
}
export async function apply(ctx, rawConfig) {
    const config = validateConfig(rawConfig);
    const statePath = config.statePath ?? join(resolveDshHome(), 'free-first', 'state.json');
    const store = new FreeFirstStateStore(statePath);
    const modeStore = new ModeStore(join(dirname(statePath), 'mode.json'));
    const engine = new FreeFirstEngine({ store, modeStore, config });
    await engine.load();
    ctx.effect(() => () => engine.dispose(), 'dsh-free-first engine');
    ctx.on('agent/request', async (payload, next) => {
        const resolved = await next();
        // Ownership boundary: never inspect, price, wait for, or rewrite a
        // non-OpenCode-Go route (including the direct DeepSeek API).
        if (!isManagedProvider(resolved.provider))
            return resolved;
        const session = payload.agent.session;
        const original = { provider: resolved.provider, model: resolved.model };
        let guard = 0;
        while (guard++ < 16) {
            if (engine.mode === 'disabled')
                return resolved;
            const pricing = pricingView(ctx, engine.config.fallback, session.id);
            const selection = await engine.selectRoute(session, original, pricing.peak);
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
        if (!isManagedProvider(route.provider))
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
        if (!isManagedProvider(source.provider))
            return;
        void engine.recordSuccess(session, { provider: source.provider, model: source.model }).catch((error) => {
            ctx.logger.warn(`dsh-free-first: could not record free-route recovery: ${String(error)}`);
        });
    });
    ctx.commands.register({
        name: 'free-first',
        description: 'Inspect or control OpenCode Go free-route usage, mode, and fallback state',
        handler: (invocation) => handleCommand(engine, invocation, ctx),
    });
    ctx.logger.info(`dsh-free-first: loaded (${modeLabel(engine.mode)}, ${config.free.provider}/${config.free.model} -> ${config.fallback.provider}/${config.fallback.model})`);
}
