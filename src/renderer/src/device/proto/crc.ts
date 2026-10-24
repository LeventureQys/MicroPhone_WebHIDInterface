/** Modbus CRC-16：多项式 0xA001（0x8005 反射），初值 0xFFFF，无最终异或 */
const CRC_POLY = 0xa001;
const CRC_INIT = 0xffff;

/**
 * 逐位实现而非查表：本层要求能在 Node 与浏览器同时跑，且协议层帧长最大 512 B，
 * 逐位的 8 倍开销可以忽略，换来一份能对着规格书逐行核对的实现。
 */
export function crc16(bytes: Uint8Array): number {
  let crc = CRC_INIT;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ CRC_POLY : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/** 低字节先发 */
export function crcLo(crc: number): number {
  return crc & 0xff;
}

export function crcHi(crc: number): number {
  return (crc >>> 8) & 0xff;
}
