export interface SidecarOptions {
  bridge: string;
  device: string;
  controlPort: number;
  level: number;
}

export declare function parseArgs(argv: string[]): SidecarOptions;
export declare function padReportPayload(bytes: Uint8Array): Uint8Array | null;
