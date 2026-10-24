export declare const ACTIONS: readonly string[];
export declare const REPLY_ACTIONS: readonly string[];

export interface FaultContext {
  mode?: string;
  func?: number;
  dfuCmd?: number;
  phase?: string;
}

export interface FaultOn {
  mode: string;
  phase: string;
  func?: number;
  dfuCmd?: number;
  nth?: number;
}

export interface FaultRule {
  on: FaultOn;
  action: string;
  times: number;
  ms?: number;
  code?: number;
}

export declare function parseFaults(raw: unknown): FaultRule[];

export declare class FaultTable {
  constructor(rules?: unknown[]);
  set(rules?: unknown[]): number;
  size(): number;
  match(ctx: FaultContext | null | undefined): FaultRule | null;
  consume(rule: FaultRule): boolean;
  reset(): void;
  fired(): number;
}
