// src/shared/text.ts

/** Escape a string for safe use inside a RegExp */
export function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cheap snippet: N lines starting at index (clamped), joined */
export function snippetFrom(lines: string[], start: number, maxLines = 20): string {
  const s = Math.max(0, Math.min(start | 0, Math.max(0, lines.length - 1)));
  const e = Math.min(lines.length, s + Math.max(1, maxLines | 0));
  return lines.slice(s, e).join('\n');
}

/**
 * Multi-dot extension extractor:
 *  - "foo.ts"        -> ".ts"
 *  - "foo.min.js"    -> ".min.js"
 *  - "types.d.ts"    -> ".d.ts"
 *  - "a.d.ts.map"    -> ".d.ts.map"
 *  - ".gitignore"    -> ""  (dotfile, no ext)
 */
export function extOf(p: string): string {
  const base = (p.split(/[/\\]/).pop() || '').trim();
  if (!base || base.startsWith('.')) return '';
  const i = base.indexOf('.');
  return i === -1 ? '' : base.slice(i).toLowerCase();
}
