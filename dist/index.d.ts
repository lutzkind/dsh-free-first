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
import type { DshContext, Route } from './types.js';
export declare const name = "dsh-free-first";
export declare const inject: string[];
export interface Config {
    free?: Route;
    fallback?: Route;
    preferAsDefault?: boolean;
    respectExplicitModelSelection?: boolean;
    reasoningEffort?: string;
    backoffMs?: number[];
    maxCooldownMs?: number;
    jitterRatio?: number;
    routeRejectRetryMs?: number;
    probeLeaseMs?: number;
    statePath?: string;
}
export declare function apply(ctx: DshContext, rawConfig?: unknown): Promise<void>;
