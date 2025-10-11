// src/services/parse/utils.ts
import * as path from 'path';

export function normalizePosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function makeModuleId(label: string): string {
  return `mod:${normalizePosixPath(label)}`;
}

export function makeClassId(fileLabel: string, className: string): string {
  return `cls:${normalizePosixPath(fileLabel)}#${className}`;
}

export function makeFuncId(fileLabel: string, name: string, line: number): string {
  return `fn:${normalizePosixPath(fileLabel)}#${name}@${line}`;
}

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
  s = s.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, (m) => '""')
       .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, (m) => "''")
       .replace(/`[^`\\]*(?:\\.[^`\\]*)*`/g, (m) => '``');

  return s;
}

/**
 * Join line continuations (e.g. Python "\" or JS backslash) into single logical lines.
 */
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

  const fromDir = normalizePosixPath(path.dirname(normalizePosixPath(fromFile)));
  const joined = normalizePosixPath(path.normalize(path.join(fromDir, spec)));
  // strip common JS/TS/Python extensions
  return joined.replace(/\.(tsx?|mjs|cjs|jsx?|py|go|rs|rb|php|java|kt|cs)$/i, '');
}
