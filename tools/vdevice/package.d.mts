export interface PackageInfo {
  length: number;
  checksum: number;
  blocks: number;
}

export interface PackageOptions {
  image: Uint8Array | ArrayLike<number>;
  modelCode: string;
  modelName?: string;
  version?: Partial<{ x: number; y: number; z: number }>;
}

export interface PackageInfoFields {
  modelCode: string;
  version: { x: number; y: number; z: number };
  length: number;
  checksum: number;
}

export declare function buildPackage(opts: PackageOptions): { bytes: Uint8Array; info: PackageInfo };
export declare function tamperByte(bytes: Uint8Array, index: number): Uint8Array;
export declare function overrideLength(bytes: Uint8Array, length: number): Uint8Array;
export declare function verifyFrames(bytes: Uint8Array): Uint8Array[];
export declare function syntheticImage(size: number): Uint8Array;
export declare function readInfoFields(bytes: Uint8Array): PackageInfoFields;
