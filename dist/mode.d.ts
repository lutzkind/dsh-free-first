/**
 * Durable free-usage mode override.
 *
 * The mode is deliberately stored in its own small document, not in the health
 * record: a health write must never clobber an explicit operator choice, and
 * clearing the override must not touch availability evidence. Precedence is
 * saved choice > configured mode > `free-first`.
 */
export declare const FREE_USAGE_MODES: readonly ["free-first", "peak-only", "disabled"];
export type FreeUsageMode = typeof FREE_USAGE_MODES[number];
export declare const MODE_VERSION = 1;
export interface ModeRecord {
    version: typeof MODE_VERSION;
    mode: FreeUsageMode;
    updatedAt: number;
}
export declare function isFreeUsageMode(value: unknown): value is FreeUsageMode;
export declare function decodeMode(value: unknown): FreeUsageMode | undefined;
/** One atomic JSON document under `$DSH_HOME/free-first/mode.json`. */
export declare class ModeStore {
    readonly path: string;
    private record;
    private loaded;
    private writeChain;
    constructor(path: string);
    load(): Promise<FreeUsageMode | undefined>;
    saved(): FreeUsageMode | undefined;
    save(mode: FreeUsageMode, updatedAt: number): Promise<void>;
    clear(): Promise<void>;
    flush(): Promise<void>;
    private write;
}
