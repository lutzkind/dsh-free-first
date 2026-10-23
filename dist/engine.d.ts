/** Free-first routing: health, one-probe recovery, managed sessions, and waits. */
import { type FailureView } from './classify.js';
import { type HealthOptions, type HealthRecord } from './health.js';
import type { FreeFirstState, FreeFirstStateStore } from './state.js';
export interface Route {
    provider: string;
    model: string;
}
export interface EngineConfig extends HealthOptions {
    free: Route;
    fallback: Route;
    preferAsDefault: boolean;
    respectExplicitModelSelection: boolean;
    reasoningEffort?: string;
}
export interface SessionView {
    id: string;
    requestHeader?: () => {
        config: Route;
    } | undefined;
    events?: () => readonly {
        type: string;
        data?: unknown;
    }[];
}
export interface SelectionResult {
    route: Route;
    managed: boolean;
    reason: string;
}
export interface FreeFirstEngineOptions {
    store: FreeFirstStateStore;
    config: EngineConfig;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
/** One process-local free-route controller. */
export declare class FreeFirstEngine {
    private readonly store;
    readonly config: EngineConfig;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly waiters;
    private disposed;
    constructor(options: FreeFirstEngineOptions);
    load(): Promise<void>;
    health(): HealthRecord;
    state(): FreeFirstState;
    /** Read the latest explicit selection recorded by the Session controller. */
    explicitSelection(session: SessionView): Route | undefined;
    /** Whether this session is owned by free-first rather than an explicit user route. */
    isManaged(session: SessionView): boolean;
    /**
     * Resolve the route for one request. A managed session uses the free route
     * when healthy or when it wins the single post-cooldown probe lease; every
     * other managed request uses the paid fallback.
     */
    selectRoute(session: SessionView, current: Route): Promise<SelectionResult>;
    /**
     * Record one free-route failure and decide whether the same step should be
     * retried on the paid fallback. Only a conservative transient/limit verdict
     * returns true.
     */
    recordFailure(session: SessionView, failure: FailureView, route: Route): Promise<{
        failover: boolean;
        reason: string;
    }>;
    /** A successful free-route assistant message confirms recovery. */
    recordSuccess(session: SessionView, route: Route): Promise<void>;
    /** Clear the cooldown on an explicit operator reset. */
    reset(): Promise<void>;
    /** Forget one session's managed record without touching shared health. */
    forgetSession(sessionId: string): Promise<void>;
    /**
     * Wait until free health changes or its next cooldown/probe boundary.
     * One timer is scheduled at the next authoritative instant; no polling.
     */
    waitForChange(signal?: AbortSignal, sessionId?: string): Promise<void>;
    wakeWaiters(): void;
    private persistHealth;
    dispose(): void;
}
