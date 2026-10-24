export declare const PATTERNS: readonly string[];
export declare const DEFAULT_PERIOD_MS: number;
export declare const DEFAULT_STEP_VALUE: number;
export declare const LEVEL_MIN: number;
export declare const LEVEL_MAX: number;

export type LevelPattern = 'sine' | 'step' | 'silence';

export interface LevelOptions {
  pattern?: LevelPattern;
  periodMs?: number;
  min?: number;
  max?: number;
  value?: number;
}

export interface LevelSnapshot {
  pattern: LevelPattern;
  periodMs: number;
  min: number;
  max: number;
  value: number;
}

export declare class LevelSource {
  constructor(opts?: LevelOptions);
  set(opts?: LevelOptions): LevelSnapshot;
  value(now?: number): number;
  snapshot(): LevelSnapshot;
}
