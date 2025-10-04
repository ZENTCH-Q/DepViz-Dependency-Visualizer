// src/core/hash.ts
// Single source of truth for FNV-1a 32-bit hex hashing (zero-padded).
// Use this everywhere; do NOT re-implement hashing locally.

export function fnv1a32(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0'); // stable width
}

// Alias, so you can import { hash } if you like that name better.
export const hash = fnv1a32;
