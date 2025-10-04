// src/core/labels.ts
// Parsing helpers for node labels, kept DRY across the codebase.

export function bareFromLabel(label: string | undefined): string {
  const s = (label || '').trim();
  const m = /\b([A-Za-z_][A-Za-z0-9_]*)\(\)\s*$/.exec(s);
  return m ? m[1] : s;
}
