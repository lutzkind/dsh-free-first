/** Pure free-route health state machine with absolute cooldowns and one probe lease. */
export type CooldownReason = 'rate-limit' | 'quota' | 'route-rejected' | 'transient';
export interface ProbeLease {
    sessionId: string;
    until: number;
}
export interface HealthRecord {
    state: 'healthy' | 'cooldown';
    cooldownUntil?: number;
    cooldownReason?: CooldownReason;
    level: number;
    failures: number;
    lastFailureAt?: number;
    lastFailureCode?: string;
    lastHealthyAt?: number;
    probe?: ProbeLease;
}
export interface HealthOptions {
    backoffMs: readonly number[];
    maxCooldownMs: number;
    jitterRatio: number;
    routeRejectRetryMs: number;
    probeLeaseMs: number;
}
export interface FailureInput {
    now: number;
    kind: CooldownReason;
    code?: string;
    providerRetryAfterMs?: number;
    random?: () => number;
}
export declare function initialHealth(): HealthRecord;
export declare function backoffFor(level: number, ladder: readonly number[]): number;
export declare function withJitter(value: number, ratio: number, random: () => number): number;
export declare function cooldownFor(record: HealthRecord, input: FailureInput, options: HealthOptions): number;
export declare function applyFailure(record: HealthRecord, input: FailureInput, options: HealthOptions): HealthRecord;
export declare function markHealthy(record: HealthRecord, now: number): HealthRecord;
export declare function cooldownExpired(record: HealthRecord, now: number): boolean;
/**
 * Claim the single recovery probe slot. Only one session may test the free
 * route after a cooldown; every other session stays on the paid fallback until
 * the probe settles or its lease expires.
 */
export declare function claimProbe(record: HealthRecord, sessionId: string, now: number, options: HealthOptions): {
    record: HealthRecord;
    claimed: boolean;
};
export declare function releaseProbe(record: HealthRecord, sessionId: string): HealthRecord;
export declare function freeRouteUsable(record: HealthRecord, now: number): boolean;
