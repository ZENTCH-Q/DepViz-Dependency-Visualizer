// src/core/text.ts
// Shared string preprocessors (comments/strings stripping, continuation flattening).

/** Remove comments and string literals from Python source. */
export function stripStringsAndCommentsPy(src: string): string {
  let s = src.replace(/^[ \t]*#.*$/gm, '');
  s = s.replace(/("""|''')[\s\S]*?\1/g, '');
  s = s.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '');
  return s;
}

/** Join line continuations and parenthesized import lists for Python. */
export function normalizeContinuationsPy(src: string): string {
  let s = src.replace(/\\\r?\n/g, ' ');
  s = s.replace(/from\s+[^\n]+\s+import\s*\(([\s\S]*?)\)/g, (m) => m.replace(/\r?\n/g, ' '));
  return s;
}
