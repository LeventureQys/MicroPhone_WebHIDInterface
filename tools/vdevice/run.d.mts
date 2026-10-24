import type { ChildProcess } from 'node:child_process';

export interface RunOptions {
  port: number;
  controlPort: number;
  bridgeUrl: string;
}

export interface BridgeOptions {
  python: string;
  port: number;
  stdio?: 'inherit' | 'ignore' | 'pipe';
  env?: NodeJS.ProcessEnv;
  profilePath?: string;
}

export interface SidecarOptions {
  bridgeUrl: string;
  controlPort: number;
  deviceId?: string;
  level?: number;
  stdio?: 'inherit' | 'ignore' | 'pipe';
  execPath?: string;
}

export interface VDeviceOptions {
  port?: number;
  controlPort?: number;
  deviceId?: string;
  level?: number;
  stdio?: 'inherit' | 'ignore' | 'pipe';
  python?: string | null;
  healthTimeoutMs?: number;
}

export interface VDeviceHandle {
  bridge: ChildProcess;
  sidecar: ChildProcess;
  python: string;
  bridgeUrl: string;
  controlUrl: string;
  cleanup: () => void;
}

export declare const REPO_ROOT: string;
export declare const PROFILE_PATH: string;
export declare const SIDECAR_PATH: string;
export declare const VIRTUAL_HID_PATH: string;
export declare const DEVICE_ID: string;
export declare const DEFAULT_PYTHON: string;

export declare function parseRunArgs(argv: string[]): RunOptions;
export declare function resolvePython(env?: NodeJS.ProcessEnv): string | null;
export declare function delay(ms: number): Promise<void>;
export declare function waitForBridge(port: number, timeoutMs?: number): Promise<boolean>;
export declare function killChild(child: ChildProcess | null | undefined): void;
export declare function startBridge(options: BridgeOptions): ChildProcess;
export declare function startSidecar(options: SidecarOptions): ChildProcess;
export declare function startVDevice(options?: VDeviceOptions): Promise<VDeviceHandle>;
export declare function main(): Promise<void>;
