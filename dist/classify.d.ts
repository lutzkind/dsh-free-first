/** Conservative free-route failure classification for DeepSeek Harness LlmFailure values. */
export interface FailureView {
    message?: string;
    code?: string;
    status?: number;
    providerRetryAfterMs?: number;
}
export type FailureKind = 'rate-limit' | 'quota' | 'route-rejected' | 'transient';
export interface Classification {
    failover: boolean;
    kind?: FailureKind;
    reason: string;
}
/**
 * Classify one free-route failure.
 *
 * Fallback is reserved for a genuine rate limit, an exhausted free allowance,
 * the OpenCode free-tier provenance gate, or a transient provider outage.
 * Bad requests, authentication, invalid models, context errors, tool errors,
 * content filtering, and plugin defects keep their real error.
 */
export declare function classifyFailure(failure: FailureView | undefined): Classification;
