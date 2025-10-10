// src/shared/base64.ts
export function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}
