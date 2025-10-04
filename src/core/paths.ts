// src/core/paths.ts
// Path normalization helpers. Keep FS case sensitivity; never lowercase.

export const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Normalize a path by removing "." and ".." segments, using posix slashes.
 *  Preserves a leading "/" for absolute paths. */
export function normalizePosixPath(input: string): string {
  const s = toPosix(input);
  const isAbs = s.startsWith('/');
  const parts = s.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  const body = out.join('/');
  return isAbs ? '/' + body : body;
}

// Legacy alias for keys; intentionally identical to toPosix for now.
export const normKey = toPosix;
