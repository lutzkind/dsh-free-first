/** Durable free-route health and managed-session records. */
import { type HealthRecord } from './health.js';
export interface ManagedSession {
    managed: true;
    since: number;
    movedToFallback: boolean;
}
export interface FreeFirstState {
    version: 1;
    health: HealthRecord;
    sessions: Record<string, ManagedSession>;
}
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
export declare function defaultFreeFirstState(): FreeFirstState;
/** One atomic JSON document under `$DSH_HOME/free-first/state.json`. */
export declare class FreeFirstStateStore {
    readonly path: string;
    private state;
    private writeChain;
    constructor(path?: string);
    load(): Promise<FreeFirstState>;
    current(): FreeFirstState;
    update(change: (state: FreeFirstState) => FreeFirstState): Promise<FreeFirstState>;
    private write;
    flush(): Promise<void>;
}
