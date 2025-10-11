// src/shared/parseUtils.ts

/**
 * Strip (best-effort) strings and comments from mixed-language source.
 * Keeps newlines so line numbers remain roughly stable.
 */
export function stripStringsAndComments(src: string): string {
  // Remove block comments /* ... */ and /** ... */ and <!-- ... -->
  let s = src
    // JS/C/Java block
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat(m.split('\n').length - 1))
    // HTML/XML
    .replace(/<!--[\s\S]*?-->/g, (m) => '\n'.repeat(m.split('\n').length - 1));

  // Remove single-line comments: //, #, -- (SQL/Lua-ish), ; in lisp-ish (skip if ; inside string)
  s = s.replace(
    /(^|[ \t])(?:\/\/|#|--|;)(.*)$|("[^"\\]*(?:\\.[^"\\]*)*")|('[^'\\]*(?:\\.[^'\\]*)*')|(`[^`\\]*(?:\\.[^`\\]*)*`)/gm,
    (_, lead, cm, dqs, sqs, tqs) => {
      if (dqs || sqs || tqs) return (dqs || sqs || tqs); // keep strings
      return lead ? lead : '';
    }
  );

  // Finally, wipe strings themselves (preserve line count)
  s = s.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
       .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
       .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, '``');

  return s;
}

/** Join line continuations (e.g. Python "\" or JS backslash) into single logical lines. */
export function normalizeContinuations(src: string): string {
  return src.replace(/\\\r?\n/g, ' ');
}

/**
 * Resolve an import-ish string (relative or bare) to a displayable label:
 * - For relative paths, normalize to workspace-style posix paths
 * - For bare module names, return as-is
 */
export function resolveImportLabelByText(fromFile: string, spec: string): string | null {
  const isRelative = spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('..');
  if (!isRelative) return spec;

  const fromPosix = fromFile.replace(/\\/g, '/');
  const fromDir = fromPosix.split('/').slice(0, -1).join('/');
  // Normalize, collapse slashes, strip leading ./ or /
  const joined = (`${fromDir}/${spec}`)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  // Strip common JS/TS/Python/etc extensions
  return joined.replace(/\.(tsx?|mjs|cjs|jsx?|py|go|rs|rb|php|java|kt|cs)$/i, '');
}
